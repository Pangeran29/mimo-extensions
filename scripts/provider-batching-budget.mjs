import { readFile, writeFile, mkdir, open, unlink, rename } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
const ledgerPath = 'artifacts/provider-batching/budget.json';
const lockPath = ledgerPath + '.lock';
let chain = Promise.resolve();
export async function reserveLiveRequest(provider, label, reserveUsd) {
  const task = chain.then(async () => {
    await mkdir('artifacts/provider-batching', { recursive: true });
    let lock;
    const deadline = Date.now() + 10000;
    while (!lock) {
      try {
        lock = await open(lockPath, 'wx');
      } catch (e) {
        if (e.code !== 'EEXIST' || Date.now() >= deadline) throw e;
        await sleep(30);
      }
    }
    try {
      let ledger;
      try {
        ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        ledger = { limitRequests: 100, limitUsd: 2, requests: [], reservedUsd: 0 };
      }
      if (
        !Number.isFinite(reserveUsd) ||
        reserveUsd < 0 ||
        ledger.requests.length >= 100 ||
        ledger.reservedUsd + reserveUsd > 2
      )
        throw Error('Live evaluation budget exhausted');
      const id = ledger.requests.length + 1;
      ledger.requests.push({
        id,
        provider,
        label,
        at: new Date().toISOString(),
        reservedUsd: reserveUsd,
      });
      ledger.reservedUsd += reserveUsd;
      const temporary = ledgerPath + '.tmp-' + process.pid;
      await writeFile(temporary, JSON.stringify(ledger, null, 2));
      await rename(temporary, ledgerPath);
      return id;
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  });
  chain = task.catch(() => {});
  return task;
}
