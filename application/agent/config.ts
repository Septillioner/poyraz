import {
  isTokenPricing,
  type ChatMessage,
  type LLMProvider,
  type ReasoningConfig,
  type ServiceTier,
  type TokenPricing,
  type TokenUsage,
} from '../../domain/llm.js';
import { isReasoningEffort, isServiceTier } from '../../domain/llm.js';
import { DEFAULT_AGENT_POLICY, type AgentPolicy } from '../../domain/agent-policy.js';
import type { McpServerDef } from '../../domain/mcp.js';
import type { ToolPresetName } from '../../tools/core/registry.js';
import type { RepairInput, RepairResolver } from '../chat/repair-instruction.js';
import type { FileLoggingConfig, LogLevel } from '../../shared/logger.js';
import type { ToolDefinition } from '../../tools/core/types.js';
import type { ToolRoutingPolicy } from '../chat/tool-policy.js';
import type { TokenEstimatorOptions } from '../context/token-estimate.js';

export type { ToolRoutingPolicy };

/**
 * Library defaults. A bare `new AgentBuilder()` is a plain text completion: no system
 * message, no rules, no skills, no tools, no summary, no logging, no rate-limit waiting.
 * Every feature below is opt-in; an omitted section means "off".
 */

/** Thrown when the config cannot produce a working agent (e.g. no provider and no model/host). */
export class AgentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentConfigError';
  }
}

/**
 * Shared validation of `Reasoning(...)` and `Agent.setReasoning(...)`: `{ effort }` or `undefined`
 * (no effort clears the setting). An unknown effort throws `AgentConfigError`.
 */
export function normalizeReasoning(config: ReasoningConfig | undefined): ReasoningConfig | undefined {
  const effort = config?.effort;
  if (effort !== undefined && !isReasoningEffort(effort)) {
    throw new AgentConfigError(`Unknown reasoning effort: ${String(effort)}`);
  }
  return effort ? { effort } : undefined;
}

/** Shared validation of `ServiceTier(...)` and `Agent.setServiceTier(...)`. An unknown tier throws `AgentConfigError`. */
export function normalizeServiceTier(tier: ServiceTier | undefined): ServiceTier | undefined {
  if (tier !== undefined && !isServiceTier(tier)) {
    throw new AgentConfigError(`Unknown service tier: ${String(tier)}`);
  }
  return tier;
}

/** Validates and copies a per-token price table. Omit it to disable cost calculation. */
export function normalizeTokenPricing(pricing?: TokenPricing): TokenPricing | undefined {
  if (pricing === undefined) return undefined;
  if (!isTokenPricing(pricing)) {
    throw new AgentConfigError('Invalid token pricing: input, cache, and output must be finite non-negative numbers');
  }
  return { ...pricing };
}

/** A positive finite number, rounded down; anything else is `undefined` (shared by the builder and the agent). */
export function normalizeMaxToolRounds(rounds: unknown): number | undefined {
  return typeof rounds === 'number' && Number.isFinite(rounds) && rounds > 0 ? Math.floor(rounds) : undefined;
}

