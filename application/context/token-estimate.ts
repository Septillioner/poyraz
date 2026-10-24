/**
 * Dependency-free local token estimator: characters / charsPerToken, plus a fixed
 * framing cost per message. `calibrate()` nudges the ratio toward provider-reported
 * usage so the estimate follows the real tokenizer over time.
 */

export const DEFAULT_CHARS_PER_TOKEN = 3.5;
export const DEFAULT_MESSAGE_OVERHEAD_TOKENS = 4;
export const MIN_CHARS_PER_TOKEN = 1;
export const MAX_CHARS_PER_TOKEN = 8;

export interface TokenEstimatorOptions {
  charsPerToken?: number;
  messageOverheadTokens?: number;
}

export interface CalibrationSample {
  /** Characters the estimate was computed from (excluding framing overhead). */
  chars: number;
  /** Non-text tokens (framing and estimated images) that were part of the estimate. */
  overheadTokens?: number;
  /** Provider-reported prompt tokens for the same request. */
  realTokens: number;
}

export interface TokenEstimator {
  readonly charsPerToken: number;
  readonly messageOverheadTokens: number;
  estimateText(text: string): number;
  tokensForChars(chars: number): number;
  /**
   * Moves `charsPerToken` toward the ratio implied by the sample (exponential
   * moving average, default weight 0.5) and returns the new ratio. Ignored for
   * samples without chars or real tokens.
   */
  calibrate(sample: CalibrationSample, weight?: number): number;
}

function sanitizeRatio(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_CHARS_PER_TOKEN;
  return Math.min(MAX_CHARS_PER_TOKEN, Math.max(MIN_CHARS_PER_TOKEN, value));
}

export function createTokenEstimator(options: TokenEstimatorOptions = {}): TokenEstimator {
  let ratio = sanitizeRatio(options.charsPerToken);
  const overhead =
    typeof options.messageOverheadTokens === 'number' &&
    Number.isFinite(options.messageOverheadTokens) &&
    options.messageOverheadTokens >= 0
      ? Math.round(options.messageOverheadTokens)
      : DEFAULT_MESSAGE_OVERHEAD_TOKENS;

  const tokensForChars = (chars: number): number => {
    if (!Number.isFinite(chars) || chars <= 0) return 0;
    return Math.ceil(chars / ratio);
  };

  return {
    get charsPerToken() {
      return ratio;
    },
    messageOverheadTokens: overhead,
    estimateText: (text: string) => tokensForChars(typeof text === 'string' ? text.length : 0),
    tokensForChars,
    calibrate(sample, weight = 0.5) {
      const content = sample.realTokens - (sample.overheadTokens ?? 0);
      if (!Number.isFinite(sample.chars) || sample.chars <= 0) return ratio;
      if (!Number.isFinite(content) || content <= 0) return ratio;
      const w = Number.isFinite(weight) ? Math.min(1, Math.max(0, weight)) : 0.5;
      ratio = sanitizeRatio(ratio * (1 - w) + (sample.chars / content) * w);
      return ratio;
    },
  };
}
