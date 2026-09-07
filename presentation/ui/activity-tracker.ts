import type { AgentStreamEvent } from '../../domain/events.js';
import { toolRegistry } from '../../tools/core/registry.js';
import { tryParseToolError } from '../../application/chat/tool-errors.js';
import { formatEditMetaSummary } from '../../tools/core/edit-diff.js';
import type { ActivityStatus, ToolActivityView } from './tool-ui-consumer.js';

export interface ActivityTracker {
  activities: Map<string, ToolActivityView>;
  lifecyclePhase?: string;
}

export function createActivityTracker(): ActivityTracker {
  return { activities: new Map() };
}

export function applyStreamEvent(
  tracker: ActivityTracker,
  event: AgentStreamEvent
): ToolActivityView | null {
  switch (event.type) {
    case 'lifecycle':
      tracker.lifecyclePhase = event.phase;
      return null;

    case 'text.delta':
    case 'reasoning.delta':
      return null;

    case 'tool.call.start': {
      const presentation = toolRegistry.getPresentation(event.toolName);
      const detail = presentation.summarizeArgs?.(event.args);
      const view: ToolActivityView = {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        label: presentation.runningLabel ?? presentation.label,
        detail,
        status: 'running',
        args: event.args,
      };
      tracker.activities.set(event.toolCallId, view);
      return view;
    }

    case 'tool.call.result': {
      const existing = tracker.activities.get(event.toolCallId);
      const presentation = toolRegistry.getPresentation(event.toolName);
      let summary =
        presentation.summarizeResult?.(event.content) ??
        defaultResultSummary(event.content, event.ok);

      if (event.meta && event.toolName === 'edit_file') {
        const metaPreview = formatEditMetaSummary(event.meta);
        if (metaPreview) {
          summary = { ...summary, preview: metaPreview };
        }
      }

      const view: ToolActivityView = {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        label: presentation.label,
        detail: existing?.detail,
        status: summary.status,
        args: existing?.args,
        resultPreview: summary.preview,
        resultRaw: event.content,
        resultMeta: event.meta,
        errorCode: event.error?.code,
        errorMessage: event.error?.message,
      };
      tracker.activities.set(event.toolCallId, view);
      return view;
    }

    case 'tool.call.end':
      return tracker.activities.get(event.toolCallId) ?? null;

    default:
      return null;
  }
}

function defaultResultSummary(
  content: string,
  ok: boolean
): { preview: string; status: ActivityStatus } {
  const err = tryParseToolError(content);
  if (err?.code === 'POLICY_BLOCKED') {
    return { preview: err.message, status: 'blocked' };
  }
  if (err || !ok) {
    return { preview: err?.message ?? content.slice(0, 220), status: 'error' };
  }
  const oneLine = content.replace(/\s+/g, ' ').trim();
  return {
    preview: oneLine.length > 220 ? `${oneLine.slice(0, 220)}...` : oneLine,
    status: 'success',
  };
}

export function getLifecycleLabel(phase?: string): string | undefined {
  switch (phase) {
    case 'thinking':
      return 'Thinking';
    case 'summarizing':
      return 'Summarizing context';
    case 'summarized':
      return 'Context summarized';
    default:
      return undefined;
  }
}
