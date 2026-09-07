import type { AgentError } from './llm.js';

export type LifecyclePhase = 'thinking' | 'summarizing' | 'summarized';

export type AgentStreamEvent =
  | { type: 'lifecycle'; phase: LifecyclePhase }
  | { type: 'text.delta'; delta: string }
  | { type: 'reasoning.delta'; delta: string }
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
