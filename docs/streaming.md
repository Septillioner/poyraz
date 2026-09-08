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
      case 'subagent.task.started':
      case 'subagent.task.progress':
      case 'subagent.task.completed':
      case 'subagent.task.failed':
      case 'subagent.task.cancelled':
      case 'subagent.task.injected':
      case 'subagent.tool.start':
      case 'subagent.tool.result':
        // Background subagent lifecycle — see docs/subagents.md
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
| `subagent.task.started` | `taskId`, `model`, `taskPreview`, `startedAt` | Background child started |
| `subagent.task.progress` | `taskId`, `phase`, `toolName?`, `toolDetail?` | Child progress (no raw deltas) |
| `subagent.task.completed` | `taskId`, `model`, `durationMs`, `usage` | Child finished successfully |
| `subagent.task.failed` | `taskId`, `model`, `durationMs`, `error` | Child failed |
| `subagent.task.cancelled` | `taskId`, `model`, `durationMs`, `reason?` | Child cancelled |
| `subagent.task.injected` | `taskId` | Pending notice flushed into parent context |
| `subagent.tool.start` | `taskId`, `toolCallId`, `toolName`, `args` | Child tool start (verbose UIs) |
| `subagent.tool.result` | `taskId`, `toolCallId`, `toolName`, `ok`, `preview` | Child tool result (verbose UIs) |

`agent.subscribeSubagentEvents(listener)` receives the same subagent events across parent turns (useful when the child outlives a single `chat()` call).

`emitEvent(handlers, event)` is available if you build a custom loop that reuses the same event shape.
