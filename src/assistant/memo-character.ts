import type { Phase } from '../types';
import { presentationEvent } from '../replay/presentation';
import { MimoMascot, type MimoGesture, type MimoPose } from '../mimo/mascot';
import {
  MimoPresentation,
  type MimoNavigationOptions,
  type MimoNavigationView,
} from '../mimo/presentation';

type Feedback = 'useful' | 'not-helpful' | 'dismissed';
type Activity = 'idle' | 'listening' | 'thinking' | 'reassure';

/** Local presentation and character reactions; app actions remain in the existing callbacks. */
class MemoCharacter {
  private root = document.getElementById('memo-companion')!;
  private button = document.getElementById('memo-character') as HTMLButtonElement;
  private bubble = document.getElementById('memo-bubble')!;
  private content = document.getElementById('memo-bubble-content')!;
  private contributionView = document.getElementById('contribution-view') ?? this.bubble;
  private analysisPanel = document.getElementById('analysis-panel')!;
  private state = new MimoPresentation();
  private mascot = new MimoMascot(this.button, { interactive: true, greetOnClick: false });
  private nodes = new Map<string, HTMLElement>();
  private phase: Phase = 'idle';
  private currentActivity: Activity = 'idle';
  private sequence = 0;
  private settle?: ReturnType<typeof setTimeout>;
  private lastPresentation = '';
  private greetingCount = 0;
  private returnHandler?: () => void;
  private ended = false;
  private endProcessing = false;
  private endFailed = false;
  private endEmpty = false;

  constructor() {
    this.setCompanionVisible(false);
    if (!this.analysisPanel.hasAttribute('tabindex')) this.analysisPanel.tabIndex = -1;
    if (!this.contributionView.hasAttribute('tabindex')) this.contributionView.tabIndex = -1;
    this.button.onclick = () => {
      if (this.ended && this.state.view === 'summary') {
        this.react('greet');
        this.say(this.endCue());
        return;
      }
      if (this.state.view !== 'summary' || !this.state.visible) {
        this.returnHandler?.();
        return;
      }
      if (this.state.mode === 'contribution') this.close(true, 'character');
      else if (this.state.openLatest()) {
        this.reflect('character');
        this.react('insight');
      } else {
        this.react(++this.greetingCount % 3 === 0 ? 'stretch' : 'greet');
        this.say(this.phase === 'recording' ? 'I’m with you.' : 'Hi, I’m Mimo.');
      }
    };
    document.getElementById('memo-bubble-close')!.onclick = () => this.close(true, 'close_button');
    document.addEventListener('keydown', this.onKeydown);
    this.reflect('initial');
  }

  get mode() {
    return this.state.mode;
  }
  get displayedId() {
    return this.state.displayedId;
  }
  get displayedContributionId() {
    return this.state.displayedId;
  }
  get pendingId() {
    return this.state.pendingId;
  }

  isShowingContribution(id: string): boolean {
    return (
      this.state.visible &&
      this.state.view === 'summary' &&
      this.state.mode === 'contribution' &&
      this.state.displayedId === id
    );
  }

  reset(session: string | undefined): void {
    if (!this.state.reset(session)) return;
    this.nodes.clear();
    this.content.replaceChildren();
    clearTimeout(this.settle);
    this.settle = undefined;
    this.greetingCount = 0;
    this.currentActivity = 'idle';
    this.lastPresentation = '';
    this.reflect('session_reset');
  }

  setVisible(visible: boolean): void {
    this.state.setVisible(visible);
    this.reflect('surface_visibility');
  }

  setCompanionVisible(visible: boolean): void {
    this.root.hidden = !visible;
    this.mascot.setVisible(visible);
  }

  setReturnHandler(handler: () => void): void {
    this.returnHandler = handler;
  }

  setContribution(id: string | undefined, node: HTMLElement | null, newlyAccepted: boolean): void {
    if (id && node) this.nodes.set(id, node);
    const result = this.state.receive(id, newlyAccepted);
    if (result.queued)
      presentationEvent(
        'ui.contribution_queued',
        {
          displayedContributionId: this.state.displayedId ?? null,
          pendingContributionId: this.state.pendingId ?? null,
          currentView: this.state.view,
        },
        this.state.sessionId,
      );
    this.reflect(
      result.presented ? 'new_contribution' : result.queued ? 'queued_contribution' : 'state',
    );
    if (result.presented) {
      this.react('insight');
      this.say('A thought for you.');
    }
  }

  understanding(): void {
    // Narrative updates behind a contribution never interrupt reading it.
    if (this.state.visible && this.state.view === 'summary' && this.state.mode !== 'contribution')
      this.react('understanding');
  }

