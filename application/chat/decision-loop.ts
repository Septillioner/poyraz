import { createHash } from 'crypto';
import type { ChatMessage, ChatOptions, LLMProvider, ReasoningConfig, ServiceTier, TokenUsage } from '../../domain/llm.js';
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
import type { RepairOptions } from './repair-instruction.js';
import type { ToolDefinition } from '../../tools/core/types.js';
import type {
  ContinuationDecision,
  ContinuationOutcome,
  ContinuationPolicy,
  SameToolBreakerConfig,
} from '../agent/config.js';

/** Default of `sameToolBreaker.limit`: consecutive rounds led by the same tool before the notice fires. */
export const CONSECUTIVE_SAME_TOOL_LIMIT = 3;
export const CONSECUTIVE_SAME_ERROR_LIMIT = 2;

/**
 * Same-error circuit breaker mode, owned by the host policy (`AgentPolicy.errorBreaker`).
 * Unset means `'off'`: the loop never counts the streak, injects no notice and blocks no round.
 */
export function resolveErrorBreakerMode(agentPolicy: AgentPolicy): ErrorBreakerMode {
  return agentPolicy.errorBreaker ?? 'off';
}

/** `sameToolBreaker.limit` after validation; falls back to `CONSECUTIVE_SAME_TOOL_LIMIT`. */
export function resolveSameToolLimit(config?: SameToolBreakerConfig): number {
  const limit = config?.limit;
  return typeof limit === 'number' && Number.isFinite(limit) && limit >= 1
    ? Math.floor(limit)
    : CONSECUTIVE_SAME_TOOL_LIMIT;
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
  /** Sent to the provider only when set. */
  model?: string;
  /** Provider options. Sent only when set. */
  options?: Record<string, any>;
  /** Fallback tool schemas, used only when `handlers.compileRequest` is not provided. */
  tools?: any[];
  policy: { maxToolRounds: number };
  promptCacheKey?: string;
  promptCacheRetention?: 'in_memory' | '24h';
  reasoning?: ReasoningConfig;
  serviceTier?: ServiceTier;
  agentPolicy: AgentPolicy;
  /** `config.repair`. Failed tool results carry repair text only when `enabled`. */
  repair?: RepairOptions;
  /** `config.sameToolBreaker`. Off unless `enabled: true`. */
  sameToolBreaker?: SameToolBreakerConfig;
  /**
   * `config.progressTools`: a round in which one of these tools succeeded (without leading the round)
   * resets the same-tool streak. Default: none.
   */
  progressTools?: readonly string[];
  /** `config.continuation`. Consulted after every accepted tool-less reply; default: none (the reply ends the turn). */
  continuation?: ContinuationPolicy;
}

/** What goes to the provider for one round; the minimum the loop needs from a request compiler. */
export interface CompiledRound {
  messages: ChatMessage[];
  tools: any[];
}

export interface DecisionLoopHandlers {
  getMessages: () => ChatMessage[];
  /**
   * Compiles the request for the next round (messages, filtered tool schemas, and
   * whatever the caller records about it). When set, it is the single source of what
   * is sent; `getMessages` and `deps.tools` are then only used for bookkeeping/fallback.
   */
  compileRequest?: () => CompiledRound;
  addMessage: (message: ChatMessage) => void;
  onEvent?: (event: AgentStreamEvent) => void;
  onUsage?: (usage: TokenUsage) => void;
  buildToolContext: () => ToolContext;
  /** Token pressure hook, runs before each model request. Must keep tool_calls pairing intact. */
  beforeRound?: () => Promise<void>;

  getPromptCacheKey?: () => string | undefined;
  /** Session the agent is bound to; handed to the continuation policy. Read at decision time. */
  getSessionId?: () => string | undefined;
  signal?: AbortSignal;
}

