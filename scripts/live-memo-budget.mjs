import { open, readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
const root = 'artifacts/live-memo-v1';
export async function reserveLiveMemoRequest(kind) {
  await mkdir(root, { recursive: true });
  const lock = root + '/budget.lock';
  let handle;
  for (let i = 0; i < 500; i++) {
    try {
      handle = await open(lock, 'wx');
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  if (!handle) throw Error('Evaluation budget lock unavailable');
  try {
    let value = { limit: 800, attempts: [] };
    try {
      value = JSON.parse(await readFile(root + '/provider-budget.json', 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (value.attempts.length >= 800)
      throw Error('Evaluation request cap reached; partial report required');
    value.attempts.push({ at: new Date().toISOString(), kind });
    await writeFile(root + '/provider-budget.json', JSON.stringify(value, null, 2));
    return value.attempts.length;
  } finally {
    await handle.close();
    await unlink(lock);
  }
}
