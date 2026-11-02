// Runs in the evaluation offscreen document before the first TRANSCRIBE.
// Copy bytes before the production transfer detaches the original ArrayBuffer.
(() => {
  const nativePost = Worker.prototype.postMessage;
  const observed = new WeakSet();
  let windows = 0;
  Worker.prototype.postMessage = function (message, ...rest) {
    if (message?.type === 'TRANSCRIBE' && message.audio instanceof Float32Array) {
      if (!observed.has(this)) {
        observed.add(this);
        this.addEventListener('message', ({ data }) => {
          if (data?.type === 'ASR_DEBUG') globalThis.listenAsrDebug(JSON.stringify(data.detail));
          else if (data?.type === 'RESULT' || data?.type === 'ERROR')
            globalThis.listenAsrDebug(JSON.stringify({ kind: 'result', ...data }));
        });
      }
      if (++windows <= 8) {
        const bytes = new Uint8Array(
          message.audio.buffer,
          message.audio.byteOffset,
          message.audio.byteLength,
        );
        let binary = '';
        for (let i = 0; i < bytes.length; i += 8192)
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        globalThis.listenAsrDebug(
          JSON.stringify({
            kind: 'input',
            requestId: message.requestId,
            sessionId: message.sessionId,
            sampleRate: 16000,
            format: 'float32-le',
            audio: btoa(binary),
            at: performance.timeOrigin + performance.now(),
          }),
        );
      }
    }
    return nativePost.call(this, message, ...rest);
  };
})();
