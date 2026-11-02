// New preference defaults existing installations to the requested time schedule.
// The old listenAssistantSurface preference is intentionally superseded.
export const surfaceKey = 'listenAssistantAppearance';
export type AssistantSurface = 'Automatic' | 'Midnight' | 'Daylight';
export function assistantSurface(value: unknown): AssistantSurface {
  return value === 'Daylight' || value === 'Midnight' ? value : 'Automatic';
}
export function surfaceAtTime(
  preference: AssistantSurface,
  now = new Date(),
): 'Midnight' | 'Daylight' {
  if (preference !== 'Automatic') return preference;
  const hour = now.getHours();
  return hour >= 18 || hour < 6 ? 'Midnight' : 'Daylight';
}
