import type { ChatMessage } from '../../domain/llm.js';
import {
  emptyCategoryTokens,
  type ContextCategory,
  type MessageContextMeta,
} from '../../domain/context.js';
import { LOAD_SKILL_TOOL_NAME } from '../../tools/definitions/skills.js';
import { isSummaryMessage } from './summary-settings.js';
import type { TokenEstimator } from './token-estimate.js';

/** Names that depend on host configuration. Every field falls back to the library default. */
export interface CategorizeOptions {
  /** Prefix that marks a summary message (`summarization.prefix`). */
  summaryPrefix?: string;
  /** Tool whose results are filed under `skills` (`skillTool.toolName`). */
  skillToolName?: string;
}

/** tool_call_id -> tool name, built from the assistant messages seen so far. */
export type ToolNameIndex = Map<string, string>;

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

/** Records the tool names of an assistant message so later tool results can be classified. */
export function indexToolCalls(message: ChatMessage, index: ToolNameIndex): void {
  if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) return;
  for (const call of message.tool_calls) {
    if (call?.id && call.function?.name) index.set(call.id, call.function.name);
  }
}

/** Primary category of a message. Decided from the message itself plus the tool-name index. */
export function categorizeMessage(
  message: ChatMessage,
  toolNames: ToolNameIndex,
  options: CategorizeOptions = {}
): ContextCategory {
  if (message.role === 'system') return 'system';
  if (message.role === 'tool') {
    const name = message.tool_call_id ? toolNames.get(message.tool_call_id) : undefined;
    const skillToolName = options.skillToolName?.trim() || LOAD_SKILL_TOOL_NAME;
    return name === skillToolName ? 'skills' : 'toolResults';
  }
  if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return 'toolCalls';
  }
  if (isSummaryMessage(message, options.summaryPrefix)) return 'summary';
  return 'conversation';
}

function toolCallChars(message: ChatMessage): number {
  let chars = 0;
  for (const call of message.tool_calls ?? []) {
    chars += (call.id?.length ?? 0) + (call.function?.name?.length ?? 0);
    chars += textOf(call.function?.arguments).length;
  }
  return chars;
}

/**
 * Builds the category/size metadata stored next to a message.
 *
 * An assistant message that carries tool calls spans categories: its text is
 * `conversation`, its calls are `toolCalls`. `providerMeta` is the provider's
 * replay payload; providers send it *instead of* the text and tool calls of that
 * message, so only the part that exceeds them is charged to `providerMeta`.
 */
export function buildMessageMeta(
  message: ChatMessage,
  toolNames: ToolNameIndex,
  estimator: TokenEstimator,
  options: CategorizeOptions = {}
): MessageContextMeta {
  const category = categorizeMessage(message, toolNames, options);
  const content = textOf(message.content);
  const chars: Partial<Record<ContextCategory, number>> = {};

  const callChars = message.role === 'assistant' ? toolCallChars(message) : 0;
  if (message.role === 'assistant' && category === 'toolCalls') {
    if (content.length > 0) chars.conversation = content.length;
    chars.toolCalls = callChars;
  } else if (content.length > 0) {
    chars[category] = content.length;
  }

  if (message.providerMeta) {
    const metaChars = textOf(message.providerMeta).length;
    const sentAsText = content.length + callChars;
    const extra = metaChars - sentAsText;
    if (extra > 0) chars.providerMeta = extra;
  }

  // Image costs vary by provider and resolution. Use a bounded local estimate;
  // never count base64 as text. Completed requests use provider-reported usage.
  const overheadTokens = estimator.messageOverheadTokens + (message.images?.length ?? 0) * 1536;

  const tokens: Partial<Record<ContextCategory, number>> = {};
  const totals = emptyCategoryTokens();
  for (const [key, value] of Object.entries(chars) as [ContextCategory, number][]) {
    totals[key] = estimator.tokensForChars(value);
  }
  totals[category] += overheadTokens;
  for (const key of Object.keys(totals) as ContextCategory[]) {
    if (totals[key] > 0) tokens[key] = totals[key];
  }

  return { category, chars, overheadTokens, tokens };
}
