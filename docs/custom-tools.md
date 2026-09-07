# Custom tools

Add domain-specific tools with Zod schemas via `defineTool`, then attach them when you build the agent.

## Example

```ts
import { z } from 'zod';
import { defineTool, AgentBuilder, openAiProfile } from 'poyraz';

const echoTool = defineTool({
  name: 'echo',
  description: 'Echo a message back to the model.',
  inputSchema: z.object({
    message: z.string().describe('Text to echo.'),
  }),
  execute: async (args) => {
    return { content: args.message };
  },
  presentation: {
    label: 'Echo',
    category: 'network',
  },
  meta: {
    category: 'network',
  },
});

const agent = new AgentBuilder()
  .WithModelProfile(openAiProfile('gpt-4o-mini'))
  .WithPresets('filesystem')
  .RegisterTool(echoTool)
  .Build();

await agent.init();
```

### `execute` return values

Prefer `{ content: string, structured?: unknown, isError?: boolean }`. Plain strings and other values are normalized. Objects with `code` + `message` (`AgentError`) become error results.

### `ToolContext`

Second argument to `execute`:

- `agent` — owning agent when wired
- `sessionId` — session id
- `abortSignal` — turn abort
- `logger`, `refreshSystemPrompt`, `lastReadFile`

## Register vs add

| API | Behavior |
|-----|----------|
| `RegisterTool(def)` | Registers on the shared registry and includes the tool on this agent |
| `AddTool` / `AddTools` | Attach definitions on this agent only |
| `agent.mergeExternalTools(map)` | Add tools after build (same pattern as MCP) |

## Presentation and meta

Optional `presentation` drives labels/icons and arg/result summaries in a host UI (`sensitiveArgKeys` for redaction).

Optional `meta`:

- `category`: `file` \| `shell` \| `memory` \| `planning` \| `network`
- `destructive` / `requiresApproval` — hints for your host UI

## Provider schemas

`toolRegistry.toOpenAISchemas(names)` builds tool schemas for the model. If you set `parametersJsonSchema` (as MCP bridging does), that raw schema is sent instead of a Zod-derived one.
