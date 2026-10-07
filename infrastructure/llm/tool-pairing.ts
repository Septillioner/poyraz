import type { ChatMessage } from '../../domain/llm.js';

/** Shown to the model for a tool call whose output never made it into history. */
export const MISSING_TOOL_OUTPUT_NOTE =
  '[tool output was not recorded; the run was interrupted before the tool finished]';

/**
 * Every call id this message asks for. Both sources count: the plain `tool_calls`
 * array and the raw Responses output items replayed from `providerMeta`.
 */
function requestedCallIds(message: ChatMessage): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();

  const collect = (id: string | undefined) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };

  for (const call of message.tool_calls ?? []) collect(call.id);

  const replayItems = message.providerMeta?.openai?.outputItems;
  if (Array.isArray(replayItems)) {
    for (const item of replayItems) {
      const candidate = item as { type?: string; call_id?: string } | null;
      if (candidate?.type === 'function_call') collect(candidate.call_id);
    }
  }

  return ids;
}

/**
 * Repair tool/call pairing without touching the caller's history.
 *
 * Both providers reject a `function_call` that has no output (`400 No tool output
 * found for function call`) and an output whose call is missing. History can end up
 * in that state when a turn is cut short, so every request is paired here first: the
 * returned array is new, the stored transcript keeps every message it had.
 */
export function sanitizeToolPairing(messages: ChatMessage[]): ChatMessage[] {
  const requestedIds = new Set<string>();
  const respondedIds = new Set<string>();

  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const id of requestedCallIds(message)) requestedIds.add(id);
    } else if (message.role === 'tool' && message.tool_call_id) {
      respondedIds.add(message.tool_call_id);
    }
  }

  const sanitized: ChatMessage[] = [];

  for (const message of messages) {
    if (message.role === 'assistant') {
      const answeredCalls = message.tool_calls?.filter(
        (call) => call.id && respondedIds.has(call.id)
      );

      sanitized.push({
        ...message,
        tool_calls: answeredCalls?.length ? answeredCalls : undefined,
      });

      for (const id of requestedCallIds(message)) {
        if (respondedIds.has(id)) continue;
        sanitized.push({ role: 'tool', content: MISSING_TOOL_OUTPUT_NOTE, tool_call_id: id });
      }
      continue;
    }

    if (message.role === 'tool') {
      if (!message.tool_call_id || !requestedIds.has(message.tool_call_id)) continue;
      sanitized.push(message);
      continue;
    }

    sanitized.push(message);
  }

  return sanitized;
}
