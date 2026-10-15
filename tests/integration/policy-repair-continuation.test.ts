import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('../../infrastructure/persistence/chat-debug-log.js', () => ({
  writeChatDebugLog: vi.fn(async () => {}),
}));

import { AgentBuilder } from '../../application/agent/agent-builder.js';
import type {
  ContinuationContext,
  ContinuationDecision,
  ContinuationPolicy,
} from '../../application/agent/config.js';
import { runDecisionLoop } from '../../application/chat/decision-loop.js';
import {
  buildRepairInstruction,
  builtinRepairResolvers,
  type RepairOptions,
} from '../../application/chat/repair-instruction.js';
import { createToolPolicyGuard } from '../../application/chat/tool-policy.js';
import { createMessageContext } from '../../application/context/message-context.js';
import { DEFAULT_AGENT_POLICY, resolvePolicyDenied, resolvePolicyTools } from '../../domain/agent-policy.js';
import type { ChatMessage } from '../../domain/llm.js';
import { ChatAbortedError } from '../../shared/chat-aborted.js';
import { defineTool } from '../../tools/core/define-tool.js';
import { mockLLM, toolCall } from './mock-llm.js';

const echoTool = defineTool({
  name: 'pol_echo',
  description: 'echoes text back',
  inputSchema: z.object({ text: z.string() }),
  execute: async (args) => ({ content: `echo:${String(args.text)}` }),
});

const stepTool = defineTool({
  name: 'pol_step',
  description: 'makes progress',
  inputSchema: z.object({ n: z.number() }),
  execute: async (args) => ({ content: `step:${String(args.n)}` }),
});

const failTool = defineTool({
  name: 'pol_fail',
  description: 'always fails',
  inputSchema: z.object({ n: z.number().optional() }),
  execute: async () => ({
    content: JSON.stringify({ error: { code: 'EXECUTION_ERROR', message: 'boom' } }),
    isError: true,
  }),
});

const toolMessages = (messages: ChatMessage[]) => messages.filter((m) => m.role === 'tool');
const userNotices = (messages: ChatMessage[], needle: string) =>
  messages.filter((m) => m.role === 'user' && m.content.includes(needle));

/** Rounds of distinct echo calls so identical-call limits never interfere. */
const echoRounds = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ tool_calls: [toolCall(echoTool.name, { text: `t${i}` }, `e${i}`)] }));

// ---------------------------------------------------------------------------
// Repair
// ---------------------------------------------------------------------------

