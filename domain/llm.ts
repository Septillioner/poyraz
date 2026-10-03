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
  model: string;
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
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number;
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
