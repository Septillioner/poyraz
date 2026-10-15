import type { AgentStreamEvent } from '../../domain/events.js';
import type { EvalTrace } from '../types.js';

export type ToolStartEvent = Extract<AgentStreamEvent, { type: 'tool.call.start' }>;
export type ToolResultEvent = Extract<AgentStreamEvent, { type: 'tool.call.result' }>;

/** Error code the library puts on a tool result denied by the active `AgentPolicy`. */
export const POLICY_BLOCKED_CODE = 'POLICY_BLOCKED';

export function toolStarts(trace: EvalTrace, toolName: string): ToolStartEvent[] {
  return trace.events.filter(
    (e): e is ToolStartEvent => e.type === 'tool.call.start' && e.toolName === toolName
  );
}

export function toolResults(trace: EvalTrace, toolName: string): ToolResultEvent[] {
  return trace.events.filter(
    (e): e is ToolResultEvent => e.type === 'tool.call.result' && e.toolName === toolName
  );
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
  for (const event of toolResults(trace, toolName)) {
    if (!event.ok) {
      sawFailure = true;
      continue;
    }
    if (sawFailure) return true;
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

/** The tool was denied by the active policy (`POLICY_BLOCKED` error code or content marker). */
export function wasPolicyBlocked(trace: EvalTrace, toolName: string): boolean {
  return toolResults(trace, toolName).some(
    (e) => !e.ok && (e.error?.code === POLICY_BLOCKED_CODE || e.content.includes(POLICY_BLOCKED_CODE))
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
