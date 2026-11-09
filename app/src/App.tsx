import { RouterProvider } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { DictateWindow } from '@/components/DictateWindow/DictateWindow';
import { StartupScreen } from '@/components/StartupScreen';
import { useAutoUpdater } from '@/hooks/useAutoUpdater';
import { useThemeSync } from '@/hooks/useThemeSync';
import { useChordSync } from '@/lib/hooks/useChordSync';
import { isRecoverableStartupError, waitForHealthyServer } from '@/lib/serverStartup';
import { usePlatform } from '@/platform/PlatformContext';
import { router } from '@/router';
import { useLogStore } from '@/stores/logStore';
import {
  getDefaultServerUrl,
  isLoopbackVoiceboxServerUrl,
  useServerStore,
} from '@/stores/serverStore';

function isDictateView(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('view') === 'dictate';
}

function App() {
  useThemeSync();

  // The dictate window runs in a separate Tauri webview that must skip
  // server bootstrap (the main window owns that lifecycle) and render only
  // the floating recording surface. Split into a sibling component so the
  // main app's hooks are not called on the dictate path.
  if (isDictateView()) {
    return <DictateWindow />;
  }
  return <MainApp />;
}

function MainApp() {
  const platform = usePlatform();
  const [serverReady, setServerReady] = useState(false);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [startupStartedAt] = useState(Date.now);
  const startupPromiseRef = useRef<Promise<string> | null>(null);

  // Automatically check for app updates on startup and show toast notifications
  useAutoUpdater({ checkOnMount: true, showToast: true });

  // Replay the saved chord into the Rust hotkey listener every time
  // capture_settings resolves or the user edits the chord.
  useChordSync();

  // Sync stored setting to Rust on startup
  useEffect(() => {
    if (platform.metadata.isTauri) {
      const keepRunning = useServerStore.getState().keepServerRunningOnClose;
      platform.lifecycle.setKeepServerRunning(keepRunning).catch((error) => {
        console.error('Failed to sync initial setting to Rust:', error);
      });
    }
    // Empty dependency array - platform is stable from context, only run once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform.metadata.isTauri, platform.lifecycle]);

  // Setup lifecycle callbacks
  useEffect(() => {
    platform.lifecycle.onServerReady = () => {
      setServerReady(true);
    };
    // Empty dependency array - platform is stable from context, only run once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform.lifecycle]);

  // Load and follow the persistent server log. Polling works even when this
  // app instance reused a backend process started by an earlier instance.
  useEffect(() => {
    let disposed = false;
    const refreshLogs = async () => {
      try {
        const entries = await platform.lifecycle.getServerLogs();
        if (!disposed) useLogStore.getState().replaceEntries(entries);
      } catch (error) {
        console.error('Failed to load server logs:', error);
      }
    };
    void refreshLogs();
    const interval = window.setInterval(() => void refreshLogs(), 1000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [platform.lifecycle]);

  // Setup window close handler and auto-start server when running in Tauri (production only)
  useEffect(() => {
    if (!platform.metadata.isTauri) {
      const serverUrl = getDefaultServerUrl();
      const currentServerUrl = useServerStore.getState().serverUrl;
      if (currentServerUrl !== serverUrl && isLoopbackVoiceboxServerUrl(currentServerUrl)) {
        useServerStore.getState().setServerUrl(serverUrl);
      }
      setServerReady(true); // Web assumes server is running
      return;
    }

    // Setup window close handler to check setting and stop server if needed
    // This works in both dev and prod, but will only stop server if it was started by the app
    platform.lifecycle.setupWindowCloseHandler().catch((error) => {
      console.error('Failed to setup window close handler:', error);
    });

    // Only auto-start server in production mode
    // In dev mode, user runs server separately
    if (!import.meta.env?.PROD) {
      console.log('Dev mode: Skipping auto-start of server (run it separately)');
      setServerReady(true); // Mark as ready so UI doesn't show loading screen
      // Mark that server was not started by app (so we don't try to stop it on close)
      window.__voiceboxServerStartedByApp = false;
      return;
    }

    const controller = new AbortController();
    const localUrl = getDefaultServerUrl();
    if (!startupPromiseRef.current) {
      const { mode, customModelsDir } = useServerStore.getState();
      startupPromiseRef.current = platform.lifecycle.startServer(
        mode === 'remote',
        customModelsDir,
      );
    }

    const finish = (url: string) => {
      if (controller.signal.aborted) return;
      useServerStore.getState().setServerUrl(url);
      setStartupError(null);
      setServerReady(true);
    };

    void startupPromiseRef.current
      .then((url) => {
        window.__voiceboxServerStartedByApp = true;
        finish(url);
      })
      .catch(async (error: unknown) => {
        if (controller.signal.aborted) return;
        window.__voiceboxServerStartedByApp = false;
        if (!isRecoverableStartupError(error)) {
          setStartupError(error instanceof Error ? error.message : String(error));
          return;
        }
        // Older desktop binaries can return after 120s while their child is
        // still importing dependencies. Keep the startup view and reconnect.
        window.__voiceboxServerStartedByApp = /startup timeout/i.test(String(error));
        try {
          await waitForHealthyServer(localUrl, controller.signal);
          finish(localUrl);
        } catch (recoveryError) {
          if (!controller.signal.aborted) {
            setStartupError(
              recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
            );
          }
        }
      });

    // Preserve the native startup promise across React StrictMode's effect
    // replay; only cancel this subscription and its recovery health probes.
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform.metadata.isTauri, platform.lifecycle]);

  if (platform.metadata.isTauri && !serverReady) {
    return (
      <StartupScreen
        startedAt={startupStartedAt}
        error={startupError}
        onRetry={() => window.location.reload()}
      />
    );
  }

  return <RouterProvider router={router} />;
}

export default App;
