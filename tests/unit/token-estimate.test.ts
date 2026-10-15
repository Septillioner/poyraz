import { describe, expect, it } from 'vitest';
import {
  createTokenEstimator,
  DEFAULT_CHARS_PER_TOKEN,
  DEFAULT_MESSAGE_OVERHEAD_TOKENS,
  MAX_CHARS_PER_TOKEN,
} from '../../application/context/token-estimate.js';

describe('token estimator', () => {
  it('uses chars / ratio rounded up and has sane defaults', () => {
    const estimator = createTokenEstimator();
    expect(estimator.charsPerToken).toBe(DEFAULT_CHARS_PER_TOKEN);
    expect(estimator.messageOverheadTokens).toBe(DEFAULT_MESSAGE_OVERHEAD_TOKENS);
    expect(estimator.estimateText('')).toBe(0);
    expect(estimator.estimateText('a'.repeat(7))).toBe(2);
    expect(estimator.tokensForChars(0)).toBe(0);
    expect(estimator.tokensForChars(-5)).toBe(0);
  });

  it('accepts a custom ratio and ignores invalid ones', () => {
    expect(createTokenEstimator({ charsPerToken: 4 }).estimateText('a'.repeat(8))).toBe(2);
    expect(createTokenEstimator({ charsPerToken: -1 }).charsPerToken).toBe(DEFAULT_CHARS_PER_TOKEN);
    expect(createTokenEstimator({ charsPerToken: Number.NaN }).charsPerToken).toBe(DEFAULT_CHARS_PER_TOKEN);
    expect(createTokenEstimator({ charsPerToken: 100 }).charsPerToken).toBe(MAX_CHARS_PER_TOKEN);
  });

  it('calibrates toward the ratio implied by real usage', () => {
    const estimator = createTokenEstimator({ charsPerToken: 4 });
    // 1000 chars + 10 overhead really cost 210 tokens -> content ratio 5.
    const next = estimator.calibrate({ chars: 1000, overheadTokens: 10, realTokens: 210 }, 1);
    expect(next).toBeCloseTo(5, 5);
    expect(estimator.charsPerToken).toBeCloseTo(5, 5);
    expect(estimator.tokensForChars(1000)).toBe(200);
  });

  it('blends calibration with the previous ratio by weight and ignores empty samples', () => {
    const estimator = createTokenEstimator({ charsPerToken: 4 });
    estimator.calibrate({ chars: 600, realTokens: 100 }, 0.5); // implied 6 -> 5
    expect(estimator.charsPerToken).toBeCloseTo(5, 5);
    estimator.calibrate({ chars: 0, realTokens: 100 });
    estimator.calibrate({ chars: 100, realTokens: 0 });
    estimator.calibrate({ chars: 100, overheadTokens: 50, realTokens: 40 });
    expect(estimator.charsPerToken).toBeCloseTo(5, 5);
  });
});
