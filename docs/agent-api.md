# Agent API

Everything below is imported from `poyraz`:

```ts
import {
  Agent,
  AgentBuilder,
  AgentConfigError,
  type AgentConfig,
  type AgentTemplate,
  type ToolRoutingPolicy,
} from 'poyraz';
```

## Principle: a clean builder is a plain text completion

`new AgentBuilder().Provider(p).Build()` sends the user message and nothing else. Every feature is **off by default** and turned on by an explicit builder method:

- no system message, rules or skills (and so no `load_skill` tool)
- no tools
- no summarization or trimming (history only grows)
- no repair text, no same-tool breaker, no error breaker, no continuation
- no logging output, no chat debug files
- no rate-limit waiting (a 429 is an error at once)
- no MCP
- no `model`, `options` (temperature, `num_ctx`, ...), cache key, reasoning or service tier sent unless you set them

Without `Provider(...)`, the built-in providers need an explicit model **and** host (`Model` + `RemoteModel` / `LocalModel`, or `WithModelProfile`). `Build()` throws `AgentConfigError` otherwise: there is no implicit model or localhost default.

## AgentBuilder

Fluent configuration. Call `Build()` once; tool selection is finalized then. Every method returns the builder.

### Name and model

| Method | Effect |
|--------|--------|
| `Name(name)` | Display / agent name (also part of the prompt cache key) |
| `Model(model)` | Model id string |
| `LocalModel(model)` | Model + Ollama host `http://127.0.0.1:11434` |
| `RemoteModel(url, model?)` | Custom host (and optional model) |
| `WithModelProfile(profile)` | Sets `model` + `host` from a `ModelProfile`. The provider class is inferred from the host (see below) |
| `Provider(provider)` | Inject a custom `LLMProvider`. Needs no model or host; without `Model(...)` the provider receives requests with no `model` (`ChatOptions.model` is optional) |
| `ApiKey(key)` | Explicit API key (required for remote providers) |
| `Options(record)` | Provider options (`temperature`, `num_ctx`, ...). Nothing is sent unless you set it |
| `Reasoning(config)` | `{ effort }`: `none` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh`. Unknown effort throws |
| `ServiceTier(tier?)` | `default` \| `flex` \| `fast` \| `priority` \| `ultrafast`. Unknown tier throws |
| `PromptCacheRetention(v?)` | `'in_memory'` \| `'24h'`. Unknown value throws. Not sent when omitted |

When no `Provider(...)` is given, the host decides the provider: OpenAI, Groq, OpenRouter and Gemini hosts are recognized, anything else is treated as Ollama. llama.cpp cannot be told apart by host, so build its provider yourself and pass it in:

```ts
import { AgentBuilder, createLLMProvider, llamaCppProfile } from 'poyraz';

const profile = llamaCppProfile('qwen2.5-7b', 'http://127.0.0.1:8080');
const agent = new AgentBuilder()
  .Provider(createLLMProvider(profile)) // OpenAI-compatible, /v1 base, anonymous key
  .Model(profile.model)
  .Build();
