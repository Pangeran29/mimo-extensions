import type { AssistantSnapshot } from '../types';
import type { ContributionV2 } from './types';
import { memoCharacter } from '../memo-character';
import { presentationEvent } from '../../replay/presentation';
type Feedback = NonNullable<ContributionV2['feedback']>;
const element = (tag: string, text = '', className = '') => {
  const e = document.createElement(tag);
  e.textContent = text;
  e.className = className;
  return e;
};
let session: string | undefined,
  visible = 25,
  memoId: string | undefined;
// A history entry and the focused reading card never share a DOM node.
const cards = new Map<string, HTMLElement>();
const pendingFeedback = new Set<string>();
export function renderV2(
  s: AssistantSnapshot,
  feedback: (id: string, v: Feedback) => Promise<void>,
  sources: (ids: number[], e: HTMLElement) => void,
  notify = false,
) {
  const state = s.liveV2!,
    feed = document.getElementById('summary-feed')!,
    panel = document.getElementById('analysis-panel')!;
  const sessionChanged = session !== s.sessionId;
  if (sessionChanged) {
    memoCharacter.reset(s.sessionId);
    session = s.sessionId;
    cards.clear();
    pendingFeedback.clear();
    visible = 25;
    memoId = undefined;
    feed.replaceChildren();
  }
  let memo = feed.querySelector<HTMLElement>('[data-current-memo]');
  if (!memo) {
    memo = element('section', '', 'current-memo');
    memo.dataset.currentMemo = 'true';
    memo.append(element('h2', 'Current understanding'), element('p', '', 'live-body'));
    const footer = element('div', '', 'memo-footer');
    footer.append(element('p', '', 'live-meta'));
    const button = element('button', 'Sources', 'text-button') as HTMLButtonElement;
    button.type = 'button';
    footer.append(button);
    memo.append(footer);
    feed.prepend(memo);
  }
  const anchor = document.activeElement as HTMLElement | null,
    oldTop = anchor?.getBoundingClientRect().top,
    scroll = panel.scrollTop;
  const thoughtScroller = document.querySelector<HTMLElement>('.mimo-thought .memo-bubble-scroll')!;
  const thoughtScroll = thoughtScroller.scrollTop;
  if (memoId !== state.memo?.id || !state.memo) {
    const changed = memoId !== state.memo?.id;
    memo.querySelector('.live-body')!.textContent =
      state.memo?.text ??
      (state.closed
        ? 'This session ended before a current understanding was accepted.'
        : 'Gathering enough context to follow the conversation.');
    memo.dataset.empty = String(!state.memo);
    memo.querySelector('.live-meta')!.textContent = state.memo
      ? `Updated ${new Date(state.memo.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : '';
    const button = memo.querySelector('button')!;
    button.hidden = !state.memo;
    button.dataset.evidenceIds = state.memo?.sources.join(',') ?? '';
    button.onclick = () => sources(state.memo?.sources ?? [], button);
    memoId = state.memo?.id;
    if (changed && state.memo && !state.closed && notify && !sessionChanged)
      memoCharacter.understanding();
  }
  const matchingCards = (id: string) =>
    [...cards.values()].filter((n) => n.dataset.contributionId === id);
  const setPending = (id: string) => {
    for (const node of matchingCards(id))
      for (const button of node.querySelectorAll<HTMLButtonElement>('[data-feedback]')) {
        button.disabled = pendingFeedback.has(id);
        button.setAttribute('aria-busy', String(button.disabled));
      }
  };
  const make = (c: ContributionV2, presentation: 'focus' | 'history') => {
    const key = `${c.id}:${presentation}`;
    let node = cards.get(key);
    if (!node) {
      node = element('article', '', 'live-contribution');
      node.dataset.contributionId = c.id;
      node.dataset.presentation = presentation;
      const heading = element('header', '', 'contribution-heading');
      heading.append(element('h2', c.title ?? 'A thought to consider', 'contribution-title'));
      node.append(heading);
      node.append(
        element('p', c.body, 'live-body'),
        element(
          'p',
          new Date(c.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          'live-meta',
        ),
        element('p', '', 'contribution-status live-meta'),
      );
      const markers = [
        ...new Set(
          [
            c.kind[0].toUpperCase() + c.kind.slice(1).replaceAll('_', ' '),
            c.interpretation ? 'Interpretation' : '',
            c.generalKnowledge ? 'General knowledge' : '',
            c.proposal ? 'Suggestion' : '',
          ].filter(Boolean),
        ),
      ];
      if (markers.length) {
        const tags = element('div', '', 'knowledge-tags');
        markers.forEach((m) => tags.append(element('span', m)));
        node.append(tags);
      }
      const evidence = element('div', '', 'contribution-evidence');
      const source = element('button', 'Sources', 'text-button') as HTMLButtonElement;
      source.type = 'button';
      source.dataset.contributionSource = 'true';
      source.title = c.generalKnowledge
        ? 'Conversation sources provide context; they do not verify general knowledge.'
        : 'View the conversation behind this contribution';
      const statusSource = element('button', 'Status sources', 'text-button') as HTMLButtonElement;
      statusSource.type = 'button';
      statusSource.dataset.statusSource = 'true';
      evidence.append(source, statusSource);
      node.append(evidence);
      const actions = element(
        'div',
        '',
        presentation === 'focus' ? 'contribution-response' : 'live-actions',
      );
      const makeFeedback = (value: Feedback, label: string, className = 'text-button') => {
        const b = element('button', label, className) as HTMLButtonElement;
        b.type = 'button';
        b.dataset.feedback = value;
        if (presentation === 'focus' && value === 'useful') {
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          svg.setAttribute('viewBox', '0 0 20 20');
          svg.setAttribute('aria-hidden', 'true');
          const path = document.createElementNS(svg.namespaceURI, 'path');
          path.setAttribute('d', 'm4 10 4 4 8-8');
          svg.append(path);
          b.prepend(svg);
        }
        b.onclick = async () => {
          if (pendingFeedback.has(c.id)) return;
          const requestSession = s.sessionId!;
          const token = memoCharacter.beginFeedback(requestSession, c.id);
          pendingFeedback.add(c.id);
          setPending(c.id);
          for (const card of matchingCards(c.id))
            card.querySelector<HTMLElement>('.feedback-error')!.hidden = true;
          presentationEvent(
            'ui.feedback_clicked',
            { contributionId: c.id, feedback: value },
            requestSession,
          );
          try {
            await feedback(c.id, value);
            presentationEvent(
              'ui.feedback_saved',
              { contributionId: c.id, feedback: value },
              requestSession,
            );
            memoCharacter.completeFeedback(requestSession, c.id, value, token);
          } catch {
            presentationEvent(
              'ui.feedback_failed',
              { contributionId: c.id, feedback: value },
              requestSession,
            );
            if (session !== requestSession) return;
            memoCharacter.feedbackFailed(requestSession, c.id, token);
            for (const card of matchingCards(c.id)) {
              const notice = card.querySelector<HTMLElement>('.feedback-error')!;
              notice.textContent = 'Feedback could not be saved. Try again.';
              notice.hidden = false;
            }
          } finally {
            if (session === requestSession) {
              pendingFeedback.delete(c.id);
              setPending(c.id);
            }
          }
        };
        return b;
      };
      actions.append(
        makeFeedback(
          'useful',
          'Useful',
          presentation === 'focus' ? 'feedback-primary' : 'text-button',
        ),
      );
      if (presentation === 'focus') {
        const skip = element('button', 'Skip', 'feedback-skip') as HTMLButtonElement;
        skip.type = 'button';
        skip.dataset.skipContribution = 'true';
        skip.onclick = () => memoCharacter.skip();
        const more = element('details', '', 'contribution-more');
        more.append(element('summary', 'More'));
        const secondary = element('div', '', 'contribution-more-actions');
        secondary.append(
          makeFeedback('not-helpful', 'Not helpful'),
          makeFeedback('dismissed', 'Dismiss'),
        );
        more.append(secondary);
        actions.append(skip, more);
      } else
        actions.append(
          makeFeedback('not-helpful', 'Not helpful'),
          makeFeedback('dismissed', 'Dismiss'),
        );
      node.append(actions);
      const notice = element('p', '', 'feedback-error');
      notice.hidden = true;
      notice.setAttribute('role', 'alert');
      node.append(notice);
      cards.set(key, node);
    }
    const labels = {
      relevant: 'Relevant to the current discussion',
      previous_topic: 'From an earlier topic',
      answered: 'Already addressed in the conversation',
      corrected: 'Corrected in the conversation — check status sources',
    };
    node.querySelector('.contribution-status')!.textContent =
      (c.archivedAt ? 'Status when last shown: ' : '') + labels[c.status];
    node.dataset.status = c.status;
    const source = node.querySelector<HTMLButtonElement>('[data-contribution-source]')!;
    source.dataset.evidenceIds = c.sources.join(',');
    source.onclick = () => sources(c.sources, source);
    const statusSource = node.querySelector<HTMLButtonElement>('[data-status-source]')!;
    statusSource.hidden = !c.statusSources.length || c.status === 'relevant';
    statusSource.dataset.evidenceIds = c.statusSources.join(',');
    statusSource.onclick = () => sources(c.statusSources, statusSource);
    for (const b of node.querySelectorAll<HTMLButtonElement>('[data-feedback]')) {
      b.setAttribute('aria-pressed', String(b.dataset.feedback === c.feedback));
      b.hidden = b.dataset.feedback === 'dismissed' && !!c.archivedAt;
    }
    setPending(c.id);
    return node;
  };
  const active = state.contributions.find((c) => c.id === state.activeId);
  // Refresh a pinned, older thought in place when its status/feedback changes.
  const pinned = state.contributions.find((c) => c.id === memoCharacter.displayedId);
  if (pinned && pinned.id !== active?.id) make(pinned, 'focus');
  const next = active ? make(active, 'focus') : null;
  for (const child of [...feed.children]) if (child !== memo) child.remove();
  memoCharacter.setContribution(active?.id, next, notify && !sessionChanged && !state.closed);
  panel.scrollTop = scroll;
  if (anchor?.isConnected && panel.contains(anchor) && oldTop !== undefined && scroll > 0)
    panel.scrollTop += anchor.getBoundingClientRect().top - oldTop;
  if (
    anchor?.isConnected &&
    thoughtScroller.contains(anchor) &&
    oldTop !== undefined &&
    thoughtScroll > 0
  )
    thoughtScroller.scrollTop += anchor.getBoundingClientRect().top - oldTop;
  document.getElementById('summary-empty')!.hidden = true;
  document.getElementById('follow-up')!.hidden = true;
  document.getElementById('live-history')!.hidden = false;
  const history = state.contributions.filter((c) => c.id !== state.activeId).reverse(),
    historyFeed = document.getElementById('live-history-feed')!;
  const nodes = history.slice(0, visible).map((c) => make(c, 'history'));
  if (state.legacyNote) {
    let old = historyFeed.querySelector<HTMLElement>('[data-legacy]');
    if (!old) {
      old = element('details');
      old.dataset.legacy = 'true';
      old.append(
        element('summary', 'Notes from a previous version'),
        element('p', state.legacyNote),
      );
    }
    nodes.push(old);
  }
  const wanted = new Set(nodes);
  for (const child of [...historyFeed.children])
    if (!wanted.has(child as HTMLElement)) child.remove();
  nodes.forEach((node, i) => {
    if (historyFeed.children[i] !== node)
      historyFeed.insertBefore(node, historyFeed.children[i] ?? null);
  });
  if (!nodes.length && !historyFeed.firstChild)
    historyFeed.append(element('p', 'No earlier contributions.', 'empty'));
  const more = document.getElementById('history-more') as HTMLButtonElement;
  more.hidden = history.length <= visible;
  more.onclick = () => {
    visible += 25;
    renderV2(s, feedback, sources);
  };
}
