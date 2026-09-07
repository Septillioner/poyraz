import type { AgentMode } from '../../domain/agent-mode.js';

export interface ToolRoutingPolicy {
  maxToolRounds: number;
  repeatCallLimit: number;
  deterministicMode: boolean;
  deniedTools?: string[];
  /** Active agent mode for mode-specific policy (e.g. plan todo_write once). */
  mode?: AgentMode;
}

export interface ToolPolicyDecision {
  allowed: boolean;
  reason?: string;
}

export interface ToolPolicyGuard {
  reset(): void;
  markAndCountSignature(signature: string): number;
  markRepairAttempt(key: string): number;
  getRepairAttempts(key: string): number;
  /** Call after a successful todo_write in plan mode. */
  markPlanTodoWriteSuccess(): void;
  /** True if todo_write succeeded at least once this turn. */
  didTodoWriteSucceed(): boolean;
  canExecute(toolName: string): Promise<ToolPolicyDecision>;
  getPolicy(): ToolRoutingPolicy;
}

export function createToolPolicyGuard(policy: ToolRoutingPolicy): ToolPolicyGuard {
  const normalizedCallCounts = new Map<string, number>();
  const repairCounts = new Map<string, number>();
  let planTodoWriteSucceeded = false;
  let todoWriteSucceeded = false;

  return {
    reset() {
      normalizedCallCounts.clear();
      repairCounts.clear();
      planTodoWriteSucceeded = false;
      todoWriteSucceeded = false;
    },
    markAndCountSignature(signature: string) {
      const count = (normalizedCallCounts.get(signature) || 0) + 1;
      normalizedCallCounts.set(signature, count);
      return count;
    },
    markRepairAttempt(key: string) {
      const count = (repairCounts.get(key) || 0) + 1;
      repairCounts.set(key, count);
      return count;
    },
    getRepairAttempts(key: string) {
      return repairCounts.get(key) || 0;
    },
    markPlanTodoWriteSuccess() {
      planTodoWriteSucceeded = true;
      todoWriteSucceeded = true;
    },
    didTodoWriteSucceed() {
      return todoWriteSucceeded;
    },
    async canExecute(toolName: string) {
      if (policy.deniedTools?.includes(toolName)) {
        return {
          allowed: false,
          reason:
            'This tool is disabled in the active mode. Writes and commands are blocked here. ' +
            'Tell the user to switch to Agent mode with "/mode agent" to apply changes; ' +
            'do not ask whether to proceed and do not retry this tool.',
        };
      }

      if (
        toolName === 'todo_write' &&
        policy.mode === 'plan' &&
        planTodoWriteSucceeded
      ) {
        return {
          allowed: false,
          reason:
            'In Plan mode todo_write may be called at most once per user turn. ' +
            'You already recorded the plan. Stop calling tools and present the plan in plain text. ' +
            'Tell the user to switch to Agent mode with "/mode agent" to apply changes.',
        };
      }

      return { allowed: true };
    },
    getPolicy() {
      return policy;
    },
  };
}
