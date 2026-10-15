import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('../../infrastructure/persistence/chat-debug-log.js', () => ({
  writeChatDebugLog: vi.fn(async () => {}),
}));

const mcpMock = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../../infrastructure/mcp/mcp-client-manager.js', () => ({
  createMcpClientManager: mcpMock.create,
  mcpClientManager: {},
}));

import { AgentBuilder } from '../../application/agent/agent-builder.js';
import {
  AgentConfigError,
  chainContinuation,
  DEFAULT_RATE_LIMIT_MAX_WAITS,
  resolveAgentPolicy,
  resolveRateLimitConfig,
  type ContinuationContext,
  type ContinuationPolicy,
} from '../../application/agent/config.js';
import { DEFAULT_AGENT_POLICY } from '../../domain/agent-policy.js';
import { isSummaryMessage, SUMMARY_MESSAGE_PREFIX } from '../../application/context/summarizer.js';
import { writeChatDebugLog } from '../../infrastructure/persistence/chat-debug-log.js';
import { OpenAIProvider } from '../../infrastructure/llm/providers.js';
import { RateLimitExceededError } from '../../infrastructure/llm/rate-limit.js';
import { MCP_TOOL_PREFIX } from '../../infrastructure/mcp/mcp-tool-bridge.js';
import { isFileLoggingEnabled, logger, LogLevel } from '../../shared/logger.js';
import { defineTool } from '../../tools/core/define-tool.js';
import { createToolRegistry, toolRegistry } from '../../tools/core/registry.js';
import { LOAD_SKILL_TOOL_NAME } from '../../tools/definitions/skills.js';
import { mockLLM, toolCall } from './mock-llm.js';

const echoTool = defineTool({
  name: 'builder_test_echo',
  description: 'echoes text back',
  inputSchema: z.object({ text: z.string() }),
  execute: async (args) => ({ content: `echo:${String(args.text)}` }),
});

const skill = { name: 'deploy', description: 'How to deploy', content: 'Run the deploy steps.' };

