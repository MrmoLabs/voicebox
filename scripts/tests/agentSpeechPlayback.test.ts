import { expect, test } from 'bun:test';
import { playAgentSpeech, type SpeechPlaybackTrace } from '../../app/src/lib/audio/agentSpeechPlayback';

test('streaming preroll waits for actual PCM, then keeps packet scheduling contiguous', async () => {
  const starts: number[] = [], trace: SpeechPlaybackTrace[] = [];
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const context = {
    state: 'running', currentTime: 10, destination: {},
    createBuffer(_channels: number, count: number, rate: number) { return { duration: count / rate, getChannelData: () => new Float32Array(count) }; },
    createBufferSource() { return { connect() {}, disconnect() {}, start(at: number) { starts.push(at); }, stop() {} }; },
  };
  const packet = (seconds: number) => {
    const bytes = new Uint8Array(8 + Math.round(seconds * 8000) * 4), view = new DataView(bytes.buffer);
    view.setUint32(0, 8000, true); view.setUint32(4, (bytes.length - 8) / 4, true); return bytes;
  };
  const abort = new AbortController();
  const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; controller.enqueue(packet(.2)); } });
  const task = playAgentSpeech({ generation_id: 'preroll', stream_audio: true }, 'http://fixture', abort.signal, () => {}, {
    context: context as unknown as AudioContext, resume: false, initialBufferSeconds: .04, bufferedStartSeconds: .6,
    fetch: (async () => new Response(body)) as typeof fetch, trace: event => trace.push(event),
  });
  const settled = task.catch(error => error);
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(starts).toEqual([]);
    expect(trace.map(event => event.kind)).toEqual(['first']);
    context.currentTime = 10.4; stream.enqueue(packet(.4));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(starts).toHaveLength(2); expect(starts[0]).toBeCloseTo(10.44); expect(starts[1]).toBeCloseTo(10.64);
    expect(trace.find(event => event.kind === 'ready')).toMatchObject({ bufferedMs: 600 });
    context.currentTime = 10.7; stream.enqueue(packet(.6)); stream.enqueue(new Uint8Array(8)); stream.close();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(starts[2]).toBeCloseTo(11.04);
    context.currentTime = 12; expect(await settled).toBeUndefined();
    expect(trace.some(event => event.kind === 'underrun')).toBe(false);
    expect(trace.at(-1)).toMatchObject({ kind: 'completed', audioMs: 1200 });
  } finally { abort.abort(); await settled; }
});

test('a short completed utterance flushes below preroll, while cancellation discards pending PCM', async () => {
  for (const complete of [true, false]) {
    let starts = 0, cancelled = 0;
    const context = {
      state: 'running', currentTime: 10, destination: {},
      createBuffer(_channels: number, count: number, rate: number) { return { duration: count / rate, getChannelData: () => new Float32Array(count) }; },
      createBufferSource() { return { connect() {}, disconnect() {}, start() { starts++; }, stop() {} }; },
    };
    const bytes = new Uint8Array(8 + 1600 * 4 + (complete ? 8 : 0)), view = new DataView(bytes.buffer);
    view.setUint32(0, 8000, true); view.setUint32(4, 1600, true);
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); if (complete) controller.close(); }, cancel() { cancelled++; } });
    const abort = new AbortController(), trace: SpeechPlaybackTrace[] = [];
    const task = playAgentSpeech({ generation_id: 'short', stream_audio: true }, 'http://fixture', abort.signal, () => {}, {
      context: context as unknown as AudioContext, resume: false, initialBufferSeconds: .04, bufferedStartSeconds: .8,
      fetch: (async () => new Response(body)) as typeof fetch, trace: event => trace.push(event),
    }).catch(error => error);
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(starts).toBe(complete ? 1 : 0);
      if (complete) { context.currentTime = 11; expect(await task).toBeUndefined(); expect(trace.find(event => event.kind === 'ready')).toMatchObject({ bufferedMs: 200 }); }
      else { abort.abort(); expect((await task).name).toBe('AbortError'); expect(cancelled).toBe(1); expect(trace.some(event => event.kind === 'ready')).toBe(false); }
    } finally { abort.abort(); await task; }
  }
});

