export const TODO_STATUSES = [
  'pending',
  'in_progress',
  'completed',
  'cancelled',
  'blocked',
] as const;

export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
  /** Required when status is blocked. */
  blockedReason?: string;
}

export interface TodoSnapshot {
  todos: TodoItem[];
  open: TodoItem[];
  completedCount: number;
  totalCount: number;
  inProgress?: TodoItem;
  blocked: TodoItem[];
  allTerminal: boolean;
}

const TERMINAL_STATUSES: ReadonlySet<TodoStatus> = new Set([
  'completed',
  'cancelled',
  'blocked',
]);

const OPEN_STATUSES: ReadonlySet<TodoStatus> = new Set(['pending', 'in_progress']);

const ALLOWED_TRANSITIONS: Record<TodoStatus, TodoStatus[]> = {
  pending: ['in_progress', 'completed', 'cancelled', 'blocked'],
  in_progress: ['pending', 'completed', 'cancelled', 'blocked'],
  completed: [],
  cancelled: [],
  blocked: [],
};

/** @deprecated Use TodoItem — kept for legacy web imports. */
export type TaskItem = TodoItem;
/** @deprecated Use TodoStatus */
export type TaskStatus = TodoStatus;
/** @deprecated Use TODO_STATUSES */
export const TASK_STATUSES = TODO_STATUSES;

export function isTerminalTodoStatus(status: TodoStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** @deprecated Use isTerminalTodoStatus */
export function isTerminalTaskStatus(status: TodoStatus): boolean {
  return isTerminalTodoStatus(status);
}

export function isOpenTodoStatus(status: TodoStatus): boolean {
  return OPEN_STATUSES.has(status);
}

export function canTransitionTodo(from: TodoStatus, to: TodoStatus): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** @deprecated Use canTransitionTodo */
export function canTransitionTask(from: TodoStatus, to: TodoStatus): boolean {
  return canTransitionTodo(from, to);
}

export function parseTodoStatus(value: string): TodoStatus {
  if ((TODO_STATUSES as readonly string[]).includes(value)) {
    return value as TodoStatus;
  }
  // Legacy persisted statuses from the old TaskItem model
  if (value === 'todo') return 'pending';
  if (value === 'done') return 'completed';
  if (value === 'failed') return 'blocked';
  if (value === 'awaiting_approval') return 'pending';
  return 'pending';
}

/** @deprecated Use parseTodoStatus */
export function parseTaskStatus(value: string): TodoStatus {
  return parseTodoStatus(value);
}

export function normalizeTodoItem(raw: unknown): TodoItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;

  const id =
    typeof item.id === 'string'
      ? item.id
      : typeof item.id === 'number'
        ? String(item.id)
        : null;
  const content =
    typeof item.content === 'string'
      ? item.content
      : typeof item.task === 'string'
        ? item.task
        : null;
  if (!id || !content) return null;

  const status = parseTodoStatus(String(item.status ?? 'pending'));
  const blockedReason =
    typeof item.blockedReason === 'string' && item.blockedReason.trim()
      ? item.blockedReason.trim()
      : undefined;

  if (status === 'blocked' && !blockedReason) {
    return {
      id,
      content,
      status: 'blocked',
      blockedReason: 'No reason provided',
    };
  }

  return {
    id,
    content,
    status,
    ...(status === 'blocked' ? { blockedReason } : {}),
  };
}

export function buildTodoSnapshot(todos: TodoItem[]): TodoSnapshot {
  const open = todos.filter((t) => isOpenTodoStatus(t.status));
  const blocked = todos.filter((t) => t.status === 'blocked');
  const completedCount = todos.filter((t) => t.status === 'completed').length;
  const inProgress = todos.find((t) => t.status === 'in_progress');

  return {
    todos: [...todos],
    open,
    completedCount,
    totalCount: todos.length,
    inProgress,
    blocked,
    allTerminal: todos.length === 0 || open.length === 0,
  };
}

export function formatTodoLines(todos: TodoItem[]): string {
  return todos
    .map((t) => {
      const reason = t.status === 'blocked' && t.blockedReason ? ` — ${t.blockedReason}` : '';
      return `- [${t.status}] ${t.id}: ${t.content}${reason}`;
    })
    .join('\n');
}

export function formatTodoProgressSummary(snapshot: TodoSnapshot): string {
  if (snapshot.totalCount === 0) return 'No todos';
  const parts = [
    `${snapshot.completedCount}/${snapshot.totalCount} completed`,
  ];
  if (snapshot.inProgress) {
    parts.push(`in progress: ${snapshot.inProgress.id}`);
  }
  if (snapshot.open.length > 0) {
    parts.push(`${snapshot.open.length} open`);
  }
  if (snapshot.blocked.length > 0) {
    parts.push(`${snapshot.blocked.length} blocked`);
  }
  return parts.join(' · ');
}
