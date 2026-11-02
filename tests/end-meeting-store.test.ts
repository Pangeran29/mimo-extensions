import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { claimDestinationCleanup, getDestinationRecord, releaseDestinationCleanup, setDestination } from '../src/end-meeting/store';

// Prototype methods stay outside the structured-clone payload; real browser tests use native handles.
class TestHandle {
  kind = 'directory';
  constructor(public name: string) {}
  async isSameEntry(other: TestHandle) { return this.name === other.name; }
}
const handle = (name: string) => new TestHandle(name) as unknown as FileSystemDirectoryHandle;
it('same-folder permission renewal retains the existing bundle identity', async () => {
  await setDestination('same-folder', handle('folder'));
  const before = (await getDestinationRecord('same-folder'))!;
  await setDestination('same-folder', handle('folder'));
  expect((await getDestinationRecord('same-folder'))!.key).toBe(before.key);
});
it('the local cleanup claim blocks a destination switch until failed cleanup releases it', async () => {
  await setDestination('locked', handle('old'));
  const before = (await getDestinationRecord('locked'))!;
  expect(await claimDestinationCleanup('locked', 'not-the-current-key')).toBe(false);
  expect(await claimDestinationCleanup('locked', before.key)).toBe(true);
  await expect(setDestination('locked', handle('new'))).rejects.toThrow('finished saving');
  await setDestination('locked', handle('old'));
  expect((await getDestinationRecord('locked'))!.key).toBe(before.key);
  await releaseDestinationCleanup('locked', before.key);
  await setDestination('locked', handle('new'));
  expect((await getDestinationRecord('locked'))!.key).not.toBe(before.key);
});
