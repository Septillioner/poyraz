# Agent API

Everything below is imported from `poyraz`:

```ts
import {
  Agent,
  AgentBuilder,
  type AgentConfig,
  type AgentTemplate,
  type ToolRoutingPolicy,
} from 'poyraz';
```

## AgentBuilder

Fluent configuration. Call `Build()` once; tool selection is finalized then.

### Identity and model

| Method | Effect |
|--------|--------|
| `Name(name)` | Display / agent name |
| `Model(model)` | Model id string |
| `LocalModel(model)` | Model + Ollama host `http://127.0.0.1:11434` |
| `RemoteModel(url, model?)` | Custom host (and optional model) |
| `WithModelProfile(profile)` | Sets `model` + `host` from a `ModelProfile` |
| `Provider(provider)` | Inject a custom `LLMProvider` |
| `ApiKey(key)` | Explicit API key (prefer env / `~/.poyraz/.env`) |

### Tools

| Method | Effect |
|--------|--------|
| `WithPresets(...presets)` | `filesystem` \| `shell` \| `planning` \| `search` |
| `WithTools(...names)` | Include specific tool names |
| `WithoutTools(...names)` | Exclude names after resolution |
| `DefaultSystemTools(permissions?)` | Map read/write/execute/tasks/grep flags to presets |
| `RegisterTool(definition)` | Register globally and add to this agent |
| `AddTool(name, definition)` / `AddTools(map)` | Add definitions on this agent |

If you pass neither presets nor explicit tools, the builder enables **all** preset groups.

### Behavior and routing

| Method | Effect |
|--------|--------|
| `Identity(text)` | System identity string |
| `ContextLimit(n)` | Message context limit (message count) |
| `AutoSummary(enabled?)` | Enable context auto-summary |
| `RemoteContext(url)` | Remote context URL |
| `Options(record)` | Provider options (`temperature`, `num_ctx`, …) |
| `RoutingPolicy(partial)` | `maxToolRounds`, `repeatCallLimit`, `deterministicMode`, … |
| `LogLevel(level)` | Logger level for this agent |
| `FromTemplate(template)` / `FromJSON(json)` | Load from an `AgentTemplate` / JSON object |

### Example

```ts
import { AgentBuilder, openAiProfile, LogLevel } from 'poyraz';

const agent = new AgentBuilder()
  .Name('coder')
  .WithModelProfile(openAiProfile('gpt-4o'))
  .WithPresets('filesystem', 'shell', 'search', 'planning')
  .WithoutTools('delete_file')
  .Identity('You are a careful coding agent.')
  .ContextLimit(80)
  .AutoSummary(true)
  .RoutingPolicy({ maxToolRounds: 40, repeatCallLimit: 2 })
  .LogLevel(LogLevel.INFO)
  .Build();
```

## Agent

Returned by `AgentBuilder.Build()`.

### Lifecycle

```ts
await agent.init(); // prepare system prompt; call before chat
```

### Chat

```ts
const { content, usage } = await agent.chat(userInput, {
  onEvent: (event) => { /* see streaming.md */ },
  signal: abortController.signal,
});
```

Throws `ChatAbortedError` when the abort signal fires.

### Mode and tools

| Method | Description |
|--------|-------------|
| `getMode()` / `setMode(mode)` | `agent` \| `plan` \| `ask` \| `chat` |
| `getTools()` | Tools allowed in the **current** mode |
| `mergeExternalTools(tools)` | Add MCP (or other) tools into the base set |
| `removeExternalTools(prefix?)` | Remove tools by name prefix (default `mcp_`) |
| `rebuildSystemPrompt()` | Refresh system prompt after config/mode changes |

### Model and session

| Method | Description |
|--------|-------------|
| `getModel()` / `setModel(model)` | Model id |
| `getModelProfile()` / `setModelProfile(profile)` | Full profile + provider swap |
| `getName()` | Agent name |
| `setSessionId(id)` / `getSessionId()` | Session id (todos, shell cwd) |
| `getApiKeyPreview()` | Masked key preview or `null` |
| `getConfig()` | Current `AgentConfig` |

### History and usage

| Method | Description |
|--------|-------------|
| `loadHistory(messages)` | Restore chat messages (keeps current system message) |
| `getHistory()` / `getMessageHistory()` | Current messages |
| `getContextUsage()` / `getMemoryUsage()` / `getUsageBreakdown()` | Context stats |
| `getStats()` | Token stats helper |
| `setSessionUsage(usage)` | Seed session token totals |
| `getTodoSnapshot()` / `getCachedTodoSnapshot()` | Todo list for the session |
| `refreshCurrentTodosBlock()` | Refresh the current-todos prompt block |
| `setChatLogSource(source)` | Tag for debug logging |
| `getPromptCacheKey()` | Prompt cache key when applicable |

## Routing policy

`ToolRoutingPolicy` controls the tool loop:

- `maxToolRounds` — max tool rounds per turn
- `repeatCallLimit` — identical call signature limit
- `deterministicMode` — stricter policy guard behavior
- `deniedTools` — filled automatically from the active mode
- `mode` — current mode (e.g. plan-mode `todo_write` once)

Set via `AgentBuilder.RoutingPolicy()` or a template’s `routingPolicy` field.
