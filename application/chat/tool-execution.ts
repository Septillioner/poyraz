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
import { buildRepairInstruction } from './repair-instruction.js';

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
  signature?: string
): ToolCallOutcome {
  const parsed = tryParseToolError(errorContent);
  if (!parsed) {
    return toolMessage(errorContent, toolCallId);
  }
  if (policyGuard && signature) {
    policyGuard.markRepairAttempt(signature);
  }
  const repair = buildRepairInstruction(toolName, parsed, toolArgs, {
    lastReadFile: context.lastReadFile,
  });
  return toolMessage(`${errorContent}\n\n${repair}`, toolCallId);
}

function updateLastReadFile(
  context: ToolContext,
  toolName: string,
  normalized: { content: string; structured?: unknown; isError?: boolean }
): void {
  if (toolName !== 'read_file' || normalized.isError) return;
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
  context: ToolContext
): Promise<ToolCallOutcome> {
  const rawToolName = toolCall.function.name;
  const toolName = toolRegistry.resolveAlias(rawToolName);
  const toolArgs = parseRawToolArgs(toolCall.function.arguments);
  const signature = buildSignature(toolName, toolArgs);
  const count = policyGuard.markAndCountSignature(signature);
  const repairAttempts = policyGuard.getRepairAttempts(signature);

  if (count > policyGuard.getPolicy().repeatCallLimit && repairAttempts === 0) {
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
      signature
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
      signature
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
      signature
    );
  }

  try {
    const parsed = getToolSchema(tool).safeParse(toolArgs);
    if (!parsed.success) {
      const errors = parsed.error.issues.map((i: any) => ({
        path: i.path.join('.'),
        message: i.message,
      }));
      const hasMissingCommand = errors.some((e) => e.path === 'command');
      const errorCode = hasMissingCommand
        ? TOOL_ERROR_CODES.missingRequiredArg
        : TOOL_ERROR_CODES.validationError;
      const errorMsg = hasMissingCommand
        ? `${toolName} requires 'command' argument.`
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
        signature
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
        signature
      );
    }

    updateLastReadFile(context, toolName, normalized);

    if (toolName === 'todo_write') {
      policyGuard.markPlanTodoWriteSuccess();
    }

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
      signature
    );
  }
}
