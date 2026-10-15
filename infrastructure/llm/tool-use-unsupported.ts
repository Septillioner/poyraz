import type { ChatOptions, ChatResponse, LLMProvider } from '../../domain/llm.js';

/** `code` of `ToolUseUnsupportedError`. */
export const TOOL_USE_UNSUPPORTED_CODE = 'TOOL_USE_UNSUPPORTED';

/**
 * The model (or the route behind it) cannot take tools. Thrown by the built-in providers in place of
 * the provider's own error, which stays available as `cause` and whose text is kept as `message`.
 * A host can catch it and retry the turn without tools.
 */
export class ToolUseUnsupportedError extends Error {
  readonly code = TOOL_USE_UNSUPPORTED_CODE;
  readonly model?: string;
  /** HTTP status of the provider error, when it had one. */
  readonly status?: number;

  constructor(message: string, details: { cause?: unknown; model?: string } = {}) {
    super(message, { cause: details.cause });
    this.name = 'ToolUseUnsupportedError';
    this.model = details.model;
    const source = details.cause as { status?: unknown; statusCode?: unknown } | null | undefined;
    const status = source?.status ?? source?.statusCode;
    this.status = typeof status === 'number' ? status : undefined;
  }
}

// Wordings seen from OpenRouter ("No endpoints found that support tool use"), OpenAI ("'tools' is not
// supported with this model"), Ollama ("... does not support tools"), Gemini ("Function calling is not
// enabled / supported ..."), Groq ("... does not support tool use / tool calling"), llama.cpp
// ("tools param requires --jinja flag") and vLLM ("auto tool choice requires --enable-auto-tool-choice").
const TOOL_WORD = String.raw`(?:tools?|tool[ _-]?(?:use|calls?|calling|choice)|function[ _-]?calls?|function[ _-]?calling|functions)`;
const PATTERNS: RegExp[] = [
  /no endpoints found that support tool/i,
  new RegExp(String.raw`(?:does(?:\s?n[o']t| not)|do(?:\s?n[o']t| not)|can(?:no|')t|unable to)\s+(?:currently\s+)?(?:support|use|handle|accept|work with)\s+(?:the\s+|any\s+)?${TOOL_WORD}`, 'i'),
  new RegExp(String.raw`${TOOL_WORD}\s+(?:is|are)\s+(?:currently\s+)?(?:not\s+(?:supported|available|enabled|allowed)|unsupported|disabled)`, 'i'),
  new RegExp(String.raw`(?:unsupported|invalid)\s+(?:parameter|field|value|request)s?:?\s*['"\x60]?${TOOL_WORD}['"\x60]?[^.\n]*(?:not supported|unsupported|not allowed)`, 'i'),
  new RegExp(String.raw`(?:not supported|unsupported)\s+(?:for|with|by|on)\s+(?:this|the)\s+model[^.\n]*${TOOL_WORD}`, 'i'),
  new RegExp(String.raw`${TOOL_WORD}[^.\n]{0,40}(?:not supported|unsupported)\s+(?:for|with|by|on)\s+(?:this|the)\s+model`, 'i'),
  new RegExp(String.raw`(?:model|endpoint|provider)[^.\n]{0,60}(?:lacks|without|has no)\s+(?:support\s+for\s+)?${TOOL_WORD}`, 'i'),
  /(?:tools?|tool_choice)\s+param(?:eter)?\s+requires\s+--jinja/i,
  /tool choice requires\s+--enable-auto-tool-choice/i,
  /--jinja[^.\n]*\btools?\b|\btools?\b[^.\n]*--jinja/i,
];
// Statuses that say something else is wrong: bad credentials, quota.
const OTHER_CAUSE_STATUSES = new Set([401, 403, 429]);

function textsOf(error: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 3 || error === null || error === undefined) return out;
  if (typeof error === 'string') {
    out.push(error);
    return out;
  }
  if (typeof error !== 'object') return out;
  const record = error as Record<string, unknown>;
  for (const key of ['message', 'detail', 'raw', 'body']) {
    if (typeof record[key] === 'string') out.push(record[key] as string);
  }
  // OpenRouter nests the upstream text in `error.metadata.raw`; the SDKs nest the body in `error.error`.
  for (const key of ['error', 'metadata', 'response', 'data', 'cause']) {
    if (record[key] !== undefined) textsOf(record[key], depth + 1, out);
  }
  return out;
}

function statusOf(error: unknown): number | undefined {
  const record = error as { status?: unknown; statusCode?: unknown; code?: unknown; error?: { code?: unknown } } | null | undefined;
  for (const value of [record?.status, record?.statusCode, record?.code, record?.error?.code]) {
    if (typeof value === 'number') return value;
  }
  return undefined;
}

/**
 * True for a provider error that means "this model cannot use tools", whatever the provider or
 * SDK wrapped it in. Also true for a `ToolUseUnsupportedError` (or anything carrying its `code`).
 * Aborts, auth and rate-limit failures are never reported as this.
 */
export function isToolUseUnsupportedError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ((error as { code?: unknown }).code === TOOL_USE_UNSUPPORTED_CODE) return true;
  const name = (error as { name?: string }).name;
  if (name === 'AbortError' || name === 'APIUserAbortError' || name === 'ChatAbortedError') return false;
  const status = statusOf(error);
  if (status !== undefined && OTHER_CAUSE_STATUSES.has(status)) return false;
  const text = textsOf(error).join('\n');
  return text.length > 0 && PATTERNS.some((pattern) => pattern.test(text));
}

/** The error as `ToolUseUnsupportedError` when it is one, else `undefined`. */
export function classifyToolUseUnsupported(error: unknown, model?: string): ToolUseUnsupportedError | undefined {
  if (error instanceof ToolUseUnsupportedError) return error;
  if (!isToolUseUnsupportedError(error)) return undefined;
  const message = textsOf(error)[0] ?? 'The model does not support tool use';
  return new ToolUseUnsupportedError(message, { cause: error, model });
}

/** Makes every `chat` rejection of `provider` that means "no tool support" a `ToolUseUnsupportedError`. */
export function withToolUseClassification(provider: LLMProvider): LLMProvider {
  return {
    async chat(options: ChatOptions, onToken, onReasoning): Promise<ChatResponse> {
      try {
        return await provider.chat(options, onToken, onReasoning);
      } catch (error) {
        throw classifyToolUseUnsupported(error, options.model) ?? error;
      }
    },
  };
}
