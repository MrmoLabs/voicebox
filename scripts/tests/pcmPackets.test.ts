import { expect, test } from 'bun:test';
import { PcmPacketDecoder } from '../../app/src/lib/audio/pcmPackets';

function packet(rate: number, samples: number[]) {
  const bytes = new Uint8Array(8 + samples.length * 4);
  const data = new DataView(bytes.buffer);
  data.setUint32(0, rate, true);
  data.setUint32(4, samples.length, true);
  samples.forEach((sample, i) => data.setFloat32(8 + i * 4, sample, true));
  return bytes;
}

test('every byte boundary can split a network PCM packet', () => {
  const bytes = new Uint8Array([...packet(24000, [0.25, -0.5]), ...packet(0, [])]);
  for (let split = 0; split <= bytes.length; split++) {
    const decoder = new PcmPacketDecoder();
    const decoded = [...decoder.push(bytes.slice(0, split)), ...decoder.push(bytes.slice(split))];
    expect(decoded.map(p => Array.from(p.samples))).toEqual([[0.25, -0.5]]);
    expect(decoded[0].sampleRate).toBe(24000);
    expect(() => decoder.finish()).not.toThrow();
  }
});

test('byte by byte and multiple PCM packets preserve sample order', () => {
  const decoder = new PcmPacketDecoder();
  const decoded = [];
  for (const byte of [...packet(24000, [1]), ...packet(24000, [2]), ...packet(0, [])]) {
    decoded.push(...decoder.push(new Uint8Array([byte])));
  }
  expect(decoded.map(p => p.samples[0])).toEqual([1, 2]);
  decoder.finish();
});

test('failed or truncated streams never report success', () => {
  expect(() => new PcmPacketDecoder().push(packet(1, []))).toThrow();
  const incomplete = new PcmPacketDecoder();
  incomplete.push(packet(24000, [1]).slice(0, -1));
  expect(() => incomplete.finish()).toThrow();
  const noTerminal = new PcmPacketDecoder();
  noTerminal.push(packet(24000, [1]));
  expect(() => noTerminal.finish()).toThrow();
});

test('invalid PCM and trailing bytes are rejected', () => {
  expect(() => new PcmPacketDecoder().push(packet(10, [1]))).toThrow();
  expect(() => new PcmPacketDecoder().push(packet(24000, [NaN]))).toThrow();
  expect(() => new PcmPacketDecoder().push(new Uint8Array([...packet(0, []), 1]))).toThrow();
});
