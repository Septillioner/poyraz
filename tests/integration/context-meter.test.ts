import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent } from '../../application/agent/agent.js';
import { SUMMARY_MESSAGE_PREFIX } from '../../application/context/summarizer.js';
import { CONTEXT_CATEGORIES, type ContextCategoryTokens } from '../../domain/context.js';
import { MCP_TOOL_PREFIX } from '../../infrastructure/mcp/mcp-tool-bridge.js';
import { defineTool } from '../../tools/core/define-tool.js';
import { toolRegistry } from '../../tools/core/registry.js';
import { LOAD_SKILL_TOOL_NAME } from '../../tools/definitions/skills.js';
import { mockLLM, toolCall } from './mock-llm.js';

function sum(categories: ContextCategoryTokens): number {
  return CONTEXT_CATEGORIES.reduce((acc, key) => acc + categories[key], 0);
}

const echoTool = defineTool({
  name: 'echo',
  description: 'echoes text back',
  inputSchema: z.object({ text: z.string() }),
  execute: async (args) => ({ content: `echo:${String(args.text)}` }),
});

const mcpTool = defineTool({
  name: `${MCP_TOOL_PREFIX}docs__search`,
  description: 'search docs over MCP',
  inputSchema: z.object({ query: z.string() }),
  execute: async () => ({ content: 'none' }),
});

function makeAgent(provider: ReturnType<typeof mockLLM>, extra: Partial<ConstructorParameters<typeof Agent>[0]> = {}) {
  return new Agent({
    provider,
    model: 'mock',
    name: 'ctx-test',
    systemPrompt: 'You are a test agent.',
    rules: ['Always answer briefly.'],
    skills: [{ name: 'deploy', description: 'How to deploy', content: 'DEPLOY STEPS '.repeat(20) }],
    tools: { echo: echoTool },
    contextWindowTokens: 10_000,
    ...extra,
  });
}

