import { createHash } from 'crypto';
import type { ChatMessage, LLMProvider, ReasoningConfig, ServiceTier, TokenUsage } from '../../domain/llm.js';
import type { AgentStreamEvent } from '../../domain/events.js';
import { rateLimitStreamEvent } from '../../domain/events.js';
import type { AgentPolicy } from '../../domain/agent-policy.js';
import type { TodoSnapshot } from '../../domain/task.js';
import { logger } from '../../shared/logger.js';
import { assertNotAborted, ChatAbortedError } from '../../shared/chat-aborted.js';
import { toolRegistry } from '../../tools/core/registry.js';
import type { ToolContext } from '../../tools/core/types.js';
import type { ToolPolicyGuard } from './tool-policy.js';
import { tryParseToolError } from './tool-errors.js';
import { executeToolCall, parseRawToolArgs } from './tool-execution.js';
import type { ToolDefinition } from '../../tools/core/types.js';
import {
  TODO_CONTINUATION_BUDGET,
  buildAgentSoftCircuitNotice,
  buildTodoBudgetExhaustedMessage,
  buildTodoContinuationNotice,
} from './todo-completion-gate.js';
export const CONSECUTIVE_SAME_TOOL_LIMIT = 3;
export const TODO_WRITE_CONSECUTIVE_LIMIT = 2;
export const CONSECUTIVE_SAME_ERROR_LIMIT = 2;

// Tools that mutate the workspace. A round that runs one of these made real
// progress, so it should not count toward the read-only "same tool loop"
// breaker. In read-only modes (plan/ask) none of these are available, so the
// breaker keeps stopping unproductive read/todo loops early.
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
  onBeforeRound?: () => Promise<void>;
  getPromptCacheKey?: () => string | undefined;
  signal?: AbortSignal;
  /** Agent-mode completion gate: current todo snapshot for this session. */
  getTodoSnapshot?: () => Promise<TodoSnapshot>;
  /**
   * When the model is about to return a final text answer, wait for any running
   * background subagent, inject its result, and return true to continue the loop.
   */
  waitForSubagentIfNeeded?: () => Promise<boolean>;
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

function getConsecutiveSameToolLimit(toolName: string): number {
  return toolName === 'todo_write' ? TODO_WRITE_CONSECUTIVE_LIMIT : CONSECUTIVE_SAME_TOOL_LIMIT;
}

function buildCircuitBreakerNotice(toolName: string, count: number): string {
  return (
    `NOTICE: '${toolName}' was called ${count} times in a row without progress. ` +
    'Stop calling tools. Respond to the user in plain text with your findings or ask what they want next.'
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
  let todoContinuationCount = 0;
  const gateRetries = new Map<number, number>();

  const isToolLoopBlocked = () => circuitBreakerNoticeSent;
  const bufferTextUntilAccepted = Boolean(deps.agentPolicy.bufferTextUntilAccepted);

  try {
    outer: while (round < deps.policy.maxToolRounds) {
      round++;
      assertNotAborted(handlers.signal);

      if (handlers.onBeforeRound) {
        await handlers.onBeforeRound();
      }
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
      }
      assertNotAborted(handlers.signal);

      const toolCalls = isToolLoopBlocked() ? undefined : response.tool_calls;

      handlers.addMessage({
        role: 'assistant',
        content: response.content,
        tool_calls: toolCalls,
        providerMeta: response.providerMeta,
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

        if (deps.agentPolicy.enforceOpenTodos && handlers.getTodoSnapshot) {
          const snapshot = await handlers.getTodoSnapshot();
          if (!snapshot.allTerminal && snapshot.open.length > 0) {
            if (todoContinuationCount >= TODO_CONTINUATION_BUDGET) {
              const exhausted = buildTodoBudgetExhaustedMessage(snapshot);
              logger.warn('Todo continuation budget exhausted', {
                open: snapshot.open.length,
                todoContinuationCount,
              });
              handlers.addMessage({ role: 'assistant', content: exhausted });
              return { content: exhausted, usage: response.usage ?? lastUsage };
            }

            todoContinuationCount++;
            const notice = buildTodoContinuationNotice(snapshot);
            logger.info('Todo completion gate: continuing', {
              open: snapshot.open.length,
              todoContinuationCount,
            });
            handlers.addMessage({ role: 'user', content: notice });
            continue;
          }
        }

        if (handlers.waitForSubagentIfNeeded) {
          const injected = await handlers.waitForSubagentIfNeeded();
          if (injected) {
            logger.info('Subagent finalization gate: synthesizing with injected result');
            continue;
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
          if (consecutiveSameError >= CONSECUTIVE_SAME_ERROR_LIMIT) {
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
      if (errorCircuitToolName) {
        logger.warn('Error circuit breaker triggered', {
          toolName: errorCircuitToolName,
          consecutiveSameError,
          policyId: deps.agentPolicy.id,
        });
        if (shouldHardBlockTools(deps.agentPolicy)) {
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

      const limit = getConsecutiveSameToolLimit(roundToolName);
      if (consecutiveSameTool >= limit) {
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

    if (deps.agentPolicy.enforceOpenTodos && handlers.getTodoSnapshot) {
      const snapshot = await handlers.getTodoSnapshot();
      if (!snapshot.allTerminal && snapshot.open.length > 0) {
        const exhausted = buildTodoBudgetExhaustedMessage(snapshot);
        logger.warn(exhausted);
        handlers.addMessage({ role: 'assistant', content: exhausted });
        return { content: exhausted, usage: lastUsage };
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
