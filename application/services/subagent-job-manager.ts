import { randomUUID } from 'crypto';
import type { AgentStreamEvent } from '../../domain/events.js';
import type { TokenUsage } from '../../domain/llm.js';
import type { ModelProfile } from '../../domain/model-profile.js';
import { toolRegistry } from '../../tools/core/registry.js';
import type { AgentConfig } from '../agent/config.js';
import {
  buildSubagentCancelledNotice,
  buildSubagentCompletionNotice,
  buildSubagentFailureNotice,
  previewSubagentContent,
} from '../chat/subagent-result-gate.js';
import {
  DELEGATE_TASK_TOOL_NAME,
  SUBAGENT_MODEL_ENV,
  readSubagentModelId,
} from './subagent-constants.js';
import {
  runSubagentTask,
  type SubagentChatCapable,
  type SubagentRunResult,
} from './subagent-runner.js';

const TASK_PREVIEW_MAX = 120;

export type SubagentJobPhase = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface DelegateTaskStartResult {
  taskId: string;
  status: 'running';
  model: string;
  content: string;
}

export interface SubagentJobSnapshot {
  taskId: string;
  status: Exclude<SubagentJobPhase, 'idle'>;
  task: string;
  taskPreview: string;
  model: string;
  provider?: string;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  usage?: TokenUsage;
  content?: string;
  error?: string;
}

export interface SubagentJobStartOptions {
  task: string;
  createAgent: (config: AgentConfig) => SubagentChatCapable;
  parentSignal?: AbortSignal;
  onEvent?: (event: AgentStreamEvent) => void;
  onUsage?: (usage: TokenUsage) => void;
  env?: NodeJS.ProcessEnv;
}

type PendingKind = 'completed' | 'failed' | 'cancelled';

type PendingPayload = {
  kind: PendingKind;
  taskId: string;
  notice: string;
};

/**
 * One active background subagent per parent Agent.
 * Completions are stored as pending notices and flushed only at round boundaries.
 */
export class SubagentJobManager {
  private phase: SubagentJobPhase = 'idle';
  private snapshot: SubagentJobSnapshot | undefined;
  private pending: PendingPayload | undefined;
  private childAbort: AbortController | undefined;
  private parentAbortHandler: (() => void) | undefined;
  private linkedParentSignal: AbortSignal | undefined;
  private settleWaiters: Array<() => void> = [];
  private runToken = 0;
  private onEvent?: (event: AgentStreamEvent) => void;

  getPhase(): SubagentJobPhase {
    return this.phase;
  }

  getSnapshot(): SubagentJobSnapshot | undefined {
    return this.snapshot ? { ...this.snapshot } : undefined;
  }

  isBusy(): boolean {
    return this.phase === 'running' || this.pending !== undefined;
  }

  isRunning(): boolean {
    return this.phase === 'running';
  }

  hasPendingFlush(): boolean {
    return this.pending !== undefined;
  }

  start(options: SubagentJobStartOptions): DelegateTaskStartResult {
    if (this.isBusy()) {
      const activeId = this.snapshot?.taskId ?? 'unknown';
      throw new Error(
        `A subagent is already active (${activeId}). Wait for it to finish or cancel before starting another.`
      );
    }

    const modelId = readSubagentModelId(options.env);
    if (!modelId) {
      throw new Error(
        `${SUBAGENT_MODEL_ENV} is not set. Configure a cheaper model id before using ${DELEGATE_TASK_TOOL_NAME}.`
      );
    }

    const task = options.task.trim();
    const taskId = randomUUID();
    const taskPreview = truncateOneLine(task, TASK_PREVIEW_MAX);
    const startedAt = Date.now();
    const token = ++this.runToken;

    this.childAbort = new AbortController();
    this.onEvent = options.onEvent;
    this.linkParentAbort(options.parentSignal);

    this.phase = 'running';
    this.pending = undefined;
    this.snapshot = {
      taskId,
      status: 'running',
      task,
      taskPreview,
      model: modelId,
      startedAt,
    };

    const emit = (event: AgentStreamEvent) => {
      options.onEvent?.(event);
    };

    emit({
      type: 'subagent.task.started',
      taskId,
      model: modelId,
      taskPreview,
      startedAt,
    });

    void this.runBackground(token, options, emit);

    return {
      taskId,
      status: 'running',
      model: modelId,
      content:
        `Subagent started (${taskId}) on ${modelId}. ` +
        'Continue other work; findings will be injected automatically when ready.',
    };
  }