test('a starved stream refills with actual PCM instead of restarting on another tiny packet', async () => {
  const starts: number[] = [], trace: SpeechPlaybackTrace[] = [];
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const context = {
    state: 'running', currentTime: 10, destination: {},
    createBuffer(_channels: number, count: number, rate: number) { return { duration: count / rate, getChannelData: () => new Float32Array(count) }; },
    createBufferSource() { return { connect() {}, disconnect() {}, start(at: number) { starts.push(at); }, stop() {} }; },
  };
  const packet = (seconds: number) => {
    const bytes = new Uint8Array(8 + Math.round(seconds * 8000) * 4), view = new DataView(bytes.buffer);
    view.setUint32(0, 8000, true); view.setUint32(4, (bytes.length - 8) / 4, true); return bytes;
  };
  const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; stream.enqueue(packet(.6)); } });
  const abort = new AbortController();
  const task = playAgentSpeech({ generation_id: 'refill', stream_audio: true }, 'http://fixture', abort.signal, () => {}, {
    context: context as unknown as AudioContext, resume: false, initialBufferSeconds: .04, bufferedStartSeconds: .6,
    fetch: (async () => new Response(body)) as typeof fetch, trace: event => trace.push(event),
  }).catch(error => error);
  try {
    await new Promise(resolve => setTimeout(resolve, 20)); expect(starts).toHaveLength(1);
    context.currentTime = 11; stream.enqueue(packet(.2));
    await new Promise(resolve => setTimeout(resolve, 20)); expect(starts).toHaveLength(1);
    context.currentTime = 11.2; stream.enqueue(packet(.4));
    await new Promise(resolve => setTimeout(resolve, 20)); expect(starts).toHaveLength(3);
    expect(starts[1]).toBeCloseTo(11.24); expect(starts[2]).toBeCloseTo(11.44);
    expect(trace.filter(event => event.kind === 'underrun')).toHaveLength(1);
    stream.enqueue(new Uint8Array(8)); stream.close(); context.currentTime = 12;
    expect(await task).toBeUndefined();
  } finally { abort.abort(); await task; }
});

test('a queued PCM piece preserves a suspended shared context and abort stops scheduled nodes', async () => {
  let resumed = 0, stopped = 0, started = 0;
  const trace: SpeechPlaybackTrace[] = [];
  const context = {
    state: 'suspended', currentTime: 0, destination: {},
    async resume() { resumed++; },
    createBuffer(_channels: number, count: number, rate: number) { return { duration: count / rate, getChannelData: () => new Float32Array(count) }; },
    createBufferSource() { return { connect() {}, disconnect() {}, start() { started++; }, stop() { stopped++; } }; },
  } as unknown as AudioContext;
  const pcm = new Uint8Array(8 + 4 + 8);
  const view = new DataView(pcm.buffer); view.setUint32(0, 24000, true); view.setUint32(4, 1, true);
  const abort = new AbortController();
  const task = playAgentSpeech({ generation_id: 'paused-piece', stream_audio: true }, 'http://fixture', abort.signal, () => {}, {
    context, resume: false, fetch: (async () => new Response(pcm)) as typeof fetch, trace: event => trace.push(event),
  });
  const settled = task.catch(error => error);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(resumed).toBe(0);
  expect(started).toBe(1);
  abort.abort();
  expect((await settled).name).toBe('AbortError');
  expect(stopped).toBe(1);
  expect(trace.map(event => event.kind)).toEqual(['first', 'aborted']);
});

