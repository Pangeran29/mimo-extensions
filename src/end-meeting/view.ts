import type { EndMeetingJob, ExportFile } from './types';
import { unsavedEndJobs } from './presentation';

export interface EndViewActions {
  sources(ids: number[], trigger: HTMLElement): void;
  save(): void;
  retryMom(): void;
  retrySave(): void;
  start(): void;
  discard(): void;
  select(sessionId: string): void;
}

function phaseText(job: EndMeetingJob): string {
  if (job.phase === 'waiting_transcript')
    return job.transcript?.incomplete || job.transcript?.phase === 'failed'
      ? 'The last speech still needs transcription. Your audio is retained.'
      : 'Finishing the last speech before writing your meeting notes.';
  if (job.phase === 'generating')
    return job.retryAt && job.retryAt > Date.now()
      ? 'The AI service needs a moment. Your meeting notes will retry automatically.'
      : job.checkpoint?.repairing
        ? 'Mimo is correcting the meeting notes against the transcript, then checking them again.'
      : 'Mimo is finding the important points from the whole conversation.';
  if (job.phase === 'failed') return job.error ?? 'Meeting notes could not be completed. Your audio and transcript are retained.';
  if (job.phase === 'empty') return job.minutes?.emptyReason ?? 'There was not enough conversation to write meeting notes.';
  return 'The important points, from beginning to end.';
}

/** Keeps the reading DOM stable when only save progress changes. Model text is never HTML. */
export class EndMeetingView {
  private renderedMinutes = '';
  private sessionId?: string;
  private status: HTMLElement;
  private list: HTMLUListElement;
  private exportStatus: HTMLElement;
  private fileList: HTMLUListElement;
  private save: HTMLButtonElement;
  private retry: HTMLButtonElement;
  private retrySave: HTMLButtonElement;
  private discard: HTMLButtonElement;
  private start: HTMLButtonElement;
  private busy = false;
  private pendingJobs: EndMeetingJob[] = [];
  private pendingDisabled = false;
  private others: HTMLDetailsElement;
  private othersList: HTMLUListElement;

