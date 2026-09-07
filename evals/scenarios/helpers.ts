import type { EvalTrace } from '../types.js';

export function toolStarts(trace: EvalTrace, toolName: string) {
  return trace.events.filter((e) => e.type === 'tool.call.start' && e.toolName === toolName);
}

export function toolResults(trace: EvalTrace, toolName: string) {
  return trace.events.filter((e) => e.type === 'tool.call.result' && e.toolName === toolName);
}

export function hadToolFailure(trace: EvalTrace, toolName: string): boolean {
  return toolResults(trace, toolName).some((e) => !e.ok);
}

export function hadToolSuccess(trace: EvalTrace, toolName: string): boolean {
  return toolResults(trace, toolName).some((e) => e.ok);
}

/** At least one failed tool call for toolName, then a later successful one. */
export function hadRecovery(trace: EvalTrace, toolName: string): boolean {
  let sawFailure = false;
  for (const event of trace.events) {
    if (event.type !== 'tool.call.result' || event.toolName !== toolName) continue;
    if (!event.ok) {
      sawFailure = true;
      continue;
    }
    if (sawFailure && event.ok) return true;
  }
  return false;
}

export function assistantText(trace: EvalTrace): string {
  return trace.messages
    .filter((m) => m.role === 'assistant')
    .map((m) => m.content)
    .join('\n')
    .toLowerCase();
}

export function mentionsModeSwitch(trace: EvalTrace): boolean {
  const text = assistantText(trace);
  return (
    text.includes('agent mode') ||
    text.includes('/mode agent') ||
    text.includes('switch to agent') ||
    text.includes('plan mode') ||
    text.includes('active mode: plan')
  );
}

export function wasPolicyBlocked(trace: EvalTrace, toolName: string): boolean {
  return toolResults(trace, toolName).some(
    (e) =>
      !e.ok &&
      (e.error?.code === 'POLICY_BLOCKED' || e.content.includes('POLICY_BLOCKED'))
  );
}

export function asksClarification(trace: EvalTrace): boolean {
  const text = assistantText(trace);
  return (
    text.includes('?') ||
    text.includes('which') ||
    text.includes('what') ||
    text.includes('clarif') ||
    text.includes('more detail') ||
    text.includes('could you')
  );
}
