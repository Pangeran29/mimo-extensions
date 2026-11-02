import { diagnosticsReady, diagnosticConfig, configureDiagnostics } from './diagnostics';
import {
  beginAgentDiagnostics,
  agentDiagnosticsActive,
  resumeAgentDiagnostics,
  stopAgentDiagnostics,
  finishAgentDiagnostics,
  agentEvent,
  readAgentReport,
} from './agent-diagnostics';
import { checkMicrophone } from './microphone';
import { BUILD_ID } from './build-info';
import { REPLAY_LAB } from './replay/config';
import { ReplayAudioSource } from './replay/source';
import { appendEvent, getRun, getSource, getSourceBlob, listRuns, updateRun } from './replay/store';
import type { ReplayRun, ReplayStatus } from './replay/types';
import { BATCH_SECONDS } from './transcription/batch';
import { LiveMemoController as AssistantController } from './assistant/v2/controller';
import { AssistantClient } from './assistant/client';
import { loadAssistant, recoveredAssistant, saveAssistant } from './assistant/v2/store';
const aiClient = new AssistantClient();
const assistant = new AssistantController(
  aiClient,
  (snapshot) => {
    recordReplayAssistant(snapshot);
    void chrome.runtime
      .sendMessage({ target: 'ui', type: 'ASSISTANT_STATE', snapshot })
      .catch(() => {});
  },
  saveAssistant,
  () => {
    void settleAgentReport().finally(() => {
      void chrome.runtime
        .sendMessage({ target: 'worker', type: 'ASSISTANT_SETTLED' })
        .catch(() => {});
    });
  },
);
import { RecorderEngine } from './engine';
import { Transcriber } from './transcription/controller';
import { errorText, type RecorderMessage, type Reply, type Status } from './types';
const assistantReady = loadAssistant()
  .then((s) => {
    if (s) assistant.restore(recoveredAssistant(s));
  })
  .catch(() => {});