  constructor(private root: HTMLElement, private actions: EndViewActions) {
    const heading = document.createElement('h2');
    heading.textContent = 'Meeting notes';
    this.status = document.createElement('p');
    this.status.className = 'end-status';
    this.status.setAttribute('role', 'status');
    this.list = document.createElement('ul');
    this.list.className = 'end-bullets';
    this.list.setAttribute('aria-label', 'Minutes of meeting');
    const exportSection = document.createElement('section');
    exportSection.className = 'end-export';
    exportSection.setAttribute('aria-label', 'Save meeting files');
    this.exportStatus = document.createElement('p');
    this.exportStatus.className = 'end-export-status';
    this.exportStatus.setAttribute('role', 'status');
    this.fileList = document.createElement('ul');
    this.fileList.className = 'end-files';
    const buttons = document.createElement('div');
    buttons.className = 'end-actions';
    const button = (label: string, callback: () => void) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'text-button';
      el.textContent = label;
      el.onclick = callback;
      buttons.append(el);
      return el;
    };
    this.save = button('Choose folder', () => actions.save());
    this.retry = button('Retry meeting notes', () => actions.retryMom());
    this.retrySave = button('Retry saving', () => actions.retrySave());
    this.start = button('New meeting', () => actions.start());
    this.discard = button('Discard unsaved files', () => actions.discard());
    exportSection.append(this.exportStatus, this.fileList, buttons);
    this.others = document.createElement('details');
    this.others.className = 'end-other';
    this.others.hidden = true;
    this.others.append(document.createElement('summary'));
    this.othersList = document.createElement('ul');
    this.others.append(this.othersList);
    root.append(heading, this.status, this.list, exportSection, this.others);
  }

  setPending(jobs: EndMeetingJob[], disabled: boolean): void {
    this.pendingJobs = jobs;
    this.pendingDisabled = disabled;
    const pending = unsavedEndJobs(jobs, this.sessionId);
    const signature = JSON.stringify(pending.map((job) => [job.sessionId, job.sourceTitle, job.createdAt])) + disabled;
    this.others.hidden = !pending.length;
    if (this.othersList.dataset.signature === signature) return;
    this.othersList.dataset.signature = signature;
    this.others.querySelector('summary')!.textContent = `Other unsaved meetings (${pending.length})`;
    this.othersList.replaceChildren();
    for (const job of pending) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'text-button';
      button.disabled = disabled;
      button.textContent = `${job.sourceTitle} — ${new Date(job.createdAt).toLocaleString()}`;
      button.onclick = () => this.actions.select(job.sessionId);
      li.append(button);
      this.othersList.append(li);
    }
  }

  setBusy(value: boolean): void {
    this.busy = value;
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('.end-actions button'))
      button.disabled = value;
  }

  render(job: EndMeetingJob): void {
    if (this.sessionId !== job.sessionId) {
      this.sessionId = job.sessionId;
      this.renderedMinutes = '';
      this.root.scrollTop = 0;
    }
    this.root.dataset.phase = job.phase;
    const status = phaseText(job);
    if (this.status.textContent !== status) this.status.textContent = status;
    const signature = JSON.stringify(job.minutes ?? null);
    if (signature !== this.renderedMinutes) {
      this.renderedMinutes = signature;
      this.list.replaceChildren();
      for (const bullet of job.minutes?.bullets ?? []) {
        const li = document.createElement('li');
        const text = document.createElement('p');
        text.textContent = bullet.text;
        li.append(text);
        if (bullet.sources.length && job.transcript) {
          const sources = document.createElement('button');
          sources.type = 'button';
          sources.className = 'text-button end-sources';
          sources.textContent = 'Sources';
          sources.setAttribute('aria-label', `Sources for ${bullet.text}`);
          sources.onclick = () => this.actions.sources(bullet.sources, sources);
          li.append(sources);
        }
        this.list.append(li);
      }
    }
    this.list.hidden = !job.minutes?.bullets.length;
    const saved = Object.values(job.files).filter((file) => file.phase === 'saved').length;
    const writeFailed = Object.values(job.files).some((file) => file.phase === 'failed');
    const exportText = saved === 3
      ? `All three files saved in ${job.directoryName ? job.directoryName + ' / ' : ''}${job.folderName}.${job.cleanupError ? ' Temporary local audio still needs cleanup. Retry saving to clear it.' : ''}`
      : job.destination === 'missing'
        ? 'Choose a folder whenever you’re ready. Your results stay here.'
        : job.destination === 'permission_required'
          ? 'Folder access needs to be granted again. Choose a folder to continue saving.'
          : writeFailed
            ? `${saved} of 3 files saved. The remaining files need a retry; your results are retained.`
            : job.phase === 'failed'
              ? `${saved} of 3 files saved. Meeting notes need a retry; your audio and transcript are retained.`
            : `Saving to ${job.directoryName ? job.directoryName + ' / ' : ''}${job.folderName}. ${saved} of 3 files saved.`;
    if (this.exportStatus.textContent !== exportText) this.exportStatus.textContent = exportText;
    const fileSignature = JSON.stringify([job.files, job.phase]);
    if (this.fileList.dataset.signature !== fileSignature) {
      this.fileList.dataset.signature = fileSignature;
      this.fileList.replaceChildren();
      for (const [type, label] of [['audio', 'Audio'], ['transcript', 'Transcript'], ['mom', 'Meeting notes']] as [ExportFile, string][]) {
        const file = job.files[type];
        const row = document.createElement('li');
        row.dataset.state = file.phase;
        row.textContent = `${label}: ${file.phase === 'saved' ? 'saved' : file.phase === 'writing' ? 'saving…' : file.phase === 'failed' ? (file.error ?? 'needs retry') : type === 'mom' && job.phase === 'failed' ? 'needs retry' : type === 'mom' && job.phase === 'generating' ? 'preparing…' : 'waiting'}`;
        this.fileList.append(row);
      }
    }
    this.save.hidden = saved === 3 || job.destination === 'selected';
    this.retry.hidden = job.phase !== 'failed' || !!job.retryAt && job.retryAt > Date.now();
    this.retrySave.hidden = !job.cleanupError && (job.destination !== 'selected' || !Object.values(job.files).some((f) => f.phase === 'failed'));
    this.discard.hidden = saved === 3;
    this.start.hidden = job.phase === 'waiting_transcript' && !job.transcript?.incomplete && job.transcript?.phase !== 'failed';
    this.setBusy(this.busy);
    this.setPending(this.pendingJobs, this.pendingDisabled);
  }
}
