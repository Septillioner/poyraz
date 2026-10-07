import { createHash } from 'crypto';
import type { ChatMessage, LLMProvider, ReasoningConfig, ServiceTier, TokenUsage } from '../../domain/llm.js';
import type { AgentStreamEvent } from '../../domain/events.js';
import { rateLimitStreamEvent } from '../../domain/events.js';
import type { AgentPolicy, ErrorBreakerMode } from '../../domain/agent-policy.js';
import { logger } from '../../shared/logger.js';
import { assertNotAborted, ChatAbortedError } from '../../shared/chat-aborted.js';
import { toolRegistry } from '../../tools/core/registry.js';
import type { ToolContext } from '../../tools/core/types.js';
import type { ToolPolicyGuard } from './tool-policy.js';
import { tryParseToolError } from './tool-errors.js';
import { executeToolCall, parseRawToolArgs } from './tool-execution.js';
import type { ToolDefinition } from '../../tools/core/types.js';
export const CONSECUTIVE_SAME_TOOL_LIMIT = 3;
export const CONSECUTIVE_SAME_ERROR_LIMIT = 2;

/**
 * Same-tool loop breaker. Off for now: it fired on legitimate work (host tools
 * arrive MCP-prefixed, so the read-only progress check never matched) and cut a
 * turn that was making real progress. Mode policy still blocks mutating tools
 * outside agent mode, `maxToolRounds` still bounds a turn, and the error
 * circuit breaker below still stops identical failures. Flip to true to restore
 * the "same tool N times in a row" NOTICE.
 */
export const SAME_TOOL_LOOP_BREAKER_ENABLED = false;

/**
 * Same-error circuit breaker. Off for now: the hard-block NOTICE inserted a user
 * message mid-history, the round that followed stripped `tool_calls` while keeping
 * `providerMeta.openai.outputItems`, and the next request replayed those
 * `function_call` items with no output — the provider answered
 * `400 No tool output found for function call`. The failures it guarded against are
 * already bounded by `repeatCallLimit` (identical tool+args), `maxToolRounds` and
 * the mode policy, so it buys little and breaks the transcript.
 *
 * Re-enable only once `sanitizeToolPairing` is in place AND the hard-block path is
 * replaced by `buildAgentSoftCircuitNotice` (which never touches tool_calls).
 */
export const ERROR_CIRCUIT_BREAKER_ENABLED: boolean = false;

/**
 * Host-owned configuration for the same-error circuit breaker. The module constant
 * above is the legacy in-repo default for callers that pass no policy (kept for
 * backwards compatibility); `AgentPolicy.errorBreaker` wins whenever it is set, and
 * an unset policy field means `'off'`.
 */
export function resolveErrorBreakerMode(agentPolicy: AgentPolicy): ErrorBreakerMode {
  if (agentPolicy.errorBreaker) return agentPolicy.errorBreaker;
  return ERROR_CIRCUIT_BREAKER_ENABLED ? 'hard' : 'off';
}

// Tools that mutate the workspace. A round that runs one of these made real
// progress, so it should not count toward the read-only "same tool loop"
// breaker. In read-only modes (plan/ask) none of these are available, so the
// breaker keeps stopping unproductive read loops early.
const PROGRESS_TOOLS = new Set(['edit_file', 'delete_file', 'run_terminal_cmd']);

function isProgressTool(toolName: string): boolean {
  return PROGRESS_TOOLS.has(toolName);
}

function buildErrorCircuitNotice(toolName: string): string {
  return (
    `NOTICE: '${toolName}' returned the same error twice in a row. ` +
    'Stop retrying that tool call. Explain what you need from the user or describe the blocker in plain text.'
  );
}

function buildToolErrorKey(toolName: string, code: string, message: string): string {
  const msgHash = createHash('sha1').update(message).digest('hex').slice(0, 8);
  return `${toolName}:${code}:${msgHash}`;
}

export interface DecisionLoopDeps {
  provider: LLMProvider;
  model: string;
  options: Record<string, any>;
  tools: any[];
  policy: { maxToolRounds: number };
  promptCacheKey?: string;
  promptCacheRetention?: 'in_memory' | '24h';
  reasoning?: ReasoningConfig;
  serviceTier?: ServiceTier;
  agentPolicy: AgentPolicy;
}

