import { TOKEN_BUDGETS, type EvalBudget } from '../types.js';

export function gradeEfficiency(totalTokens: number, budget: EvalBudget): number {
  const limit = TOKEN_BUDGETS[budget];
  if (totalTokens <= limit) {
    return 100;
  }
  const overRatio = (totalTokens - limit) / limit;
  const penalty = Math.min(100, Math.round(overRatio * 100));
  return Math.max(0, 100 - penalty);
}
