import type { TodoItem, TodoSnapshot } from './task.js';

export interface TodoStore {
  list(sessionId?: string): Promise<TodoItem[]>;
  writeTodos(
    items: TodoItem[],
    opts: { sessionId?: string; merge: boolean }
  ): Promise<TodoItem[]>;
  getSnapshot(sessionId?: string): Promise<TodoSnapshot>;
  getCachedSnapshot(sessionId?: string): TodoSnapshot | null;
}
