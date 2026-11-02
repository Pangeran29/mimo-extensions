import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

export function audioStats(bytes) {
  if (bytes.length % 4) throw Error('Incomplete float32 PCM');
  let energy = 0,
    peak = 0,
    nonFinite = 0,
    clipped = 0,
    nonzero = 0;
  for (let i = 0; i < bytes.length; i += 4) {
    const x = bytes.readFloatLE(i);
    if (!Number.isFinite(x)) {
      nonFinite++;
      continue;
    }
    energy += x * x;
    peak = Math.max(peak, Math.abs(x));
    if (Math.abs(x) >= 1) clipped++;
    if (x !== 0) nonzero++;
  }
  const samples = bytes.length / 4;
  return {
    samples,
    seconds: samples / 16000,
    rms: Math.sqrt(energy / Math.max(1, samples - nonFinite)),
    peak,
    nonFinite,
    clipped,
    nonzero,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

// Same UTF-8 length / zlib-compressed length definition as OpenAI Whisper.
export function compressionRatio(text) {
  const bytes = Buffer.from(text, 'utf8');
  return bytes.length / deflateSync(bytes).length;
}

export function transformPcm(bytes, { gain = 1, prependMs = 0, trimTailMs = 0 } = {}) {
  const prepend = prependMs * 16 * 4,
    trim = trimTailMs * 16 * 4;
  if (
    ![prepend, trim].every(Number.isSafeInteger) ||
    prepend < 0 ||
    trim < 0 ||
    trim > bytes.length
  )
    throw Error('Invalid PCM transformation');
  const result = Buffer.alloc(prepend + bytes.length - trim);
  bytes.copy(result, prepend, 0, bytes.length - trim);
  if (gain !== 1)
    for (let i = 0; i < result.length; i += 4) result.writeFloatLE(result.readFloatLE(i) * gain, i);
  return result;
}

export function pcmWav(bytes) {
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(36 + bytes.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(3, 20); // IEEE float, preserve the exact original samples.
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(64000, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(32, 34);
  header.write('data', 36);
  header.writeUInt32LE(bytes.length, 40);
  return Buffer.concat([header, bytes]);
}
