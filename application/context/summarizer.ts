import type { ChatHandlers } from '../../domain/events.js';
import { emitEvent, rateLimitStreamEvent } from '../../domain/events.js';
import type { ChatMessage, LLMProvider, ServiceTier } from '../../domain/llm.js';
import { logger } from '../../shared/logger.js';
import type { OnSummarizedHook, SummarizedContext, SummaryPromptBuilder } from '../agent/config.js';
import type { MessageContext } from './message-context.js';
import {
  buildSummaryPrompt,
  DEFAULT_SUMMARY_MESSAGE_PREFIX,
  DEFAULT_SUMMARY_THRESHOLD_RATIO,
  DEFAULT_SUMMARY_TOOL_RESULT_MAX_CHARS,
  isSummaryMessage,
  normalizeSummaryThreshold,
  resolveSummaryPrefix,
} from './summary-settings.js';

export {
  DEFAULT_SUMMARY_MESSAGE_PREFIX,
  DEFAULT_SUMMARY_THRESHOLD_RATIO,
  isSummaryMessage,
  normalizeSummaryThreshold,
};

/** Default prefix of the summary message (kept for existing imports; see `DEFAULT_SUMMARY_MESSAGE_PREFIX`). */
export const SUMMARY_MESSAGE_PREFIX = DEFAULT_SUMMARY_MESSAGE_PREFIX;

/** What `summarizeHistory` takes from `AgentConfig.summarization`. Every field is optional. */
export interface SummarizeOptions {
  /** Prompt (string with optional `{{conversation}}`, or a builder). Omitted -> neutral built-in prompt. */
  prompt?: string | SummaryPromptBuilder;
  /** Prefix of the summary message. Omitted -> `DEFAULT_SUMMARY_MESSAGE_PREFIX`. */
  prefix?: string;
  /** Share of the context limit kept verbatim. Omitted -> 0.6. */
  keepRatio?: number;
  /** Tool results are cut to this length in the summarization input. Omitted -> 200. */
  toolResultMaxChars?: number;
  /** Called right after a summary replaced the history (see `SummarizationConfig.onSummarized`). */
  onSummarized?: OnSummarizedHook;
}

/** Token estimate of the messages in `context` (message text and tool calls, no tool schemas). */
function estimateContextTokens(context: MessageContext): number {
  let total = 0;
  for (const { meta } of context.getMessageEntries()) {
    for (const value of Object.values(meta.tokens)) total += value ?? 0;
  }
  return total;
}

/** Runs the hook; a throwing or non-text hook never breaks the summary. Returns the text to append, if any. */
async function runSummarizedHook(hook: OnSummarizedHook, summarized: SummarizedContext): Promise<string> {
  try {
    const text = await hook(summarized);
    return typeof text === 'string' ? text.trim() : '';
  } catch (error: any) {
    logger.warn('onSummarized hook failed; the summary is kept as is', { error: error?.message ?? String(error) });
    return '';
  }
}

function compactMessageForSummary(
  message: ChatMessage,
  prefix: string,
  toolResultMaxChars: number
): string | null {
  if (message.role === 'system') return null;

  if (isSummaryMessage(message, prefix)) {
    return message.content;
  }

  if (message.role === 'tool') {
    const body = String(message.content ?? '').slice(0, toolResultMaxChars);
    return `[tool] ${body}`;
  }

  if (message.role === 'user' || message.role === 'assistant') {
    return `[${message.role}] ${message.content ?? ''}`;
  }

  return null;
}

function formatSummaryInput(messages: ChatMessage[], prefix: string, toolResultMaxChars: number): string {
  return messages
    .map((message) => compactMessageForSummary(message, prefix, toolResultMaxChars))
    .filter((line): line is string => Boolean(line))
    .join('\n\n');
}

function resolveToolResultMaxChars(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : DEFAULT_SUMMARY_TOOL_RESULT_MAX_CHARS;
}

export interface TokenSummaryTrigger {
  promptTokens?: number;
  contextWindowTokens?: number;
  summaryThresholdRatio?: number;
}

