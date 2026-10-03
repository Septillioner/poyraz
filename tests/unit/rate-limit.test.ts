import { describe, expect, it } from 'vitest';
import {
  isAbortError,
  isRateLimitError,
  parseDurationMs,
  rateLimitReason,
  resolveRateLimitDelay,
  sleepWithSignal,
  withRateLimitRetry,
  RATE_LIMIT_FALLBACK_DELAY_MS,
  RATE_LIMIT_MAX_DELAY_MS,
  RATE_LIMIT_MIN_DELAY_MS,
} from '../../infrastructure/llm/rate-limit.js';
import { ChatAbortedError } from '../../shared/chat-aborted.js';
import type { RateLimitNotice } from '../../domain/llm.js';

function rateLimited(headers: Record<string, string>, message: string) {
  return Object.assign(new Error(message), { status: 429, headers });
}

const TPM_MESSAGE =
  'Rate limit reached for gpt-5 in organization org-1 on tokens per min (TPM): Limit 10000, Requested 15000.';
const RPM_MESSAGE =
  'Rate limit reached for gpt-5 in organization org-1 on requests per min (RPM): Limit 500, Requested 600.';

describe('parseDurationMs', () => {
  it('reads the window formats providers use', () => {
    expect(parseDurationMs('6m0s')).toBe(360_000);
    expect(parseDurationMs('1.5s')).toBe(1_500);
    expect(parseDurationMs('100ms')).toBe(100);
    expect(parseDurationMs('1h2m3s')).toBe(3_723_000);
  });

  it('treats a bare number as seconds', () => {
    expect(parseDurationMs('12')).toBe(12_000);
  });

  it('rejects anything it cannot read', () => {
    expect(parseDurationMs('soon')).toBeUndefined();
    expect(parseDurationMs('')).toBeUndefined();
    expect(parseDurationMs(undefined)).toBeUndefined();
  });
});

