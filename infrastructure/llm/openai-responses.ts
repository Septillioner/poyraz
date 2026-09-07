import type {
  ChatMessage,
  ChatResponse,
  TokenUsage,
  ToolCall,
} from '../../domain/llm.js';
import { logger } from '../../shared/logger.js';

const OPENAI_HOST_MARKER = 'openai.com';
const CODEX_MODEL_PATTERN = /codex/i;
const RESPONSES_ENDPOINT_HINT = /v1\/responses/i;
const HTTP_NOT_FOUND = 404;

export function isOpenAiHost(baseUrl: string): boolean {
  return baseUrl.includes(OPENAI_HOST_MARKER);
}

export function requiresOpenAIResponsesApi(model: string, baseUrl: string): boolean {
  return isOpenAiHost(baseUrl) && CODEX_MODEL_PATTERN.test(model);
}

export function isResponsesApiRequiredError(error: unknown): boolean {
  const err = error as { status?: number; statusCode?: number; message?: string };
  const status = err?.status ?? err?.statusCode;
  const message = String(err?.message ?? '');
  return status === HTTP_NOT_FOUND && RESPONSES_ENDPOINT_HINT.test(message);
}

export interface ResponsesToolDefinition {
  type: 'function';
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict: false;
}

export function toResponsesTools(tools: unknown[] | undefined): ResponsesToolDefinition[] | undefined {
  if (!tools?.length) return undefined;

  return tools.map((raw) => {
    const tool = raw as {
      type?: string;
      name?: string;
      description?: string;
      parameters?: Record<string, unknown>;
      function?: {
        name?: string;
        description?: string;
        parameters?: Record<string, unknown>;
      };
    };

    if (tool.function) {
      return {
        type: 'function' as const,
        name: tool.function.name || '',
        description: tool.function.description,
        parameters: tool.function.parameters,
        strict: false as const,
      };
    }

    return {
      type: 'function' as const,
      name: tool.name || '',
      description: tool.description,
      parameters: tool.parameters,
      strict: false as const,
    };
  });
}

export interface ResponsesRequestParts {
  instructions?: string;
  input: unknown[];
}

function stringifyToolArguments(args: unknown): string {
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return '{}';
  }
}

/**
 * Convert Chat Completions-style messages into Responses API input items.
 * System messages become top-level `instructions`; reasoning/output items are replayed from providerMeta.
 */
export function toResponsesInput(messages: ChatMessage[]): ResponsesRequestParts {
  const instructionParts: string[] = [];
  const input: unknown[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      if (msg.content) instructionParts.push(msg.content);
      continue;
    }

    const replayItems = msg.providerMeta?.openai?.outputItems;
    if (msg.role === 'assistant' && Array.isArray(replayItems) && replayItems.length > 0) {
      input.push(...replayItems);
      continue;
    }

    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      if (msg.content) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: msg.content,
        });
      }
      for (const tc of msg.tool_calls) {
        input.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.function.name,
          arguments: stringifyToolArguments(tc.function.arguments),
        });
      }
      continue;
    }

    if (msg.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id || '',
        output: msg.content ?? '',
      });
      continue;
    }

    input.push({
      role: msg.role,
      content: msg.content ?? '',
    });
  }

  const instructions = instructionParts.length > 0 ? instructionParts.join('\n\n') : undefined;
  return { instructions, input };
}

function parseToolArguments(raw: string, toolName: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || '{}') as Record<string, unknown>;
  } catch (error: any) {
    logger.warn('Invalid tool arguments JSON from Responses API', {
      toolName,
      rawArguments: raw || '',
      error: error?.message || String(error),
    });
    return {
      _invalid_arguments: true,
      _raw: raw || '',
    };
  }
}

export function extractToolCallsFromOutput(output: unknown[] | undefined): ToolCall[] {
  if (!output?.length) return [];

  const toolCalls: ToolCall[] = [];
  for (const item of output) {
    const typed = item as {
      type?: string;
      call_id?: string;
      name?: string;
      arguments?: string;
    };
    if (typed.type !== 'function_call') continue;
    toolCalls.push({
      id: typed.call_id || '',
      type: 'function',
      function: {
        name: typed.name || '',
        arguments: parseToolArguments(typed.arguments || '{}', typed.name || 'unknown'),
      },
    });
  }
  return toolCalls;
}

export function mapResponsesUsage(usage: {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
} | null | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  const promptTokens = usage.input_tokens ?? 0;
  const completionTokens = usage.output_tokens ?? 0;
  const cachedTokens = usage.input_tokens_details?.cached_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: usage.total_tokens ?? promptTokens + completionTokens,
    ...(cachedTokens > 0 ? { cachedTokens } : {}),
  };
}

export function buildChatResponseFromResponsesOutput(params: {
  content: string;
  output: unknown[] | undefined;
  usage: TokenUsage | undefined;
}): ChatResponse {
  const tool_calls = extractToolCallsFromOutput(params.output);
  const providerMeta =
    params.output && params.output.length > 0
      ? { openai: { outputItems: params.output } }
      : undefined;

  return {
    content: params.content,
    tool_calls: tool_calls.length > 0 ? tool_calls : undefined,
    usage: params.usage,
    providerMeta,
  };
}
