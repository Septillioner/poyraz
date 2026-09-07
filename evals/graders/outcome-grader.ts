import type { EvalTrace, OutcomeCheck } from '../types.js';

export function gradeOutcome(check: OutcomeCheck): number {
  if (check.score !== undefined) {
    return Math.max(0, Math.min(100, check.score));
  }
  return check.pass ? 100 : 0;
}

export async function runOutcomeCheck(
  workspace: string,
  trace: EvalTrace,
  checkOutcome: (workspace: string, trace: EvalTrace) => OutcomeCheck | Promise<OutcomeCheck>
): Promise<{ score: number; check: OutcomeCheck }> {
  const check = await checkOutcome(workspace, trace);
  return { score: gradeOutcome(check), check };
}
