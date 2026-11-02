import { appendDiagnostic } from './diagnostic-store';
import { REPLAY_LAB } from './replay/config';
import { appendEvent, listRuns, updateRun } from './replay/store';
import type { ReplayStatus } from './replay/types';
import { exportAgentReport, trackAgentReportDownload } from './agent-report-export';
chrome.downloads.onChanged.addListener((delta) => {
  void trackAgentReportDownload(delta).catch(() => {});
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (
    sender.id !== chrome.runtime.id ||
    message.target !== 'worker' ||
    message.type !== 'AGENT_REPORT_EXPORT'
  )
    return;
  if (message.sessionId !== undefined && typeof message.sessionId !== 'string') return;
  void exportAgentReport(message.sessionId, message.automatic === true)
    .then((downloadId) => respond({ ok: true, value: { downloadId } }))
    .catch(() =>
      respond({
        ok: false,
        error: 'Report download failed. The local report is retained; retry from Privacy & help.',
      }),
    );
  return true;
});
import {
  trace,
  diagnosticsReady,
  diagnosticConfig,
  configureDiagnostics,
  DIAGNOSTIC_CONFIG_KEY,
  setDiagnosticSink,
} from './diagnostics';
setDiagnosticSink((event) => {
  void appendDiagnostic(event).catch(() => {});
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message.type !== 'DIAGNOSTIC_EVENT') return;
  void appendDiagnostic(message.event)
    .then(async () => {
      if (!REPLAY_LAB || typeof message.event?.sessionId !== 'string') return;
      const run = (await listRuns()).find((r) => r.sessionId === message.event.sessionId);
      if (run)
        await appendEvent(run.id, 'pipeline-diagnostic', message.event, run.sourceMs);
    })
    .then(() => respond({ ok: true }))
    .catch(() => respond({ ok: false }));
  return true;
});
import { panelViewKey, setupWarningKey } from './panel';
import { isDownloadCancelled } from './download';
import { assistantControl, assistantReadiness, initializeAssistant, initializeEndConnection } from './assistant/settings';
import type { AssistantAction } from './assistant/types';
import { loadTranscript, recoveredTranscript, pendingWindows } from './transcription/store';
import type { TranscriptSnapshot } from './transcription/types';
import * as db from './db';
import { getJob, listJobs } from './end-meeting/store';
import type { EndAction, EndMeetingJob } from './end-meeting/types';
import {
  errorText,
  type RecorderMessage,
  type RecorderEvent,
  type Reply,
  type Status,
  type UIMessage,
} from './types';
let creating: Promise<void> | undefined;
let restoringTranscription: Promise<void> | undefined;
let restoringRecoveryAI: Promise<void> | undefined;
let controls: Promise<unknown> = Promise.resolve();
let captureStartRequests = 0;
const exports = new Map<string, Promise<void>>();
const finishing = new Map<number, Promise<void>>();
async function hasRecorder(): Promise<boolean> {
  return (
    (
      await chrome.runtime.getContexts({
        contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      })
    ).length > 0
  );
}
async function ensureRecorder(): Promise<void> {
  if (creating) return creating;
  if (await hasRecorder()) return;
  if (!creating)
    creating = chrome.offscreen
      .createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.BLOBS],
        justification: 'Record tab and microphone audio locally and export a recording file.',
      })
      .then(async () => {
        restoringTranscription = undefined;
        restoringRecoveryAI = undefined;
        // Chrome can expose the offscreen context before its bundled module has
        // installed the receiver. Probe read-only state before dispatching controls.
        for (let attempt = 0; attempt < 75; attempt++) {
          try {
            const response = await chrome.runtime.sendMessage({ target: 'recorder', type: 'STATUS' });
            if (response?.ok) return;
          } catch { /* The document is still loading. */ }
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        throw new Error('The recorder could not finish loading. Reopen Mimo and try again.');
      })
      .finally(() => {
        creating = undefined;
      });
  await creating;
}
async function recorder<T = Status>(message: RecorderMessage): Promise<T> {
  await diagnosticsReady;
  // Read-only polls can arrive while a different request is still loading the
  // offscreen module. They must join that startup instead of racing its receiver.
  if (creating) await creating;
  const reply: Reply<T> = await chrome.runtime.sendMessage({
    ...message,
    diagnostics: diagnosticConfig(),
  });
  if (!reply?.ok)
    throw new Error(
      reply?.error ?? 'The recorder is unavailable. Reopen the extension and try again.',
    );
  return reply.value;
}
async function broadcast(status: Status): Promise<void> {
  const label =
    status.phase === 'recording'
      ? 'REC'
      : status.phase === 'saving'
        ? 'SAVE'
        : status.phase === 'save-failed' || status.phase === 'error'
          ? '!'
          : '';
  await chrome.action.setBadgeBackgroundColor({
    color: status.phase === 'recording' ? '#b43545' : '#2457ba',
  });
  await chrome.action.setBadgeText({ text: label });
  await chrome.runtime.sendMessage({ target: 'ui', type: 'STATE', status }).catch(() => {});
}
async function finishDownload(
  downloadId: number,
  success: boolean,
  error?: string,
  cancelled = false,
): Promise<void> {
  if (finishing.has(downloadId)) return finishing.get(downloadId);
  const task = (async () => {
    const session = (await db.sessions()).find((row) => row.downloadId === downloadId);
    if (!session) return;
    if (await hasRecorder()) {
      await recorder({
        target: 'recorder',
        type: 'DOWNLOAD_DONE',
        id: session.id,
        success,
        cancelled,
        error,
      });
      const live = await recorder({ target: 'recorder', type: 'STATUS' });
      if (
        live.phase === 'idle' &&
        !live.retained.length &&
        !live.transcriptionBusy &&
        !live.assistantBusy
        && !live.endMeetingBusy
        && !captureStartRequests
      )
        await chrome.offscreen.closeDocument();
    } else if (cancelled) {
      await db.deleteSession(session.id);
    } else if (success) {
      await db.completeDownload(session.id);
    } else {
      await db.updateSession(session.id, {
        downloadId: undefined,
        error: error ?? 'Download interrupted. Retry Save to download again.',
      });
    }
  })().finally(() => {
    finishing.delete(downloadId);
  });
  finishing.set(downloadId, task);
  return task;
}
async function reconcileDownloads(): Promise<void> {
  for (const session of await db.sessions()) {
    if (session.downloadId === undefined) continue;
    const [item] = await chrome.downloads.search({ id: session.downloadId });
    if (item?.state === 'in_progress') continue;
    await finishDownload(
      session.downloadId,
      item?.state === 'complete',
      'The previous download did not finish. Retry Save or discard the audio.',
      isDownloadCancelled(item?.error),
    );
  }
}
async function status(): Promise<Status> {
  await reconcileDownloads();
  if (await hasRecorder()) return recorder({ target: 'recorder', type: 'STATUS' });
  const rows = await db.sessions();
  const endMeeting = (await listJobs().catch(() => []))[0];
  const active = rows.find((row) => row.downloadId !== undefined);
  if (active)
    return {
      phase: 'saving',
      session: active,
      retained: rows.filter((row) => row.id !== active.id),
    };
  return {
    phase: 'idle',
    endMeeting,
    retained: rows.map((row) =>
      row.status === 'capturing'
        ? {
            ...row,
            partial: true,
            error: 'Interrupted recording: the last audio may be missing.',
          }
        : row,
    ),
  };
}
async function save(id: string): Promise<void> {
  const existing = exports.get(id);
  if (existing) return existing;
  const task = (async () => {
    const session = await db.getSession(id);
    if (!session) throw new Error('Recording no longer exists.');
    if (session.exportKind) {
      await ensureRecorder();
      await recorder({ target: 'recorder', type: 'END_SAVE', sessionId: id });
      return;
    }
    if (session.downloadId !== undefined) {
      const [item] = await chrome.downloads.search({ id: session.downloadId });
      if (item?.state === 'in_progress') throw new Error('This recording is already downloading.');
      if (item?.state === 'complete') {
        await finishDownload(item.id, true);
        return;
      }
    }
    await ensureRecorder();
    try {
      const file = await recorder<{ url: string; session: typeof session }>({
        target: 'recorder',
        type: 'EXPORT',
        id,
      });
      const downloadId = await chrome.downloads.download({
        url: file.url,
        filename: file.session.filename,
        conflictAction: 'uniquify',
        saveAs: false,
      });
      await db.updateSession(id, { downloadId });
      // A tiny download may complete before its ID was persisted or the listener ran.
      const [item] = await chrome.downloads.search({ id: downloadId });
      if (item && item.state !== 'in_progress')
        await finishDownload(
          downloadId,
          item.state === 'complete',
          'Download interrupted. Retry Save.',
          isDownloadCancelled(item.error),
        );
    } catch (error) {
      const cancelled = isDownloadCancelled(errorText(error));
      // Only change the session that this export actually owns.
      const live = await recorder({ target: 'recorder', type: 'STATUS' });
      if (live.session?.id === id && ['saving', 'save-failed'].includes(live.phase)) {
        await recorder({
          target: 'recorder',
          type: 'DOWNLOAD_DONE',
          id,
          success: false,
          cancelled,
          error: errorText(error),
        });
      }
      if (cancelled) {
        const settled = await recorder({ target: 'recorder', type: 'STATUS' });
        if (
          settled.phase === 'idle' &&
          !settled.retained.length &&
          !settled.transcriptionBusy &&
          !settled.assistantBusy
        )
          await chrome.offscreen.closeDocument();
      } else throw error;
    }
  })().finally(() => {
    exports.delete(id);
  });
  exports.set(id, task);
  return task;
}
async function control(message: UIMessage): Promise<Status> {
  switch (message.type) {
    case 'END_MEETING':
    case 'END_STATUS':
    case 'END_DESTINATION':
    case 'END_RETRY':
    case 'END_SAVE':
    case 'END_DISCARD':
      throw new Error('Use the end-meeting message handler.');
    case 'STATUS':
      return status();
    case 'TRANSCRIPT_STATUS':
    case 'PREPARE_TRANSCRIPTION':
      throw new Error('Use the transcription message handler.');
    case 'REPLAY_STATUS':
    case 'REPLAY_START':
    case 'REPLAY_STOP':
    case 'REPLAY_UI_EVENT':
      throw new Error('Use the replay message handler.');
    case 'START': {
      const current = await status();
      if (['starting', 'recording', 'stopping', 'saving'].includes(current.phase))
        throw new Error('A recording or download is already active.');
      const tab = await chrome.tabs.get(message.tabId);
      if (!tab.active || !/^https?:\/\//.test(tab.url ?? ''))
        throw new Error(
          'Open a normal website tab and press Listen there. Chrome internal pages cannot be recorded.',
        );
      if (current.transcriptionBusy || current.assistantBusy)
        throw new Error('Wait until the previous session has finished.');
      const warn = async (message: string): Promise<never> => {
        await chrome.storage.session.set({
          [setupWarningKey(tab.windowId)]: message,
          [panelViewKey(tab.windowId)]: 'settings',
        });
        throw new Error(message);
      };
      const preferences = await chrome.storage.local.get([
        'microphoneReady',
        'transcriptionEnabled',
        'listenAgentDiagnosticsEnabled',
      ]);
      const issues = await assistantReadiness();
      if (!preferences.microphoneReady) issues.unshift('Allow microphone access');

      if (issues.length) return warn(`Before listening: ${issues.join('; ')}.`);
      await diagnosticsReady;
      trace('startup.accepted');
      await ensureRecorder();
      try {
        await recorder({ target: 'recorder', type: 'CHECK_MICROPHONE' });
      } catch {
        await chrome.storage.local.set({ microphoneReady: false });
        return warn('Microphone unavailable. Check access and the device in Settings.');
      }
      // Prepare the packaged speech detector; cloud availability never blocks capture.
      try {
        const transcript = await recorder<TranscriptSnapshot>({
          target: 'recorder',
          type: 'PREPARE_TRANSCRIPTION',
        });
        if (!transcript.modelReady || transcript.phase === 'failed') throw new Error('Not ready');
        trace('model.ready');
      } catch {
        return warn('Speech detection could not start. Retry transcription in Settings.');
      }
      try {
        await initializeAssistant(true);
      } catch {
        return warn('AI could not initialize. Check AI settings and save again.');
      }
      await chrome.storage.session.remove(setupWarningKey(tab.windowId));
      const streamId = await new Promise<string>((resolve, reject) => {
        chrome.tabCapture.getMediaStreamId({ targetTabId: message.tabId }, (id) => {
          const error = chrome.runtime.lastError;
          if (error || !id)
            reject(new Error(error?.message ?? 'Chrome did not grant tab audio access.'));
          else resolve(id);
        });
      });
      try {
        return await recorder({
          target: 'recorder',
          type: 'START',
          streamId,
          tabId: tab.id!,
          title: tab.title ?? message.title,
          agentDiagnostics: preferences.listenAgentDiagnosticsEnabled === true,
        });
      } catch (error) {
        return warn(`Session could not start. ${errorText(error)}`);
      }
    }
    case 'STOP':
      if (await hasRecorder()) return recorder({ target: 'recorder', type: 'STOP' });
      return status();
    case 'RETRY':
      await save(message.id);
      return status();
    case 'DISCARD': {
      const row = await db.getSession(message.id);
      if (row?.downloadId !== undefined) {
        const [item] = await chrome.downloads.search({ id: row.downloadId });
        if (item?.state === 'in_progress')
          throw new Error('Wait for the download to finish before discarding.');
      }
      if (await hasRecorder())
        await recorder({ target: 'recorder', type: 'DISCARD', id: message.id });
      else await db.deleteSession(message.id);
      return status();
    }
  }
}
chrome.runtime.onMessage.addListener(
  (
    message: UIMessage | RecorderEvent | ({ target: 'worker' } & AssistantAction),
    sender,
    respond,
  ) => {
    if (sender.id !== chrome.runtime.id || message.target !== 'worker') return;
    if (message.type === 'AGENT_REPORT_EXPORT') return;
    if (message.type === 'END_CONNECTION') {
      void initializeEndConnection(message.settings).then(() => respond({ ok: true }))
        .catch(() => respond({ ok: false, error: 'The saved meeting connection could not be restored.' }));
      return true;
    }
    if (message.type === 'END_STATE') {
      void chrome.runtime.sendMessage({ target: 'ui', type: 'END_STATE', job: message.job }).catch(() => {});
      respond({ ok: true });
      return;
    }
    if (['END_MEETING', 'END_STATUS', 'END_DESTINATION', 'END_RETRY', 'END_SAVE', 'END_DISCARD'].includes(message.type)) {
      const action = message as EndAction;
      if (action.sessionId !== undefined && typeof action.sessionId !== 'string') {
        respond({ ok: false, error: 'Invalid meeting session.' });
        return;
      }
      void (async (): Promise<EndMeetingJob | undefined> => {
        if (action.type === 'END_STATUS')
          return action.sessionId ? getJob(action.sessionId) : (await listJobs())[0];
        if (action.type === 'END_MEETING' && !(await hasRecorder())) {
          const saved = action.sessionId ? await getJob(action.sessionId) : (await listJobs())[0];
          const retained = action.sessionId ? await db.getSession(action.sessionId) : undefined;
          if (saved || !retained?.exportKind) return saved;
        }
        await ensureRecorder();
        if (action.type === 'END_RETRY') {
          const job = await getJob(action.sessionId);
          if (job) await initializeEndConnection(job.settings);
        }
        return recorder<EndMeetingJob | undefined>({ ...action, target: 'recorder' });
      })().then((value) => respond({ ok: true, value }))
        .catch((error) => respond({ ok: false, error: errorText(error) }));
      return true;
    }
    if (message.type.startsWith('REPLAY_')) {
      const action = message as import('./replay/types').ReplayAction;
      if (!REPLAY_LAB) {
        respond({ ok: false, error: 'Open Replay Lab in the separate research extension build.' });
        return;
      }
      if (action.type === 'REPLAY_UI_EVENT') {
        if (
          typeof action.sessionId !== 'string' ||
          typeof action.event?.kind !== 'string' ||
          !/^[a-z][a-z0-9_.-]{0,79}$/i.test(action.event.kind) ||
          !action.event.data ||
          typeof action.event.data !== 'object'
        ) {
          respond({ ok: false, error: 'Invalid replay UI event.' });
          return;
        }
        void hasRecorder()
          .then((exists) =>
            exists
              ? recorder<{ accepted: boolean }>({ ...action, target: 'recorder' })
              : { accepted: false },
          )
          .then((value) => respond({ ok: true, value }))
          .catch((error) => respond({ ok: false, error: errorText(error) }));
        return true;
      }
      const replayControl = async (): Promise<ReplayStatus> => {
        if (action.type === 'REPLAY_START') {
          if (typeof action.sourceId !== 'string' || !action.sourceId || action.sourceId.length > 100)
            throw Error('Choose a recording before starting replay.');
          if (action.monitor !== undefined && typeof action.monitor !== 'boolean')
            throw Error('Invalid replay audio setting.');
          const current = await status();
          if (
            ['starting', 'recording', 'stopping', 'saving'].includes(current.phase) ||
            current.transcriptionBusy ||
            current.assistantBusy
          )
            throw Error('Wait until the current recording, transcript and AI work have finished.');
          const issues = await assistantReadiness();
          if (issues.length) throw Error(`Before replay: ${issues.join('; ')}. Open AI settings.`);
          await diagnosticsReady;
          const config = configureDiagnostics({
            enabled: true,
            runId: `replay:${crypto.randomUUID()}`,
            policy: diagnosticConfig().policy,
          });
          await chrome.storage.session.set({ [DIAGNOSTIC_CONFIG_KEY]: config });
          await ensureRecorder();
          const transcript = await recorder<TranscriptSnapshot>({
            target: 'recorder',
            type: 'PREPARE_TRANSCRIPTION',
          });
          if (!transcript.modelReady || transcript.phase === 'failed')
            throw Error('Speech detection could not start. Prepare transcription in Settings.');
          await initializeAssistant(true);
          return recorder<ReplayStatus>({
            target: 'recorder',
            type: 'REPLAY_START',
            sourceId: action.sourceId,
            monitor: action.monitor,
          });
        }
        if (await hasRecorder())
          return recorder<ReplayStatus>({ target: 'recorder', type: action.type });
        const run = (await listRuns())[0];
        if (run && !run.endedAt) {
          run.endedAt = Date.now();
          run.phase = 'error';
          run.partial = true;
          run.stopReason = 'interrupted';
          run.error = 'Replay was interrupted. Start a new run to repeat the recording.';
          await updateRun(run);
        }
        return {
          enabled: true,
          phase: run?.phase ?? 'idle',
          run,
          sourceMs: run?.sourceMs ?? 0,
          durationMs: run?.durationMs,
          transcriptionBusy: false,
          assistantBusy: false,
          error: run?.error,
        };
      };
      // Status reads must stay responsive while a start is acquiring/validating its file.
      if (action.type === 'REPLAY_START') captureStartRequests++;
      const task = (action.type === 'REPLAY_STATUS' ? replayControl() : controls.then(replayControl))
        .finally(() => { if (action.type === 'REPLAY_START') captureStartRequests--; });
      if (action.type !== 'REPLAY_STATUS') controls = task.catch(() => {});
      void task
        .then((value) => respond({ ok: true, value }))
        .catch((error) => respond({ ok: false, error: errorText(error) }));
      return true;
    }
    if (message.type.startsWith('ASSISTANT_') && message.type !== 'ASSISTANT_SETTLED') {
      void assistantControl(message as AssistantAction)
        .then((value) => respond({ ok: true, value }))
        .catch((error) =>
          respond({
            ok: false,
            error: errorText(error),
          }),
        );
      return true;
    }
    if (message.type === 'TRANSCRIPT_STATUS') {
      void (async () => {
        const { transcriptionEnabled } = await chrome.storage.local.get('transcriptionEnabled');
        // Opening the research UI is read-only. Interrupted ASR recovery may
        // contact a provider, so it starts only after an explicit lab action.
        if (!REPLAY_LAB && (transcriptionEnabled || (await pendingWindows()).length))
          await ensureRecorder();
        if (await hasRecorder()) {
          const current = await recorder<TranscriptSnapshot>({
            target: 'recorder',
            type: 'TRANSCRIPT_STATUS',
          });
          if (current.phase === 'recovering') {
            restoringRecoveryAI ??= initializeAssistant().catch(() => {});
            await restoringRecoveryAI;
          }
          if (transcriptionEnabled && !current.modelReady && current.phase === 'unavailable') {
            // Restore once per offscreen lifetime. Preparation verifies the packaged speech detector;
            // a failure remains actionable instead of retrying on every status poll.
            if (!restoringTranscription)
              restoringTranscription = (async () => {
                const live = await recorder({ target: 'recorder', type: 'STATUS' });
                if (
                  ['starting', 'recording', 'stopping', 'saving'].includes(live.phase) ||
                  live.transcriptionBusy ||
                  live.assistantBusy
                )
                  return;
                const restored = await recorder<TranscriptSnapshot>({
                  target: 'recorder',
                  type: 'PREPARE_TRANSCRIPTION',
                });
                if (!restored.modelReady || restored.phase === 'failed')
                  throw new Error('Cloud transcription could not be restored.');
              })().catch(() => {
                /* The recorder's failed snapshot provides recovery in Settings. */
              });
            await restoringTranscription;
            return recorder<TranscriptSnapshot>({ target: 'recorder', type: 'TRANSCRIPT_STATUS' });
          }
          return current;
        }
        const stored = await loadTranscript();
        return stored
          ? recoveredTranscript(stored)
          : ({
              phase: 'unavailable',
              segments: [],
              incomplete: false,
              lagMs: 0,
              modelReady: false,
              message: 'Cloud transcription starts when you listen.',
            } satisfies TranscriptSnapshot);
      })()
        .then((value) => respond({ ok: true, value }))
        .catch((error) => respond({ ok: false, error: errorText(error) }));
      return true;
    }
    if (message.type === 'PREPARE_TRANSCRIPTION') {
      // Separate from recording controls: prepare only the packaged speech detector.
      void (async () => {
        const live = await status();
        if (['starting', 'recording', 'stopping', 'saving'].includes(live.phase))
          throw new Error('Stop recording before preparing transcription.');
        await ensureRecorder();
        const value = await recorder<TranscriptSnapshot>({
          target: 'recorder',
          type: 'PREPARE_TRANSCRIPTION',
        });
        await chrome.storage.local.set({ transcriptionEnabled: true });
        return value;
      })()
        .then((value) => respond({ ok: true, value }))
        .catch((error) => respond({ ok: false, error: errorText(error) }));
      return true;
    }
    if (message.type === 'TRANSCRIPTION_SETTLED' || message.type === 'ASSISTANT_SETTLED' || message.type === 'END_SETTLED') {
      void (async () => {
        if (!(await hasRecorder())) return;
        const live = await recorder({ target: 'recorder', type: 'STATUS' });
        if (
          live.phase === 'idle' &&
          !live.replay &&
          !live.retained.length &&
          !live.transcriptionBusy &&
          !live.assistantBusy
          && !live.endMeetingBusy
          && !captureStartRequests
        )
          await chrome.offscreen.closeDocument();
        await broadcast(await status());
      })().catch(() => {});
      respond({ ok: true });
      return;
    }

    if (message.type === 'STATE') {
      void broadcast(message.status).catch(() => {});
      respond({ ok: true });
      return;
    }
    if (message.type === 'READY') {
      // A completed file may request the next output before the previous save call returns.
      void (exports.get(message.id) ?? Promise.resolve())
        .catch(() => {})
        .then(() => save(message.id))
        .then(() => status())
        .then(broadcast)
        .catch(async (error) => {
          console.error('Save failed:', errorText(error));
          await broadcast(await status());
        });
      respond({ ok: true });
      return;
    }
    // Serialize controls so fast clicks cannot create duplicate streams or discard during start.
    if (message.type === 'START') captureStartRequests++;
    const task = controls.then(() => control(message as UIMessage))
      .finally(() => { if (message.type === 'START') captureStartRequests--; });
    controls = task.catch(() => {});
    void task
      .then(async (value) => {
        respond({ ok: true, value } satisfies Reply);
        await broadcast(value);
      })
      .catch((error) => {
        if (message.type === 'START')
          void chrome.runtime
            .sendMessage({ target: 'ui', type: 'RECORDING_START_FAILED', error: errorText(error) })
            .catch(() => {});
        respond({ ok: false, error: errorText(error) } satisfies Reply);
      });
    return true;
  },
);
chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state?.current !== 'complete' && delta.state?.current !== 'interrupted') return;
  void (async () => {
    // Some Chrome versions deliver error separately from the state delta.
    const [item] = await chrome.downloads.search({ id: delta.id });
    await finishDownload(
      delta.id,
      delta.state!.current === 'complete',
      'Download interrupted. Retry Save or discard the retained audio.',
      isDownloadCancelled(delta.error?.current ?? item?.error),
    );
  })()
    .then(status)
    .then(broadcast)
    .catch((error) => console.error('Download cleanup failed:', errorText(error)));
});
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason !== chrome.runtime.OnInstalledReason.INSTALL) return;
  void chrome.tabs.create({ url: chrome.runtime.getURL('setup.html') });
});
chrome.runtime.onStartup.addListener(() => {
  if (!REPLAY_LAB) void pendingWindows()
    .then(async (jobs) => {
      if (jobs.length) {
        await ensureRecorder();
        await initializeAssistant();
      }
    })
    .catch(() => {});
  void status()
    .then(broadcast)
    .catch(() => {});
});
