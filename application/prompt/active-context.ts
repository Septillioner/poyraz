import {
  AgentExecutionContext,
  buildExecutionContext,
} from '../../domain/execution-phase.js';
import { taskRepository } from '../../infrastructure/persistence/task-repository.js';

export interface ActiveContext {
  get(): AgentExecutionContext;
  refresh(sessionId?: string, lastUserMessage?: string): Promise<AgentExecutionContext>;
}

export function createActiveContext(): ActiveContext {
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
      const tasks = await taskRepository.list(sessionId);
      context = buildExecutionContext(tasks, lastUserMessage);
      return context;
    },
  };
}
