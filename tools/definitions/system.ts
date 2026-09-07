import { z } from 'zod';
import { execa } from 'execa';
import { defineTool } from '../core/define-tool.js';
import { withPresentation } from '../core/presentations.js';
import { checkCommandPolicy } from '../core/command-policy.js';
import {
  getShellCwd,
  prepareShellCommand,
  shellResultMeta,
  syncSessionCwdFromCommand,
} from '../core/shell-session.js';
import type { ToolContext, ToolResult } from '../core/types.js';

export const runTerminalCmdSchema = z.object({
  command: z.string().min(1, 'command cannot be empty').describe('The terminal command to execute.'),
  is_background: z
    .boolean()
    .describe('Whether the command should be run in the background.'),
  explanation: z
    .string()
    .optional()
    .describe('One sentence explanation as to why this command needs to be run.'),
});

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: string }).name;
  return name === 'AbortError' || name === 'CanceledError';
}

const BACKGROUND_EARLY_EXIT_MS = 500;

function formatCommandOutput(stdout?: string, stderr?: string): string {
  const combined = [stderr, stdout].filter(Boolean).join('\n').trim();
  if (!combined) return '';
  const MAX_OUTPUT = 2000;
  if (combined.length > MAX_OUTPUT) {
    return `\n${combined.slice(0, MAX_OUTPUT)}\n\n... (truncated)`;
  }
  return `\n${combined}`;
}

function withShellMeta(content: string, command: string, sessionId?: string): ToolResult {
  const cwd = getShellCwd(sessionId);
  return {
    content,
    structured: shellResultMeta(cwd, command),
  };
}

async function runBackgroundCommand(
  command: string,
  cwd: string,
  originalCommand: string,
  sessionId: string | undefined,
  startCwd: string,
  ctx?: ToolContext
): Promise<ToolResult> {
  const child = execa(command, {
    shell: true,
    cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    reject: false,
    cancelSignal: ctx?.abortSignal,
  });

  const earlyResult = await Promise.race([
    child,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), BACKGROUND_EARLY_EXIT_MS)),
  ]);

  if (ctx?.abortSignal?.aborted) {
    return withShellMeta('Command cancelled by user.', originalCommand, sessionId);
  }

  if (earlyResult && earlyResult.exitCode !== 0) {
    const detail = formatCommandOutput(earlyResult.stdout, earlyResult.stderr);
    return withShellMeta(
      `ERROR: Background command exited immediately (code ${earlyResult.exitCode}): ${originalCommand}${detail}`,
      originalCommand,
      sessionId
    );
  }

  child.unref();
  void child.catch(() => {});

  syncSessionCwdFromCommand(originalCommand, sessionId, startCwd);

  return withShellMeta(
    `Command started in background (pid: ${child.pid ?? 'unknown'}): ${originalCommand}`,
    originalCommand,
    sessionId
  );
}

export async function runTerminalCmd(
  args: z.infer<typeof runTerminalCmdSchema>,
  ctx?: ToolContext
): Promise<ToolResult | string> {
  const { command, is_background } = args;
  const sessionId = ctx?.sessionId;

  const policy = checkCommandPolicy(command, is_background);
  if (policy.blocked) {
    return policy.reason!;
  }

  if (command.startsWith('ssh ') && !command.includes('BatchMode=yes')) {
    return "ERROR: Interactive SSH is not supported. Use '-o BatchMode=yes' for key-based connections.";
  }

  if (command.includes('sudo ') && !command.includes('-n')) {
    return "ERROR: Sudo commands that require a password are not supported. Use '-n' (non-interactive) mode.";
  }

  const prepared = prepareShellCommand(command, sessionId);
  if (prepared.error) {
    return prepared.error;
  }
  if (prepared.cdOnly) {
    return withShellMeta(prepared.cdMessage!, command, sessionId);
  }

  if (is_background) {
    try {
      return await runBackgroundCommand(
        prepared.command,
        prepared.cwd,
        command,
        sessionId,
        prepared.startCwd,
        ctx
      );
    } catch (error: unknown) {
      if (ctx?.abortSignal?.aborted || isAbortError(error)) {
        return withShellMeta('Command cancelled by user.', command, sessionId);
      }
      const err = error as { message?: string };
      return withShellMeta(
        `Error starting background command: ${err.message ?? String(error)}`,
        command,
        sessionId
      );
    }
  }

  try {
    const result = await execa(prepared.command, {
      shell: true,
      cwd: prepared.cwd,
      timeout: 30000,
      reject: false,
      cancelSignal: ctx?.abortSignal,
    });

    if (ctx?.abortSignal?.aborted) {
      return withShellMeta('Command cancelled by user.', command, sessionId);
    }

    const output = (result.stdout || result.stderr || '').trim();

    if (result.exitCode !== 0) {
      const detail = output || `exit code ${result.exitCode}`;
      const MAX_OUTPUT = 5000;
      const content =
        detail.length > MAX_OUTPUT
          ? detail.slice(0, MAX_OUTPUT) + `\n\n... (truncated, ${detail.length} total characters)`
          : detail;
      return withShellMeta(
        `ERROR: Command failed (exit ${result.exitCode}): ${command}${content ? `\n${content}` : ''}`,
        command,
        sessionId
      );
    }

    syncSessionCwdFromCommand(command, sessionId, prepared.startCwd);

    if (!output) {
      return withShellMeta('Command executed successfully with no output.', command, sessionId);
    }

    const MAX_OUTPUT = 5000;
    const content =
      output.length > MAX_OUTPUT
        ? output.slice(0, MAX_OUTPUT) + `\n\n... (truncated, ${output.length} total characters)`
        : output;
    return withShellMeta(content, command, sessionId);
  } catch (error: unknown) {
    if (ctx?.abortSignal?.aborted || isAbortError(error)) {
      return withShellMeta('Command cancelled by user.', command, sessionId);
    }
    const err = error as { timedOut?: boolean; message?: string };
    if (err.timedOut) {
      return withShellMeta(
        'ERROR: Command timed out after 30 seconds. Use is_background: true for long-running processes.',
        command,
        sessionId
      );
    }
    return withShellMeta(
      `Error executing command: ${err.message ?? String(error)}`,
      command,
      sessionId
    );
  }
}

export const systemToolDefinitions = [
  defineTool({
    name: 'run_terminal_cmd',
    description:
      'PROPOSE a command to run on behalf of the user. The user may approve or modify it before execution. ' +
      'Shell working directory persists within the session; standalone cd updates cwd for later commands. ' +
      'For long-running commands, set is_background to true. ' +
      'For ANY commands that would require user interaction, pass non-interactive flags (e.g. --yes). ' +
      'Non-interactive SSH: ssh -o BatchMode=yes user@host "command". Sudo: -n. Timeout: 30s for foreground commands.',
    inputSchema: runTerminalCmdSchema,
    execute: (args, ctx) => runTerminalCmd(args, ctx),
    presentation: withPresentation('run_terminal_cmd'),
    meta: { category: 'shell', destructive: true },
  }),
];
