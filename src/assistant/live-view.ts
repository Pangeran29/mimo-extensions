import type { AssistantSnapshot } from './types';
import type { Contribution } from './live-types';
type Feedback = NonNullable<Contribution['feedback']>;
let session: string | undefined,
  visible = 25,
  signature = '';
const cards = new Map<string, HTMLElement>();
const el = (tag: string, text: string, cls?: string) => {
  const node = document.createElement(tag);
  node.textContent = text;
  if (cls) node.className = cls;
  return node;
};
export function renderLiveMemo(
  s: AssistantSnapshot,
  feedback: (id: string, value: Feedback) => Promise<void>,
  sources: (ids: number[], trigger: HTMLElement) => void,
) {
  const live = s.live!;
  if (session !== s.sessionId) {
    session = s.sessionId;
    visible = 25;
    signature = '';
    cards.clear();
  }
  const active = live.contributions.find((c) => c.id === live.activeId);
  const make = (c: Contribution) => {
    let node = cards.get(c.id);
    if (!node) {
      node = el('article', '', 'live-contribution');
      node.dataset.contributionId = c.id;
      if (c.title) node.append(el('h2', c.title));
      node.append(el('p', c.body, 'live-body'));
      node.append(
        el(
          'p',
          `${c.kind} · ${new Date(c.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
          'live-meta',
        ),
      );
      const knowledge = [
        c.interpretation ? 'Interpretation' : '',
        c.generalKnowledge ? 'General knowledge' : '',
        c.proposal ? 'Suggestion' : '',
      ].filter(Boolean);
      if (knowledge.length) node.append(el('p', knowledge.join(' · '), 'live-meta'));
      const actions = el('div', '', 'live-actions');
      const source = el('button', 'Sources') as HTMLButtonElement;
      source.type = 'button';
      source.className = 'text-button';
      source.dataset.evidenceIds = c.sources.join(',');
      source.onclick = () => sources(c.sources, source);
      actions.append(source);
      for (const [value, label] of [
        ['useful', 'Useful'],
        ['not-helpful', 'Not helpful'],
        ['dismissed', 'Dismiss'],
      ] as const) {
        const button = el('button', label) as HTMLButtonElement;
        button.type = 'button';
        button.className = 'text-button';
        button.dataset.feedback = value;
        button.onclick = async () => {
          button.disabled = true;
          try {
            await feedback(c.id, value);
          } finally {
            button.disabled = false;
          }
        };
        actions.append(button);
      }
      node.append(actions);
      cards.set(c.id, node);
    }
    for (const button of node.querySelectorAll<HTMLButtonElement>('[data-feedback]')) {
      button.setAttribute('aria-pressed', String(button.dataset.feedback === c.feedback));
      button.hidden = button.dataset.feedback === 'dismissed' && !!c.archivedAt;
    }
    return node;
  };
  const feed = document.getElementById('summary-feed')!;
  const next = active ? make(active) : undefined;
  if (feed.firstElementChild !== next) {
    // Keep keyboard focus in the same reading region when the old contribution expires.
    const focused = feed.contains(document.activeElement);
    const panel = document.getElementById('analysis-panel')!;
    const scroll = panel.scrollTop;
    feed.replaceChildren(...(next ? [next] : []));
    panel.scrollTop = scroll;
    if (focused) panel.focus({ preventScroll: true });
  }
  const empty = document.getElementById('summary-empty')!;
  empty.hidden = !!active;
  empty.querySelector('h2')!.textContent = live.closed
    ? 'Session saved.'
    : live.decision === 'wait'
      ? 'Listening for context.'
      : 'Listening.';
  empty.querySelector('p')!.textContent = live.closed
    ? 'Your contributions are available in More insights.'
    : 'I’ll contribute when there’s something useful to add.';
  document.getElementById('follow-up')!.hidden = true;
  document.getElementById('live-history')!.hidden = false;
  const history = live.contributions.filter((c) => c.id !== live.activeId).reverse();
  const key = JSON.stringify([
    s.sessionId,
    live.activeId,
    history.map((c) => [c.id, c.feedback]),
    visible,
    live.legacyNote,
  ]);
  if (key !== signature) {
    const historyFeed = document.getElementById('live-history-feed')!;
    const nodes = history.slice(0, visible).map(make);
    if (live.legacyNote) {
      const old = el('details', '');
      old.append(el('summary', 'Notes from a previous version'), el('p', live.legacyNote));
      nodes.push(old);
    }
    const desired = new Set(nodes);
    for (const child of [...historyFeed.children])
      if (!desired.has(child as HTMLElement)) child.remove();
    nodes.forEach((node, i) => {
      if (historyFeed.children[i] !== node)
        historyFeed.insertBefore(node, historyFeed.children[i] ?? null);
    });
    if (!nodes.length) historyFeed.replaceChildren(el('p', 'No earlier contributions.', 'empty'));
    signature = key;
  }
  const more = document.getElementById('history-more') as HTMLButtonElement;
  more.hidden = history.length <= visible;
  more.onclick = () => {
    visible += 25;
    renderLiveMemo(s, feedback, sources);
  };
}