  /**
   * Waits until the current job leaves `running`.
   * No-op when idle or already settled with a pending flush.
   */
  async waitUntilSettled(): Promise<void> {
    if (this.phase !== 'running') return;
    await new Promise<void>((resolve) => {
      this.settleWaiters.push(resolve);
    });
  }

  flushPending(): { taskId: string; notice: string } | undefined {
    const pending = this.pending;
    if (!pending) return undefined;
    this.pending = undefined;
    this.phase = 'idle';
    this.snapshot = undefined;
    this.clearChildAbort();
    return { taskId: pending.taskId, notice: pending.notice };
  }

  cancel(reason = 'cancelled by parent'): void {
    if (this.phase === 'running' && this.snapshot) {
      const snap = this.snapshot;
      this.childAbort?.abort();
      const finishedAt = Date.now();
      const durationMs = Math.max(0, finishedAt - snap.startedAt);
      this.phase = 'cancelled';
      this.snapshot = {
        ...snap,
        status: 'cancelled',
        finishedAt,
        durationMs,
        error: reason,
      };
      this.pending = {
        kind: 'cancelled',
        taskId: snap.taskId,
        notice: buildSubagentCancelledNotice({
          taskId: snap.taskId,
          task: snap.task,
          model: snap.model,
          durationMs,
          reason,
        }),
      };
      this.onEvent?.({
        type: 'subagent.task.cancelled',
        taskId: snap.taskId,
        model: snap.model,
        durationMs,
        reason,
      });
      this.resolveWaiters();
      return;
    }

    this.childAbort?.abort();
    this.clearChildAbort();
    this.resolveWaiters();
  }

  /** Hard reset used when clearing SUBAGENT_MODEL. */
  reset(): void {
    this.runToken += 1;
    this.childAbort?.abort();
    this.clearChildAbort();
    this.pending = undefined;
    this.phase = 'idle';
    this.snapshot = undefined;
    this.resolveWaiters();
  }

  /**
   * Re-bind or clear the parent abort link without starting a new job.
   * Call at the start of each parent chat so Ctrl+C cancels a still-running child.
   * Call with undefined when the parent turn ends normally so the child keeps running.
   */
  attachParentSignal(signal?: AbortSignal): void {
    if (!this.isRunning()) {
      this.unlinkParentAbort();
      return;
    }
    this.linkParentAbort(signal);
  }

