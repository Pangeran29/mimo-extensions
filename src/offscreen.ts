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
import { appendEvent, getRun, getSource, getSourceBlob, listRuns, readEvents, updateRun } from './replay/store';
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
import * as audioDB from './db';
import { MIME } from './types';
import { DEFAULT_SETTINGS, type AssistantSettings } from './assistant/types';
import { EndMeetingController } from './end-meeting/controller';
import type { EndMeetingJob, EndReason } from './end-meeting/types';
import { ReplayRecorder } from './replay/recorder';
import { loadTranscript } from './transcription/store';
import { endJobSettled, recoveredEndTranscript } from './end-meeting/lifecycle';
import { replayRejection } from './end-meeting/recovery';
let endSettings: AssistantSettings = { ...DEFAULT_SETTINGS };
let endError: string | undefined;
let endObservations = Promise.resolve();
let endObservationCount = 0;
const replayRecorder = new ReplayRecorder();
const endMeeting = new EndMeetingController({
  changed: (job) => {
    void chrome.runtime.sendMessage({ target: 'worker', type: 'END_STATE', job }).catch(() => {});
    if (REPLAY_LAB) {
      replayWrites = replayWrites.then(async () => {
        const run = replayRun?.sessionId === job.sessionId
          ? replayRun : (await listRuns()).find((r) => r.sessionId === job.sessionId);
        if (run) { run.endMeeting = structuredClone(job); await updateRun(run); }
      }).catch(() => {});
    }
  },
  settled: () => {
    void chrome.runtime.sendMessage({ target: 'worker', type: 'END_SETTLED' }).catch(() => {});
    if (replayRun?.phase === 'stopping') void saveReplayFinal();
  },
  loadAudio: (id) => audioDB.audioBlob(id, MIME, 'mixed'),
  releaseAudio: (id) => engine.completeBundle(id),
  event: (sessionId, kind, data) => {
    if (!REPLAY_LAB) return;
    replayWrites = replayWrites.then(async () => {
      const run = replayRun?.sessionId === sessionId
        ? replayRun : (await listRuns()).find((r) => r.sessionId === sessionId);
      if (run) await appendEvent(run.id, `end.${kind}`, data, run.sourceMs);
    }).catch(() => {});
  },
});
const endReady = endMeeting.restore().catch((error) => { endError = errorText(error); });

