import {
  formatTodoProgressSummary,
  type TodoItem,
  type TodoSnapshot,
} from '../../domain/task.js';

const COL_STATUS = 12;
const COL_ID = 16;
const COL_CONTENT = 48;
const COL_REASON = 28;

function padCell(value: string, width: number): string {
  const truncated =
    value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value;
  return truncated.padEnd(width, ' ');
}

function reasonFor(todo: TodoItem): string {
  return todo.status === 'blocked' ? todo.blockedReason ?? '' : '';
}

/**
 * ASCII Current Todos table for CLI and prompt injection.
 * Columns: Status | Id | Content | Reason
 */
export function formatTodoTable(snapshot: TodoSnapshot): string {
  if (snapshot.totalCount === 0) {
    return 'Current Todos\n(no todos)';
  }

  const header =
    `${padCell('Status', COL_STATUS)} | ${padCell('Id', COL_ID)} | ` +
    `${padCell('Content', COL_CONTENT)} | ${padCell('Reason', COL_REASON)}`;
  const rule = '-'.repeat(header.length);

  const rows = snapshot.todos.map((todo) => {
    return (
      `${padCell(todo.status, COL_STATUS)} | ${padCell(todo.id, COL_ID)} | ` +
      `${padCell(todo.content, COL_CONTENT)} | ${padCell(reasonFor(todo), COL_REASON)}`
    );
  });

  const summary = formatTodoProgressSummary(snapshot);
  return ['Current Todos', summary, rule, header, rule, ...rows, rule].join('\n');
}

/** Compact block for system prompt injection. */
export function formatCurrentTodosPromptBlock(snapshot: TodoSnapshot): string {
  if (snapshot.totalCount === 0) return '';
  return `<current_todos>\n${formatTodoTable(snapshot)}\n</current_todos>`;
}
