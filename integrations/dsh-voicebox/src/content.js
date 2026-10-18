/** User-visible answer structure. This parser tracks coverage, not semantic truth. */
export function answerUnits(text) {
  const units = [];
  let title = '答复', lines = [], fence;
  const flush = () => {
    const raw = lines.join('\n').trim(); lines = [];
    let rest = raw, part = 0;
    while (rest) {
      let end = rest.length <= 12000 ? rest.length : rest.lastIndexOf('\n', 12000);
      if (end < 1) end = Math.min(12000, rest.length);
      if (/[\uD800-\uDBFF]/u.test(rest[end - 1])) end--;
      units.push({ id: `u${units.length + 1}`, title: title + (part++ ? '（续）' : ''), text: rest.slice(0, end),
        artifacts: /(?:^|\n)\s*(?:```|~~~|\|)/u.test(raw) });
      rest = rest.slice(end).trimStart();
    }
  };
  for (const line of text.split('\n')) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/u);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined;
    }
    const heading = !fence && line.match(/^\s{0,3}#{1,6}\s+(.+)$/u);
    if (heading) { flush(); title = heading[1]; }
    else lines.push(line);
  }
  flush();
  return units;
}

export function voiceIntent(text, { busy = false, awaitingAnswer = false, paused = false } = {}) {
  const clean = text.trim().replace(/[。！!？?，,\s]+$/gu, '');
  if (/^(?:停止|别说了|不用了|停一下|不要继续了)$/u.test(clean)) return { kind: 'stop' };
  if (/^(?:暂停|暂停一下|等一下|等一等)$/u.test(clean)) return { kind: 'pause' };
  if (/^(?:继续播放|恢复播放|接着播放)$/u.test(clean) || (paused && /^(?:继续|继续讲|接着说|接着讲)$/u.test(clean))) return { kind: 'resume' };
  if (busy && !awaitingAnswer && /^(?:嗯|嗯嗯|明白了|听懂了|知道了|好的|好|对|继续|继续讲|接着说|接着讲)$/u.test(clean)) return { kind: 'ack' };
  const continuation = /^(?:继续|接着说|继续讲|接着讲)$/u.test(clean);
  const detailed = continuation || /(?:详细|详述|展开|讲清楚|从头讲|太少了|不够详细|全部.*(?:讲|说|解释)|完整.*(?:讲|说|解释))/u.test(clean);
  const restart = /(?:重新|从头|再).*(?:详细|完整|全部|讲一遍)/u.test(clean);
  const partial = /(?:第[一二三四五六七八九十\d]+(?:点|部分|项|个)|这个词|这个概念|刚才那句|这一点)/u.test(clean);
  const expandPrevious = detailed && (continuation || /(?:刚才|上面|上一[轮条]|这个回答|这份答复|这些内容|你(?:提供|说|讲)的|太少了|不够详细)/u.test(clean)
    || /^(?:请|麻烦|把|全部|所有|内容|回答|答复|再|重新|从头|详细|地|说|讲|解释|展开|详述|完整|一遍|一下|一点|给我|清楚|都|讲解)+$/u.test(clean));
  return { kind: 'question', detailed, expandPrevious, restart, scope: partial ? 'target' : 'answer',
    temporary: partial && !/(?:不对|换个|不是|改成)/u.test(clean),
    continuation };
}

/** Model coverage claims and player receipts are deliberately separate. */
export class NarrationPlan {
  constructor(answer, request) {
    this.answer = answer; this.request = request;
    this.units = answerUnits(answer.text);
    this.covered = new Map(); this.playedSteps = new Set();
    this.rounds = 0; this.lastMissing = undefined; this.stalled = 0;
  }
  pending() { return this.units.filter(unit => !this.covered.has(unit.id)); }
  cover(ids, step) {
    if (!Array.isArray(ids) || ids.length > 200 || ids.some(id => !this.units.some(unit => unit.id === id))) throw new Error('未知的讲解单元');
    for (const id of ids) this.covered.set(id, step);
  }
  complete() { return this.units.length > 0 && !this.pending().length && [...this.covered.values()].every(step => this.playedSteps.has(step)); }
  advance() {
    const missing = this.pending().map(unit => unit.id).join(',');
    if (!missing || this.rounds >= 8) return false;
    this.stalled = missing === this.lastMissing ? this.stalled + 1 : 0;
    this.lastMissing = missing;
    if (this.stalled >= 2) return false;
    this.rounds++;
    return true;
  }
}