export interface DecisionLoopHandlers {
  getMessages: () => ChatMessage[];
  addMessage: (message: ChatMessage) => void;
  onEvent?: (event: AgentStreamEvent) => void;
  onUsage?: (usage: TokenUsage) => void;
  buildToolContext: () => ToolContext;

  getPromptCacheKey?: () => string | undefined;
  signal?: AbortSignal;
}

function parseToolCallArgs(rawArgs: unknown): Record<string, unknown> {
  if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
    return parseRawToolArgs(rawArgs);
  }
  if (typeof rawArgs === 'string') {
    return parseRawToolArgs(rawArgs);
  }
  return {};
}

function buildCircuitBreakerNotice(toolName: string, count: number): string {
  return (
    `NOTICE: '${toolName}' was called ${count} times in a row without progress. ` +
    'Stop calling tools. Respond to the user in plain text with your findings or ask what they want next.'
  );
}

function buildAgentSoftCircuitNotice(toolName: string, kind: 'repeat' | 'error'): string {
  if (kind === 'error') {
    return (
      `<system_reminder>\n` +
      `NOTICE: '${toolName}' returned the same error twice. Do not retry the identical call. ` +
      `Try a different approach or gather more context with other tools before trying again.\n` +
      `</system_reminder>`
    );
  }

  return (
    `<system_reminder>\n` +
    `NOTICE: '${toolName}' was called repeatedly without progress. ` +
    `Stop looping that tool. Switch approach or use other tools to make progress.\n` +
    `</system_reminder>`
  );
}

/** Fill missing tool responses so OpenAI history stays valid after abort. */
function completePendingToolResponses(handlers: DecisionLoopHandlers): void {
  const messages = handlers.getMessages();
  let assistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && messages[i].tool_calls?.length) {
      assistantIdx = i;
      break;
    }
  }
  if (assistantIdx < 0) return;

  const toolCalls = messages[assistantIdx].tool_calls!;
  const respondedIds = new Set<string>();
  for (let i = assistantIdx + 1; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'tool' && msg.tool_call_id) {
      respondedIds.add(msg.tool_call_id);
    }
  }

  for (const toolCall of toolCalls) {
    const toolCallId = toolCall.id;
    if (!toolCallId || respondedIds.has(toolCallId)) continue;
    handlers.addMessage({
      role: 'tool',
      content: 'Command cancelled.',
      tool_call_id: toolCallId,
    });
  }
}

function shouldHardBlockTools(agentPolicy: AgentPolicy): boolean {
  return Boolean(agentPolicy.hardBlockDeniedTools);
}

function flushTextDelta(
  handlers: DecisionLoopHandlers,
  text: string
): void {
  if (!text) return;
  handlers.onEvent?.({ type: 'text.delta', delta: text });
}

