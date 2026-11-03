import type { EndMeetingJob, ExportFile } from './types';
import { unsavedEndJobs } from './presentation';

export interface EndViewActions {
  save(): void;
  retryMom(): void;
  retrySave(): void;
  start(): void;
  discard(sessionId: string): void;
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
      : job.checkpoint?.correcting
        ? 'Mimo is checking the transcript references and preparing the meeting notes again.'
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
  private discardConfirmation: HTMLElement;
  private discardMeeting: HTMLElement;
  private keepMeeting: HTMLButtonElement;
  private discardSession?: string;

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
    this.discard = button('Discard unsaved files', () => this.askDiscard());
    this.discard.setAttribute('aria-expanded', 'false');
    this.discardConfirmation = document.createElement('section');
    this.discardConfirmation.className = 'end-discard-confirmation';
    this.discardConfirmation.id = `${root.id}-discard-confirmation`;
    this.discardConfirmation.hidden = true;
    this.discardConfirmation.setAttribute('role', 'group');
    this.discardConfirmation.setAttribute('aria-label', 'Discard meeting confirmation');
    this.discard.setAttribute('aria-controls', this.discardConfirmation.id);
    const discardHeading = document.createElement('h3');
    discardHeading.textContent = 'Discard this meeting?';
    this.discardMeeting = document.createElement('p');
    this.discardMeeting.className = 'end-discard-meeting';
    const consequence = document.createElement('p');
    consequence.textContent = 'Unsaved results and the retained recording will be removed from Mimo. Files already saved to your folder stay there. This cannot be undone.';
    const discardActions = document.createElement('div');
    discardActions.className = 'end-discard-actions';
    this.keepMeeting = document.createElement('button');
    this.keepMeeting.type = 'button';
    this.keepMeeting.className = 'text-button';
    this.keepMeeting.textContent = 'Keep meeting';
    this.keepMeeting.onclick = () => this.cancelDiscard();
    const confirmDiscard = document.createElement('button');
    confirmDiscard.type = 'button';
    confirmDiscard.className = 'text-button end-discard-confirm';
    confirmDiscard.textContent = 'Discard meeting';
    confirmDiscard.onclick = () => {
      const id = this.discardSession;
      if (!id || id !== this.sessionId || this.busy || this.discard.hidden) return;
      this.cancelDiscard();
      actions.discard(id);
    };
    this.discardConfirmation.onkeydown = (event) => {
      if (event.key === 'Escape' && !this.busy) {
        event.preventDefault();
        event.stopPropagation();
        this.cancelDiscard();
      }
    };
    discardActions.append(this.keepMeeting, confirmDiscard);
    this.discardConfirmation.append(discardHeading, this.discardMeeting, consequence, discardActions);
    exportSection.append(this.exportStatus, this.fileList, buttons, this.discardConfirmation);
    this.others = document.createElement('details');
    this.others.className = 'end-other';
    this.others.hidden = true;
    this.others.append(document.createElement('summary'));
    const otherDescription = document.createElement('p');
    otherDescription.className = 'end-other-description';
    otherDescription.textContent = 'Previous sessions still kept on this device. Open one to view its notes and save status.';
    this.others.append(otherDescription);
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
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('.end-actions button, .end-discard-confirmation button'))
      button.disabled = value;
  }

  private askDiscard(): void {
    if (this.busy || !this.sessionId || this.discard.hidden) return;
    this.discardSession = this.sessionId;
    this.discardConfirmation.hidden = false;
    this.discard.setAttribute('aria-expanded', 'true');
    this.keepMeeting.parentElement!.scrollIntoView({ block: 'nearest' });
    this.keepMeeting.focus({ preventScroll: true });
  }

  cancelDiscard(restoreFocus = true): void {
    const wasOpen = !this.discardConfirmation.hidden;
    const ownedFocus = this.discardConfirmation.contains(document.activeElement);
    this.discardSession = undefined;
    this.discardConfirmation.hidden = true;
    this.discard.setAttribute('aria-expanded', 'false');
    if (wasOpen && restoreFocus && ownedFocus && !this.busy) {
      if (!this.discard.hidden && this.discard.getClientRects().length)
        this.discard.focus({ preventScroll: true });
      else if (this.root.getClientRects().length)
        this.root.focus({ preventScroll: true });
    }
  }

  render(job: EndMeetingJob): void {
    if (this.sessionId !== job.sessionId) {
      this.cancelDiscard(false);
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
    if (saved === 3) this.cancelDiscard();
    const meetingLabel = `${job.sourceTitle} — ${new Date(job.createdAt).toLocaleString()}`;
    if (this.discardMeeting.textContent !== meetingLabel) this.discardMeeting.textContent = meetingLabel;
    this.start.hidden = job.phase === 'waiting_transcript' && !job.transcript?.incomplete && job.transcript?.phase !== 'failed';
    this.setBusy(this.busy);
    this.setPending(this.pendingJobs, this.pendingDisabled);
  }
}