describe('repair is off unless enabled, name independent when on', () => {
  const failingTurn = () =>
    mockLLM([{ tool_calls: [toolCall(failTool.name, { n: 1 }, 'f1')] }, { content: 'done' }]);

  it('a clean agent adds no REPAIR text to failed tool results', async () => {
    const agent = new AgentBuilder().Provider(failingTurn()).RegisterTool(failTool).Build();
    await agent.chat('go');
    const [result] = toolMessages(agent.getHistory());
    expect(result.content).toContain('boom');
    expect(result.content).not.toContain('REPAIR');
  });

  it('repair.enabled adds a generic text naming the tool, with no mode wording', async () => {
    const agent = new AgentBuilder().Provider(failingTurn()).RegisterTool(failTool).Repair().Build();
    await agent.chat('go');
    const [result] = toolMessages(agent.getHistory());
    expect(result.content).toContain('REPAIR: pol_fail failed (EXECUTION_ERROR)');
    expect(result.content).not.toMatch(/\/mode|Plan mode|Ask mode|Agent mode/i);
  });

  it('a policy-blocked call gets a neutral text, not a "/mode agent" hint', async () => {
    const llm = mockLLM([{ tool_calls: [toolCall(echoTool.name, { text: 'x' })] }, { content: 'ok' }]);
    const agent = new AgentBuilder()
      .Provider(llm)
      .RegisterTool(echoTool)
      .RegisterTool(stepTool)
      .AllowedTools([stepTool.name])
      .Repair()
      .Build();
    await agent.chat('go');
    const [result] = toolMessages(agent.getHistory());
    expect(result.content).toContain('POLICY_BLOCKED');
    expect(result.content).toContain('blocked by policy');
    expect(result.content).not.toMatch(/\/mode|switch to/i);
  });

  it('per-tool resolvers are optional and fall back to the generic text', async () => {
    const repair: RepairOptions = {
      enabled: true,
      resolvers: {
        pol_fail: ({ error, args }) => `CUSTOM(${error.code}, n=${String(args.n)})`,
        pol_echo: () => undefined,
      },
    };
    const llm = mockLLM([
      { tool_calls: [toolCall(failTool.name, { n: 7 }, 'f1'), toolCall('pol_missing', {}, 'm1')] },
      { content: 'done' },
    ]);
    const agent = new AgentBuilder().Provider(llm).RegisterTool(failTool).Repair(repair).Build();
    await agent.chat('go');
    const [failed, missing] = toolMessages(agent.getHistory());
    expect(failed.content).toContain('CUSTOM(EXECUTION_ERROR, n=7)');
    expect(missing.content).toContain('REPAIR: pol_missing failed (TOOL_NOT_FOUND)');
  });

  it('maxAttempts bounds the repair texts per identical call', async () => {
    const same = (id: string) => ({ tool_calls: [toolCall(failTool.name, { n: 1 }, id)] });
    const llm = mockLLM([same('f1'), same('f2'), same('f3'), { content: 'done' }]);
    const agent = new AgentBuilder()
      .Provider(llm)
      .RegisterTool(failTool)
      .RepeatCallLimit(10)
      .Repair({ enabled: true, maxAttempts: 2 })
      .Build();
    await agent.chat('go');
    const results = toolMessages(agent.getHistory()).map((m) => m.content.includes('REPAIR:'));
    expect(results).toEqual([true, true, false]);
  });

  it('with repair off an identical failing call is bounded by repeatCallLimit', async () => {
    const same = (id: string) => ({ tool_calls: [toolCall(failTool.name, { n: 1 }, id)] });
    const llm = mockLLM([same('f1'), same('f2'), same('f3'), { content: 'done' }]);
    const agent = new AgentBuilder().Provider(llm).RegisterTool(failTool).RepeatCallLimit(2).Build();
    await agent.chat('go');
    const results = toolMessages(agent.getHistory());
    expect(results[0].content).toContain('boom');
    expect(results[2].content).toContain('POLICY_BLOCKED');
    expect(results.every((m) => !m.content.includes('REPAIR'))).toBe(true);
  });

  it('builtinRepairResolvers is the opt-in home of the edit_file / run_terminal_cmd / grep texts', () => {
    const error = { code: 'VALIDATION_ERROR', message: 'bad' };
    expect(buildRepairInstruction('grep', error, {})).not.toContain('head_limit');
    expect(buildRepairInstruction('grep', error, {}, undefined, { resolvers: builtinRepairResolvers })).toContain(
      'head_limit'
    );
    expect(
      buildRepairInstruction('run_terminal_cmd', { code: 'X', message: 'long-running is_background' }, {}, undefined, {
        resolvers: builtinRepairResolvers,
      })
    ).toContain('is_background: true');
    expect(
      buildRepairInstruction('edit_file', error, { target_file: 'a.ts' }, { lastReadFile: { path: 'a.ts', lineCount: 3 } }, {
        resolvers: builtinRepairResolvers,
      })
    ).toContain('You read a.ts (3 lines)');
    // a built-in resolver steps aside for policy blocks, the neutral text applies
    expect(
      buildRepairInstruction('edit_file', { code: 'POLICY_BLOCKED', message: 'denied' }, {}, undefined, {
        resolvers: builtinRepairResolvers,
      })
    ).toContain('blocked by policy');
  });

  it('options.generic replaces the generic text', () => {
    const text = buildRepairInstruction('t', { code: 'X', message: 'm' }, {}, undefined, {
      generic: ({ toolName }) => `REPAIR: custom for ${toolName}`,
    });
    expect(text).toBe('REPAIR: custom for t');
  });
});

// ---------------------------------------------------------------------------
// Same-tool breaker / progress tools / round limits
// ---------------------------------------------------------------------------

