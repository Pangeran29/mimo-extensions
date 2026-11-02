import { expect, it } from 'vitest';
import { assistantSurface, surfaceAtTime } from '../src/appearance';

it.each([
  [0, 0, 'Midnight'],
  [5, 59, 'Midnight'],
  [6, 0, 'Daylight'],
  [12, 0, 'Daylight'],
  [17, 59, 'Daylight'],
  [18, 0, 'Midnight'],
  [23, 59, 'Midnight'],
] as const)('uses local time at %s:%s', (hour, minute, expected) => {
  expect(surfaceAtTime('Automatic', new Date(2026, 9, 18, hour, minute))).toBe(expected);
});
it('defaults to automatic and preserves explicit surface overrides', () => {
  expect(assistantSurface(undefined)).toBe('Automatic');
  expect(assistantSurface('System')).toBe('Automatic');
  expect(surfaceAtTime('Daylight', new Date(2026, 9, 18, 23))).toBe('Daylight');
  expect(surfaceAtTime('Midnight', new Date(2026, 9, 18, 12))).toBe('Midnight');
});
