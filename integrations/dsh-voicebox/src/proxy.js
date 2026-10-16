/** Exact Connection route: works over Desktop IPC and authenticated Web HTTP. */
export class VoiceboxProxy {
  constructor(config = {}, fetcher = globalThis.fetch) {
    const endpoint = new URL(config.endpoint || 'http://127.0.0.1:17493');
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new Error('Voicebox endpoint must be an HTTP(S) URL without credentials, query or fragment');
    }
    this.endpoint = endpoint.href.replace(/\/$/, '');
    this.config = config;
    this.fetcher = fetcher;
    this.generations = new Set();
    this.sessions = new Set();
    this.abort = new AbortController();
  }

  async handle(request) {
    const path = new URL(request.url).searchParams.get('path');
    const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
    if (path === '/settings' && request.method === 'GET') {
      return json({ ...this.config, streamAudio: true });
    }
    let body;
    let liveId;
    if (request.method === 'POST' && (path === '/speak' || path === '/speak/cancel')) {
      try {
        const raw = await request.text();
        if (raw.length > 64000) return json({ error: 'Speech request is too large' }, 413);
        body = JSON.parse(raw);
      } catch { return json({ error: 'Invalid JSON' }, 400); }
      if (!body || typeof body.session_id !== 'string' || !body.session_id || body.session_id.length > 200
        || (body.request_id !== undefined && (typeof body.request_id !== 'string' || !body.request_id || body.request_id.length > 200))) {
        return json({ error: 'Invalid speech identity' }, 400);
      }
      if (this.config.sessionIds?.length && !this.config.sessionIds.includes(body.session_id)) return json({ error: 'Session is not enabled for speech' }, 403);
      if (path === '/speak') {
        if (!body.request_id || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 10000) return json({ error: 'Speech requires 1–10000 characters and a request id' }, 400);
        if (this.sessions.size >= 512 && !this.sessions.has(body.session_id)) return json({ error: 'Too many speech sessions; reload the plugin' }, 429);
        this.sessions.add(body.session_id);
        body = {
          text: body.text, session_id: body.session_id, request_id: body.request_id,
          profile: this.config.profile || undefined, language: this.config.language || undefined,
          engine: 'qwen', model_size: this.config.modelSize || '0.6B',
          personality: false, stream_audio: true, playback_owner: 'client',
        };
      } else body = { session_id: body.session_id, request_id: body.request_id };
    } else if (request.method === 'GET' && (path === '/openapi.json' || path === '/profiles')) {
      // Capability discovery prevents silently using an older backend.
    } else if (request.method === 'GET' && /^\/generate\/[A-Za-z0-9_-]+\/live$/.test(path || '')) {
      liveId = path.split('/')[2];
      if (!this.generations.has(liveId)) return json({ error: 'Unknown speech generation' }, 404);
    } else return json({ error: 'Unknown Voicebox operation' }, 404);
    try {
      const signal = AbortSignal.any([request.signal, this.abort.signal, AbortSignal.timeout(liveId ? 30 * 60_000 : 15_000)]);
      const response = await this.fetcher(`${this.endpoint}${path}`, {
        method: request.method, signal,
        headers: { 'Content-Type': 'application/json', 'X-Voicebox-Client-Id': this.config.clientId || 'dsh-voicebox' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (liveId && response.ok) return new Response(response.body, {
        headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' },
      });
      const data = await response.json();
      if (path === '/profiles' && response.ok) {
        if (!Array.isArray(data)) return json({ error: 'Invalid Voicebox profile list' }, 502);
        return json(data.map(({ id, name, language, voice_type }) => ({
          id, name, language, voiceType: voice_type || 'cloned',
          compatible: !voice_type || voice_type === 'cloned',
        })));
      }
      if (path === '/speak' && response.ok && typeof data.id === 'string') {
        this.generations.add(data.id);
        if (this.generations.size > 512) this.generations.delete(this.generations.values().next().value);
      }
      return json(data, response.status);
    } catch (error) {
      return json({ error: `Voicebox is unavailable: ${error.message || error}` }, 502);
    }
  }

  async dispose() {
    this.abort.abort();
    await Promise.allSettled([...this.sessions].map((session_id) => this.fetcher(`${this.endpoint}/speak/cancel`, {
      method: 'POST', signal: AbortSignal.timeout(3000),
      headers: { 'Content-Type': 'application/json', 'X-Voicebox-Client-Id': this.config.clientId || 'dsh-voicebox' },
      body: JSON.stringify({ session_id }),
    })));
    this.sessions.clear();
    this.generations.clear();
  }
}
