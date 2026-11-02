import { REPLAY_LAB } from './replay/config';
import { putSource, listSources, listRuns, getRun, readEvents } from './replay/store';
import type { ReplaySource, ReplayRun, ReplayStatus } from './replay/types';
import { readAgentReport } from './agent-diagnostics';
import { renderReplayReport, type ReplayEvidence } from './replay/report';
import { replayEventDescriptor } from './replay/describe';
import { assistantSurface, surfaceAtTime, surfaceKey } from './appearance';
import { BUILD_ID } from './build-info';
import { attachMeetingDirectory, chooseMeetingDirectory, endAndChooseFolder } from './end-meeting/ui';
import { duration, errorText, type Reply } from './types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fileInput = $<HTMLInputElement>('audio-file');
const sourceSelect = $<HTMLSelectElement>('source-select');
const runSelect = $<HTMLSelectElement>('run-select');
const eventFilter = $<HTMLSelectElement>('event-filter');
const startButton = $<HTMLButtonElement>('start-replay');
const stopButton = $<HTMLButtonElement>('stop-replay');
const repeatButton = $<HTMLButtonElement>('repeat-replay');
let sources: ReplaySource[] = [];
let runs: ReplayRun[] = [];
let status: ReplayStatus | undefined;
let pending = false;
let updating = false;
let importing = false;
let inspectedRun = '';
let pageLimit = 50;
let inspectGeneration = 0;
let latestEvidence: ReplayEvidence | undefined;
let followRunId: string | undefined;
let displayedStatusError: string | undefined;
let outputDirectory: FileSystemDirectoryHandle | undefined;
let choosingDirectory = false;
const rows = new Map<string, HTMLDetailsElement>();
const labels: Record<string, string> = {
  idle: 'Ready',
  starting: 'Preparing audio',
  playing: 'Playing at 1×',
  draining: 'Audio ended. Finishing the pipeline',
  stopping: 'Stopping replay',
  complete: 'Replay complete',
  error: 'Replay needs attention',
};
function showError(value?: unknown): void {
  $('error').hidden = value === undefined;
  $('error').textContent = value === undefined ? '' : errorText(value);
}
async function send<T>(message: object): Promise<T> {
  const reply: Reply<T> = await chrome.runtime.sendMessage({ target: 'worker', ...message });
  if (!reply?.ok) throw Error(reply?.error ?? 'Replay is unavailable. Reload the research build.');
  return reply.value;
}
function busy(): boolean {
  return (
    pending ||
    importing ||
    (!!status &&
      (['starting', 'playing', 'draining', 'stopping'].includes(status.phase) ||
        status.transcriptionBusy ||
        status.assistantBusy))
  );
}
function selectedSource(): ReplaySource | undefined {
  return sources.find((s) => s.id === sourceSelect.value);
}
function controls(): void {
  const active = busy();
  startButton.disabled = !REPLAY_LAB || active || !selectedSource();
  stopButton.disabled = pending || !status || !['playing', 'draining'].includes(status.phase);
  repeatButton.disabled =
    active || !status?.run || !sources.some((s) => s.id === status!.run!.sourceId);
  fileInput.disabled = active;
  sourceSelect.disabled = active;
  $<HTMLInputElement>('monitor-audio').disabled = active;
  $<HTMLButtonElement>('choose-output-folder').disabled = choosingDirectory || pending || importing;
  $('output-folder').textContent = outputDirectory
    ? `Each replay saves its audio, transcript, and meeting notes in a new session folder inside ${outputDirectory.name}.`
    : 'Optional: choose a folder now to save all three files automatically when playback ends. You can also save afterwards.';
  $('source-info').textContent = importing
    ? 'Checking and saving the recording locally…'
    : selectedSource()
      ? `${selectedSource()!.name} · ${(selectedSource()!.size / 1048576).toFixed(1)} MiB · SHA-256 ${selectedSource()!.sha256}`
      : 'The original file is kept locally for repeat runs.';
}
function renderStatus(): void {
  $('run-status').textContent = labels[status?.phase ?? 'idle'] ?? 'Ready';
  const sourceMs = status?.sourceMs ?? 0;
  const length = status?.durationMs ?? status?.run?.source.durationMs ?? 0;
  $('source-position').textContent = `${duration(sourceMs)} / ${duration(length)}`;
  const progress = $<HTMLProgressElement>('source-progress');
  progress.max = length || 1;
  progress.value = sourceMs;
  if (status?.error) {
    displayedStatusError = status.error;
    showError(status.error);
  } else if (displayedStatusError && $('error').textContent === displayedStatusError) {
    displayedStatusError = undefined;
    showError();
  }
  $('run-detail').textContent =
    status?.phase === 'draining'
      ? 'The file has finished. Mimo is completing the transcript, meeting notes, and selected exports.'
      : status?.phase === 'stopping'
        ? 'Playback has stopped. Mimo is completing the played portion’s transcript and meeting notes.'
        : status?.phase === 'complete'
          ? 'The end-of-meeting process has settled. Check Meeting notes for any save or retry action. Repeat starts a fresh session.'
          : status?.phase === 'playing'
            ? 'Original speed and silence are preserved. Memo only receives audio that has played.'
            : status?.phase === 'error'
              ? (status.error ?? 'Inspect the timeline, resolve the issue, then start a fresh run.')
              : 'Start when you are ready. Opening the lab does not play or send audio.';
  controls();
}
function updateOptions(
  select: HTMLSelectElement,
  options: { value: string; label: string }[],
  fallback: string,
): void {
  const signature = JSON.stringify(options);
  if (select.dataset.options === signature) return;
  const selected = select.value;
  select.replaceChildren(
    ...(options.length ? options : [{ value: '', label: fallback }]).map(
      (o) => new Option(o.label, o.value),
    ),
  );
  if (options.some((o) => o.value === selected)) select.value = selected;
  select.dataset.options = signature;
}
async function refreshSources(): Promise<void> {
  sources = await listSources();
  updateOptions(
    sourceSelect,
    sources.map((s) => ({ value: s.id, label: s.name })),
    'Choose a recording first',
  );
  controls();
}
async function inspect(): Promise<void> {
  const id = runSelect.value;
  const generation = ++inspectGeneration;
  if (id !== inspectedRun) {
    rows.clear();
    $('event-list').replaceChildren();
    pageLimit = 50;
    inspectedRun = id;
  }
  if (!id) return;
  const run = await getRun(id);
  if (!run) return;
  const [events, liveAgentReport] = await Promise.all([
    readEvents(id),
    readAgentReport(run.sessionId).catch(() => undefined),
  ]);
  const agentReport = run.agentReport ?? liveAgentReport;
  if (generation !== inspectGeneration || id !== runSelect.value) return;
  latestEvidence = {
    format: 'memo-replay-lab',
    version: 1,
    exportedAt: new Date().toISOString(),
    run,
    events,
    agentReport,
    limitations: [
      'Audio replay at 1× exercises the real extension audio processing, ASR, memo controller, messaging, and interface. It bypasses physical microphone and tab-capture acquisition.',
      'Live provider responses and latency can vary between runs. This is not a deterministic AI-quality test.',
      'Source position measures playback, not the age of evidence used in a model request. Transcript and context sources are recorded in the AI input.',
      'DOM updates and visibility are observations, not proof of browser paint. Full-content diagnostics may be incomplete if their storage limit is reached.',
      'Stop and natural EOF close live publication, finish the final transcription, and prepare meeting notes through the same end-session pipeline. Manual Stop exports only the played audio. Folder cancellation retains the results for saving later.',
    ],
  };
  const warning = $('report-warning');
  const session = agentReport?.session;
  const limited = session?.limited || session?.storageError || run.partial || run.limited;
  warning.hidden = !limited;
  warning.textContent =
    'This run is partial: diagnostic storage was limited, processing was interrupted, or an error prevented completion. Inspect the report before comparing results.';
  const combined: { key: string; kind: string; at: number; sourceMs?: number; data: unknown }[] = [
    ...events.map((e, i) => ({ ...e, key: `run:${e.sequence ?? i}` })),
    ...(agentReport?.events ?? []).map((e, i) => ({ ...e, key: `agent:${e.sequence ?? i}` })),
  ].sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
  const selected = eventFilter.value;
  const described = combined.map((e) => ({
    ...e,
    descriptor: replayEventDescriptor(e.kind, e.data),
  }));
  const visible = described.filter((e) =>
    selected === 'all' ? e.kind !== 'source-position' : e.descriptor.stage === selected,
  );
  $('event-count').textContent = `${combined.length} events`;
  $('timeline-empty').hidden = !!combined.length;
  const list = $('event-list');
  const rendered = visible.slice(0, pageLimit).map((e) => {
    let row = rows.get(e.key);
    if (!row) {
      row = document.createElement('details');
      const summary = document.createElement('summary');
      const time = document.createElement('time');
      time.textContent =
        e.sourceMs === undefined
          ? `+${duration(Math.max(0, e.at - run.startedAt))}`
          : duration(e.sourceMs);
      time.title =
        e.sourceMs === undefined ? 'Elapsed wall time since run start' : 'Audio playback position';
      const title = document.createElement('span');
      title.className = 'event-title';
      title.textContent = e.descriptor.title;
      const category = document.createElement('span');
      category.className = 'event-stage';
      category.textContent = e.descriptor.stage;
      summary.append(time, title, category);
      const pre = document.createElement('pre');
      pre.textContent = JSON.stringify(
        { ...e, key: undefined, elapsedMs: e.at - run.startedAt },
        null,
        2,
      );
      row.append(summary);
      const description = e.descriptor.description;
      if (description) {
        const paragraph = document.createElement('p');
        paragraph.className = 'event-description';
        paragraph.textContent = description;
        row.append(paragraph);
      }
      const technical = document.createElement('details');
      technical.className = 'technical';
      const technicalSummary = document.createElement('summary');
      technicalSummary.textContent = 'Complete evidence';
      technical.append(technicalSummary, pre);
      row.append(technical);
      rows.set(e.key, row);
    }
    return row;
  });
  // Keep existing elements, expanded details, keyboard focus, and scroll position on every poll.
  for (const child of [...list.children])
    if (!rendered.includes(child as HTMLDetailsElement)) child.remove();
  rendered.forEach((row, i) => {
    if (list.children[i] !== row) list.insertBefore(row, list.children[i] ?? null);
  });
  $('more-events').hidden = visible.length <= pageLimit;
  $<HTMLButtonElement>('export-run').disabled = false;
  $<HTMLButtonElement>('export-json').disabled = false;
}
async function refresh(): Promise<void> {
  if (updating || !REPLAY_LAB) return;
  updating = true;
  try {
    const next = await send<ReplayStatus>({ type: 'REPLAY_STATUS' });
    const newRun = next.run?.id !== status?.run?.id;
    status = next;
    runs = await listRuns();
    updateOptions(
      runSelect,
      runs.map((r) => ({
        value: r.id,
        label: `${new Date(r.startedAt).toLocaleString()} — ${r.source.name} (${r.phase})`,
      })),
      'No runs yet',
    );
    if (followRunId && runs.some((r) => r.id === followRunId)) {
      runSelect.value = followRunId;
      followRunId = undefined;
    } else if (newRun && next.run) runSelect.value = next.run.id;
    renderStatus();
    await inspect();
  } catch (e) {
    showError(e);
  } finally {
    updating = false;
  }
}
async function start(repeat = false): Promise<void> {
  if (busy()) return;
  const sourceId = repeat ? status?.run?.sourceId : sourceSelect.value;
  if (!sourceId) return;
  pending = true;
  controls();
  showError();
  try {
    status = await send<ReplayStatus>({
      type: 'REPLAY_START',
      sourceId,
      monitor: $<HTMLInputElement>('monitor-audio').checked,
    });
    followRunId = status.run?.id;
    if (outputDirectory && status.run?.sessionId)
      await attachMeetingDirectory(status.run.sessionId, outputDirectory);
    sourceSelect.value = sourceId;
    renderStatus();
  } catch (e) {
    showError(e);
  } finally {
    pending = false;
    await refresh();
    controls();
  }
}
fileInput.addEventListener(
  'change',
  () =>
    void (async () => {
      const file = fileInput.files?.[0];
      if (!file || busy()) return;
      importing = true;
      controls();
      showError();
      try {
        const source = await putSource(file);
        await refreshSources();
        sourceSelect.value = source.id;
      } catch (e) {
        showError(e);
      } finally {
        importing = false;
        fileInput.value = '';
        controls();
      }
    })(),
);
sourceSelect.addEventListener('change', controls);
startButton.onclick = () => void start();
repeatButton.onclick = () => void start(true);
$('choose-output-folder').onclick = () => {
  if (choosingDirectory || pending || importing) return;
  const selecting = chooseMeetingDirectory();
  choosingDirectory = true;
  controls();
  void selecting.then(async (directory) => {
    if (!directory) return;
    outputDirectory = directory;
    if (status?.run && ['playing', 'draining', 'stopping'].includes(status.phase))
      await attachMeetingDirectory(status.run.sessionId, directory);
  }).catch(showError).finally(() => {
    choosingDirectory = false;
    controls();
  });
};
stopButton.onclick = () =>
  void (async () => {
    if (pending || !status || !['playing', 'draining'].includes(status.phase)) return;
    pending = true;
    const stopping = endAndChooseFolder(status.run?.sessionId, !outputDirectory);
    controls();
    showError();
    try {
      await stopping;
      status = await send<ReplayStatus>({ type: 'REPLAY_STATUS' });
      renderStatus();
    } catch (e) {
      showError(e);
    } finally {
      pending = false;
      await refresh();
      controls();
    }
  })();
