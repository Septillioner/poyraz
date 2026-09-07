import type { ChatMessage } from '../domain/llm.js';
import type { AgentStreamEvent } from '../domain/events.js';

export const PASS_THRESHOLD = 80;

export type EvalDifficulty = 'easy' | 'medium' | 'hard' | 'challenging';
export type EvalBudget = 'simple' | 'medium';

export interface EvalMetrics {
  totalTokens: number;
  toolRounds: number;
  sameErrorRepeats: number;
  editFileAttempts: number;
  orphanToolCalls: boolean;
}

export interface EvalTrace {
  messages: ChatMessage[];
  events: AgentStreamEvent[];
  metrics: EvalMetrics;
}

export interface EvalResult {
  scenarioId: string;
  model: string;
  difficulty: EvalDifficulty;
  category: string;
  timestamp: string;
  traceScore: number;
  outcomeScore: number;
  efficiencyScore: number;
  composite: number;
  passed: boolean;
  metrics: EvalMetrics;
  details?: string;
}

export interface EvalHistoryRecord {
  scenarioId: string;
  model: string;
  difficulty: EvalDifficulty;
  category: string;
  timestamp: string;
  prompt: string;
  messages: ChatMessage[];
  events: AgentStreamEvent[];
  metrics: EvalMetrics;
}

export interface OutcomeCheck {
  pass: boolean;
  score?: number;
  details?: string;
}

export interface EvalScenario {
  id: string;
  difficulty: EvalDifficulty;
  budget: EvalBudget;
  category: string;
  prompt: string;
  mode?: 'agent' | 'plan' | 'ask' | 'chat';
  setup: (workspace: string) => Promise<void>;
  checkOutcome: (workspace: string, trace: EvalTrace) => OutcomeCheck | Promise<OutcomeCheck>;
}

export const TOKEN_BUDGETS: Record<EvalBudget, number> = {
  simple: 15_000,
  medium: 40_000,
};

export const DIFFICULTY_ORDER: EvalDifficulty[] = ['easy', 'medium', 'hard', 'challenging'];

export function computeComposite(trace: number, outcome: number, efficiency: number): number {
  return Math.round((trace + outcome + efficiency) / 3);
}

export function isPassed(composite: number): boolean {
  return composite >= PASS_THRESHOLD;
}
