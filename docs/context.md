# Context and token metering

The agent keeps the chat history in a message context, tags every message with a category when it is stored, and measures each model request before it is sent. After the provider answers, the reported usage is paired with that estimate. Hosts can read both sides at any time, for example to drive a context-window meter.

```ts
import { AgentBuilder, CONTEXT_CATEGORIES, openAiProfile } from 'poyraz';

const agent = new AgentBuilder()
  .WithModelProfile(openAiProfile('gpt-4o-mini'))
  .ApiKey(apiKey)
  .ContextWindow(128_000)
  .TokenEstimator({ charsPerToken: 3.5 })
  .Build();

await agent.init();

const before = agent.getContextMeterEstimate(); // local, no provider call
await agent.chat('Hello');
const after = agent.getContextMeterReal();      // provider-reported, split by category

for (const key of CONTEXT_CATEGORIES) {
  console.log(key, after.categories[key]);
}
console.log(after.total, after.windowTokens, after.percent);

if (Math.abs(agent.getContextDrift()?.percent ?? 0) > 10) {
  agent.calibrateEstimator(); // host decides when to correct
}
```

## Categories

`CONTEXT_CATEGORIES` lists every category in a fixed order. `ContextCategory` is its union type and `ContextCategoryTokens` maps each one to a number. `emptyCategoryTokens()` returns an all-zero map.

| Category | What it counts |
|----------|----------------|
| `system` | Host system text (the system message minus rules) |
| `rules` | Host rules appended to the system message |
| `skills` | The skill tool schema (the skill catalog; `load_skill` or your `skillTool.toolName`) and loaded skill bodies |
| `tools` | Tool schemas that are not MCP-bridged |
| `mcp` | Tool schemas bridged from MCP servers (name prefix `mcp.toolPrefix`, default `mcp_`) |
| `summary` | Rolling summary message (a `user` message starting with `summarization.prefix`) |
| `conversation` | User text and assistant text |
| `toolCalls` | Assistant `tool_calls` (id, name, arguments) |
| `toolResults` | `role: 'tool'` messages, except skill tool results (those count as `skills`) |
| `providerMeta` | Provider replay payload beyond what is already counted as text or tool calls |

Message categories are assigned when a message is stored. Tool schema categories are assigned when the request is compiled. Nothing is guessed at measurement time.

## Configuration

Everything is off or unset by default: with no `ContextLimit`, no `ContextWindow` and no summarization the history only grows and the meter has no window.

