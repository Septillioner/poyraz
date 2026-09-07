import { EASY_SCENARIOS } from './easy/index.js';
import { MEDIUM_SCENARIOS } from './medium/index.js';
import { HARD_SCENARIOS } from './hard/index.js';
import { CHALLENGING_SCENARIOS } from './challenging/index.js';
import type { EvalDifficulty, EvalScenario } from '../types.js';

export { EASY_SCENARIOS, MEDIUM_SCENARIOS, HARD_SCENARIOS, CHALLENGING_SCENARIOS };

export const ALL_SCENARIOS: EvalScenario[] = [
  ...EASY_SCENARIOS,
  ...MEDIUM_SCENARIOS,
  ...HARD_SCENARIOS,
  ...CHALLENGING_SCENARIOS,
];

export const SCENARIOS_BY_DIFFICULTY: Record<EvalDifficulty, EvalScenario[]> = {
  easy: EASY_SCENARIOS,
  medium: MEDIUM_SCENARIOS,
  hard: HARD_SCENARIOS,
  challenging: CHALLENGING_SCENARIOS,
};