async function beginEndSession(
  session: { id: string; createdAt: number; sourceTitle: string; durationMs: number; endSettings?: AssistantSettings },
  reason: EndReason,
): Promise<EndMeetingJob> {
  await endReady;
  return endMeeting.begin({
    sessionId: session.id, createdAt: session.createdAt, sourceTitle: session.sourceTitle,
    durationMs: session.durationMs, reason, settings: { ...(session.endSettings ?? endSettings) },
    ...(replayRun?.sessionId === session.id ? { replayRunId: replayRun.id } : {}),
  });
}
async function bundleAudioReady(id: string): Promise<void> {
  const session = await audioDB.getSession(id);
  if (!session?.exportKind) {
    await chrome.runtime.sendMessage({ target: 'worker', type: 'READY', id });
    return;
  }
  await beginEndSession(session, session.partial ? 'source-error' : 'manual');
  await endMeeting.audioReady(id);
  await endMeeting.updateTranscript(await transcription.status());
}
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
    endMeetingBusy: endMeeting.busy,
    error: replayRun?.error,
  };
}
async function saveReplayFinal(): Promise<void> {
  if (!replayRun || replayStopping || replaySettling || replayRun.endedAt || transcription.busy || assistant.busy || agentFinalizing || endMeeting.busy)
    return;
  replaySettling = true;
  const run = replayRun;
  try {
    const end = await endMeeting.get(run.sessionId);
    const endingTranscript = await transcription.status();
    if (!endJobSettled(end, endingTranscript, transcription.busy)) return;
    await settleAgentReport();
    run.agentReport = await readAgentReport(run.sessionId).catch(() => undefined);
    if (run.agentReport?.session.limited || run.agentReport?.session.storageError) run.partial = true;
    if (assistant.snapshot.sessionId === run.sessionId)
      run.finalAssistant = structuredClone(assistant.snapshot);
    const transcript = await transcription.status();
    if (transcript.sessionId === run.sessionId) run.finalTranscript = transcript;
    run.endMeeting = await endMeeting.get(run.sessionId);
    if (
      run.finalTranscript?.incomplete ||
      run.finalTranscript?.phase === 'failed' ||
      run.finalAssistant?.analysisError || run.endMeeting?.phase === 'failed'
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
    // Stop audible playback at the user's boundary, independently of storage,
    // final ASR, or any destination write that may take longer.
    replaySource?.audio.pause();
    run.stopReason = reason;
    run.partial ||= reason !== 'eof';
    run.phase = 'stopping';
    if (replayTimer) clearInterval(replayTimer);
    replayTimer = undefined;
    replayEvent('stop-requested', { reason });
    // The same explicit Stop boundary as live capture: no late memo publication.
    assistant.stopCapture();
    stopAgentDiagnostics(run.sessionId);
    const begun = beginEndSession({
      id: run.sessionId, createdAt: run.startedAt, sourceTitle: run.source.name,
      durationMs: run.sourceMs,
    }, reason === 'eof' ? 'eof' : reason === 'manual' ? 'manual' : reason === 'interrupted' ? 'interrupted' : 'source-error').then(
      (job) => ({ job, error: undefined }),
      (error) => ({ job: undefined, error }),
    );
    const audio = replayRecorder.stop(run.sourceMs, reason !== 'eof').then(
      (session) => ({ session, error: undefined }),
      (error) => ({ session: undefined, error: errorText(error) }),
    );
    await transcription.stopCapture();
    const savedAudio = await audio;
    await replaySource?.release();
    replaySource = undefined;
    const beginning = await begun;
    if (beginning.error) throw beginning.error;
    if (savedAudio.session?.error) {
      run.partial = true;
      run.error = 'Some replay audio could not be recorded. Retained audio may be incomplete.';
    }
    await endMeeting.audioReady(run.sessionId, savedAudio.error);
    const finalTranscript = await transcription.status();
    await endMeeting.updateTranscript(finalTranscript.sessionId === run.sessionId
      ? finalTranscript
      : { ...finalTranscript, sessionId: run.sessionId, segments: [], phase: 'failed', incomplete: true });
    await replayWrites;
    await updateRun(run).catch(() => {});
    await publishReplayStatus();
  } catch (error) {
    if (replayRun) {
      replayRun.partial = true;
      replayRun.error = 'The replay stopped, but its end results need recovery. Retained audio is preserved.';
      replayRun.phase = 'error';
      replayRun.endedAt = Date.now();
      await updateRun(replayRun).catch(() => {});
    }
    endError = errorText(error);
  } finally {
    await replaySource?.release().catch(() => {});
    replaySource = undefined;
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
  await publishReplayStatus();
}
async function startReplay(sourceId: string, monitor = false): Promise<ReplayStatus> {
  if (!REPLAY_LAB) throw Error('Replay Lab is available only in the research build.');
  await recoverReplay();
  if (replayActive() || engine.busy || transcription.busy || assistant.busy || endMeeting.busy)
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
    await replayRecorder.start(replaySource.destination.stream, id, replayRun.startedAt, source.name);
    replaySource.audio.onended = () => {
      if (!replayRun || replayRun.sessionId !== id || replayRun.phase !== 'playing') return;
      replayRun.sourceMs = replaySource?.positionMs ?? replayRun.durationMs ?? 0;
      replayEvent('source-ended', { endMeetingProtocol: 1 });
      // EOF closes live publication immediately. Final ASR and minutes use the
      // same durable end-session pipeline as a real user's Stop.
      void stopReplay('eof').catch((error) => { endError = errorText(error); });
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
    if (!ephemeral && snapshot.sessionId && !['ready', 'loading', 'unavailable'].includes(snapshot.phase)) {
      const observed = structuredClone(snapshot);
      endObservationCount++;
      endObservations = endObservations.catch(() => {}).then(async () => {
        await endReady;
        await endMeeting.updateTranscript(observed);
      }).catch((error) => { endError = errorText(error); }).finally(() => {
        endObservationCount--;
        void chrome.runtime.sendMessage({ target: 'worker', type: 'END_SETTLED' }).catch(() => {});
      });
    }
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
    void bundleAudioReady(id).catch((error) => { endError = errorText(error); });
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
      const current = (await engine.status()).session;
      if (current?.exportKind)
        await beginEndSession(current, current.error ? 'source-error' : 'manual')
          .catch((error) => { endError = errorText(error); });
      await transcription.stopCapture();
      if (!transcription.busy) assistant.finish();
    },
  },
);
async function liveStatus(): Promise<Status> {
  await recoverReplay();
  const normal = await engine.status();
  const endStatus = {
    endMeetingBusy: endMeeting.busy || endObservationCount > 0,
    endMeeting: await endMeeting.get(normal.session?.id ?? replayRun?.sessionId).catch(() => undefined),
    endMeetingError: endError,
  };
  if (replayRun) {
    return {
      ...normal,
      ...endStatus,
      phase:
        replayRun.phase === 'starting'
          ? 'starting'
          : replayRun.phase === 'stopping'
            ? replaySource ? 'stopping' : 'idle'
            : replayActive()
              ? 'recording'
              : 'idle',
      session: {
        id: replayRun.sessionId,
        createdAt: replayRun.startedAt,
        sourceTitle: replayRun.source.name,
        tabId: -1,
        filename: replayRun.source.name,
        status: replayActive() && !!replaySource ? 'capturing' : 'ready',
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
    ...endStatus,
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
        endSettings = { ...message.settings };
        endMeeting.configure(message.settings, message.apiKey ?? '');
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
        await endObservations;
        await engine.start(message.streamId, message.tabId, message.title, endSettings);
        break;
      case 'REPLAY_START':
        return startReplay(message.sourceId, message.monitor);
      case 'REPLAY_STATUS':
        return replayStatus();
      case 'REPLAY_STOP':
        await stopReplay();
        return replayStatus();
      case 'END_MEETING': {
        const current = engine.captureState();
        if (message.sessionId && current.session?.id !== message.sessionId && replayRun?.sessionId !== message.sessionId) {
          const existing = await endMeeting.get(message.sessionId);
          if (existing || current.phase === 'recording' || replayActive()) return existing;
          const retained = await audioDB.getSession(message.sessionId);
          if (!retained?.exportKind) return undefined;
          const settings = retained.endSettings ?? (await chrome.runtime.sendMessage({ target: 'worker', type: 'ASSISTANT_SETTINGS' }))?.value?.settings ?? endSettings;
          await beginEndSession({ ...retained, endSettings: settings }, 'interrupted');
          if (retained.status === 'capturing')
            await audioDB.updateSession(retained.id, { status: 'ready', partial: true, error: 'Recording was interrupted. The last audio may be missing.' });
          await endMeeting.audioReady(retained.id);
          const prepared = await chrome.runtime.sendMessage({ target: 'worker', type: 'END_CONNECTION', settings });
          if (!prepared?.ok) throw new Error('The saved meeting connection could not be restored. Check AI settings and retry.');
          const saved = await loadTranscript();
          if (saved?.sessionId === retained.id)
            await endMeeting.updateTranscript(recoveredEndTranscript(saved, retained.status === 'capturing'));
          return endMeeting.get(retained.id);
        }
        if (replayActive()) {
          await stopReplay();
          return endMeeting.get(replayRun?.sessionId);
        }
        assistant.stopCapture();
        stopAgentDiagnostics(assistantSessionId);
        engine.stop();
        const session = engine.captureState().session;
        if (!session) return endMeeting.get(message.sessionId);
        const job = await beginEndSession(session, 'manual');
        await endMeeting.updateTranscript(await transcription.status());
        return job;
      }
      case 'END_STATUS':
        await endReady;
        return endMeeting.get(message.sessionId);
      case 'END_DESTINATION':
      case 'END_SAVE':
        await endReady;
        await endMeeting.save(message.sessionId);
        return endMeeting.get(message.sessionId);
      case 'END_RETRY':
        await endReady;
        await endMeeting.updateTranscript(await transcription.status());
        const retryJob = await endMeeting.get(message.sessionId);
        const priorRejection = retryJob?.replayRunId
          ? replayRejection(retryJob, await readEvents(retryJob.replayRunId).catch(() => []))
          : undefined;
        await endMeeting.retry(message.sessionId, priorRejection);
        return endMeeting.get(message.sessionId);
      case 'END_CONFIGURE':
        endMeeting.configure(message.settings, message.apiKey ?? '');
        return { configured: true };
      case 'END_DISCARD':
        await endReady;
        await endMeeting.discard(message.sessionId);
        return endMeeting.get(message.sessionId);
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
        const stopped = (await engine.status()).session;
        if (stopped?.exportKind) {
          await beginEndSession(stopped, 'manual');
          await endMeeting.updateTranscript(await transcription.status());
        }
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
