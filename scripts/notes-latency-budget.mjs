// Shared conservative ledger. A reserved attempt counts even if its process crashes.
import { open, readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
export const REQUEST_CAP = 100;
export async function budgetStatus(file) {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (
      value.cap !== REQUEST_CAP ||
      !Number.isInteger(value.used) ||
      value.used < 0 ||
      value.used > REQUEST_CAP
    )
      throw Error('Invalid budget ledger');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return { cap: REQUEST_CAP, used: 0, attempts: [] };
    throw error;
  }
}
export async function reserveRequest(file, metadata = {}) {
  await mkdir(path.dirname(file), { recursive: true });
  // Fail closed if another runner owns the lock; do not race the request cap.
  const lock = await open(file + '.lock', 'wx');
  try {
    const budget = await budgetStatus(file);
    if (budget.used >= REQUEST_CAP) throw Error('Live evaluation request cap reached (100).');
    budget.used++;
    budget.attempts.push({ number: budget.used, at: new Date().toISOString(), ...metadata });
    await writeFile(file + '.next', JSON.stringify(budget, null, 2));
    await rename(file + '.next', file);
    return budget;
  } finally {
    await lock.close();
    await unlink(file + '.lock');
  }
}
