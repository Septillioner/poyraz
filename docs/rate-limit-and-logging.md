# Rate limit and logging

Both are off by default and configured per agent from the builder.

## Rate limit

```ts
new AgentBuilder()
  .Provider(provider)
  .RateLimit({ enabled: true, maxWaits: 3, fallbackDelayMs: 20_000, maxDelayMs: 120_000, maxTotalWaitMs: 300_000 })
  .Build();
```

- Disabled (the default): a 429 / TPM / RPM rejection is an error at once. No wait, no retry.
- Enabled: on a rate-limit error the request waits for the window the provider reports (`x-ratelimit-reset-*`, `Retry-After`, "try again in ..."), or `fallbackDelayMs` when it reports none, and is sent again.
- The waiting is always bounded. `maxWaits` (default 3 when enabled) caps the waits per request, `maxDelayMs` one wait, `maxTotalWaitMs` all waits together. Past a limit the call throws `RateLimitExceededError` (`reason: 'max-waits' | 'max-total-wait'`, the provider error is `cause`). A wait that would pass `maxTotalWaitMs` is refused up front.
- An aborted `signal` ends a wait at once (`ChatAbortedError`). Output that already streamed is never replayed.
- The policy travels to the provider in `ChatOptions.rateLimit`, so it also applies to a provider built elsewhere. Waiting is implemented by `OpenAIProvider` (OpenAI, OpenRouter, Groq, llama.cpp); Ollama and Gemini do not wait.
- Providers take it directly too: `new OpenAIProvider(url, key, headers, { rateLimit })`, `createLLMProvider(profile, key, { rateLimit })`.

## Logging

```ts
new AgentBuilder()
  .Provider(provider)
  .Logging({ level: LogLevel.INFO, file: { enabled: true, logDir: '.poyraz/log' }, chatDebugLog: true, source: 'worker-3' })
  .Build();
```

- Per agent: `level` and `file` belong to that agent's own logger (`createLogger`). An agent never changes the level or the file of the shared `logger` / `configureFileLogging`.
- Everything logged through the shared `logger` while the agent runs `chat`, `init`, `summarize` or MCP connect (tools, provider, decision loop) goes to that agent's logger. This is scoped per call, so concurrent agents stay separate.
- Outside an agent call the shared `logger` keeps its own level and file. A host that wants process-wide file logging calls `configureFileLogging(...)` itself.
- `chatDebugLog: true` writes one JSON file per turn into the agent's log dir (falling back to the process-wide dir of `configureFileLogging`); with neither, nothing is written. `source` is free text and is left out of the file when not set.
