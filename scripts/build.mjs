import { createRequire } from 'node:module';
import path from 'node:path';
import { build } from 'esbuild';
import { cp, mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises';
const replayLab = process.env.LISTEN_REPLAY_LAB === '1';
const output = process.env.LISTEN_BUILD_DIR || (replayLab ? 'artifacts/replay-lab/build' : 'dist');
if (replayLab && path.resolve(output) === path.resolve('dist'))
  throw Error('Replay Lab needs a separate build directory. The main extension was not changed.');
const buildId = new Date().toISOString();
let relay = {};
try {
  relay = JSON.parse(await readFile('.local/deepinfra.json', 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp('public', output, { recursive: true });
const relayOrigin =
  replayLab && process.env.LISTEN_RELAY_ORIGIN
    ? new URL(process.env.LISTEN_RELAY_ORIGIN).origin
    : 'http://127.0.0.1:8787';
if (replayLab) {
  const manifest = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'));
  manifest.name = 'Memo Replay Lab';
  manifest.description =
    'Research build: replay a fixed audio recording through the real Memo pipeline.';
  manifest.action.default_title = 'Memo Replay Lab';
  manifest.action.default_popup = 'replay-launcher.html';
  manifest.options_page = 'replay.html';
  manifest.host_permissions = manifest.host_permissions.map((origin) =>
    origin === 'http://127.0.0.1:8787/*' ? relayOrigin + '/*' : origin,
  );
  manifest.content_security_policy.extension_pages =
    manifest.content_security_policy.extension_pages.replace('http://127.0.0.1:8787', relayOrigin);
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
} else {
  for (const file of ['replay.html', 'replay.css', 'replay-launcher.html'])
    await rm(path.join(output, file), { force: true });
}
await cp('THIRD_PARTY_NOTICES.md', path.join(output, 'THIRD_PARTY_NOTICES.md'));
await cp('licenses', path.join(output, 'licenses'), { recursive: true });
await build({
  entryPoints: [
    'src/worker.ts',
    'src/offscreen.ts',
    'src/popup.ts',
    'src/setup.ts',
    'src/assistant-window.ts',
    'src/assistant/network-worker.ts',
    ...(replayLab ? ['src/replay-lab.ts', 'src/replay-launcher.ts'] : []),
  ],
  outdir: output,
  bundle: true,
  format: 'esm',
  target: 'chrome116',
  sourcemap: true,
  legalComments: 'eof',
  define: {
    LISTEN_BUILD_ID: JSON.stringify(buildId),
    LISTEN_REPLAY_LAB: JSON.stringify(replayLab),
    LISTEN_ASR_BATCH_SECONDS: JSON.stringify(Number(process.env.LISTEN_ASR_BATCH_SECONDS || 16)),
    LISTEN_TRANSCRIPTION_URL: JSON.stringify(relayOrigin + '/transcribe'),
    LISTEN_RELAY_TOKEN: JSON.stringify(
      replayLab && process.env.LISTEN_RELAY_TOKEN !== undefined
        ? process.env.LISTEN_RELAY_TOKEN
        : relay.relayToken || '',
    ),
  },
});
const require = createRequire(import.meta.url);
const vadRequire = createRequire(require.resolve('@ricky0123/vad-web'));
const vadOrtDirectory = path.dirname(vadRequire.resolve('onnxruntime-web'));
await mkdir(path.join(output, 'vad-ort'), { recursive: true });
for (const file of await readdir(vadOrtDirectory)) {
  if (/^ort-wasm-simd-threaded\.(wasm|mjs)$/.test(file))
    await cp(path.join(vadOrtDirectory, file), path.join(path.join(output, 'vad-ort'), file));
}
await mkdir(path.join(output, 'vad'), { recursive: true });
const vadDirectory = path.dirname(require.resolve('@ricky0123/vad-web'));
for (const file of ['silero_vad_v5.onnx', 'vad.worklet.bundle.min.js']) {
  await cp(path.join(vadDirectory, file), path.join(path.join(output, 'vad'), file));
}

await writeFile(path.join(output, 'build-info.json'), JSON.stringify({ buildId }, null, 2));
console.log('Unpacked Chrome extension built in ' + output);