describe('same-tool breaker and progress tools come from config', () => {
  it('off by default: any number of identical-tool rounds ends without a notice', async () => {
    const llm = mockLLM([...echoRounds(5), { content: 'done' }]);
    const agent = new AgentBuilder().Provider(llm).RegisterTool(echoTool).MaxToolRounds(10).Build();
    await agent.chat('go');
    expect(userNotices(agent.getHistory(), 'NOTICE')).toHaveLength(0);
    expect(llm.calls).toHaveLength(6);
  });

  it('enabled: soft notice after `limit` consecutive rounds led by the same tool', async () => {
    const llm = mockLLM([...echoRounds(4), { content: 'done' }]);
    const agent = new AgentBuilder()
      .Provider(llm)
      .RegisterTool(echoTool)
      .MaxToolRounds(10)
      .SameToolBreaker({ enabled: true, limit: 3 })
      .Build();
    await agent.chat('go');

    const history = agent.getHistory();
    const notices = userNotices(history, 'pol_echo');
    expect(notices).toHaveLength(1);
    expect(notices[0].content).toContain('<system_reminder>');
    // the notice follows the third tool round (after every tool response of that round)
    const noticeIndex = history.indexOf(notices[0]);
    expect(history[noticeIndex - 1]).toMatchObject({ role: 'tool', content: 'echo:t2' });
    // soft mode never strips tool calls
    expect(history.filter((m) => m.role === 'assistant' && m.tool_calls?.length)).toHaveLength(4);
  });

  it('limit is configurable', async () => {
    const llm = mockLLM([...echoRounds(3), { content: 'done' }]);
    const agent = new AgentBuilder()
      .Provider(llm)
      .RegisterTool(echoTool)
      .MaxToolRounds(10)
      .SameToolBreaker({ enabled: true, limit: 2 })
      .Build();
    await agent.chat('go');
    const history = agent.getHistory();
    const noticeIndex = history.findIndex((m) => m.role === 'user' && m.content.includes('pol_echo'));
    expect(history[noticeIndex - 1]).toMatchObject({ role: 'tool', content: 'echo:t1' });
  });

  it('hard block policy drops further tool calls after the notice', async () => {
    const llm = mockLLM([...echoRounds(5), { content: 'done' }]);
    const agent = new AgentBuilder()
      .Provider(llm)
      .RegisterTool(echoTool)
      .MaxToolRounds(10)
      .Policy({ hardBlockDeniedTools: true })
      .SameToolBreaker({ enabled: true, limit: 2 })
      .Build();
    await agent.chat('go');
    expect(llm.calls).toHaveLength(3);
    const assistants = agent.getHistory().filter((m) => m.role === 'assistant');
    expect(assistants[2].tool_calls).toBeUndefined();
  });

  const mixedRounds = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      tool_calls: [
        toolCall(echoTool.name, { text: `m${i}` }, `me${i}`),
        toolCall(stepTool.name, { n: i }, `ms${i}`),
      ],
    }));

  it('progressTools: a succeeded progress tool in a round resets the streak', async () => {
    const run = async (withProgress: boolean) => {
      const llm = mockLLM([...mixedRounds(4), { content: 'done' }]);
      const builder = new AgentBuilder()
        .Provider(llm)
        .RegisterTool(echoTool)
        .RegisterTool(stepTool)
        .MaxToolRounds(10)
        .SameToolBreaker({ enabled: true, limit: 2 });
      if (withProgress) builder.ProgressTools(stepTool.name);
      const agent = builder.Build();
      await agent.chat('go');
      return userNotices(agent.getHistory(), 'pol_echo').length;
    };
    expect(await run(false)).toBeGreaterThan(0);
    expect(await run(true)).toBe(0);
  });

  it('progressTools: a failing progress tool is not progress', async () => {
    const rounds = Array.from({ length: 4 }, (_, i) => ({
      tool_calls: [
        toolCall(echoTool.name, { text: `x${i}` }, `xe${i}`),
        toolCall(failTool.name, { n: i }, `xf${i}`),
      ],
    }));
    const llm = mockLLM([...rounds, { content: 'done' }]);
    const agent = new AgentBuilder()
      .Provider(llm)
      .RegisterTool(echoTool)
      .RegisterTool(failTool)
      .MaxToolRounds(10)
      .SameToolBreaker({ enabled: true, limit: 2 })
      .ProgressTools(failTool.name)
      .Build();
    await agent.chat('go');
    expect(userNotices(agent.getHistory(), 'pol_echo').length).toBeGreaterThan(0);
  });

  it('maxToolRounds: top level > routingPolicy > options; repeatCallLimit likewise', async () => {
    const loop = mockLLM([{ tool_calls: [toolCall(echoTool.name, { text: 'again' })] }]);
    const top = new AgentBuilder()
      .Provider(loop)
      .RegisterTool(echoTool)
      .Options({ max_tool_rounds: 8 })
      .RoutingPolicy({ maxToolRounds: 6 })
      .MaxToolRounds(3)
      .Build();
    expect((await top.chat('x')).content).toContain('Tool loop limit reached (3)');

    const viaRouting = new AgentBuilder()
      .Provider(mockLLM([{ tool_calls: [toolCall(echoTool.name, { text: 'again' })] }]))
      .RegisterTool(echoTool)
      .Options({ max_tool_rounds: 8 })
      .RoutingPolicy({ maxToolRounds: 4 })
      .Build();
    expect((await viaRouting.chat('x')).content).toContain('Tool loop limit reached (4)');

    const viaOptions = new AgentBuilder()
      .Provider(mockLLM([{ tool_calls: [toolCall(echoTool.name, { text: 'again' })] }]))
      .RegisterTool(echoTool)
      .Options({ max_tool_rounds: 5 })
      .Build();
    expect((await viaOptions.chat('x')).content).toContain('Tool loop limit reached (5)');

    // identical calls: the 2nd is blocked with repeatCallLimit 1, allowed with 3 (top level wins)
    const same = (id: string) => ({ tool_calls: [toolCall(echoTool.name, { text: 'same' }, id)] });
    const strict = new AgentBuilder()
      .Provider(mockLLM([same('a'), same('b'), { content: 'done' }]))
      .RegisterTool(echoTool)
      .RoutingPolicy({ repeatCallLimit: 9 })
      .RepeatCallLimit(1)
      .Build();
    await strict.chat('x');
    expect(toolMessages(strict.getHistory())[1].content).toContain('POLICY_BLOCKED');

    const lenient = new AgentBuilder()
      .Provider(mockLLM([same('a'), same('b'), { content: 'done' }]))
      .RegisterTool(echoTool)
      .Options({ repeat_call_limit: 1 })
      .RoutingPolicy({ repeatCallLimit: 3 })
      .Build();
    await lenient.chat('x');
    expect(toolMessages(lenient.getHistory())[1].content).toBe('echo:same');
  });
});

