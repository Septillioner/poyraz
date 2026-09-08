const CONTENT_PREVIEW_MAX = 400;
const TASK_PREVIEW_IN_NOTICE = 200;

export function buildSubagentCompletionNotice(input: {
  taskId: string;
  task: string;
  model: string;
  content: string;
  durationMs: number;
}): string {
  const taskPreview = truncateOneLine(input.task, TASK_PREVIEW_IN_NOTICE);
  return (
    `<system_reminder>\n` +
    `Subagent task ${input.taskId} completed (${input.durationMs}ms) on model ${input.model}.\n` +
    `Original brief: ${taskPreview}\n` +
    `Use the findings below to continue. Do not call delegate_task again for the same work.\n\n` +
    `${input.content.trim()}\n` +
    `</system_reminder>`
  );
}

export function buildSubagentFailureNotice(input: {
  taskId: string;
  task: string;
  model: string;
  error: string;
  durationMs: number;
}): string {
  const taskPreview = truncateOneLine(input.task, TASK_PREVIEW_IN_NOTICE);
  return (
    `<system_reminder>\n` +
    `Subagent task ${input.taskId} failed (${input.durationMs}ms) on model ${input.model}.\n` +
    `Original brief: ${taskPreview}\n` +
    `Error: ${input.error}\n` +
    `Continue without that research, or retry with a narrower brief if needed.\n` +
    `</system_reminder>`
  );
}

export function buildSubagentCancelledNotice(input: {
  taskId: string;
  task: string;
  model: string;
  durationMs: number;
  reason?: string;
}): string {
  const taskPreview = truncateOneLine(input.task, TASK_PREVIEW_IN_NOTICE);
  const reason = input.reason?.trim() || 'cancelled';
  return (
    `<system_reminder>\n` +
    `Subagent task ${input.taskId} was cancelled (${input.durationMs}ms) on model ${input.model}.\n` +
    `Original brief: ${taskPreview}\n` +
    `Reason: ${reason}\n` +
    `Continue without that research.\n` +
    `</system_reminder>`
  );
}

export function previewSubagentContent(content: string): string {
  return truncateOneLine(content, CONTENT_PREVIEW_MAX);
}

function truncateOneLine(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, Math.max(0, max - 1))}…`;
}
