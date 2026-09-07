import type { ChatHandlers } from '../../domain/events.js';
import { emitEvent } from '../../domain/events.js';
import type { LLMProvider } from '../../domain/llm.js';
import { logger } from '../../shared/logger.js';
import type { MessageContext } from './message-context.js';

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
  handlers?: ChatHandlers
): Promise<void> {
  const { toSummarize, keepIndex } = context.getMessagesToSummarize();

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
    `Konuşma:\n${JSON.stringify(toSummarize)}`;

  try {
    const response = await provider.chat({
      model,
      messages: [{ role: 'user', content: summaryPrompt }],
    });

    const summaryMessage = {
      role: 'system',
      content: `Önceki konuşmaların özeti: ${response.content}`,
    };

    const messages = context.getMessages();
    const systemMessage = messages[0];
    const recentMessages = messages.slice(keepIndex);

    context.setMessages([systemMessage, summaryMessage, ...recentMessages]);
    emitEvent(handlers, { type: 'lifecycle', phase: 'summarized' });
    logger.info('History summarized and updated', {
      newMessageCount: context.getMessages().length,
    });
  } catch (error: any) {
    logger.error('Failed to summarize history', { error: error.message });
    context.trim();
  }
}