export async function runDecisionLoop(
  deps: DecisionLoopDeps,
  toolDefs: Record<string, ToolDefinition>,
  policyGuard: ToolPolicyGuard,
  handlers: DecisionLoopHandlers
): Promise<{ content: string; usage?: TokenUsage }> {
  let round = 0;
  let lastRoundToolName: string | undefined;
  let consecutiveSameTool = 0;
  let circuitBreakerNoticeSent = false;
  let lastErrorKey: string | undefined;
  let consecutiveSameError = 0;
  let lastUsage: TokenUsage | undefined;
  const gateRetries = new Map<number, number>();

  const isToolLoopBlocked = () => circuitBreakerNoticeSent;
  const bufferTextUntilAccepted = Boolean(deps.agentPolicy.bufferTextUntilAccepted);
  const errorBreakerMode = resolveErrorBreakerMode(deps.agentPolicy);

  try {
    outer: while (round < deps.policy.maxToolRounds) {
      round++;
      assertNotAborted(handlers.signal);



      handlers.onEvent?.({ type: 'lifecycle', phase: 'thinking' });

      let textBuffer = '';
      const response = await deps.provider.chat(
        {
          model: deps.model,
          messages: handlers.getMessages(),
          options: deps.options,
          tools: deps.tools,
          promptCacheKey: handlers.getPromptCacheKey?.() ?? deps.promptCacheKey,
          promptCacheRetention: deps.promptCacheRetention,
          reasoning: deps.reasoning,
          serviceTier: deps.serviceTier,
          signal: handlers.signal,
          onRateLimit: (notice) => handlers.onEvent?.(rateLimitStreamEvent(notice)),
        },
        (token) => {
          if (bufferTextUntilAccepted) {
            textBuffer += token;
          } else {
            handlers.onEvent?.({ type: 'text.delta', delta: token });
          }
        },
        (delta) => {
          handlers.onEvent?.({ type: 'reasoning.delta', delta });
        }
      );

      if (response.usage) {
        lastUsage = response.usage;
        handlers.onUsage?.(response.usage);
        // Published before the abort check so a cancelled turn still reports the
        // request it already paid for. The prompt is measured on the history that
        // was actually sent, before this round's assistant message is appended.
        handlers.onEvent?.({
          type: 'context.usage',
          promptTokens: response.usage.promptTokens,
          completionTokens: response.usage.completionTokens,
          totalTokens: response.usage.totalTokens,
          cachedTokens: response.usage.cachedTokens,
          round,
          final: isToolLoopBlocked() || !response.tool_calls?.length,
        });
      }
      assertNotAborted(handlers.signal);

      const toolCalls = isToolLoopBlocked() ? undefined : response.tool_calls;

      // Dropping `tool_calls` without dropping the raw provider output would leave
      // `function_call` items the next request replays with nothing to answer them.
      handlers.addMessage({
        role: 'assistant',
        content: response.content,
        tool_calls: toolCalls,
        providerMeta: toolCalls ? response.providerMeta : undefined,
      });

      if (!toolCalls?.length) {
        const gates = deps.agentPolicy.responseGates ?? [];
        for (let gateIndex = 0; gateIndex < gates.length; gateIndex++) {
          const gate = gates[gateIndex];
          const verdict = gate.evaluate({
            content: response.content ?? '',
            succeededTools: policyGuard.succeededTools(),
          });
          if (verdict.kind === 'accept') continue;

          const retries = gateRetries.get(gateIndex) ?? 0;
          if (retries < gate.maxRetries) {
            gateRetries.set(gateIndex, retries + 1);
            logger.warn('Response gate: rejecting and retrying', {
              gateIndex,
              retries: retries + 1,
            });
            handlers.addMessage({ role: 'user', content: verdict.notice });
            continue outer;
          }

          if (gate.onExhausted) {
            const sanitized = gate.onExhausted(response.content ?? '');
            logger.warn('Response gate: retry budget exhausted; sanitizing', { gateIndex });
            handlers.addMessage({ role: 'assistant', content: sanitized });
            flushTextDelta(handlers, sanitized);
            return { content: sanitized, usage: response.usage ?? lastUsage };
          }
        }

        if (bufferTextUntilAccepted) {
          flushTextDelta(handlers, textBuffer || response.content || '');
        }
        return { content: response.content, usage: response.usage ?? lastUsage };
      }
      if (bufferTextUntilAccepted) {
        flushTextDelta(handlers, textBuffer || response.content || '');
      }

      const roundToolNames = toolCalls.map((tc) => toolRegistry.resolveAlias(tc.function.name));
      const roundToolName = roundToolNames[0];
      const leadingIsProgressTool = isProgressTool(roundToolName);
      const roundMadeProgress = roundToolNames.some(isProgressTool);

      if (roundMadeProgress && !leadingIsProgressTool) {
        // Mixed productive round (e.g. read_file + edit_file): a read that feeds
        // an edit is progress, not a loop. Reset the read-oriented streak so the
        // breaker does not trip on interleaved read/edit work. Streaks led by a
        // mutating tool still accumulate normally below to catch true edit loops.
        lastRoundToolName = undefined;
        consecutiveSameTool = 0;
      } else if (roundToolName === lastRoundToolName) {
        consecutiveSameTool++;
      } else {
        lastRoundToolName = roundToolName;
        consecutiveSameTool = 1;
      }

      let errorCircuitToolName: string | undefined;

      for (const toolCall of toolCalls) {
        assertNotAborted(handlers.signal);
        const toolCallId = toolCall.id || `call_${round}_${toolCall.function.name}`;
        const toolName = toolRegistry.resolveAlias(toolCall.function.name);
        const toolArgs = parseToolCallArgs(toolCall.function.arguments);

        handlers.onEvent?.({
          type: 'tool.call.start',
          toolCallId,
          toolName,
          args: toolArgs,
        });

        const toolOutcome = await executeToolCall(
          toolDefs,
          policyGuard,
          { ...toolCall, id: toolCallId },
          handlers.buildToolContext()
        );

        const parsedError = tryParseToolError(toolOutcome.message.content);
        const ok = !parsedError;

        handlers.onEvent?.({
          type: 'tool.call.result',
          toolCallId,
          toolName,
          content: toolOutcome.message.content,
          ok,
          error: parsedError ?? undefined,
          meta: toolOutcome.meta,
        });

        handlers.onEvent?.({ type: 'tool.call.end', toolCallId });

        handlers.addMessage(toolOutcome.message);
        assertNotAborted(handlers.signal);

        if (parsedError) {
          const errorKey = buildToolErrorKey(toolName, parsedError.code, parsedError.message);
          if (errorKey === lastErrorKey) {
            consecutiveSameError++;
          } else {
            lastErrorKey = errorKey;
            consecutiveSameError = 1;
          }
          if (errorBreakerMode !== 'off' && consecutiveSameError >= CONSECUTIVE_SAME_ERROR_LIMIT) {
            errorCircuitToolName = toolName;
          }
        } else {
          lastErrorKey = undefined;
          consecutiveSameError = 0;
        }
      }

      // Circuit-breaker notices are appended only after every tool_call in this
      // round has a matching tool response. Inserting a user message between an
      // assistant tool_calls message and its tool responses corrupts the
      // provider history (OpenAI rejects orphaned tool_call_ids with a 400).
      if (errorBreakerMode !== 'off' && errorCircuitToolName) {
        logger.warn('Error circuit breaker triggered', {
          toolName: errorCircuitToolName,
          consecutiveSameError,
          policyId: deps.agentPolicy.id,
        });
        if (errorBreakerMode === 'hard' && shouldHardBlockTools(deps.agentPolicy)) {
          handlers.addMessage({
            role: 'user',
            content: buildErrorCircuitNotice(errorCircuitToolName),
          });
          circuitBreakerNoticeSent = true;
        } else {
          handlers.addMessage({
            role: 'user',
            content: buildAgentSoftCircuitNotice(errorCircuitToolName, 'error'),
          });
          lastErrorKey = undefined;
          consecutiveSameError = 0;
        }
      }

      if (SAME_TOOL_LOOP_BREAKER_ENABLED && consecutiveSameTool >= CONSECUTIVE_SAME_TOOL_LIMIT) {
        logger.warn('Circuit breaker triggered', {
          toolName: roundToolName,
          consecutiveSameTool,
          policyId: deps.agentPolicy.id,
        });
        if (shouldHardBlockTools(deps.agentPolicy)) {
          const notice = buildCircuitBreakerNotice(roundToolName, consecutiveSameTool);
          handlers.addMessage({ role: 'user', content: notice });
          circuitBreakerNoticeSent = true;
        } else {
          handlers.addMessage({
            role: 'user',
            content: buildAgentSoftCircuitNotice(roundToolName, 'repeat'),
          });
          lastRoundToolName = undefined;
          consecutiveSameTool = 0;
        }
      }
    }

    const errorMsg = `Tool loop limit reached (${deps.policy.maxToolRounds}). Stopping to avoid unstable behavior.`;
    logger.warn(errorMsg);
    handlers.addMessage({ role: 'assistant', content: errorMsg });
    return { content: errorMsg, usage: lastUsage };
  } catch (error) {
    if (error instanceof ChatAbortedError) {
      completePendingToolResponses(handlers);
    }
    throw error;
  }
}