// ---------------------------------------------------------------------------
// Policy end to end
// ---------------------------------------------------------------------------

describe('policy: AllowedTools, PerTurnToolLimits, ErrorBreaker, ResponseGates', () => {
  it('resolveAgentPolicy defaults: all tools, breaker off; unset fields do not deny', () => {
    const agent = new AgentBuilder().Provider(mockLLM([{ content: 'x' }])).Build();
    expect(agent.getPolicy()).toMatchObject({ id: 'default', allowedTools: 'all' });
    expect(agent.getPolicy().errorBreaker).toBeUndefined();
    expect(resolvePolicyTools(['a', 'b'], { ...DEFAULT_AGENT_POLICY, allowedTools: undefined as any })).toEqual(['a', 'b']);
    expect(resolvePolicyDenied(['a', 'b'], { ...DEFAULT_AGENT_POLICY, allowedTools: ['a'] })).toEqual(['b']);
  });

  it('AllowedTools narrows the schemas sent and blocks calls to denied tools with deniedToolReason', async () => {
    const llm = mockLLM([{ tool_calls: [toolCall(stepTool.name, { n: 1 })] }, { content: 'ok' }]);
    const agent = new AgentBuilder()
      .Provider(llm)
      .RegisterTool(echoTool)
      .RegisterTool(stepTool)
      .Policy({ deniedToolReason: 'Not available here.' })
      .AllowedTools([echoTool.name])
      .Build();

    expect(agent.getTools()).toEqual([echoTool.name]);
    await agent.chat('go');
    expect(llm.calls[0].options.tools).toHaveLength(1);
    const [blocked] = toolMessages(agent.getHistory());
    expect(blocked.content).toContain('POLICY_BLOCKED');
    expect(blocked.content).toContain('Not available here.');
  });

  it('AllowedTools([]) leaves a plain completion and later widening via setPolicy works', async () => {
    const llm = mockLLM([{ content: 'a' }, { content: 'b' }]);
    const agent = new AgentBuilder().Provider(llm).RegisterTool(echoTool).AllowedTools([]).Build();
    expect(agent.getTools()).toEqual([]);
    await agent.chat('one');
    expect(llm.calls[0].options.tools ?? []).toEqual([]);
    agent.setPolicy({ ...agent.getPolicy(), allowedTools: 'all' });
    expect(agent.getTools()).toEqual([echoTool.name]);
    await agent.chat('two');
    expect(llm.calls[1].options.tools).toHaveLength(1);
  });

  it('PerTurnToolLimits caps successful calls per turn and resets next turn', async () => {
    const llm = mockLLM([
      { tool_calls: [toolCall(echoTool.name, { text: 'a' }, 'a')] },
      { tool_calls: [toolCall(echoTool.name, { text: 'b' }, 'b')] },
      { content: 'first turn done' },
      { tool_calls: [toolCall(echoTool.name, { text: 'c' }, 'c')] },
      { content: 'second turn done' },
    ]);
    const agent = new AgentBuilder().Provider(llm).RegisterTool(echoTool).PerTurnToolLimits({ [echoTool.name]: 1 }).Build();

    await agent.chat('turn 1');
    const first = toolMessages(agent.getHistory());
    expect(first[0].content).toBe('echo:a');
    expect(first[1].content).toContain('at most 1 time(s) per turn');

    await agent.chat('turn 2');
    const all = toolMessages(agent.getHistory());
    expect(all[2].content).toBe('echo:c');
  });

  it('ErrorBreaker: off by default, soft injects a reminder, hard + hardBlock strips later tool calls', async () => {
    const failing = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ tool_calls: [toolCall(failTool.name, { n: i }, `f${i}`)] }));
    // same error message each time -> same error key even with different args
    const build = (configure: (b: AgentBuilder) => AgentBuilder, llm: ReturnType<typeof mockLLM>) =>
      configure(new AgentBuilder().Provider(llm).RegisterTool(failTool).MaxToolRounds(10)).Build();

    const off = build((b) => b, mockLLM([...failing(3), { content: 'done' }]));
    await off.chat('go');
    expect(userNotices(off.getHistory(), 'NOTICE')).toHaveLength(0);

    const soft = build((b) => b.ErrorBreaker('soft'), mockLLM([...failing(3), { content: 'done' }]));
    await soft.chat('go');
    expect(userNotices(soft.getHistory(), 'same error twice').length).toBeGreaterThan(0);

    const hardLlm = mockLLM([...failing(4), { content: 'done' }]);
    const hard = build((b) => b.Policy({ errorBreaker: 'hard', hardBlockDeniedTools: true }), hardLlm);
    await hard.chat('go');
    expect(userNotices(hard.getHistory(), 'Stop retrying that tool call')).toHaveLength(1);
    expect(hardLlm.calls).toHaveLength(3);
  });

  it('ResponseGates retry a rejected reply with the gate notice, then accept', async () => {
    const llm = mockLLM([{ content: 'BAD answer' }, { content: 'good answer' }]);
    const agent = new AgentBuilder()
      .Provider(llm)
      .ResponseGates({
        maxRetries: 1,
        evaluate: ({ content }) =>
          content.includes('BAD') ? { kind: 'retry', notice: 'Do not say BAD.' } : { kind: 'accept' },
      })
      .Build();
    const result = await agent.chat('go');
    expect(result.content).toBe('good answer');
    expect(llm.calls).toHaveLength(2);
    expect(userNotices(agent.getHistory(), 'Do not say BAD.')).toHaveLength(1);
  });

  it('ResponseGates onExhausted sanitizes the reply once retries are used up', async () => {
    const llm = mockLLM([{ content: 'BAD answer' }]);
    const agent = new AgentBuilder()
      .Provider(llm)
      .ResponseGates({
        maxRetries: 0,
        evaluate: () => ({ kind: 'retry', notice: 'again' }),
        onExhausted: () => 'sanitized',
      })
      .Build();
    const result = await agent.chat('go');
    expect(result.content).toBe('sanitized');
    expect(llm.calls).toHaveLength(1);
  });

  it('gates see the tools that succeeded this turn', async () => {
    const seen: string[][] = [];
    const llm = mockLLM([{ tool_calls: [toolCall(echoTool.name, { text: 'a' })] }, { content: 'done' }]);
    const agent = new AgentBuilder()
      .Provider(llm)
      .RegisterTool(echoTool)
      .ResponseGates({
        maxRetries: 0,
        evaluate: ({ succeededTools }) => {
          seen.push([...succeededTools]);
          return { kind: 'accept' };
        },
      })
      .Build();
    await agent.chat('go');
    expect(seen).toEqual([[echoTool.name]]);
  });
});

