import { describe, expect, it } from 'vitest';
import { calculateTokenCost, isTokenPricing } from '../../domain/llm.js';

describe('token cost calculation', () => {
  const pricing = { input: 0.01, cache: 0.002, output: 0.03 };

  it('charges cached prompt tokens once at the cache price', () => {
    const cost = calculateTokenCost(
      { promptTokens: 1_000, cachedTokens: 400, completionTokens: 100, totalTokens: 1_100 },
      pricing
    );

    expect(cost).toMatchObject({
      inputTokens: 600,
      cacheTokens: 400,
      outputTokens: 100,
      inputCost: 6,
      cacheCost: 0.8,
      outputCost: 3,
      totalCost: 9.8,
    });
  });

  it('does not trust totalTokens and clamps impossible cached usage to prompt usage', () => {
    const cost = calculateTokenCost(
      { promptTokens: 10, cachedTokens: 50, completionTokens: 4, totalTokens: 9_999 },
      pricing
    );

    expect(cost).toMatchObject({ inputTokens: 0, cacheTokens: 10, outputTokens: 4 });
    expect(cost.totalCost).toBeCloseTo(0.14);
  });

  it('accepts only complete non-negative price tables', () => {
    expect(isTokenPricing(pricing)).toBe(true);
    expect(isTokenPricing({ input: 0.01, cache: -1, output: 0.03 })).toBe(false);
    expect(isTokenPricing({ input: 0.01, output: 0.03 })).toBe(false);
  });
});
