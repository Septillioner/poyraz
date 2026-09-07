import {
  formatTodoLines,
  formatTodoProgressSummary,
  type TodoSnapshot,
} from '../../domain/task.js';

/** Max synthetic continue injections while open todos remain in Agent mode. */
export const TODO_CONTINUATION_BUDGET = 8;

export function buildTodoContinuationNotice(snapshot: TodoSnapshot): string {
  const openLines = formatTodoLines(snapshot.open);
  const progress = formatTodoProgressSummary(snapshot);
  const active = snapshot.inProgress
    ? `Current in_progress: ${snapshot.inProgress.id} — ${snapshot.inProgress.content}`
    : 'No item is in_progress; mark the next pending item in_progress and work on it.';

  return (
    `<system_reminder>\n` +
    `Open todos remain (${progress}). Do not end your turn yet.\n` +
    `${active}\n` +
    `Remaining:\n${openLines}\n` +
    `Continue working with tools. Mark each item completed as soon as it is done. ` +
    `If a step is impossible, mark it blocked with blockedReason via todo_write (merge: true) ` +
    `and explain the blocker to the user.\n` +
    `</system_reminder>`
  );
}

export function buildTodoBudgetExhaustedMessage(snapshot: TodoSnapshot): string {
  const progress = formatTodoProgressSummary(snapshot);
  const openLines = formatTodoLines(snapshot.open);
  const blockedLines =
    snapshot.blocked.length > 0
      ? `\nAlready blocked:\n${formatTodoLines(snapshot.blocked)}`
      : '';

  return (
    `Stopped with open todos still remaining (${progress}). ` +
    `Continuation budget exhausted before the list became terminal.\n` +
    `Open items:\n${openLines}${blockedLines}\n` +
    `Tell the user what is left and what is blocking progress.`
  );
}

export function buildAgentSoftCircuitNotice(toolName: string, kind: 'repeat' | 'error'): string {
  if (kind === 'error') {
    return (
      `<system_reminder>\n` +
      `NOTICE: '${toolName}' returned the same error twice. Do not retry the identical call. ` +
      `Try a different approach, gather more context with other tools, or mark the current todo ` +
      `as blocked with blockedReason via todo_write if progress is impossible.\n` +
      `</system_reminder>`
    );
  }

  return (
    `<system_reminder>\n` +
    `NOTICE: '${toolName}' was called repeatedly without progress. ` +
    `Stop looping that tool. Switch approach, use other tools, or mark the current todo ` +
    `blocked with blockedReason if you cannot proceed.\n` +
    `</system_reminder>`
  );
}
