import {
  type TodoItem,
  isOpenTodoStatus,
  isTerminalTodoStatus,
} from './task.js';

export type ExecutionPhase = 'idle' | 'planning' | 'execution';

export interface AgentExecutionContext {
  phase: ExecutionPhase;
  task?: string;
  currentStep?: number;
  totalSteps?: number;
  completed: string[];
  pending: string[];
}

const APPROVAL_PATTERN = /^(evet|tamam|uygula|onayla|devam|başla|basla)/i;

export function isApprovalMessage(message?: string): boolean {
  if (!message) return false;
  return APPROVAL_PATTERN.test(message.trim());
}

export function resolvePhase(tasks: TodoItem[], lastUserMessage?: string): ExecutionPhase {
  const active = tasks.filter((t) => !isTerminalTodoStatus(t.status));
  if (active.length === 0) return 'idle';

  const hasInProgress = tasks.some((t) => t.status === 'in_progress');
  if (hasInProgress || isApprovalMessage(lastUserMessage)) {
    return 'execution';
  }

  const hasPending = tasks.some((t) => t.status === 'pending');
  if (hasPending) return 'planning';

  return 'idle';
}

export function buildExecutionContext(
  tasks: TodoItem[],
  lastUserMessage?: string
): AgentExecutionContext {
  const phase = resolvePhase(tasks, lastUserMessage);
  const nonTerminal = tasks.filter((t) => !isTerminalTodoStatus(t.status));
  const completed = tasks.filter((t) => t.status === 'completed').map((t) => t.content);
  const pending = tasks.filter((t) => isOpenTodoStatus(t.status)).map((t) => t.content);

  const inProgress = tasks.find((t) => t.status === 'in_progress');
  const nextPending = tasks.find((t) => t.status === 'pending');
  const task = inProgress?.content ?? nextPending?.content;

  const doneCount = tasks.filter((t) => t.status === 'completed').length;
  const totalSteps = nonTerminal.length + doneCount;

  return {
    phase,
    task,
    currentStep: doneCount > 0 ? doneCount + (inProgress ? 1 : 0) : inProgress ? 1 : undefined,
    totalSteps: totalSteps > 0 ? totalSteps : undefined,
    completed,
    pending,
  };
}