test('a prepared continuation starts promptly and reports a real PCM starvation as buffering', async () => {
  const starts: number[] = [], progress: Array<{ elapsed: number; buffering: boolean | undefined }> = [];
  const trace: SpeechPlaybackTrace[] = [];
  let release: ReadableStreamDefaultController<Uint8Array>;
  const context = {
    state: 'running', currentTime: 10, destination: {},
    createBuffer(_channels: number, count: number, rate: number) { return { duration: count / rate, getChannelData: () => new Float32Array(count) }; },
    createBufferSource() { return { connect() {}, disconnect() {}, start(at: number) { starts.push(at); }, stop() {} }; },
  };
  const packet = new Uint8Array(8 + 240 * 4);
  const view = new DataView(packet.buffer); view.setUint32(0, 24000, true); view.setUint32(4, 240, true);
  const abort = new AbortController();
  const body = new ReadableStream<Uint8Array>({ start(controller) { release = controller; controller.enqueue(packet); } });
  const task = playAgentSpeech({ generation_id: 'next-piece', stream_audio: true }, 'http://fixture', abort.signal,
    (elapsed, buffering) => progress.push({ elapsed, buffering }), {
      context: context as unknown as AudioContext, resume: false, initialBufferSeconds: .04,
      fetch: (async () => new Response(body)) as typeof fetch,
      trace: event => trace.push(event),
    });
  const settled = task.catch(error => error);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(starts).toEqual([10.04]);
  context.currentTime = 10.045;
  await new Promise(resolve => setTimeout(resolve, 110));
  expect(progress.at(-1)?.buffering).toBe(false);
  context.currentTime = 11;
  await new Promise(resolve => setTimeout(resolve, 110));
  expect(progress.at(-1)?.buffering).toBe(true);
  expect(progress.at(-1)?.elapsed).toBeCloseTo(10);
  release!.enqueue(packet); release!.enqueue(new Uint8Array(8)); release!.close();
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(starts).toEqual([10.04, 11.3]);
  const underrun = trace.find(event => event.kind === 'underrun');
  expect(underrun?.kind === 'underrun' && underrun.gapMs).toBeCloseTo(950);
  expect(underrun?.kind === 'underrun' && underrun.refillMs).toBe(300);
  context.currentTime = 11.32;
  expect(await settled).toBeUndefined();
  expect(trace.map(event => event.kind)).toEqual(['first', 'started', 'underrun', 'completed']);
  const completion = trace.at(-1);
  expect(completion?.kind === 'completed' && completion.audioMs).toBeCloseTo(20);
});

test('diagnostics failures cannot alter playback; malformed PCM never reports completion', async () => {
  const packet = new Uint8Array(8 + 240 * 4 + 8);
  const view = new DataView(packet.buffer); view.setUint32(0, 24000, true); view.setUint32(4, 240, true);
  let now = 10, stopped = 0;
  const context = {
    state: 'running', get currentTime() { now += .1; return now; }, destination: {},
    createBuffer(_channels: number, count: number, rate: number) { return { duration: count / rate, getChannelData: () => new Float32Array(count) }; },
    createBufferSource() { return { connect() {}, disconnect() {}, start() {}, stop() { stopped++; } }; },
  } as unknown as AudioContext;
  await playAgentSpeech({ generation_id: 'valid', stream_audio: true }, 'http://fixture', new AbortController().signal, () => {}, {
    context, resume: false, initialBufferSeconds: .04, fetch: (async () => new Response(packet)) as typeof fetch,
    trace() { throw new Error('observer failed'); },
  });
  const trace: SpeechPlaybackTrace[] = [];
  await expect(playAgentSpeech({ generation_id: 'truncated', stream_audio: true }, 'http://fixture', new AbortController().signal, () => {}, {
    context, resume: false, fetch: (async () => new Response(packet.slice(0, -8))) as typeof fetch, trace: event => trace.push(event),
  })).rejects.toThrow('Audio connection interrupted');
  expect(trace.map(event => event.kind)).toEqual(['first', 'failed']);
  expect(trace.at(-1)).toMatchObject({ kind: 'failed', state: 'decode' });
  expect(stopped).toBe(2);
});

