import type { AgentError } from '../../domain/llm.js';

export const TOOL_ERROR_CODES = {
  toolNotFound: 'TOOL_NOT_FOUND',
  validationError: 'VALIDATION_ERROR',
  missingRequiredArg: 'MISSING_REQUIRED_ARG',
  policyBlocked: 'POLICY_BLOCKED',
  executionError: 'EXECUTION_ERROR',
} as const;

export function createToolError(code: string, message: string, details?: unknown): AgentError {
  return { code, message, details };
}

export function serializeToolError(error: AgentError): string {
  return JSON.stringify({ error });
}

function parseToolErrorPayload(content: string): AgentError | null {
  const parsed = JSON.parse(content);
  if (!parsed || typeof parsed !== 'object' || !parsed.error) return null;
  const err = parsed.error as AgentError;
  if (!err.code || !err.message) return null;
  return err;
}

export function tryParseToolError(content: string): AgentError | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{')) return null;

  try {
    return parseToolErrorPayload(trimmed);
  } catch {
    const splitAt = trimmed.indexOf('\n\n');
    if (splitAt === -1) return null;
    try {
      return parseToolErrorPayload(trimmed.slice(0, splitAt));
    } catch {
      return null;
    }
  }
}