  private async runBackground(
    token: number,
    options: SubagentJobStartOptions,
    emit: (event: AgentStreamEvent) => void
  ): Promise<void> {
    const snap = this.snapshot;
    if (!snap) return;

    try {
      const result = await runSubagentTask({
        task: snap.task,
        createAgent: options.createAgent,
        signal: this.childAbort?.signal,
        env: options.env,
        onEvent: (event) => this.forwardChildEvent(snap.taskId, event, emit),
      });

      if (token !== this.runToken || this.phase === 'cancelled') {
        return;
      }

      this.completeSuccess(result, emit, options.onUsage);
    } catch (error: unknown) {
      if (token !== this.runToken) return;
      if (this.phase === 'cancelled' || this.childAbort?.signal.aborted) {
        this.ensureCancelledPending('aborted');
        this.resolveWaiters();
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.completeFailure(message, emit);
    }
  }

  private completeSuccess(
    result: SubagentRunResult,
    emit: (event: AgentStreamEvent) => void,
    onUsage?: (usage: TokenUsage) => void
  ): void {
    const snap = this.snapshot;
    if (!snap) return;

    const finishedAt = Date.now();
    const durationMs = Math.max(0, finishedAt - snap.startedAt);
    const modelProfile: ModelProfile = result.modelProfile;
    onUsage?.(result.usage);

    this.phase = 'completed';
    this.snapshot = {
      ...snap,
      status: 'completed',
      model: modelProfile.model,
      provider: modelProfile.provider,
      finishedAt,
      durationMs,
      usage: result.usage,
      content: result.content,
    };
    this.pending = {
      kind: 'completed',
      taskId: snap.taskId,
      notice: buildSubagentCompletionNotice({
        taskId: snap.taskId,
        task: snap.task,
        model: modelProfile.model,
        content: result.content,
        durationMs,
      }),
    };

    emit({
      type: 'subagent.task.completed',
      taskId: snap.taskId,
      model: modelProfile.model,
      provider: modelProfile.provider,
      durationMs,
      usage: result.usage,
      contentPreview: previewSubagentContent(result.content),
    });
    this.resolveWaiters();
  }

  private completeFailure(error: string, emit: (event: AgentStreamEvent) => void): void {
    const snap = this.snapshot;
    if (!snap) return;
    const finishedAt = Date.now();
    const durationMs = Math.max(0, finishedAt - snap.startedAt);
    this.phase = 'failed';
    this.snapshot = {
      ...snap,
      status: 'failed',
      finishedAt,
      durationMs,
      error,
    };
    this.pending = {
      kind: 'failed',
      taskId: snap.taskId,
      notice: buildSubagentFailureNotice({
        taskId: snap.taskId,
        task: snap.task,
        model: snap.model,
        error,
        durationMs,
      }),
    };
    emit({
      type: 'subagent.task.failed',
      taskId: snap.taskId,
      model: snap.model,
      durationMs,
      error,
    });
    this.resolveWaiters();
  }

  private ensureCancelledPending(reason: string): void {
    const snap = this.snapshot;
    if (!snap) return;
    if (this.pending?.kind === 'cancelled') return;
    const finishedAt = Date.now();
    const durationMs = Math.max(0, finishedAt - snap.startedAt);
    this.phase = 'cancelled';
    this.snapshot = {
      ...snap,
      status: 'cancelled',
      finishedAt,
      durationMs,
      error: reason,
    };
    this.pending = {
      kind: 'cancelled',
      taskId: snap.taskId,
      notice: buildSubagentCancelledNotice({
        taskId: snap.taskId,
        task: snap.task,
        model: snap.model,
        durationMs,
        reason,
      }),
    };
    this.onEvent?.({
      type: 'subagent.task.cancelled',
      taskId: snap.taskId,
      model: snap.model,
      durationMs,
      reason,
    });
  }

  private forwardChildEvent(
    taskId: string,
    event: AgentStreamEvent,
    emit: (event: AgentStreamEvent) => void
  ): void {
    if (event.type === 'lifecycle' && event.phase === 'thinking') {
      emit({ type: 'subagent.task.progress', taskId, phase: 'thinking' });
      return;
    }
    if (event.type === 'tool.call.start') {
      const presentation = toolRegistry.getPresentation(event.toolName);
      const toolDetail = presentation.summarizeArgs?.(event.args);
      emit({
        type: 'subagent.tool.start',
        taskId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      });
      emit({
        type: 'subagent.task.progress',
        taskId,
        phase: 'tool',
        toolName: event.toolName,
        toolDetail,
      });
      return;
    }
    if (event.type === 'tool.call.result') {
      const preview = event.content.replace(/\s+/g, ' ').trim().slice(0, 160);
      emit({
        type: 'subagent.tool.result',
        taskId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        ok: event.ok,
        preview,
      });
    }
  }

  private linkParentAbort(signal?: AbortSignal): void {
    this.unlinkParentAbort();
    if (!signal) return;
    const onAbort = () => {
      this.cancel('parent aborted');
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    this.linkedParentSignal = signal;
    this.parentAbortHandler = onAbort;
  }

  private unlinkParentAbort(): void {
    if (this.linkedParentSignal && this.parentAbortHandler) {
      this.linkedParentSignal.removeEventListener('abort', this.parentAbortHandler);
    }
    this.linkedParentSignal = undefined;
    this.parentAbortHandler = undefined;
  }

  private clearChildAbort(): void {
    this.unlinkParentAbort();
    this.childAbort = undefined;
  }

  private resolveWaiters(): void {
    const waiters = this.settleWaiters;
    this.settleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}

function truncateOneLine(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, Math.max(0, max - 1))}…`;
}