// ---------------------------------------------------------------------------
// DecisionLoopDeps.model / options optional
// ---------------------------------------------------------------------------

describe('decision loop request: model and options are optional', () => {
  it('leaves both keys out of the request when unset', async () => {
    const llm = mockLLM([{ content: 'hi' }]);
    const context = createMessageContext({ limit: 50 });
    context.addMessage({ role: 'user', content: 'hello' });
    await runDecisionLoop(
      { provider: llm, policy: { maxToolRounds: 3 }, agentPolicy: DEFAULT_AGENT_POLICY },
      {},
      createToolPolicyGuard({ maxToolRounds: 3, repeatCallLimit: 2 }),
      { getMessages: () => context.getMessages(), addMessage: (m) => context.addMessage(m), buildToolContext: () => ({}) }
    );
    expect('model' in llm.calls[0].options).toBe(false);
    expect('options' in llm.calls[0].options).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Continuation
// ---------------------------------------------------------------------------

describe('continuation policy runs inside the decision loop', () => {
  const continueOnce = (record?: ContinuationContext[]): ContinuationPolicy => ({
    async evaluate(context) {
      record?.push(context);
      await new Promise((resolve) => setTimeout(resolve, 2));
      return context.continuations === 0 ? { kind: 'continue', notice: 'Keep going.' } : { kind: 'stop' };
    },
  });

  it('no policy: the first tool-less reply ends the turn and no outcome is reported', async () => {
    const llm = mockLLM([{ content: 'only' }]);
    const result = await new AgentBuilder().Provider(llm).Build().chat('go');
    expect(result.continuation).toBeUndefined();
    expect(llm.calls).toHaveLength(1);
  });

  it('continue appends the notice as a user message and runs another round (async evaluate is awaited)', async () => {
    const llm = mockLLM([{ content: 'first' }, { content: 'second' }]);
    const agent = new AgentBuilder().Provider(llm).Continuation(continueOnce()).Build();
    const result = await agent.chat('go');

    expect(result.content).toBe('second');
    expect(result.continuation).toEqual({ continuations: 1 });
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1].messages.slice(-2)).toEqual([
      { role: 'assistant', content: 'first' },
      { role: 'user', content: 'Keep going.' },
    ]);
  });

  it('the context carries content, round, counters, remaining, tools, usage, messages, sessionId and signal', async () => {
    const record: ContinuationContext[] = [];
    const policy: ContinuationPolicy = { maxContinuations: 3, evaluate: continueOnce(record).evaluate };
    const llm = mockLLM([
      { tool_calls: [toolCall(echoTool.name, { text: 'a' })] },
      { content: 'first', usage: { promptTokens: 5, completionTokens: 1, totalTokens: 6 } },
      { content: 'second' },
    ]);
    const agent = new AgentBuilder().Provider(llm).RegisterTool(echoTool).Continuation(policy).Build();
    agent.setSessionId('session-1');
    const controller = new AbortController();
    await agent.chat('go', { signal: controller.signal });

    expect(record).toHaveLength(2);
    expect(record[0]).toMatchObject({
      content: 'first',
      round: 2,
      continuations: 0,
      remaining: 3,
      sessionId: 'session-1',
      usage: { promptTokens: 5, completionTokens: 1, totalTokens: 6 },
    });
    expect(record[0].signal).toBe(controller.signal);
    expect([...record[0].succeededTools]).toEqual([echoTool.name]);
    expect(record[0].messages.at(-1)).toMatchObject({ role: 'assistant', content: 'first' });
    expect(record[1]).toMatchObject({ content: 'second', round: 3, continuations: 1, remaining: 2 });
  });

  it('is not consulted after replies that carry tool calls', async () => {
    const evaluate = vi.fn(async (): Promise<ContinuationDecision> => ({ kind: 'stop' }));
    const llm = mockLLM([{ tool_calls: [toolCall(echoTool.name, { text: 'a' })] }, { content: 'done' }]);
    const agent = new AgentBuilder().Provider(llm).RegisterTool(echoTool).Continuation({ evaluate }).Build();
    await agent.chat('go');
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('maxContinuations is a hard cap: a continue beyond it becomes stop with reason max-continuations', async () => {
    const remainingSeen: Array<number | undefined> = [];
    const policy: ContinuationPolicy = {
      maxContinuations: 2,
      evaluate: (context) => {
        remainingSeen.push(context.remaining);
        return { kind: 'continue', notice: `again ${context.continuations}` };
      },
    };
    const llm = mockLLM([{ content: 'r' }]);
    const agent = new AgentBuilder().Provider(llm).MaxToolRounds(10).Continuation(policy).Build();
    const result = await agent.chat('go');

    expect(llm.calls).toHaveLength(3);
    expect(remainingSeen).toEqual([2, 1, 0]);
    expect(result.continuation).toEqual({ continuations: 2, reason: 'max-continuations' });
    expect(userNotices(agent.getHistory(), 'again')).toHaveLength(2);
  });

  it('maxContinuations 0 never continues', async () => {
    const llm = mockLLM([{ content: 'r' }]);
    const agent = new AgentBuilder()
      .Provider(llm)
      .Continuation({ maxContinuations: 0, evaluate: () => ({ kind: 'continue', notice: 'x' }) })
      .Build();
    const result = await agent.chat('go');
    expect(llm.calls).toHaveLength(1);
    expect(result.continuation).toEqual({ continuations: 0, reason: 'max-continuations' });
  });

  it('stop hands reason and data back on the result', async () => {
    const llm = mockLLM([{ content: 'r' }]);
    const agent = new AgentBuilder()
      .Provider(llm)
      .Continuation({ evaluate: () => ({ kind: 'stop', reason: 'handoff', data: { open: ['t1'] } }) })
      .Build();
    const result = await agent.chat('go');
    expect(result.continuation).toEqual({ continuations: 0, reason: 'handoff', data: { open: ['t1'] } });
  });

  it('a plain stop reports only the count', async () => {
    const agent = new AgentBuilder()
      .Provider(mockLLM([{ content: 'r' }]))
      .Continuation({ evaluate: () => ({ kind: 'stop' }) })
      .Build();
    expect((await agent.chat('go')).continuation).toEqual({ continuations: 0 });
  });

  it('several policies are chained: the first continue wins, the count is shared', async () => {
    const never: ContinuationPolicy = { evaluate: () => ({ kind: 'stop' }) };
    const once: ContinuationPolicy = {
      maxContinuations: 1,
      evaluate: () => ({ kind: 'continue', notice: 'from once' }),
    };
    const reasoned: ContinuationPolicy = { evaluate: () => ({ kind: 'stop', reason: 'why', data: 1 }) };
    const llm = mockLLM([{ content: 'a' }, { content: 'b' }]);
    const agent = new AgentBuilder().Provider(llm).Continuation(never, reasoned, once).Build();
    const result = await agent.chat('go');

    expect(llm.calls).toHaveLength(2);
    expect(userNotices(agent.getHistory(), 'from once')).toHaveLength(1);
    expect(result.continuation).toEqual({ continuations: 1, reason: 'why', data: 1 });
  });

  it('runs after the response gates accepted the reply, not on gate retries', async () => {
    const contents: string[] = [];
    const llm = mockLLM([{ content: 'BAD' }, { content: 'fine' }]);
    const agent = new AgentBuilder()
      .Provider(llm)
      .ResponseGates({
        maxRetries: 1,
        evaluate: ({ content }) => (content === 'BAD' ? { kind: 'retry', notice: 'fix it' } : { kind: 'accept' }),
      })
      .Continuation({
        evaluate: (context) => {
          contents.push(context.content);
          return { kind: 'stop' };
        },
      })
      .Build();
    const result = await agent.chat('go');
    expect(result.content).toBe('fine');
    expect(contents).toEqual(['fine']);
  });

  it('an abort during evaluate ends the turn with ChatAbortedError, even if the policy decided to continue', async () => {
    const controller = new AbortController();
    const llm = mockLLM([{ content: 'r' }]);
    const agent = new AgentBuilder()
      .Provider(llm)
      .Continuation({
        evaluate: async () => {
          controller.abort();
          return { kind: 'continue', notice: 'more' };
        },
      })
      .Build();
    await expect(agent.chat('go', { signal: controller.signal })).rejects.toBeInstanceOf(ChatAbortedError);
    expect(llm.calls).toHaveLength(1);
  });

  it('a policy failure surfaces as the chat error; a failure caused by an abort surfaces as an abort', async () => {
    const failing = new AgentBuilder()
      .Provider(mockLLM([{ content: 'r' }]))
      .Continuation({
        evaluate: () => {
          throw new Error('policy broke');
        },
      })
      .Build();
    await expect(failing.chat('go')).rejects.toThrow('policy broke');

    const controller = new AbortController();
    const aborted = new AgentBuilder()
      .Provider(mockLLM([{ content: 'r' }]))
      .Continuation({
        evaluate: async () => {
          controller.abort();
          throw new Error('fetch aborted');
        },
      })
      .Build();
    await expect(aborted.chat('go', { signal: controller.signal })).rejects.toBeInstanceOf(ChatAbortedError);
  });

  it('an empty notice ends the turn instead of sending an empty user message', async () => {
    const llm = mockLLM([{ content: 'r' }]);
    const agent = new AgentBuilder()
      .Provider(llm)
      .Continuation({ evaluate: () => ({ kind: 'continue', notice: '  ' }) })
      .Build();
    const result = await agent.chat('go');
    expect(llm.calls).toHaveLength(1);
    expect(result.continuation).toEqual({ continuations: 0 });
  });

  it('the count resets every turn (the policy keeps no state)', async () => {
    const llm = mockLLM([{ content: 'a' }, { content: 'b' }, { content: 'c' }, { content: 'd' }]);
    const agent = new AgentBuilder().Provider(llm).Continuation(continueOnce()).Build();
    expect((await agent.chat('one')).continuation).toEqual({ continuations: 1 });
    expect((await agent.chat('two')).continuation).toEqual({ continuations: 1 });
  });
});

// ---------------------------------------------------------------------------
// context.usage `final` is decided after gates and continuation
// ---------------------------------------------------------------------------

describe('context.usage final flag', () => {
  type UsageEvent = { round: number; final: boolean };

  /** Runs one turn and returns the usage events plus everything else that happened, in order. */
  async function runTurn(
    configure: (builder: AgentBuilder, trace: string[]) => AgentBuilder,
    steps: Parameters<typeof mockLLM>[0],
    signal?: AbortSignal
  ) {
    const trace: string[] = [];
    const usage: UsageEvent[] = [];
    const agent = configure(new AgentBuilder().Provider(mockLLM(steps)).RegisterTool(echoTool), trace).Build();
    let error: unknown;
    try {
      await agent.chat('go', {
        signal,
        onEvent: (event) => {
          if (event.type === 'context.usage') {
            usage.push({ round: event.round, final: event.final });
            trace.push(`usage:${event.round}:${event.final}`);
          }
        },
      });
    } catch (caught) {
      error = caught;
    }
    return { usage, trace, error };
  }

  it('a plain reply is final', async () => {
    const { usage } = await runTurn((b) => b, [{ content: 'hi' }]);
    expect(usage).toEqual([{ round: 1, final: true }]);
  });

  it('a tool round is not final, the closing reply is', async () => {
    const { usage } = await runTurn((b) => b, [
      { tool_calls: [toolCall(echoTool.name, { text: 'a' })] },
      { content: 'done' },
    ]);
    expect(usage).toEqual([
      { round: 1, final: false },
      { round: 2, final: true },
    ]);
  });

  it('a continue decision keeps the request non-final; the event follows the decision', async () => {
    const { usage, trace } = await runTurn(
      (b, order) =>
        b.Continuation({
          evaluate: (context) => {
            order.push(`evaluate:${context.continuations}`);
            return context.continuations === 0 ? { kind: 'continue', notice: 'more' } : { kind: 'stop' };
          },
        }),
      [{ content: 'first' }, { content: 'second' }]
    );
    expect(usage).toEqual([
      { round: 1, final: false },
      { round: 2, final: true },
    ]);
    expect(trace).toEqual(['evaluate:0', 'usage:1:false', 'evaluate:1', 'usage:2:true']);
  });

  it('a stop decision and the maxContinuations cap make the request final', async () => {
    const stopped = await runTurn(
      (b) => b.Continuation({ evaluate: () => ({ kind: 'stop', reason: 'enough' }) }),
      [{ content: 'a' }]
    );
    expect(stopped.usage).toEqual([{ round: 1, final: true }]);

    const capped = await runTurn(
      (b) => b.MaxToolRounds(10).Continuation({ maxContinuations: 1, evaluate: () => ({ kind: 'continue', notice: 'x' }) }),
      [{ content: 'a' }]
    );
    expect(capped.usage).toEqual([
      { round: 1, final: false },
      { round: 2, final: true },
    ]);
  });

  it('a response gate retry is not final', async () => {
    const { usage } = await runTurn(
      (b) =>
        b.ResponseGates({
          maxRetries: 1,
          evaluate: ({ content }) => (content === 'BAD' ? { kind: 'retry', notice: 'again' } : { kind: 'accept' }),
        }),
      [{ content: 'BAD' }, { content: 'fine' }]
    );
    expect(usage).toEqual([
      { round: 1, final: false },
      { round: 2, final: true },
    ]);
  });

  it('a request that cannot be followed by another round (round budget used up) is final', async () => {
    const tool = await runTurn((b) => b.MaxToolRounds(1), [{ tool_calls: [toolCall(echoTool.name, { text: 'a' })] }]);
    expect(tool.usage).toEqual([{ round: 1, final: true }]);

    const continued = await runTurn(
      (b) => b.MaxToolRounds(1).Continuation({ evaluate: () => ({ kind: 'continue', notice: 'more' }) }),
      [{ content: 'a' }]
    );
    expect(continued.usage).toEqual([{ round: 1, final: true }]);
  });

  it('an abort while the policy decides still reports the paid request, as final, once', async () => {
    const controller = new AbortController();
    const { usage, error } = await runTurn(
      (b) =>
        b.Continuation({
          evaluate: async () => {
            controller.abort();
            return { kind: 'continue', notice: 'more' };
          },
        }),
      [{ content: 'a' }],
      controller.signal
    );
    expect(error).toBeInstanceOf(ChatAbortedError);
    expect(usage).toEqual([{ round: 1, final: true }]);
  });

  it('an abort right after the response still reports the request', async () => {
    const controller = new AbortController();
    const llm = mockLLM([{ content: 'a' }]);
    const original = llm.chat.bind(llm);
    llm.chat = async (...args: Parameters<typeof original>) => {
      const response = await original(...args);
      controller.abort();
      return response;
    };
    const events: UsageEvent[] = [];
    const agent = new AgentBuilder().Provider(llm).Build();
    await expect(
      agent.chat('go', {
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === 'context.usage') events.push({ round: event.round, final: event.final });
        },
      })
    ).rejects.toBeInstanceOf(ChatAbortedError);
    expect(events).toEqual([{ round: 1, final: true }]);
  });
});
