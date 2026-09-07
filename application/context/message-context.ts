import type { ChatMessage } from '../../domain/llm.js';
import { logger } from '../../shared/logger.js';

export interface ContextOptions {
  limit: number;
  autoSummary: boolean;
  totalCapacity: number;
}

export interface UsageBreakdown {
  byRole: {
    system: number;
    user: number;
    assistant: number;
    tool: number;
  };
  percentages: {
    system: number;
    user: number;
    assistant: number;
    tool: number;
  };
  total: number;
  messageCounts: {
    system: number;
    user: number;
    assistant: number;
    tool: number;
  };
}

export interface MessageContext {
  addMessage(message: ChatMessage): void;
  getMessages(): ChatMessage[];
  getMessagesCopy(): ChatMessage[];
  setMessages(messages: ChatMessage[]): void;
  clear(): void;
  getUsage(): { used: number; total: number; percentage: number };
  getMemoryUsage(): { current: number; limit: number; percentage: number };
  getUsageBreakdown(): UsageBreakdown;
  shouldManage(): boolean;
  trim(): void;
  getMessagesToSummarize(): { toSummarize: ChatMessage[]; keepIndex: number };
}

export function createMessageContext(options: ContextOptions): MessageContext {
  let messages: ChatMessage[] = [];

  const getConversationTurnCount = () =>
    messages.filter((m) => m.role === 'user' || m.role === 'assistant').length;

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
    getUsage() {
      const totalCtx = options.totalCapacity || 128000;
      const usedChars = JSON.stringify(messages).length;
      const estimatedTokens = Math.ceil(usedChars / 4);
      const percentage = Math.min(100, Math.round((estimatedTokens / totalCtx) * 100));
      return { used: estimatedTokens, total: totalCtx, percentage };
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
    getUsageBreakdown(): UsageBreakdown {
      const byRole = { system: 0, user: 0, assistant: 0, tool: 0 };
      const messageCounts = { system: 0, user: 0, assistant: 0, tool: 0 };

      for (const message of messages) {
        const estimated = Math.ceil(JSON.stringify(message).length / 4);
        const role = message.role;
        if (role === 'system' || role === 'user' || role === 'assistant' || role === 'tool') {
          byRole[role] += estimated;
          messageCounts[role]++;
        }
      }

      const total = byRole.system + byRole.user + byRole.assistant + byRole.tool;
      const percentage = (value: number) => (total > 0 ? Math.round((value / total) * 100) : 0);

      return {
        byRole,
        percentages: {
          system: percentage(byRole.system),
          user: percentage(byRole.user),
          assistant: percentage(byRole.assistant),
          tool: percentage(byRole.tool),
        },
        total,
        messageCounts,
      };
    },
    shouldManage() {
      return getConversationTurnCount() > options.limit;
    },
    trim() {
      const turnCount = getConversationTurnCount();
      if (turnCount <= options.limit) return;

      logger.info(`Trimming history (${turnCount} turns exceeds limit ${options.limit})...`);
      const systemMessage = messages[0];

      const keepTurns = Math.ceil(options.limit * 0.6);
      let keptTurns = 0;
      let cutIndex = messages.length;
      for (let i = messages.length - 1; i >= 1; i--) {
        if (messages[i].role === 'user' || messages[i].role === 'assistant') {
          keptTurns++;
        }
        if (keptTurns >= keepTurns) {
          cutIndex = i;
          break;
        }
      }

      cutIndex = Math.max(1, cutIndex);
      while (cutIndex > 1 && messages[cutIndex].role === 'tool') {
        cutIndex--;
      }

      const recentMessages = messages.slice(cutIndex);
      messages = [systemMessage, ...recentMessages];
    },
    getMessagesToSummarize() {
      const keepTurns = Math.ceil(options.limit * 0.6);
      let keptTurns = 0;
      let keepFromIndex = messages.length;

      for (let i = messages.length - 1; i >= 1; i--) {
        if (messages[i].role === 'user' || messages[i].role === 'assistant') {
          keptTurns++;
        }
        if (keptTurns >= keepTurns) {
          keepFromIndex = i;
          break;
        }
      }

      while (keepFromIndex > 1 && messages[keepFromIndex].role === 'tool') {
        keepFromIndex--;
      }

      keepFromIndex = Math.max(1, keepFromIndex);

      return {
        toSummarize: messages.slice(1, keepFromIndex),
        keepIndex: keepFromIndex,
      };
    },
  };
}
