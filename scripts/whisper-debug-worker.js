// Appended ONLY to an isolated evaluation copy of the production worker.
// Keep original audio, decoding options, return tensors and response validation.
{
  const originalHandler = self.onmessage;
  let hooked = false;
  let active = null;
  let overrides = {};
  self.onmessage = async (event) => {
    if (event.data.type === 'TRANSCRIBE') {
      let instance;
      try {
        instance = await prepare();
      } catch {
        return originalHandler(event); // Preserve production ERROR reporting.
      }
      active = { requestId: event.data.requestId, sessionId: event.data.sessionId };
      overrides = Object.fromEntries(
        Object.entries(event.data.debugOverrides || {}).filter(([key]) =>
          [
            'language',
            'max_new_tokens',
            'no_repeat_ngram_size',
            'do_sample',
            'temperature',
            'top_k',
          ].includes(key),
        ),
      );
      if (!hooked) {
        hooked = true;
        const generate = instance.model.generate.bind(instance.model);
        instance.model.generate = async (options) => {
          if (Object.keys(overrides).length) options = { ...options, ...overrides };
          const result = await generate(options);
          try {
            const tokens = result.tolist()[0].map(Number);
            const { inputs, generation_config, ...kwargs } = options;
            const config = instance.model._prepare_generation_config(generation_config, kwargs);
            self.postMessage({
              type: 'ASR_DEBUG',
              detail: {
                kind: 'generation',
                ...active,
                tokens,
                decoded: instance.tokenizer.decode(tokens, { skip_special_tokens: false }),
                config: Object.fromEntries(
                  [
                    'language',
                    'task',
                    'max_new_tokens',
                    'num_beams',
                    'do_sample',
                    'temperature',
                    'top_k',
                    'repetition_penalty',
                    'no_repeat_ngram_size',
                    'eos_token_id',
                    'decoder_start_token_id',
                  ].map((key) => [key, config[key]]),
                ),
                prefixTokens: instance.model._retrieve_init_tokens(config),
              },
            });
          } catch (error) {
            self.postMessage({
              type: 'ASR_DEBUG',
              detail: { kind: 'observer-error', ...active, error: String(error) },
            });
          }
          return result;
        };
      }
    }
    // Repeatable sampling is evaluation-only. Restore the native RNG after each
    // request; normal production and unseeded diagnostic calls are unaffected.
    const random = Math.random;
    if (Number.isSafeInteger(event.data.debugSeed)) {
      let state = event.data.debugSeed >>> 0;
      Math.random = () => {
        state += 0x6d2b79f5;
        let x = Math.imul(state ^ (state >>> 15), 1 | state);
        x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
      };
    }
    try {
      return await originalHandler(event);
    } finally {
      Math.random = random;
    }
  };
}
