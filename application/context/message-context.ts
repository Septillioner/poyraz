import type { ChatMessage } from '../../domain/llm.js';
import { logger } from '../../shared/logger.js';

export interface ContextOptions {
  limit: number;
}

export interface MessageContext {
  addMessage(message: ChatMessage): void;
  getMessages(): ChatMessage[];
  getMessagesCopy(): ChatMessage[];
  setMessages(messages: ChatMessage[]): void;
  clear(): void;
  getMemoryUsage(): { current: number; limit: number; percentage: number };
  shouldManage(): boolean;
  trim(): void;
  getMessagesToSummarize(): { toSummarize: ChatMessage[]; keepIndex: number };
}

function hasPinnedSystem(messages: ChatMessage[]): boolean {
  return messages.length > 0 && messages[0].role === 'system';
}

export function createMessageContext(options: ContextOptions): MessageContext {
  let messages: ChatMessage[] = [];

  const getConversationTurnCount = () =>
    messages.filter((m) => m.role === 'user' || m.role === 'assistant').length;

  const findCutIndex = (keepTurns: number): number => {
    const pinnedSystem = hasPinnedSystem(messages);
    const minIndex = pinnedSystem ? 1 : 0;
    let keptTurns = 0;
    let cutIndex = messages.length;

    for (let i = messages.length - 1; i >= minIndex; i--) {
      if (messages[i].role === 'user' || messages[i].role === 'assistant') {
        keptTurns++;
      }
      if (keptTurns >= keepTurns) {
        cutIndex = i;
        break;
      }
    }

    cutIndex = Math.max(minIndex, cutIndex);
    while (cutIndex > minIndex && messages[cutIndex].role === 'tool') {
      cutIndex--;
    }

    return cutIndex;
  };

  return {
    addMessage(message: ChatMessage) {
      messages.push(message);
    },
    getMessages() {
      return messages;
    },
    getMessagesCopy() {
      return [...messages];
    },
    setMessages(newMessages: ChatMessage[]) {
      messages = [...newMessages];
    },
    clear() {
      messages = [];
    },
    getMemoryUsage() {
      const current = messages.filter((m) => m.role !== 'system').length;
      const limit = options.limit;
      return {
        current,
        limit,
        percentage: Math.min(100, Math.round((current / limit) * 100)),
      };
    },
    shouldManage() {
      return getConversationTurnCount() > options.limit;
    },
    trim() {
      const turnCount = getConversationTurnCount();
      if (turnCount <= options.limit) return;

      logger.info(`Trimming history (${turnCount} turns exceeds limit ${options.limit})...`);
      const keepTurns = Math.ceil(options.limit * 0.6);
      const cutIndex = findCutIndex(keepTurns);
      const recentMessages = messages.slice(cutIndex);

      if (hasPinnedSystem(messages)) {
        messages = [messages[0], ...recentMessages];
      } else {
        messages = recentMessages;
      }
    },
    getMessagesToSummarize() {
      const keepTurns = Math.ceil(options.limit * 0.6);
      const keepIndex = findCutIndex(keepTurns);
      const startIndex = hasPinnedSystem(messages) ? 1 : 0;

      return {
        toSummarize: messages.slice(startIndex, keepIndex),
        keepIndex,
      };
    },
  };
}