export interface Skill {
  name: string;
  description: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Repair (A1)
// ---------------------------------------------------------------------------

/** Repair instructions appended to failed tool results. Off unless `enabled: true`. */
export interface RepairConfig {
  enabled?: boolean;
  /** Max repair instructions per identical tool call signature. */
  maxAttempts?: number;
  /** Tool name -> specific repair text. Return `undefined` to fall back to the generic text. Not JSON-serializable. */
  resolvers?: Record<string, RepairResolver>;
  /** Replaces the library's generic repair text for every failure no resolver handled. Not JSON-serializable. */
  generic?: (input: RepairInput) => string;
}

// ---------------------------------------------------------------------------
// Policy (A1): allowed tools, gates, error breaker. Every field optional.
// ---------------------------------------------------------------------------

/**
 * Behavioral policy. All fields are optional: omitted `id` becomes `'default'`,
 * omitted `allowedTools` becomes `'all'` (of the tools the agent has; a bare agent has none),
 * omitted `errorBreaker` is `'off'`, and no gates / per-turn limits are applied.
 */
export type PolicyConfig = Partial<AgentPolicy>;

/** Merges a (partial) policy over the library default. */
export function resolveAgentPolicy(policy?: PolicyConfig): AgentPolicy {
  // A field set explicitly to `undefined` (id included) means "not set": it must not wipe the default.
  const defined = Object.fromEntries(
    Object.entries(policy ?? {}).filter(([, value]) => value !== undefined)
  ) as PolicyConfig;
  return { ...DEFAULT_AGENT_POLICY, ...defined };
}

/** Same-tool loop breaker ("same tool N times in a row"). Off unless `enabled: true`. */
export interface SameToolBreakerConfig {
  enabled?: boolean;
  /** Consecutive rounds led by the same tool before the notice fires. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Continuation (A1): generic hook, the host plugs in its own rule.
// ---------------------------------------------------------------------------

export interface ContinuationContext {
  /** Text of the final (tool-less) assistant reply of this round. */
  content: string;
  /** 1-based tool round the reply came from. */
  round: number;
  /** How many times continuation already fired in the current turn (shared by a whole chain). */
  continuations: number;
  /**
   * Continuations still allowed by this policy's `maxContinuations` (`undefined` without a cap).
   * `0` means a `continue` decision will be turned into a stop; this is the moment to hand
   * the leftover work back with `{ kind: 'stop', reason, data }`.
   */
  remaining?: number;
  /** Tools that succeeded at least once this turn. */
  succeededTools: ReadonlySet<string>;
  /** Usage of the request that produced the reply, when the provider reported it. */
  usage?: TokenUsage;
  /** Read-only snapshot of the conversation, including the reply. */
  messages: readonly ChatMessage[];
  /** Session the agent is bound to (`Agent.setSessionId`), when set. */
  sessionId?: string;
  /**
   * Turn cancellation. Long async decisions should honor it; a policy may also stop
   * early when it is aborted (e.g. nobody is listening any more).
   */
  signal?: AbortSignal;
}

export type ContinuationDecision =
  /** End the turn. `reason` / `data` come back on the chat result (`ContinuationOutcome`). */
  | { kind: 'stop'; reason?: string; data?: unknown }
  /** Append `notice` as a `user` message and run another round. */
  | { kind: 'continue'; notice: string };

/** What a stopped turn reports about continuation; carried on the chat result. */
export interface ContinuationOutcome {
  /** Continuations that fired during the turn. */
  continuations: number;
  /** `reason` of the final `stop` decision; the library sets `'max-continuations'` when the cap ended it. */
  reason?: string;
  /** `data` of the final `stop` decision (e.g. the open steps handed back to the user). */
  data?: unknown;
}

/**
 * Decides whether a finished reply should be followed by another round. The library ships
 * no implementation: the default is no policy (the first tool-less reply ends the turn).
 *
 * Contract for the runtime:
 * - `evaluate` runs after every tool-less reply (after response gates accepted it), awaited.
 * - `maxContinuations` is a hard cap enforced by the library after `evaluate`: a `continue`
 *   beyond it becomes a stop with reason `'max-continuations'`. `maxToolRounds` still bounds the turn.
 * - The policy keeps no library-managed state; counts arrive in the context, so one policy
 *   object can serve many turns and sessions.
 */
export interface ContinuationPolicy {
  /** Hard cap on continuations per turn. A policy without a cap is bounded by `maxToolRounds`. */
  maxContinuations?: number;
  evaluate(context: ContinuationContext): ContinuationDecision | Promise<ContinuationDecision>;
}

/**
 * Chains several policies into one (what `Continuation(...policies)` does). They are asked in
 * order; the first `continue` wins. If none continues, the first `stop` carrying a reason or
 * data is the result (else a plain stop). Each member sees `remaining` computed from its own
 * cap, and a member whose `continue` exceeds its own cap is skipped as if it had stopped.
 * The chain's own cap is the largest member cap (uncapped if any member is uncapped).
 */
export function chainContinuation(...policies: ContinuationPolicy[]): ContinuationPolicy {
  if (policies.length === 0) return { evaluate: () => ({ kind: 'stop' }) };
  if (policies.length === 1) return policies[0];
  const caps = policies.map((policy) => policy.maxContinuations);
  const maxContinuations = caps.every((cap) => typeof cap === 'number')
    ? Math.max(...(caps as number[]))
    : undefined;
  return {
    maxContinuations,
    async evaluate(context) {
      type Stop = Extract<ContinuationDecision, { kind: 'stop' }>;
      let stop: Stop | undefined;
      const isPlain = (decision: Stop) => decision.reason === undefined && decision.data === undefined;
      const note = (decision: Stop) => {
        if (!stop || (isPlain(stop) && !isPlain(decision))) stop = decision;
      };
      for (const policy of policies) {
        const remaining =
          typeof policy.maxContinuations === 'number'
            ? Math.max(0, policy.maxContinuations - context.continuations)
            : undefined;
        const decision = await policy.evaluate({ ...context, remaining });
        if (decision.kind === 'continue' && remaining !== 0) return decision;
        note(decision.kind === 'stop' ? decision : { kind: 'stop', reason: 'max-continuations' });
      }
      return stop ?? { kind: 'stop' };
    },
  };
}

// ---------------------------------------------------------------------------
// Summarization (A2): neutral, everything configurable.
// ---------------------------------------------------------------------------

/** Builds the summarization request text from the compacted conversation. */
export type SummaryPromptBuilder = (conversation: string) => string;

/** What `summarization.onSummarized` receives right after the history was replaced by a summary. */
export interface SummarizedContext {
  /** Summary text as the model wrote it (without the prefix). */
  summary: string;
  /** Prefix the summary message starts with. */
  prefix: string;
  /** Messages the summary replaced (the system message is never one of them). */
  summarizedMessages: number;
  /** Messages kept verbatim after the summary message. */
  keptMessages: number;
  /** Token estimate of the history messages before the summary (message text and tool calls, no tool schemas). */
  tokensBefore: number;
  /** Same estimate after the summary replaced the history. */
  tokensAfter: number;
  /** Snapshot of the history after the summary: system message (if any), summary message, kept tail. */
  messages: readonly ChatMessage[];
  /** Session the agent is bound to (`Agent.setSessionId`), when set. */
  sessionId?: string;
}

/**
 * Post-summary hook. A non-blank string it returns is appended to the end of the summary
 * message (after a newline); `undefined`, `null` or blank text adds nothing. It may be async.
 * A throwing hook is logged and ignored: the summary stays as it is.
 */
export type OnSummarizedHook = (
  summarized: SummarizedContext
) => string | null | undefined | void | Promise<string | null | undefined | void>;

export interface SummarizationConfig {
  /** Rolling summary instead of trim. Off by default. */
  enabled?: boolean;
  /** Window occupancy (0-1) that triggers it. Clamped to 0.5..0.95 when summarizing. */
  thresholdRatio?: number;
  /** Share of `contextLimit` kept verbatim after a summary. */
  keepRatio?: number;
  /**
   * Prompt sent to the model. A string may contain `{{conversation}}`; without the
   * placeholder the conversation is appended. Omitted -> a language-neutral built-in prompt.
   */
  prompt?: string | SummaryPromptBuilder;
  /** Prefix of the summary message. Omitted -> a language-neutral built-in prefix. */
  prefix?: string;
  /** Tool results are cut to this many characters in the summarization input. Omitted -> built-in default (200). */
  toolResultMaxChars?: number;
  /** Called after every summary; may return text to append to the summary message. Off (undefined) by default. */
  onSummarized?: OnSummarizedHook;
}

// ---------------------------------------------------------------------------
// Skills (A2): the `load_skill` tool.
// ---------------------------------------------------------------------------

export const DEFAULT_LOAD_SKILL_TOOL_NAME = 'load_skill';

export interface SkillToolConfig {
  /**
   * Whether the skill-loading tool is exposed. Omitted -> on only when skills exist.
   * `false` hides the tool even when skills are registered.
   */
  enabled?: boolean;
  /** Tool name shown to the model. Omitted -> `load_skill`. */
  toolName?: string;
}

// ---------------------------------------------------------------------------
// MCP (A3): optional.
// ---------------------------------------------------------------------------

export interface AgentMcpConfig {
  enabled?: boolean;
  servers?: Record<string, McpServerDef>;
  /** Name prefix of bridged MCP tools. */
  toolPrefix?: string;
}

// ---------------------------------------------------------------------------
// Rate limit (A3): off by default; no unbounded waiting.
// ---------------------------------------------------------------------------

/** Default wait budget once `rateLimit.enabled` is true and `maxWaits` is omitted. */
export const DEFAULT_RATE_LIMIT_MAX_WAITS = 3;

export interface RateLimitConfig {
  /** Wait and retry on a TPM/RPM rejection. Off by default: the error surfaces immediately. */
  enabled?: boolean;
  /** Max waits per request. Omitted -> `DEFAULT_RATE_LIMIT_MAX_WAITS`. Never unbounded. */
  maxWaits?: number;
  /** Fixed wait used when the provider reports no window. Omitted -> the provider layer's constant. */
  fallbackDelayMs?: number;
  /** Longest single wait; a longer window is capped to it. Omitted -> the provider layer's constant. */
  maxDelayMs?: number;
  /** Budget for all waits of one request together. Omitted -> only `maxWaits` bounds it. */
  maxTotalWaitMs?: number;
}

/** `RateLimitConfig` after defaults: what the provider layer reads. */
export interface ResolvedRateLimitConfig {
  enabled: boolean;
  /** `0` when disabled. */
  maxWaits: number;
  fallbackDelayMs?: number;
  maxDelayMs?: number;
  maxTotalWaitMs?: number;
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function positiveMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}

/** No config, or `enabled` not `true`, means no waiting at all (`maxWaits: 0`). */
export function resolveRateLimitConfig(config?: RateLimitConfig): ResolvedRateLimitConfig {
  if (config?.enabled !== true) return { enabled: false, maxWaits: 0 };
  return {
    enabled: true,
    maxWaits: nonNegativeInt(config.maxWaits) ?? DEFAULT_RATE_LIMIT_MAX_WAITS,
    fallbackDelayMs: positiveMs(config.fallbackDelayMs),
    maxDelayMs: positiveMs(config.maxDelayMs),
    maxTotalWaitMs: positiveMs(config.maxTotalWaitMs),
  };
}

// ---------------------------------------------------------------------------
// Logging (A3): off by default.
// ---------------------------------------------------------------------------

export interface LoggingConfig {
  level?: LogLevel;
  /** Process-wide file logging (`agent.log`). Omitted -> untouched (off unless the host enabled it). */
  file?: FileLoggingConfig;
  /** Write one JSON file per chat turn into the configured log dir. Off by default. */
  chatDebugLog?: boolean;
  /** Free-text origin tag stored in chat debug logs (e.g. `'cli'`, `'http'`, `'worker-3'`). */
  source?: string;
}

// ---------------------------------------------------------------------------
// Agent config
// ---------------------------------------------------------------------------

export interface AgentConfig {
  /** Sent to the provider only when set. Required for built-in providers (no `provider`). */
  model?: string;
  /** Required for built-in providers (no `provider`). No implicit localhost default. */
  host?: string;
  /** Full system message content. Empty/omitted → no system message. Non-empty rules are appended after it. */
  systemPrompt?: string;
  /** Alias for `systemPrompt` (system / rules / skills as separate fields). `systemPrompt` wins when both are set. */
  system?: string;
  rules?: string[];
  skills?: Skill[];
  tools?: Record<string, ToolDefinition>;
  /** Names to keep out of the tool set (also hides the skill tool when it names it). */
  excludeTools?: string[];
  /** Provider options. Sent only when set; there are no implicit temperature / num_ctx values. */
  options?: Record<string, any>;
  contextLimit?: number;
  /** Token window for token-based autosummary. Falls back to catalog value when omitted. */
  contextWindowTokens?: number;
  /** Legacy alias of `summarization.thresholdRatio`. Occupancy ratio (0-1) that triggers token-based autosummary. Defaults to 0.8. */
  summaryThresholdRatio?: number;
  /** Legacy alias of `summarization.enabled`. */
  autoSummary?: boolean;
  /** Local token estimator tuning (chars/token, per-message overhead) for the context meter. */
  tokenEstimator?: TokenEstimatorOptions;
  /** Per-token prices used for request and aggregate cost reporting. Omit to disable cost calculation. */
  tokenPricing?: TokenPricing;
  /** Legacy alias of `logging.level`. */
  logLevel?: LogLevel;
  apiKey?: string;
  provider?: LLMProvider;
  name?: string;
  promptCacheRetention?: 'in_memory' | '24h';
  reasoning?: ReasoningConfig;
  serviceTier?: ServiceTier;
  routingPolicy?: Partial<ToolRoutingPolicy>;
  /** Active behavioral policy (tool allow-list, gates, error breaker). Merged over the library default. */
  policy?: PolicyConfig;

