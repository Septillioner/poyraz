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

### Name and model

| Method | Effect |
|--------|--------|
| `Name(name)` | Display / agent name |
| `Model(model)` | Model id string |
| `LocalModel(model)` | Model + Ollama host `http://127.0.0.1:11434` |
| `RemoteModel(url, model?)` | Custom host (and optional model) |
| `WithModelProfile(profile)` | Sets `model` + `host` from a `ModelProfile` |
| `Provider(provider)` | Inject a custom `LLMProvider` |
| `ApiKey(key)` | Explicit API key (required for remote providers) |

### Tools

| Method | Effect |
|--------|--------|
| `WithPresets(...presets)` | `filesystem` \| `shell` \| `planning` \| `search` |
| `WithTools(...names)` | Include specific tool names |
| `WithoutTools(...names)` | Exclude names after resolution |
| `DefaultSystemTools(permissions?)` | Map read/write/execute/tasks/grep flags to presets |
| `RegisterTool(definition)` | Register globally and add to this agent |
| `AddTool(name, definition)` / `AddTools(map)` | Add definitions on this agent |

If you pass neither presets nor explicit tools, the agent stays bare: no tools. Opt in with `WithPresets`, `WithTools`, `AddTool`, or `DefaultSystemTools`. Selecting tools does **not** inject `BASE_PROMPT`; tools are sent as provider schemas only. Import `BASE_PROMPT` and pass it via `.SystemPrompt(...)` if you want that text.

### Behavior and routing

| Method | Effect |
|--------|--------|
| `SystemPrompt(text)` | Host system text. Empty/omitted and no rules → no system message |
| `Rules(...texts)` | Appended after the system text, separated by a blank line. Empty → system text unchanged |
| `AddSkill(skill)` / `AddSkills(skills)` | Register skills. Adds `load_skill`; skill bodies are not written into the system message |
| `ContextLimit(n)` | Turn limit for trim / auto-summary. Omitted → history is not trimmed |
| `AutoSummary(enabled?)` | When `ContextLimit` is exceeded, rolling summary instead of trim. No effect without a limit |
| `RemoteContext(url)` | Remote context URL |
| `Options(record)` | Provider options (`temperature`, `num_ctx`, …) |
| `RoutingPolicy(partial)` | `maxToolRounds`, `repeatCallLimit`, `deterministicMode`, … |
| `Policy(policy)` | Set `AgentPolicy` (tool allow-list, gates) |
| `TodoStore(store)` | Inject todo persistence (default: in-memory) |
| `Delegation(config \| null)` | Enable/disable `delegate_task` with explicit child profile + key |
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
  .SystemPrompt('You are a careful coding agent.')
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

### Policy and tools

| Method | Description |
|--------|-------------|
| `getPolicy()` / `setPolicy(policy)` | Active `AgentPolicy` |
| `getDelegation()` / `setDelegation(config \| null)` | Child model for `delegate_task` |
| `syncDelegationTool()` | Refresh `delegate_task` presence from current delegation config |
| `getTools()` | Tools allowed under the **current** policy |
| `mergeExternalTools(tools)` | Add MCP (or other) tools into the base set |
| `removeExternalTools(prefix?)` | Remove tools by name prefix (default `mcp_`) |
| `setSystemPrompt(text)` / `rebuildSystemPrompt()` | Update or re-apply the system message |

### Model and session

| Method | Description |
|--------|-------------|
| `getModel()` / `setModel(model)` | Model id |
| `getModelProfile()` / `setModelProfile(profile, apiKey)` | Full profile + provider swap (apiKey required) |
| `getName()` | Agent name |
| `setSessionId(id)` / `getSessionId()` | Session id (todos, shell cwd) |
| `getApiKeyPreview()` | Masked key preview or `null` |
| `getConfig()` | Current `AgentConfig` |

### History and usage

| Method | Description |
|--------|-------------|
| `loadHistory(messages)` | Restore chat messages (keeps current system message if present) |
| `getHistory()` / `getMessageHistory()` | Current messages |
| `getMemoryUsage()` | Non-system message count. `limit` and `percentage` are `null` when `ContextLimit` is omitted |
| `getStats()` | Provider token stats (`current` / `session`) |
| `setSessionUsage(usage)` | Seed session token totals |
| `summarize()` | Manually run the same rolling summary as `AutoSummary` |
| `getTodoSnapshot()` / `getCachedTodoSnapshot()` | Todo list for the session |
| `setChatLogSource(source)` | Tag for debug logging |
| `getPromptCacheKey()` | Prompt cache key when applicable |

When `ContextLimit` is omitted, history only grows. `AutoSummary` does not run, and trim does not run.

When `AutoSummary` is on and the turn count exceeds `ContextLimit`, older turns collapse into one `user` message (`Önceki konuşmaların özeti: …`) placed after the system message. The newest turns kept are about 60% of the limit. Without `AutoSummary`, the same cut is a hard trim.

`summarize()` uses that same cut when a limit is set. With no limit it keeps the last `user` message and everything after it, and summarizes what comes before. If that slice is empty, no model call is made.

`Rules` are host text only. They are joined onto the system message when non-empty. `AddSkill` registers `{ name, description, content }`. The tool schema lists name and description. Calling `load_skill` returns `content` as a tool result. Set skills at build time; changing the catalog changes the tool schema. If `allowedTools` is a name list, include `load_skill`. `WithoutTools('load_skill')` omits the tool.

## Routing policy

`ToolRoutingPolicy` controls the tool loop:

- `maxToolRounds` — max tool rounds per turn
- `repeatCallLimit` — identical call signature limit
- `deterministicMode` — stricter policy guard behavior
- `deniedTools` / `deniedToolReason` — filled from the active `AgentPolicy`
- `perTurnToolLimits` — e.g. `{ todo_write: 1 }`

Behavioral modes (agent/plan/ask/chat) are **not** in this package — hosts map them to `AgentPolicy` plus optional `SystemPrompt` text (see `poyraz-cli`).

Set via `AgentBuilder.RoutingPolicy()` or a template’s `routingPolicy` field.
