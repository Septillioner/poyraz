# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.2.0] - 2026-10-24

### Added

- Lifecycle hooks on `AgentBuilder` / `Agent`: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `UserPromptSubmit`, `Stop`, `Interrupt`, `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `PreCompact`, and `PostCompact`. A matcher is a regular expression (tool name or subagent id). Hook output can allow, ask, deny, replace tool input, or block. `runHooks` runs the chain.

### Changed

- Reorganized the README with a clearer project overview, package badges, tool and streaming examples, provider information, and a documentation guide.
- Synchronized the package and lockfile versions; the lockfile previously still identified the root package as `1.0.0`.

## [1.1.2] - 2026-10-16

### Added

- Token pricing and cost calculation for agent requests.
- Policy: `AgentPolicy.allowedTools` entries may be `*` patterns (`'mcp_*'`), `AgentPolicy.deniedTools` / `DeniedTools(...names)` (deny wins over allow) and `AgentPolicy.maxToolRounds` (precedence: top-level `maxToolRounds` > policy > `routingPolicy` > `options.max_tool_rounds`). New helpers `matchesToolPattern`, `matchesAnyToolPattern`. See [docs/policy.md](docs/policy.md#tool-name-patterns).
- Summarization hook: `summarization.onSummarized` / `OnSummarized(hook?)` runs after each summary with a `SummarizedContext` (summary text, replaced / kept message counts, token estimate before / after, history snapshot, session id); the text it returns is appended to the summary message. Off by default. See [docs/context.md](docs/context.md#after-summary-hook).
- Runtime settings on `Agent`: `getReasoning` / `setReasoning`, `getServiceTier` / `setServiceTier`, `getContextWindow` / `setContextWindow`, `getMaxToolRounds` / `setMaxToolRounds`. They apply from the next turn (a running turn keeps its values), `getConfig()` reflects them, and invalid values throw `AgentConfigError` ([Agent API](docs/agent-api.md#runtime-settings)). The agent now works on a copy of the config object it is given.
- `resolveContextWindow({ model, host?, provider?, catalog?, providerCache?, staticTable? })`: resolves a model's context window from a catalog, then a provider cache, then a static table, and returns `{ tokens, source }`. With `normalizeContextWindow` and `MIN_CONTEXT_WINDOW_TOKENS` ([Context](docs/context.md#resolving-the-window)).
- MCP sync: `agent.syncMcp(servers?, options?)` and `McpClientManager.sync(servers, options?)` connect only added or changed servers, disconnect removed ones and leave unchanged ones alone; they return `McpSyncResult` (`added`, `changed`, `removed`, `unchanged`, `retried`, `states`, `tools`) and never throw for a failing server. Calls are serialized (also with `connectMcp()` / `disconnectMcp()`); with `mcp.enabled` off `syncMcp` does nothing. New types `McpSyncOptions` (`retryFailed`) and `McpSyncResult` ([MCP](docs/mcp.md#sync-reconnect-only-what-changed)).
- Tool result size limit: `toolResultMaxChars` / `toolResultMaxBytes` (`ToolResultMaxChars(n)` / `ToolResultMaxBytes(n)`, `FromJSON`). Off by default; a longer result is cut and ends with a `[truncated: ...]` note, and the call meta carries `toolResultTruncated`. New `limitToolResult` and `ToolResultLimit` ([Agent API](docs/agent-api.md#tool-loop-and-routing)).
- `ToolUseUnsupportedError`, `isToolUseUnsupportedError(error)` and `TOOL_USE_UNSUPPORTED_CODE`: providers made by `createLLMProvider` throw it when a model cannot take tools (OpenRouter, OpenAI, Ollama, Gemini, Groq, llama.cpp / vLLM wordings); the provider error stays as `cause` and its text as `message` ([Auth and providers](docs/auth-and-providers.md#models-without-tool-support)).

### Changed

- `McpClientManager.disconnect(id)` also forgets the server's state (it used to leave a stale entry in `listStates()`). Operations that change connections now run one after the other.

### Fixed

- `summarize()` (and a context trim) no longer throws `Cannot read properties of undefined (reading 'role')` when the history holds fewer conversation turns than the kept tail (for example two messages): nothing is summarized, the history is left as it is and `onSummarized` is not called.

## [1.0.0] - 2026-10-15

A clean `new AgentBuilder()` is now a plain text completion: every feature is off until enabled. Upgrade steps and before / after examples: [docs/migration-1.0.md](docs/migration-1.0.md).

### Changed (breaking)

- The builder adds nothing by itself: no default model (`gpt-4o`), host, `temperature` / `num_ctx` options or prompt cache key. `Build()` throws `AgentConfigError` without a `Provider(...)` or a model and host. `ChatOptions.model` is optional.
- An empty tool selection means no tools (it used to mean every registered tool). `AgentConfig.toolPresets` / `includeTools` are removed; they remain in `AgentTemplate` / `FromJSON`.
- `RegisterTool`, `mergeExternalTools` and `removeExternalTools` use per-instance registries and no longer write to the shared `toolRegistry`; `mergeExternalTools` returns the replaced names (`string[]`).
- Repair text is off by default; the built-in tool texts are opt-in through `builtinRepairResolvers`. The same-tool breaker, progress tools, `maxToolRounds` and `repeatCallLimit` are configuration (`SameToolBreaker`, `ProgressTools`, `MaxToolRounds`, `RepeatCallLimit`).
- Rate-limit waiting is off by default and bounded when enabled; running out of budget throws `RateLimitExceededError`.
- MCP is optional on the agent (`Mcp(...)`); `connectMcp()` does not throw on a failing server.
- The summary prefix and prompt are neutral English. Pass `summarization.prefix` for history that holds the old Turkish prefix.
- Logging is per agent; the chat debug log is written only with `logging.chatDebugLog`; `ChatDebugLogSource` is a free string.
- OpenAI requests no longer carry an empty `tools` array, and `reasoning` is sent only with `Reasoning({ effort })`.
- `context.usage` `final: true` is published after response gates and the continuation decision.

### Added

- Optional sections and builder methods: `Repair`, `SameToolBreaker`, `ProgressTools`, `MaxToolRounds`, `RepeatCallLimit`, `Continuation`, `AllowedTools` / `ErrorBreaker` / `ResponseGates` / `PerTurnToolLimits`, `Summarization`, `SkillTool`, `TokenEstimator`, `Mcp`, `RateLimit`, `Logging`.
- Context metering: `compileRequest`, `estimateContext`, `getContextMeter*`, `getContextReal`, `getContextDrift`, `getContextRecords`, `calibrateEstimator`, ten context categories.
- Agent: `connectMcp`, `disconnectMcp`, `getMcpStates`, `getMcpToolPrefix`, `getRateLimitConfig`, `getToolRegistry`.

### Removed

- `BASE_PROMPT`, `deterministicMode`, `AgentConfig` / `AgentTemplate` `workflow`, `thinking`, `deepThinking`, `order`, `RemoteContext()` / `remoteContextUrl`, the `poyraz-2.0.json` template, and `docs/modes.md` (now `docs/policy.md`).
