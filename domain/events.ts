import type { AgentError, RateLimitDelaySource, RateLimitNotice, TokenUsage } from './llm.js';

export type LifecyclePhase = 'thinking' | 'summarizing' | 'summarized';

export type AgentStreamEvent =
  | { type: 'lifecycle'; phase: LifecyclePhase }
  | { type: 'text.delta'; delta: string }
  | { type: 'reasoning.delta'; delta: string }
  /** A rate-limited request is waiting out its window and will be retried. */
  | {
      type: 'rate_limit.wait';
      attempt: number;
      delayMs: number;
      retryAt: number;
      source: RateLimitDelaySource;
      reason?: string;
    }
  | { type: 'rate_limit.resumed'; attempt: number }
  | {
      type: 'tool.call.start';
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  | { type: 'tool.call.end'; toolCallId: string }
  | {
      type: 'tool.call.result';
      toolCallId: string;
      toolName: string;
      content: string;
      ok: boolean;
      error?: AgentError;
      meta?: Record<string, unknown>;
    };

export interface ChatHandlers {
  onEvent?: (event: AgentStreamEvent) => void;
  signal?: AbortSignal;
}

export function emitEvent(handlers: ChatHandlers | undefined, event: AgentStreamEvent) {
  handlers?.onEvent?.(event);
}

/** Single place that turns a provider rate-limit notice into a stream event. */
export function rateLimitStreamEvent(notice: RateLimitNotice): AgentStreamEvent {
  if (notice.kind === 'resumed') return { type: 'rate_limit.resumed', attempt: notice.attempt };
  return {
    type: 'rate_limit.wait',
    attempt: notice.attempt,
    delayMs: notice.delayMs,
    retryAt: notice.retryAt,
    source: notice.source,
    reason: notice.reason,
  };
}