  activity(activity: Activity): void {
    const changed = this.currentActivity !== activity;
    this.currentActivity = activity;
    this.updatePose();
    if (changed && activity === 'reassure' && this.state.visible) this.react('reassure');
  }

  endMeeting(active: boolean, processing = false, failed = false, empty = false): void {
    if (this.ended === active && this.endProcessing === processing && this.endFailed === failed && this.endEmpty === empty) return;
    const finished = this.ended && this.endProcessing && active && !processing && !failed && !empty;
    this.ended = active;
    this.endProcessing = processing;
    this.endFailed = failed;
    this.endEmpty = empty;
    if (active) this.state.stop();
    this.reflect('end_meeting');
    if (finished) this.react('useful');
  }

  recording(phase: Phase): void {
    const previous = this.phase;
    this.phase = phase;
    if (
      (previous === 'recording' && phase !== 'recording') ||
      (previous === 'starting' && phase !== 'starting' && phase !== 'recording')
    ) {
      this.state.stop();
      this.reflect('recording_stopped');
      this.react('stop');
      this.say('Resting here with your notes.');
    } else {
      this.reflect('recording_state');
      if (phase === 'recording' && previous !== 'recording') this.react('listen');
    }
  }

  navigation(view: MimoNavigationView, options: MimoNavigationOptions = {}): void {
    this.state.navigation(view, options);
    this.reflect(
      options.backFromSource ? 'source_return' : options.source ? 'sources' : 'navigation',
    );
    if (options.source) this.react('sources');
    else if (view === 'insights') this.react('history');
  }

  skip(): void {
    this.close(true, 'skip');
  }

  beginFeedback(sessionId: string, id: string): number | undefined {
    return this.state.beginFeedback(sessionId, id);
  }

  completeFeedback(sessionId: string, id: string, feedback: Feedback, token?: number): boolean {
    if (!this.state.canCompleteFeedback(sessionId, id, token)) return false;
    this.close(true, 'feedback_' + feedback, false);
    this.react(feedback === 'useful' ? 'useful' : 'skip');
    this.say(feedback === 'useful' ? 'Glad that helped.' : 'Back to the conversation.');
    presentationEvent(
      'ui.feedback_acknowledged',
      {
        contributionId: id,
        feedback,
        returnedToUnderstanding: true,
      },
      sessionId,
    );
    return true;
  }

  feedbackFailed(sessionId: string, id: string, token?: number): void {
    if (this.state.canCompleteFeedback(sessionId, id, token)) this.react('reassure');
  }

  dispose(): void {
    clearTimeout(this.settle);
    document.removeEventListener('keydown', this.onKeydown);
    this.mascot.dispose();
  }

