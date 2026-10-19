/** Cached, optional waiting speech. It never owns answer audio or progress. */
export class TransitionAudio {
  constructor({ load, play, eligible, now = () => Date.now(), delay = 1100, cooldown = 15_000 }) {
    Object.assign(this, { load, play, eligible, now, delay, cooldown });
    this.cache = new Map(); this.used = 0; this.lastPlayed = -Infinity;
  }
  configure(key, enabled) {
    if (key !== this.key) { this.stop(); this.cache.clear(); this.key = key; this.failed = false; }
    this.enabled = enabled;
    if (!enabled) this.stop();
  }
  async warm() {
    if (!this.enabled || this.warming || this.failed || !this.eligible('warm')) return;
    const abort = new AbortController(), key = this.key;
    this.warming = abort;
    try {
      for (const kind of ['initial', 'gap']) {
        if (this.cache.has(kind)) continue;
        if (abort.signal.aborted || !this.eligible('warm')) return;
        const clip = await this.load(kind, key, abort.signal);
        if (abort.signal.aborted || key !== this.key) return;
        this.cache.set(kind, clip);
      }
    } catch { if (!abort.signal.aborted) this.failed = true; }
    finally { if (this.warming === abort) this.warming = undefined; }
  }
  scheduleWarm() {
    if (!this.enabled || this.warmTimer || this.warming || this.failed || this.cache.size === 2 || !this.eligible('warm')) return;
    this.warmTimer = setTimeout(() => { this.warmTimer = undefined; void this.warm(); }, 500);
  }
  begin() { this.cancel(); this.active = true; this.spoke = false; this.used = 0; this.initialUsed = false; }
  audioReady() { this.spoke = true; this.cancelPlayback(); this.clearTimer(); }
  wait(boundary) {
    if (!this.enabled || !this.active || this.timer || this.playing || !this.eligible('play')) return;
    const kind = this.spoke ? 'gap' : 'initial';
    if ((kind === 'gap' && !boundary) || (kind === 'initial' && this.initialUsed) || this.used >= 3 || !this.cache.has(kind)) return;
    const remainingCooldown = Math.max(0, this.cooldown - (this.now() - this.lastPlayed));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.active || !this.enabled || !this.eligible('play') || (kind === 'initial' && this.spoke)) return;
      this.lastPlayed = this.now(); this.used++;
      if (kind === 'initial') this.initialUsed = true;
      const abort = new AbortController(); this.playing = abort;
      void Promise.resolve().then(() => this.play(this.cache.get(kind), kind, abort.signal)).catch(() => {}).finally(() => {
        if (this.playing === abort) this.playing = undefined;
      });
    }, Math.max(this.delay, remainingCooldown));
  }
  clearTimer() { clearTimeout(this.timer); this.timer = undefined; }
  cancelPlayback() { this.playing?.abort(); this.playing = undefined; }
  cancel() { this.clearTimer(); clearTimeout(this.warmTimer); this.warmTimer = undefined; this.cancelPlayback(); this.warming?.abort(); this.warming = undefined; }
  stop() { this.cancel(); this.active = false; }
}
