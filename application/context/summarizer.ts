import type { ChatHandlers } from '../../domain/events.js';
import { emitEvent, rateLimitStreamEvent } from '../../domain/events.js';
import type { ChatMessage, LLMProvider, ServiceTier } from '../../domain/llm.js';
import { logger } from '../../shared/logger.js';
import type { MessageContext } from './message-context.js';

export const SUMMARY_MESSAGE_PREFIX = 'Önceki konuşmaların özeti:';

const TOOL_RESULT_MAX_CHARS = 200;

export function isSummaryMessage(message: ChatMessage): boolean {
  return (
    message.role === 'user' &&
    typeof message.content === 'string' &&
    message.content.startsWith(SUMMARY_MESSAGE_PREFIX)
  );
}

function compactMessageForSummary(message: ChatMessage): string | null {
  if (message.role === 'system') return null;

  if (isSummaryMessage(message)) {
    return message.content;
  }

  if (message.role === 'tool') {
    const body = String(message.content ?? '').slice(0, TOOL_RESULT_MAX_CHARS);
    return `[tool] ${body}`;
  }

  if (message.role === 'user' || message.role === 'assistant') {
    return `[${message.role}] ${message.content ?? ''}`;
  }

  return null;
}

function formatSummaryInput(messages: ChatMessage[]): string {
  return messages
    .map(compactMessageForSummary)
    .filter((line): line is string => Boolean(line))
    .join('\n\n');
}

export async function applyContextManagement(
  context: MessageContext,
  autoSummary: boolean,
  handlers: ChatHandlers | undefined,
  summarize: () => Promise<void>
): Promise<void> {
  if (!context.shouldManage()) return;

  logger.debug('Context management triggered', {
    autoSummary,
    currentMessages: context.getMessages().length,
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
  model: string,
  handlers?: ChatHandlers,
  serviceTier?: ServiceTier,
): Promise<void> {
  const { toSummarize, keepIndex } = context.getMessagesToSummarize();

  if (toSummarize.length === 0) {
    logger.debug('Nothing to summarize');
    return;
  }

  logger.info('Summarizing history', {
    messageCount: toSummarize.length,
    keepIndex,
  });

  emitEvent(handlers, { type: 'lifecycle', phase: 'summarizing' });

  const summaryPrompt =
    `Aşağıdaki konuşma geçmişini özetle. Şu formatta yaz:\n\n` +
    `TAMAMLANAN GÖREVLER: (ne yapıldı, sonucu ne oldu)\n` +
    `ÖNEMLİ KARARLAR: (kullanıcının verdiği kararlar, tercihler)\n` +
    `DEVAM EDEN İŞLER: (yarım kalan veya takip gereken şeyler)\n\n` +
    `Gereksiz detay, hata mesajı tekrarı ve sohbet selamlaşması ekleme.\n\n` +
    `Konuşma:\n${formatSummaryInput(toSummarize)}`;

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
      content: `${SUMMARY_MESSAGE_PREFIX} ${response.content}`,
    };

    const messages = context.getMessages();
    const hasSystem = messages.length > 0 && messages[0].role === 'system';
    const recentMessages = messages.slice(keepIndex);

    if (hasSystem) {
      context.setMessages([messages[0], summaryMessage, ...recentMessages]);
    } else {
      context.setMessages([summaryMessage, ...recentMessages]);
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