let assistantSessionId: string | undefined;
let agentDiagnosticOptIn = false;
let agentFinalizing = false;
let replayRun: ReplayRun | undefined;
let replaySource: ReplayAudioSource | undefined;
let replayTimer: ReturnType<typeof setInterval> | undefined;
let replayDrainDeadline = 0;
let replayWrites = Promise.resolve();
let replayAssistantSignature = '';
let replayTranscriptSignature = '';
let replayStopping = false;
let replaySettling = false;
let replayRecovery: Promise<void> | undefined;
function recoverReplay(): Promise<void> {
  return (replayRecovery ??= (async () => {
    if (!REPLAY_LAB || replayRun) return;
    const saved = (await listRuns())[0];
    if (!saved) return;
    if (!saved.endedAt) {
      saved.phase = 'error';
      saved.endedAt = Date.now();
      saved.partial = true;
      saved.stopReason = 'interrupted';
      saved.error = 'Replay was interrupted. Start a new run to repeat the recording.';
      await updateRun(saved);
    }
    replayRun = saved;
  })());
}
function replayActive(): boolean {
  return !!replayRun && ['starting', 'playing', 'draining', 'stopping'].includes(replayRun.phase);
}
function replayEvent(kind: string, data: unknown): void {
  if (!REPLAY_LAB || !replayRun) return;
  const run = replayRun;
  const sourceMs = replaySource?.positionMs ?? run.sourceMs;
  replayWrites = replayWrites
    .then(() => appendEvent(run.id, kind, data, sourceMs))
    .catch(() => {
      run.error = 'Some replay evidence could not be saved. The run is incomplete.';
      run.partial = true;
    });
}
function recordReplayAssistant(snapshot: import('./assistant/types').AssistantSnapshot): void {
  if (!replayRun || snapshot.sessionId !== replayRun.sessionId) return;
  const signature = JSON.stringify([
    snapshot.version,
    snapshot.phase,
    snapshot.liveV2?.stage,
    snapshot.liveV2?.memo?.id,
    snapshot.liveV2?.activeId,
    snapshot.analysisError,
    snapshot.liveV2?.feedbackVersion,
  ]);
  if (signature === replayAssistantSignature) return;
  replayAssistantSignature = signature;
  replayEvent('assistant-state', snapshot);
}
async function replayStatus(): Promise<ReplayStatus> {
  await recoverReplay();
  if (replayRun) {
    const stored = await getRun(replayRun.id).catch(() => undefined);
    if (stored?.limited) replayRun.limited = true;
    if (stored?.eventBytes) replayRun.eventBytes = stored.eventBytes;
  }
  return {
    enabled: REPLAY_LAB,
    phase: replayRun?.phase ?? 'idle',
    run: replayRun ? structuredClone(replayRun) : undefined,
    sourceMs: replaySource?.positionMs ?? replayRun?.sourceMs ?? 0,
    durationMs: replayRun?.durationMs,
    transcriptionBusy: transcription.busy,
    assistantBusy: assistant.busy || assistant.liveProgress().queued || agentFinalizing,
    error: replayRun?.error,
  };
}
async function saveReplayFinal(): Promise<void> {
  if (!replayRun || replaySettling || replayRun.endedAt || transcription.busy || assistant.busy || agentFinalizing)
    return;
  replaySettling = true;
  const run = replayRun;
  try {
    await settleAgentReport();
    run.agentReport = await readAgentReport(run.sessionId).catch(() => undefined);
    if (run.agentReport?.session.limited || run.agentReport?.session.storageError) run.partial = true;
    if (assistant.snapshot.sessionId === run.sessionId)
      run.finalAssistant = structuredClone(assistant.snapshot);
    const transcript = await transcription.status();
    if (transcript.sessionId === run.sessionId) run.finalTranscript = transcript;
    if (
      run.finalTranscript?.incomplete ||
      run.finalTranscript?.phase === 'failed' ||
      run.finalAssistant?.analysisError
    )
      run.partial = true;
    run.endedAt = Date.now();
    run.phase = run.error ? 'error' : 'complete';
    replayEvent('run-finished', {
      reason: run.stopReason,
      partial: run.partial ?? false,
      lastSegmentId: assistant.snapshot.lastSegmentId,
    });
    await replayWrites;
    await updateRun(run);
    await publishReplayStatus();
  } finally {
    replaySettling = false;
  }
}
async function publishReplayStatus(): Promise<void> {
  void chrome.runtime
    .sendMessage({ target: 'ui', type: 'REPLAY_STATE', status: await replayStatus() })
    .catch(() => {});
  void liveStatus()
    .then((status) => chrome.runtime.sendMessage({ target: 'worker', type: 'STATE', status }))
    .catch(() => {});
}
async function stopReplay(reason: ReplayRun['stopReason'] = 'manual'): Promise<void> {
  if (!replayRun || !replayActive() || replayRun.phase === 'stopping' || replayStopping) return;
  replayStopping = true;
  try {
    const run = replayRun;
    run.sourceMs = replaySource?.positionMs ?? run.sourceMs;
    run.stopReason = reason;
    run.partial ||= reason !== 'eof';
    run.phase = 'stopping';
    if (replayTimer) clearInterval(replayTimer);
    replayTimer = undefined;
    replayEvent('stop-requested', { reason });
    // The same explicit Stop boundary as live capture: no late memo publication.
    assistant.stopCapture();
    stopAgentDiagnostics(run.sessionId);
    await transcription.stopCapture();
    await replaySource?.release();
    replaySource = undefined;
    await replayWrites;
    await updateRun(run).catch(() => {});
    await publishReplayStatus();
  } finally {
    replayStopping = false;
  }
  await saveReplayFinal();
}
async function tickReplay(): Promise<void> {
  if (!replayRun || !replayActive() || replayStopping) return;
  replayRun.sourceMs = replaySource?.positionMs ?? replayRun.sourceMs;
  replayEvent('source-position', { phase: replayRun.phase });
  await updateRun(replayRun).catch(() => {
    if (replayRun) replayRun.partial = true;
  });
  if (replayRun.phase === 'draining') {
    const progress = assistant.liveProgress();
    const transcript = await transcription.status();
    const lastSegment = Math.max(-1, ...transcript.segments.map((s) => s.id));
    if (
      !transcription.busy &&
      !assistant.busy &&
      !progress.queued &&
      assistant.snapshot.lastSegmentId >= lastSegment
    )
      await stopReplay('eof');
    else if (Date.now() >= replayDrainDeadline) {
      replayRun.error = 'Replay reached its 60-second drain limit. Pending work is recorded as incomplete.';
      await stopReplay('drain-timeout');
    }
  }
  await publishReplayStatus();
}
async function startReplay(sourceId: string, monitor = false): Promise<ReplayStatus> {
  if (!REPLAY_LAB) throw Error('Replay Lab is available only in the research build.');
  await recoverReplay();
  if (replayActive() || engine.busy || transcription.busy || assistant.busy)
    throw Error('Wait until the current capture and AI work have finished.');
  const source = await getSource(sourceId);
  const blob = await getSourceBlob(sourceId);
  if (!source || !blob) throw Error('Choose the recording again. Its local source is unavailable.');
  const id = crypto.randomUUID();
  const settings = (await chrome.runtime.sendMessage({ target: 'worker', type: 'ASSISTANT_SETTINGS' }))?.value?.settings;
  replayRun = {
    id,
    sessionId: id,
    sourceId,
    source,
    phase: 'starting',
    startedAt: Date.now(),
    buildId: BUILD_ID,
    protocol: 2,
    sourceMs: 0,
    settings: {
      provider: settings?.provider,
      model: settings?.model,
      objective: settings?.goal,
      asrBatchSeconds: BATCH_SECONDS,
    },
  };
  replayAssistantSignature = replayTranscriptSignature = '';
  await updateRun(replayRun);
  replaySource = new ReplayAudioSource();
  try {
    // Decode/metadata validation precedes any transcription or model work.
    await replaySource.prepare(blob, monitor);
    replayRun.durationMs = replaySource.durationMs;
    replayRun.source.durationMs = replaySource.durationMs;
    await updateRun(replayRun);
    await assistantReady;
    assistantSessionId = id;
    agentDiagnosticOptIn = true;
    await beginAgentDiagnostics(id, true);
    assistant.observe({
      ...(await transcription.status()),
      sessionId: id,
      phase: 'transcribing',
      segments: [],
    });
    await transcription.start(replaySource.destination.stream, id, replaySource.context);
    if ((await transcription.status()).phase !== 'transcribing')
      throw Error('Speech detection could not start. Check transcription in Settings.');
    replaySource.audio.onended = () => {
      if (!replayRun || replayRun.sessionId !== id || replayRun.phase !== 'playing') return;
      replayRun.sourceMs = replaySource?.positionMs ?? replayRun.durationMs ?? 0;
      replayRun.phase = 'draining';
      replayDrainDeadline = Date.now() + 60000;
      replayEvent('source-ended', { drainDeadlineMs: 60000 });
      // Flush the final VAD window while the memo remains live. This is replay
      // EOF, distinct from the user's Stop, so the final speech gets evaluated.
      void transcription.stopCapture().catch(() => {});
      void publishReplayStatus();
    };
    replaySource.audio.onerror = () => {
      if (!replayRun || replayRun.sessionId !== id) return;
      replayRun.error = 'Audio playback failed. Try a WAV recording.';
      void stopReplay('source-error');
    };
    replayRun.phase = 'playing';
    replayEvent('run-started', {
      source,
      durationMs: replayRun.durationMs,
      playbackRate: 1,
      monitor,
      settings: replayRun.settings,
    });
    await replaySource.play();
    replayTimer = setInterval(() => void tickReplay().catch(() => {}), 1000);
    await updateRun(replayRun);
    await publishReplayStatus();
    return replayStatus();
  } catch (error) {
    replayRun.error = errorText(error);
    replayRun.partial = true;
    await stopReplay('source-error');
    replayRun.phase = 'error';
    replayRun.endedAt = Date.now();
    await updateRun(replayRun).catch(() => {});
    throw error;
  }
}
async function settleAgentReport(): Promise<void> {
  if (
    !assistant.snapshot.sessionId ||
    !agentDiagnosticsActive(assistant.snapshot.sessionId) ||
    agentFinalizing ||
    transcription.busy ||
    !['complete', 'disabled'].includes(assistant.snapshot.phase)
  )
    return;
  agentFinalizing = true;
  try {
    const panel = await Promise.race([
      chrome.runtime
        .sendMessage({ target: 'ui', type: 'MEMO_PRESENTATION_STATUS', includeMemoText: true })
        .catch(() => undefined),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 250)),
    ]);
    const automatic = await finishAgentDiagnostics(assistant.snapshot.sessionId, {
      assistant: assistant.snapshot,
      savedAssistant: await loadAssistant().catch(() => undefined),
      transcript: await transcription.status(),
      presentation: {
        panel: panel?.ok ? panel.value : null,
        correlated:
          panel?.value?.sessionId === assistant.snapshot.sessionId &&
          panel?.value?.requestId === assistant.snapshot.lastAnalysis?.requestId,
        limitation:
          'Optional DOM reading from one responding panel, not proof of visible browser paint. Null means unavailable.',
      },
    });
    if (automatic && !replayRun)
      await chrome.runtime.sendMessage({
        target: 'worker',
        type: 'AGENT_REPORT_EXPORT',
        sessionId: assistant.snapshot.sessionId,
        automatic: true,
      });
  } catch {
    /* Reports never interrupt recording, saving or notes. */
  } finally {
    agentFinalizing = false;
    if (replayRun?.phase === 'stopping' && !replaySettling) void saveReplayFinal();
  }
}
const visiblePopups = new Set<chrome.runtime.Port>();
const visibleAssistants = new Set<chrome.runtime.Port>();
const transcription = new Transcriber(
  (snapshot, ephemeral) => {
    if (!ephemeral && assistantSessionId === snapshot.sessionId) assistant.observe(snapshot);
    if (!ephemeral && replayRun?.sessionId === snapshot.sessionId) {
      const signature = JSON.stringify([snapshot.phase, snapshot.segments]);
      if (signature !== replayTranscriptSignature) {
        replayTranscriptSignature = signature;
        replayEvent('transcript-state', snapshot);
      }
    }
    if (ephemeral && !visiblePopups.size && !visibleAssistants.size) return;
    void chrome.runtime
      .sendMessage({ target: 'ui', type: 'TRANSCRIPT_STATE', snapshot })
      .catch(() => {});
  },
  () => {
    if (!(replayRun?.phase === 'draining')) assistant.finish();
    if (replayRun?.phase === 'stopping') void saveReplayFinal();
    void chrome.runtime
      .sendMessage({ target: 'worker', type: 'TRANSCRIPTION_SETTLED' })
      .catch(() => {});
  },
);
const engine = new RecorderEngine(
  () => {
    void liveStatus()
      .then((status) => chrome.runtime.sendMessage({ target: 'worker', type: 'STATE', status }))
      .catch(() => {});
  },
  (id) => {
    void chrome.runtime.sendMessage({ target: 'worker', type: 'READY', id }).catch(() => {});
  },
  {
    start: async (stream, id, context) => {
      await assistantReady;
      assistantSessionId = id;
      await beginAgentDiagnostics(id, agentDiagnosticOptIn);
      assistant.observe({
        ...(await transcription.status()),
        sessionId: id,
        phase: 'transcribing',
        segments: [],
      });
      await transcription.start(stream, id, context);
      if ((await transcription.status()).phase !== 'transcribing')
        throw new Error('Speech detection could not start. Check transcription in Settings.');
    },
    stopCapture: async () => {
      assistant.stopCapture();
      await transcription.stopCapture();
      if (!transcription.busy) assistant.finish();
    },
  },
);
async function liveStatus(): Promise<Status> {
  await recoverReplay();
  const normal = await engine.status();
  if (replayRun) {
    return {
      ...normal,
      phase:
        replayRun.phase === 'starting'
          ? 'starting'
          : replayRun.phase === 'stopping'
            ? 'stopping'
            : replayActive()
              ? 'recording'
              : 'idle',
      session: {
        id: replayRun.sessionId,
        createdAt: replayRun.startedAt,
        sourceTitle: replayRun.source.name,
        tabId: -1,
        filename: replayRun.source.name,
        status: replayActive() ? 'capturing' : 'ready',
        bytes: 0,
        chunks: 0,
        durationMs: replaySource?.positionMs ?? replayRun.sourceMs,
        partial: replayRun.partial ?? false,
        sources: [],
      },
      replay: {
        runId: replayRun.id,
        phase: replayRun.phase,
        sourceMs: replaySource?.positionMs ?? replayRun.sourceMs,
      },
      transcriptionBusy: transcription.busy,
      assistantBusy: assistant.busy || agentFinalizing || replayRun.phase === 'draining',
    };
  }
  return {
    ...normal,
    transcriptionBusy: transcription.busy,
    assistantBusy: assistant.busy || agentFinalizing,
  };
}
chrome.runtime.onMessage.addListener((message: RecorderMessage, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message.target !== 'recorder') return;
  void (async () => {
    if (message.diagnostics) configureDiagnostics(message.diagnostics);
    switch (message.type) {
      case 'ASSISTANT_INIT':
        await assistantReady;
        await diagnosticsReady;
        assistant.setMemoPolicy(diagnosticConfig().policy);
        assistant.configure(message.settings);
        if (
          message.settings.enabled &&
          (message.apiKey || message.settings.provider === 'deepinfra')
        )
          aiClient.init(message.apiKey ?? '', message.settings.provider ?? 'hpop');
        else aiClient.close();
        const savedTranscript = await transcription.status();
        // Recovery drains ASR only. A restored/closed session never resumes live contributions.
        if (
          savedTranscript.sessionId &&
          savedTranscript.phase === 'transcribing' &&
          (await engine.status()).phase !== 'idle'
        ) {
          assistantSessionId = savedTranscript.sessionId;
          assistant.observe(savedTranscript);
        }
        return assistant.snapshot;
      case 'ASSISTANT_STATUS':
        await assistantReady;
        return assistant.snapshot;
      case 'ASSISTANT_RESUME':
        assistant.resume();
        return assistant.snapshot;
      case 'ASSISTANT_FEEDBACK':
        assistant.feedback(message.sessionId, message.issueKey, message.feedback);
        return assistant.snapshot;
      case 'ASSISTANT_DEEPER':
        void assistant.deeper(message.sessionId);
        return assistant.snapshot;
      case 'ASSISTANT_SETTINGS':
      case 'ASSISTANT_CONFIGURE':
        throw new Error('Unsupported recorder action.');
      case 'PREPARE_TRANSCRIPTION':
        await transcription.prepare();
        return transcription.status();
      case 'TRANSCRIPT_STATUS':
        return transcription.status();
      case 'CHECK_MICROPHONE':
        await checkMicrophone();
        return { ready: true };
      case 'START':
        if (assistant.busy) throw new Error('Wait until AI has finished.');
        if (transcription.busy) throw new Error('Wait until the current transcript has finished.');
        agentDiagnosticOptIn = message.agentDiagnostics === true;
        replayRun = undefined;
        await engine.start(message.streamId, message.tabId, message.title);
        break;
      case 'REPLAY_START':
        return startReplay(message.sourceId, message.monitor);
      case 'REPLAY_STATUS':
        return replayStatus();
      case 'REPLAY_STOP':
        await stopReplay();
        return replayStatus();
      case 'REPLAY_UI_EVENT':
        if (REPLAY_LAB && replayRun?.sessionId === message.sessionId)
          replayEvent(message.event.kind, {
            ...message.event.data,
            uiAt: message.event.at,
            monotonicMs: message.event.monotonicMs,
            timeOrigin: message.event.timeOrigin,
          });
        return { accepted: REPLAY_LAB && replayRun?.sessionId === message.sessionId };
      case 'STOP':
        if (replayActive()) {
          await stopReplay();
          break;
        }
        assistant.stopCapture();
        stopAgentDiagnostics(assistantSessionId);
        agentEvent(assistantSessionId, 'capture-stopped', {
          pendingTranscription: transcription.busy,
        });
        engine.stop();
        break;
      case 'STATUS':
        break;
      case 'EXPORT':
        return engine.export(message.id);
      case 'DOWNLOAD_DONE':
        await engine.downloadDone(message.id, message.success, message.error, message.cancelled);
        break;
      case 'DISCARD':
        await engine.discard(message.id);
        break;
    }
    return liveStatus();
  })()
    .then((value) => respond({ ok: true, value } satisfies Reply<unknown>))
    .catch((error) => respond({ ok: false, error: errorText(error) } satisfies Reply));
  return true;
});
// A port exists only while a popup is visible. No polling when it is closed.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'listen-assistant') {
    visibleAssistants.add(port);
    const publishProgress = () => {
      try {
        const progress = transcription.liveProgress();
        port.postMessage({
          type: 'PIPELINE_PROGRESS',
          progress: {
            ...progress,
            llm:
              assistant.snapshot.sessionId === progress.sessionId
                ? assistant.liveProgress()
                : { state: 'idle', elapsedMs: 0, queued: false, paused: false },
          },
        });
      } catch {
        clearInterval(timer);
      }
    };
    const timer = setInterval(publishProgress, 250);
    publishProgress();
    port.onDisconnect.addListener(() => {
      visibleAssistants.delete(port);
      clearInterval(timer);
    });
    return;
  }
  if (port.name !== 'listen-levels') return;
  visiblePopups.add(port);
  const timer = setInterval(() => {
    try {
      port.postMessage({ type: 'LEVELS', ...engine.levels() });
    } catch {
      clearInterval(timer);
    }
  }, 150);
  port.onDisconnect.addListener(() => {
    visiblePopups.delete(port);
    clearInterval(timer);
  });
});
