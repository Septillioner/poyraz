import type { AgentError } from '../../domain/llm.js';
import { TOOL_ERROR_CODES } from './tool-errors.js';
import { getToolExampleShape } from '../prompt/tool-schema-hints.js';

export interface RepairContext {
  lastReadFile?: { path: string; lineCount: number };
}

/** What a repair text builder gets to work with. */
export interface RepairInput {
  toolName: string;
  error: AgentError;
  args: Record<string, unknown>;
  context: RepairContext;
}

/** Tool-specific repair text. Return `undefined` to fall back to the generic text. */
export type RepairResolver = (input: RepairInput) => string | undefined;

/**
 * Runtime view of the `repair` config section. Structurally a superset of `RepairConfig`
 * (`enabled`, `maxAttempts`), so the config object can be passed as is.
 */
export interface RepairOptions {
  /** Repair text on failed tool results. Off unless `true`. */
  enabled?: boolean;
  /** Max repair texts per identical tool call signature. Omitted -> `DEFAULT_REPAIR_MAX_ATTEMPTS`. */
  maxAttempts?: number;
  /** Tool name -> specific text. Tools without an entry (or whose resolver returns nothing) get the generic text. */
  resolvers?: Record<string, RepairResolver>;
  /** Replaces the library's generic text for every failure no resolver handled. */
  generic?: (input: RepairInput) => string;
}

export const DEFAULT_REPAIR_MAX_ATTEMPTS = 3;

export function isRepairEnabled(options?: RepairOptions): boolean {
  return options?.enabled === true;
}

export function resolveRepairMaxAttempts(options?: RepairOptions): number {
  const value = options?.maxAttempts;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : DEFAULT_REPAIR_MAX_ATTEMPTS;
}

function buildGenericRepair(input: RepairInput): string {
  const { toolName, error } = input;
  if (error.code === TOOL_ERROR_CODES.policyBlocked) {
    return (
      `REPAIR: ${toolName} was blocked by policy. Do not repeat the same call. ` +
      'Respond in plain text and explain what you could not do.'
    );
  }
  const example = getToolExampleShape(toolName);
  const examplePart = example ? ` Expected shape: ${example}.` : '';
  return `REPAIR: ${toolName} failed (${error.code}). Fix the arguments and retry.${examplePart}`;
}

/**
 * Repair text for a failed tool call: the resolver registered for the tool name when it
 * returns text, else `options.generic`, else the library's neutral generic text.
 * Knows no tool by name unless a resolver is passed in.
 */
export function buildRepairInstruction(
  toolName: string,
  error: AgentError,
  args: Record<string, unknown>,
  ctx?: RepairContext,
  options?: Pick<RepairOptions, 'resolvers' | 'generic'>
): string {
  const input: RepairInput = { toolName, error, args, context: ctx ?? {} };
  const resolver = options?.resolvers?.[toolName];
  if (resolver) {
    const text = resolver(input);
    if (typeof text === 'string' && text.trim()) return text;
  }
  return options?.generic ? options.generic(input) : buildGenericRepair(input);
}

// ---------------------------------------------------------------------------
// Opt-in resolvers for the built-in fs / shell / grep tools. Not applied by default:
// pass `resolvers: builtinRepairResolvers` (or pick entries) in the repair config.
// ---------------------------------------------------------------------------

function readFileHint(ctx?: RepairContext, targetFile?: string): string {
  if (!ctx?.lastReadFile || !targetFile) return '';
  const normalized = targetFile.replace(/\\/g, '/');
  const readPath = ctx.lastReadFile.path.replace(/\\/g, '/');
  if (normalized !== readPath && !normalized.endsWith(readPath) && !readPath.endsWith(normalized)) {
    return '';
  }
  return (
    `You read ${ctx.lastReadFile.path} (${ctx.lastReadFile.lineCount} lines) — use that content as the base. `
  );
}

function buildEditFileRepair({ error, args, context }: RepairInput): string | undefined {
  if (error.code === TOOL_ERROR_CODES.policyBlocked) return undefined;
  const target = typeof args.target_file === 'string' ? args.target_file : 'the file';
  const readHint = readFileHint(context, target);
  const msg = error.message.toLowerCase();

  if (msg.includes('markers or the full file') || msg.includes('markers or full')) {
    return (
      `REPAIR: edit_file failed on ${target}. ${readHint}` +
      'You must either: (a) put the COMPLETE file content in code_edit, OR ' +
      '(b) use TWO markers: // ... existing code ... before AND after your change. ' +
      'Do not call edit_file again with a short snippet only.'
    );
  }

  if (msg.includes('both before and after markers')) {
    return (
      `REPAIR: edit_file failed on ${target}. ${readHint}` +
      'Add a SECOND // ... existing code ... marker after your change. ' +
      'Copy unique anchor lines from read_file output on each side of the edit.'
    );
  }

  if (msg.includes('jsx/tsx') || msg.includes('{/*')) {
    return (
      `REPAIR: edit_file failed on ${target}. ${readHint}` +
      'Inside return (...), use {/* ... existing code ... */} markers, OR rewrite the full file in code_edit.'
    );
  }

  if (msg.includes('before-context anchor') || msg.includes('after-context anchor')) {
    return (
      `REPAIR: edit_file failed on ${target}. ${readHint}` +
      'Re-read the file with read_file. Paste exact lines from the numbered output as anchors before and after your change.'
    );
  }

  if (msg.includes('broken edit') || msg.includes('many lines without removing')) {
    return (
      `REPAIR: edit_file failed on ${target}. ${readHint}` +
      'Stop partial fixes. read_file the FULL file, then edit_file with the complete file in code_edit.'
    );
  }

  return (
    `REPAIR: edit_file failed on ${target}. ${readHint}` +
    'Either paste the FULL file in code_edit, or use // ... existing code ... markers on BOTH sides of your change.'
  );
}

function buildRunTerminalCmdRepair({ error }: RepairInput): string | undefined {
  if (error.code === TOOL_ERROR_CODES.policyBlocked) return undefined;
  const msg = error.message.toLowerCase();
  if (msg.includes('is_background') || msg.includes('long-running')) {
    return (
      'REPAIR: run_terminal_cmd failed. Dev servers (npm run dev, vite) need is_background: true. ' +
      'If session cwd is already inside the project, run npm run dev without cd prefix.'
    );
  }
  if (msg.includes('directory not found')) {
    return (
      'REPAIR: run_terminal_cmd cd failed. Check session cwd in the last tool result. ' +
      'Use paths relative to session cwd, or cd from workspace root once.'
    );
  }
  return 'REPAIR: run_terminal_cmd failed. Read the error, fix command or is_background, then retry once with a corrected command.';
}

function buildGrepRepair({ error }: RepairInput): string | undefined {
  if (error.code === TOOL_ERROR_CODES.policyBlocked) return undefined;
  return 'REPAIR: grep failed. Use head_limit (not limit). Example: { "pattern": "foo", "path": "src", "head_limit": 20 }';
}

/** Specific repair texts of the built-in `edit_file`, `run_terminal_cmd` and `grep` tools. */
export const builtinRepairResolvers: Readonly<Record<string, RepairResolver>> = {
  edit_file: buildEditFileRepair,
  run_terminal_cmd: buildRunTerminalCmdRepair,
  grep: buildGrepRepair,
};
