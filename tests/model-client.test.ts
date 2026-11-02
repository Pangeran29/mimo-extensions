import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { ModelClient } from '../src/transcription/client';
import { encodeWav } from '../src/transcription/wav';
let request: ReturnType<typeof vi.fn>;
beforeEach(() => {
  request = vi.fn(
    async () => new Response(JSON.stringify({ text: 'Halo 世界', language: 'auto' })),
  );
  vi.stubGlobal('fetch', request);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('cloud transcription transport', () => {
  it('sends exact float32 WAV to our relay, without a DeepInfra credential or language restriction', async () => {
    const client = new ModelClient();
    await client.prepare();
    const pcm = new Float32Array([0.5, -0.25, 0]);
    expect((await client.transcribe(pcm, 'session')).text).toBe('Halo 世界');
    const [url, options] = request.mock.calls[0] as any;
    expect(url).toBe('http://127.0.0.1:8787/transcribe');
    expect(options.headers).toEqual({ 'Content-Type': 'audio/wav', 'X-Listen-Session': 'session' });
    const view = new DataView(options.body);
    expect(view.getUint16(20, true)).toBe(3);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getFloat32(44, true)).toBe(0.5);
    expect(view.getFloat32(48, true)).toBe(-0.25);
    expect(pcm.byteLength).toBe(12);
  });
  it('does not require an upstream connection to prepare recording', async () => {
    const client = new ModelClient();
    await client.prepare();
    expect(client.ready).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });
  it('allows an empty finalized transcript and rejects malformed output', async () => {
    const client = new ModelClient();
    request.mockResolvedValueOnce(new Response('{"text":""}'));
    expect((await client.transcribe(new Float32Array(16), 's')).text).toBe('');
    request.mockResolvedValueOnce(new Response('{"error":"private server diagnostic"}'));
    await expect(client.transcribe(new Float32Array(16), 's')).rejects.toThrow('automatic retry');
  });
  it('aborts a stalled request and remains available for automatic retry', async () => {
    vi.useFakeTimers();
    request.mockImplementation(
      (_url: string, options: RequestInit) =>
        new Promise((_resolve, reject) =>
          options.signal!.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    );
    const client = new ModelClient();
    await client.prepare();
    const pending = client.transcribe(new Float32Array(16), 's');
    const failure = expect(pending).rejects.toThrow('automatic retry');
    await vi.advanceTimersByTimeAsync(50000);
    await failure;
    expect(client.ready).toBe(true);
  });
  it('redacts provider failures instead of displaying their arbitrary body', async () => {
    request.mockResolvedValueOnce(new Response('secret provider response', { status: 503 }));
    await expect(new ModelClient().transcribe(new Float32Array(16), 's')).rejects.toThrow(
      'Cloud transcription is unavailable',
    );
  });
});
