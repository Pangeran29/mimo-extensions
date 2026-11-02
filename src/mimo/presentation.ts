export type MimoPresentationMode = 'understanding' | 'contribution';
export type MimoNavigationView = 'summary' | 'transcript' | 'insights' | 'settings';
export interface MimoNavigationOptions {
  source?: boolean;
  backFromSource?: boolean;
}

/** Local reading state. No feedback, recording, inference, or persistence side effects. */
export class MimoPresentation {
  sessionId: string | undefined;
  mode: MimoPresentationMode = 'understanding';
  displayedId: string | undefined;
  latestId: string | undefined;
  pendingId: string | undefined;
  visible = false;
  view: MimoNavigationView = 'summary';
  private epoch = 0;
  private seen = new Set<string>();
  private sourceReturnId: string | undefined;
  private acceptingAutomaticEntry = true;

  reset(sessionId: string | undefined): boolean {
    if (sessionId === this.sessionId) return false;
    this.sessionId = sessionId;
    this.mode = 'understanding';
    this.displayedId = this.latestId = this.pendingId = this.sourceReturnId = undefined;
    this.seen.clear();
    this.acceptingAutomaticEntry = true;
    this.epoch++;
    return true;
  }

  setVisible(visible: boolean): void {
    if (this.visible && !visible) this.epoch++;
    this.visible = visible;
  }

  receive(id: string | undefined, newlyAccepted: boolean) {
    const changed = this.latestId !== id;
    const firstSeen = !!id && !this.seen.has(id);
    this.latestId = id;
    if (id) this.seen.add(id);
    if (!id) {
      const closed = this.mode === 'contribution';
      this.close();
      this.pendingId = this.sourceReturnId = undefined;
      return { changed, presented: false, queued: false, closed };
    }
    if (!changed || !newlyAccepted || !firstSeen || !this.acceptingAutomaticEntry)
      return { changed, presented: false, queued: false, closed: false };
    if (this.visible && this.view === 'summary' && this.mode === 'understanding') {
      this.show(id);
      return { changed, presented: true, queued: false, closed: false };
    }
    this.pendingId = id;
    return { changed, presented: false, queued: true, closed: false };
  }

  openLatest(): boolean {
    if (!this.latestId || !this.visible || this.view !== 'summary') return false;
    this.show(this.latestId);
    return true;
  }

  close(): boolean {
    const changed = this.mode === 'contribution' || !!this.displayedId;
    if (this.displayedId === this.pendingId) this.pendingId = undefined;
    this.mode = 'understanding';
    this.displayedId = this.sourceReturnId = undefined;
    if (changed) this.epoch++;
    return changed;
  }

  stop(): void {
    this.acceptingAutomaticEntry = false;
    this.close();
    this.pendingId = this.sourceReturnId = undefined;
    this.epoch++;
  }

  navigation(view: MimoNavigationView, options: MimoNavigationOptions = {}): void {
    this.epoch++;
    if (view === 'transcript' && options.source) {
      this.sourceReturnId = this.mode === 'contribution' ? this.displayedId : undefined;
      this.view = view;
      return;
    }
    if (view === 'summary' && options.backFromSource && this.sourceReturnId) {
      const id = this.sourceReturnId;
      this.sourceReturnId = undefined;
      this.view = view;
      this.show(id);
      return;
    }
    this.view = view;
    this.close();
    this.sourceReturnId = undefined;
  }

  beginFeedback(sessionId: string, id: string): number | undefined {
    return this.matches(sessionId, id) ? this.epoch : undefined;
  }

  canCompleteFeedback(sessionId: string, id: string, token?: number): boolean {
    return typeof token === 'number' && this.matches(sessionId, id) && token === this.epoch;
  }

  private matches(sessionId: string, id: string): boolean {
    return (
      this.sessionId === sessionId &&
      this.visible &&
      this.view === 'summary' &&
      this.mode === 'contribution' &&
      this.displayedId === id
    );
  }

  private show(id: string): void {
    this.mode = 'contribution';
    this.displayedId = id;
    if (this.pendingId === id) this.pendingId = undefined;
    this.epoch++;
  }
}
