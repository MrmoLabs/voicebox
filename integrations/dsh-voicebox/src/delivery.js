/** Playback receipts belong to one session and audio epoch, never the model. */
export class DeliveryLedger {
  constructor() { this.reset(); }
  reset() { this.segments = new Map(); this.steps = new Map(); this.recent = ''; this.current = ''; }
  key(turn, step) { return `${turn}:${step}`; }
  enqueue(item) {
    if (this.segments.has(item.id)) return;
    this.segments.set(item.id, { ...item, status: 'queued' });
    const key = this.key(item.turn, item.step);
    if (!this.steps.has(key)) this.steps.set(key, { sealed: false, ids: new Set() });
    this.steps.get(key).ids.add(item.id);
  }
  seal(turn, step) {
    const key = this.key(turn, step);
    if (this.steps.has(key)) this.steps.get(key).sealed = true;
  }
  entries(item) { return (typeof item === 'string' ? [{ id: item }] : item.parts || [item]).map(part => this.segments.get(part.id)); }
  playing(item) {
    const entries = this.entries(item);
    if (!entries.length || entries.some(entry => entry?.status !== 'queued')) return;
    for (const entry of entries) entry.status = 'playing';
    this.current = typeof item === 'string' ? entries[0].text : item.text;
  }
  played(item) {
    const entries = this.entries(item);
    if (!entries.length || entries.some(entry => entry?.status !== 'playing')) return;
    for (const entry of entries) entry.status = 'played';
    this.recent = typeof item === 'string' ? entries[0].text : item.text; this.current = '';
  }
  interrupt() { for (const entry of this.segments.values()) if (entry.status !== 'played') entry.status = 'interrupted'; this.current = ''; }
  snapshot() {
    this.prune();
    return { recent: this.recent, current: this.current,
      pending: [...this.segments.values()].filter(entry => entry.status === 'queued' || entry.status === 'playing').length, completedSteps: [...this.steps]
      .filter(([, step]) => step.sealed && step.ids.size && [...step.ids].every(id => this.segments.get(id)?.status === 'played'))
      .map(([key]) => key).slice(-64) };
  }
  prune() {
    // Keep recent receipts without retaining all audio text for an entire day.
    for (const [key, step] of this.steps) {
      if (this.steps.size <= 128) break;
      if ([...step.ids].some(id => ['queued', 'playing'].includes(this.segments.get(id)?.status))) continue;
      for (const id of step.ids) this.segments.delete(id);
      this.steps.delete(key);
    }
  }
}