describe('clean AgentBuilder() is a plain text completion', () => {
  beforeEach(() => {
    vi.mocked(writeChatDebugLog).mockClear();
  });

  it('sends only the user message: no system, no tools, no model/options/cache key', async () => {
    const llm = mockLLM([{ content: 'hello back' }]);
    const agent = new AgentBuilder().Provider(llm).Build();
    await agent.init();

    const result = await agent.chat('hello');

    expect(result.content).toBe('hello back');
    expect(llm.calls).toHaveLength(1);
    const request = llm.calls[0];
    expect(request.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(request.messages.some((m) => m.role === 'system')).toBe(false);
    // tools: empty or absent, never a populated list
    expect(request.options.tools ?? []).toEqual([]);
    // nothing implicit: no model, no provider options, no cache key, no reasoning / tier
    expect(request.options.model).toBeUndefined();
    expect(request.options.options).toBeUndefined();
    expect(request.options.promptCacheKey).toBeUndefined();
    expect(request.options.promptCacheRetention).toBeUndefined();
    expect(request.options.reasoning).toBeUndefined();
    expect(request.options.serviceTier).toBeUndefined();
  });

  it('has no tools, system prompt, rules, skills or summary in its config', () => {
    const agent = new AgentBuilder().Provider(mockLLM([{ content: 'x' }])).Build();
    const config = agent.getConfig();

    expect(agent.getTools()).toEqual([]);
    expect(Object.keys(config.tools ?? {})).toEqual([]);
    expect(config.systemPrompt).toBeUndefined();
    expect(config.system).toBeUndefined();
    expect(config.rules).toBeUndefined();
    expect(config.skills).toBeUndefined();
    expect(config.autoSummary).toBeFalsy();
    expect(config.summarization).toBeUndefined();
    expect(config.model).toBeUndefined();
    expect(config.host).toBeUndefined();
    expect(config.options).toBeUndefined();
    expect(config.rateLimit).toBeUndefined();
    expect(config.logging).toBeUndefined();
    expect(config.repair).toBeUndefined();
    expect(config.sameToolBreaker).toBeUndefined();
    expect(config.continuation).toBeUndefined();
    expect(config.mcp).toBeUndefined();
    expect(agent.getModelProfile()).toBeUndefined();
  });

  it('never summarizes by itself, however long the history grows', async () => {
    const llm = mockLLM([{ content: 'ok', usage: { promptTokens: 900_000, completionTokens: 1, totalTokens: 900_001 } }]);
    const agent = new AgentBuilder().Provider(llm).Build();
    await agent.init();

    for (let i = 0; i < 6; i++) await agent.chat(`turn ${i}`);

    expect(llm.calls).toHaveLength(6);
    expect(agent.getHistory().some(isSummaryMessage)).toBe(false);
    expect(agent.getHistory()).toHaveLength(12);
  });

  it('does not write chat debug logs or switch on file logging', async () => {
    const llm = mockLLM([{ content: 'ok' }]);
    const agent = new AgentBuilder().Provider(llm).Build();
    await agent.init();
    await agent.chat('hi');

    expect(writeChatDebugLog).not.toHaveBeenCalled();
    expect(isFileLoggingEnabled()).toBe(false);
  });

  it('exposes an empty skill/tool surface even when a skill tool config is present but no skills exist', () => {
    const agent = new AgentBuilder()
      .Provider(mockLLM([{ content: 'x' }]))
      .SkillTool({ toolName: 'custom_skills' })
      .Build();
    expect(agent.getTools()).toEqual([]);
  });

  it('turns off nothing it should not: model and options appear only when set', async () => {
    const llm = mockLLM([{ content: 'ok' }]);
    const agent = new AgentBuilder().Provider(llm).Model('m-1').Options({ temperature: 0.7 }).Build();
    await agent.chat('hi');
    expect(llm.calls[0].options.model).toBe('m-1');
    expect(llm.calls[0].options.options).toEqual({ temperature: 0.7 });
  });

  it('acceptance: a whole turn stays plain (no REPAIR, no continuation, no MCP, no waiting, no log)', async () => {
    mcpMock.create.mockReset();
    const llm = mockLLM([{ tool_calls: [toolCall('ghost_tool', {})] }, { content: 'done' }]);
    const agent = new AgentBuilder().Provider(llm).Build();
    await agent.init();

    const result = await agent.chat('go');

    expect(result.content).toBe('done');
    expect(result.continuation).toBeUndefined();
    // the call to a tool nobody registered fails plainly: no REPAIR text anywhere
    const toolMessage = agent.getHistory().find((m) => m.role === 'tool');
    expect(toolMessage).toBeDefined();
    expect(toolMessage!.content).not.toContain('REPAIR');
    expect(llm.calls).toHaveLength(2);
    for (const call of llm.calls) {
      expect(call.messages.some((m) => m.role === 'system')).toBe(false);
      expect(JSON.stringify(call.messages)).not.toContain('REPAIR');
      expect(call.options.tools ?? []).toEqual([]);
      expect(call.options.model).toBeUndefined();
      expect(call.options.options).toBeUndefined();
      expect(call.options.promptCacheKey).toBeUndefined();
      expect(call.options.rateLimit).toBeUndefined();
    }
    // no summary, no rate-limit waiting, no MCP, no log
    expect(agent.getHistory().some(isSummaryMessage)).toBe(false);
    expect(agent.getRateLimitConfig()).toMatchObject({ enabled: false, maxWaits: 0 });
    expect(mcpMock.create).not.toHaveBeenCalled();
    expect(agent.getMcpStates()).toEqual([]);
    expect(agent.getTools()).toEqual([]);
    expect(writeChatDebugLog).not.toHaveBeenCalled();
    expect(isFileLoggingEnabled()).toBe(false);
  });

  it('a clean builder has no tools whatever the policy leaves unset', async () => {
    for (const policy of [{}, { allowedTools: undefined }, { id: undefined, allowedTools: undefined }]) {
      const llm = mockLLM([{ content: 'ok' }]);
      const agent = new AgentBuilder().Provider(llm).Policy(policy).Build();
      await agent.chat('hi');
      expect(agent.getTools()).toEqual([]);
      expect(llm.calls[0].options.tools ?? []).toEqual([]);
      expect(agent.getPolicy().id).toBe(DEFAULT_AGENT_POLICY.id);
    }
  });

  it('an unset allowedTools lets registered tools through; it never conjures tools', async () => {
    const llm = mockLLM([{ content: 'ok' }]);
    const agent = new AgentBuilder().Provider(llm).RegisterTool(echoTool).Policy({ allowedTools: undefined }).Build();
    await agent.chat('hi');
    expect(llm.calls[0].options.tools?.map((t) => t.function.name)).toEqual([echoTool.name]);
  });
});

describe('policy defaults and repair text hooks', () => {
  const failTool = defineTool({
    name: 'builder_test_fail',
    description: 'always fails',
    inputSchema: z.object({}),
    execute: async () => ({
      content: JSON.stringify({ error: { code: 'EXECUTION_ERROR', message: 'boom' } }),
      isError: true,
    }),
  });

  const failingToolMessage = async (repair: Parameters<AgentBuilder['Repair']>[0]) => {
    const llm = mockLLM([{ tool_calls: [toolCall(failTool.name, {})] }, { content: 'done' }]);
    const agent = new AgentBuilder().Provider(llm).RegisterTool(failTool).Repair(repair).Build();
    await agent.chat('go');
    return agent.getHistory().find((m) => m.role === 'tool')!.content;
  };

  it('resolveAgentPolicy: fields explicitly set to undefined (id included) keep the default', () => {
    expect(
      resolveAgentPolicy({ id: undefined, allowedTools: undefined, deniedToolReason: undefined })
    ).toStrictEqual(DEFAULT_AGENT_POLICY);
    expect(resolveAgentPolicy()).toStrictEqual(DEFAULT_AGENT_POLICY);
    expect(resolveAgentPolicy({ id: 'plan', allowedTools: ['a'], deniedToolReason: undefined })).toStrictEqual({
      id: 'plan',
      allowedTools: ['a'],
    });
  });

  it('Repair({ resolvers }): the resolver text replaces the generic one for that tool', async () => {
    const content = await failingToolMessage({
      enabled: true,
      resolvers: { [failTool.name]: ({ toolName, error }) => `fix ${toolName} (${error.code})` },
    });
    expect(content).toContain(`fix ${failTool.name} (`);
    expect(content).not.toContain('REPAIR');
  });

  it('Repair({ generic }) replaces the library text; a resolver returning undefined falls back to it', async () => {
    const generic = ({ toolName }: { toolName: string }) => `custom generic for ${toolName}`;
    expect(await failingToolMessage({ enabled: true, generic })).toContain(`custom generic for ${failTool.name}`);
    expect(
      await failingToolMessage({ enabled: true, resolvers: { [failTool.name]: () => undefined }, generic })
    ).toContain(`custom generic for ${failTool.name}`);
    expect(await failingToolMessage({ enabled: true })).toContain(`REPAIR: ${failTool.name} failed`);
  });

  it('Repair(config) copies the resolvers map', () => {
    const resolvers: Record<string, () => string> = { a: () => 'x' };
    const builder = new AgentBuilder().Provider(mockLLM([{ content: 'x' }])).Repair({ enabled: true, resolvers });
    resolvers.b = () => 'y';
    expect(Object.keys(builder.Build().getConfig().repair?.resolvers ?? {})).toEqual(['a']);
  });

  it('FromJSON reads repair.resolvers / repair.generic only when they are functions', () => {
    const fn = () => 'x';
    const read = (repair: unknown) =>
      new AgentBuilder()
        .Provider(mockLLM([{ content: 'x' }]))
        .FromJSON({ repair } as never)
        .Build()
        .getConfig().repair;

    expect(read({ enabled: true, maxAttempts: 2, resolvers: { a: 'text', b: fn }, generic: 'nope' })).toEqual({
      enabled: true,
      maxAttempts: 2,
      resolvers: { b: fn },
    });
    expect(read({ enabled: true, resolvers: { a: 'text' } })).toEqual({ enabled: true });
    expect(read({ generic: fn })).toEqual({ generic: fn });
    expect(read(true)).toEqual({ enabled: true });
  });
});

describe('explicit provider requirements', () => {
  it('Build() without provider or model throws an explicit error', () => {
    expect(() => new AgentBuilder().Build()).toThrow(AgentConfigError);
    expect(() => new AgentBuilder().Build()).toThrow(/Provider\(/);
  });

  it('Build() with a model but no host and no provider throws an explicit error', () => {
    expect(() => new AgentBuilder().Model('gpt-x').Build()).toThrow(/No host configured/);
  });

  it('LocalModel / RemoteModel still build a built-in provider', () => {
    expect(() => new AgentBuilder().LocalModel('llama3').Build()).not.toThrow();
    expect(() => new AgentBuilder().RemoteModel('http://127.0.0.1:9', 'm').Build()).not.toThrow();
  });
});

describe('tools are opt-in and instance-scoped', () => {
  it('registry.resolveToolSet with an empty selection returns no tools', () => {
    expect(toolRegistry.resolveToolSet({})).toEqual({});
    expect(toolRegistry.resolveToolSet({ exclude: ['read_file'] })).toEqual({});
    expect(createToolRegistry(toolRegistry).resolveToolSet({})).toEqual({});
  });

  it('builder.RegisterTool does not mutate the global toolRegistry', async () => {
    const before = toolRegistry.listNames();
    const llm = mockLLM([{ tool_calls: [toolCall(echoTool.name, { text: 'hi' })] }, { content: 'done' }]);
    const agent = new AgentBuilder().Provider(llm).RegisterTool(echoTool).Build();

    expect(toolRegistry.get(echoTool.name)).toBeUndefined();
    expect(toolRegistry.listNames()).toEqual(before);
    expect(agent.getTools()).toEqual([echoTool.name]);

    await agent.chat('go');
    expect(llm.calls[0].options.tools).toHaveLength(1);
    expect(agent.getHistory().some((m) => m.role === 'tool' && m.content === 'echo:hi')).toBe(true);
  });

  it('a registered tool can be picked by name through WithTools, still without touching the global registry', () => {
    const agent = new AgentBuilder().Provider(mockLLM([{ content: 'x' }])).RegisterTool(echoTool).WithTools(echoTool.name).Build();
    expect(agent.getTools()).toEqual([echoTool.name]);
    expect(toolRegistry.get(echoTool.name)).toBeUndefined();
  });

  it('built-in tools arrive only when explicitly selected', () => {
    const none = new AgentBuilder().Provider(mockLLM([{ content: 'x' }])).WithoutTools('read_file').Build();
    expect(none.getTools()).toEqual([]);

    const byName = new AgentBuilder().Provider(mockLLM([{ content: 'x' }])).WithTools('read_file').Build();
    expect(byName.getTools()).toEqual(['read_file']);

    const preset = new AgentBuilder().Provider(mockLLM([{ content: 'x' }])).WithPresets('search').Build();
    expect(preset.getTools()).toEqual(['grep']);
  });
});

describe('config sections are accepted and stored (all optional)', () => {
  it('builder methods fill their sections', () => {
    const continuation = { evaluate: () => ({ kind: 'stop' as const }) };
    const agent = new AgentBuilder()
      .Provider(mockLLM([{ content: 'x' }]))
      .Repair({ enabled: true, maxAttempts: 2 })
      .AllowedTools(['a'])
      .ErrorBreaker('soft')
      .PerTurnToolLimits({ a: 1 })
      .SameToolBreaker({ enabled: true, limit: 4 })
      .ProgressTools('edit_file')
      .MaxToolRounds(7)
      .RepeatCallLimit(3)
      .Continuation(continuation)
      .Summarization({ enabled: true, thresholdRatio: 0.7, keepRatio: 0.5, prefix: 'SUMMARY:', prompt: 'Summarize:\n{{conversation}}' })
      .SkillTool({ enabled: true, toolName: 'skills' })
      .Mcp({ enabled: false })
      .RateLimit({ enabled: true, maxWaits: 2, fallbackDelayMs: 5 })
      .Logging({ level: 3, chatDebugLog: false, source: 'worker-3' })
      .Build();
    const config = agent.getConfig();

    expect(config.repair).toEqual({ enabled: true, maxAttempts: 2 });
    expect(config.policy).toMatchObject({ allowedTools: ['a'], errorBreaker: 'soft', perTurnToolLimits: { a: 1 } });
    expect(config.sameToolBreaker).toEqual({ enabled: true, limit: 4 });
    expect(config.progressTools).toEqual(['edit_file']);
    expect(config.maxToolRounds).toBe(7);
    expect(config.repeatCallLimit).toBe(3);
    expect(config.continuation).toBe(continuation);
    expect(config.summarization).toMatchObject({ enabled: true, thresholdRatio: 0.7, prefix: 'SUMMARY:' });
    expect(config.skillTool).toEqual({ enabled: true, toolName: 'skills' });
    expect(config.mcp).toEqual({ enabled: false });
    expect(config.rateLimit).toEqual({ enabled: true, maxWaits: 2, fallbackDelayMs: 5 });
    expect(config.logging).toMatchObject({ level: 3, chatDebugLog: false, source: 'worker-3' });
    expect(agent.getPolicy().allowedTools).toEqual(['a']);
  });

  it('boolean shortcuts toggle a section', () => {
    const config = new AgentBuilder()
      .Provider(mockLLM([{ content: 'x' }]))
      .Repair()
      .SameToolBreaker(false)
      .RateLimit()
      .Summarization(true)
      .Build()
      .getConfig();
    expect(config.repair).toEqual({ enabled: true });
    expect(config.sameToolBreaker).toEqual({ enabled: false });
    expect(config.rateLimit).toEqual({ enabled: true });
    expect(config.summarization).toEqual({ enabled: true });
  });

  it('FromJSON reads system, tokenEstimator, promptCacheRetention and the new sections', () => {
    const config = new AgentBuilder()
      .Provider(mockLLM([{ content: 'x' }]))
      .FromJSON({
        system: 'Be brief.',
        tokenEstimator: { charsPerToken: 3 },
        promptCacheRetention: '24h',
        serviceTier: 'flex',
        maxToolRounds: 5,
        repeatCallLimit: 4,
        repair: { enabled: true },
        policy: { allowedTools: [], errorBreaker: 'hard' },
        sameToolBreaker: { enabled: true },
        progressTools: ['edit_file'],
        summarization: { enabled: true, prefix: 'S:' },
        skillTool: { toolName: 'skills' },
        mcp: { enabled: false },
        rateLimit: { enabled: true, maxWaits: 1 },
        logging: { chatDebugLog: true, source: 'json' },
        routingPolicy: { maxToolRounds: 9, deterministicMode: true },
      })
      .Build()
      .getConfig();

    expect(config.system).toBe('Be brief.');
    expect(config.tokenEstimator).toEqual({ charsPerToken: 3 });
    expect(config.promptCacheRetention).toBe('24h');
    expect(config.serviceTier).toBe('flex');
    expect(config.maxToolRounds).toBe(5);
    expect(config.repeatCallLimit).toBe(4);
    expect(config.repair).toEqual({ enabled: true });
    expect(config.policy).toEqual({ allowedTools: [], errorBreaker: 'hard' });
    expect(config.sameToolBreaker).toEqual({ enabled: true });
    expect(config.progressTools).toEqual(['edit_file']);
    expect(config.summarization).toEqual({ enabled: true, prefix: 'S:' });
    expect(config.skillTool).toEqual({ toolName: 'skills' });
    expect(config.mcp).toEqual({ enabled: false });
    expect(config.rateLimit).toEqual({ enabled: true, maxWaits: 1 });
    expect(config.logging).toEqual({ chatDebugLog: true, source: 'json', file: undefined });
    // the dead `deterministicMode` flag is dropped, the rest of routingPolicy survives
    expect(config.routingPolicy).toEqual({ maxToolRounds: 9 });
  });

  it('FromJSON system reaches the system message', async () => {
    const llm = mockLLM([{ content: 'ok' }]);
    const agent = new AgentBuilder().Provider(llm).FromJSON({ system: 'Be brief.' }).Build();
    await agent.init();
    await agent.chat('hi');
    expect(llm.calls[0].messages[0]).toEqual({ role: 'system', content: 'Be brief.' });
  });
});

describe('wired sections', () => {
  it('maxToolRounds / repeatCallLimit take precedence over routingPolicy and options', async () => {
    const llm = mockLLM([{ tool_calls: [toolCall(echoTool.name, { text: 'again' })] }]);
    const agent = new AgentBuilder()
      .Provider(llm)
      .RegisterTool(echoTool)
      .RoutingPolicy({ maxToolRounds: 9 })
      .MaxToolRounds(2)
      .Build();
    const result = await agent.chat('loop');
    expect(llm.calls).toHaveLength(2);
    expect(result.content).toContain('Tool loop limit reached (2)');
  });

  it('skillTool: custom tool name, and enabled:false hides the tool', () => {
    const named = new AgentBuilder().Provider(mockLLM([{ content: 'x' }])).AddSkill(skill).SkillTool({ toolName: 'skills_load' }).Build();
    expect(named.getTools()).toEqual(['skills_load']);

    const defaultName = new AgentBuilder().Provider(mockLLM([{ content: 'x' }])).AddSkill(skill).Build();
    expect(defaultName.getTools()).toEqual([LOAD_SKILL_TOOL_NAME]);

    const disabled = new AgentBuilder().Provider(mockLLM([{ content: 'x' }])).AddSkill(skill).SkillTool(false).Build();
    expect(disabled.getTools()).toEqual([]);
  });

  it('logging.chatDebugLog writes the turn log with a free-text source', async () => {
    const llm = mockLLM([{ content: 'ok' }]);
    const agent = new AgentBuilder().Provider(llm).Logging({ chatDebugLog: true, source: 'worker-3' }).Build();
    await agent.chat('hi');
    expect(writeChatDebugLog).toHaveBeenCalledTimes(1);
    expect(vi.mocked(writeChatDebugLog).mock.calls[0][0]).toMatchObject({ source: 'worker-3', userInput: 'hi' });
  });

  it('summarization.enabled summarizes once the context limit is exceeded; without it history is trimmed', async () => {
    const enabled = new AgentBuilder().Provider(mockLLM([{ content: 'ok' }])).ContextLimit(4).Summarization({ enabled: true }).Build();
    const trimmed = new AgentBuilder().Provider(mockLLM([{ content: 'ok' }])).ContextLimit(4).Build();
    for (const agent of [enabled, trimmed]) {
      await agent.init();
      for (let i = 0; i < 6; i++) await agent.chat('turn ' + i);
    }
    expect(enabled.getHistory().some(isSummaryMessage)).toBe(true);
    expect(trimmed.getHistory().some(isSummaryMessage)).toBe(false);
  });
});

describe('rate limit config is off unless enabled', () => {
  it('a clean agent never waits: disabled, zero waits', () => {
    const agent = new AgentBuilder().Provider(mockLLM([{ content: 'x' }])).Build();
    expect(agent.getRateLimitConfig()).toEqual({ enabled: false, maxWaits: 0 });
    expect(resolveRateLimitConfig({ maxWaits: 9, fallbackDelayMs: 1 })).toEqual({ enabled: false, maxWaits: 0 });
    expect(resolveRateLimitConfig({ enabled: false, maxWaits: 9 })).toEqual({ enabled: false, maxWaits: 0 });
  });

  it('enabled gets a finite default budget and its own settings', () => {
    expect(resolveRateLimitConfig({ enabled: true })).toMatchObject({ enabled: true, maxWaits: DEFAULT_RATE_LIMIT_MAX_WAITS });
    expect(
      resolveRateLimitConfig({ enabled: true, maxWaits: 5, fallbackDelayMs: 100, maxDelayMs: 2000, maxTotalWaitMs: 9000 })
    ).toEqual({ enabled: true, maxWaits: 5, fallbackDelayMs: 100, maxDelayMs: 2000, maxTotalWaitMs: 9000 });
    expect(resolveRateLimitConfig({ enabled: true, maxWaits: -1, maxDelayMs: Number.NaN })).toEqual({
      enabled: true,
      maxWaits: DEFAULT_RATE_LIMIT_MAX_WAITS,
    });
    const agent = new AgentBuilder().Provider(mockLLM([{ content: 'x' }])).RateLimit({ enabled: true, maxWaits: 2 }).Build();
    expect(agent.getRateLimitConfig()).toEqual({ enabled: true, maxWaits: 2 });
  });
});

describe('continuation policy', () => {
  const ctx = (extra: Partial<ContinuationContext> = {}): ContinuationContext => ({
    content: 'done',
    round: 1,
    continuations: 0,
    succeededTools: new Set(),
    messages: [],
    ...extra,
  });

  // The host rule (open todos -> continue twice -> hand the open list back) expressed through the hook.
  const openSteps = (open: () => string[]): ContinuationPolicy => ({
    maxContinuations: 2,
    async evaluate(context) {
      if (context.signal?.aborted) return { kind: 'stop', reason: 'not-listening' };
      const steps = open();
      if (steps.length === 0) return { kind: 'stop' };
      if (context.remaining === 0) return { kind: 'stop', reason: 'handoff', data: { open: steps } };
      return { kind: 'continue', notice: `Open steps: ${steps.join(', ')}.` };
    },
  });

  it('expresses continue / handoff / stop with async decisions, counters and the abort signal', async () => {
    const policy = openSteps(() => ['t1', 't2']);
    expect(await policy.evaluate(ctx({ remaining: 2 }))).toEqual({ kind: 'continue', notice: 'Open steps: t1, t2.' });
    expect(await policy.evaluate(ctx({ continuations: 2, remaining: 0 }))).toEqual({
      kind: 'stop',
      reason: 'handoff',
      data: { open: ['t1', 't2'] },
    });
    const controller = new AbortController();
    controller.abort();
    expect(await policy.evaluate(ctx({ signal: controller.signal }))).toMatchObject({ reason: 'not-listening' });
    expect(await openSteps(() => []).evaluate(ctx())).toEqual({ kind: 'stop' });
  });

  it('chain: first continue wins, remaining is per member, stop reasons survive', async () => {
    const never: ContinuationPolicy = { evaluate: () => ({ kind: 'stop' }) };
    const capped: ContinuationPolicy = { maxContinuations: 1, evaluate: () => ({ kind: 'continue', notice: 'A' }) };
    const second: ContinuationPolicy = { evaluate: () => ({ kind: 'continue', notice: 'B' }) };
    const reasoned: ContinuationPolicy = { evaluate: () => ({ kind: 'stop', reason: 'why', data: 1 }) };

    const chain = chainContinuation(never, capped, second);
    expect(chain.maxContinuations).toBeUndefined();
    expect(await chain.evaluate(ctx())).toEqual({ kind: 'continue', notice: 'A' });
    expect(await chain.evaluate(ctx({ continuations: 1 }))).toEqual({ kind: 'continue', notice: 'B' });

    expect((await chainContinuation(never, reasoned).evaluate(ctx())) as any).toMatchObject({ reason: 'why', data: 1 });
    expect(await chainContinuation(capped, { maxContinuations: 3, evaluate: () => ({ kind: 'stop' }) }).evaluate(ctx({ continuations: 1 }))).toEqual({
      kind: 'stop',
      reason: 'max-continuations',
    });
    expect(chainContinuation(capped, { maxContinuations: 3, evaluate: () => ({ kind: 'stop' }) }).maxContinuations).toBe(3);
    expect(await chainContinuation().evaluate(ctx())).toEqual({ kind: 'stop' });
  });

  it('builder: one policy is stored as is, several are chained, none clears', () => {
    const a: ContinuationPolicy = { evaluate: () => ({ kind: 'stop' }) };
    const b: ContinuationPolicy = { evaluate: () => ({ kind: 'stop' }) };
    const build = (fn: (builder: AgentBuilder) => AgentBuilder) =>
      fn(new AgentBuilder().Provider(mockLLM([{ content: 'x' }]))).Build().getConfig().continuation;
    expect(build((x) => x.Continuation(a))).toBe(a);
    expect(build((x) => x.Continuation(a, b))).not.toBe(a);
    expect(build((x) => x.Continuation(a).Continuation())).toBeUndefined();
  });
});

describe('summarization config reaches the summarizer', () => {
  const usage = { promptTokens: 900_000, completionTokens: 1, totalTokens: 900_001 };

  it('custom prompt, prefix and keepRatio are used; the default prefix no longer marks the summary', async () => {
    const llm = mockLLM([{ content: 'ok' }]);
    const agent = new AgentBuilder()
      .Provider(llm)
      .ContextLimit(10)
      .Summarization({ enabled: true, prefix: 'RECAP>', keepRatio: 0.3, prompt: 'Condense:\n{{conversation}}\nEnd.' })
      .Build();
    await agent.init();
    for (let i = 0; i < 6; i++) await agent.chat('turn ' + i);

    // 6 chats = 6 model calls, then one summary request at the end of the last turn
    expect(llm.calls).toHaveLength(7);
    const summaryRequest = llm.calls[6].messages;
    expect(summaryRequest).toHaveLength(1);
    expect(String(summaryRequest[0].content).startsWith('Condense:\n')).toBe(true);
    expect(String(summaryRequest[0].content).endsWith('\nEnd.')).toBe(true);
    expect(String(summaryRequest[0].content)).toContain('[user] turn 0');

    const history = agent.getHistory();
    expect(history[0]).toEqual({ role: 'user', content: 'RECAP> ok' });
    // keepRatio 0.3 of limit 10: the last 3 turns stay verbatim (the default 0.6 would keep 6)
    expect(history).toHaveLength(4);
    expect(history.some((m) => isSummaryMessage(m, 'RECAP>'))).toBe(true);
    expect(history.some((m) => isSummaryMessage(m))).toBe(false);
    // the context meter files it under summary through the configured prefix
    expect(agent.estimateContext().categories.summary).toBeGreaterThan(0);
  });

  it('omitted prompt/prefix/keepRatio use the neutral defaults', async () => {
    const llm = mockLLM([{ content: 'ok' }]);
    const agent = new AgentBuilder().Provider(llm).ContextLimit(10).Summarization(true).Build();
    await agent.init();
    for (let i = 0; i < 6; i++) await agent.chat('turn ' + i);

    const summaryRequest = String(llm.calls[6].messages[0].content);
    expect(summaryRequest).toContain('[user] turn 0');
    expect(summaryRequest).not.toMatch(/[^\x00-\x7F]/);
    const history = agent.getHistory();
    expect(isSummaryMessage(history[0])).toBe(true);
    expect(history[0].content).toBe(`${SUMMARY_MESSAGE_PREFIX} ok`);
    expect(history).toHaveLength(7);
  });

  it('token pressure alone never triggers a summary while summarization is off', async () => {
    const llm = mockLLM([{ content: 'ok', usage }]);
    const agent = new AgentBuilder().Provider(llm).ContextWindow(1000).Summarization({ enabled: false, prompt: 'X {{conversation}}' }).Build();
    await agent.init();
    for (let i = 0; i < 4; i++) await agent.chat('turn ' + i);
    expect(llm.calls).toHaveLength(4);
    expect(agent.getHistory()).toHaveLength(8);
    expect(llm.calls.every((call) => !String(call.messages[0].content).startsWith('X '))).toBe(true);
  });

  it('with summarization on, token pressure summarizes with the configured prompt', async () => {
    const llm = mockLLM([{ content: 'ok', usage }]);
    const agent = new AgentBuilder()
      .Provider(llm)
      .ContextWindow(1000)
      .Summarization({ enabled: true, thresholdRatio: 0.5, prefix: 'RECAP>', prompt: 'X {{conversation}}' })
      .Build();
    await agent.init();
    await agent.chat('one');
    await agent.chat('two');
    expect(llm.calls.some((call) => String(call.messages[0].content).startsWith('X '))).toBe(true);
    expect(agent.getHistory().some((m) => isSummaryMessage(m, 'RECAP>'))).toBe(true);
  });
});

describe('skill tool name and system message', () => {
  it('a clean agent with skills but skillTool disabled has no tool and no system message', async () => {
    const llm = mockLLM([{ content: 'ok' }]);
    const agent = new AgentBuilder().Provider(llm).AddSkill(skill).SkillTool({ enabled: false, toolName: 'skills_load' }).Build();
    await agent.init();
    await agent.chat('hi');
    expect(agent.getTools()).toEqual([]);
    expect(llm.calls[0].messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(llm.calls[0].options.tools ?? []).toEqual([]);
    expect(agent.compileRequest().parts.skills).toBe('');
  });

  it('a custom skill tool name is exposed, runs, files its result under skills and reports the catalog', async () => {
    const llm = mockLLM([{ tool_calls: [toolCall('skills_load', { name: 'deploy' }, 'sk1')] }, { content: 'done' }]);
    const agent = new AgentBuilder().Provider(llm).AddSkill(skill).SkillTool({ toolName: 'skills_load' }).Build();
    await agent.init();
    expect(agent.getTools()).toEqual(['skills_load']);
    expect(agent.compileRequest().parts.skills).toBe('deploy: How to deploy');
    expect(agent.compileRequest().toolSchemas.find((t) => t.name === 'skills_load')?.category).toBe('skills');

    await agent.chat('deploy it');
    const result = agent.getHistory().find((m) => m.role === 'tool');
    expect(result?.content).toBe('Run the deploy steps.');
    expect(agent.estimateContext().categories.skills).toBeGreaterThan(0);
    expect(agent.estimateContext().categories.toolResults).toBe(0);
  });

  it('only a given system / rules create a system message; skills alone never do', async () => {
    const skillsOnly = mockLLM([{ content: 'ok' }]);
    const a = new AgentBuilder().Provider(skillsOnly).AddSkill(skill).Build();
    await a.init();
    await a.chat('hi');
    expect(skillsOnly.calls[0].messages.some((m) => m.role === 'system')).toBe(false);

    const withRules = mockLLM([{ content: 'ok' }]);
    const b = new AgentBuilder().Provider(withRules).System('Be brief.').Rules('No emojis.').AddSkill(skill).Build();
    await b.init();
    await b.chat('hi');
    expect(withRules.calls[0].messages[0]).toEqual({ role: 'system', content: 'Be brief.\n\nNo emojis.' });
  });
});

describe('repair, same-tool breaker and continuation follow the config', () => {
  const failTool = defineTool({
    name: 'builder_test_fail',
    description: 'always fails',
    inputSchema: z.object({}),
    execute: async () => ({
      content: JSON.stringify({ error: { code: 'EXECUTION_ERROR', message: 'boom' } }),
      isError: true,
    }),
  });
  const rounds = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ tool_calls: [toolCall(echoTool.name, { text: `r${i}` }, `c${i}`)] }));

  it('repair: failed tool results carry no REPAIR text unless repair.enabled', async () => {
    const run = async (repair: boolean) => {
      const llm = mockLLM([{ tool_calls: [toolCall(failTool.name, {})] }, { content: 'done' }]);
      const builder = new AgentBuilder().Provider(llm).RegisterTool(failTool);
      if (repair) builder.Repair();
      const agent = builder.Build();
      await agent.chat('go');
      return agent.getHistory().find((m) => m.role === 'tool')!.content;
    };
    expect(await run(false)).not.toContain('REPAIR');
    expect(await run(true)).toContain('REPAIR: builder_test_fail failed');
  });

  it('sameToolBreaker / progressTools: read from config instead of module constants', async () => {
    const run = async (configure: (b: AgentBuilder) => AgentBuilder) => {
      const llm = mockLLM([...rounds(3), { content: 'done' }]);
      const agent = configure(new AgentBuilder().Provider(llm).RegisterTool(echoTool).MaxToolRounds(10)).Build();
      await agent.chat('go');
      return agent.getHistory().filter((m) => m.role === 'user' && m.content.includes(echoTool.name)).length;
    };
    expect(await run((b) => b)).toBe(0);
    expect(await run((b) => b.SameToolBreaker({ enabled: true, limit: 3 }))).toBe(1);
    expect(await run((b) => b.SameToolBreaker({ enabled: false, limit: 1 }))).toBe(0);
    // a progress tool that led the round (and succeeded) keeps counting as an ordinary streak
    expect(await run((b) => b.SameToolBreaker({ enabled: true, limit: 3 }).ProgressTools(echoTool.name))).toBe(1);
  });

  it('continuation: ContinuationPolicy.evaluate runs after a tool-less reply', async () => {
    const seen: string[] = [];
    const llm = mockLLM([{ content: 'first' }, { content: 'second' }]);
    const agent = new AgentBuilder()
      .Provider(llm)
      .Continuation({
        async evaluate(context) {
          seen.push(context.content);
          return context.continuations === 0 ? { kind: 'continue', notice: 'go on' } : { kind: 'stop', reason: 'enough' };
        },
      })
      .Build();
    const result = await agent.chat('go');
    expect(seen).toEqual(['first', 'second']);
    expect(result.content).toBe('second');
    expect(result.continuation).toEqual({ continuations: 1, reason: 'enough' });
  });
});

