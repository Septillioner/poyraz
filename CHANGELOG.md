# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/).

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
