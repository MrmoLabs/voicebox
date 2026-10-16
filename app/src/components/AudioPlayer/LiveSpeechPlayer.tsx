import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api/client';
import { livePlayback } from '@/lib/audio/livePlayback';
import { useLivePlaybackStore } from '@/stores/livePlaybackStore';
import { usePlayerStore } from '@/stores/playerStore';

export function LiveSpeechPlayer() {
  const state = useLivePlaybackStore();
  const audioUrl = usePlayerStore((s) => s.audioUrl);
  const { t } = useTranslation();
  useEffect(() => {
    if (audioUrl && state.id) livePlayback.stop(false);
  }, [audioUrl, state.id]);
  useEffect(() => () => livePlayback.stop(false), []);
  if (!state.id) return null;
  const labels = {
    buffering: t('generation.live.buffering', 'Buffering speech…'),
    playing: t('generation.live.playing', 'Playing while generating'),
    paused: t('generation.live.paused', 'Playback paused; generation continues'),
    finished: t('generation.live.finished', 'Playback finished; audio saved'),
    failed: t('generation.live.failed', 'Live preview interrupted'),
  };
  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 border-t bg-background px-6 py-4 flex items-center gap-4" aria-label={t('generation.live.player', 'Live speech player')}>
      <div className="flex-1 min-w-0 text-sm">
        <div>{labels[state.status]}</div>
        <div className="text-xs text-muted-foreground tabular-nums">
          {Math.floor(state.playedSeconds)}s / {Math.floor(state.receivedSeconds)}s · {t('generation.live.original', 'Original voice preview · default output device')}
        </div>
        {state.error && <div className="text-xs text-destructive">{state.error}</div>}
      </div>
      {state.status !== 'finished' && state.status !== 'failed' && (
        <Button variant="outline" onClick={() => void livePlayback.togglePause()}>
          {state.status === 'paused' ? t('generation.live.resume', 'Resume') : t('generation.live.pause', 'Pause')}
        </Button>
      )}
      {state.status === 'finished' && (
        <Button variant="outline" onClick={() => {
          const id = state.id!;
          livePlayback.stop(false);
          usePlayerStore.getState().setAudioWithAutoPlay(apiClient.getAudioUrl(id), id, null);
        }}>{t('generation.live.replay', 'Replay saved audio')}</Button>
      )}
      <Button variant="outline" onClick={() => livePlayback.stop(!['finished', 'failed'].includes(state.status))}>
        {state.status === 'finished' || state.status === 'failed' ? t('common.close', 'Close') : t('generation.live.stop', 'Stop')}
      </Button>
    </div>
  );
}
