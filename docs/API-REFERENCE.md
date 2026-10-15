# API reference map

One page that lists what the `poyraz` package exports, grouped by area. Each entry has a short description and a link to the page that covers it in detail. Everything is imported from `poyraz`:

```ts
import { AgentBuilder, defineTool, mcpClientManager, type AgentStreamEvent } from 'poyraz';
```

A clean `new AgentBuilder().Provider(p).Build()` is a plain text completion: every feature below is off until you enable it ([Agent API](agent-api.md#principle-a-clean-builder-is-a-plain-text-completion)).

Markers: **Deprecated** means a replacement exists and the symbol should not be used in new code. **Planned removal** means the symbol is slated to leave the package.

## Contents

- [Documentation pages](#documentation-pages)
- [Agent, config and builder](#agent-config-and-builder)
- [Agent policy](#agent-policy)
- [Chat, decision loop and events](#chat-decision-loop-and-events)
- [Context and token metering](#context-and-token-metering)
- [System prompt, rules and skills](#system-prompt-rules-and-skills)
- [Tools infrastructure](#tools-infrastructure)
- [Built-in tools](#built-in-tools)
- [MCP bridge](#mcp-bridge)
- [Providers, models and LLM types](#providers-models-and-llm-types)
- [Rate limits and aborts](#rate-limits-and-aborts)
- [Stats and usage](#stats-and-usage)
- [UI and presentation](#ui-and-presentation)
- [Logging and workspace](#logging-and-workspace)

## Documentation pages

| Page | Covers |
|------|--------|
| [Getting started](getting-started.md) | Install, minimal agent, turning features on, running without an API key |
| [Agent API](agent-api.md) | Every builder and agent method, the clean-builder principle, continuation |
| [Agent policy](policy.md) | `AgentPolicy`, allow-list, error breaker, response gates, per-turn limits |
| [Templates](templates.md) | `AgentTemplate` and `FromTemplate` / `FromJSON` |
| [Migrating to 1.0](migration-1.0.md) | Breaking changes of 1.0.0 with before / after and an upgrade checklist (see also the [changelog](../CHANGELOG.md)) |
| [Auth and providers](auth-and-providers.md) | Keys, model profiles, listing models, custom provider instance |
| [Tools](tools.md) and [Custom tools](custom-tools.md) | Built-in tools, presets, registry, `defineTool` |
| [Context and token metering](context.md) | Context categories, meters, estimator, summarization |
| [MCP](mcp.md) | Optional MCP on the agent, the shared manager, tool names |
| [Streaming](streaming.md) | `AgentStreamEvent` types, abort, activity tracker |
| [Rate limit and logging](rate-limit-and-logging.md) | Bounded rate-limit waiting, per-agent logging |
| [Workspace](workspace.md) | Workspace root and file logging helpers |
| [How it works](how-it-works.md) | Layering and runtime flow |
| [Evals](evals.md) | Eval harness |

## Agent, config and builder

| Symbol | What it does | Detail |
|--------|--------------|--------|
| `AgentBuilder` | Fluent builder; `Build()` finalizes tool selection and returns an `Agent`. Throws `AgentConfigError` without a provider or a model + host | [Agent API](agent-api.md#agentbuilder) |
| `AgentConfigError` | Thrown by `Build()` when the config cannot produce a working agent | [Agent API](agent-api.md#principle-a-clean-builder-is-a-plain-text-completion) |
| `Name`, `Model`, `LocalModel`, `RemoteModel`, `WithModelProfile`, `Provider`, `ApiKey` | Name, model, host, custom `LLMProvider`, API key | [Name and model](agent-api.md#name-and-model) |
| `Options`, `Reasoning`, `ServiceTier`, `PromptCacheRetention` | Provider options, reasoning effort, service tier, prompt cache retention. Nothing is sent unless set | [Name and model](agent-api.md#name-and-model) |
| `WithPresets`, `WithTools`, `WithoutTools`, `DefaultSystemTools`, `RegisterTool`, `AddTool`, `AddTools` | Tool selection; no selection → bare agent with no tools | [Tools](agent-api.md#tools) |
| `SystemPrompt`, `System`, `Rules`, `AddSkill`, `AddSkills`, `SkillTool` | Host system text (`System` is an alias, `SystemPrompt` wins), rules, skills, skill-tool switch and name | [System, rules and skills](agent-api.md#system-rules-and-skills) |
| `ContextLimit`, `ContextWindow`, `TokenEstimator`, `Summarization`, `AutoSummary`, `AutoSummaryThreshold` | Turn limit, token window, estimator tuning, rolling summary (`enabled`, `thresholdRatio`, `keepRatio`, `prompt`, `prefix`, `toolResultMaxChars`) | [Context and summarization](agent-api.md#context-and-summarization), [Context](context.md#configuration) |
| `RoutingPolicy`, `MaxToolRounds`, `RepeatCallLimit` | Tool round budget (default 10) and identical-call limit (default 2) | [Tool loop and routing](agent-api.md#tool-loop-and-routing) |
| `Repair`, `SameToolBreaker`, `ProgressTools` | Repair text on failed tool results (`resolvers` / `generic` for custom texts), same-tool loop breaker, progress tools. All off by default | [Tool loop and routing](agent-api.md#tool-loop-and-routing) |
| `Continuation(...policies)` | Host-defined continuation rules (`ContinuationPolicy`, chained with `chainContinuation`) | [Continuation](agent-api.md#continuation) |
| `Policy`, `AllowedTools`, `ErrorBreaker`, `ResponseGates`, `PerTurnToolLimits` | `AgentPolicy` section and its single-field shortcuts | [Agent policy](policy.md) |
| `Mcp`, `RateLimit`, `Logging`, `LogLevel`, `FileLogging`, `ChatDebugLog`, `LogSource` | Optional MCP, bounded rate-limit waiting, per-agent logging. All off by default | [MCP, rate limit and logging](agent-api.md#mcp-rate-limit-and-logging) |
| `FromTemplate`, `FromJSON` | Load an `AgentTemplate` / plain JSON config | [Templates](templates.md) |
| `Agent` | Runtime returned by `Build()`: `init()`, `chat()`, policy, tools, history, context | [Agent](agent-api.md#agent) |
| `AgentConfig` (type) | Full config: model/host/provider, `tools` / `excludeTools` (no `toolPresets` / `includeTools`: the builder resolves them into `tools`), `systemPrompt` / `system`, `rules`, `skills`, `skillTool`, `contextLimit`, `contextWindowTokens`, `summarization`, `tokenEstimator`, `reasoning`, `serviceTier`, `routingPolicy`, `maxToolRounds`, `repeatCallLimit`, `repair`, `sameToolBreaker`, `progressTools`, `continuation`, `policy`, `mcp`, `rateLimit`, `logging` | [Agent API](agent-api.md#agentbuilder), [Context](context.md#configuration) |
| `AgentTemplate` (type) | JSON-serializable subset of the config for `FromTemplate` | [Templates](templates.md) |
| `RepairConfig`, `SameToolBreakerConfig`, `SummarizationConfig`, `SummaryPromptBuilder`, `SkillToolConfig`, `AgentMcpConfig`, `RateLimitConfig`, `ResolvedRateLimitConfig`, `LoggingConfig`, `PolicyConfig` (types) | Shapes of the config sections | [Agent API](agent-api.md#agentbuilder) |
| `resolveAgentPolicy(policy?)`, `resolveRateLimitConfig(config?)` | Merge a partial policy over the default / resolve a rate-limit section after defaults | [Agent policy](policy.md), [Rate limit and logging](rate-limit-and-logging.md) |
| `DEFAULT_RATE_LIMIT_MAX_WAITS`, `DEFAULT_LOAD_SKILL_TOOL_NAME` | `3`, `'load_skill'` | [Rate limit and logging](rate-limit-and-logging.md), [`load_skill`](tools.md#load_skill) |
| `Skill` (type) | `{ name, description, content }` | [System, rules and skills](agent-api.md#system-rules-and-skills) |
| `agent.getModel` / `setModel`, `getModelProfile` / `setModelProfile`, `getName`, `setSessionId` / `getSessionId`, `getApiKeyPreview`, `getConfig` | Model, profile swap, session id, config | [Model and session](agent-api.md#model-and-session) |
| `agent.loadHistory`, `getHistory`, `getMessageHistory`, `summarize`, `setChatLogSource`, `getPromptCacheKey` | History restore/read, manual summary, debug tag, prompt cache key | [History and usage](agent-api.md#history-and-usage) |
| `agent.connectMcp`, `disconnectMcp`, `getMcpStates`, `getMcpToolPrefix`, `getRateLimitConfig`, `getToolRegistry` | MCP lifecycle of the agent, its MCP prefix, resolved rate-limit config, own tool registry. `connectMcp()` does not throw when a server fails: that server's state has `status: 'error'` | [MCP](mcp.md#optional-mcp-on-the-agent), [Connection errors](mcp.md#connection-errors-do-not-throw), [Agent API](agent-api.md#agent) |

## Agent policy

| Symbol | What it does | Detail |
|--------|--------------|--------|
| `AgentPolicy` (type) | Tool allow-list, deny reason, per-turn limits, error breaker, response gates | [AgentPolicy fields](policy.md#agentpolicy-fields) |
| `PolicyConfig` (type) | `Partial<AgentPolicy>`: what `Policy(...)` and `config.policy` take | [Setting a policy](policy.md#setting-a-policy) |
| `DEFAULT_AGENT_POLICY` | `{ id: 'default', allowedTools: 'all' }` | [Setting a policy](policy.md#setting-a-policy) |
| `ResponseGate`, `GateVerdict` (types) | Gate evaluated before a text-only reply is accepted; `accept` or `retry` | [ResponseGate](policy.md#responsegate) |
| `ErrorBreakerMode` (type) | `'off'` \| `'soft'` \| `'hard'` same-error circuit breaker | [AgentPolicy fields](policy.md#agentpolicy-fields) |
| `resolvePolicyTools(baseTools, policy)` | Tool names allowed by a policy | [AgentPolicy fields](policy.md#agentpolicy-fields) |
| `resolvePolicyDenied(baseTools, policy)` | Tool names denied by a policy | [AgentPolicy fields](policy.md#agentpolicy-fields) |
| `ContinuationPolicy`, `ContinuationContext`, `ContinuationDecision`, `ContinuationOutcome` (types) | Host-defined continuation rule, its input, `stop` / `continue` decision, and the outcome on the `chat()` result | [Continuation](agent-api.md#continuation) |
| `chainContinuation(...policies)` | Chain several continuation policies (first `continue` wins) | [Continuation](agent-api.md#continuation) |
| `agent.getPolicy` / `setPolicy`, `getTools` | Active policy; tools allowed under it | [Policy and tools](agent-api.md#policy-and-tools) |

## Chat, decision loop and events

| Symbol | What it does | Detail |
|--------|--------------|--------|
| `agent.chat(input, handlers?)` | Runs one turn of the decision loop: model → policy-filtered tools → response gates → context management. Returns `{ content, usage, contextUsage?, continuation? }` | [Chat](agent-api.md#chat), [How it works](how-it-works.md#runtime-flow) |
| `ChatHandlers` (type) | `{ onEvent?, signal? }` | [Streaming](streaming.md) |
| `AgentStreamEvent` (type) | `lifecycle`, `text.delta`, `reasoning.delta`, `context.usage`, `rate_limit.wait` / `rate_limit.resumed`, `tool.call.start` / `end` / `result` | [Event types](streaming.md#event-types) |
| `LifecyclePhase` (type) | `thinking` \| `summarizing` \| `summarized` | [Event types](streaming.md#event-types) |
| `emitEvent(handlers, event)` | Emit an event with the same shape from a custom loop | [Event types](streaming.md#event-types) |
| `rateLimitStreamEvent(notice)` | Turn a provider `RateLimitNotice` into a stream event | [Rate limit and logging](rate-limit-and-logging.md) |
| `ToolRoutingPolicy` (type) | `maxToolRounds`, `repeatCallLimit`, `deniedTools`, `deniedToolReason`, `perTurnToolLimits` (the last three come from the active policy) | [Routing policy](agent-api.md#routing-policy) |
| `builtinRepairResolvers` | Opt-in repair texts of the built-in `edit_file`, `run_terminal_cmd` and `grep`; never applied by default. Pass as `Repair({ enabled: true, resolvers: builtinRepairResolvers })` (**Planned removal** with the built-in tools) | [Tool loop and routing](agent-api.md#tool-loop-and-routing) |
| `RepairInput`, `RepairResolver`, `RepairOptions`, `ToolExecutionOptions` (types) | Input of a repair text builder, the builder type, the runtime view of `repair`, and the tool execution options of the loop | [Tool loop and routing](agent-api.md#tool-loop-and-routing) |

## Context and token metering

| Symbol | What it does | Detail |
|--------|--------------|--------|
| `CONTEXT_CATEGORIES`, `ContextCategory`, `ContextCategoryTokens` | The ten context categories and per-category number maps | [Categories](context.md#categories) |
| `emptyCategoryTokens()` | All-zero category map | [Categories](context.md#categories) |
| `agent.compileRequest(options?)` | The next request exactly as `chat()` sends it, with its estimate; no provider call | [Agent methods](context.md#agent-methods) |
| `agent.estimateContext(options?)` | Local per-category estimate of the next request | [Agent methods](context.md#agent-methods) |
| `agent.getContextMeterEstimate()` | Meter from the local estimate | [Agent methods](context.md#agent-methods) |
| `agent.getContextMeterReal()` | Meter from the last provider usage (zeros until a request completes) | [Agent methods](context.md#agent-methods) |
| `agent.getContextReal()` | Last completed request split by category, scaled to the provider total | [Agent methods](context.md#agent-methods) |
| `agent.getContextDrift()` | Estimate minus real for the last completed request | [Agent methods](context.md#agent-methods) |
| `agent.getContextRecords()` | Last 20 requests with estimate, real usage and drift | [Agent methods](context.md#agent-methods) |
| `agent.getTokenEstimator()` | The agent's `TokenEstimator` | [Agent methods](context.md#agent-methods) |
| `agent.calibrateEstimator(weight?)` | Move chars/token toward the last real request; host-triggered only | [Agent methods](context.md#agent-methods) |
| `agent.getMemoryUsage()` | Message count against `ContextLimit` | [Agent methods](context.md#agent-methods) |
| `createTokenEstimator(options?)` | Dependency-free chars/token estimator with `calibrate()` | [How the estimate works](context.md#how-the-estimate-works) |
| `DEFAULT_CHARS_PER_TOKEN`, `DEFAULT_MESSAGE_OVERHEAD_TOKENS` | Estimator defaults (3.5, 4) | [How the estimate works](context.md#how-the-estimate-works) |
| `estimateRequest(input)` | `ContextEstimate` from message entries, tool schemas and the system prompt | [Low-level helpers](context.md#low-level-helpers) |
| `scaleCategoriesToTotal(categories, target)` | Rescale category shares to an exact total | [Low-level helpers](context.md#low-level-helpers) |
| `buildMeter(source, categories, total, windowTokens)` | Build a `ContextMeter` | [Meter shape](context.md#meter-shape), [Low-level helpers](context.md#low-level-helpers) |
| `computeDrift`, `completeRecord`, `realSnapshot` | Drift, request/usage pairing, real breakdown | [Low-level helpers](context.md#low-level-helpers) |
| `categorizeMessage`, `buildMessageMeta`, `CategorizeOptions` (type) | Category and size metadata of one message | [Low-level helpers](context.md#low-level-helpers) |
| `createMessageContext(options)` | Standalone message context (history, trim, per-message meta) | [Low-level helpers](context.md#low-level-helpers) |
| `DEFAULT_SUMMARY_MESSAGE_PREFIX`, `DEFAULT_SUMMARY_PROMPT`, `buildSummaryPrompt(conversation, prompt?)` | Neutral English summary prefix and prompt, and the function that builds the summarization request | [Summarization](context.md#summarization) |
| `SUMMARY_MESSAGE_PREFIX`, `isSummaryMessage(message, prefix?)` | Default summary prefix (same as `DEFAULT_SUMMARY_MESSAGE_PREFIX`) and the detector; pass your `summarization.prefix` for a custom one | [Summarization](context.md#summarization), [History and usage](agent-api.md#history-and-usage) |
| Types: `CompiledRequest`, `CompiledToolSchema`, `CompileRequestOptions`, `ContextEstimate`, `ContextMeter`, `ContextDrift`, `ContextRealSnapshot`, `ContextRequestRecord`, `MessageContextMeta`, `ToolSchemaCategory`, `SystemPromptParts`, `EstimateRequestInput`, `MessageEntry`, `TokenEstimator`, `TokenEstimatorOptions`, `CalibrationSample`, `ContextOptions`, `MessageContext`, `MemoryUsage` | Shapes used by the APIs above | [Low-level helpers](context.md#low-level-helpers) |

## System prompt, rules and skills

| Symbol | What it does | Detail |
|--------|--------------|--------|
| `buildSystemPrompt(system?, rules?, skills?, options?)` | `{ content, cacheKey, parts }`: system text then rules, nothing added by the library; skill catalog only in `parts.skills` (`options.skillCatalog: false` empties it) | [System prompt, rules and skills](agent-api.md#system-prompt-rules-and-skills), [Context](context.md#system-prompt-parts) |
| `BuiltSystemPrompt`, `SystemPromptParts` (types) | Built prompt and its `system` / `rules` / `skills` parts | [System prompt parts](context.md#system-prompt-parts) |
| `agent.setSystemPrompt(text)`, `rebuildSystemPrompt()` | Replace / re-apply the system message | [Policy and tools](agent-api.md#policy-and-tools) |
| `agent.setRules(rules)` | Replace host rules and rebuild the system message | [Policy and tools](agent-api.md#policy-and-tools) |
| `agent.setSkills(skills)` | Replace skills; `load_skill` and its catalog follow | [Policy and tools](agent-api.md#policy-and-tools) |
| `LOAD_SKILL_TOOL_NAME` | `'load_skill'` (default skill tool name) | [`load_skill`](tools.md#load_skill) |
| `resolveSkillToolName(config?)`, `isSkillToolEnabled(skills, config?)` | Configured skill tool name; whether the tool is exposed for these skills and `skillTool` config | [`load_skill`](tools.md#load_skill) |
| `buildSkillCatalog(skills)` | `name: description` per line, as in the `load_skill` description | [`load_skill`](tools.md#load_skill) |

## Tools infrastructure

| Symbol | What it does | Detail |
|--------|--------------|--------|
| `defineTool(def)` | Define a tool with a Zod `inputSchema`, `execute`, optional `presentation` / `meta` | [Custom tools](custom-tools.md#example) |
| `ToolDefinition`, `ToolResult`, `ToolContext`, `ToolMeta`, `ToolCategory`, `ToolPresentation`, `ToolResultSummary`, `LastReadFileState`, `ToolHostAgent` (types) | Tool shapes and the context passed to `execute` | [`execute` return values](custom-tools.md#execute-return-values), [`ToolContext`](custom-tools.md#toolcontext), [Presentation and meta](custom-tools.md#presentation-and-meta) |
| `Tool` (type) | **Deprecated**: use `ToolDefinition` | [Custom tools](custom-tools.md) |
| `ToolDefinition.schema` | **Deprecated**: use `inputSchema` | [Custom tools](custom-tools.md) |
| `getToolSchema(tool)`, `normalizeToolResult(result)` | Zod schema of a tool; normalize `execute` output to `ToolResult` | [`execute` return values](custom-tools.md#execute-return-values) |
| `toolRegistry`, `ToolRegistry`, `createToolRegistry(parent?)` | Shared registry (`register`, `registerMany`, `unregister`, `get`, `list`, `listNames`, `resolveToolSet`, `toOpenAISchemas`, `toCatalogEntries`, `getPresentation`), its class, and a factory for a registry layered over a parent (writes stay local). Each agent and builder has its own | [Inspecting the registry](tools.md#inspecting-the-registry) |
| `toOpenAISchema(tool)` | Provider schema of one tool (`parametersJsonSchema` wins over Zod) | [Provider schemas](custom-tools.md#provider-schemas) |
| `TOOL_PRESETS`, `ToolPresetName` | `filesystem` / `shell` / `search` preset map (**Planned removal** with the built-ins) | [Presets](tools.md#presets) |
| `TOOL_ALIASES`, `resolveCanonicalToolName(name)` | Tool name aliases (currently empty) | [Inspecting the registry](tools.md#inspecting-the-registry) |
| `TOOL_PRESENTATIONS`, `withPresentation(name, partial?)` | Default UI presentation per built-in tool | [Presentation and meta](custom-tools.md#presentation-and-meta) |
| `ToolRoutingPolicy` (type) | Tool loop limits | [Routing policy](agent-api.md#routing-policy) |
| `agent.mergeExternalTools(tools)` | Add external (MCP or other) tools after build. They are registered in the agent's own registry (`getToolRegistry()`), never in the shared `toolRegistry`; returns the names that replaced an existing tool | [Register vs add](custom-tools.md#register-vs-add), [Policy and tools](agent-api.md#policy-and-tools) |
| `agent.removeExternalTools(prefix?)` | Remove tools by name prefix (default: the configured MCP prefix, `mcp_`) and unregister them from the agent's registry | [Policy and tools](agent-api.md#policy-and-tools) |
| `load_skill` tool | Name configurable with `SkillTool({ toolName })`. Present only with at least one skill and not disabled; returns a skill's `content` | [`load_skill`](tools.md#load_skill) |

## Built-in tools

**Planned removal:** the built-in tools below (`tools/definitions/fs.ts`, `grep.ts`, `system.ts`), their presets and the helpers that exist only for them are slated for removal. Prefer your own `defineTool` tools in new hosts.

| Symbol | What it does | Detail |
|--------|--------------|--------|
| `builtinTools` | Name → definition map of registered built-ins (**Planned removal**) | [Inspecting the registry](tools.md#inspecting-the-registry) |
| `read_file`, `edit_file`, `list_dir`, `glob_file_search`, `delete_file` | Filesystem tools, preset `filesystem` (**Planned removal**) | [`read_file`](tools.md#read_file), [`edit_file`](tools.md#edit_file), [`list_dir`](tools.md#list_dir), [`glob_file_search`](tools.md#glob_file_search), [`delete_file`](tools.md#delete_file) |
| `grep` | Ripgrep search, preset `search` (**Planned removal**) | [`grep`](tools.md#grep) |
| `run_terminal_cmd` | Shell command with per-session cwd, preset `shell` (**Planned removal**) | [`run_terminal_cmd`](tools.md#run_terminal_cmd) |
| `setActiveWorkspaceRoot(root)` | Workspace root used by shell tools for cwd resolution (**Planned removal** with the shell tool) | [Workspace](workspace.md) |
| `getShellCwd`, `setShellCwd`, `resetShellSessions`, `prepareShellCommand`, `extractLastCdTarget`, `resolveCdChain`, `syncSessionCwdFromCommand`, `shellResultMeta`, `PreparedShellCommand` | Shell session helpers behind `run_terminal_cmd` (**Planned removal**) | [`run_terminal_cmd`](tools.md#run_terminal_cmd) |
| `computeChangedLineRanges`, `formatChangedRangesSummary`, `formatEditResultContent`, `formatEditMetaSummary`, `formatEditArgsSummary`, `isSuspiciousPartialMerge`, `stripMarkersFromCodeEdit`, `ADD_ONLY_PARTIAL_THRESHOLD`, `ChangedLineRange`, `EditKind`, `EditFileStructuredResult` | Diff and summary helpers behind `edit_file` (**Planned removal**) | [`edit_file`](tools.md#edit_file) |

## MCP bridge

| Symbol | What it does | Detail |
|--------|--------------|--------|
| `mcpClientManager` | Shared default manager: `connectAll(servers)` → bridged tools, `connect`, `disconnect`, `disconnectAll`, `getTools`, `listStates`. An agent with `Mcp({ enabled: true })` never uses it | [Connect](mcp.md#connect), [Status](mcp.md#status) |
| `McpClientManager`, `createMcpClientManager(options?)`, `McpClientManagerOptions` | A manager of your own (`toolPrefix`), so connections and tool names are not shared | [Optional MCP on the agent](mcp.md#optional-mcp-on-the-agent) |
| `McpServerDef`, `McpStdioServerDef`, `McpHttpServerDef`, `McpServerEntry`, `McpConfig` (types) | Server definitions you pass in (stdio or HTTP) | [Types](mcp.md#types) |
| `isMcpHttpServerDef(def)` | Narrow a definition to HTTP | [Types](mcp.md#types) |
| `McpConnectionStatus`, `McpServerState` (types) | `connected` \| `error` \| `disabled` and per-server state | [Status](mcp.md#status) |
| `MCP_TOOL_PREFIX`, `mcpToolName(serverId, toolName, used?, prefix?)`, `isMcpToolName(name, prefix?)`, `resolveMcpToolPrefix(prefix?)` | Default `mcp_` prefix, bridged name builder (`<prefix><server>__<tool>`, sanitized, max 64 chars), prefix test, and prefix resolution (blank → `mcp_`) | [Tool names](mcp.md#tool-names) |
| `agent.mergeExternalTools` / `removeExternalTools` | Attach / detach bridged tools on an agent | [Connect](mcp.md#connect), [Policy and tools](agent-api.md#policy-and-tools) |

## Providers, models and LLM types

| Symbol | What it does | Detail |
|--------|--------------|--------|
| `ModelProfile`, `ModelProviderKind`, `ProviderApiKeys` (types) | Model + host + provider; explicit key bag | [Model profiles](auth-and-providers.md#model-profiles), [Passing keys](auth-and-providers.md#passing-keys) |
| `openAiProfile`, `groqProfile`, `geminiProfile`, `openRouterProfile`, `ollamaProfile`, `llamaCppProfile` | Profile factories (`llamaCppProfile(model, host?)`: host default `http://127.0.0.1:8080`) | [Model profiles](auth-and-providers.md#model-profiles) |
| `resolveApiKeyForProfile(profile, keys)` | Pick the key for a profile; never reads `process.env` | [Passing keys](auth-and-providers.md#passing-keys) |
| `inferProviderFromHost`, `formatProviderLabel`, `llamaCppApiBase` | Provider from host URL (OpenAI, Groq, OpenRouter, Gemini; anything else is `'ollama'`, llama.cpp is never inferred), display label, llama.cpp API base (`<host>/v1`) | [Model profiles](auth-and-providers.md#model-profiles) |
| `DEFAULT_OPENAI_HOST`, `DEFAULT_GROQ_HOST`, `DEFAULT_GEMINI_HOST`, `DEFAULT_GEMINI_API_BASE`, `DEFAULT_OPENROUTER_HOST`, `DEFAULT_OLLAMA_HOST`, `DEFAULT_LLAMACPP_HOST`, `LLAMACPP_MAX_TOOLS`, `LLAMACPP_ANONYMOUS_API_KEY` | Default hosts and llama.cpp constants | [Model profiles](auth-and-providers.md#model-profiles) |
| `openRouterDefaultHeaders({ referer?, title? })` | OpenRouter app headers | [Model profiles](auth-and-providers.md#model-profiles) |
| `inferProfileForModel`, `findModelProfile`, `rowToModelProfile` | Resolve a profile from a model id or a listed row | [Model profiles](auth-and-providers.md#model-profiles) |
| `listAggregatedChatModels(env)`, `groupModelsByProvider`, `groupOpenRouterByTier`, `classifyOpenRouterTier` | List and group chat models across providers | [Listing models](auth-and-providers.md#listing-models) |
| `ListedChatModelRow`, `ListChatModelsEnv`, `OpenRouterTier` (types) | Model listing shapes | [Listing models](auth-and-providers.md#listing-models) |
| `fetchModelInfo(profile, env)`, `fetchModelInfoForId(modelId, env)`, `ModelInfo` (type) | Model metadata (context length, pricing, description; Ollama family / size / quantization) built from the model listing; `limitedMetadata: true` when little is known. `…ForId` returns `null` for an unknown id | [Model info](auth-and-providers.md#model-info) |
| `createLLMProvider(profile, apiKey?, options?)`, `CreateProviderOptions` | Provider instance for a profile. `options.rateLimit` enables bounded waiting on the OpenAI-compatible providers | [Custom provider instance](auth-and-providers.md#custom-provider-instance) |
| `OpenAIProvider`, `OllamaProvider` | Provider classes (`OpenAIProvider` covers OpenAI, Groq, OpenRouter and llama.cpp; Gemini has its own internal provider) | [Custom provider instance](auth-and-providers.md#custom-provider-instance), [Rate limit and logging](rate-limit-and-logging.md) |
| `LLMProvider`, `ChatMessage`, `ChatOptions`, `ChatResponse`, `ToolCall`, `TokenUsage`, `AgentError`, `ReasoningConfig`, `ReasoningEffort`, `ServiceTier`, `RateLimitPolicy` (types) | Provider interface and message types. `ChatOptions.model` is optional: it is sent only when set | [Custom provider instance](auth-and-providers.md#custom-provider-instance), [Name and model](agent-api.md#name-and-model) |
| `agent.setModelProfile(profile, apiKey)` | Swap model and provider at runtime | [Switching models at runtime](auth-and-providers.md#switching-models-at-runtime) |

## Rate limits and aborts

Waiting on a rate-limit rejection is **off by default**; enable it with `RateLimit({ enabled: true })` ([Rate limit and logging](rate-limit-and-logging.md)).

| Symbol | What it does | Detail |
|--------|--------------|--------|
| `RateLimitConfig`, `ResolvedRateLimitConfig`, `resolveRateLimitConfig`, `DEFAULT_RATE_LIMIT_MAX_WAITS` | Builder section, its resolved form and the default wait budget (3) | [Rate limit and logging](rate-limit-and-logging.md#rate-limit) |
| `RateLimitPolicy` (type), `DISABLED_RATE_LIMIT` | Policy handed to providers through `ChatOptions.rateLimit`; the frozen "no waiting" policy providers use unless told otherwise | [Rate limit and logging](rate-limit-and-logging.md#rate-limit) |
| `withRateLimitPolicy(provider, policy)` | Wrap any `LLMProvider` so every call carries the policy | [Rate limit and logging](rate-limit-and-logging.md#rate-limit) |
| `withRateLimitRetry`, `RateLimitRetryOptions` | Bounded wait-and-repeat wrapper the providers use on 429 | [Streaming](streaming.md#rate-limits) |
| `RateLimitExceededError`, `RateLimitExceededReason` | Thrown when the wait budget (`maxWaits` / `maxTotalWaitMs`) runs out; `reason`, `waits`, `waitedMs`, provider error as `cause` | [Rate limit and logging](rate-limit-and-logging.md#rate-limit) |
| `resolveRateLimitDelay`, `RateLimitDelay`, `parseDurationMs`, `rateLimitReason`, `isRateLimitError` | Delay resolution from headers / message / fallback | [Streaming](streaming.md#rate-limits) |
| `RATE_LIMIT_FALLBACK_DELAY_MS`, `RATE_LIMIT_MIN_DELAY_MS`, `RATE_LIMIT_MAX_DELAY_MS`, `RATE_LIMIT_DEFAULT_MAX_WAITS` | 20s fallback, clamp 1s..10min, 3 waits | [Streaming](streaming.md#rate-limits) |
| `RateLimitNotice`, `RateLimitWait`, `RateLimitDelaySource` (types) | Provider notices behind `rate_limit.*` events | [Event types](streaming.md#event-types) |
| `sleepWithSignal(ms, signal?)`, `isAbortError` | Abortable sleep; abort error check | [Streaming](streaming.md#rate-limits) |
| `ChatAbortedError`, `assertNotAborted(signal?)` | Error thrown when a turn is aborted; guard | [Streaming](streaming.md), [Chat](agent-api.md#chat) |

## Stats and usage

| Symbol | What it does | Detail |
|--------|--------------|--------|
| `agent.getStats()` | `{ current, session }` provider token totals | [History and usage](agent-api.md#history-and-usage) |
| `agent.getContextUsage()` | Usage of the last model request of the turn (window occupancy) | [History and usage](agent-api.md#history-and-usage), [Agent methods](context.md#agent-methods) |
| `agent.setSessionUsage(usage)` | Seed session totals | [History and usage](agent-api.md#history-and-usage) |
| `agent.recordExternalUsage(usage)` | Roll subagent usage into `current` and `session` | [History and usage](agent-api.md#history-and-usage) |
| `chat()` result `usage` / `contextUsage` | Turn billing vs last-request occupancy | [Chat](agent-api.md#chat) |
| `context.usage` event | Per-request usage while the turn runs | [Event types](streaming.md#event-types) |

`createTokenStats` (`application/stats/token-stats.ts`) is internal and not exported.

## UI and presentation

| Symbol | What it does | Detail |
|--------|--------------|--------|
| `createActivityTracker(registry?)` | New tracker (optionally resolving presentations from a given `ToolRegistry`): `{ activities: Map, lifecyclePhase? }` | [Streaming](streaming.md), [How it works](how-it-works.md#layering) |
| `applyStreamEvent(tracker, event)` | Fold an `AgentStreamEvent` into the tracker; returns the changed `ToolActivityView` or `null` | [Streaming](streaming.md) |
| `getLifecycleLabel(phase?)` | Human label for a lifecycle phase | [Event types](streaming.md#event-types) |
| `ActivityTracker`, `ToolActivityView`, `ActivityStatus` (types) | Tool activity view model (`running` \| `success` \| `error` \| `blocked`) | [Streaming](streaming.md) |
| `ToolPresentation` (`presentation` on a tool) | Label, icon, arg/result summaries, `sensitiveArgKeys` | [Presentation and meta](custom-tools.md#presentation-and-meta) |

## Logging and workspace

Logging is per agent and off by default (`Logging(...)`, [Rate limit and logging](rate-limit-and-logging.md#logging)). An agent never changes the shared `logger`.

| Symbol | What it does | Detail |
|--------|--------------|--------|
| `LoggingConfig` (type) | `{ level, file, chatDebugLog, source }` | [Rate limit and logging](rate-limit-and-logging.md#logging) |
| `logger`, `LogLevel` | Shared process-wide logger (silent until you configure it) and levels | [Rate limit and logging](rate-limit-and-logging.md#logging) |
| `Logger`, `createLogger(options?)`, `LoggerOptions` | An independent logger with its own level and file (what each agent uses) | [Rate limit and logging](rate-limit-and-logging.md#logging) |
| `runWithLogger(logger, fn)`, `scopeToLogger(logger, fn)` | Run code (or wrap a function) so the shared `logger` forwards to a scoped logger | [Rate limit and logging](rate-limit-and-logging.md#logging) |
| `configureFileLogging(config)`, `getConfiguredLogDir()`, `isFileLoggingEnabled()`, `FileLoggingConfig` | Process-wide file logging (`agent.log`); fallback log dir for chat debug files | [Workspace](workspace.md) |
| `setActiveWorkspaceRoot(root)` | Workspace root for shell tools (**Planned removal**) | [Workspace](workspace.md) |
