import type { Content } from '@google/genai';

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface ReasoningConfig {
  effort?: ReasoningEffort;
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value);
}

export const SERVICE_TIERS = ['default', 'flex', 'fast', 'priority', 'ultrafast'] as const;

export type ServiceTier = (typeof SERVICE_TIERS)[number];

export function isServiceTier(value: unknown): value is ServiceTier {
  return typeof value === 'string' && (SERVICE_TIERS as readonly string[]).includes(value);
}

/** Where the wait before a rate-limited retry came from. */
export type RateLimitDelaySource = 'header' | 'message' | 'fallback';

export interface RateLimitWait {
  attempt: number;
  delayMs: number;
  retryAt: number;
  source: RateLimitDelaySource;
  reason?: string;
}

export type RateLimitNotice =
  | ({ kind: 'wait' } & RateLimitWait)
  | { kind: 'resumed'; attempt: number };

/**
 * Wait-and-retry policy for rate-limited requests. Off unless `enabled` is true; the waiting
 * is always bounded (`maxWaits`, optionally `maxDelayMs` / `maxTotalWaitMs`).
 */
export interface RateLimitPolicy {
  enabled: boolean;
  /** Max waits per request. `0` means no waiting. */
  maxWaits: number;
  /** Wait used when the provider reports no window. */
  fallbackDelayMs?: number;
  /** Longest single wait; a longer window is capped to it. */
  maxDelayMs?: number;
  /** Budget for all waits of one request together. */
  maxTotalWaitMs?: number;
}

export interface ChatMessageProviderMeta {
  gemini?: {
    modelContent: Content;
  };
  /** Responses API output items (reasoning, function_call, …) for replay on later turns. */
  openai?: {
    outputItems?: unknown[];
  };
}

export interface ChatMessage {
  role: string;
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  providerMeta?: ChatMessageProviderMeta;
}
export interface ToolCallFunction {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: ToolCallFunction;
}

export interface AgentError {
  code: string;
  message: string;
  details?: unknown;
}

export interface ChatOptions {
  /** Sent only when set. Optional so a clean agent (or a custom provider) needs none. */
  model?: string;
  messages: ChatMessage[];
  tools?: any[];
  options?: any;
  promptCacheKey?: string;
  promptCacheRetention?: 'in_memory' | '24h';
  reasoning?: ReasoningConfig;
  serviceTier?: ServiceTier;
  signal?: AbortSignal;
  /** Reports a TPM/RPM wait so the caller can show it and keep the turn alive. */
  onRateLimit?: (notice: RateLimitNotice) => void;
  /** Rate-limit wait policy for this call. Omitted -> the provider's own (default: no waiting). */
  rateLimit?: RateLimitPolicy;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number;
}

/** Per-token prices for a model request. `cache` applies to the cached part of `promptTokens`. */
export interface TokenPricing {
  input: number;
  cache: number;
  output: number;
}

/** A request's billable token split and its cost at a particular `TokenPricing`. */
export interface TokenCost {
  /** Uncached prompt tokens: `promptTokens - cachedTokens`. */
  inputTokens: number;
  /** Cached prompt tokens. This is always at most `promptTokens`. */
  cacheTokens: number;
  /** Completion tokens reported by the provider. */
  outputTokens: number;
  inputCost: number;
  cacheCost: number;
  outputCost: number;
  totalCost: number;
}

/** Current-turn and whole-session costs using one price table. */
export interface TokenCostTotals {
  current: TokenCost;
  session: TokenCost;
}

function nonNegativeFinite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** True only for a complete, finite, non-negative per-token price table. */
export function isTokenPricing(value: unknown): value is TokenPricing {
  if (!value || typeof value !== 'object') return false;
  const pricing = value as Partial<TokenPricing>;
  return (
    typeof pricing.input === 'number' &&
    Number.isFinite(pricing.input) &&
    pricing.input >= 0 &&
    typeof pricing.cache === 'number' &&
    Number.isFinite(pricing.cache) &&
    pricing.cache >= 0 &&
    typeof pricing.output === 'number' &&
    Number.isFinite(pricing.output) &&
    pricing.output >= 0
  );
}

/**
 * Calculates a provider-reported request's cost. Cached tokens are a subset of
 * prompt tokens, so only the remainder is charged at the normal input price.
 * `totalTokens` is intentionally not used: providers may define it differently,
 * while prompt + cache + completion is the billing contract.
 */
export function calculateTokenCost(usage: TokenUsage, pricing: TokenPricing): TokenCost {
  const promptTokens = nonNegativeFinite(usage.promptTokens);
  const cacheTokens = Math.min(promptTokens, nonNegativeFinite(usage.cachedTokens));
  const inputTokens = promptTokens - cacheTokens;
  const outputTokens = nonNegativeFinite(usage.completionTokens);
  const inputCost = inputTokens * pricing.input;
  const cacheCost = cacheTokens * pricing.cache;
  const outputCost = outputTokens * pricing.output;
  return {
    inputTokens,
    cacheTokens,
    outputTokens,
    inputCost,
    cacheCost,
    outputCost,
    totalCost: inputCost + cacheCost + outputCost,
  };
}

export interface ChatResponse {
  content: string;
  tool_calls?: ToolCall[];
  usage?: TokenUsage;
  providerMeta?: ChatMessageProviderMeta;
}

export interface LLMProvider {
  chat(
    options: ChatOptions,
    onToken?: (token: string) => void,
    onReasoning?: (delta: string) => void
  ): Promise<ChatResponse>;
}
