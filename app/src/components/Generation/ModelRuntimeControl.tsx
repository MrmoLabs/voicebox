import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api/client';
import { useModelRuntime } from '@/lib/hooks/useModelRuntime';

export function engineModelName(engine: string, size?: string) {
  if (engine === 'qwen') return `qwen-tts-${size || '1.7B'}`;
  if (engine === 'qwen_custom_voice') return `qwen-custom-voice-${size || '1.7B'}`;
  if (engine === 'qwen_voice_design') return 'qwen-voice-design-1.7B';
  if (engine === 'tada') return size === '3B' ? 'tada-3b-ml' : 'tada-1b';
  return (
    (
      { chatterbox: 'chatterbox-tts', chatterbox_turbo: 'chatterbox-turbo' } as Record<
        string,
        string
      >
    )[engine] || engine
  );
}

export function ModelRuntimeControl({ modelName }: { modelName: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const runtime = useModelRuntime();
  const { data: downloaded } = useQuery({
    queryKey: ['modelStatus'],
    queryFn: () => apiClient.getModelStatus(),
    staleTime: 10000,
  });
  const state = runtime.data?.models.find((model) => model.model_name === modelName);
  const model = downloaded?.models.find((model) => model.model_name === modelName);
  const mutation = useMutation({
    mutationFn: (action: 'load' | 'unload') =>
      action === 'load' ? apiClient.loadModel(modelName) : apiClient.unloadModel(modelName),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['modelRuntime'] });
      void queryClient.invalidateQueries({ queryKey: ['modelStatus'] });
      void queryClient.invalidateQueries({ queryKey: ['serverHealth'] });
    },
  });
  const changing =
    state?.operation === 'loading' || state?.operation === 'unloading' || mutation.isPending;
  const phase = !state
    ? 'checking'
    : state?.operation === 'error'
      ? 'error'
      : changing
        ? state?.operation === 'unloading' || mutation.variables === 'unload'
          ? 'unloading'
          : 'loading'
        : state?.loaded
          ? 'loaded'
          : 'unloaded';
  const labels = {
    checking: t('models.runtime.checking', 'Reading model state'),
    loading: t('models.runtime.loading', 'Loading model'),
    unloading: t('models.runtime.unloading', 'Unloading model'),
    loaded: t('models.runtime.loaded', 'Loaded in memory'),
    unloaded: t('models.runtime.unloaded', 'Not loaded in memory'),
    error: t('models.runtime.error', 'Last model operation failed'),
  };
  return (
    <div
      className="rounded-md border p-3 text-xs space-y-2"
      aria-label={t('models.runtime.label', 'Model memory state')}
    >
      <div className="flex items-center gap-2" role="status">
        {changing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        <span>{labels[phase]}</span>
        {state?.operation_elapsed_seconds != null && changing && (
          <span className="tabular-nums">{Math.ceil(state.operation_elapsed_seconds)}s</span>
        )}
      </div>
      {state?.runtime_busy && !changing && (
        <p className="text-muted-foreground">
          {t(
            'models.runtime.busy',
            'Model is busy; finish or stop the current task before switching.',
          )}
          {state.runtime_activity ? ` (${state.runtime_activity})` : ''}
        </p>
      )}
      {(mutation.error || state?.operation_error || runtime.error) && (
        <p role="alert" className="break-words text-destructive">
          {mutation.error?.message || state?.operation_error || runtime.error?.message}
        </p>
      )}
      {!state?.loaded && model && !model.downloaded && (
        <Link className="block underline text-muted-foreground" to="/models">
          {t('models.runtime.downloadFirst', 'Download this model from Models first')}
        </Link>
      )}
      <div className="flex gap-2">
        {runtime.error && (
          <Button type="button" size="sm" variant="outline" onClick={() => void runtime.refetch()}>
            {t('models.runtime.reconnect', 'Reconnect')}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={
            !state || changing || state.runtime_busy || (!state.loaded && !model?.downloaded)
          }
          onClick={() => {
            mutation.reset();
            mutation.mutate(state?.loaded ? 'unload' : 'load');
          }}
        >
          {changing
            ? labels[phase]
            : state?.loaded
              ? t('models.runtime.unload', 'Unload')
              : t('models.runtime.load', 'Load and switch')}
        </Button>
        {state?.loaded && (
          <span className="self-center text-muted-foreground">
            {t('models.runtime.keepsFiles', 'Unloading keeps downloaded files')}
          </span>
        )}
      </div>
    </div>
  );
}