```

### Tools

| Method | Effect |
|--------|--------|
| `WithPresets(...presets)` | `filesystem` \| `shell` \| `search` (built-in tools, see [Tools](tools.md)) |
| `WithTools(...names)` | Include specific tool names from the registry |
| `WithoutTools(...names)` | Exclude names from what `WithPresets` / `WithTools` select. It does not remove tools added with `RegisterTool`, `AddTool(s)` or `DefaultSystemTools`. Excluding `load_skill` (or the configured skill tool name) hides the skill tool |
| `DefaultSystemTools(permissions?)` | Map `read` / `write` (filesystem), `execute` (shell) and `grep` / `search` flags to presets and add those tools to this agent. Called with no argument it enables read, write, execute and grep |
| `RegisterTool(definition)` | Add to this agent and the builder's own registry; the shared `toolRegistry` is not touched |
| `AddTool(name, definition)` / `AddTools(map)` | Add definitions on this agent |

With neither presets nor explicit tools the agent stays bare: no tools. Tools go to the provider as schemas only; the library never writes tool instructions into the system message.

The builder resolves presets, `WithTools` and `WithoutTools` into one `tools` map when `Build()` runs. `AgentConfig` therefore has no `toolPresets` / `includeTools`: the agent gets exactly `config.tools` (nothing is implied from any registry), plus `excludeTools` to keep names out. `toolPresets`, `includeTools` and `defaultTools` exist only as template / JSON keys that `FromJSON` turns into the builder calls above.

### System, rules and skills

| Method | Effect |
|--------|--------|
| `SystemPrompt(text)` | Host system text. Empty/omitted and no rules → no system message |
| `System(text)` | Alias field (`system`). `SystemPrompt` wins when both are set |
| `Rules(...texts)` | Appended after the system text, separated by a blank line. Blank entries are dropped. A later `Rules(...)` call replaces the earlier list; `Rules()` clears it |
| `AddSkill(skill)` / `AddSkills(skills)` | Register skills (`{ name, description, content }`). Same name replaces. A skill missing its name, description or content throws |
| `SkillTool(config \| boolean)` | `{ enabled, toolName }` for the skill-loading tool. Omitted `enabled` → on only when skills exist; `false` hides it. `toolName` defaults to `load_skill` |

### Context and summarization

| Method | Effect |
|--------|--------|
| `ContextLimit(n)` | Turn limit for trim / summary. Omitted → history is never trimmed |
| `ContextWindow(tokens)` | Token window for meter percentages and token-based summarization. Ignored below 1000 |
| `TokenEstimator(options)` | Tune the local estimator (`charsPerToken`, `messageOverheadTokens`). See [Context](context.md#configuration) |
| `Summarization(config \| boolean)` | `{ enabled, thresholdRatio, keepRatio, prompt, prefix, toolResultMaxChars }`. `true` / `false` only toggles `enabled`. Off by default |
| `AutoSummary(enabled = true)` | Legacy shortcut (`autoSummary`); `summarization.enabled` wins when both are set |
| `AutoSummaryThreshold(ratio)` | Legacy shortcut (`summaryThresholdRatio`); `summarization.thresholdRatio` wins when both are set. Clamped to 0.5..0.95 |

`summarization` fields (all optional):

| Field | Default | Meaning |
|-------|---------|---------|
| `enabled` | `false` | Roll older turns into one summary message instead of trimming them |
| `thresholdRatio` | `0.8` | Window occupancy (needs `ContextWindow`) that triggers a summary. Clamped to 0.5..0.95 |
| `keepRatio` | `0.6` | Share of `ContextLimit` kept verbatim after a summary. Clamped to 0.1..0.9 |
| `prompt` | neutral English prompt (`DEFAULT_SUMMARY_PROMPT`) | A string (may contain `{{conversation}}`; without the placeholder the conversation is appended) or a function `(conversation) => string` |
| `prefix` | `DEFAULT_SUMMARY_MESSAGE_PREFIX` (`Summary of the earlier conversation:`) | Start of the summary message. It also marks summary messages already in history |
| `toolResultMaxChars` | `200` | Tool results are cut to this length inside the summarization input |

Hosts that persisted history with the old Turkish prefix (`Önceki konuşmaların özeti:`) must pass `summarization.prefix` with that text, otherwise those messages are no longer recognized as summaries. Functions (`prompt`) are code-only: `AgentTemplate` / JSON carry a string prompt.

### Tool loop and routing

| Method | Effect |
|--------|--------|
| `RoutingPolicy(partial)` | `maxToolRounds`, `repeatCallLimit` (the `ToolRoutingPolicy` fields). A legacy `deterministicMode` key is ignored |
| `MaxToolRounds(n)` / `RepeatCallLimit(n)` | Tool round budget per turn (default **10**) and identical tool+args limit (default **2**). They win over `RoutingPolicy` and over `options.max_tool_rounds` / `options.repeat_call_limit` |
| `Repair(config \| boolean = true)` | `{ enabled, maxAttempts, resolvers, generic }`. Off by default. When on, a failed tool result carries a short repair instruction (at most `maxAttempts`, default 3, per identical call signature). The default text is a neutral generic one. `resolvers` maps a tool name to its own text builder (`(input) => string \| undefined`; `undefined` falls back to the generic text), `generic` replaces the generic text. Both are code-only. The tool-specific texts for the built-in `edit_file`, `run_terminal_cmd` and `grep` are opt-in: `Repair({ enabled: true, resolvers: builtinRepairResolvers })` (or pick entries) |
| `SameToolBreaker(config \| boolean = true)` | `{ enabled, limit }`. Off by default. After `limit` (default 3) consecutive rounds led by the same tool, a notice is injected |
| `ProgressTools(...names)` | Tools whose success counts as progress for the same-tool breaker: a round where one succeeded without leading the round resets the streak. Default: none |
| `Policy(config)` | The [agent policy](policy.md) (tool allow-list, error breaker, gates, per-turn limits) |
| `AllowedTools(list \| 'all')`, `ErrorBreaker(mode)`, `ResponseGates(...gates)`, `PerTurnToolLimits(map)` | Single-field shortcuts into `policy` |
| `Continuation(...policies)` | See [Continuation](#continuation) |

### MCP, rate limit and logging

| Method | Effect |
|--------|--------|
| `Mcp(config \| boolean)` | `{ enabled, servers, toolPrefix }`. Off unless `enabled: true`. See [MCP](mcp.md#optional-mcp-on-the-agent) |
| `RateLimit(config \| boolean = true)` | `{ enabled, maxWaits, fallbackDelayMs, maxDelayMs, maxTotalWaitMs }`. Off by default; when on, the waiting is bounded (default 3 waits). See [Rate limit and logging](rate-limit-and-logging.md) |
| `Logging(config)` | `{ level, file, chatDebugLog, source }`. All off by default |
| `LogLevel(level)` / `FileLogging(config)` / `ChatDebugLog(enabled = true)` / `LogSource(text)` | Shortcuts into `logging` |

### JSON

`FromTemplate(template)` and `FromJSON(json)` read a plain object: `name`, `localModel`, `remoteModel`, `model`, `host`, `toolPresets`, `defaultTools`, `includeTools`, `excludeTools`, `contextLimit`, `contextWindowTokens`, `summaryThresholdRatio`, `autoSummary`, `summarization`, `tokenEstimator`, `reasoning`, `serviceTier`, `systemPrompt`, `system`, `rules`, `skills`, `skillTool`, `promptCacheRetention`, `options`, `routingPolicy`, `maxToolRounds`, `repeatCallLimit`, `repair`, `sameToolBreaker`, `progressTools`, `policy`, `mcp`, `rateLimit`, `logging`, `logLevel`, `apiKey`. `FromJSON` also accepts a `continuation` object (or array) with an `evaluate` function, and `repair.resolvers` / `repair.generic` when they are functions (other values are dropped). `AgentTemplate`'s `repair` type leaves those two out. Unknown keys are ignored, so an old template with removed keys (`deterministicMode`, `workflow`, `thinking`, `deepThinking`, `order`, `remoteContextUrl`, `identity`) still loads. See [Templates](templates.md).

```ts
import { AgentBuilder, openAiProfile, LogLevel } from 'poyraz';

