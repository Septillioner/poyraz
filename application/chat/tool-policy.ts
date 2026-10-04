export interface ToolRoutingPolicy {
  maxToolRounds: number;
  repeatCallLimit: number;
  deterministicMode: boolean;
  deniedTools?: string[];
  /** Reason returned when a tool is in deniedTools. */
  deniedToolReason?: string;
  /** Per-tool success cap within a single user turn (e.g. { write_file: 1 }). */
  perTurnToolLimits?: Record<string, number>;
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
  /** Record a successful tool execution for per-turn limits. */
  markToolSuccess(toolName: string): void;
  /** True if the named tool succeeded at least once this turn. */
  didToolSucceed(toolName: string): boolean;
  /** Set of tool names that succeeded this turn. */
  succeededTools(): ReadonlySet<string>;
  canExecute(toolName: string): Promise<ToolPolicyDecision>;
  getPolicy(): ToolRoutingPolicy;
}

const DEFAULT_DENIED_TOOL_REASON =
  'This tool is disabled under the active policy. Do not retry it.';

export function createToolPolicyGuard(policy: ToolRoutingPolicy): ToolPolicyGuard {
  const normalizedCallCounts = new Map<string, number>();
  const repairCounts = new Map<string, number>();
  const successCounts = new Map<string, number>();

  return {
    reset() {
      normalizedCallCounts.clear();
      repairCounts.clear();
      successCounts.clear();
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
    markToolSuccess(toolName: string) {
      successCounts.set(toolName, (successCounts.get(toolName) || 0) + 1);
    },
    didToolSucceed(toolName: string) {
      return (successCounts.get(toolName) || 0) > 0;
    },
    succeededTools() {
      return new Set(successCounts.keys());
    },
    async canExecute(toolName: string) {
      if (policy.deniedTools?.includes(toolName)) {
        return {
          allowed: false,
          reason: policy.deniedToolReason?.trim() || DEFAULT_DENIED_TOOL_REASON,
        };
      }

      const limit = policy.perTurnToolLimits?.[toolName];
      if (limit !== undefined && (successCounts.get(toolName) || 0) >= limit) {
        return {
          allowed: false,
          reason:
            `Tool '${toolName}' may be called at most ${limit} time(s) per turn under the active policy. ` +
            'Stop calling tools and respond to the user.',
        };
      }

      return { allowed: true };
    },
    getPolicy() {
      return policy;
    },
  };
}
