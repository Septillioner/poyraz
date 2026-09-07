import type { AgentError } from '../../domain/llm.js';
import { TOOL_ERROR_CODES } from './tool-errors.js';
import { getToolExampleShape } from '../prompt/tool-schema-hints.js';

export interface RepairContext {
  lastReadFile?: { path: string; lineCount: number };
}

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

function buildEditFileRepair(error: AgentError, args: Record<string, unknown>, ctx?: RepairContext): string {
  const target = typeof args.target_file === 'string' ? args.target_file : 'the file';
  const readHint = readFileHint(ctx, target);
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

function buildRunTerminalCmdRepair(error: AgentError): string {
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

function buildGrepRepair(): string {
  return 'REPAIR: grep failed. Use head_limit (not limit). Example: { "pattern": "foo", "path": "src", "head_limit": 20 }';
}

function buildGenericRepair(toolName: string, error: AgentError): string {
  const example = getToolExampleShape(toolName);
  const examplePart = example ? ` Expected shape: ${example}.` : '';
  return `REPAIR: ${toolName} failed (${error.code}). Fix the arguments and retry.${examplePart}`;
}

export function buildRepairInstruction(
  toolName: string,
  error: AgentError,
  args: Record<string, unknown>,
  ctx?: RepairContext
): string {
  if (toolName === 'edit_file') {
    return buildEditFileRepair(error, args, ctx);
  }
  if (toolName === 'run_terminal_cmd') {
    return buildRunTerminalCmdRepair(error);
  }
  if (toolName === 'grep') {
    return buildGrepRepair();
  }
  if (
    error.code === TOOL_ERROR_CODES.validationError ||
    error.code === TOOL_ERROR_CODES.missingRequiredArg
  ) {
    return buildGenericRepair(toolName, error);
  }
  if (error.code === TOOL_ERROR_CODES.policyBlocked) {
    return (
      `REPAIR: ${toolName} blocked by policy. Do not repeat the same call. ` +
      'If it was blocked because the active mode is read-only, respond in plain text and tell ' +
      'the user to switch to Agent mode with "/mode agent" to apply the change.'
    );
  }
  return buildGenericRepair(toolName, error);
}
