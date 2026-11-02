import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { budgetStatus } from './notes-latency-budget.mjs';
const { values: v } = parseArgs({
  options: {
    manifest: { type: 'string' },
    phase: { type: 'string', default: 'pilot' },
    'pilot-review': { type: 'string' },
    run: { type: 'boolean' },
    output: { type: 'string', default: 'artifacts/notes-suite' },
    budget: { type: 'string', default: 'artifacts/notes-latency-budget.json' },
  },
});
if (!v.manifest || !['pilot', 'full'].includes(v.phase))
  throw Error('--manifest required; --phase pilot|full');
const manifest = JSON.parse(await readFile(v.manifest, 'utf8'));
if (
  !Array.isArray(manifest.clips) ||
  manifest.clips.length < 4 ||
  new Set(manifest.clips.map((c) => c.id)).size !== manifest.clips.length
)
  throw Error('Need at least four distinct clip IDs');
let seed = manifest.seed ?? 20261023;
const clips = v.phase === 'pilot' ? manifest.clips.slice(0, 4) : manifest.clips.slice(4);
const jobs = [];
// Advance the seed for every clip, including the pilot, so full-run order is reproducible.
for (const clip of manifest.clips) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  if (!clips.includes(clip)) continue;
  for (const variant of seed & 0x80000000
    ? ['baseline', 'short-first-note']
    : ['short-first-note', 'baseline'])
    jobs.push({
      clip,
      variant,
      output: path.join(v.output, `${clip.id.replace(/[^\w-]/g, '_')}-${variant}.json`),
    });
}
console.log(
  JSON.stringify(
    {
      phase: v.phase,
      jobs: jobs.map((j) => ({ id: j.clip.id, variant: j.variant, output: j.output })),
      budget: await budgetStatus(v.budget),
    },
    null,
    2,
  ),
);
if (!v.run) process.exit(0);
if (!process.env.LISTEN_HPOP_KEY)
  throw Error('Set LISTEN_HPOP_KEY locally; no live requests made.');
if (v.phase === 'full') {
  const review = v['pilot-review'] && JSON.parse(await readFile(v['pilot-review'], 'utf8'));
  if (
    review?.technicalPass !== true ||
    typeof review.findings !== 'string' ||
    !review.findings.trim()
  )
    throw Error(
      'Full evaluation requires --pilot-review with technicalPass:true and findings after reviewing four pairs.',
    );
}
await mkdir(v.output, { recursive: true });
const completed = [];
const previous =
  v.phase === 'full'
    ? JSON.parse(await readFile(path.join(v.output, 'pilot-runs.json'), 'utf8'))
    : [];
if (v.phase === 'full' && previous.length !== 8)
  throw Error('Full evaluation requires all eight pilot runs.');
for (const job of jobs) {
  if ((await budgetStatus(v.budget)).used >= 100) break;
  const args = [
    'scripts/notes-latency-browser.mjs',
    '--variant',
    job.variant,
    '--duration',
    String(job.clip.durationSeconds ?? 45),
    '--output',
    job.output,
    '--budget',
    v.budget,
    '--run',
    job.clip.audio ? '--audio' : '--url',
    job.clip.audio || job.clip.url,
  ];
  if (!args.at(-1)) throw Error('Each clip needs audio or url');
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', resolve);
  });
  completed.push({ ...job, exitCode });
  await writeFile(
    path.join(v.output, `${v.phase}-runs.json`),
    JSON.stringify(
      completed.map((j) => j.output),
      null,
      2,
    ),
  );
  await writeFile(
    path.join(v.output, 'reports.json'),
    JSON.stringify([...previous, ...completed.map((j) => j.output)], null, 2),
  );
  if (exitCode !== 0) break; // Inspect technical failures before spending on more jobs.
}