export function shouldSummarizeByTokens(trigger: TokenSummaryTrigger): boolean {
  const promptTokens = trigger.promptTokens;
  const window = trigger.contextWindowTokens;
  if (typeof promptTokens !== 'number' || !Number.isFinite(promptTokens) || promptTokens <= 0) return false;
  if (typeof window !== 'number' || !Number.isFinite(window) || window <= 0) return false;
  return promptTokens >= window * normalizeSummaryThreshold(trigger.summaryThresholdRatio);
}

/**
 * Runs between turns. With `autoSummary` off nothing is ever summarized: the history is
 * only trimmed once the turn limit is exceeded (token pressure alone never acts).
 */
export async function applyContextManagement(
  context: MessageContext,
  autoSummary: boolean,
  handlers: ChatHandlers | undefined,
  summarize: () => Promise<void>,
  tokenTrigger?: TokenSummaryTrigger
): Promise<void> {
  const tokenPressure = autoSummary && tokenTrigger ? shouldSummarizeByTokens(tokenTrigger) : false;
  if (!tokenPressure && !context.shouldManage()) return;

  logger.debug('Context management triggered', {
    autoSummary,
    currentMessages: context.getMessages().length,
    promptTokens: tokenTrigger?.promptTokens,
    contextWindowTokens: tokenTrigger?.contextWindowTokens,
    tokenPressure,
  });

  if (autoSummary) {
    await summarize();
  } else {
    context.trim();
  }
}

export async function summarizeHistory(
  context: MessageContext,
  provider: LLMProvider,
  model: string | undefined,
  handlers?: ChatHandlers,
  serviceTier?: ServiceTier,
  options: SummarizeOptions = {}
): Promise<void> {
  const prefix = resolveSummaryPrefix(options.prefix);
  const { toSummarize, keepIndex } = context.getMessagesToSummarize(options.keepRatio);
  const tokensBefore = options.onSummarized ? estimateContextTokens(context) : 0;

  if (toSummarize.length === 0) {
    logger.debug('Nothing to summarize');
    return;
  }

  logger.info('Summarizing history', {
    messageCount: toSummarize.length,
    keepIndex,
  });

  emitEvent(handlers, { type: 'lifecycle', phase: 'summarizing' });

  const summaryPrompt = buildSummaryPrompt(
    formatSummaryInput(toSummarize, prefix, resolveToolResultMaxChars(options.toolResultMaxChars)),
    options.prompt
  );

  try {
    const response = await provider.chat({
      model,
      messages: [{ role: 'user', content: summaryPrompt }],
      serviceTier,
      signal: handlers?.signal,
      onRateLimit: (notice) => emitEvent(handlers, rateLimitStreamEvent(notice)),
    });

    const summaryMessage: ChatMessage = {
      role: 'user',
      content: `${prefix} ${response.content}`,
    };

    const messages = context.getMessages();
    const hasSystem = messages.length > 0 && messages[0].role === 'system';
    const recentMessages = messages.slice(keepIndex);

    const withSummary = (summary: ChatMessage): ChatMessage[] =>
      hasSystem ? [messages[0], summary, ...recentMessages] : [summary, ...recentMessages];
    context.setMessages(withSummary(summaryMessage));

    if (options.onSummarized) {
      const extra = await runSummarizedHook(options.onSummarized, {
        summary: response.content,
        prefix,
        summarizedMessages: toSummarize.length,
        keptMessages: recentMessages.length,
        tokensBefore,
        tokensAfter: estimateContextTokens(context),
        messages: context.getMessagesCopy(),
      });
      if (extra) {
        context.setMessages(withSummary({ ...summaryMessage, content: `${summaryMessage.content}\n${extra}` }));
      }
    }

    emitEvent(handlers, { type: 'lifecycle', phase: 'summarized' });
    logger.info('History summarized and updated', {
      newMessageCount: context.getMessages().length,
    });
  } catch (error: any) {
    logger.error('Failed to summarize history', { error: error.message });
    context.trim();
  }
}
