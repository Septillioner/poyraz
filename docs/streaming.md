# Streaming

Wire `agent.chat` into your UI with optional `ChatHandlers`: stream tokens, surface tool activity, and cancel mid-turn.

```ts
import type { AgentStreamEvent, ChatHandlers } from 'poyraz';
import { ChatAbortedError } from 'poyraz';

const ac = new AbortController();

const handlers: ChatHandlers = {
  signal: ac.signal,
  onEvent: (event: AgentStreamEvent) => {
    switch (event.type) {
      case 'lifecycle':
        // thinking | summarizing | summarized
        break;
      case 'text.delta':
        appendToTranscript(event.delta);
        break;
      case 'reasoning.delta':
        appendToReasoning(event.delta);
        break;
      case 'rate_limit.wait':
        // TPM/RPM limit: event.delayMs from now, then the same request is retried
        showRateLimitWait(event.delayMs, event.retryAt, event.reason);
        break;
      case 'rate_limit.resumed':
        clearRateLimitWait();
        break;
      case 'tool.call.start':
        showToolRunning(event.toolName, event.args);
        break;
      case 'tool.call.end':
        markToolFinished(event.toolCallId);
        break;
      case 'tool.call.result':
        showToolResult(event.toolName, event.ok, event.content);
        break;
    }
  },
};

try {
  const { content, usage } = await agent.chat('Refactor the logger.', handlers);
  finalizeTurn(content, usage);
} catch (error) {
  if (error instanceof ChatAbortedError) {
    showCancelled();
  } else {
    throw error;
  }
}

// user hits Stop
ac.abort();
```

## Event types

| `type` | Fields | Meaning |
|--------|--------|---------|
| `lifecycle` | `phase` | `thinking`, `summarizing`, `summarized` |
| `text.delta` | `delta` | Assistant text stream |
| `reasoning.delta` | `delta` | Reasoning stream when the provider emits it |
| `rate_limit.wait` | `attempt`, `delayMs`, `retryAt`, `source`, `reason?` | Rate limited (TPM/RPM); waiting `delayMs` before the same request is retried. `source` is `header`, `message`, or `fallback` |
| `rate_limit.resumed` | `attempt` | The wait ended and the request is being sent again |
| `tool.call.start` | `toolCallId`, `toolName`, `args` | Tool about to run |
| `tool.call.end` | `toolCallId` | Tool execution finished |
| `tool.call.result` | `toolCallId`, `toolName`, `content`, `ok`, `error?`, `meta?` | Tool output |

`emitEvent(handlers, event)` is available if you build a custom loop that reuses the same event shape.

## Rate limits

`OpenAIProvider` (OpenAI, OpenRouter, Groq, llama.cpp) never ends a turn on a TPM/RPM rejection. On a 429 it waits and repeats the same request:

1. `x-ratelimit-reset-tokens` or `x-ratelimit-reset-requests`, picking the window named in the message, otherwise the longer one.
2. `retry-after-ms`, then `retry-after` (delay or HTTP date).
3. The `Please try again in 12.5s` hint in the message body.
4. A fixed `RATE_LIMIT_FALLBACK_DELAY_MS` (20s) when the provider recommends nothing.

The wait is clamped to 1s..10min, aborts instantly when the turn is cancelled, and never repeats a request that already streamed output to the caller. The same protection covers `/summary`, because the summarizer goes through the same provider.
