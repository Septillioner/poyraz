import type { AgentError, TokenUsage } from './llm.js';

export type LifecyclePhase = 'thinking' | 'summarizing' | 'summarized';

export type SubagentTaskPhase = 'thinking' | 'tool';

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
    }
  | {
      type: 'subagent.task.started';
      taskId: string;
      model: string;
      provider?: string;
      taskPreview: string;
      startedAt: number;
    }
  | {
      type: 'subagent.task.progress';
      taskId: string;
      phase: SubagentTaskPhase;
      toolName?: string;
      toolDetail?: string;
    }
  | {
      type: 'subagent.task.completed';
      taskId: string;
      model: string;
      provider?: string;
      durationMs: number;
      usage: TokenUsage;
      contentPreview?: string;
    }
  | {
      type: 'subagent.task.failed';
      taskId: string;
      model: string;
      durationMs: number;
      error: string;
    }
  | {
      type: 'subagent.task.cancelled';
      taskId: string;
      model: string;
      durationMs: number;
      reason?: string;
    }
  | {
      type: 'subagent.task.injected';
      taskId: string;
    }
  | {
      type: 'subagent.tool.start';
      taskId: string;
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  | {
      type: 'subagent.tool.result';
      taskId: string;
      toolCallId: string;
      toolName: string;
      ok: boolean;
      preview: string;
    };

export interface ChatHandlers {
  onEvent?: (event: AgentStreamEvent) => void;
  signal?: AbortSignal;
}

export function emitEvent(handlers: ChatHandlers | undefined, event: AgentStreamEvent) {
  handlers?.onEvent?.(event);
}
