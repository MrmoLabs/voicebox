import { useTranslation } from 'react-i18next';
import { useGenerationStore, type GenerationProgressData } from '@/stores/generationStore';

function duration(seconds: number): string {
  const rounded = Math.ceil(seconds);
  return rounded < 60 ? `${rounded}s` : `${Math.floor(rounded / 60)}m ${rounded % 60}s`;
}

export function GenerationProgress({
  id,
  loadingModel = false,
  progress: suppliedProgress,
}: {
  id: string;
  loadingModel?: boolean;
  progress?: GenerationProgressData | null;
}) {
  const { t } = useTranslation();
  const storedProgress = useGenerationStore((state) => state.progressById[id]);
  const progress = suppliedProgress ?? storedProgress;
  const stage = progress?.stage ?? (loadingModel ? 'loading_model' : 'generating');
  const percent =
    stage === 'generating' && progress && progress.total_chunks > 1 ? progress.percent : null;
  const labels = {
    queued: t('generation.progress.queued', 'Waiting in queue'),
    loading_model: t('generation.progress.loading_model', 'Loading model'),
    preparing_voice: t('generation.progress.preparing_voice', 'Preparing voice'),
    generating: t('generation.progress.generating', 'Generating speech'),
    finalizing: t('generation.progress.finalizing', 'Processing and saving audio'),
  };
  return (
    <div
      className="space-y-1.5 text-xs"
      aria-label={t('generation.progress.label', 'Generation progress')}
    >
      <div className="flex items-center justify-between gap-2 text-foreground">
        <span>{labels[stage]}</span>
        {stage === 'generating' && progress && progress.total_chunks > 1 && (
          <span className="shrink-0 tabular-nums">
            {progress.completed_chunks}/{progress.total_chunks}
          </span>
        )}
      </div>
      <div
        role="progressbar"
        aria-label={labels[stage]}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-valuetext={percent == null ? labels[stage] : `${Math.round(percent)}%`}
        className="h-1.5 overflow-hidden rounded-full bg-secondary"
      >
        <div
          className={`h-full bg-accent transition-[width] duration-300 ${percent == null ? 'w-1/3 animate-pulse motion-reduce:animate-none' : ''}`}
          style={percent == null ? undefined : { width: `${percent}%` }}
        />
      </div>
      {progress && (
        <div className="space-y-0.5 text-[11px] text-muted-foreground tabular-nums">
          <div>
            {t('generation.progress.elapsed', {
              defaultValue: 'Elapsed {{time}}',
              time: duration(progress.elapsed_seconds),
            })}
          </div>
          {stage === 'generating' && (
            <div>
              {progress.estimate_overdue
                ? t('generation.progress.overdue', 'Taking longer than estimated')
                : progress.estimated_remaining_seconds != null
                  ? t('generation.progress.remaining', {
                      defaultValue: 'Speech: about {{time}} left',
                      time: duration(progress.estimated_remaining_seconds),
                    })
                  : t('generation.progress.estimating', 'Estimating remaining time…')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
