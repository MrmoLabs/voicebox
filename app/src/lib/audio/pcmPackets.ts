/** Incremental parser for little-endian (sampleRate, sampleCount, float32 PCM). */
export class PcmPacketDecoder {
  private pending = new Uint8Array(0);
  ended = false;

  push(bytes: Uint8Array): Array<{ sampleRate: number; samples: Float32Array }> {
    if (this.ended && bytes.length) throw new Error('Audio arrived after stream completion');
    const joined = new Uint8Array(this.pending.length + bytes.length);
    joined.set(this.pending);
    joined.set(bytes, this.pending.length);
    let offset = 0;
    const packets = [];
    while (joined.length - offset >= 8) {
      const header = new DataView(joined.buffer, offset, 8);
      const sampleRate = header.getUint32(0, true);
      const count = header.getUint32(4, true);
      if (!count) {
        if (sampleRate !== 0) throw new Error('Speech generation stopped before completing');
        this.ended = true;
        offset += 8;
        if (offset !== joined.length) throw new Error('Invalid trailing audio');
        break;
      }
      if (sampleRate < 8000 || sampleRate > 192000 || count > 262144) {
        throw new Error('Invalid PCM packet');
      }
      if (joined.length - offset < 8 + count * 4) break;
      const samples = new Float32Array(count);
      const data = new DataView(joined.buffer, offset + 8, count * 4);
      for (let i = 0; i < count; i++) {
        const value = data.getFloat32(i * 4, true);
        if (!Number.isFinite(value)) throw new Error('Invalid PCM sample');
        samples[i] = value;
      }
      packets.push({ sampleRate, samples });
      offset += 8 + count * 4;
    }
    this.pending = joined.slice(offset);
    return packets;
  }

  finish() {
    if (!this.ended || this.pending.length) throw new Error('Audio connection interrupted');
  }
}
