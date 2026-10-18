import { SentenceBuffer, SentenceQueue } from './sentences.js';

/** Live attempt/turn ownership sits above the existing scoped speech transport. */
export class LiveNarration {
  constructor(bridge, { play, update, failed, delivery, voiceMode = () => false }) {
    Object.assign(this, { bridge, play, update, failed, delivery, voiceMode });
  }
  reset() { this.queue?.cancel(); this.queue = undefined; this.attempt = undefined; this.blocked = undefined; this.finished = false; this.messageId = undefined; }
  fail(session, turn, error) {
    const messageId = this.messageId;
    const finished = this.finished;
    this.bridge.interrupt(session.id);
    this.blocked = turn;
    this.failed({ activeTurn: turn, activeMessageId: messageId, turnFinished: finished, live: true, phase: 'error', error: error.message || String(error) });
  }
  handle(session, event) {
    if (event.type === 'turn/start' || event.type === 'user/message') { this.bridge.handle(session, event); return; }
    const turn = this.bridge.turns.get(session.id);
    if (!turn?.human || this.bridge.active !== session.id) return;
    if (this.blocked === turn.turn) {
      if (event.type === 'assistant/message' && event.data.turn === turn.turn) this.update({ activeMessageId: event.data.message?.id });
      if (event.type === 'turn/end' && event.data.turn === turn.turn) {
        this.bridge.turns.delete(session.id); this.finished = true; this.update({ turnFinished: true });
      }
      return;
    }
    const data = event.data;
    try {
      if (event.type === 'assistant/live-chunk') {
        if (data.turn !== turn.turn || event.seq < (session.firstLiveSeq ?? 0)) return;
        if (this.attempt?.id !== data.attemptId) {
          if (this.attempt && this.attempt.step === data.step) throw new Error('回答正在重试，已停止本轮播报；完成后可手动朗读');
          this.attempt?.buffer.finish();
          this.ensureQueue(session, turn.turn);
          const attempt = { id: data.attemptId, step: data.step, blocks: new Map(), seq: -1, piece: 0 };
          this.attempt = attempt;
          attempt.buffer = new SentenceBuffer(text => this.queue.enqueue(text, `live:${turn.turn}:${attempt.id}:${attempt.piece++}`, { turn: turn.turn, step: attempt.step ?? 0 }));
        }
        const attempt = this.attempt;
        if (event.seq <= attempt.seq) return;
        attempt.seq = event.seq;
        const chunk = data.chunk;
        if (chunk.type === 'block-start') {
          attempt.blocks.set(chunk.index, { type: chunk.blockType, text: '' });
        } else if (chunk.type === 'text-delta') {
          const block = attempt.blocks.get(chunk.index) || { type: 'text', text: '' };
          if (block.type !== 'text') return;
          if (attempt.lastBlock !== undefined && attempt.lastBlock !== chunk.index) attempt.buffer.append('\n');
          attempt.lastBlock = chunk.index;
          block.text += chunk.text;
          attempt.blocks.set(chunk.index, block);
          attempt.buffer.append(chunk.text);
        } else if (chunk.type === 'block-end' && chunk.block?.type === 'text') {
          const block = attempt.blocks.get(chunk.index);
          const prefix = block?.text || '';
          if (!chunk.block.text.startsWith(prefix)) throw new Error('正文发生改写，已停止本轮播报；完成后可手动朗读');
          attempt.buffer.append(chunk.block.text.slice(prefix.length));
          attempt.blocks.set(chunk.index, { type: 'text', text: chunk.block.text });
          attempt.buffer.finish();
        } else if (chunk.type === 'finish' && ['error', 'aborted'].includes(chunk.reason?.kind)) {
          throw new Error('回答中断，已停止本轮播报');
        }
      } else if (event.type === 'assistant/retired') {
        if (this.attempt?.id === data.attemptId && !this.attempt.settled && this.queue) throw new Error('回答中断，已停止本轮播报；完成后可手动朗读');
      } else if (event.type === 'llm/retry' || event.type === 'assistant/attempt' || event.type === 'assistant/abandoned') {
        if (this.queue) throw new Error('回答发生重试或中断，已停止本轮播报；完成后可手动朗读');
      } else if (event.type === 'assistant/message' && data.turn === turn.turn) {
        if (data.interrupted) throw new Error('回答中断，已停止本轮播报');
        // Settlement names the row without enqueueing the complete answer again.
        if (this.attempt && (this.attempt.step === data.step || data.step === undefined)) {
          this.attempt?.buffer.settle((data.message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n'));
          this.attempt.settled = true;
          this.delivery?.seal(turn.turn, data.step ?? this.attempt.step ?? 0);
          this.messageId = data.message?.id;
          if (this.queue) this.update({ activeMessageId: this.messageId });
        } else {
          // Hosts without live frames fall back to one settled text per step.
          this.ensureQueue(session, turn.turn);
          const buffer = new SentenceBuffer(text => this.queue.enqueue(text, `settled:${turn.turn}:${event.seq}:${this.fallbackPiece++}`, { turn: turn.turn, step: data.step ?? 0 }));
          buffer.append((data.message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n'), true);
          this.delivery?.seal(turn.turn, data.step ?? 0);
          this.messageId = data.message?.id;
          this.update({ activeMessageId: this.messageId });
        }
      } else if (event.type === 'turn/end' && data.turn === turn.turn) {
        this.bridge.turns.delete(session.id);
        this.finished = true;
        this.update({ turnFinished: true });
        if (data.reason?.kind !== 'completed') {
          if (data.reason?.kind !== 'max-tokens' || !this.voiceMode()) throw new Error('回答中断，已停止本轮播报');
          this.update({ notice: '模型曾达到输出限制，请留意尚未讲完的内容' });
        }
        this.attempt?.buffer.finish();
        this.queue?.finish();
      }
    } catch (error) { this.fail(session, turn.turn, error); }
  }
  ensureQueue(session, turn) {
    if (this.queue) return;
    this.finished = false; this.messageId = undefined; this.fallbackPiece = 0;
    const epoch = this.bridge.epochs.get(session.id);
    const queue = new SentenceQueue({
      longForm: this.voiceMode(),
      queued: item => this.delivery?.enqueue(item),
      playing: item => this.delivery?.playing(item),
      played: item => this.delivery?.played(item),
      prepare: item => {
        if (this.queue !== queue) return;
        this.update({ waitingForText: false });
        return this.bridge.speak(session.id, item.id, item.text, epoch, { notify: false });
      },
      play: generation => this.play(generation),
      waiting: () => { if (this.queue === queue) this.update({ waitingForText: true, phase: 'buffering' }); },
      drained: () => { if (this.queue === queue) this.update({ activeMessageId: undefined, activeTurn: undefined, phase: 'idle', elapsed: 0 }); },
      error: error => { if (this.queue === queue) this.fail(session, turn, error); },
    });
    this.queue = queue;
    this.update({ activeTurn: turn, activeMessageId: undefined, turnFinished: false, live: true, phase: 'buffering', elapsed: 0, error: '', waitingForText: true });
  }
  async idle() { await this.queue?.idle(); }
}