export interface DecisionLoopResult {
  content: string;
  usage?: TokenUsage;
  /** Set when a `ContinuationPolicy` was configured for the turn. */
  continuation?: ContinuationOutcome;
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
): Promise<DecisionLoopResult> {
  let round = 0;
  let lastRoundToolName: string | undefined;
  let consecutiveSameTool = 0;
  let circuitBreakerNoticeSent = false;
  let lastErrorKey: string | undefined;
  let consecutiveSameError = 0;
  let lastUsage: TokenUsage | undefined;
  // `context.usage` of the request in flight. A tool-less reply may still be followed by another
  // round (gate retry, continuation), so its `final` flag is only known once that is decided.
  let pendingUsage: ((final: boolean) => void) | undefined;
  const settleUsage = (final: boolean) => pendingUsage?.(final);
  const gateRetries = new Map<number, number>();

  const isToolLoopBlocked = () => circuitBreakerNoticeSent;
  const bufferTextUntilAccepted = Boolean(deps.agentPolicy.bufferTextUntilAccepted);
  const errorBreakerMode = resolveErrorBreakerMode(deps.agentPolicy);
  const sameToolBreakerEnabled = deps.sameToolBreaker?.enabled === true;
  const sameToolLimit = resolveSameToolLimit(deps.sameToolBreaker);
  const progressTools = new Set(deps.progressTools ?? []);
  const continuationPolicy = deps.continuation;
  let continuations = 0;
  const outcome = (extra?: Pick<ContinuationOutcome, 'reason' | 'data'>): ContinuationOutcome | undefined =>
    continuationPolicy ? { continuations, ...extra } : undefined;

  try {
    outer: while (round < deps.policy.maxToolRounds) {
      round++;
      assertNotAborted(handlers.signal);

      await handlers.beforeRound?.();

      handlers.onEvent?.({ type: 'lifecycle', phase: 'thinking' });

      let textBuffer = '';
      const compiled = handlers.compileRequest?.();
      // `model` stays out of the request when none is configured (`ChatOptions` still types it as required).
      const request: Omit<ChatOptions, 'model'> & { model?: string } = {
        ...(deps.model ? { model: deps.model } : {}),
        messages: compiled?.messages ?? handlers.getMessages(),
        ...(deps.options ? { options: deps.options } : {}),
        tools: compiled?.tools ?? deps.tools ?? [],
        promptCacheKey: handlers.getPromptCacheKey?.() ?? deps.promptCacheKey,
        promptCacheRetention: deps.promptCacheRetention,
        reasoning: deps.reasoning,
        serviceTier: deps.serviceTier,
        signal: handlers.signal,
        onRateLimit: (notice) => handlers.onEvent?.(rateLimitStreamEvent(notice)),
      };
      const response = await deps.provider.chat(
        request as ChatOptions,
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
        const usage = response.usage;
        const usageRound = round;
        lastUsage = usage;
        handlers.onUsage?.(usage);
        // Published even when the turn is cancelled right after: a cancelled turn still reports
        // the request it already paid for. The prompt is measured on the history that was
        // actually sent, before this round's assistant message is appended.
        pendingUsage = (final) => {
          pendingUsage = undefined;
          handlers.onEvent?.({
            type: 'context.usage',
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            totalTokens: usage.totalTokens,
            cachedTokens: usage.cachedTokens,
            round: usageRound,
            final,
          });
        };
      }
      assertNotAborted(handlers.signal);

      const toolCalls = isToolLoopBlocked() ? undefined : response.tool_calls;

      // `final` means no further request follows. Another round only runs while the round budget lasts.
      const anotherRoundPossible = round < deps.policy.maxToolRounds;
      if (toolCalls?.length) settleUsage(!anotherRoundPossible);

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
            settleUsage(!anotherRoundPossible);
            handlers.addMessage({ role: 'user', content: verdict.notice });
            continue outer;
          }

          if (gate.onExhausted) {
            const sanitized = gate.onExhausted(response.content ?? '');
            logger.warn('Response gate: retry budget exhausted; sanitizing', { gateIndex });
            handlers.addMessage({ role: 'assistant', content: sanitized });
            flushTextDelta(handlers, sanitized);
            settleUsage(true);
            return { content: sanitized, usage: response.usage ?? lastUsage, continuation: outcome() };
          }
        }

        if (bufferTextUntilAccepted) {
          flushTextDelta(handlers, textBuffer || response.content || '');
        }

        if (!continuationPolicy) {
          settleUsage(true);
          return { content: response.content, usage: response.usage ?? lastUsage };
        }

        const cap = continuationPolicy.maxContinuations;
        const remaining = typeof cap === 'number' ? Math.max(0, cap - continuations) : undefined;
        let decision: ContinuationDecision;
        try {
          decision = await continuationPolicy.evaluate({
            content: response.content ?? '',
            round,
            continuations,
            remaining,
            succeededTools: policyGuard.succeededTools(),
            usage: response.usage,
            messages: [...handlers.getMessages()],
            sessionId: handlers.getSessionId?.(),
            signal: handlers.signal,
          });
        } catch (error) {
          // A cancelled turn wins over whatever the policy was doing when it was cancelled.
          assertNotAborted(handlers.signal);
          throw error;
        }
        assertNotAborted(handlers.signal);

        if (decision.kind === 'continue') {
          if (remaining === 0) {
            logger.info('Continuation stopped: maxContinuations reached', { continuations, cap });
            settleUsage(true);
            return {
              content: response.content,
              usage: response.usage ?? lastUsage,
              continuation: outcome({ reason: 'max-continuations' }),
            };
          }
          if (typeof decision.notice === 'string' && decision.notice.trim()) {
            continuations++;
            logger.info('Continuation: another round', { continuations, round });
            settleUsage(!anotherRoundPossible);
            handlers.addMessage({ role: 'user', content: decision.notice });
            continue outer;
          }
          logger.warn('Continuation policy returned an empty notice; ending the turn');
        }

        settleUsage(true);
        return {
          content: response.content,
          usage: response.usage ?? lastUsage,
          continuation: outcome(
            decision.kind === 'stop'
              ? {
                  ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
                  ...(decision.data !== undefined ? { data: decision.data } : {}),
                }
              : undefined
          ),
        };
      }
      if (bufferTextUntilAccepted) {
        flushTextDelta(handlers, textBuffer || response.content || '');
      }

      const roundToolNames = toolCalls.map((tc) => toolRegistry.resolveAlias(tc.function.name));
      const roundToolName = roundToolNames[0];
      const succeededProgressTools = new Set<string>();

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
          handlers.buildToolContext(),
          { repair: deps.repair }
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

        if (ok && progressTools.has(toolName)) succeededProgressTools.add(toolName);

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

      if (sameToolBreakerEnabled) {
        const leadingIsProgressTool = progressTools.has(roundToolName);
        const roundMadeProgress = succeededProgressTools.size > 0;

        if (roundMadeProgress && !leadingIsProgressTool) {
          // Mixed productive round (e.g. a read that feeds a progress tool): that is
          // progress, not a loop. Reset the streak so the breaker does not trip on
          // interleaved work. Streaks led by a progress tool still accumulate normally
          // below to catch true edit loops.
          lastRoundToolName = undefined;
          consecutiveSameTool = 0;
        } else if (roundToolName === lastRoundToolName) {
          consecutiveSameTool++;
        } else {
          lastRoundToolName = roundToolName;
          consecutiveSameTool = 1;
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

      if (sameToolBreakerEnabled && consecutiveSameTool >= sameToolLimit) {
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
    settleUsage(true);
    handlers.addMessage({ role: 'assistant', content: errorMsg });
    return { content: errorMsg, usage: lastUsage, continuation: outcome() };
  } catch (error) {
    // The turn ends here (abort or failure): the request already paid for is still reported.
    settleUsage(true);
    if (error instanceof ChatAbortedError) {
      completePendingToolResponses(handlers);
    }
    throw error;
  }
}
