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
| `tool.call.start` | `toolCallId`, `toolName`, `args` | Tool about to run |
| `tool.call.end` | `toolCallId` | Tool execution finished |
| `tool.call.result` | `toolCallId`, `toolName`, `content`, `ok`, `error?`, `meta?` | Tool output |

`emitEvent(handlers, event)` is available if you build a custom loop that reuses the same event shape.
