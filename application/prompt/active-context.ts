import {
  AgentExecutionContext,
  buildExecutionContext,
} from '../../domain/execution-phase.js';
import type { TodoStore } from '../../domain/todo-store.js';

export interface ActiveContext {
  get(): AgentExecutionContext;
  refresh(sessionId?: string, lastUserMessage?: string): Promise<AgentExecutionContext>;
}

export function createActiveContext(todoStore: TodoStore): ActiveContext {
  let context: AgentExecutionContext = {
    phase: 'idle',
    completed: [],
    pending: [],
  };

  return {
    get() {
      return context;
    },
    async refresh(sessionId?: string, lastUserMessage?: string) {
      const tasks = await todoStore.list(sessionId);
      context = buildExecutionContext(tasks, lastUserMessage);
      return context;
    },
  };
}
