import { ChatAbortedError, assertNotAborted } from '../../shared/chat-aborted.js';
import { logger } from '../../shared/logger.js';
import type { RateLimitDelaySource, RateLimitNotice, RateLimitWait } from '../../domain/llm.js';

const HTTP_TOO_MANY_REQUESTS = 429;

const RATE_LIMIT_ERROR_NAME = 'RateLimitError';
const RATE_LIMIT_ERROR_TYPE = 'rate_limit_error';
const RATE_LIMIT_ERROR_CODE = 'rate_limit_exceeded';
const RATE_LIMIT_MESSAGE =
  /rate[ _-]?limit|too many requests|tokens? per (?:min|minute)|requests? per (?:min|minute)|\bTPM\b|\bRPM\b|quota exceeded|resource exhausted/i;
const TOKEN_WINDOW = /tokens? per (?:min|minute)|\bTPM\b/i;
const REQUEST_WINDOW = /requests? per (?:min|minute)|\bRPM\b/i;
const TRY_AGAIN_IN = /try again in\s+([0-9]+(?:\.[0-9]+)?\s*[a-z]*)/i;

const TOKEN_WINDOW_LABEL = 'tokens per min (TPM)';
const REQUEST_WINDOW_LABEL = 'requests per min (RPM)';
const GENERIC_LABEL = 'rate limit';

const TOKEN_RESET_HEADER = 'x-ratelimit-reset-tokens';
const REQUEST_RESET_HEADER = 'x-ratelimit-reset-requests';
const RETRY_AFTER_MS_HEADER = 'retry-after-ms';
const RETRY_AFTER_HEADER = 'retry-after';

const DURATION_UNITS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
const DURATION_PART = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
const PLAIN_SECONDS = /^\d+(?:\.\d+)?$/;

/** Wait used when the provider does not say when to come back. */
export const RATE_LIMIT_FALLBACK_DELAY_MS = 20_000;
/** Never come back faster than this, even when the header asks for less. */
export const RATE_LIMIT_MIN_DELAY_MS = 1_000;
/**
 * Longest single wait. A longer wait is split into several attempts, so a
 * provider asking for a very long window still comes back and re-checks.
 */
export const RATE_LIMIT_MAX_DELAY_MS = 600_000;

export interface RateLimitDelay {
  delayMs: number;
  source: RateLimitDelaySource;
}

export interface RateLimitRetryOptions {
  model?: string;
  signal?: AbortSignal;
  onRateLimit?: (notice: RateLimitNotice) => void;
  /** Fixed wait used when the provider recommends nothing. */
  fallbackDelayMs?: number;
}

type HeaderLookup = (name: string) => string | null | undefined;

function messageOf(error: unknown): string {
  const err = error as { message?: unknown; error?: { message?: unknown } } | null | undefined;
  return [err?.message, err?.error?.message]
    .filter((part): part is string => typeof part === 'string')
    .join(' ');
}

function headerLookup(error: unknown): HeaderLookup {
  const headers = (error as { headers?: unknown } | null | undefined)?.headers;
  if (!headers || typeof headers !== 'object') return () => undefined;
  const bag = headers as Record<string, unknown>;
  // The SDK exposes a `Headers` instance; other clients pass a plain object.
  if (typeof bag.get === 'function') {
    const get = bag.get as (name: string) => string | null;
    return (name) => get.call(headers, name);
  }
  return (name) => {
    const key = Object.keys(bag).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    return key === undefined ? undefined : String(bag[key]);
  };
}

export function isAbortError(error: unknown): boolean {
  const name = (error as { name?: string } | null | undefined)?.name;
  return name === 'AbortError' || name === 'APIUserAbortError';
}

/** True for the TPM/RPM rejections a long turn can hit mid-flight. */
export function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if (isAbortError(error)) return false;

  const err = error as {
    status?: number;
    statusCode?: number;
    name?: string;
    type?: string;
    code?: unknown;
    error?: { type?: string; code?: unknown };
  };
  if ((err.status ?? err.statusCode) === HTTP_TOO_MANY_REQUESTS) return true;
  if (err.name === RATE_LIMIT_ERROR_NAME) return true;
  if (err.type === RATE_LIMIT_ERROR_TYPE || err.error?.type === RATE_LIMIT_ERROR_TYPE) return true;
  if (err.code === RATE_LIMIT_ERROR_CODE || err.error?.code === RATE_LIMIT_ERROR_CODE) return true;
  return RATE_LIMIT_MESSAGE.test(messageOf(error));
}

/** Short label for the limit that tripped, used in logs and the UI. */
export function rateLimitReason(error: unknown): string {
  const message = messageOf(error);
  if (TOKEN_WINDOW.test(message)) return TOKEN_WINDOW_LABEL;
  if (REQUEST_WINDOW.test(message)) return REQUEST_WINDOW_LABEL;
  return GENERIC_LABEL;
}