const agent = new AgentBuilder()
  .Name('coder')
  .WithModelProfile(openAiProfile('gpt-4o'))
  .ApiKey(apiKey)
  .Options({ temperature: 0.2 })
  .SystemPrompt('You are a careful coding agent.')
  .WithPresets('filesystem', 'search')
  .WithoutTools('delete_file')
  .ContextLimit(80)
  .ContextWindow(128_000)
  .Summarization({ enabled: true, thresholdRatio: 0.8 })
  .MaxToolRounds(40)
  .Repair(true)
  .SameToolBreaker({ enabled: true, limit: 3 })
  .ErrorBreaker('soft')
  .Logging({ level: LogLevel.INFO })
  .Build();
```

## Continuation

`Continuation(...policies)` plugs host-defined rules that decide whether a finished (tool-less, gate-accepted) reply is followed by another round. The library ships no implementation: by default the first tool-less reply ends the turn.

```ts
import type { ContinuationPolicy } from 'poyraz';

const untilDone: ContinuationPolicy = {
  maxContinuations: 3, // hard cap per turn, enforced by the library
  evaluate({ content, round, continuations, remaining, succeededTools }) {
    if (remaining === 0) return { kind: 'stop', reason: 'out-of-budget', data: { lastReply: content } };
    return content.includes('DONE')
      ? { kind: 'stop' }
      : { kind: 'continue', notice: 'Continue until you write DONE.' }; // appended as a user message
  },
};

