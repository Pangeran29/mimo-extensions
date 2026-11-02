import { DEEPINFRA_MODEL } from './assistant/types';
declare const LISTEN_TRANSCRIPTION_URL: string;
declare const LISTEN_RELAY_TOKEN: string;
export const RELAY_ORIGIN = new URL(
  typeof LISTEN_TRANSCRIPTION_URL === 'undefined'
    ? 'http://127.0.0.1:8787/transcribe'
    : LISTEN_TRANSCRIPTION_URL,
).origin;
export const RELAY_TOKEN = typeof LISTEN_RELAY_TOKEN === 'undefined' ? '' : LISTEN_RELAY_TOKEN;
export async function managedNotesStatus(): Promise<'ready' | 'outdated' | 'unavailable'> {
  try {
    const response = await fetch(RELAY_ORIGIN + '/health', {
      headers: { Authorization: `Bearer ${RELAY_TOKEN}` },
      signal: AbortSignal.timeout(5000),
      credentials: 'omit',
      redirect: 'error',
    });
    if (!response.ok) return 'unavailable';
    const result = await response.json();
    if (result.notes?.configured !== true || result.notes.model !== DEEPINFRA_MODEL)
      return 'unavailable';
    return Array.isArray(result.notes.supportedLiveMemoProtocols) &&
      result.notes.supportedLiveMemoProtocols.includes(2)
      ? 'ready'
      : 'outdated';
  } catch {
    return 'unavailable';
  }
}

export async function managedNotesReady(): Promise<boolean> {
  return (await managedNotesStatus()) === 'ready';
}
