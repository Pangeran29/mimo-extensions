// Evaluation policy only. Adapted from OpenAI Whisper's compression-ratio
// fallback concept; deliberately bounded to two retries. Not a confidence score.
import { compressionRatio } from './whisper-debug-metrics.mjs';
export const FALLBACK_POLICY = Object.freeze({
  compressionThreshold: 2.4,
  temperatures: [0.2, 0.4],
  maxRetries: 2,
});

export function assessDecode(output) {
  if (output.result?.type !== 'RESULT') throw Error('Recognition did not return RESULT');
  const generation = output.generations?.find((x) => x.kind === 'generation');
  if (!generation?.tokens?.length || !generation.prefixTokens)
    throw Error('Missing generation evidence');
  const eos = generation.config.eos_token_id;
  const eosIds = Array.isArray(eos) ? eos : [eos];
  if (
    !eosIds.length ||
    !eosIds.every(Number.isSafeInteger) ||
    !Number.isSafeInteger(generation.config.max_new_tokens)
  )
    throw Error('Incomplete generation configuration');
  const ended = eosIds.includes(generation.tokens.at(-1));
  const generated = generation.tokens.length - generation.prefixTokens.length;
  const ratio = compressionRatio(output.result.text);
  const reasons = [];
  if (ratio > FALLBACK_POLICY.compressionThreshold) reasons.push('repetition');
  if (!ended && generated >= generation.config.max_new_tokens)
    reasons.push('token-limit-without-eos');
  return { compressionRatio: ratio, generated, ended, reasons, flagged: reasons.length > 0 };
}

export async function decodeWithFallback(decode, seed) {
  const attempts = [];
  const first = await decode({}, seed);
  attempts.push({ ...first, assessment: assessDecode(first), overrides: {} });
  if (!attempts[0].assessment.flagged) return { attempts, selected: 0, unresolved: false };
  const language = first.result.language;
  for (let i = 0; i < FALLBACK_POLICY.maxRetries; i++) {
    // Preserve the initially detected language, audio, model and token allowance.
    const overrides = {
      language,
      do_sample: true,
      temperature: FALLBACK_POLICY.temperatures[i],
      top_k: 0,
    };
    try {
      const output = await decode(overrides, (seed + i + 1) >>> 0);
      const assessment = assessDecode(output);
      attempts.push({ ...output, assessment, overrides });
      if (!assessment.flagged)
        return { attempts, selected: attempts.length - 1, unresolved: false };
    } catch (error) {
      attempts.push({ overrides, error: String(error) });
    }
  }
  // Structural failure is not permission to invent text or silently discard it.
  return { attempts, selected: 0, unresolved: true };
}