/**
 * Parse the window styles providers use: `6m0s`, `1.5s`, `100ms`, `1h2m3s`.
 * A bare number is seconds, which is how `Retry-After` is written.
 */
export function parseDurationMs(raw: string | null | undefined): number | undefined {
  const value = raw?.trim().toLowerCase();
  if (!value) return undefined;
  if (PLAIN_SECONDS.test(value)) return Number(value) * 1_000;

  DURATION_PART.lastIndex = 0;
  let total = 0;
  let consumed = 0;
  let match: RegExpExecArray | null;
  while ((match = DURATION_PART.exec(value)) !== null) {
    total += Number(match[1]) * (DURATION_UNITS[match[2]] ?? 0);
    consumed += match[0].length;
  }
  if (consumed !== value.length || total <= 0) return undefined;
  return total;
}

/** `Retry-After` is either a delay or an HTTP date to come back at. */
function parseRetryAfterMs(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const duration = parseDurationMs(raw);
  if (duration !== undefined) return duration;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/** `retry-after-ms` is already milliseconds, so a bare number is not seconds. */
function parseMilliseconds(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw.trim());
  return Number.isFinite(value) ? value : parseDurationMs(raw);
}

function clampDelay(delayMs: number): number {
  if (!Number.isFinite(delayMs)) return RATE_LIMIT_FALLBACK_DELAY_MS;
  return Math.min(RATE_LIMIT_MAX_DELAY_MS, Math.max(RATE_LIMIT_MIN_DELAY_MS, Math.round(delayMs)));
}

/**
 * How long to wait before repeating a rate-limited request: the window the
 * provider reported, or a fixed delay when it reported nothing usable.
 */
export function resolveRateLimitDelay(
  error: unknown,
  fallbackMs: number = RATE_LIMIT_FALLBACK_DELAY_MS
): RateLimitDelay {
  const read = headerLookup(error);
  const message = messageOf(error);
  const tokenWindow = parseDurationMs(read(TOKEN_RESET_HEADER));
  const requestWindow = parseDurationMs(read(REQUEST_RESET_HEADER));

  // The limit that tripped decides which window to wait for. Without that hint,
  // take the longer window so the retry is not rejected the same way again.
  let suggested: number | undefined;
  let source: RateLimitDelaySource = 'header';
  if (TOKEN_WINDOW.test(message) && tokenWindow !== undefined) {
    suggested = tokenWindow;
  } else if (REQUEST_WINDOW.test(message) && requestWindow !== undefined) {
    suggested = requestWindow;
  } else if (tokenWindow !== undefined || requestWindow !== undefined) {
    suggested = Math.max(tokenWindow ?? 0, requestWindow ?? 0);
  }

  suggested ??= parseMilliseconds(read(RETRY_AFTER_MS_HEADER));
  suggested ??= parseRetryAfterMs(read(RETRY_AFTER_HEADER));

  if (suggested === undefined) {
    suggested = parseDurationMs(TRY_AGAIN_IN.exec(message)?.[1]);
    if (suggested !== undefined) source = 'message';
  }
  if (suggested === undefined) {
    suggested = fallbackMs;
    source = 'fallback';
  }

  return { delayMs: clampDelay(suggested), source };
}

/** Abortable wait, so a rate-limited turn still stops the moment the user asks. */
export function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  assertNotAborted(signal);
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    function cleanup() {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    function onAbort() {
      cleanup();
      reject(new ChatAbortedError());
    }

    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Runs a provider request and survives rate limits: on a TPM/RPM rejection it
 * waits for the reported window (or a fixed fallback) and sends the same request
 * again instead of ending the turn. `markEmitted` locks the retry out once any
 * output reached the caller, because replaying it would duplicate the stream.
 */
export async function withRateLimitRetry<T>(
  options: RateLimitRetryOptions,
  attempt: (markEmitted: () => void) => Promise<T>
): Promise<T> {
  let emitted = false;
  let waits = 0;

  for (;;) {
    try {
      return await attempt(() => {
        emitted = true;
      });
    } catch (error) {
      if (options.signal?.aborted || isAbortError(error)) throw new ChatAbortedError();
      if (!isRateLimitError(error) || emitted) throw error;

      waits++;
      const { delayMs, source } = resolveRateLimitDelay(error, options.fallbackDelayMs);
      const wait: RateLimitWait = {
        attempt: waits,
        delayMs,
        retryAt: Date.now() + delayMs,
        source,
        reason: rateLimitReason(error),
      };
      logger.warn('Rate limit reached; waiting before retrying the request', {
        model: options.model,
        ...wait,
        message: error instanceof Error ? error.message : String(error),
      });
      options.onRateLimit?.({ kind: 'wait', ...wait });
      await sleepWithSignal(delayMs, options.signal);
      options.onRateLimit?.({ kind: 'resumed', attempt: waits });
    }
  }
}
