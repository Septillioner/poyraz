# Rate limit and logging

Both are off by default and configured per agent from the builder. A clean `AgentBuilder()` waits for nothing, writes no log file and changes no global state.

## Rate limit

```ts
import { AgentBuilder } from 'poyraz';

new AgentBuilder()
  .Provider(provider)
  .RateLimit({ enabled: true, maxWaits: 3, fallbackDelayMs: 20_000, maxDelayMs: 120_000, maxTotalWaitMs: 300_000 })
  .Build();
```

`RateLimit(config | boolean = true)`; `RateLimit()` is `{ enabled: true }`. The same section is `rateLimit` in `FromJSON` / templates.

| Field | Meaning | If omitted |
| --- | --- | --- |
| `enabled` | Wait and retry on a TPM/RPM rejection (429) | Off. Anything other than `true` is off, whatever the other fields say |
| `maxWaits` | Waits per request (a non-negative integer) | `3` (`DEFAULT_RATE_LIMIT_MAX_WAITS`) when enabled. `0` means no waiting |
| `fallbackDelayMs` | Wait when the provider reports no window | `20000` (`RATE_LIMIT_FALLBACK_DELAY_MS`) |
| `maxDelayMs` | Longest single wait; a longer window is cut to it | `600000` (`RATE_LIMIT_MAX_DELAY_MS`) |
| `maxTotalWaitMs` | Budget for all waits of one request together | Only `maxWaits` bounds it |

Invalid values (negative, `NaN`, non-numbers) are ignored and the default applies. `agent.getRateLimitConfig()` returns the resolved form (`ResolvedRateLimitConfig`); `resolveRateLimitConfig(config?)` does the same without an agent.

- **Disabled (the default)**: a 429 / TPM / RPM rejection is an error at once, the original error, with no wait and no retry.
- **Enabled**: on a rate-limit error the request waits for the window the provider reports (`x-ratelimit-reset-*`, `Retry-After`, "try again in ..."), or `fallbackDelayMs` when it reports none, and is sent again. A reported window is never shorter than 1 s; a configured `fallbackDelayMs` is used as given.
- **Bounded**: there is no unbounded waiting. Past `maxWaits`, or when the next wait would pass `maxTotalWaitMs` (it is refused up front, not waited out first), the call throws `RateLimitExceededError`.
- **Abort**: an aborted `signal` ends a wait at once (`ChatAbortedError`). Output that already streamed to the caller is never replayed, so a rate limit after output is an error.
- **Events**: each wait emits `rate_limit.wait` (`attempt`, `delayMs`, `retryAt`, `source: 'header' | 'message' | 'fallback'`, `reason`) and, when it ends, `rate_limit.resumed` (`attempt`) to `onEvent`. See [Streaming](streaming.md).

### RateLimitExceededError

```ts
import { RateLimitExceededError } from 'poyraz';

try {
  await agent.chat('...');
} catch (error) {
  if (error instanceof RateLimitExceededError) {
    error.reason;   // 'max-waits' | 'max-total-wait'
    error.waits;    // waits completed before giving up
    error.waitedMs; // time spent waiting
    error.status;   // copied from the provider error (429)
    error.cause;    // the original provider error
  }
}
```

`reason: 'max-waits'` means the limit was still active after `maxWaits` waits. `reason: 'max-total-wait'` means the next wait would have passed `maxTotalWaitMs`.

### Which providers wait

Waiting is implemented by `OpenAIProvider`, which serves OpenAI, OpenRouter, Groq and llama.cpp. `OllamaProvider` and the Gemini provider do not wait: with them a 429 is always an error, enabled or not.

The policy reaches the provider through `ChatOptions.rateLimit`. An agent hands it over only when `rateLimit.enabled` is on, so it also applies to a provider you built yourself with `Provider(...)`. A policy already on a call wins over the agent's.

Using the provider layer directly:

```ts
import { OpenAIProvider, createLLMProvider, withRateLimitPolicy, DISABLED_RATE_LIMIT } from 'poyraz';

const policy = { enabled: true, maxWaits: 2 }; // RateLimitPolicy

new OpenAIProvider(baseUrl, apiKey, headers, { rateLimit: policy }); // default for every call of this provider
createLLMProvider(profile, apiKey, { rateLimit: policy });            // CreateProviderOptions
withRateLimitPolicy(anyProvider, policy);                              // wraps any LLMProvider: each chat() carries the policy
// DISABLED_RATE_LIMIT is the frozen "no waiting" policy providers use when none is given
```

`withRateLimitRetry(options, attempt)` is the helper behind it. Without `options.rateLimit` it uses a bounded default of 3 waits (never unbounded); providers always pass a policy, which is `DISABLED_RATE_LIMIT` unless configured.

## Logging

```ts
import { AgentBuilder, LogLevel } from 'poyraz';

new AgentBuilder()
  .Provider(provider)
  .Logging({ level: LogLevel.INFO, file: { enabled: true, logDir: '.poyraz/log' }, chatDebugLog: true, source: 'worker-3' })
  .Build();
```

| Field | Meaning | If omitted |
| --- | --- | --- |
| `level` | Minimum level of this agent's logger (`LogLevel.DEBUG` ... `ERROR`) | `INFO`. `logLevel` / `LogLevel(level)` on the builder is a legacy alias |
| `file` | `{ enabled, logDir }`: this agent's `agent.log` | No file; nothing is written |
| `chatDebugLog` | One JSON file per chat turn | Off |
| `source` | Free-text origin tag stored in the chat debug log (`'cli'`, `'http'`, `'worker-3'`, ...) | Left out of the file |

Shortcuts: `FileLogging(file)`, `ChatDebugLog(enabled = true)`, `LogSource(source)`, `LogLevel(level)`.

- **Per agent**: `level` and `file` belong to that agent's own logger (`createLogger`). An agent never changes the level or the file of the shared `logger`, and never calls `configureFileLogging`. The file is written only when `file.enabled` is true and `logDir` is set.
- **Scoped, not global**: everything logged through the shared `logger` while the agent runs `chat`, `init`, `summarize`, `connectMcp` or `disconnectMcp` (decision loop, tools, providers) goes to that agent's logger, with its level and file. The scope follows the call across `await`s, so concurrent agents stay separate. `ToolContext.logger` is the agent's own logger.
- **Outside an agent call** the shared `logger` keeps its own level and file. It is silent until the host calls `configureFileLogging({ enabled: true, logDir })` or `logger.setLevel(...)`, which are process-wide and remain available.
- **Chat debug log**: written only when `chatDebugLog` is `true`, into the agent's log dir (`<logDir>/<yyyy-mm-dd>/<session>-<hhmmss>.json`). Without an agent file it falls back to the process-wide dir of `configureFileLogging`; with neither, nothing is written. There is no default `source`.

Your own loggers and scopes:

```ts
import { createLogger, runWithLogger, scopeToLogger, logger, LogLevel } from 'poyraz';

const own = createLogger({ level: LogLevel.DEBUG, file: { enabled: true, logDir: './log' } }); // LoggerOptions
await own.info('goes to ./log/agent.log only');

// Everything logged through the shared `logger` inside fn goes to `own` meanwhile (also across awaits):
await runWithLogger(own, async () => {
  await logger.warn('ends up in own');
});

const scoped = scopeToLogger(own, async (id: string) => { /* same, as a wrapped function */ });
```

An instance from `createLogger` is never redirected by a scope; only the shared `logger` follows it.