describe('isRateLimitError', () => {
  it('accepts 429 responses', () => {
    expect(isRateLimitError(rateLimited({}, TPM_MESSAGE))).toBe(true);
    expect(isRateLimitError({ statusCode: 429, message: 'nope' })).toBe(true);
  });

  it('accepts the SDK shapes and the TPM/RPM wording', () => {
    expect(isRateLimitError({ name: 'RateLimitError' })).toBe(true);
    expect(isRateLimitError({ type: 'rate_limit_error' })).toBe(true);
    expect(isRateLimitError({ error: { type: 'rate_limit_error' } })).toBe(true);
    expect(isRateLimitError(new Error(RPM_MESSAGE))).toBe(true);
    expect(isRateLimitError(new Error('Rate limit reached'))).toBe(true);
  });

  it('leaves aborts and unrelated failures alone', () => {
    const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(isAbortError(aborted)).toBe(true);
    expect(isRateLimitError(aborted)).toBe(false);
    expect(isRateLimitError({ status: 500, message: 'internal' })).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
  });

describe('resolveRateLimitDelay', () => {
  it('waits for the token window when the tokens limit tripped', () => {
    const error = rateLimited(
      { 'x-ratelimit-reset-tokens': '6m0s', 'x-ratelimit-reset-requests': '1s' },
      TPM_MESSAGE
    );
    expect(resolveRateLimitDelay(error)).toEqual({ delayMs: 360_000, source: 'header' });
  });

  it('waits for the request window when the requests limit tripped', () => {
    const error = rateLimited(
      { 'x-ratelimit-reset-tokens': '6m0s', 'x-ratelimit-reset-requests': '1s' },
      RPM_MESSAGE
    );
    expect(resolveRateLimitDelay(error)).toEqual({ delayMs: 1_000, source: 'header' });
  });

  it('takes the longer window when the message does not say which limit tripped', () => {
    const error = rateLimited(
      { 'x-ratelimit-reset-tokens': '250ms', 'x-ratelimit-reset-requests': '8s' },
      'Rate limit reached'
    );
    expect(resolveRateLimitDelay(error)).toEqual({ delayMs: 8_000, source: 'header' });
  });

  it('falls back to Retry-After, then to the wait in the message', () => {
    expect(resolveRateLimitDelay(rateLimited({ 'retry-after-ms': '2500' }, 'Rate limit reached'))).toEqual({
      delayMs: 2_500,
      source: 'header',
    });
    expect(resolveRateLimitDelay(rateLimited({ 'retry-after': '7' }, 'Rate limit reached'))).toEqual({
      delayMs: 7_000,
      source: 'header',
    });
    expect(resolveRateLimitDelay(rateLimited({}, 'Please try again in 12.5s.'))).toEqual({
      delayMs: 12_500,
      source: 'message',
    });
  });

  it('uses a fixed delay when the provider recommends nothing', () => {
    expect(resolveRateLimitDelay(rateLimited({}, 'Rate limit reached'))).toEqual({
      delayMs: RATE_LIMIT_FALLBACK_DELAY_MS,
      source: 'fallback',
    });
  });

  it('keeps the wait inside sane bounds', () => {
    expect(resolveRateLimitDelay(rateLimited({ 'retry-after-ms': '10' }, 'x')).delayMs).toBe(
      RATE_LIMIT_MIN_DELAY_MS
    );
    expect(resolveRateLimitDelay(rateLimited({ 'retry-after-ms': '9999999' }, 'x')).delayMs).toBe(
      RATE_LIMIT_MAX_DELAY_MS
    );
  });

  it('reads headers from a Headers instance as the SDK provides them', () => {
    const headers = new Headers({ 'x-ratelimit-reset-tokens': '4s' });
    const error = Object.assign(new Error(TPM_MESSAGE), { status: 429, headers });
    expect(resolveRateLimitDelay(error)).toEqual({ delayMs: 4_000, source: 'header' });
  });
});

describe('sleepWithSignal', () => {
  it('resolves after the wait', async () => {
    const started = Date.now();
    await sleepWithSignal(20);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });

  it('rejects with a chat abort when the turn is stopped mid-wait', async () => {
    const controller = new AbortController();
    const pending = sleepWithSignal(5_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(ChatAbortedError);
  });

  it('rejects immediately for an already aborted signal', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => sleepWithSignal(5_000, controller.signal)).toThrow(ChatAbortedError);
  });
});

describe('withRateLimitRetry', () => {
  it('retries a rate-limited request instead of failing the turn', async () => {
    const notices: RateLimitNotice[] = [];
    let attempts = 0;

    const result = await withRateLimitRetry(
      { model: 'gpt-5', fallbackDelayMs: 1, onRateLimit: (notice) => notices.push(notice) },
      async () => {
        attempts++;
        if (attempts < 3) throw rateLimited({}, TPM_MESSAGE);
        return 'done';
      }
    );

    expect(result).toBe('done');
    expect(attempts).toBe(3);
    expect(notices.map((notice) => notice.kind)).toEqual(['wait', 'resumed', 'wait', 'resumed']);
    const wait = notices[0] as Extract<RateLimitNotice, { kind: 'wait' }>;
    expect(wait.attempt).toBe(1);
    expect(wait.source).toBe('fallback');
    expect(wait.reason).toBe('tokens per min (TPM)');
    expect(wait.retryAt).toBeGreaterThan(0);
  });

  it('never retries once output already reached the caller', async () => {
    let attempts = 0;

    await expect(
      withRateLimitRetry({ model: 'gpt-5' }, async (markEmitted) => {
        attempts++;
        markEmitted();
        throw rateLimited({ 'retry-after-ms': '10' }, TPM_MESSAGE);
      })
    ).rejects.toMatchObject({ status: 429 });
    expect(attempts).toBe(1);
  });

  it('lets unrelated failures through untouched', async () => {
    let attempts = 0;
    await expect(
      withRateLimitRetry({}, async () => {
        attempts++;
        throw Object.assign(new Error('boom'), { status: 500 });
      })
    ).rejects.toMatchObject({ message: 'boom' });
    expect(attempts).toBe(1);
  });

  it('stops waiting as soon as the turn is aborted', async () => {
    const controller = new AbortController();
    let attempts = 0;

    const pending = withRateLimitRetry({ signal: controller.signal }, async () => {
      attempts++;
      if (attempts > 1) return 'unreachable';
      // Abort while the provider would otherwise wait out a long window.
      controller.abort();
      throw rateLimited({ 'retry-after-ms': '60000' }, TPM_MESSAGE);
    });

    await expect(pending).rejects.toBeInstanceOf(ChatAbortedError);
    expect(attempts).toBe(1);
  });

  it('really waits the reported window before retrying', async () => {
    let attempts = 0;
    const started = Date.now();

    await withRateLimitRetry({}, async () => {
      attempts++;
      if (attempts === 1) throw rateLimited({ 'retry-after-ms': '1000' }, TPM_MESSAGE);
      return 'done';
    });

    expect(attempts).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });
});

});

describe('rateLimitReason', () => {
  it('names the window that tripped', () => {
    expect(rateLimitReason(rateLimited({}, TPM_MESSAGE))).toBe('tokens per min (TPM)');
    expect(rateLimitReason(rateLimited({}, RPM_MESSAGE))).toBe('requests per min (RPM)');
    expect(rateLimitReason(rateLimited({}, 'Rate limit reached'))).toBe('rate limit');
  });
});
