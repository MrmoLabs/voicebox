import { Check, ChevronDown, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import voiceboxLogo from '@/assets/voicebox-logo.png';
import { TOP_SAFE_AREA_PADDING } from '@/lib/constants/ui';
import { getStartupPhase, STARTUP_SLOW_MS } from '@/lib/serverStartup';
import { cn } from '@/lib/utils/cn';
import { useLogStore } from '@/stores/logStore';
import { TitleBarDragRegion } from './TitleBarDragRegion';

interface StartupScreenProps {
  startedAt: number;
  error: string | null;
  onRetry: () => void;
}

export function StartupScreen({ startedAt, error, onRetry }: StartupScreenProps) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now);
  const entries = useLogStore((state) => state.entries);
  const logs = entries.filter((entry) => entry.timestamp >= startedAt);
  const phase = getStartupPhase(logs, startedAt);
  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));
  const slow = now - startedAt >= STARTUP_SLOW_MS;
  const timedOut = error !== null && /startup timeout|startup wait limit/i.test(error);
  const steps = ['launch', 'database', 'runtime', 'connect'] as const;

  useEffect(() => {
    if (error) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [error]);

  return (
    <div
      className={cn(
        'h-screen overflow-y-auto bg-background text-foreground',
        TOP_SAFE_AREA_PADDING,
      )}
    >
      <TitleBarDragRegion />
      <main className="mx-auto flex min-h-full w-full max-w-lg flex-col justify-center px-6 py-5">
        <img src={voiceboxLogo} alt="Voicebox" className="mx-auto mb-4 size-24 object-contain" />
        <div aria-live="polite" className="text-center">
          <h1 className="text-xl font-semibold tracking-tight">
            {error
              ? t(timedOut ? 'startup.waitingTitle' : 'startup.errorTitle')
              : t(slow ? 'startup.slowTitle' : 'startup.title')}
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {error
              ? t(timedOut ? 'startup.waitingDescription' : 'startup.errorDescription')
              : t(slow ? 'startup.slowDescription' : `startup.descriptions.${steps[phase]}`)}
          </p>
        </div>

        <div className="mt-6 rounded-xl border bg-card p-5">
          <div className="mb-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>{t(error ? 'startup.paused' : 'startup.working')}</span>
            <span className="tabular-nums">
              {t('startup.elapsed', {
                time: `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`,
              })}
            </span>
          </div>
          {!error && (
            <div
              role="progressbar"
              aria-label={t('startup.progress')}
              className="h-1.5 overflow-hidden rounded-full bg-muted"
            >
              <div className="startup-progress h-full w-1/3 rounded-full bg-primary" />
            </div>
          )}
          <ol className="mt-5 space-y-3">
            {steps.map((step, index) => (
              <li
                key={step}
                aria-current={index === phase ? 'step' : undefined}
                className={cn(
                  'flex items-center gap-3 text-sm',
                  index > phase && 'text-muted-foreground',
                )}
              >
                <span
                  className={cn(
                    'flex size-6 shrink-0 items-center justify-center rounded-full border',
                    index < phase && 'border-primary/20 bg-primary/10 text-primary',
                    index === phase && 'border-primary text-primary',
                  )}
                >
                  {index < phase ? (
                    <Check className="size-3.5" aria-hidden="true" />
                  ) : index === phase && !error ? (
                    <Loader2
                      className="size-3.5 animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  ) : (
                    <span className="text-xs">{index + 1}</span>
                  )}
                </span>
                <span className={cn(index === phase && 'font-medium text-foreground')}>
                  {t(`startup.steps.${step}`)}
                </span>
              </li>
            ))}
          </ol>
        </div>

        {error && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-5 self-center rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            {t(timedOut ? 'startup.checkAgain' : 'startup.retry')}
          </button>
        )}
        <p className="mt-4 text-center text-xs leading-5 text-muted-foreground">
          {t(error ? 'startup.help' : 'startup.automatic')}
        </p>
        <details className="group mt-5 text-xs text-muted-foreground">
          <summary className="flex cursor-pointer list-none items-center justify-center gap-1.5 py-2 hover:text-foreground">
            {t('startup.details')}
            <ChevronDown
              className="size-3.5 transition-transform group-open:rotate-180"
              aria-hidden="true"
            />
          </summary>
          <textarea
            readOnly
            aria-label={t('startup.details')}
            className="mt-2 h-40 w-full resize-none overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px] leading-5"
            value={`${error ? `${error}\n\n` : ''}${
              logs.length
                ? logs
                    .slice(-40)
                    .map((entry) => entry.line)
                    .join('\n')
                : t('startup.noLogs')
            }`}
          />
        </details>
      </main>
    </div>
  );
}