describe('context compile and meter (mock-llm)', () => {
  afterEach(() => {
    toolRegistry.unregister(mcpTool.name);
  });

  it('compiles the request that is actually sent and classifies every category', async () => {
    const llm = mockLLM([
      {
        tool_calls: [toolCall('load_skill', { name: 'deploy' }, 'call_skill'), toolCall('echo', { text: 'hi' }, 'call_echo')],
        usage: { promptTokens: 400, completionTokens: 10, totalTokens: 410 },
      },
      { content: 'all done', usage: { promptTokens: 900, completionTokens: 20, totalTokens: 920 } },
    ]);
    const agent = makeAgent(llm);
    agent.mergeExternalTools({ [mcpTool.name]: mcpTool });
    await agent.init();

    const before = agent.compileRequest();
    expect(before.tools.map((t) => t.function.name).sort()).toEqual(
      ['echo', LOAD_SKILL_TOOL_NAME, mcpTool.name].sort()
    );
    expect(before.parts.system).toBe('You are a test agent.');
    expect(before.parts.rules).toBe('Always answer briefly.');
    expect(before.parts.skills).toBe('deploy: How to deploy');
    expect(before.estimate.categories.system).toBeGreaterThan(0);
    expect(before.estimate.categories.rules).toBeGreaterThan(0);
    expect(before.estimate.categories.skills).toBeGreaterThan(0);
    expect(before.estimate.categories.tools).toBeGreaterThan(0);
    expect(before.estimate.categories.mcp).toBeGreaterThan(0);
    expect(before.toolSchemas.find((t) => t.name === mcpTool.name)?.category).toBe('mcp');
    expect(before.toolSchemas.find((t) => t.name === LOAD_SKILL_TOOL_NAME)?.category).toBe('skills');

    await agent.chat('please deploy');

    // The provider received exactly the compiled tool schemas, twice (two rounds).
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[0].options.tools).toEqual(before.tools);
    expect(llm.calls[1].messages.length).toBeGreaterThan(llm.calls[0].messages.length);

    const after = agent.estimateContext();
    expect(after.categories.toolCalls).toBeGreaterThan(0);
    expect(after.categories.toolResults).toBeGreaterThan(0);
    expect(after.categories.conversation).toBeGreaterThan(before.estimate.categories.conversation);
    // The loaded skill body is filed under skills, not toolResults.
    const entries = agent.compileRequest().messages;
    expect(entries.some((m) => m.role === 'tool' && m.content.startsWith('DEPLOY STEPS'))).toBe(true);
    expect(after.categories.skills).toBeGreaterThan(before.estimate.categories.skills);
    expect(after.total).toBe(sum(after.categories));
  });

  it('pairs estimate and real per request and keeps the real meter equal to the provider total', async () => {
    const llm = mockLLM([
      {
        tool_calls: [toolCall('echo', { text: 'ping' }, 'call_echo')],
        usage: { promptTokens: 400, completionTokens: 10, totalTokens: 410 },
      },
      { content: 'all done', usage: { promptTokens: 900, completionTokens: 20, totalTokens: 920 } },
    ]);
    const agent = makeAgent(llm);
    await agent.init();

    expect(agent.getContextReal()).toBeUndefined();
    const emptyReal = agent.getContextMeterReal();
    expect(emptyReal).toMatchObject({ source: 'real', total: 0, windowTokens: 10_000, percent: 0 });

    await agent.chat('ping me');

    const records = agent.getContextRecords();
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.real?.promptTokens)).toEqual([400, 900]);
    expect(records[0].estimate.total).toBeGreaterThan(0);
    expect(records[1].estimate.total).toBeGreaterThan(records[0].estimate.total);
    for (const record of records) {
      expect(record.drift?.tokens).toBe(record.estimate.total - (record.real?.promptTokens ?? 0));
    }

    const real = agent.getContextReal()!;
    expect(real.total).toBe(900);
    expect(sum(real.categories)).toBe(900);
    expect(real.estimate.total).toBe(records[1].estimate.total);
    expect(agent.getContextDrift()).toEqual(records[1].drift);

    const meter = agent.getContextMeterReal();
    expect(meter).toMatchObject({ source: 'real', total: 900, windowTokens: 10_000, percent: 9 });
    expect(sum(meter.categories)).toBe(meter.total);
  });

  it('estimate meter follows the live context and is independent of the real meter', async () => {
    const llm = mockLLM([{ content: 'hello there', usage: { promptTokens: 50, completionTokens: 5, totalTokens: 55 } }]);
    const agent = makeAgent(llm);
    await agent.init();

    const before = agent.getContextMeterEstimate();
    expect(before).toMatchObject({ source: 'estimate', windowTokens: 10_000 });
    expect(before.total).toBe(sum(before.categories));
    expect(before.percent).toBeCloseTo((before.total / 10_000) * 100, 1);

    await agent.chat('x'.repeat(2000));
    const after = agent.getContextMeterEstimate();
    expect(after.total).toBeGreaterThan(before.total + 500);
    expect(agent.getContextMeterReal().total).toBe(50);
  });

  it('applies the policy filter to the compiled tools and supports a tool-less compile', async () => {
    const llm = mockLLM([{ content: 'ok' }]);
    const agent = makeAgent(llm, { policy: { id: 'ro', allowedTools: ['echo'] } });
    await agent.init();

    const full = agent.compileRequest();
    expect(full.tools.map((t) => t.function.name)).toEqual(['echo']);
    expect(full.estimate.categories.mcp).toBe(0);
    expect(full.estimate.categories.skills).toBe(0);

    const bare = agent.compileRequest({ includeTools: false });
    expect(bare.tools).toEqual([]);
    expect(bare.estimate.categories.tools).toBe(0);
    expect(full.estimate.total - bare.estimate.total).toBe(full.estimate.categories.tools);
  });

  it('accepts separate system/rules/skills fields and the legacy systemPrompt string', async () => {
    const separate = makeAgent(mockLLM([{ content: 'ok' }]), { systemPrompt: undefined, system: 'Separate system.' });
    await separate.init();
    expect(separate.getHistory()[0]).toEqual({ role: 'system', content: 'Separate system.\n\nAlways answer briefly.' });

    const legacy = makeAgent(mockLLM([{ content: 'ok' }]), { system: 'ignored' });
    await legacy.init();
    expect(legacy.getHistory()[0].content).toBe('You are a test agent.\n\nAlways answer briefly.');

    legacy.setRules(['Be formal.']);
    expect(legacy.getHistory()[0].content).toBe('You are a test agent.\n\nBe formal.');
    expect(legacy.compileRequest().parts.rules).toBe('Be formal.');
    legacy.setSkills(undefined);
    expect(legacy.getTools()).not.toContain(LOAD_SKILL_TOOL_NAME);
  });

  it('drops the real reading once history is replaced and can calibrate the estimator from it', async () => {
    const llm = mockLLM([{ content: 'hi', usage: { promptTokens: 120, completionTokens: 3, totalTokens: 123 } }]);
    const agent = makeAgent(llm);
    await agent.init();
    expect(agent.calibrateEstimator()).toBeUndefined();

    await agent.chat('hello');
    const ratioBefore = agent.getTokenEstimator().charsPerToken;
    const ratioAfter = agent.calibrateEstimator(1)!;
    expect(ratioAfter).not.toBe(ratioBefore);
    // Calibration moves the estimate onto the provider's number (the context now also holds the reply, a few tokens more).
    const record = agent.getContextRecords()[0];
    const nextEstimate = agent.compileRequest().estimate.total;
    expect(Math.abs(nextEstimate - 120)).toBeLessThanOrEqual(12);
    expect(record.real?.promptTokens).toBe(120);

    agent.loadHistory([{ role: 'user', content: `${SUMMARY_MESSAGE_PREFIX} something` }]);
    expect(agent.getContextReal()).toBeUndefined();
    expect(agent.getContextMeterReal().total).toBe(0);
    expect(agent.estimateContext().categories.summary).toBeGreaterThan(0);
  });
});
