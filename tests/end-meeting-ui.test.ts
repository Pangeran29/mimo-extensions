import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { endAndChooseFolder, attachMeetingDirectory, chooseMeetingDirectory } from '../src/end-meeting/ui';

const store = vi.hoisted(() => ({ setDestination: vi.fn(), getDestination: vi.fn() }));
vi.mock('../src/end-meeting/store', () => store);

const directory = { kind: 'directory', name: 'Meetings' } as FileSystemDirectoryHandle;
const job = { sessionId: 'meeting-one' };
let calls: string[];
let message: ReturnType<typeof vi.fn>;
let picker: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  message = vi.fn(async (action: { type: string }) => {
    calls.push(action.type);
    return { ok: true, value: job };
  });
  picker = vi.fn(async () => {
    calls.push('picker');
    return directory;
  });
  store.setDestination.mockImplementation(async () => { calls.push('persist destination'); });
  vi.stubGlobal('chrome', { runtime: { sendMessage: message } });
  vi.stubGlobal('window', { showDirectoryPicker: picker });
});
afterEach(() => vi.unstubAllGlobals());

describe('end-meeting folder interaction', () => {
  it('dispatches Stop and invokes the native picker in the original event turn', async () => {
    const stopping = endAndChooseFolder('meeting-one');
    expect(calls).toEqual(['END_MEETING', 'picker']);
    await expect(stopping).resolves.toEqual(job);
    expect(calls).toEqual(['END_MEETING', 'picker', 'persist destination', 'END_DESTINATION']);
    expect(picker).toHaveBeenCalledWith({ mode: 'readwrite', id: 'mimo-meeting-results', startIn: 'downloads' });
  });

  it('picker cancellation neither cancels Stop nor discards retained audio', async () => {
    picker.mockRejectedValue(new DOMException('Cancelled', 'AbortError'));
    await expect(endAndChooseFolder('meeting-one')).resolves.toEqual(job);
    expect(message.mock.calls.map(([action]) => action.type)).toEqual(['END_MEETING']);
    expect(store.setDestination).not.toHaveBeenCalled();
  });

  it('a blocked picker leaves Stop dispatched and supplies a recovery message', async () => {
    picker.mockRejectedValue(new DOMException('No activation', 'SecurityError'));
    await expect(endAndChooseFolder('meeting-one')).rejects.toThrow('Recording has stopped');
    expect(message.mock.calls.map(([action]) => action.type)).toEqual(['END_MEETING']);
  });

  it('reuses a destination selected before replay instead of opening a second picker', async () => {
    await expect(endAndChooseFolder('meeting-one', false)).resolves.toEqual(job);
    expect(picker).not.toHaveBeenCalled();
    expect(message.mock.calls.map(([action]) => action.type)).toEqual(['END_MEETING']);
  });

  it('persists a directory handle before notifying the background, without serializing it into a message', async () => {
    await attachMeetingDirectory('meeting-one', directory);
    expect(store.setDestination).toHaveBeenCalledWith('meeting-one', directory);
    expect(message).toHaveBeenCalledWith({ target: 'worker', type: 'END_DESTINATION', sessionId: 'meeting-one' });
    expect(calls).toEqual(['persist destination', 'END_DESTINATION']);
  });

  it('handles synchronous browser rejection as a rejected promise', async () => {
    picker.mockImplementation(() => { throw new DOMException('Unavailable', 'SecurityError'); });
    await expect(chooseMeetingDirectory()).rejects.toMatchObject({ name: 'SecurityError' });
  });
});