  private onKeydown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.key !== 'Escape' || this.contributionView.hidden) return;
    const menu = this.contributionView.querySelector<HTMLDetailsElement>('details[open]');
    if (menu && menu.contains(document.activeElement)) {
      event.preventDefault();
      menu.open = false;
      menu.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true });
      return;
    }
    event.preventDefault();
    this.close(true, 'escape');
  };

  private close(explicit: boolean, cause: string, gesture = true): void {
    const hadFocus = this.contributionView.contains(document.activeElement);
    const changed = this.state.close();
    this.reflect(cause);
    if (changed && gesture) {
      this.react('skip');
      this.say('Back to the conversation.');
    }
    if (explicit && hadFocus && this.state.visible)
      this.analysisPanel.focus({ preventScroll: true });
  }

  private react(gesture: MimoGesture): void {
    clearTimeout(this.settle);
    const reaction =
      gesture === 'listen'
        ? 'listening'
        : gesture === 'insight'
          ? 'contribution'
          : gesture === 'stop'
            ? 'stopped'
            : gesture;
    this.root.dataset.reaction = reaction;
    this.root.dataset.reactionId = String(++this.sequence);
    document.body.dataset.memoReaction = reaction;
    this.mascot.react(gesture);
    presentationEvent(
      'ui.character_reaction',
      {
        contributionId: this.state.displayedId ?? this.state.latestId ?? null,
        reaction,
        gesture,
        reactionSequence: this.sequence,
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
        documentHidden: document.hidden,
      },
      this.state.sessionId,
    );
    this.settle = setTimeout(() => {
      this.settle = undefined;
      this.root.dataset.reaction = this.phase === 'recording' ? 'listening' : 'idle';
      this.updatePose();
      this.updateCue();
    }, 1750);
  }

  private say(text: string): void {
    const cue = document.getElementById('mimo-cue');
    if (cue) cue.textContent = text;
  }

  private updateCue(): void {
    this.say(
      this.ended
        ? this.endCue()
        : this.state.view !== 'summary' || !this.state.visible
        ? 'Tap Mimo to return to your reading.'
        : this.state.pendingId
          ? 'A new thought is ready.'
          : this.state.mode === 'contribution'
            ? 'A thought for you.'
            : this.state.latestId
              ? 'Tap Mimo to revisit a thought.'
              : this.phase === 'recording'
                ? 'Here with you.'
                : 'Say hello to Mimo.',
    );
  }

  private endCue(): string {
    if (this.endFailed) return 'Your meeting notes need another try.';
    if (this.endEmpty) return 'There wasn’t enough conversation for meeting notes.';
    return this.endProcessing ? 'Putting your meeting notes together.' : 'Your meeting notes are here.';
  }

  private updatePose(): void {
    const pose: MimoPose =
      this.ended
        ? this.endFailed
          ? 'reassure'
          : this.endProcessing
            ? 'thinking'
            : 'rest'
        : this.phase === 'error' || (this.phase === 'recording' && this.currentActivity === 'reassure')
        ? 'reassure'
        : this.state.mode === 'contribution'
          ? 'insight'
          : this.phase === 'starting' ||
              (this.phase === 'recording' && this.currentActivity === 'thinking')
            ? 'thinking'
            : this.phase === 'recording'
              ? 'listening'
              : this.state.sessionId
                ? 'rest'
                : 'idle';
    this.mascot.setPose(pose);
    this.button.dataset.state = pose;
  }

  private reflect(cause: string): void {
    const wasOpen = !this.contributionView.hidden;
    const display = this.state.displayedId ? this.nodes.get(this.state.displayedId) : undefined;
    const show =
      !this.ended &&
      this.state.visible &&
      this.state.view === 'summary' &&
      this.state.mode === 'contribution' &&
      !!display;
    const previousFocus = document.activeElement;
    const hidingFocusedNarrative = show && this.analysisPanel.contains(previousFocus);
    const hidingFocusedContribution = !show && this.contributionView.contains(previousFocus);
    if (display && this.content.firstElementChild !== display)
      this.content.replaceChildren(display);
    this.analysisPanel.hidden = show;
    this.analysisPanel.inert = show;
    this.contributionView.hidden = !show;
    this.contributionView.inert = !show;
    this.bubble.hidden = !show;
    document.body.dataset.mimoView = show ? 'contribution' : 'understanding';
    this.root.dataset.mode = show ? 'contribution' : 'understanding';
    this.root.dataset.pending = String(!!this.state.pendingId);
    this.button.dataset.hasContribution = String(!this.ended && !!this.state.latestId);
    this.button.dataset.hasPendingContribution = String(!!this.state.pendingId);
    this.button.setAttribute('aria-expanded', String(show));
    this.button.setAttribute(
      'aria-label',
      this.ended
        ? 'Say hello to Mimo'
        : this.state.view !== 'summary' || !this.state.visible
        ? 'Mimo: return to your reading'
        : show
          ? 'Mimo: return to current understanding'
          : this.state.pendingId
            ? 'Mimo: open a new contribution'
            : this.state.latestId
              ? 'Mimo: revisit the additional contribution'
              : 'Say hello to Mimo',
    );
    this.updatePose();
    if (!this.settle) this.updateCue();
    if (hidingFocusedNarrative) this.contributionView.focus({ preventScroll: true });
    else if (hidingFocusedContribution && this.state.visible && this.state.view === 'summary')
      this.analysisPanel.focus({ preventScroll: true });
    const signature = JSON.stringify([
      show,
      this.state.displayedId,
      this.state.pendingId,
      this.state.latestId,
    ]);
    if (signature !== this.lastPresentation) {
      this.lastPresentation = signature;
      presentationEvent(
        'ui.presentation_changed',
        {
          mode: show ? 'contribution' : 'understanding',
          cause,
          displayedContributionId: show ? this.state.displayedId : null,
          pendingContributionId: this.state.pendingId ?? null,
          latestContributionId: this.state.latestId ?? null,
          currentView: this.state.view,
        },
        this.state.sessionId,
      );
    }
    if (wasOpen !== show)
      presentationEvent(
        show ? 'ui.bubble_opened' : 'ui.bubble_closed',
        {
          contributionId: this.state.displayedId ?? this.state.latestId ?? null,
          cause,
          documentVisible: !document.hidden,
          wantsOpen: this.state.mode === 'contribution',
          presentation: 'contribution_focus',
        },
        this.state.sessionId,
      );
  }
}

export const memoCharacter = new MemoCharacter();