runSelect.onchange = () => void inspect().catch(showError);
eventFilter.onchange = () => {
  pageLimit = 50;
  void inspect().catch(showError);
};
$('more-events').onclick = () => {
  pageLimit += 50;
  void inspect().catch(showError);
};
async function exportEvidence(json: boolean): Promise<void> {
  await inspect();
  if (!latestEvidence) return;
  const data = { ...latestEvidence, exportedAt: new Date().toISOString() };
  const blob = new Blob([json ? JSON.stringify(data, null, 2) : renderReplayReport(data)], {
    type: json ? 'application/json' : 'text/html',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `memo-replay-${runSelect.value}.${json ? 'json' : 'html'}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
$('export-run').onclick = () => void exportEvidence(false).catch(showError);
$('export-json').onclick = () => void exportEvidence(true).catch(showError);
async function appearance(): Promise<void> {
  const stored = await chrome.storage.local.get(surfaceKey);
  document.documentElement.dataset.surface = surfaceAtTime(assistantSurface(stored[surfaceKey]));
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[surfaceKey]) void appearance();
});
$('build-info').textContent = `Research build ${BUILD_ID}`;
if (!REPLAY_LAB) showError('Open Replay Lab from its separate research build.');
else {
  void Promise.all([appearance(), refreshSources(), refresh()]).catch(showError);
  const timer = setInterval(() => {
    if (document.visibilityState === 'visible') void refresh();
  }, 1000);
  const themeTimer = setInterval(() => void appearance(), 60000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void refresh();
      void appearance();
    }
  });
  window.addEventListener('pagehide', () => {
    clearInterval(timer);
    clearInterval(themeTimer);
  });
}