  /** Tool round budget per turn. Wins over `routingPolicy.maxToolRounds` and `options.max_tool_rounds`. */
  maxToolRounds?: number;
  /** Identical tool+args call limit. Wins over `routingPolicy.repeatCallLimit` and `options.repeat_call_limit`. */
  repeatCallLimit?: number;
  repair?: RepairConfig;
  sameToolBreaker?: SameToolBreakerConfig;
  /** Tool names whose success counts as progress for the same-tool breaker. Default: none. */
  progressTools?: string[];
  /** Longest tool result in characters; a longer one is cut and ends with a `[truncated: ...]` note. Omitted -> no limit. */
  toolResultMaxChars?: number;
  /** Longest tool result in UTF-8 bytes; same cut and note. Omitted -> no limit. */
  toolResultMaxBytes?: number;
  continuation?: ContinuationPolicy;
  summarization?: SummarizationConfig;
  skillTool?: SkillToolConfig;
  mcp?: AgentMcpConfig;
  rateLimit?: RateLimitConfig;
  logging?: LoggingConfig;
}

/** JSON-serializable subset of the config (what `FromJSON` / `FromTemplate` read). */
export interface AgentTemplate {
  name: string;
  systemPrompt?: string;
  system?: string;
  rules?: string[];
  skills?: Skill[];
  toolPresets?: ToolPresetName[];
  includeTools?: string[];
  excludeTools?: string[];
  defaultTools?: {
    read?: boolean;
    write?: boolean;
    execute?: boolean;
    search?: boolean;
    grep?: boolean;
  };
  options?: Record<string, any>;
  contextLimit?: number;
  /** Token window for token-based autosummary. */
  contextWindowTokens?: number;
  /** Occupancy ratio (0-1) that triggers token-based autosummary. Defaults to 0.8. */
  summaryThresholdRatio?: number;
  autoSummary?: boolean;
  tokenEstimator?: TokenEstimatorOptions;
  tokenPricing?: TokenPricing;
  logLevel?: LogLevel;
  promptCacheRetention?: 'in_memory' | '24h';
  reasoning?: ReasoningConfig;
  serviceTier?: ServiceTier;
  routingPolicy?: Partial<ToolRoutingPolicy>;
  policy?: Omit<PolicyConfig, 'responseGates'>;
  maxToolRounds?: number;
  repeatCallLimit?: number;
  repair?: Omit<RepairConfig, 'resolvers' | 'generic'>;
  sameToolBreaker?: SameToolBreakerConfig;
  progressTools?: string[];
  toolResultMaxChars?: number;
  toolResultMaxBytes?: number;
  summarization?: Omit<SummarizationConfig, 'prompt' | 'onSummarized'> & { prompt?: string };
  skillTool?: SkillToolConfig;
  mcp?: AgentMcpConfig;
  rateLimit?: RateLimitConfig;
  logging?: LoggingConfig;
}
