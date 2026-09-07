import { createHash } from 'crypto';
import type { EvalTrace } from '../types.js';

function errorKey(toolName: string, code: string, message: string): string {
  const msgHash = createHash('sha1').update(message).digest('hex').slice(0, 8);
  return `${toolName}:${code}:${msgHash}`;
}

export function gradeTrace(trace: EvalTrace): number {
  let score = 100;

  if (trace.metrics.orphanToolCalls) {
    return 0;
  }

  if (trace.metrics.sameErrorRepeats > 1) {
    score -= 40 * (trace.metrics.sameErrorRepeats - 1);
  }

  if (trace.metrics.toolRounds > 12) {
    score -= Math.min(30, (trace.metrics.toolRounds - 12) * 3);
  }

  if (trace.metrics.editFileAttempts > 4) {
    score -= Math.min(20, (trace.metrics.editFileAttempts - 4) * 5);
  }

  return Math.max(0, Math.min(100, score));
}

export function buildTraceMetrics(
  trace: Omit<EvalTrace, 'metrics'> & { totalTokens: number }
): EvalTrace {
  const toolStarts = trace.events.filter((e) => e.type === 'tool.call.start');
  const toolResults = trace.events.filter((e) => e.type === 'tool.call.result');
  const editFileAttempts = toolStarts.filter((e) => e.toolName === 'edit_file').length;

  let sameErrorRepeats = 0;
  let lastKey: string | undefined;
  let streak = 0;
  for (const event of toolResults) {
    if (event.type !== 'tool.call.result' || event.ok) {
      lastKey = undefined;
      streak = 0;
      continue;
    }
    const key = errorKey(event.toolName, event.error?.code ?? 'unknown', event.error?.message ?? '');
    if (key === lastKey) {
      streak++;
      sameErrorRepeats = Math.max(sameErrorRepeats, streak);
    } else {
      lastKey = key;
      streak = 1;
    }
  }

  let orphanToolCalls = false;
  for (let i = 0; i < trace.messages.length; i++) {
    const msg = trace.messages[i];
    if (msg.role !== 'assistant' || !msg.tool_calls?.length) continue;
    const responded = new Set<string>();
    for (let j = i + 1; j < trace.messages.length; j++) {
      const next = trace.messages[j];
      if (next.role === 'assistant') break;
      if (next.role === 'tool' && next.tool_call_id) {
        responded.add(next.tool_call_id);
      }
    }
    for (const call of msg.tool_calls) {
      if (call.id && !responded.has(call.id)) {
        orphanToolCalls = true;
        break;
      }
    }
  }

  const toolRounds = trace.messages.filter(
    (m) => m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0
  ).length;

  return {
    ...trace,
    metrics: {
      totalTokens: trace.totalTokens,
      toolRounds,
      sameErrorRepeats,
      editFileAttempts,
      orphanToolCalls,
    },
  };
}
