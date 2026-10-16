import { create } from 'zustand';

export type LivePlaybackStatus = 'buffering' | 'playing' | 'paused' | 'finished' | 'failed';

interface LivePlaybackState {
  id: string | null;
  status: LivePlaybackStatus;
  receivedSeconds: number;
  playedSeconds: number;
  firstPlaybackMs: number | null;
  underruns: number;
  error: string | null;
  handledIds: Set<string>;
}

export const useLivePlaybackStore = create<LivePlaybackState>(() => ({
  id: null, status: 'buffering', receivedSeconds: 0, playedSeconds: 0,
  firstPlaybackMs: null, underruns: 0, error: null, handledIds: new Set(),
}));
