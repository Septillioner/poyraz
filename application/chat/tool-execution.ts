import { createHash } from 'crypto';
import { logger } from '../../shared/logger.js';
import type { ChatMessage } from '../../domain/llm.js';
import { ToolDefinition, ToolContext, getToolSchema, normalizeToolResult } from '../../tools/core/types.js';
import { toolRegistry } from '../../tools/core/registry.js';
import type { ToolPolicyGuard } from './tool-policy.js';
import {
  createToolError,
  serializeToolError,
  TOOL_ERROR_CODES,
  tryParseToolError,
} from './tool-errors.js';
import { getToolExampleShape } from '../prompt/tool-schema-hints.js';
import {
  buildRepairInstruction,
  isRepairEnabled,
  resolveRepairMaxAttempts,
  type RepairOptions,
} from './repair-instruction.js';
import { isToolResultLimitActive, limitToolResult, type ToolResultLimit } from './tool-result-limit.js';

export interface ToolExecutionOptions {
  /** Repair text on failed results. Omitted / not enabled -> failed results carry no `REPAIR:` text. */
  repair?: RepairOptions;
  /**
   * Argument names whose absence is reported as `MISSING_REQUIRED_ARG` ("<tool> requires '<arg>' argument.")
   * instead of the general `VALIDATION_ERROR`. Defaults to `DEFAULT_MISSING_ARG_NAMES`; `[]` turns it off.
   */
  missingArgNames?: readonly string[];
  /**
   * Size limit of the result message. Omitted / without a usable field -> results pass on unchanged.
   * A longer result is cut and ends with a `[truncated: ...]` note; the call meta then carries `toolResultTruncated`.
   */
  resultLimit?: ToolResultLimit;
}

