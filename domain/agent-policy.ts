export type GateVerdict =
  | { kind: 'accept' }
  | { kind: 'retry'; notice: string };

/**
 * Same-error circuit breaker mode.
 * - `'off'` (default): the streak is never counted, no NOTICE is injected, and no
 *   round is ever marked blocked. Choose this unless you need the loop breaker.
 * - `'soft'`: streak is counted and a `<system_reminder>` NOTICE is injected. It never
 *   touches `tool_calls`, so the saved history stays provider-valid.
 * - `'hard'`: the legacy hard path. It marks the loop blocked, which drops `tool_calls`
 *   from later rounds while `sanitizeToolPairing` still has to repair the request payload.
 *   Prefer `'soft'`.
 */
export type ErrorBreakerMode = 'off' | 'soft' | 'hard';

export interface ResponseGate {
  /** Max retries after a retry verdict before accepting or calling onExhausted. */
  maxRetries: number;
  evaluate(input: {
    content: string;
    succeededTools: ReadonlySet<string>;
  }): GateVerdict;
  /** When retry budget is exhausted, transform the content (optional). */
  onExhausted?(content: string): string;
}

export interface AgentPolicy {
  id: string;
  allowedTools: 'all' | string[];
  /** When true, denied tools abort the turn (hard block). Default false. */
  hardBlockDeniedTools?: boolean;
  /** Same-error circuit breaker mode. `undefined` means `'off'`. */
  errorBreaker?: ErrorBreakerMode;
  /** Reason returned when a tool is denied by allowedTools. */
  deniedToolReason?: string;
  /** Buffer text.delta until a text-only reply is accepted (e.g. plan code-dump gate). */
  bufferTextUntilAccepted?: boolean;
  /** Per-tool success cap within a single user turn (e.g. { write_file: 1 }). */
  perTurnToolLimits?: Record<string, number>;
  /** Text-only reply gates evaluated in order before accepting a final answer. */
  responseGates?: ResponseGate[];
}

export const DEFAULT_AGENT_POLICY: AgentPolicy = {
  id: 'default',
  allowedTools: 'all',
};

export function resolvePolicyTools(
  baseTools: string[],
  policy: AgentPolicy
): string[] {
  if (policy.allowedTools === 'all') return [...baseTools];
  const allowed = new Set(policy.allowedTools);
  return baseTools.filter((tool) => allowed.has(tool));
}

export function resolvePolicyDenied(
  baseTools: string[],
  policy: AgentPolicy
): string[] {
  const allowed = new Set(resolvePolicyTools(baseTools, policy));
  return baseTools.filter((tool) => !allowed.has(tool));
}
