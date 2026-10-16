import { invoke } from '@tauri-apps/api/core';
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useEffect, useRef, useState } from 'react';
import { CapturePill } from '@/components/CapturePill/CapturePill';
import { apiClient } from '@/lib/api/client';
import { playAgentSpeech } from '@/lib/audio/agentSpeechPlayback';
import { AgentSpeechQueue, type AgentSpeechJob, type AgentSpeechState } from '@/lib/audio/agentSpeechQueue';
import type { FocusSnapshot } from '@/lib/api/types';
import { useCaptureRecordingSession } from '@/lib/hooks/useCaptureRecordingSession';
import { useServerStore } from '@/stores/serverStore';

/**
 * Floating dictate surface shown in a separate transparent Tauri window.
 * Mounted when the URL contains ``?view=dictate``. The main window bypasses
 * this branch and renders the full app shell.
 *
 * The pill surfaces for two independent cycles:
 *   1. User dictation — driven by ``dictate:start`` / ``dictate:stop``
 *      from the Rust hotkey monitor.
 *   2. Agent speech — driven by ``dictate:speak-start`` / ``dictate:speak-stop``
 *      from the Rust ``speak_monitor`` (which owns the backend SSE stream).
 *      A bounded FIFO plays live PCM or waits for saved audio for legacy
 *      callers. Only playback completion dismisses a successful job.
 */
export function DictateWindow() {
  // Force the host document chrome to be transparent so the Tauri window
  // takes on the pill's own shape.
  useEffect(() => {
    const prevHtml = document.documentElement.style.background;
    const prevBody = document.body.style.background;
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    return () => {
      document.documentElement.style.background = prevHtml;
      document.body.style.background = prevBody;
    };
  }, []);

  // Snapshot of the focused UI element at chord-start, shipped over from
  // Rust on the ``dictate:start`` payload. Held in a ref so it survives
  // the 1–2 s transcribe + refine window — the paste only fires once the
  // final text comes back.
  const focusRef = useRef<FocusSnapshot | null>(null);

  const session = useCaptureRecordingSession({
    onFinalText: async (text, _capture, allowAutoPaste) => {
      const focus = focusRef.current;
      // Consume-once: a second chord before this fires would overwrite
      // focusRef, but nulling it here guards against the late-arriving
      // refine-result firing a paste after the user has moved on.
      focusRef.current = null;
      if (!allowAutoPaste) return;
      if (!focus || !text.trim()) return;
      try {
        await invoke('paste_final_text', { text, focus });
      } catch (err) {
        // Surface accessibility failures to the main window so it can prompt
        // the user to grant permission. Other errors stay swallowed —
        // the transcription still landed in the captures list.
        const msg = err instanceof Error ? err.message : String(err);
        if (/accessibility/i.test(msg)) {
          emit('system:accessibility-missing').catch(() => {});
        }
        console.warn('[dictate] paste_final_text failed:', err);
      }
    },
  });

  // Route the chord events emitted from Rust into the session hook. Using a
  // ref so the `listen` effect only subscribes once — rebinding every render
  // would thrash the Tauri event bridge.
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    const unlistens: Promise<UnlistenFn>[] = [];
    unlistens.push(
      listen<{ focus: FocusSnapshot | null }>('dictate:start', (event) => {
        focusRef.current = event.payload?.focus ?? null;
        sessionRef.current.startRecording();
      }),
    );
    unlistens.push(
      listen('dictate:stop', () => {
        if (sessionRef.current.isRecording) sessionRef.current.stopRecording();
      }),
    );
    return () => {
      for (const p of unlistens) p.then((fn) => fn()).catch(() => {});
    };
  }, []);

  // One queue owns all agent audio in this window. Main-window autoplay is
  // suppressed by the backend's rest/mcp source marker.
  const [speaking, setSpeaking] = useState<AgentSpeechState | null>(null);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const speechQueueRef = useRef<AgentSpeechQueue | null>(null);

  useEffect(() => {
    const queue = new AgentSpeechQueue({
      play: (job, signal, update) => playAgentSpeech(job, useServerStore.getState().serverUrl, signal, update),
      cancel: (id) => apiClient.cancelGeneration(id),
      state: (state) => {
        setSpeaking(state);
        if (state) {
          setSpeechError(null);
          emit('dictate:show').catch(() => {});
        }
      },
      error: (error) => {
        setSpeechError(error instanceof Error ? error.message : String(error));
        emit('dictate:show').catch(() => {});
      },
    });
    speechQueueRef.current = queue;
    const unlistens = [
      listen<string>('dictate:speak-start', (event) => {
        try {
          const job = JSON.parse(event.payload) as AgentSpeechJob;
          if (typeof job.generation_id === 'string') queue.enqueue(job);
        } catch { /* Ignore malformed external events. */ }
      }),
      listen<string>('dictate:speak-stop', (event) => {
        try {
          const data = JSON.parse(event.payload) as { generation_ids?: string[] };
          if (Array.isArray(data.generation_ids)) queue.stop(data.generation_ids);
        } catch { /* Ignore malformed external events. */ }
      }),
      listen('dictate:start', () => queue.stopAll()),
    ];
    return () => {
      speechQueueRef.current = null;
      queue.stopAll();
      for (const pending of unlistens) pending.then((fn) => fn()).catch(() => {});
    };
  }, []);

  const effectiveState = speaking ? (speaking.playing ? 'speaking' : 'buffering')
    : speechError ? 'error' : session.pillState;
  const effectiveElapsed = speaking ? speaking.elapsedMs : session.pillElapsedMs;

  // When the pill cycle ends (no capture AND no speak), tell Rust to tuck
  // the window away. Rust owns the hide + park-off-screen + click-through
  // combo because calling hide() directly from JS has been unreliable for
  // transparent always-on-top windows on macOS.
  useEffect(() => {
    if (effectiveState === 'hidden') {
      emit('dictate:hide').catch(() => {});
    }
  }, [effectiveState]);

  return (
    <div
      className="h-screen w-screen flex items-center justify-center px-3"
      style={{ background: 'transparent' }}
    >
      {effectiveState !== 'hidden' ? (
        <CapturePill
          state={effectiveState}
          elapsedMs={effectiveElapsed}
          errorMessage={speechError || session.errorMessage}
          onDismiss={() => { setSpeechError(null); session.dismissError(); }}
          onStop={speaking ? () => speechQueueRef.current?.stopAll() : session.isRecording ? session.stopRecording : undefined}
        />
      ) : null}
    </div>
  );
}