test('a suspended audio clock is not a PCM underrun and EOF draining does not invent a gap', async () => {
  const trace: SpeechPlaybackTrace[] = [];
  let stream: ReadableStreamDefaultController<Uint8Array>;
  const context = {
    state: 'suspended', currentTime: 10, destination: {},
    createBuffer(_channels: number, count: number, rate: number) { return { duration: count / rate, getChannelData: () => new Float32Array(count) }; },
    createBufferSource() { return { connect() {}, disconnect() {}, start() {}, stop() {} }; },
  };
  const packet = new Uint8Array(8 + 240 * 4);
  const view = new DataView(packet.buffer); view.setUint32(0, 24000, true); view.setUint32(4, 240, true);
  const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; controller.enqueue(packet); } });
  const abort = new AbortController();
  const task = playAgentSpeech({ generation_id: 'suspended', stream_audio: true }, 'http://fixture', abort.signal, () => {}, {
    context: context as unknown as AudioContext, resume: false, initialBufferSeconds: .04,
    fetch: (async () => new Response(body)) as typeof fetch, trace: event => trace.push(event),
  });
  try {
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(trace.map(event => event.kind)).toEqual(['first']);
    stream!.enqueue(packet); stream!.enqueue(new Uint8Array(8)); stream!.close();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(trace.some(event => event.kind === 'underrun')).toBe(false);
    context.state = 'running'; context.currentTime = 10.2;
    await task;
    expect(trace.map(event => event.kind)).toEqual(['first', 'started', 'completed']);
  } finally { abort.abort(); await task.catch(() => {}); }
});

test('an unexpectedly closed audio context rejects during resume, PCM read and playback drain', async () => {
  for (const stage of ['resume', 'read', 'drain']) {
    let releaseResume = () => {}, stopped = 0, disconnected = 0;
    const trace: SpeechPlaybackTrace[] = [];
    class Context extends EventTarget {
      state = 'running'; currentTime = 10; destination = {};
      resume() { return new Promise<void>(resolve => { releaseResume = resolve; }); }
      createBuffer(_channels: number, count: number, rate: number) { return { duration: count / rate, getChannelData: () => new Float32Array(count) }; }
      createBufferSource() { return { connect() {}, disconnect() { disconnected++; }, start() {}, stop() { stopped++; } }; }
    }
    const context = new Context(), abort = new AbortController();
    const pcm = new Uint8Array(8 + 240 * 4 + 8), view = new DataView(pcm.buffer);
    view.setUint32(0, 24000, true); view.setUint32(4, 240, true);
    const task = playAgentSpeech({ generation_id: stage, stream_audio: true }, 'http://fixture', abort.signal, () => {}, {
      context: context as unknown as AudioContext, resume: stage === 'resume',
      fetch: (async () => stage === 'read' ? new Response(new ReadableStream()) : new Response(pcm)) as typeof fetch,
      trace: event => trace.push(event),
    }).catch(error => error);
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      context.state = 'closed'; context.dispatchEvent(new Event('statechange'));
      const outcome = await Promise.race([task, new Promise(resolve => setTimeout(() => resolve('hung'), 100))]);
      expect(outcome).toBeInstanceOf(Error); expect((outcome as Error).message).toContain('audio context closed');
      expect(trace.at(-1)).toMatchObject({ kind: 'failed' });
      expect(trace.some(event => event.kind === 'completed')).toBe(false);
      if (stage === 'drain') { expect(stopped).toBe(1); expect(disconnected).toBe(1); }
    } finally { releaseResume(); abort.abort(); await task; }
  }
});

test('a decoding failure is not held hostage by an underlying stream whose cancellation never settles', async () => {
  let cancelled = 0;
  const context = { state: 'running', currentTime: 0, destination: {} } as AudioContext;
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1,0,0,0,1,0,0,0,0,0,0,0])); }, cancel() { cancelled++; return new Promise(() => {}); } });
  const abort = new AbortController();
  const task = playAgentSpeech({ generation_id: 'stuck-cancel', stream_audio: true }, 'http://fixture', abort.signal, () => {}, {
    context, resume: false, fetch: (async () => new Response(body)) as typeof fetch,
  }).catch(error => error);
  const outcome = await Promise.race([task, new Promise(resolve => setTimeout(() => resolve('hung'), 100))]);
  abort.abort();
  expect(outcome).toBeInstanceOf(Error); expect((outcome as Error).message).toContain('Invalid PCM');
  expect(cancelled).toBe(1);
});
