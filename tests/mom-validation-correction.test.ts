import { expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/assistant/types';
import { AssistantAPIError } from '../src/assistant/errors';
import { generateMinutes, MomValidationError, validateExtraction, validateMinutes, type MomCheckpoint } from '../src/end-meeting/mom';
import type { MomRequest, MomRequester } from '../src/end-meeting/provider';
import type { TranscriptSegment } from '../src/transcription/types';

const settings = { ...DEFAULT_SETTINGS, provider: 'hpop' as const, enabled: true };
const segments: TranscriptSegment[] = [
  { id: 77, sessionId: 'validation', startMs: 0, endMs: 5000, text: 'Servernya di kita. Mitra mengakses API yang disediakan.' },
  { id: 125, sessionId: 'validation', startMs: 5000, endMs: 10000, text: 'Maya mengirim dokumentasi API pada hari Jumat.' },
];
const response = (value: unknown) => ({ value, latencyMs: 1, firstTokenMs: 1, usage: { input: 10, output: 10 } });
const verdict = (accept = true) => ({ protocol: 1, accept, reason: accept ? 'Supported by the original evidence.' : 'Server ownership is reversed against source 77.' });
const draft = (correct = true) => ({
  protocol: 1, language: 'Indonesian', emptyReason: null,
  bullets: [{ kind: 'discussion', text: correct ? 'Server berada di pihak tim sendiri; Maya mengirim dokumentasi API hari Jumat.' : 'Server berada di pihak mitra; Maya mengirim dokumentasi API hari Jumat.', sources: [77, 125], quotes: segments.map(s => ({ source: s.id, text: s.text })) }],
});
const missingQuote = () => {
  const value = draft(); value.bullets[0].quotes.pop(); return value;
};
const payload = (r: MomRequest) => JSON.parse(r.messages[1].content);
const input = (request: MomRequester, save: (cp: MomCheckpoint) => Promise<void> = async () => {}) => ({
  segments, settings, key: 'synthetic', signal: new AbortController().signal, request, save,
});

it('diagnoses evidence mappings without leaking transcript text or source values in diagnostics', () => {
  expect(() => validateMinutes(missingQuote(), segments)).toThrow(expect.objectContaining({ code: 'missing_source_quote', path: '$.bullets[0].sources[1]' }));
  const wrongText = draft(); wrongText.bullets[0].quotes[0].text = 'Servernya di mereka.';
  expect(() => validateMinutes(wrongText, segments)).toThrow(expect.objectContaining({ code: 'quote_not_in_source', path: '$.bullets[0].quotes[0].text' }));
  const extraction = { language: 'Indonesian', facts: [{ kind: 'action', text: 'Maya mengirim dokumentasi.', sources: [125], quotes: [{ source: 0, text: segments[1].text }] }] };
  expect(() => validateExtraction(extraction, segments)).toThrow(expect.objectContaining({ code: 'quote_source_mismatch', path: '$.facts[0].quotes[0].source' }));
});

it('reports original source-array indexes when duplicate IDs precede a missing quote or unknown source', () => {
  const missing = missingQuote(); missing.bullets[0].sources = [77, 77, 125];
  expect(() => validateMinutes(missing, segments)).toThrow(expect.objectContaining({ code: 'missing_source_quote', path: '$.bullets[0].sources[2]' }));
  const unknown = draft(); unknown.bullets[0].sources = [77, 77, 999];
  expect(() => validateMinutes(unknown, segments)).toThrow(expect.objectContaining({ code: 'unknown_source', path: '$.bullets[0].sources[2]' }));
  const valid = draft(); valid.bullets[0].sources = [77, 77, 125];
  expect(validateMinutes(valid, segments).bullets[0].sources).toEqual([77, 125]);
});

it('corrects missing composition quotes from original input before any reviewer sees the candidate', async () => {
  const calls: MomRequest[] = [], checkpoints: MomCheckpoint[] = [], events: { kind: string; data: any }[] = [];
  const request: MomRequester = async r => {
    calls.push(r);
    if (r.stage === 'review') {
      expect(calls.filter(c => c.stage === 'compose')).toHaveLength(2);
      expect(payload(r).candidate.bullets[0].quotes).toHaveLength(2);
      return response(verdict());
    }
    const p = payload(r);
    if (!p.validation) return response(missingQuote());
    expect(p.validation).toEqual({ stage: 'compose', code: 'missing_source_quote', path: '$.bullets[0].sources[1]' });
    expect(p.originalInput.transcript).toEqual(segments);
    expect(p.rejectedResponse).toEqual(missingQuote());
    expect(r.messages[0].content).toContain('untrusted diagnostic data');
    expect(r.messages[0].content).toContain('global transcript IDs');
    expect(r.schema).toBe(calls[0].schema);
    expect(checkpoints.at(-1)?.correcting).toEqual({ stage: 'compose' });
    expect(checkpoints.every(cp => !cp.draft)).toBe(true);
    return response(draft());
  };
  const result = await generateMinutes({ ...input(request, async cp => { checkpoints.push(cp); }), event: (kind, data) => events.push({ kind, data }) });
  expect(calls.map(c => c.stage)).toEqual(['compose', 'compose', 'review']);
  expect(result.minutes.bullets[0].sources).toEqual([77, 125]);
  expect(result.checkpoint.correcting).toBeUndefined();
  const diagnostics = events.filter(e => e.kind.startsWith('validation-'));
  expect(diagnostics.map(e => e.kind)).toEqual(['validation-failed', 'validation-correction-started', 'validation-correction-accepted']);
  expect(JSON.stringify(diagnostics)).not.toContain('Servernya');
});

it('corrects a normalized quotation using verbatim text without relaxing the exact match', async () => {
  const request: MomRequester = async r => {
    if (r.stage === 'review') return response(verdict());
    if (payload(r).validation) {
      expect(payload(r).validation.code).toBe('quote_not_in_source');
      return response(draft());
    }
    const invalid = draft(); invalid.bullets[0].quotes[0].text = 'Server berada di pihak kita.';
    return response(invalid);
  };
  const result = await generateMinutes(input(request));
  expect((result.minutes.bullets[0] as any).quotes[0].text).toBe(segments[0].text);
});

it('preserves global source IDs while correcting an extraction and checkpoints only valid facts', async () => {
  const source = Array.from({ length: 14 }, (_, i) => ({ ...segments[0], id: 125 + i, text: `${125 + i}: ${'Percakapan sumber asli. '.repeat(100)}` }));
  const calls: MomRequest[] = [], checkpoints: MomCheckpoint[] = [];
  let invalidSent = false;
  const request: MomRequester = async r => {
    calls.push(r); const p = payload(r);
    if (r.stage === 'extract') {
      const original = p.originalInput ?? p;
      const s = original.transcript[0];
      const value = { language: 'Indonesian', facts: [{ kind: 'discussion', text: 'Percakapan sumber asli.', sources: [s.id], quotes: [{ source: s.id, text: s.text.slice(0, 80) }] }] };
      if (!invalidSent) { invalidSent = true; value.facts[0].quotes[0].source = 0; }
      if (p.validation) {
        expect(p.validation).toEqual({ stage: 'extract', code: 'quote_source_mismatch', path: '$.facts[0].quotes[0].source' });
        expect(p.originalInput.transcript[0].id).toBe(125);
        expect(checkpoints.at(-1)?.extracts).toEqual({});
      }
      return response(value);
    }
    if (r.stage === 'review') return response(verdict());
    return response({ protocol: 1, language: 'Indonesian', emptyReason: null, bullets: [{ kind: 'discussion', text: 'Percakapan sumber asli.', sources: [125], quotes: [{ source: 125, text: source[0].text.slice(0, 80) }] }] });
  };
  const result = await generateMinutes({ ...input(request, async cp => { checkpoints.push(cp); }), segments: source });
  expect(calls.filter(r => r.stage === 'extract' && payload(r).validation)).toHaveLength(1);
  expect(result.checkpoint.coverage).toEqual(source.map(s => s.id));
  expect(result.checkpoint.extracts['chunk-0'].facts[0].quotes[0].source).toBe(125);
  expect(checkpoints.every(cp => Object.values(cp.extracts).every(e => e.facts.every(f => f.quotes.every(q => f.sources.includes(q.source)))))).toBe(true);
});

it('stops after one invalid correction with precise diagnostics and no review or invalid draft checkpoint', async () => {
  const calls: MomRequest[] = [], checkpoints: MomCheckpoint[] = [];
  const request: MomRequester = async r => { calls.push(r); return response(missingQuote()); };
  await expect(generateMinutes(input(request, async cp => { checkpoints.push(cp); }))).rejects.toMatchObject({
    code: 'missing_source_quote', stage: 'compose', path: '$.bullets[0].sources[1]',
  });
  expect(calls.map(r => r.stage)).toEqual(['compose', 'compose']);
  expect(checkpoints.every(cp => !cp.draft)).toBe(true);
  expect(checkpoints.at(-1)?.correcting).toBeUndefined();
});

it('corrects a readable invalid verdict without publishing or treating it as a semantic rejection', async () => {
  const calls: MomRequest[] = [];
  const request: MomRequester = async r => {
    calls.push(r);
    if (r.stage === 'compose') return response(draft());
    if (!payload(r).validation) return response({ protocol: 1, accept: true, reason: '' });
    expect(payload(r).validation).toEqual({ stage: 'review', code: 'invalid_text', path: '$.reason' });
    expect(payload(r).originalInput.candidate.bullets).toHaveLength(1);
    return response(verdict());
  };
  const result = await generateMinutes(input(request));
  expect(calls.map(r => r.stage)).toEqual(['compose', 'review', 'review']);
  expect(result.checkpoint.lastRejection).toBeUndefined();
  expect(result.checkpoint.reviewed).toEqual(['review-0']);
});

it('fences a late valid correction after abort before it can enter a draft or reviewer', async () => {
  const abort = new AbortController(), checkpoints: MomCheckpoint[] = [];
  const request = vi.fn<MomRequester>(async r => {
    if (payload(r).validation) { abort.abort(); return response(draft()); }
    return response(missingQuote());
  });
  await expect(generateMinutes({ ...input(request, async cp => { checkpoints.push(cp); }), signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(request).toHaveBeenCalledTimes(2);
  expect(checkpoints.every(cp => !cp.draft && !cp.reviewed.length)).toBe(true);
});

it('keeps correction input bounded and refuses an oversized correction instead of truncating source data', async () => {
  const request = vi.fn<MomRequester>(async () => response({ ...draft(), invalidExtra: 'x'.repeat(25_000) }));
  await expect(generateMinutes({ ...input(request), settings: { ...settings, goal: 'g'.repeat(60_000) } })).rejects.toMatchObject({ code: 'input_too_large', stage: 'compose' });
  expect(request).toHaveBeenCalledOnce();
});

it('keeps structural correction and semantic revision limits independent, requiring review after every valid draft', async () => {
  const calls: MomRequest[] = []; let correctedDrafts = 0;
  const request: MomRequester = async r => {
    calls.push(r); const p = payload(r);
    if (r.stage === 'review') return response(verdict(correctedDrafts > 1));
    if (!p.validation) return response(missingQuote());
    correctedDrafts++;
    if (correctedDrafts > 1) expect(p.originalInput.repairFeedback.reviewerReason).toContain('ownership');
    return response(draft(correctedDrafts > 1));
  };
  const result = await generateMinutes(input(request));
  expect(calls.map(r => r.stage)).toEqual(['compose', 'compose', 'review', 'compose', 'compose', 'review']);
  expect(result.minutes.bullets[0].text).toContain('tim sendiri');
  expect(result.checkpoint.repairing).toBe(false);
  expect(result.checkpoint.correcting).toBeUndefined();
});

it('does not treat transport errors as invalid structured output and clears correction progress on failure', async () => {
  const checkpoints: MomCheckpoint[] = [];
  const request = vi.fn<MomRequester>(async r => {
    if (payload(r).validation) throw new AssistantAPIError(401);
    return response(missingQuote());
  });
  await expect(generateMinutes(input(request, async cp => { checkpoints.push(cp); }))).rejects.toBeInstanceOf(AssistantAPIError);
  expect(request).toHaveBeenCalledTimes(2);
  expect(checkpoints.at(-1)?.correcting).toBeUndefined();
  expect(checkpoints.every(cp => !cp.draft)).toBe(true);
});
