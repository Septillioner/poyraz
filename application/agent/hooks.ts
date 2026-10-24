import { logger } from '../../shared/logger.js';

/**
 * Lifecycle events shared with the Claude Agent SDK and Codex.
 * IDE-only events (worktrees, notifications, elicitation) are not part of this library.
 */
export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'UserPromptSubmit',
  'Stop',
  'Interrupt',
  'SessionStart',
  'SessionEnd',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
] as const;

export type HookEventName = (typeof HOOK_EVENTS)[number];

export type PermissionDecision = 'allow' | 'deny' | 'ask';

/** What a hook receives. `tool_input` is a copy; mutating it does not change the call. */
export interface HookInput {
  hook_event_name: HookEventName;
  session_id?: string;
  agent_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  tool_response?: string;
  prompt?: string;
  reason?: string;
}

/**
 * Claude-shaped decision. `permissionDecision` is for tool and permission events.
 * `decision: 'block'` stops prompt, compact, permission, and subagent start.
 * `updatedInput` replaces tool arguments only when the call is not denied.
 */
export interface HookJSONOutput {
  permissionDecision?: PermissionDecision;
  permissionDecisionReason?: string;
  updatedInput?: Record<string, unknown>;
  decision?: 'block';
  reason?: string;
}

export interface HookContext {
  signal?: AbortSignal;
}

export type HookCallback = (
  input: HookInput,
  toolUseId: string | undefined,
  context: HookContext,
) => HookJSONOutput | void | Promise<HookJSONOutput | void>;

/** `matcher` is a regular expression. Tool events test the tool name; subagent events test the agent id. */
export interface HookMatcher {
  matcher?: string;
  hooks: HookCallback[];
}

export type HookRegistry = Partial<Record<HookEventName, HookMatcher[]>>;

export interface HookOutcome {
  blocked: boolean;
  permissionDecision?: PermissionDecision;
  reason?: string;
  updatedInput?: Record<string, unknown>;
}

const EMPTY_OUTCOME: HookOutcome = { blocked: false };

const PERMISSION_RANK: Record<PermissionDecision, number> = { allow: 0, ask: 1, deny: 2 };

const TOOL_EVENTS = new Set<HookEventName>([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
]);

const SUBAGENT_EVENTS = new Set<HookEventName>(['SubagentStart', 'SubagentStop']);

/** Runs matching callbacks. A throw is logged and ignored. No registry entry means no decision. */
export async function runHooks(
  registry: HookRegistry | undefined,
  input: HookInput,
  context: HookContext = {},
): Promise<HookOutcome> {
  const groups = registry?.[input.hook_event_name];
  if (!groups || groups.length === 0) return EMPTY_OUTCOME;

  let blocked = false;
  let blockReason: string | undefined;
  let permissionDecision: PermissionDecision | undefined;
  let permissionReason: string | undefined;
  let updatedInput: Record<string, unknown> | undefined;

  for (const group of groups) {
    if (!matcherFits(group.matcher, input)) continue;
    for (const hook of group.hooks) {
      const output = await callHook(hook, input, context);
      if (!output) continue;
      if (output.decision === 'block') {
        blocked = true;
        blockReason ??= output.reason;
      }
      const nextDecision = output.permissionDecision;
      if (nextDecision && (!permissionDecision || PERMISSION_RANK[nextDecision] > PERMISSION_RANK[permissionDecision])) {
        permissionDecision = nextDecision;
        permissionReason = output.permissionDecisionReason ?? permissionReason;
      }
      if (output.updatedInput) updatedInput = { ...output.updatedInput };
    }
  }

  const denied = permissionDecision === 'deny';
  return {
    blocked: blocked || denied,
    ...(permissionDecision ? { permissionDecision } : {}),
    ...((blocked || denied) ? { reason: blockReason ?? permissionReason } : {}),
    ...(updatedInput && !blocked && !denied ? { updatedInput } : {}),
  };
}

async function callHook(hook: HookCallback, input: HookInput, context: HookContext): Promise<HookJSONOutput | void> {
  try {
    return await hook(copyInput(input), input.tool_use_id, context);
  } catch (error) {
    logger.warn('Hook failed; the turn continues', {
      event: input.hook_event_name,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function copyInput(input: HookInput): HookInput {
  if (!input.tool_input) return { ...input };
  return { ...input, tool_input: { ...input.tool_input } };
}

function matcherFits(matcher: string | undefined, input: HookInput): boolean {
  if (!matcher) return true;
  const subject = subjectFor(input);
  if (subject === undefined) return !usesSubject(input.hook_event_name);
  try {
    return new RegExp(matcher).test(subject);
  } catch (error) {
    logger.warn('Hook matcher is not a valid pattern', {
      matcher,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function usesSubject(event: HookEventName): boolean {
  return TOOL_EVENTS.has(event) || SUBAGENT_EVENTS.has(event);
}

function subjectFor(input: HookInput): string | undefined {
  if (TOOL_EVENTS.has(input.hook_event_name)) return input.tool_name;
  if (SUBAGENT_EVENTS.has(input.hook_event_name)) return input.agent_id;
  return undefined;
}
