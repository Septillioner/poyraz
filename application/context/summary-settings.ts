import type { ChatMessage } from '../../domain/llm.js';
import type { SummaryPromptBuilder } from '../agent/config.js';

/**
 * Single source of the summarization defaults. Everything here is language-neutral;
 * hosts replace the prompt and prefix through `summarization.prompt` / `summarization.prefix`.
 */

/** Default prefix of the summary message. Hosts override it with `summarization.prefix`. */
export const DEFAULT_SUMMARY_MESSAGE_PREFIX = 'Summary of the earlier conversation:';

/** Placeholder a string prompt may contain; replaced by the compacted conversation. */
export const SUMMARY_CONVERSATION_PLACEHOLDER = '{{conversation}}';

/** Default summarization prompt (neutral English). Ends with the conversation placeholder. */
export const DEFAULT_SUMMARY_PROMPT =
  'Summarize the conversation below so the summary can replace the older messages. ' +
  'Use this format:\n\n' +
  'COMPLETED: (what was done and its outcome)\n' +
  'DECISIONS: (decisions and preferences the user stated)\n' +
  'OPEN ITEMS: (unfinished work or things to follow up on)\n\n' +
  'Leave out needless detail, repeated error messages and greetings.\n\n' +
  `Conversation:\n${SUMMARY_CONVERSATION_PLACEHOLDER}`;

export const DEFAULT_SUMMARY_THRESHOLD_RATIO = 0.8;
export const MIN_SUMMARY_THRESHOLD_RATIO = 0.5;
export const MAX_SUMMARY_THRESHOLD_RATIO = 0.95;

/** Share of `contextLimit` kept verbatim after a trim or summary when nothing else is configured. */
export const DEFAULT_KEEP_RATIO = 0.6;
export const MIN_KEEP_RATIO = 0.1;
export const MAX_KEEP_RATIO = 0.9;

/** Tool results are cut to this many characters inside the summarization input. */
export const DEFAULT_SUMMARY_TOOL_RESULT_MAX_CHARS = 200;

/** Clamps to 0.5..0.95; missing or non-finite values give `DEFAULT_SUMMARY_THRESHOLD_RATIO`. */
export function normalizeSummaryThreshold(ratio: number | undefined): number {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return DEFAULT_SUMMARY_THRESHOLD_RATIO;
  return Math.min(MAX_SUMMARY_THRESHOLD_RATIO, Math.max(MIN_SUMMARY_THRESHOLD_RATIO, ratio));
}

/** Clamps to 0.1..0.9; missing or non-finite values give `DEFAULT_KEEP_RATIO`. */
export function normalizeKeepRatio(ratio: number | undefined): number {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return DEFAULT_KEEP_RATIO;
  return Math.min(MAX_KEEP_RATIO, Math.max(MIN_KEEP_RATIO, ratio));
}

/** The configured prefix, or the default when it is missing or blank. */
export function resolveSummaryPrefix(prefix?: string): string {
  const trimmed = typeof prefix === 'string' ? prefix.trim() : '';
  return trimmed || DEFAULT_SUMMARY_MESSAGE_PREFIX;
}

/** True for a rolling-summary message: a user message starting with `prefix` (default prefix when omitted). */
export function isSummaryMessage(message: ChatMessage, prefix?: string): boolean {
  return (
    message.role === 'user' &&
    typeof message.content === 'string' &&
    message.content.startsWith(resolveSummaryPrefix(prefix))
  );
}

/**
 * Builds the request text. A function gets the conversation; a string has
 * `{{conversation}}` replaced (or the conversation appended when it has no placeholder);
 * omitted or blank gives the default prompt.
 */
export function buildSummaryPrompt(
  conversation: string,
  prompt?: string | SummaryPromptBuilder
): string {
  if (typeof prompt === 'function') return prompt(conversation);
  const template = typeof prompt === 'string' && prompt.trim() ? prompt : DEFAULT_SUMMARY_PROMPT;
  if (!template.includes(SUMMARY_CONVERSATION_PLACEHOLDER)) return `${template}\n\n${conversation}`;
  return template.split(SUMMARY_CONVERSATION_PLACEHOLDER).join(conversation);
}
