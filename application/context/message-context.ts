import type { ChatMessage } from '../../domain/llm.js';
import type { MessageContextMeta } from '../../domain/context.js';
import { logger } from '../../shared/logger.js';
import {
  buildMessageMeta,
  indexToolCalls,
  type CategorizeOptions,
  type ToolNameIndex,
} from './message-category.js';
import type { MessageEntry } from './context-report.js';
import { normalizeKeepRatio } from './summary-settings.js';
import { createTokenEstimator, type TokenEstimator } from './token-estimate.js';

export interface ContextOptions {
  limit?: number;
  /** Estimator used for the token figures stored next to each message. */
  estimator?: TokenEstimator;
  /**
   * Share of `limit` kept verbatim after a trim or summary (clamped to 0.1..0.9).
   * Omitted -> 0.6. `getMessagesToSummarize(keepRatio)` can override it per call.
   */
  keepRatio?: number;
  /** Prefix that marks a summary message in the context meter. Omitted -> the default summary prefix. */
  summaryPrefix?: string;
  /** Tool whose results are filed under `skills` in the context meter. Omitted -> `load_skill`. */
  skillToolName?: string;
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
  /** Messages to compact and the index where the verbatim tail starts. `keepRatio` overrides the context's own. */
  getMessagesToSummarize(keepRatio?: number): { toSummarize: ChatMessage[]; keepIndex: number };
  /** Category and size metadata assigned when the message was stored (built on demand for messages pushed around the API). */
  getMessageMeta(message: ChatMessage): MessageContextMeta;
  /** Every message with its metadata, in order. */
  getMessageEntries(): MessageEntry[];
}

function hasTurnLimit(limit: number | undefined): limit is number {
  return typeof limit === 'number' && Number.isFinite(limit) && limit > 0;
}

function hasPinnedSystem(messages: ChatMessage[]): boolean {
  return messages.length > 0 && messages[0].role === 'system';
}

export function createMessageContext(options: ContextOptions): MessageContext {
  let messages: ChatMessage[] = [];
  const estimator = options.estimator ?? createTokenEstimator();
  const categorizeOptions: CategorizeOptions = {
    summaryPrefix: options.summaryPrefix,
    skillToolName: options.skillToolName,
  };
  const keepTurnsFor = (limit: number, keepRatio?: number): number =>
    Math.max(1, Math.ceil(limit * normalizeKeepRatio(keepRatio ?? options.keepRatio)));
  // Metadata follows the message object, so trimming, summarizing and re-ordering
  // never need to re-index it.
  const metaByMessage = new WeakMap<ChatMessage, MessageContextMeta>();
  let toolNames: ToolNameIndex = new Map();

  const store = (message: ChatMessage) => {
    indexToolCalls(message, toolNames);
    metaByMessage.set(message, buildMessageMeta(message, toolNames, estimator, categorizeOptions));
  };

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
      store(message);
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
      toolNames = new Map();
      for (const message of messages) store(message);
    },
    clear() {
      messages = [];
      toolNames = new Map();
    },
    getMessageMeta(message: ChatMessage) {
      return metaByMessage.get(message) ?? buildMessageMeta(message, toolNames, estimator, categorizeOptions);
    },
    getMessageEntries() {
      const index: ToolNameIndex = new Map();
      return messages.map((message) => {
        indexToolCalls(message, index);
        return {
          message,
          meta: metaByMessage.get(message) ?? buildMessageMeta(message, index, estimator, categorizeOptions),
        };
      });
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
      const keepTurns = keepTurnsFor(options.limit);
      const cutIndex = findCutIndex(keepTurns);
      const recentMessages = messages.slice(cutIndex);

      if (hasPinnedSystem(messages)) {
        messages = [messages[0], ...recentMessages];
      } else {
        messages = recentMessages;
      }
    },
    getMessagesToSummarize(keepRatio?: number) {
      const startIndex = hasPinnedSystem(messages) ? 1 : 0;
      const keepIndex = hasTurnLimit(options.limit)
        ? findCutIndex(keepTurnsFor(options.limit, keepRatio))
        : findLastUserIndex(startIndex);

      return {
        toSummarize: messages.slice(startIndex, keepIndex),
        keepIndex,
      };
    },
  };
}