const agent = new AgentBuilder().Provider(provider).Continuation(untilDone).Build();
const { content, continuation } = await agent.chat('Do the task.');
// continuation: { continuations, reason?, data? }
```

- `evaluate` receives a `ContinuationContext`: `content`, `round`, `continuations` so far this turn, `remaining` (against this policy's `maxContinuations`, `undefined` without a cap), `succeededTools`, `usage`, a read-only `messages` snapshot, `sessionId` and the turn's `signal`. It may be async.
- A `continue` beyond `maxContinuations` becomes a stop with reason `'max-continuations'`. `maxToolRounds` still bounds the turn.
- Several policies are chained with `chainContinuation(...policies)` (what `Continuation(a, b)` does): they are asked in order, the first `continue` wins; if none continues, the first `stop` that carries a reason or data is the result. The chain's cap is the largest member cap (uncapped when any member is uncapped). Calling `Continuation(...)` again replaces the previous policies.
- The policy keeps no library-managed state, so one object can serve many turns and sessions.
- `chat()` returns `continuation` only when a policy is configured.

## Agent

Returned by `AgentBuilder.Build()`.

### Lifecycle

```ts
await agent.init(); // build the system message, connect MCP (when enabled); call before chat
```

### Chat

```ts
const { content, usage, contextUsage, continuation } = await agent.chat(userInput, {
  onEvent: (event) => { /* see streaming.md */ },
  signal: abortController.signal,
});
```

`usage` sums every model request of the turn (billing). `contextUsage` is the last request only (window occupancy). `continuation` is set only with a `ContinuationPolicy`. Throws `ChatAbortedError` when the abort signal fires, and `RateLimitExceededError` when rate-limit waiting is enabled and its budget runs out.

### Policy and tools

| Method | Description |
|--------|-------------|
| `getPolicy()` / `setPolicy(policy)` | Active `AgentPolicy` |
| `getTools()` | Names of the tools allowed under the **current** policy |
| `getToolRegistry()` | This agent's registry (layered over the shared one); merged external tools are registered here |
| `mergeExternalTools(tools)` | Add MCP (or other) tools into the base set. Returns the names that replaced an existing tool (also logged) |
| `removeExternalTools(prefix?)` | Remove tools by name prefix (default: the configured MCP prefix, `mcp_`) |
| `setSystemPrompt(text)` / `rebuildSystemPrompt()` | Update or re-apply the system message |
| `setRules(rules)` | Replace host rules (`string[]` or `undefined`) and rebuild the system message |
| `setSkills(skills)` | Replace the skill list; the skill tool and its catalog follow, then the system message is rebuilt |

### MCP and rate limit

| Method | Description |
|--------|-------------|
| `connectMcp()` / `disconnectMcp()` | Connect the `mcp.servers` of this agent (`init()` does it once) / remove its tools and close the connections. `connectMcp()` does not throw when a server fails: it returns the server states and the failed one has `status: 'error'` (see [Connection errors do not throw](mcp.md#connection-errors-do-not-throw)) |
| `getMcpStates()` | Per-server state of this agent's own manager |
| `getMcpToolPrefix()` | Prefix of bridged tool names (`mcp.toolPrefix`, default `mcp_`) |
| `getRateLimitConfig()` | `ResolvedRateLimitConfig` after defaults (`enabled: false`, `maxWaits: 0` when off) |

### Model and session

| Method | Description |
|--------|-------------|
| `getModel()` / `setModel(model)` | Model id (`undefined` when none was configured) |
| `getModelProfile()` / `setModelProfile(profile, apiKey)` | Full profile + provider swap (apiKey required). `getModelProfile()` is `undefined` without a model and host. The rate-limit setting is kept |
| `getName()` | Agent name |
| `setSessionId(id)` / `getSessionId()` | Session id (handed to tools and to the continuation policy; shell tools keep their cwd per session) |
| `getApiKeyPreview()` | Masked key preview or `null` |
| `getConfig()` | Current `AgentConfig` |

### History and usage

| Method | Description |
|--------|-------------|
| `loadHistory(messages)` | Restore chat messages (keeps the current system message if present) |
| `getHistory()` / `getMessageHistory()` | Current messages |
| `getMemoryUsage()` | Non-system message count. `limit` and `percentage` are `null` when `ContextLimit` is omitted |
| `getStats()` | Provider token stats (`current` / `session`) |
| `getContextUsage()` | Usage of the last model request of the current turn, or `undefined` |
| `setSessionUsage(usage)` | Seed session token totals |
| `recordExternalUsage(usage)` | Add delegated/subagent usage to `current` and `session` |
| `summarize(handlers?)` | Run the rolling summary now, with the same `summarization` settings |
| `setChatLogSource(source)` | Free-text origin tag for chat debug logs |
| `getPromptCacheKey()` | `<name>:<hash of the system message>`, or `undefined` for an agent without system content |

When neither `ContextLimit` nor `ContextWindow` is set, history only grows: nothing is trimmed and nothing is summarized. With only `ContextWindow` and summarization enabled, the summary runs once the last prompt reaches `thresholdRatio` of the window (also between tool rounds). Without summarization the token threshold does nothing; trim only cuts when the turn count exceeds `ContextLimit`.

With summarization on and the turn count above `ContextLimit`, older turns collapse into one `user` message (`<prefix> <summary>`) placed after the system message. The newest turns kept are about `keepRatio` of the limit (default 60%). `keepRatio` belongs to summaries: without summarization the history is hard-trimmed instead and always keeps the default 60%. If the summary request fails, the history is trimmed instead.

`summarize()` uses that same cut when a limit is set. With no limit it keeps the last `user` message and everything after it, and summarizes what comes before. If that slice is empty, no model call is made.

### Context metering

| Method | Description |
|--------|-------------|
| `compileRequest(options?)` | The next request as `chat()` would send it, with its per-category estimate |
| `estimateContext(options?)` | Local per-category token estimate of the next request |
| `getContextMeterEstimate()` / `getContextMeterReal()` | Context meter from the local estimate / from the last provider usage |
| `getContextReal()` | Last completed request, split by category and scaled to the provider total |
| `getContextDrift()` | Estimate minus real for the last completed request |
| `getContextRecords()` | Last 20 requests with estimate, real usage and drift |
| `getTokenEstimator()` / `calibrateEstimator(weight?)` | Read the estimator / move its ratio toward the last real request |

Details: [Context and token metering](context.md).

## System prompt, rules and skills

`buildSystemPrompt(system?, rules?, skills?, options?)` is exported. It returns `{ content, cacheKey, parts }` (`BuiltSystemPrompt`). `content` is the system text, then the non-empty rules, joined by a blank line; empty → no system message. The library adds nothing of its own. `parts` is `{ system, rules, skills }` (`SystemPromptParts`). `parts.skills` is the skill catalog and is not part of `content`; `options.skillCatalog: false` reports it empty (the agent passes that when the skill tool is not exposed).

`Rules` are host text only. `AddSkill` registers `{ name, description, content }`; names, descriptions and content are trimmed, and an incomplete skill is dropped when skills arrive through config, JSON or `setSkills` (`AddSkill` / `AddSkills` throw instead). The skill tool (`load_skill`, or `skillTool.toolName`) lists each name and description in its description; calling it returns the skill's `content` as a tool result, and skill text is never copied into the system message. Set skills at build time or replace them with `setSkills`; changing the catalog changes the tool schema.

The tool exists only when the agent has at least one skill, `skillTool.enabled` is not `false`, and the name is not excluded with `WithoutTools(...)`. If `allowedTools` is a name list it must include the tool name. Helpers: `resolveSkillToolName(config?)` (configured name or `load_skill`), `isSkillToolEnabled(skills, config?)`, `buildSkillCatalog(skills)`, `LOAD_SKILL_TOOL_NAME` / `DEFAULT_LOAD_SKILL_TOOL_NAME`. The tool factory itself, `createLoadSkillTool(skills, toolName?)`, is internal to the package.

## Routing policy

`ToolRoutingPolicy` controls the tool loop:

- `maxToolRounds`: max tool rounds per turn (default 10)
- `repeatCallLimit`: identical call signature limit (default 2)
- `deniedTools` / `deniedToolReason` / `perTurnToolLimits`: filled from the active [`AgentPolicy`](policy.md); set them there

Set `maxToolRounds` and `repeatCallLimit` with `MaxToolRounds` / `RepeatCallLimit` (top-level `maxToolRounds` / `repeatCallLimit` in config / JSON), `RoutingPolicy`, or a template's `routingPolicy` field. `options.max_tool_rounds` and `options.repeat_call_limit` are read as a last fallback. Precedence: top-level `maxToolRounds` > `routingPolicy.maxToolRounds` > `options.max_tool_rounds` > 10 (same order for the repeat limit, default 2). Non-positive or non-numeric values are skipped.