| Builder method | `AgentConfig` field | Effect |
|----------------|---------------------|--------|
| `ContextWindow(tokens)` | `contextWindowTokens` | Window size for meter percentages and token-based summarization. Ignored below 1000. Omitted → `windowTokens` and `percent` are `null` |
| `ContextLimit(n)` | `contextLimit` | Turn limit for trim / summary |
| `Summarization(config \| boolean)` | `summarization` | Rolling summary instead of trimming; see [Summarization](#summarization) |
| `AutoSummary(enabled?)` | `autoSummary` | Shortcut for `summarization.enabled` |
| `AutoSummaryThreshold(ratio)` | `summaryThresholdRatio` | Shortcut for `summarization.thresholdRatio`. Clamped to 0.5..0.95. Default 0.8 |
| `TokenEstimator(options)` | `tokenEstimator` | `TokenEstimatorOptions`: `charsPerToken` (default 3.5, clamped to 1..8) and `messageOverheadTokens` (default 4) |

`AgentTemplate` and `FromJSON` accept `contextWindowTokens`, `summaryThresholdRatio`, `contextLimit`, `autoSummary`, `summarization` and `tokenEstimator`.

## Summarization

Summarization is off by default. Turn it on with `Summarization({ enabled: true })` (or `AutoSummary()`); the other fields only tune it.

```ts
new AgentBuilder()
  .Provider(provider)
  .ContextLimit(40)
  .ContextWindow(128_000)
  .Summarization({
    enabled: true,
    thresholdRatio: 0.8,   // summarize when the last prompt reaches 80% of the window
    keepRatio: 0.6,        // keep ~60% of ContextLimit verbatim
    prefix: 'Earlier conversation:',
    prompt: (conversation) => `Summarize briefly:\n\n${conversation}`,
    toolResultMaxChars: 200,
  })
  .Build();
```

| Field | Default | Meaning |
|-------|---------|---------|
| `enabled` | `false` | Summarize instead of trimming when `ContextLimit` is exceeded or the token threshold is reached |
| `thresholdRatio` | `0.8` | Window occupancy that triggers token-based summarization (needs `ContextWindow`). Clamped to 0.5..0.95 |
| `keepRatio` | `0.6` | Share of `ContextLimit` kept verbatim after a summary. Clamped to 0.1..0.9. Applies to summaries only: a plain trim (summarization off) keeps the default 0.6 |
| `prompt` | `DEFAULT_SUMMARY_PROMPT` | Neutral English prompt. A string may hold `{{conversation}}` (appended when absent) or pass a function `(conversation) => string` (code only; JSON templates take a string) |
| `prefix` | `DEFAULT_SUMMARY_MESSAGE_PREFIX` = `Summary of the earlier conversation:` | Start of the summary message (`<prefix> <summary text>`). It is also how a stored summary is recognized, so keep it stable for persisted histories |
| `toolResultMaxChars` | `200` | Tool results are cut to this many characters in the summarization input |

Defaults live in one place (`application/context/summary-settings.ts`) and are exported: `DEFAULT_SUMMARY_MESSAGE_PREFIX`, `DEFAULT_SUMMARY_PROMPT`, `buildSummaryPrompt(conversation, prompt?)`.

**Old histories.** Earlier versions wrote the summary message with the Turkish prefix `Önceki konuşmaların özeti:`. The default is now the neutral English prefix. A host that loads history stored with the old prefix must pass `summarization.prefix: 'Önceki konuşmaların özeti:'`; otherwise those messages are no longer recognized as summaries (they count as plain conversation and are summarized again as such).

## Agent methods

| Method | Returns | Description |
|--------|---------|-------------|
| `compileRequest(options?)` | `CompiledRequest` | The next request exactly as `chat()` sends it: `model`, `messages` (copy of the history array), policy-filtered `tools`, `parts` (system / rules / skills text), `toolSchemas` (name, category, chars) and `estimate`. Does not call the provider. `{ includeTools: false }` compiles a tool-less request |
| `estimateContext(options?)` | `ContextEstimate` | Shortcut for `compileRequest(options).estimate`: `categories`, `total`, `chars`, `overheadTokens` |
| `getContextMeterEstimate()` | `ContextMeter` | Meter from the local estimate (`source: 'estimate'`). Safe to call any time |
| `getContextMeterReal()` | `ContextMeter` | Meter from the last provider-reported usage (`source: 'real'`). All zeros until a request has completed |
| `getContextReal()` | `ContextRealSnapshot \| undefined` | Last completed request: `usage`, per-category split scaled to `promptTokens`, `total`, the `estimate` and the `drift` |
| `getContextDrift()` | `ContextDrift \| undefined` | Estimate minus real for the last completed request: `tokens`, `ratio`, `percent`. Positive means the estimate ran high |
| `getContextRecords()` | `ContextRequestRecord[]` | Last 20 requests, newest last: `seq`, `at`, `model`, `estimate`, `real?`, `drift?` |
| `getTokenEstimator()` | `TokenEstimator` | The estimator this agent uses |
| `calibrateEstimator(weight?)` | `number \| undefined` | Moves `charsPerToken` toward the last real request (moving average, default weight 0.5). Returns the new ratio, or `undefined` before the first completed request. Never runs on its own |
| `getContextUsage()` | `TokenUsage \| undefined` | Raw usage of the last model request of the current turn. Readable after an aborted turn |
| `getMemoryUsage()` | `MemoryUsage` | Non-system message count with `limit` / `percentage` (`null` without `ContextLimit`) |
| `summarize(handlers?)` | `Promise<void>` | Run the rolling summary manually |

`getContextReal()`, `getContextDrift()` and the real meter are reset to "no data" after `loadHistory`, `summarize`, an auto-summary or a trim, because the last real request no longer matches the history.

`chat()` returns `{ content, usage, contextUsage? }`. `usage` is billing for every tool round of the turn. `contextUsage` is the last request only, which is what occupies the window. The `context.usage` stream event carries the same per-request figures ([Streaming](streaming.md#event-types)).

## Meter shape

```ts
interface ContextMeter {
  source: 'estimate' | 'real';
  categories: ContextCategoryTokens;
  total: number;
  windowTokens: number | null; // ContextWindow, or null
  percent: number | null;      // total / windowTokens * 100, one decimal, not capped
}
```

## How the estimate works

- `createTokenEstimator(options?)` returns a `TokenEstimator`: `charsPerToken`, `messageOverheadTokens`, `estimateText(text)`, `tokensForChars(chars)` and `calibrate(sample, weight?)`. A token count is `ceil(chars / charsPerToken)`, plus a fixed overhead per message. No tokenizer dependency.
- `DEFAULT_CHARS_PER_TOKEN` (3.5) and `DEFAULT_MESSAGE_OVERHEAD_TOKENS` (4) are exported.
- Characters are summed per category first and converted once. After calibration the new ratio applies to everything already stored.
- The real breakdown is the estimate's category shares, scaled so they add up to the provider's `promptTokens` (largest-remainder rounding).

## Low-level helpers

These are exported for hosts that build their own meter or loop. `Agent` already uses them.

| Export | Description |
|--------|-------------|
| `estimateRequest(input)` | `ContextEstimate` from `EstimateRequestInput`: `entries` (`MessageEntry[]`: message + meta), `toolSchemas`, optional `systemPrompt` (`{ content, parts }`) and `estimator`. A system message equal to `systemPrompt.content` is split into `system` and `rules` |
| `scaleCategoriesToTotal(categories, target)` | Rescales category values so they add up to exactly `target`. With all-zero input the whole target lands in `conversation` |
| `buildMeter(source, categories, total, windowTokens)` | Builds a `ContextMeter` (percent with one decimal, `null` without a valid window) |
| `computeDrift(estimateTotal, realTotal)` | `ContextDrift`; `ratio` / `percent` are `null` when real is 0 |
| `completeRecord(record, usage)` | Pairs a `ContextRequestRecord` with provider usage and drift |
| `realSnapshot(record)` | `ContextRealSnapshot` from a completed record, or `undefined` |
| `categorizeMessage(message, toolNames)` | Primary category of a message. `toolNames` maps `tool_call_id` → tool name |
| `buildMessageMeta(message, toolNames, estimator)` | `MessageContextMeta`: `category`, `chars` and `tokens` per category, `overheadTokens` |
| `createMessageContext(options)` | Standalone `MessageContext` (`limit`, `estimator`, `keepRatio`, `summaryPrefix`, `skillToolName`): add/get/set messages, trim, memory usage, per-message meta |
| `SUMMARY_MESSAGE_PREFIX` / `isSummaryMessage(message, prefix?)` | Default prefix of the rolling summary message (the neutral English one, same as `DEFAULT_SUMMARY_MESSAGE_PREFIX`) and its detector. Pass your `summarization.prefix` as `prefix` when you use a custom one |

Types: `CompiledRequest`, `CompiledToolSchema`, `CompileRequestOptions`, `ContextCategory`, `ContextCategoryTokens`, `ContextDrift`, `ContextEstimate`, `ContextMeter`, `ContextRealSnapshot`, `ContextRequestRecord`, `MessageContextMeta`, `SystemPromptParts`, `ToolSchemaCategory`, `EstimateRequestInput`, `MessageEntry`, `TokenEstimator`, `TokenEstimatorOptions`, `CalibrationSample`, `ContextOptions`, `MessageContext`, `MemoryUsage`.

## System prompt parts

`buildSystemPrompt(system?, rules?, skills?, options?)` returns `BuiltSystemPrompt`: `content` (system text, then rules, joined by a blank line; the library adds nothing), `cacheKey`, and `parts` (`SystemPromptParts`: `system`, `rules`, `skills`). `parts.skills` is the skill catalog (`name: description` per line). It is informational only: the model reads the catalog in the skill tool's description, so it is not in `content` and is counted under `skills` through the tool schema. `options.skillCatalog: false` reports `parts.skills` empty, which is what the agent does when the skill tool is not exposed. See [Agent API](agent-api.md#system-prompt-rules-and-skills).
