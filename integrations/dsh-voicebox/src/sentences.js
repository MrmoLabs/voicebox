import { spokenText } from './bridge.js';

/** Hide unfinished Markdown constructs before looking for sentence boundaries. */
function stableText(raw, final) {
  let fence;
  const lines = [];
  for (const line of raw.split('\n')) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      continue;
    }
    if (fence || /^\s*\|/.test(line) || /^\s*[`~]{1,2}$/.test(line)) continue;
    lines.push(line);
  }
  const text = lines.join('\n');
  let plain = '';
  for (let i = 0; i < text.length;) {
    // A delta ending in ! may be the first half of ![image](url).
    if (!final && text[i] === '!' && i === text.length - 1) break;
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      if (end < 0) break;
      i = end + 3; continue;
    }
    if (text[i] === '<') {
      const end = text.indexOf('>', i + 1);
      if (end < 0) break;
      i = end + 1; continue;
    }
    if (text[i] === '`') {
      const ticks = text.slice(i).match(/^`+/)[0];
      const end = text.indexOf(ticks, i + ticks.length);
      if (end < 0) break;
      plain += text.slice(i + ticks.length, end);
      i = end + ticks.length; continue;
    }
    const image = text.startsWith('![', i);
    if (text[i] === '[' || image) {
      const start = i + (image ? 2 : 1);
      const end = text.indexOf(']', start);
      if (end < 0 || end + 1 === text.length) break;
      if (text[end + 1] === '(') {
        let depth = 1, close = end + 2;
        for (; close < text.length && depth; close++) {
          if (text[close] === '(') depth++;
          if (text[close] === ')') depth--;
        }
        if (depth) break;
        if (!image) plain += text.slice(start, end);
        i = close; continue;
      }
      if (!image) plain += text.slice(start, end);
      i = end + 1; continue;
    }
    plain += text[i++];
  }
  return spokenText(plain).replace(/\s+/g, ' ').trim();
}

/** Append-only, bounded sentence cursor; committed text is never replayed. */
export class SentenceBuffer {
  constructor(emit) { this.emit = emit; this.raw = ''; this.committed = ''; }
  append(text, final = false) {
    this.raw += text;
    if (this.raw.length > 30_000) throw new Error('本段回答过长，已停止边回答边读');
    const clean = stableText(this.raw, final);
    if (!clean.startsWith(this.committed)) throw new Error('正文发生改写，已停止本轮播报；完成后可手动朗读');
    let remaining = clean.slice(this.committed.length);
    while (remaining.trim()) {
      let end = 0;
      // Wait for whitespace after an English period, avoiding split decimals.
      const boundaries = [...remaining.matchAll(/[。！？!?；;][”’」』）)]*|\.(?=\s)|[，：]|[,:](?!\d)/gu)];
      const boundary = boundaries.find(match => match.index + match[0].length >= (/^[，：,:]/u.test(match[0]) ? 20 : 24));
      if (boundary && boundary.index + boundary[0].length <= 80) end = boundary.index + boundary[0].length;
      else if (remaining.length >= 80) {
        const prefix = remaining.slice(0, 80);
        end = Math.max(prefix.lastIndexOf(' '), prefix.lastIndexOf('，'), prefix.lastIndexOf(','));
        if (end < 24) end = 80;
        if (/[\uD800-\uDBFF]/.test(remaining[end - 1])) end--;
      } else if (final) end = remaining.length;
      if (!end) break;
      const piece = remaining.slice(0, end);
      this.emit(piece.trim());
      this.committed += piece;
      remaining = remaining.slice(end);
    }
  }
  finish() { this.append('', true); }
  settle(text) { this.raw = text; this.finish(); }
}

/** One playing job + one prepared job; at most eight bounded text batches. */
export class SentenceQueue {
  constructor({ prepare, play, waiting, drained, error, longForm = false, queued, playing, played }) {
    Object.assign(this, { prepare, play, waiting, drained, error, longForm, queued, playing, played });
    this.pending = []; this.closed = false; this.cancelled = false; this.characters = 0;
  }
  enqueue(text, id, meta = {}) {
    if (this.cancelled || this.closed || !text) return;
    const coalesce = !this.longForm && this.pending.length >= 8;
    this.characters += text.length + Number(coalesce);
    if (this.characters > (this.longForm ? 200_000 : 10_000)) throw new Error('本次朗读达到文本保护上限，尚未完整播放');
    if (coalesce) this.pending.at(-1).text += `\n${text}`;
    else { const item = { text, id, ...meta }; this.pending.push(item); this.queued?.(item); }
    this.prime(); this.run();
  }
  prime() {
    if (this.next || !this.pending.length || this.cancelled) return;
    let item = this.pending.shift();
    if (this.longForm) {
      const parts = [item];
      // Only combine text already waiting, within one durable model step.
      // First sound never waits for a larger batch; synthesis stays <=80 chars.
      while (this.pending.length && this.pending[0].turn === item.turn && this.pending[0].step === item.step
        && item.text.length + 1 + this.pending[0].text.length <= 80) {
        const next = this.pending.shift(); parts.push(next);
        item = { ...item, text: `${item.text} ${next.text}` };
      }
      if (parts.length > 1) item.parts = parts;
    }
    // Capture failures immediately, including while the previous audio plays.
    this.next = Promise.resolve().then(() => this.prepare(item)).then(value => ({ value, item }), error => ({ error }));
  }
  run() {
    if (this.runner || this.cancelled) return;
    this.runner = (async () => {
      try {
        while (!this.cancelled && this.next) {
          const result = await this.next;
          this.next = undefined;
          if (this.cancelled) return;
          if (result.error) throw result.error;
          if (!result.value) { this.cancel(); return; }
          this.prime();
          this.playing?.(result.item);
          await this.play(result.value);
          if (!this.cancelled) this.played?.(result.item);
        }
      } catch (error) {
        if (!this.cancelled) { this.cancel(); this.error(error); }
      }
    })().finally(() => {
      this.runner = undefined;
      if (this.cancelled) return;
      if (this.next || this.pending.length) { this.prime(); this.run(); }
      else if (this.closed) this.drained();
      else this.waiting();
    });
  }
  finish() {
    this.closed = true;
    if (!this.runner && !this.next && !this.cancelled) this.drained();
  }
  cancel() { this.cancelled = true; this.pending = []; }
  async idle() { while (this.runner) await this.runner; }
}
