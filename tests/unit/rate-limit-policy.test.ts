import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LLMProvider, RateLimitNotice, RateLimitPolicy } from '../../domain/llm.js';
import { OpenAIProvider } from '../../infrastructure/llm/providers.js';
import {
  DISABLED_RATE_LIMIT,
  RATE_LIMIT_DEFAULT_MAX_WAITS,
  RateLimitExceededError,
  resolveRateLimitDelay,
  withRateLimitPolicy,
  withRateLimitRetry,
} from '../../infrastructure/llm/rate-limit.js';
import { ChatAbortedError } from '../../shared/chat-aborted.js';

function rateLimited(headers: Record<string, string> = {}, message = 'Rate limit reached') {
  return Object.assign(new Error(message), { status: 429, headers });
}

/** Fails `failures` times with a 429, then answers. Counts attempts. */
function flaky(failures: number, headers: Record<string, string> = {}) {
  const state = { attempts: 0 };
  const attempt = async () => {
    state.attempts++;
    if (state.attempts <= failures) throw rateLimited(headers);
    return 'done';
  };
  return { state, attempt };
}

describe('withRateLimitRetry policy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('disabled policy: the first 429 is rethrown untouched, no wait, no retry, no timer', async () => {
    const { state, attempt } = flaky(5, { 'retry-after-ms': '60000' });
    const error = await withRateLimitRetry({ rateLimit: DISABLED_RATE_LIMIT }, attempt).catch((e) => e);

    expect(state.attempts).toBe(1);
    expect(error).toMatchObject({ status: 429, message: 'Rate limit reached' });
    expect(error).not.toBeInstanceOf(RateLimitExceededError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('enabled with maxWaits 0 behaves as disabled', async () => {
    const { state, attempt } = flaky(1);
    await expect(
      withRateLimitRetry({ rateLimit: { enabled: true, maxWaits: 0 } }, attempt)
    ).rejects.toMatchObject({ status: 429 });
    expect(state.attempts).toBe(1);
  });

  it('a policy that is not enabled never waits, whatever maxWaits says', async () => {
    const { state, attempt } = flaky(1);
    await expect(
      withRateLimitRetry({ rateLimit: { enabled: false, maxWaits: 9 } }, attempt)
    ).rejects.toMatchObject({ status: 429 });
    expect(state.attempts).toBe(1);
  });

  it('enabled: waits at most maxWaits times, then throws RateLimitExceededError', async () => {
    const { state, attempt } = flaky(Number.MAX_SAFE_INTEGER, { 'retry-after-ms': '2000' });
    const notices: RateLimitNotice[] = [];
    const pending = withRateLimitRetry(
      { rateLimit: { enabled: true, maxWaits: 2 }, onRateLimit: (n) => notices.push(n) },
      attempt
    );
    const assertion = expect(pending).rejects.toMatchObject({
      name: 'RateLimitExceededError',
      reason: 'max-waits',
      waits: 2,
      waitedMs: 4000,
      status: 429,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;

    expect(state.attempts).toBe(3); // first try + 2 waits
    expect(notices.map((n) => n.kind)).toEqual(['wait', 'resumed', 'wait', 'resumed']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the exceeded error names the limit and keeps the provider error as cause', async () => {
    const original = rateLimited({ 'retry-after-ms': '1000' }, 'Rate limit reached for gpt-5');
    const pending = withRateLimitRetry({ rateLimit: { enabled: true, maxWaits: 1 } }, async () => {
      throw original;
    });
    const assertion = pending.catch((e) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    const error = (await assertion) as RateLimitExceededError;

    expect(error).toBeInstanceOf(RateLimitExceededError);
    expect(error.cause).toBe(original);
    expect(error.message).toMatch(/after 1 wait\(s\).*maxWaits=1.*Rate limit reached for gpt-5/);
  });

  it('succeeds when the limit lifts within the budget', async () => {
    const { state, attempt } = flaky(2, { 'retry-after-ms': '1000' });
    const pending = withRateLimitRetry({ rateLimit: { enabled: true, maxWaits: 3 } }, attempt);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toBe('done');
    expect(state.attempts).toBe(3);
  });

  it('fallbackDelayMs is used when the provider reports no window, and is not raised to the 1s floor', async () => {
    const { attempt } = flaky(1);
    const notices: RateLimitNotice[] = [];
    const pending = withRateLimitRetry(
      { rateLimit: { enabled: true, maxWaits: 1, fallbackDelayMs: 40 }, onRateLimit: (n) => notices.push(n) },
      attempt
    );
    await vi.advanceTimersByTimeAsync(40);
    await expect(pending).resolves.toBe('done');
    expect(notices[0]).toMatchObject({ kind: 'wait', delayMs: 40, source: 'fallback' });
  });

  it('maxDelayMs caps a long provider window', async () => {
    const { attempt } = flaky(1, { 'retry-after-ms': '300000' });
    const notices: RateLimitNotice[] = [];
    const pending = withRateLimitRetry(
      { rateLimit: { enabled: true, maxWaits: 1, maxDelayMs: 1500 }, onRateLimit: (n) => notices.push(n) },
      attempt
    );
    await vi.advanceTimersByTimeAsync(1500);
    await expect(pending).resolves.toBe('done');
    expect(notices[0]).toMatchObject({ kind: 'wait', delayMs: 1500, source: 'header' });
    expect(resolveRateLimitDelay(rateLimited({ 'retry-after-ms': '300000' }), undefined, 1500).delayMs).toBe(1500);
  });

  it('maxTotalWaitMs: refuses a wait that would pass the budget, without waiting for it', async () => {
    const { state, attempt } = flaky(Number.MAX_SAFE_INTEGER, { 'retry-after-ms': '3000' });
    const pending = withRateLimitRetry(
      { rateLimit: { enabled: true, maxWaits: 10, maxTotalWaitMs: 7000 } },
      attempt
    );
    const assertion = expect(pending).rejects.toMatchObject({
      name: 'RateLimitExceededError',
      reason: 'max-total-wait',
      waits: 2,
      waitedMs: 6000,
    });
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    expect(state.attempts).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a total budget smaller than the first wait fails before any wait', async () => {
    const { state, attempt } = flaky(1, { 'retry-after-ms': '5000' });
    await expect(
      withRateLimitRetry({ rateLimit: { enabled: true, maxWaits: 3, maxTotalWaitMs: 1000 } }, attempt)
    ).rejects.toMatchObject({ reason: 'max-total-wait', waits: 0, waitedMs: 0 });
    expect(state.attempts).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an abort ends a wait at once as ChatAbortedError and stops retrying', async () => {
    const controller = new AbortController();
    const { state, attempt } = flaky(Number.MAX_SAFE_INTEGER, { 'retry-after-ms': '600000' });
    const pending = withRateLimitRetry(
      { rateLimit: { enabled: true, maxWaits: 5 }, signal: controller.signal },
      attempt
    );
    const assertion = expect(pending).rejects.toBeInstanceOf(ChatAbortedError);
    await vi.advanceTimersByTimeAsync(1_000); // inside the wait
    controller.abort();
    await assertion;
    expect(state.attempts).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('output that already reached the caller is never replayed, even when enabled', async () => {
    let attempts = 0;
    await expect(
      withRateLimitRetry({ rateLimit: { enabled: true, maxWaits: 3 } }, async (markEmitted) => {
        attempts++;
        markEmitted();
        throw rateLimited();
      })
    ).rejects.toMatchObject({ status: 429 });
    expect(attempts).toBe(1);
  });

  it('without a policy the helper is still bounded (default max waits), never unbounded', async () => {
    const { state, attempt } = flaky(Number.MAX_SAFE_INTEGER, { 'retry-after-ms': '1000' });
    const pending = withRateLimitRetry({}, attempt);
    const assertion = expect(pending).rejects.toBeInstanceOf(RateLimitExceededError);
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(state.attempts).toBe(RATE_LIMIT_DEFAULT_MAX_WAITS + 1);
  });
});

describe('withRateLimitPolicy', () => {
  function recorder() {
    const seen: Array<RateLimitPolicy | undefined> = [];
    const provider: LLMProvider = {
      async chat(options) {
        seen.push(options.rateLimit);
        return { content: 'ok' };
      },
    };
    return { seen, provider };
  }

  it('hands the policy to every call; a policy on the call itself wins', async () => {
    const { seen, provider } = recorder();
    const policy: RateLimitPolicy = { enabled: true, maxWaits: 2 };
    const wrapped = withRateLimitPolicy(provider, policy);

    await wrapped.chat({ model: 'm', messages: [] });
    const own: RateLimitPolicy = { enabled: false, maxWaits: 0 };
    await wrapped.chat({ model: 'm', messages: [], rateLimit: own });

    expect(seen[0]).toBe(policy);
    expect(seen[1]).toBe(own);
  });
});

describe('OpenAIProvider rate-limit policy', () => {
  function providerWith(options: ConstructorParameters<typeof OpenAIProvider>[3]) {
    const create = vi.fn(async () => {
      throw rateLimited({ 'retry-after-ms': '1000' }, 'Rate limit reached for gpt-5 on tokens per min (TPM)');
    });
    const provider = new OpenAIProvider('http://127.0.0.1:9/v1', 'k', undefined, { completionsOnly: true, ...options });
    (provider as unknown as { client: unknown }).client = { chat: { completions: { create } } };
    return { provider, create };
  }
  const request = { model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('by default a 429 is an error at once: one request, no timer', async () => {
    const { provider, create } = providerWith(undefined);
    await expect(provider.chat(request)).rejects.toMatchObject({ status: 429 });
    expect(create).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('with the constructor policy enabled it waits maxWaits times, then throws', async () => {
    const { provider, create } = providerWith({ rateLimit: { enabled: true, maxWaits: 2 } });
    const assertion = expect(provider.chat(request)).rejects.toBeInstanceOf(RateLimitExceededError);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('ChatOptions.rateLimit overrides the provider default per call', async () => {
    const { provider, create } = providerWith({ rateLimit: { enabled: true, maxWaits: 5 } });
    await expect(provider.chat({ ...request, rateLimit: DISABLED_RATE_LIMIT })).rejects.toMatchObject({ status: 429 });
    expect(create).toHaveBeenCalledTimes(1);
  });
});