/** Legacy default of `ToolExecutionOptions.missingArgNames`. Keyed by argument name, not by tool name. */
export const DEFAULT_MISSING_ARG_NAMES: readonly string[] = ['command'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Parse tool arguments as-is. No field aliases, defaults, or composition. */
export function parseRawToolArgs(rawArgs: unknown): Record<string, unknown> {
  if (isPlainObject(rawArgs)) {
    return { ...rawArgs };
  }

  if (typeof rawArgs === 'string') {
    try {
      const parsed = JSON.parse(rawArgs);
      if (isPlainObject(parsed)) {
        return { ...parsed };
      }
    } catch {
      return {};
    }
  }

  return {};
}

function buildSignature(toolName: string, args: Record<string, unknown>): string {
  const normalized = JSON.stringify(args);
  const hash = createHash('sha1').update(normalized).digest('hex');
  return `${toolName}:${hash}`;
}

function toolMessage(content: string, toolCallId: string): ToolCallOutcome {
  return {
    message: { role: 'tool', content, tool_call_id: toolCallId },
  };
}

function withRepair(
  errorContent: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
  context: ToolContext,
  toolCallId: string,
  policyGuard?: ToolPolicyGuard,
  signature?: string,
  repair?: RepairOptions
): ToolCallOutcome {
  const parsed = tryParseToolError(errorContent);
  if (!parsed || !isRepairEnabled(repair)) {
    return toolMessage(errorContent, toolCallId);
  }
  if (policyGuard && signature) {
    if (policyGuard.getRepairAttempts(signature) >= resolveRepairMaxAttempts(repair)) {
      return toolMessage(errorContent, toolCallId);
    }
    policyGuard.markRepairAttempt(signature);
  }
  const text = buildRepairInstruction(toolName, parsed, toolArgs, { lastReadFile: context.lastReadFile }, repair);
  return toolMessage(`${errorContent}\n\n${text}`, toolCallId);
}

/**
 * Remembers the last successful "edit-ready" read for repair hints. Recognized by the shape of the
 * structured result (`edit_ready`, `target_file`, `line_count`), not by the tool's name.
 */
function updateLastReadFile(
  context: ToolContext,
  normalized: { content: string; structured?: unknown; isError?: boolean }
): void {
  if (normalized.isError) return;
  if (!normalized.structured || typeof normalized.structured !== 'object') return;

  const structured = normalized.structured as Record<string, unknown>;
  if (structured.edit_ready !== true) return;

  const path = structured.target_file;
  const lineCount = structured.line_count;
  if (typeof path !== 'string' || typeof lineCount !== 'number') return;

  context.lastReadFile = { path, lineCount };
}

export interface ToolCallOutcome {
  message: ChatMessage;
  meta?: Record<string, unknown>;
}

export async function executeToolCall(
  tools: Record<string, ToolDefinition>,
  policyGuard: ToolPolicyGuard,
  toolCall: any,
  context: ToolContext,
  options: ToolExecutionOptions = {}
): Promise<ToolCallOutcome> {
  const outcome = await runToolCall(tools, policyGuard, toolCall, context, options);
  if (!isToolResultLimitActive(options.resultLimit)) return outcome;
  const limited = limitToolResult(outcome.message.content, options.resultLimit);
  if (!limited.truncation) return outcome;
  logger.warn('Tool result truncated', { toolName: toolCall.function?.name, ...limited.truncation });
  return {
    message: { ...outcome.message, content: limited.content },
    meta: { ...outcome.meta, toolResultTruncated: limited.truncation },
  };
}

async function runToolCall(
  tools: Record<string, ToolDefinition>,
  policyGuard: ToolPolicyGuard,
  toolCall: any,
  context: ToolContext,
  options: ToolExecutionOptions
): Promise<ToolCallOutcome> {
  const repair = options.repair;
  const missingArgNames = options.missingArgNames ?? DEFAULT_MISSING_ARG_NAMES;
  const rawToolName = toolCall.function.name;
  const toolName = toolRegistry.resolveAlias(rawToolName);
  const toolArgs = parseRawToolArgs(toolCall.function.arguments);
  const signature = buildSignature(toolName, toolArgs);
  const count = policyGuard.markAndCountSignature(signature);
  const repairAttempts = policyGuard.getRepairAttempts(signature);
  // A failed call that got a repair text may be retried; with repair off (or its attempts used up)
  // identical calls are bounded by `repeatCallLimit` alone.
  const repairInFlight =
    isRepairEnabled(repair) && repairAttempts > 0 && repairAttempts < resolveRepairMaxAttempts(repair);

  if (count > policyGuard.getPolicy().repeatCallLimit && !repairInFlight) {
    const repeatedCallError = createToolError(
      TOOL_ERROR_CODES.policyBlocked,
      `Tool call blocked: repeated same tool+arguments too many times (${toolName}).`,
      { toolName, count }
    );
    logger.warn(repeatedCallError.message, { toolName, toolArgs, count });
    return withRepair(
      serializeToolError(repeatedCallError),
      toolName,
      toolArgs,
      context,
      toolCall.id,
      policyGuard,
      signature,
      repair
    );
  }

  const policyDecision = await policyGuard.canExecute(toolName);
  if (!policyDecision.allowed) {
    const reason = policyDecision.reason || 'Execution blocked by policy.';
    logger.warn(reason, { toolName, toolArgs });
    return withRepair(
      serializeToolError(createToolError(TOOL_ERROR_CODES.policyBlocked, reason, { toolName })),
      toolName,
      toolArgs,
      context,
      toolCall.id,
      policyGuard,
      signature,
      repair
    );
  }

  const tool = tools[toolName];
  if (!tool) {
    return withRepair(
      serializeToolError(
        createToolError(TOOL_ERROR_CODES.toolNotFound, `Tool not found: ${toolName}`, { toolName })
      ),
      toolName,
      toolArgs,
      context,
      toolCall.id,
      policyGuard,
      signature,
      repair
    );
  }

  try {
    const parsed = getToolSchema(tool).safeParse(toolArgs);
    if (!parsed.success) {
      const errors = parsed.error.issues.map((i: any) => ({
        path: i.path.join('.'),
        message: i.message,
      }));
      const missingArgs = missingArgNames.filter((name) =>
        errors.some((e) => e.path === name)
      );
      const hasMissingArg = missingArgs.length > 0;
      const errorCode = hasMissingArg
        ? TOOL_ERROR_CODES.missingRequiredArg
        : TOOL_ERROR_CODES.validationError;
      const errorMsg = hasMissingArg
        ? `${toolName} requires ${missingArgs.map((name) => `'${name}'`).join(', ')} ${
            missingArgs.length > 1 ? 'arguments' : 'argument'
          }.`
        : `${toolName} received invalid arguments.`;
      const example = getToolExampleShape(toolName);
      const exampleHint = example ? ` Expected shape: ${example}.` : '';
      return withRepair(
        serializeToolError(
          createToolError(errorCode, `${errorMsg}${exampleHint}`, { errors })
        ),
        toolName,
        toolArgs,
        context,
        toolCall.id,
        policyGuard,
        signature,
        repair
      );
    }

    const rawResult = await tool.execute(parsed.data, context);
    const normalized = normalizeToolResult(rawResult);

    if (normalized.isError || tryParseToolError(normalized.content)) {
      return withRepair(
        normalized.content,
        toolName,
        toolArgs,
        context,
        toolCall.id,
        policyGuard,
        signature,
        repair
      );
    }

    updateLastReadFile(context, normalized);

    policyGuard.markToolSuccess(toolName);

    const meta =
      normalized.structured && typeof normalized.structured === 'object'
        ? (normalized.structured as Record<string, unknown>)
        : undefined;

    return {
      message: {
        role: 'tool',
        content: normalized.content,
        tool_call_id: toolCall.id,
      },
      meta,
    };
  } catch (error: any) {
    logger.error(`Tool execution failed: ${toolName}`, { error: error.message });
    return withRepair(
      serializeToolError(
        createToolError(TOOL_ERROR_CODES.executionError, `Tool execution failed: ${toolName}`, {
          error: error.message,
        })
      ),
      toolName,
      toolArgs,
      context,
      toolCall.id,
      policyGuard,
      signature,
      repair
    );
  }
}
