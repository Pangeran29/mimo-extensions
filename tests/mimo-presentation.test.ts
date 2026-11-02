import { describe, expect, it } from 'vitest';
import { MimoPresentation } from '../src/mimo/presentation';

function live() {
  const presentation = new MimoPresentation();
  presentation.reset('session-a');
  presentation.setVisible(true);
  return presentation;
}

describe('Mimo local contribution reading state', () => {
  it('presents a genuinely new contribution once and leaves closed content available manually', () => {
    const p = live();
    expect(p.receive('idea-a', true).presented).toBe(true);
    expect(p.mode).toBe('contribution');
    p.close();
    expect(p.mode).toBe('understanding');
    expect(p.latestId).toBe('idea-a');
    expect(p.receive('idea-a', true).presented).toBe(false);
    expect(p.openLatest()).toBe(true);
    expect(p.displayedId).toBe('idea-a');
  });

  it('does not automatically present restored state or revive an already seen ID', () => {
    const p = live();
    p.receive('restored', false);
    expect(p.mode).toBe('understanding');
    p.receive('fresh', true);
    p.close();
    expect(p.receive('restored', true).presented).toBe(false);
    expect(p.mode).toBe('understanding');
  });

  it('pins the contribution being read while a newer one becomes pending', () => {
    const p = live();
    p.receive('idea-a', true);
    expect(p.receive('idea-b', true).queued).toBe(true);
    expect(p.displayedId).toBe('idea-a');
    expect(p.pendingId).toBe('idea-b');
    p.close();
    expect(p.mode).toBe('understanding');
    expect(p.pendingId).toBe('idea-b');
    expect(p.openLatest()).toBe(true);
    expect(p.displayedId).toBe('idea-b');
    expect(p.pendingId).toBeUndefined();
  });

  it('queues arrivals outside the live view without opening them on ordinary return', () => {
    const p = live();
    p.navigation('settings');
    p.setVisible(false);
    p.receive('idea-a', true);
    p.navigation('summary');
    p.setVisible(true);
    expect(p.mode).toBe('understanding');
    expect(p.pendingId).toBe('idea-a');
    expect(p.openLatest()).toBe(true);
  });

  it('restores the exact Sources origin even when a newer contribution arrived', () => {
    const p = live();
    p.receive('idea-a', true);
    p.navigation('transcript', { source: true });
    p.setVisible(false);
    p.receive('idea-b', true);
    p.navigation('summary', { backFromSource: true });
    p.setVisible(true);
    expect(p.mode).toBe('contribution');
    expect(p.displayedId).toBe('idea-a');
    expect(p.pendingId).toBe('idea-b');
  });

  it('does not treat unrelated Transcript or History navigation as a Sources return', () => {
    const p = live();
    p.receive('idea-a', true);
    p.navigation('transcript');
    p.navigation('summary', { backFromSource: true });
    expect(p.mode).toBe('understanding');
    p.openLatest();
    p.navigation('insights');
    p.navigation('summary');
    expect(p.mode).toBe('understanding');
  });

  it('rejects a late feedback completion after close and reopening the same ID', () => {
    const p = live();
    p.receive('idea-a', true);
    const token = p.beginFeedback('session-a', 'idea-a');
    expect(token).toBeTypeOf('number');
    p.close();
    p.openLatest();
    expect(p.canCompleteFeedback('session-a', 'idea-a', token)).toBe(false);
    expect(
      p.canCompleteFeedback('session-a', 'idea-a', p.beginFeedback('session-a', 'idea-a')),
    ).toBe(true);
  });

  it('invalidates feedback while Sources is open, including after returning', () => {
    const p = live();
    p.receive('idea-a', true);
    const token = p.beginFeedback('session-a', 'idea-a');
    p.navigation('transcript', { source: true });
    p.setVisible(false);
    expect(p.canCompleteFeedback('session-a', 'idea-a', token)).toBe(false);
    p.navigation('summary', { backFromSource: true });
    p.setVisible(true);
    expect(p.canCompleteFeedback('session-a', 'idea-a', token)).toBe(false);
  });

  it('permits feedback on the pinned contribution without confusing the newer pending ID', () => {
    const p = live();
    p.receive('idea-a', true);
    const token = p.beginFeedback('session-a', 'idea-a');
    p.receive('idea-b', true);
    expect(p.canCompleteFeedback('session-a', 'idea-a', token)).toBe(true);
    expect(p.canCompleteFeedback('session-a', 'idea-b', token)).toBe(false);
  });

  it('Stop returns to understanding and invalidates feedback without losing manual access', () => {
    const p = live();
    p.receive('idea-a', true);
    const token = p.beginFeedback('session-a', 'idea-a');
    p.receive('idea-b', true);
    p.stop();
    expect(p.mode).toBe('understanding');
    expect(p.pendingId).toBeUndefined();
    expect(p.canCompleteFeedback('session-a', 'idea-a', token)).toBe(false);
    expect(p.openLatest()).toBe(true);
    expect(p.displayedId).toBe('idea-b');
  });

  it('removing the active contribution closes the focus view and clears pending access', () => {
    const p = live();
    p.receive('idea-a', true);
    p.receive('idea-b', true);
    p.receive(undefined, false);
    expect(p.mode).toBe('understanding');
    expect(p.latestId).toBeUndefined();
    expect(p.pendingId).toBeUndefined();
    expect(p.openLatest()).toBe(false);
  });

  it('does not automatically enter a late accepted item after Stop, even before the closed snapshot arrives', () => {
    const p = live();
    p.receive('idea-a', true);
    p.stop();
    expect(p.receive('late-idea', true).presented).toBe(false);
    expect(p.mode).toBe('understanding');
    expect(p.pendingId).toBeUndefined();
    p.reset('next-session');
    expect(p.receive('next-idea', true).presented).toBe(true);
  });

  it('never acknowledges feedback without the engagement token captured by its own control', () => {
    const p = live();
    p.receive('idea-a', true);
    expect(p.canCompleteFeedback('session-a', 'idea-a', undefined)).toBe(false);
  });

  it('new sessions clear local state and prevent previous-session acknowledgements', () => {
    const p = live();
    p.receive('idea-a', true);
    const token = p.beginFeedback('session-a', 'idea-a');
    p.reset('session-b');
    expect(p.displayedId).toBeUndefined();
    expect(p.latestId).toBeUndefined();
    expect(p.canCompleteFeedback('session-a', 'idea-a', token)).toBe(false);
    expect(p.receive('idea-a', true).presented).toBe(true);
  });
});
