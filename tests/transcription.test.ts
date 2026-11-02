import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { SpeechSegmenter, removeOverlap } from '../src/transcription/segmenter';
import { saveTranscript, loadTranscript, recoveredTranscript } from '../src/transcription/store';
import * as audioDB from '../src/db';
import type { AudioWindow, TranscriptSnapshot } from '../src/transcription/types';
const frame = () => new Float32Array(512);
function feed(s: SpeechSegmenter, count: number, p: number) {
  for (let i = 0; i < count; i++) s.push(frame(), p);
}
describe('speech windows', () => {
  it('keeps silence bounded, rejects short noise and emits no silence-only work', () => {
    const windows: AudioWindow[] = [];
    const s = new SpeechSegmenter((w) => windows.push(w));
    feed(s, 2000, 0);
    expect(s.bufferedSamples).toBeLessThanOrEqual(6400);
    feed(s, 4, 0.9);
    feed(s, 30, 0);
    s.flush();
    expect(windows).toHaveLength(0);
  });
  it('flushes speech after a pause with original sample timing', () => {
    const windows: AudioWindow[] = [];
    const s = new SpeechSegmenter((w) => windows.push(w));
    feed(s, 30, 0);
    feed(s, 20, 0.9);
    feed(s, 19, 0);
    expect(windows).toHaveLength(1);
    expect(windows[0].overlap).toBe(false);
    expect(windows[0].endSample).toBe(69 * 512);
    expect(windows[0].endSample - windows[0].startSample).toBe(windows[0].audio.length);
  });
  it('caps long speech near eight seconds with one second of overlap and flushes Stop', () => {
    const windows: AudioWindow[] = [];
    const s = new SpeechSegmenter((w) => windows.push(w));
    feed(s, 250, 0.9);
    expect(windows).toHaveLength(1);
    expect(windows[0].audio.length).toBe(128000);
    s.flush();
    expect(windows).toHaveLength(1); // An overlap-only tail is not a new utterance.
    const next = new SpeechSegmenter((w) => windows.push(w));
    feed(next, 300, 0.9);
    next.flush();
    expect(windows).toHaveLength(3);
    expect(windows[2].overlap).toBe(true);
    expect(windows[2].startSample).toBe(windows[1].endSample - 16000);
  });
  it('retains forced-split overlap even when the model immediately transfers the audio buffer', () => {
    const submitted: Float32Array[] = [];
    const s = new SpeechSegmenter((window) => {
      submitted.push(
        structuredClone(window.audio, { transfer: [window.audio.buffer as ArrayBuffer] }),
      );
    });
    feed(s, 300, 0.9);
    s.flush();
    expect(submitted.map((audio) => audio.length)).toEqual([128000, 41600]);
    expect(s.bufferedSamples).toBe(0);
  });
  it('deduplicates only explicit overlap, preserves natural repetition and removes blank markers', () => {
    expect(removeOverlap('Halo, apa kabar?', 'apa kabar hari ini?', true)).toBe('hari ini?');
    expect(removeOverlap('yes', 'yes', false)).toBe('yes');
    expect(removeOverlap('anything', '[BLANK_AUDIO]', true)).toBe('');
  });
});
describe('latest transcript storage', () => {
  it('survives deletion of temporary audio and recovers interrupted state honestly', async () => {
    const snapshot: TranscriptSnapshot = {
      phase: 'transcribing',
      sessionId: 'speech-session',
      segments: [
        { id: 0, sessionId: 'speech-session', startMs: 100, endMs: 1200, text: 'Halo world' },
      ],
      incomplete: false,
      lagMs: 0,
      modelReady: true,
    };
    await saveTranscript(snapshot);
    await audioDB.deleteSession('speech-session');
    const loaded = await loadTranscript();
    expect(loaded?.segments[0].text).toBe('Halo world');
    const recovered = recoveredTranscript(loaded!);
    expect(recovered.phase).toBe('failed');
    expect(recovered.incomplete).toBe(true);
    expect(recovered.modelReady).toBe(false);
    await saveTranscript({ ...snapshot, phase: 'complete' });
    expect(recoveredTranscript((await loadTranscript())!).phase).toBe('complete');
  });
});
