import { getDestination, setDestination } from './store';
import type { EndAction, EndMeetingJob } from './types';
import type { Reply } from '../types';

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options: {
    mode: 'readwrite';
    id: string;
    startIn: 'downloads';
  }) => Promise<FileSystemDirectoryHandle>;
};

export async function endRequest<T = EndMeetingJob | undefined>(action: EndAction): Promise<T> {
  const reply: Reply<T> = await chrome.runtime.sendMessage({ target: 'worker', ...action });
  if (!reply?.ok) throw new Error(reply?.error ?? 'Meeting results are unavailable. Try again.');
  return reply.value;
}

/** Invoke directly in a click handler, before awaiting another operation. */
export function chooseMeetingDirectory(): Promise<FileSystemDirectoryHandle | undefined> {
  const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
  if (!picker)
    return Promise.reject(new Error('Open meeting notes and choose a folder in desktop Chrome.'));
  try {
    return picker
      .call(window, { mode: 'readwrite', id: 'mimo-meeting-results', startIn: 'downloads' })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return undefined;
        throw error;
      });
  } catch (error) {
    return Promise.reject(error);
  }
}

export async function attachMeetingDirectory(
  sessionId: string,
  directory: FileSystemDirectoryHandle,
): Promise<EndMeetingJob | undefined> {
  await setDestination(sessionId, directory);
  return endRequest({ type: 'END_DESTINATION', sessionId });
}

export async function saveMeetingToFolder(sessionId: string): Promise<EndMeetingJob | undefined> {
  // Choosing again also handles revoked permission. The browser owns the consent UI.
  const directory = await chooseMeetingDirectory();
  return directory ? attachMeetingDirectory(sessionId, directory) : endRequest({ type: 'END_STATUS', sessionId });
}

export async function hasMeetingDirectory(sessionId: string): Promise<boolean> {
  return !!(await getDestination(sessionId));
}

/** Stop is dispatched before asking where to save, and never depends on the picker. */
export async function endAndChooseFolder(
  sessionId?: string,
  choose = true,
): Promise<EndMeetingJob | undefined> {
  const ending = endRequest({ type: 'END_MEETING', sessionId });
  // Start the picker in the original gesture. Settle its rejection immediately so a
  // cancelled/restricted native dialog cannot interrupt Stop or become unhandled.
  const selection = choose
    ? chooseMeetingDirectory().then(
        (directory) => ({ directory, error: undefined as unknown }),
        (error: unknown) => ({ directory: undefined, error }),
      )
    : Promise.resolve({ directory: undefined, error: undefined as unknown });
  const job = await ending;
  const result = await selection;
  if (result.error)
    throw new Error('Recording has stopped. Open Meeting notes and choose a folder to save the results.');
  if (!result.directory) return job;
  const id = job?.sessionId ?? sessionId;
  if (!id) throw new Error('The meeting stopped, but its save destination could not be attached. Open Meeting notes to save again.');
  return attachMeetingDirectory(id, result.directory);
}
