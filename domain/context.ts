import type { ChatMessage, TokenCost, TokenUsage } from './llm.js';

/**
 * Context categories. Every piece of a model request belongs to exactly one of
 * them. Message categories are assigned when the message is stored, tool schema
 * categories when the request is compiled; nothing is guessed at measure time.
 *
 * - `system`       host system text (system message minus rules)
 * - `rules`        host rules appended to the system message
 * - `skills`       skill catalog (the `load_skill` tool schema) and loaded skill bodies
 * - `tools`        tool schemas that are not MCP-bridged
 * - `mcp`          tool schemas bridged from MCP servers
 * - `summary`      rolling summary message
 * - `conversation` user text and assistant text
 * - `toolCalls`    assistant `tool_calls` (name + arguments)
 * - `toolResults`  `role: 'tool'` messages (except loaded skills)
 * - `providerMeta` provider replay payload that is not already counted as text/tool calls
 */
export const CONTEXT_CATEGORIES = [
  'system',
  'rules',
  'skills',
  'tools',
  'mcp',
  'summary',
  'conversation',
  'toolCalls',
  'toolResults',
  'providerMeta',
] as const;

export type ContextCategory = (typeof CONTEXT_CATEGORIES)[number];

/** Whole-number value per category (tokens or characters). */
export type ContextCategoryTokens = Record<ContextCategory, number>;

export function emptyCategoryTokens(): ContextCategoryTokens {
  return {
    system: 0,
    rules: 0,
    skills: 0,
    tools: 0,
    mcp: 0,
    summary: 0,
    conversation: 0,
    toolCalls: 0,
    toolResults: 0,
    providerMeta: 0,
  };
}

/** Category + size metadata stored next to a message when it enters the context. */
export interface MessageContextMeta {
  /** Primary category of the message (the one a UI would file it under). */
  category: ContextCategory;
  /** Characters per category; an assistant tool-call message spans several. */
  chars: Partial<Record<ContextCategory, number>>;
  /** Fixed framing and estimated image cost, charged to `category`. */
  overheadTokens: number;
  /** Token estimate per category at storage time (estimator in effect then). */
  tokens: Partial<Record<ContextCategory, number>>;
}

export type ToolSchemaCategory = Extract<ContextCategory, 'tools' | 'mcp' | 'skills'>;

/** One tool schema as sent to the provider, with its category and size. */
export interface CompiledToolSchema {
  name: string;
  category: ToolSchemaCategory;
  chars: number;
}

/** Locally computed token estimate of one request (or of the current context). */
export interface ContextEstimate {
  categories: ContextCategoryTokens;
  total: number;
  /** Characters behind the estimate; used to calibrate chars/token. */
  chars: number;
  /** Fixed framing and estimated image tokens included in `total`. */
  overheadTokens: number;
}

/** Estimate minus real, so a positive value means the estimate ran high. */
export interface ContextDrift {
  tokens: number;
  /** estimate / real (1 = exact); null when real is 0. */
  ratio: number | null;
  /** (estimate - real) / real * 100; null when real is 0. */
  percent: number | null;
}

/** One model request: what the estimator said before it was sent, what the provider reported after. */
export interface ContextRequestRecord {
  seq: number;
  at: number;
  model: string;
  estimate: ContextEstimate;
  real?: TokenUsage;
  drift?: ContextDrift;
  /** Request cost calculated when provider usage arrived, if token pricing was configured. */
  cost?: TokenCost;
}

/** Provider-reported prompt size broken down by category (estimate shares scaled to the real total). */
export interface ContextRealSnapshot {
  seq: number;
  at: number;
  usage: TokenUsage;
  categories: ContextCategoryTokens;
  /** Equals `usage.promptTokens`. */
  total: number;
  estimate: ContextEstimate;
  drift: ContextDrift;
}

export interface ContextMeter {
  source: 'estimate' | 'real';
  categories: ContextCategoryTokens;
  total: number;
  /** Configured context window, or null when unknown. */
  windowTokens: number | null;
  /** total / windowTokens * 100 (one decimal, not capped); null without a window. */
  percent: number | null;
}

/** Prompt parts exposed separately by `buildSystemPrompt`. */
export interface SystemPromptParts {
  /** Host system text. */
  system: string;
  /** Rules joined by a blank line (already part of the system message). */
  rules: string;
  /**
   * Skill catalog text (`name: description` per line). Informational: it is NOT in
   * the system message, the model sees it inside the `load_skill` tool description.
   */
  skills: string;
}

export interface CompileRequestOptions {
  /** `false` compiles a tool-less request (fallback turns). Default true. */
  includeTools?: boolean;
}

/** The request exactly as it goes to the provider, plus its measurement. */
export interface CompiledRequest {
  model: string;
  /** Copy of the history array; message objects are shared with the context. */
  messages: ChatMessage[];
  /** Policy-filtered OpenAI-style tool schemas. */
  tools: any[];
  parts: SystemPromptParts;
  toolSchemas: CompiledToolSchema[];
  estimate: ContextEstimate;
}
