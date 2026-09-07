import fs from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import {
  type TodoItem,
  type TodoSnapshot,
  buildTodoSnapshot,
  canTransitionTodo,
  formatTodoLines,
  isOpenTodoStatus,
  isTerminalTodoStatus,
  normalizeTodoItem,
} from '../../domain/task.js';
import { resolveProjectDataDir } from './paths.js';

export class TodoValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TodoValidationError';
  }
}

export class TaskRepository {
  private readonly cache = new Map<string, TodoItem[]>();

  private cacheKey(sessionId?: string): string {
    return sessionId || 'default';
  }

  private getTasksDir(): string {
    const tasksDir = path.join(resolveProjectDataDir(), 'storage', 'tasks');
    if (!existsSync(tasksDir)) {
      mkdirSync(tasksDir, { recursive: true });
    }
    return tasksDir;
  }

  private getFilePath(sessionId?: string): string {
    const fileName = sessionId ? `${sessionId}.json` : 'tasks.json';
    return path.join(this.getTasksDir(), fileName);
  }

  private async loadFromDisk(sessionId?: string): Promise<TodoItem[]> {
    const filePath = this.getFilePath(sessionId);
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(data);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((item) => normalizeTodoItem(item))
        .filter((item): item is TodoItem => item !== null);
    } catch {
      return [];
    }
  }

  async list(sessionId?: string): Promise<TodoItem[]> {
    const key = this.cacheKey(sessionId);
    if (!this.cache.has(key)) {
      const loaded = await this.loadFromDisk(sessionId);
      this.cache.set(key, loaded);
    }
    return this.cache.get(key)!.map((t) => ({ ...t }));
  }

  async getSnapshot(sessionId?: string): Promise<TodoSnapshot> {
    const todos = await this.list(sessionId);
    return buildTodoSnapshot(todos);
  }

  /** In-memory snapshot only (empty if never loaded for this session). */
  getCachedSnapshot(sessionId?: string): TodoSnapshot {
    const key = this.cacheKey(sessionId);
    const todos = this.cache.get(key) ?? [];
    return buildTodoSnapshot(todos.map((t) => ({ ...t })));
  }

  async hasOpenTodos(sessionId?: string): Promise<boolean> {
    const todos = await this.list(sessionId);
    return todos.some((t) => isOpenTodoStatus(t.status));
  }

  async areAllTerminal(sessionId?: string): Promise<boolean> {
    const todos = await this.list(sessionId);
    return todos.length === 0 || todos.every((t) => isTerminalTodoStatus(t.status));
  }

  async save(tasks: TodoItem[], sessionId?: string): Promise<void> {
    const validated = this.validateListInvariants(tasks);
    const key = this.cacheKey(sessionId);
    this.cache.set(
      key,
      validated.map((t) => ({ ...t }))
    );
    const filePath = this.getFilePath(sessionId);
    await fs.writeFile(filePath, JSON.stringify(validated, null, 2), 'utf-8');
  }

  /**
   * Replace or merge todos for a session.
   * merge=false clears and writes the new list.
   * merge=true updates by id with transition checks.
   */
  async writeTodos(
    incoming: TodoItem[],
    options: { merge: boolean; sessionId?: string }
  ): Promise<TodoItem[]> {
    const existing = options.merge ? await this.list(options.sessionId) : [];
    const next = options.merge
      ? this.mergeTodos(existing, incoming)
      : this.validateListInvariants(incoming.map((t) => this.requireBlockedReason(t)));

    await this.save(next, options.sessionId);
    return next;
  }

  clearCache(sessionId?: string): void {
    if (sessionId === undefined) {
      this.cache.clear();
      return;
    }
    this.cache.delete(this.cacheKey(sessionId));
  }

  private mergeTodos(existing: TodoItem[], incoming: TodoItem[]): TodoItem[] {
    const byId = new Map(existing.map((t) => [t.id, { ...t }]));

    for (const raw of incoming) {
      const update = this.requireBlockedReason(raw);
      const current = byId.get(update.id);

      if (!current) {
        byId.set(update.id, update);
        continue;
      }

      if (!canTransitionTodo(current.status, update.status)) {
        throw new TodoValidationError(
          `Invalid todo status transition for '${update.id}': ${current.status} → ${update.status}. ` +
            'Completed, cancelled, and blocked items cannot be reopened.'
        );
      }

      byId.set(update.id, {
        id: update.id,
        content: update.content || current.content,
        status: update.status,
        ...(update.status === 'blocked'
          ? { blockedReason: update.blockedReason }
          : {}),
      });
    }

    return this.validateListInvariants(Array.from(byId.values()));
  }

  private requireBlockedReason(todo: TodoItem): TodoItem {
    if (todo.status !== 'blocked') {
      const { blockedReason: _ignored, ...rest } = todo;
      return rest;
    }
    const reason = todo.blockedReason?.trim();
    if (!reason) {
      throw new TodoValidationError(
        `Todo '${todo.id}' is blocked but blockedReason is missing. Provide a clear reason.`
      );
    }
    return { ...todo, blockedReason: reason };
  }

  private validateListInvariants(todos: TodoItem[]): TodoItem[] {
    const seen = new Set<string>();
    let inProgressCount = 0;
    const normalized: TodoItem[] = [];

    for (const todo of todos) {
      if (!todo.id.trim()) {
        throw new TodoValidationError('Todo id must be a non-empty string.');
      }
      if (!todo.content.trim()) {
        throw new TodoValidationError(`Todo '${todo.id}' content must be non-empty.`);
      }
      if (seen.has(todo.id)) {
        throw new TodoValidationError(`Duplicate todo id '${todo.id}'.`);
      }
      seen.add(todo.id);

      const item = this.requireBlockedReason(todo);
      if (item.status === 'in_progress') inProgressCount++;
      normalized.push(item);
    }

    if (inProgressCount > 1) {
      throw new TodoValidationError(
        'At most one todo may be in_progress at a time.'
      );
    }

    return normalized;
  }
}

export function formatPersistedTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return 'Todos updated (0 items)';
  return `Todos updated (${todos.length} items):\n${formatTodoLines(todos)}`;
}

export const taskRepository = new TaskRepository();
