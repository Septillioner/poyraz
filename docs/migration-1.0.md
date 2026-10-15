# Migrating to 1.0

Version 1.0.0 (from 0.3.0) turns the builder into a plain text completion: **every feature is off until you switch it on**. Most breaking changes are one line of builder code that restores a behaviour the library used to apply for you.

If you upgrade a host that relied on the old defaults, the shortest path is the checklist at the end; the sections explain each change with a before / after.

## Contents

- [Clean builder](#clean-builder)
- [Model, host, options and cache key](#model-host-options-and-cache-key)
- [Tools](#tools)
- [Repair, breakers and the tool loop](#repair-breakers-and-the-tool-loop)
- [Rate limits](#rate-limits)
- [MCP](#mcp)
- [Summaries](#summaries)
- [Logging](#logging)
- [Removed API](#removed-api)
- [Providers](#providers)
- [Events](#events)
- [Context API](#context-api)
- [Upgrade checklist](#upgrade-checklist)

## Clean builder

A bare `new AgentBuilder().Provider(p).Build()` sends the user message and nothing else: no system message, no tools, no summarization or trimming, no repair text, no breakers, no continuation, no logging, no rate-limit waiting, no MCP. Each feature has an explicit builder method ([Agent API](agent-api.md#principle-a-clean-builder-is-a-plain-text-completion)).

**Migration:** turn on what you used (see the sections below).

## Model, host, options and cache key

Before, `Agent` filled in what you left out: model `gpt-4o`, host `http://localhost:11434`, provider options `{ temperature: 0.2, num_ctx: 4096 }`, and a prompt cache key `<name>:<hash>` on every request.

After, nothing is added:

- `Build()` throws `AgentConfigError` when there is neither a `Provider(...)` nor a model together with a host.
- `temperature`, `num_ctx` and any other provider option are sent only through `Options({...})`.
- `promptCacheKey` is sent only when the agent has system content (system text or rules).
- `ChatOptions.model` is optional. Built-in OpenAI-compatible providers leave `model` out of the request when it is unset; a custom `LLMProvider` may receive no model.
- `agent.getModel()` is `undefined` without a model; `getModelProfile()` is `undefined` without model and host.

```ts
// before: worked, silently used gpt-4o on localhost:11434 with temperature 0.2 / num_ctx 4096
const agent = new AgentBuilder().Name('demo').Build();

// after
const agent = new AgentBuilder()
  .Name('demo')
  .WithModelProfile(ollamaProfile('llama3.2'))   // or Model(...) + RemoteModel(...), or Provider(...)
  .Options({ temperature: 0.2, num_ctx: 4096 }) // only if you want them
  .Build();
```

## Tools

- **An empty selection is no tools.** Before, `registry.resolveToolSet({})` returned every registered tool, and a builder with only `WithoutTools('x')` got every built-in tool except `x`. Now no preset and no name means an empty set; `WithoutTools` only trims what `WithPresets` / `WithTools` selected.
- **`AgentConfig.toolPresets` and `AgentConfig.includeTools` are gone.** The agent receives exactly `config.tools` (the builder resolves presets and names into it) plus `excludeTools`. `toolPresets`, `includeTools` and `defaultTools` remain as keys of `AgentTemplate` / `FromJSON`, which turn them into builder calls.
- **Registries are per instance.** `RegisterTool` writes to the builder's own registry layered over the shared one, and an agent's `mergeExternalTools` / `removeExternalTools` write to the agent's registry (`getToolRegistry()`). The shared `toolRegistry` is no longer written to.
- `mergeExternalTools(tools)` now returns `string[]`, the names that replaced an existing tool (before: `void`). `removeExternalTools(prefix?)` defaults to the configured MCP prefix.
- Policy: `allowedTools` left undefined means all tools of the agent are allowed; a clean agent has none, so it exposes none.

```ts
// before: every built-in tool except delete_file
new AgentBuilder().WithoutTools('delete_file')

// after: opt in, then trim
new AgentBuilder().WithPresets('filesystem', 'search').WithoutTools('delete_file')
```

## Repair, breakers and the tool loop

Before, a failed tool result always carried a `REPAIR:` text (with tool-specific texts for `edit_file`, `run_terminal_cmd`, `grep`), the same-tool breaker was a compile-time flag (off), the progress tools were the constant `edit_file`, `delete_file`, `run_terminal_cmd`, and `maxToolRounds` / `repeatCallLimit` came from `routingPolicy` or `options.max_tool_rounds` / `options.repeat_call_limit`.

After, all of it is configuration:

| Setting | Builder | Default |
|---------|---------|---------|
| Repair text on failed tool results | `Repair(true)` or `Repair({ enabled, maxAttempts, resolvers, generic })` | off |
| Tool-specific repair texts | `Repair({ enabled: true, resolvers: builtinRepairResolvers })` | opt-in |
| Same-tool breaker | `SameToolBreaker({ enabled: true, limit: 3 })` | off |
| Progress tools of that breaker | `ProgressTools('edit_file', ...)` | none |
| Tool round budget / identical-call limit | `MaxToolRounds(n)` / `RepeatCallLimit(n)` | 10 / 2 |

`MaxToolRounds` / `RepeatCallLimit` win over `RoutingPolicy` and the old `options.max_tool_rounds` / `options.repeat_call_limit`, which still work as a last fallback. The generic repair text is neutral; the built-in tool texts are no longer applied automatically.

```ts
import { builtinRepairResolvers } from 'poyraz';

new AgentBuilder()
  .Repair({ enabled: true, resolvers: builtinRepairResolvers })  // before: always on
  .SameToolBreaker({ enabled: true })
  .ProgressTools('edit_file', 'delete_file', 'run_terminal_cmd')  // before: implicit
```

## Rate limits

Before, the OpenAI-compatible providers waited on every 429 and retried without a limit. After, waiting is **off**: a 429 is an error at once. `RateLimit({ enabled: true })` turns on bounded waiting (3 waits by default, `maxWaits`, `maxTotalWaitMs`, `fallbackDelayMs`, `maxDelayMs`); when the budget runs out the turn fails with `RateLimitExceededError`. See [Rate limit and logging](rate-limit-and-logging.md).

```ts
new AgentBuilder().RateLimit({ enabled: true, maxWaits: 3 })
```

## MCP

MCP stays host-driven (`mcpClientManager.connectAll(servers)` + `agent.mergeExternalTools(tools)`), with the registry changes above. New and optional: `Mcp({ enabled: true, servers, toolPrefix })` lets the agent connect its own servers in `init()` through its own manager; `connectMcp()` / `disconnectMcp()` / `getMcpStates()` / `getMcpToolPrefix()` manage it. `connectMcp()` does not throw when a server fails: the server's state has `status: 'error'` ([MCP](mcp.md#connection-errors-do-not-throw)). Nothing connects unless `enabled: true`.

## Summaries

The summary prefix and prompt are now neutral English. Before, the summary message started with `Önceki konuşmaların özeti:` and the prompt was Turkish.

- Prefix: `DEFAULT_SUMMARY_MESSAGE_PREFIX` (`Summary of the earlier conversation:`). `SUMMARY_MESSAGE_PREFIX` is kept and equals it.
- Prompt: `DEFAULT_SUMMARY_PROMPT`.
- Both are configurable: `Summarization({ prefix, prompt, keepRatio, thresholdRatio, toolResultMaxChars })`.

**Migration:** history persisted by an older version holds summary messages with the Turkish prefix. Pass it, or those messages are no longer recognized as summaries:

```ts
new AgentBuilder().Summarization({ enabled: true, prefix: 'Önceki konuşmaların özeti:' })
// isSummaryMessage(message, 'Önceki konuşmaların özeti:') for your own checks
```

Summarization itself is still off by default (`AutoSummary` / `AutoSummaryThreshold` keep working).

## Logging

Before, `LogLevel(...)` / `logLevel` set the level of the process-wide `logger`, and every turn wrote a chat debug file (source `'cli'` or `'http'`, default `'cli'`) whenever process-wide file logging was configured. After, logging is per agent and off by default:

- `Logging({ level, file, chatDebugLog, source })` (shortcuts `LogLevel`, `FileLogging`, `ChatDebugLog`, `LogSource`). An agent never changes the shared `logger`.
- The chat debug file is written only with `logging.chatDebugLog` (or `ChatDebugLog()`).
- `ChatDebugLogSource` is a free string and `source` is omitted when you set none; `setChatLogSource(source)` takes any text.

```ts
new AgentBuilder().Logging({ level: LogLevel.INFO, chatDebugLog: true, source: 'my-app' })
```

## Removed API

| Removed | Instead |
|---------|---------|
| `BASE_PROMPT` export | Write your own system text with `SystemPrompt(...)` |
| `ToolRoutingPolicy.deterministicMode` / `RoutingPolicy({ deterministicMode })` | Nothing read it; the key is ignored |
| `AgentConfig` / `AgentTemplate`: `workflow`, `thinking`, `deepThinking`, `order` | Delete the keys (unknown keys are ignored by `FromJSON`) |
| `RemoteContext(url)`, `remoteContextUrl` | Removed with no replacement |
| `AgentConfig.toolPresets`, `AgentConfig.includeTools` | See [Tools](#tools) |
| `defaults/templates/poyraz-2.0.json` | Keep your own template files; see [Templates](templates.md) |
| `docs/modes.md` | Renamed to [Agent policy](policy.md); the library has no modes, only `AgentPolicy` |

The removed template was never part of the npm package (`files` is `dist` only).

## Providers

- OpenAI Chat Completions and Ollama no longer send an empty `tools` array: with no tools the key is left out (OpenAI Responses and Gemini already did).
- Without a model, built-in OpenAI-compatible providers omit `model` from the request instead of failing in the library.
- OpenAI Responses sends `reasoning` only when you call `Reasoning({ effort })`, as `{ effort, summary: 'auto' }`. Before, every request carried `reasoning: { summary: 'auto' }`. Without an effort you no longer get reasoning summaries (`reasoning.delta` events).

```ts
new AgentBuilder().Reasoning({ effort: 'medium' }) // before: summaries without any effort set
```

## Events

`context.usage` has `final: true` only when the turn really ends after that request. Before, `final` was computed when the reply arrived (no tool calls, or the loop blocked), so a response-gate retry could follow a `final: true` event. Now the event of a tool-less reply is published after the response gates and the `ContinuationPolicy` have decided. See [Streaming](streaming.md#event-types).

**Migration:** if you used `final: true` to close the turn UI, it is now reliable; a turn that is cancelled at that point still reports `final: true`.

## Context API

New in 1.0 (before, only `getMemoryUsage()` and `getContextUsage()` existed):

- `agent.compileRequest(options?)`, `estimateContext(options?)`, `getContextMeterEstimate()`, `getContextMeterReal()`, `getContextReal()`, `getContextDrift()`, `getContextRecords()`, `getTokenEstimator()`, `calibrateEstimator(weight?)`.
- Builder: `TokenEstimator(options)` (`ContextWindow(tokens)` already existed).
- Ten context categories (`CONTEXT_CATEGORIES`): `system`, `rules`, `skills`, `tools`, `mcp`, `summary`, `conversation`, `toolCalls`, `toolResults`, `providerMeta`.

See [Context and token metering](context.md).

## Upgrade checklist

1. Give every agent a `Provider(...)` or a model **and** host (`WithModelProfile(...)`); add `Options({...})` if you relied on `temperature` / `num_ctx`.
2. Select tools explicitly (`WithPresets`, `WithTools`, `RegisterTool`); replace exclude-only selections.
3. Re-enable what you used: `Repair({ enabled: true, resolvers: builtinRepairResolvers })`, `SameToolBreaker`, `ProgressTools`, `RateLimit({ enabled: true })`, `Logging(...)`, `Mcp(...)`.
4. Pass `summarization.prefix` for history that holds Turkish summary messages.
5. Remove uses of `BASE_PROMPT`, `RemoteContext`, `deterministicMode`, `workflow`, `thinking`, `deepThinking`, `order`, `AgentConfig.toolPresets` / `includeTools`.
6. Use the return value of `mergeExternalTools` if you want to know about name clashes; do not expect `toolRegistry` to contain merged tools.
7. Call `Reasoning({ effort })` on OpenAI if you want reasoning summaries.
