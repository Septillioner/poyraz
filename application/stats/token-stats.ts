import type { TokenUsage } from '../../domain/llm.js';

export interface TokenStats {
  resetCurrent(): void;
  resetSession(): void;
  addUsage(usage: TokenUsage): void;
  getCurrent(): TokenUsage;
  getSessionTotal(): TokenUsage;
  setSessionTotal(usage: TokenUsage): void;
}

export function createTokenStats(): TokenStats {
  let currentResponseUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let sessionTotalUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  return {
    resetCurrent() {
      currentResponseUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    },
    resetSession() {
      sessionTotalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      currentResponseUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    },
    addUsage(usage: TokenUsage) {
      currentResponseUsage.promptTokens += usage.promptTokens;
      currentResponseUsage.completionTokens += usage.completionTokens;
      currentResponseUsage.totalTokens += usage.totalTokens;
      if (usage.cachedTokens) {
        currentResponseUsage.cachedTokens =
          (currentResponseUsage.cachedTokens ?? 0) + usage.cachedTokens;
      }

      sessionTotalUsage.promptTokens += usage.promptTokens;
      sessionTotalUsage.completionTokens += usage.completionTokens;
      sessionTotalUsage.totalTokens += usage.totalTokens;
      if (usage.cachedTokens) {
        sessionTotalUsage.cachedTokens =
          (sessionTotalUsage.cachedTokens ?? 0) + usage.cachedTokens;
      }
    },
    getCurrent() {
      return { ...currentResponseUsage };
    },
    getSessionTotal() {
      return { ...sessionTotalUsage };
    },
    setSessionTotal(usage: TokenUsage) {
      sessionTotalUsage = { ...usage };
    },
  };
}