describe('rate limit reaches the provider (A3)', () => {
  /** A real OpenAIProvider whose HTTP client always answers 429. */
  function rateLimitedProvider() {
    const create = vi.fn(async () => {
      throw Object.assign(new Error('Rate limit reached for gpt-5 on tokens per min (TPM)'), {
        status: 429,
        headers: { 'retry-after-ms': '2000' },
      });
    });
    const provider = new OpenAIProvider('http://127.0.0.1:9/v1', 'k', undefined, { completionsOnly: true });
    (provider as unknown as { client: unknown }).client = { chat: { completions: { create } } };
    return { provider, create };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a rate-limited provider error surfaces at once, no waiting by default', async () => {
    const { provider, create } = rateLimitedProvider();
    const agent = new AgentBuilder().Provider(provider).Build();
    const started = Date.now();

    await expect(agent.chat('hi')).rejects.toMatchObject({ status: 429 });

    expect(create).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('RateLimit({ enabled: false }) waits no more than the default', async () => {
    const { provider, create } = rateLimitedProvider();
    const agent = new AgentBuilder().Provider(provider).RateLimit({ enabled: false, maxWaits: 5 }).Build();
    await expect(agent.chat('hi')).rejects.toMatchObject({ status: 429 });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('enabled waits at most maxWaits times, never unbounded, then fails clearly', async () => {
    vi.useFakeTimers();
    const { provider, create } = rateLimitedProvider();
    const agent = new AgentBuilder().Provider(provider).RateLimit({ enabled: true, maxWaits: 2 }).Build();
    const events: string[] = [];

    const assertion = expect(
      agent.chat('hi', { onEvent: (event) => events.push(event.type) })
    ).rejects.toBeInstanceOf(RateLimitExceededError);
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;

    expect(create).toHaveBeenCalledTimes(3);
    expect(events.filter((type) => type === 'rate_limit.wait')).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('enabled: fallbackDelayMs and maxTotalWaitMs come from the builder config', async () => {
    vi.useFakeTimers();
    const create = vi.fn(async () => {
      throw Object.assign(new Error('Rate limit reached'), { status: 429 });
    });
    const provider = new OpenAIProvider('http://127.0.0.1:9/v1', 'k', undefined, { completionsOnly: true });
    (provider as unknown as { client: unknown }).client = { chat: { completions: { create } } };
    const agent = new AgentBuilder()
      .Provider(provider)
      .RateLimit({ enabled: true, maxWaits: 10, fallbackDelayMs: 100, maxTotalWaitMs: 250 })
      .Build();
    const delays: number[] = [];

    const assertion = expect(
      agent.chat('hi', {
        onEvent: (event) => {
          if (event.type === 'rate_limit.wait') delays.push(event.delayMs);
        },
      })
    ).rejects.toMatchObject({ reason: 'max-total-wait' });
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;

    expect(delays).toEqual([100, 100]); // a third 100 ms wait would pass 250 ms
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('enabled also covers a provider that was built elsewhere: the policy travels in ChatOptions', async () => {
    const llm = mockLLM([{ content: 'ok' }]);
    const policyOf = () => llm.calls[0].options.rateLimit;

    await new AgentBuilder().Provider(llm).RateLimit({ enabled: true, maxWaits: 4, fallbackDelayMs: 7 }).Build().chat('a');
    expect(policyOf()).toEqual({ enabled: true, maxWaits: 4, fallbackDelayMs: 7, maxDelayMs: undefined, maxTotalWaitMs: undefined });

    const clean = mockLLM([{ content: 'ok' }]);
    await new AgentBuilder().Provider(clean).Build().chat('a');
    expect(clean.calls[0].options.rateLimit).toBeUndefined();
  });

  it('an abort during the wait stops the turn at once', async () => {
    vi.useFakeTimers();
    const { provider, create } = rateLimitedProvider();
    const agent = new AgentBuilder().Provider(provider).RateLimit({ enabled: true, maxWaits: 5 }).Build();
    const controller = new AbortController();

    const assertion = expect(agent.chat('hi', { signal: controller.signal })).rejects.toThrow(/abort/i);
    await vi.advanceTimersByTimeAsync(500);
    controller.abort();
    await assertion;

    expect(create).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

/** Stands in for the MCP SDK-backed manager: returns one bridged tool named with the configured prefix. */
function fakeMcpManager(toolPrefix?: string) {
  const prefix = toolPrefix?.trim() || MCP_TOOL_PREFIX;
  const tool = defineTool({
    name: `${prefix}docs__search`,
    description: 'search docs over MCP',
    inputSchema: z.object({ query: z.string() }),
    execute: async () => ({ content: 'none' }),
  });
  return {
    tool,
    manager: {
      connectAll: vi.fn(async () => ({ [tool.name]: tool })),
      disconnectAll: vi.fn(async () => {}),
      listStates: vi.fn(() => [{ id: 'docs', status: 'connected', toolCount: 1, tools: [] }]),
    },
  };
}

describe('built-in providers add no model to the request when none is set', () => {
  it('OpenAIProvider sends no model key without Model(), and sends it with Model()', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const create = vi.fn(async (body: Record<string, unknown>) => {
      bodies.push(body);
      throw new Error('stop here');
    });
    const makeProvider = () => {
      const provider = new OpenAIProvider('http://127.0.0.1:9/v1', 'k', undefined, { completionsOnly: true });
      (provider as unknown as { client: unknown }).client = { chat: { completions: { create } } };
      return provider;
    };

    await expect(new AgentBuilder().Provider(makeProvider()).Build().chat('hi')).rejects.toThrow('stop here');
    await expect(new AgentBuilder().Provider(makeProvider()).Model('m1').Build().chat('hi')).rejects.toThrow('stop here');

    expect('model' in bodies[0]).toBe(false);
    expect(bodies[1].model).toBe('m1');
  });
});

describe('mcp is optional and instance-scoped (A3)', () => {
  const servers = { docs: { command: 'node', args: ['server.js'] } };

  beforeEach(() => {
    mcpMock.create.mockReset();
  });

  it('is disabled by default: no manager is created, no server is touched', async () => {
    const agent = new AgentBuilder().Provider(mockLLM([{ content: 'x' }])).Build();
    await agent.init();
    expect(mcpMock.create).not.toHaveBeenCalled();
    expect(await agent.connectMcp()).toEqual([]);
    expect(agent.getMcpStates()).toEqual([]);
    expect(agent.getTools()).toEqual([]);
  });

  it('servers only connect when enabled: configured servers with enabled false or omitted stay idle', async () => {
    for (const mcp of [{ servers }, { enabled: false, servers }, { enabled: true }, { enabled: true, servers: {} }]) {
      const agent = new AgentBuilder().Provider(mockLLM([{ content: 'x' }])).Mcp(mcp).Build();
      await agent.init();
    }
    expect(mcpMock.create).not.toHaveBeenCalled();
  });

  it('enabled: init() connects the servers through the agent\'s own manager and merges their tools', async () => {
    const { manager, tool } = fakeMcpManager();
    mcpMock.create.mockReturnValue(manager);
    const before = toolRegistry.listNames();
    const agent = new AgentBuilder().Provider(mockLLM([{ content: 'x' }])).Mcp({ enabled: true, servers }).Build();

    await agent.init();
    await agent.init(); // a second init does not reconnect

    expect(mcpMock.create).toHaveBeenCalledTimes(1);
    expect(manager.connectAll).toHaveBeenCalledTimes(1);
    expect(manager.connectAll).toHaveBeenCalledWith(servers);
    expect(agent.getTools()).toEqual([tool.name]);
    expect(agent.getMcpStates()).toEqual([expect.objectContaining({ id: 'docs', status: 'connected' })]);
    // instance registry only: the shared one is not polluted
    expect(agent.getToolRegistry().get(tool.name)).toBe(tool);
    expect(toolRegistry.get(tool.name)).toBeUndefined();
    expect(toolRegistry.listNames()).toEqual(before);
  });

  it('two agents keep separate MCP tools and registries', async () => {
    const one = fakeMcpManager();
    const two = fakeMcpManager('ext_');
    mcpMock.create.mockReturnValueOnce(one.manager).mockReturnValueOnce(two.manager);
    const a = new AgentBuilder().Provider(mockLLM([{ content: 'x' }])).Mcp({ enabled: true, servers }).Build();
    const b = new AgentBuilder().Provider(mockLLM([{ content: 'x' }])).Mcp({ enabled: true, servers, toolPrefix: 'ext_' }).Build();
    await a.init();
    await b.init();

    expect(a.getTools()).toEqual([one.tool.name]);
    expect(b.getTools()).toEqual([two.tool.name]);
    expect(a.getToolRegistry().get(two.tool.name)).toBeUndefined();
    expect(b.getToolRegistry().get(one.tool.name)).toBeUndefined();
  });

  it('mcp.toolPrefix reaches the manager and decides the mcp context category', async () => {
    const { manager, tool } = fakeMcpManager('ext_');
    mcpMock.create.mockReturnValue(manager);
    const agent = new AgentBuilder().Provider(mockLLM([{ content: 'x' }])).Mcp({ enabled: true, servers, toolPrefix: 'ext_' }).Build();
    await agent.init();

    expect(mcpMock.create).toHaveBeenCalledWith({ toolPrefix: 'ext_' });
    expect(agent.getMcpToolPrefix()).toBe('ext_');
    const compiled = agent.compileRequest();
    expect(compiled.toolSchemas.find((t) => t.name === tool.name)?.category).toBe('mcp');
    expect(compiled.estimate.categories.mcp).toBeGreaterThan(0);

    // a tool outside the configured prefix is a plain tool, even when it starts with the default one
    const stray = defineTool({
      name: `${MCP_TOOL_PREFIX}stray`,
      description: 'x',
      inputSchema: z.object({}),
      execute: async () => ({ content: '' }),
    });
    agent.mergeExternalTools({ [stray.name]: stray });
    expect(agent.compileRequest().toolSchemas.find((t) => t.name === stray.name)?.category).toBe('tools');
  });

  it('the default prefix still classifies bridged tools as mcp when nothing is configured', () => {
    const agent = new AgentBuilder().Provider(mockLLM([{ content: 'x' }])).Build();
    const tool = defineTool({
      name: `${MCP_TOOL_PREFIX}docs__search`,
      description: 'x',
      inputSchema: z.object({}),
      execute: async () => ({ content: '' }),
    });
    agent.mergeExternalTools({ [tool.name]: tool });
    expect(agent.compileRequest().toolSchemas[0]).toMatchObject({ name: tool.name, category: 'mcp' });
    expect(toolRegistry.get(tool.name)).toBeUndefined();
  });

  it('disconnectMcp removes the tools and closes the connections', async () => {
    const { manager } = fakeMcpManager();
    mcpMock.create.mockReturnValue(manager);
    const agent = new AgentBuilder().Provider(mockLLM([{ content: 'x' }])).Mcp({ enabled: true, servers }).Build();
    await agent.init();
    expect(agent.getTools()).toHaveLength(1);

    await agent.disconnectMcp();

    expect(agent.getTools()).toEqual([]);
    expect(manager.disconnectAll).toHaveBeenCalledTimes(1);
  });

  it('mergeExternalTools reports the names that replaced an existing tool', () => {
    const agent = new AgentBuilder().Provider(mockLLM([{ content: 'x' }])).RegisterTool(echoTool).Build();
    const clash = defineTool({
      name: echoTool.name,
      description: 'replacement',
      inputSchema: z.object({}),
      execute: async () => ({ content: '' }),
    });
    expect(agent.mergeExternalTools({ [clash.name]: clash })).toEqual([echoTool.name]);
    expect(agent.mergeExternalTools({ fresh_tool: { ...clash, name: 'fresh_tool' } })).toEqual([]);
    expect(toolRegistry.get(echoTool.name)).toBeUndefined();
  });
});

describe('logging is per agent (A3)', () => {
  it('Logging.level / logLevel never change the shared logger', async () => {
    const levelBefore = logger.getLevel();
    const agent = new AgentBuilder().Provider(mockLLM([{ content: 'ok' }])).Logging({ level: LogLevel.ERROR }).Build();
    await agent.chat('hi');
    new AgentBuilder().Provider(mockLLM([{ content: 'ok' }])).LogLevel(LogLevel.DEBUG).Build();

    expect(logger.getLevel()).toBe(levelBefore);
    expect(isFileLoggingEnabled()).toBe(false);
  });

  it('logging.file writes this agent\'s log (shared logger calls inside a turn included) without enabling global file logging', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'poyraz-agent-log-'));
    try {
      const agent = new AgentBuilder()
        .Provider(mockLLM([{ content: 'ok' }]))
        .Logging({ level: LogLevel.INFO, file: { enabled: true, logDir: dir } })
        .Build();
      await agent.chat('hello there');

      await vi.waitFor(() => expect(readFileSync(path.join(dir, 'agent.log'), 'utf-8')).toContain('User message received'));
      expect(isFileLoggingEnabled()).toBe(false);
      expect(logger.getLogDir()).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('chat debug log goes to the agent\'s log dir, only when chatDebugLog is on, with no default source', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'poyraz-agent-log-'));
    try {
      vi.mocked(writeChatDebugLog).mockClear();
      const file = { enabled: true, logDir: dir };
      const off = new AgentBuilder().Provider(mockLLM([{ content: 'ok' }])).Logging({ file }).Build();
      await off.chat('hi');
      expect(writeChatDebugLog).not.toHaveBeenCalled();

      const on = new AgentBuilder().Provider(mockLLM([{ content: 'ok' }])).Logging({ file, chatDebugLog: true }).Build();
      await on.chat('hi');
      expect(writeChatDebugLog).toHaveBeenCalledTimes(1);
      const [entry, logDir] = vi.mocked(writeChatDebugLog).mock.calls[0];
      expect(logDir).toBe(dir);
      expect(entry.source).toBeUndefined();
      expect(entry).toMatchObject({ userInput: 'hi' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
