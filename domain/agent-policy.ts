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
  /**
   * `'all'`, or the tools the model may use. An entry is an exact tool name or a pattern where `*`
   * stands for any run of characters (`'mcp_*'`, `'*_read'`, `'mcp_fs_*'`); see `matchesToolPattern`.
   */
  allowedTools: 'all' | string[];
  /**
   * Tools that are never available, whatever `allowedTools` says. Same entry syntax as `allowedTools`
   * (exact name or `*` pattern). Deny wins over allow. Omitted or empty -> nothing is denied by it.
   */
  deniedTools?: string[];
  /**
   * Tool round budget of a turn under this policy. Wins over `routingPolicy.maxToolRounds` and
   * `options.max_tool_rounds`; the top-level `maxToolRounds` setting still wins over it.
   * Omitted (or not a positive number) -> the next source in `resolveMaxToolRounds` decides.
   */
  maxToolRounds?: number;
  /** When true, denied tools abort the turn (hard block). Default false. */
  hardBlockDeniedTools?: boolean;
  /** Same-error circuit breaker mode. `undefined` means `'off'`. */
  errorBreaker?: ErrorBreakerMode;
  /** Reason returned when a tool is denied by `allowedTools` or `deniedTools`. */
  deniedToolReason?: string;
  /** Buffer text.delta until a text-only reply is accepted (e.g. when a response gate may still reject it). */
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

const patternCache = new Map<string, RegExp>();

function patternRegExp(pattern: string): RegExp {
  let regExp = patternCache.get(pattern);
  if (!regExp) {
    const source = pattern
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    regExp = new RegExp(`^${source}$`, 's');
    patternCache.set(pattern, regExp);
  }
  return regExp;
}

/**
 * True when `toolName` matches `pattern`: an exact name, or a name with `*` standing for any run of
 * characters (`'mcp_*'` is a prefix, `'*_read'` a suffix, `'a*b'` both). Everything else is literal and
 * matching is case-sensitive. A pattern without `*` is an exact match; `'*'` matches every name.
 */
export function matchesToolPattern(pattern: string, toolName: string): boolean {
  if (!pattern.includes('*')) return pattern === toolName;
  return patternRegExp(pattern).test(toolName);
}

/** True when `toolName` matches at least one entry (exact name or `*` pattern) of `patterns`. */
export function matchesAnyToolPattern(patterns: readonly string[], toolName: string): boolean {
  return patterns.some((pattern) => matchesToolPattern(pattern, toolName));
}

/**
 * Tool names of `baseTools` the policy lets through: in `allowedTools` (`'all'` or an unset field allows
 * every tool; entries may be `*` patterns) and not in `deniedTools` (deny wins). Keeps the order of `baseTools`.
 */
export function resolvePolicyTools(
  baseTools: string[],
  policy: AgentPolicy
): string[] {
  // Anything but an explicit list (`'all'`, or an unset field) leaves every tool allowed.
  const allowedByList = Array.isArray(policy.allowedTools)
    ? baseTools.filter((tool) => matchesAnyToolPattern(policy.allowedTools as string[], tool))
    : [...baseTools];
  const denied = Array.isArray(policy.deniedTools) ? policy.deniedTools : [];
  if (denied.length === 0) return allowedByList;
  return allowedByList.filter((tool) => !matchesAnyToolPattern(denied, tool));
}

export function resolvePolicyDenied(
  baseTools: string[],
  policy: AgentPolicy
): string[] {
  const allowed = new Set(resolvePolicyTools(baseTools, policy));
  return baseTools.filter((tool) => !allowed.has(tool));
}
