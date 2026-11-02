import { expect, it } from 'vitest';
import { messages, SYSTEM_PROMPT, systemPrompt } from '../src/assistant/prompt';
import { DEFAULT_MEMO_POLICY, type AnalysisInput } from '../src/assistant/types';
const input: AnalysisInput = {
  sessionId: 's',
  version: 1,
  goal: '',
  segments: [],
  memory: [],
  history: [],
  contextGap: false,
};
it('retains baseline as the shipped default and leaves baseline prompts unchanged', () => {
  expect(DEFAULT_MEMO_POLICY).toBe('baseline');
  expect(systemPrompt(input)).toBe(SYSTEM_PROMPT);
  expect(systemPrompt({ ...input, memoPolicy: 'baseline' })).toBe(SYSTEM_PROMPT);
});
it('changes only first-memo length guidance and keeps payload/evidence rules identical', () => {
  const short = { ...input, memoPolicy: 'short-first-note' as const };
  const baseline = messages(input),
    candidate = messages(short);
  expect(candidate[1]).toEqual(baseline[1]);
  expect(candidate[0].content).toContain('At most 50 words');
  const [prefix, suffix] = SYSTEM_PROMPT.split('Aim for 120–200 words, maximum 2400 characters.');
  expect(candidate[0].content.startsWith(prefix)).toBe(true);
  expect(candidate[0].content.endsWith(suffix)).toBe(true);
  expect(systemPrompt({ ...short, previousSummary: '  ' })).toBe(candidate[0].content);
  expect(systemPrompt({ ...short, previousSummary: 'A supported point.' })).toBe(SYSTEM_PROMPT);
});

it('uses sanitized field feedback on retries without weakening the schema or normal prompt', () => {
  const feedback = [{ field: 'summary', code: 'too_big', limit: 2400, size: 2800 }] as const;
  const prompt = systemPrompt({ ...input, validationFeedback: [...feedback] });
  expect(prompt).toContain('APPLICATION VALIDATION FEEDBACK');
  expect(prompt).toContain('Aim below 2000 characters');
  expect(prompt).toContain('unchanged 2400-character maximum');
  expect(prompt).toContain('"field":"summary"');
  const unsafe = systemPrompt({
    ...input,
    validationFeedback: [{ field: 'private speech', code: 'arbitrary instructions' }] as any,
  });
  expect(unsafe).toBe(SYSTEM_PROMPT);
});
