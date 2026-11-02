// Versioned local snapshot. Copies only; never edits a recording or reference.
import { readFile, writeFile, mkdir, copyFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
const source = path.resolve(process.argv[2] || 'artifacts/meeting-baseline');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pilotBytes = await readFile(path.join(source, 'pilot.json'));
const refBytes = await readFile(path.join(source, 'reference.json'));
const intakeBytes = await readFile(path.join(source, 'intake.json'));
const pilot = JSON.parse(pilotBytes),
  reference = JSON.parse(refBytes),
  intake = JSON.parse(intakeBytes);
assert.equal(reference.pilotHash, sha(pilotBytes));
const destination = path.resolve(
  'training:meeting',
  'verified-excerpts-v1-' + sha(refBytes).slice(0, 12),
);
try {
  await stat(destination);
  const previous = JSON.parse(await readFile(path.join(destination, 'manifest.json')));
  assert.equal(previous.referenceHash, sha(refBytes));
  for (const file of previous.files)
    assert.equal(sha(await readFile(path.join(destination, file.path))), file.sha256);
  console.log('Existing snapshot verified: ' + destination);
  process.exit(0);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await mkdir(destination);
await mkdir(path.join(destination, 'clips'));
const files = [];
async function save(relative, bytes) {
  await writeFile(path.join(destination, relative), bytes, { flag: 'wx' });
  files.push({ path: relative, bytes: bytes.length, sha256: sha(bytes) });
}
await save('reference.json', refBytes);
await save('pilot.json', pilotBytes);
await save('intake.json', intakeBytes);
const clips = [];
for (const row of pilot.results) {
  const id = `${row.startSeconds}:${row.role}`;
  const annotation = reference.annotations.find((a) => a.id === id);
  assert.ok(annotation);
  assert.equal(annotation.inputHash, row.inputStats.sha256);
  const name = String(row.startSeconds).padStart(4, '0') + '-' + row.role;
  const pcm = await readFile(row.pcm),
    wav = await readFile(row.reviewAudio);
  assert.equal(sha(pcm), row.inputStats.sha256);
  assert.deepEqual(wav.subarray(44), pcm);
  await save('clips/' + name + '.f32', pcm);
  await save('clips/' + name + '.wav', wav);
  clips.push({
    id,
    role: row.role,
    startSeconds: row.startSeconds,
    endSeconds: row.endSeconds,
    inputHash: sha(pcm),
    pcm: 'clips/' + name + '.f32',
    audio: 'clips/' + name + '.wav',
    referenceStatus: annotation.status,
  });
}
const manifest = {
  kind: 'verified-meeting-excerpts',
  version: 1,
  createdAt: new Date().toISOString(),
  referenceHash: sha(refBytes),
  pilotHash: sha(pilotBytes),
  sampleRate: 16000,
  pcmFormat: 'float32-le',
  originalRecordings: [],
  clips,
  files,
  use: 'User-verified development/evaluation examples; not an untouched training holdout. No training performed.',
  note: 'References and excerpts are copied byte-for-byte. The pilot/intake preserve original artifact paths as provenance; use relative clip paths in this manifest to load this snapshot.',
};
for (const [role, track] of Object.entries(intake.tracks)) {
  assert.equal(sha(await readFile(track.original)), track.sha256);
  manifest.originalRecordings.push({
    role,
    path: path.relative(destination, track.original),
    sha256: track.sha256,
  });
}
await writeFile(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2), {
  flag: 'wx',
});
await writeFile(
  path.join(destination, 'README.md'),
  `# Verified meeting excerpts — version 1\n\nPreserved locally: 18 exact eight-second excerpts (six meeting periods, three source tracks), lossless WAVs, original Float32 samples, your saved words and review statuses, raw Whisper drafts, and source provenance.\n\nYour input was copied verbatim to [reference.json](reference.json). [manifest.json](manifest.json) records hashes and relative clip paths. All three full original recordings remain unchanged in the parent folder.\n\nThis version uses reference SHA-256 \`${sha(refBytes)}\`. Later review edits should create another version; this snapshot is not overwritten.\n\nThese reviewed excerpts are now development data for comparisons. Reserve different material, ideally from other meetings, for final evaluation. No training, correction rules or production changes were made by preservation. This folder stays local under the existing source-control exclusion.\n`,
  { flag: 'wx' },
);
console.log('Preserved ' + clips.length + ' excerpts and exact user references at ' + destination);
