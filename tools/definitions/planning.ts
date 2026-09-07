import { z } from 'zod';
import { defineTool } from '../core/define-tool.js';
import { withPresentation } from '../core/presentations.js';
import type { TodoItem } from '../../domain/task.js';
import {
  formatPersistedTodos,
  taskRepository,
  TodoValidationError,
} from '../../infrastructure/persistence/task-repository.js';
import { createToolError, serializeToolError, TOOL_ERROR_CODES } from '../../application/chat/tool-errors.js';

export const todoWriteSchema = z.object({
  merge: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Whether to merge the todos with the existing todos. If true, merge by id. If false, replace all todos. Defaults to false.'
    ),
  todos: z
    .array(
      z.object({
        id: z.string().describe('Unique identifier for the todo item.'),
        content: z.string().describe('The description/content of the todo item.'),
        status: z
          .enum(['pending', 'in_progress', 'completed', 'cancelled', 'blocked'])
          .describe(
            'pending | in_progress | completed | cancelled | blocked. blocked requires blockedReason.'
          ),
        blockedReason: z
          .string()
          .optional()
          .describe('Required when status is blocked. Explain why the item cannot proceed.'),
      })
    )
    .min(1)
    .describe('Array of todo items to write.'),
});

export async function todoWrite(args: z.infer<typeof todoWriteSchema>, sessionId?: string) {
  const incoming: TodoItem[] = args.todos.map((todo) => ({
    id: todo.id,
    content: todo.content,
    status: todo.status,
    ...(todo.blockedReason ? { blockedReason: todo.blockedReason } : {}),
  }));

  try {
    const saved = await taskRepository.writeTodos(incoming, {
      merge: args.merge ?? false,
      sessionId,
    });
    return formatPersistedTodos(saved);
  } catch (error) {
    if (error instanceof TodoValidationError) {
      return serializeToolError(
        createToolError(TOOL_ERROR_CODES.validationError, error.message, {
          toolName: 'todo_write',
        })
      );
    }
    throw error;
  }
}

export const planningToolDefinitions = [
  defineTool({
    name: 'todo_write',
    description:
      'Create and manage a structured task list for the current coding session. ' +
      'Use proactively for complex multi-step tasks (3+ distinct steps). ' +
      'Skip for single straightforward tasks. Mark todos completed immediately after finishing. ' +
      'Statuses: pending, in_progress, completed, cancelled, blocked. ' +
      'When blocked, always set blockedReason with a clear explanation for the user. ' +
      'At most one item may be in_progress. Completed/cancelled/blocked items cannot be reopened. ' +
      'Required shape: { "merge": false, "todos": [{ "id": "t1", "content": "First step", "status": "pending" }, { "id": "t2", "content": "Second step", "status": "pending" }] }. ' +
      'Use "todos" (not "tasks"), "content" (not "title" or "items"), and "id" for each item. ' +
      'Set merge to false when replacing the list; true when updating existing items by id. ' +
      'In Plan mode call at most once per user turn (merge false) to record the full plan.',
    inputSchema: todoWriteSchema,
    execute: (args, ctx) => todoWrite(args, ctx.sessionId),
    presentation: withPresentation('todo_write'),
    meta: { category: 'planning' },
  }),
];
