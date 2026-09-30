import type { ChatMessage } from '../../domain/llm.js';
import { logger } from '../../shared/logger.js';

const KEPT_TURN_RATIO = 0.6;

export interface ContextOptions {
  limit?: number;
}

export interface MemoryUsage {
  current: number;
  limit: number | null;
  percentage: number | null;
}

export interface MessageContext {
  addMessage(message: ChatMessage): void;
  getMessages(): ChatMessage[];
  getMessagesCopy(): ChatMessage[];
  setMessages(messages: ChatMessage[]): void;
  clear(): void;
  getMemoryUsage(): MemoryUsage;
  shouldManage(): boolean;
  trim(): void;
  getMessagesToSummarize(): { toSummarize: ChatMessage[]; keepIndex: number };
}

function hasTurnLimit(limit: number | undefined): limit is number {
  return typeof limit === 'number' && Number.isFinite(limit) && limit > 0;
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

  const findLastUserIndex = (startIndex: number): number => {
    for (let i = messages.length - 1; i >= startIndex; i--) {
      if (messages[i].role === 'user') return i;
    }
    return startIndex;
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
      if (!hasTurnLimit(options.limit)) {
        return { current, limit: null, percentage: null };
      }
      return {
        current,
        limit: options.limit,
        percentage: Math.min(100, Math.round((current / options.limit) * 100)),
      };
    },
    shouldManage() {
      if (!hasTurnLimit(options.limit)) return false;
      return getConversationTurnCount() > options.limit;
    },
    trim() {
      if (!hasTurnLimit(options.limit)) return;

      const turnCount = getConversationTurnCount();
      if (turnCount <= options.limit) return;

      logger.info(`Trimming history (${turnCount} turns exceeds limit ${options.limit})...`);
      const keepTurns = Math.ceil(options.limit * KEPT_TURN_RATIO);
      const cutIndex = findCutIndex(keepTurns);
      const recentMessages = messages.slice(cutIndex);

      if (hasPinnedSystem(messages)) {
        messages = [messages[0], ...recentMessages];
      } else {
        messages = recentMessages;
      }
    },
    getMessagesToSummarize() {
      const startIndex = hasPinnedSystem(messages) ? 1 : 0;
      const keepIndex = hasTurnLimit(options.limit)
        ? findCutIndex(Math.ceil(options.limit * KEPT_TURN_RATIO))
        : findLastUserIndex(startIndex);

      return {
        toSummarize: messages.slice(startIndex, keepIndex),
        keepIndex,
      };
    },
  };
}
