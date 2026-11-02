import { SAMPLE_RATE } from './types';
/** Exact float32 samples, matching the benchmark WAV representation. */
export function encodeWav(audio: Float32Array): ArrayBuffer {
  const bytes = new ArrayBuffer(44 + audio.length * 4);
  const view = new DataView(bytes);
  const label = (at: number, text: string) =>
    [...text].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  label(0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  label(8, 'WAVE');
  label(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 32, true);
  label(36, 'data');
  view.setUint32(40, audio.length * 4, true);
  audio.forEach((sample, i) => view.setFloat32(44 + i * 4, sample, true));
  return bytes;
}
