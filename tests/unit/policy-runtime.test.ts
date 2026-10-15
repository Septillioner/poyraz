import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentBuilder } from '../../application/agent/agent-builder.js';
import { DEFAULT_AGENT_POLICY, matchesAnyToolPattern, matchesToolPattern } from '../../index.js';
import { defineTool } from '../../tools/core/define-tool.js';
import { mockLLM, toolCall } from '../integration/mock-llm.js';

const step = defineTool({
  name: 'policy_step',
  description: 'does a step',
  inputSchema: z.object({ n: z.number() }),
  execute: async (args) => ({ content: `step:${String(args.n)}` }),
});
const other = defineTool({
  name: 'policy_other',
  description: 'another tool',
  inputSchema: z.object({}),
  execute: async () => ({ content: 'other' }),
});

const endless = () => Array.from({ length: 30 }, (_, i) => ({ tool_calls: [toolCall(step.name, { n: i }, `c${i}`)] }));

describe('setPolicy refreshes the tool round budget', () => {
  it('a policy with maxToolRounds sets the budget of the next turn', async () => {
    const llm = mockLLM(endless());
    const agent = new AgentBuilder().Provider(llm).RegisterTool(step).Build();
    expect(agent.getMaxToolRounds()).toBe(10);

    agent.setPolicy({ ...DEFAULT_AGENT_POLICY, maxToolRounds: 2 });
    expect(agent.getMaxToolRounds()).toBe(2);
    await agent.chat('go');
    expect(llm.calls).toHaveLength(2);
  });

  it('a policy without maxToolRounds falls back to routingPolicy, then 10', () => {
    const agent = new AgentBuilder().Provider(mockLLM([{ content: 'x' }])).RoutingPolicy({ maxToolRounds: 6 }).Build();
    agent.setPolicy({ ...DEFAULT_AGENT_POLICY, maxToolRounds: 2 });
    expect(agent.getMaxToolRounds()).toBe(2);
    agent.setPolicy({ ...DEFAULT_AGENT_POLICY });
    expect(agent.getMaxToolRounds()).toBe(6);
    expect(new AgentBuilder().Provider(mockLLM([{ content: 'x' }])).Build().getMaxToolRounds()).toBe(10);
  });

  it('the top-level setting still wins; setMaxToolRounds() hands the budget back to the policy', () => {
    const agent = new AgentBuilder().Provider(mockLLM([{ content: 'x' }])).MaxToolRounds(3).Build();
    agent.setPolicy({ ...DEFAULT_AGENT_POLICY, maxToolRounds: 2 });
    expect(agent.getMaxToolRounds()).toBe(3);
    agent.setMaxToolRounds();
    expect(agent.getMaxToolRounds()).toBe(2);
    agent.setMaxToolRounds(8);
    agent.setPolicy({ ...DEFAULT_AGENT_POLICY, maxToolRounds: 4 });
    expect(agent.getMaxToolRounds()).toBe(8);
  });

  it('a non-positive policy value counts as not set', () => {
    const agent = new AgentBuilder().Provider(mockLLM([{ content: 'x' }])).Build();
    agent.setPolicy({ ...DEFAULT_AGENT_POLICY, maxToolRounds: 0 });
    expect(agent.getMaxToolRounds()).toBe(10);
  });
});

describe('DeniedTools(...names)', () => {
  const names = (agent: { getTools(): string[] }): string[] => agent.getTools();

  const build = (configure: (b: AgentBuilder) => AgentBuilder) =>
    configure(new AgentBuilder().Provider(mockLLM([{ content: 'x' }])).RegisterTool(step).RegisterTool(other)).Build();

  it('gives the same policy as Policy({ deniedTools })', () => {
    const viaShortcut = build((b) => b.DeniedTools('policy_other'));
    const viaPolicy = build((b) => b.Policy({ deniedTools: ['policy_other'] }));
    expect(viaShortcut.getPolicy()).toEqual(viaPolicy.getPolicy());
    expect(viaShortcut.getPolicy().deniedTools).toEqual(['policy_other']);
    expect(names(viaShortcut)).toEqual(names(viaPolicy));
    expect(names(viaShortcut)).toEqual([step.name]);
  });

  it('accepts patterns, keeps the other policy fields and is replaced by a later call', () => {
    const agent = build((b) => b.ErrorBreaker('soft').DeniedTools('policy_*').DeniedTools('policy_oth*'));
    expect(agent.getPolicy().errorBreaker).toBe('soft');
    expect(agent.getPolicy().deniedTools).toEqual(['policy_oth*']);
    expect(names(agent)).toEqual([step.name]);
  });

  it('deny wins over AllowedTools; a later Policy() replaces the whole section', () => {
    const denied = build((b) => b.AllowedTools(['policy_step', 'policy_other']).DeniedTools('policy_step'));
    expect(names(denied)).toEqual([other.name]);
    const replaced = build((b) => b.DeniedTools('policy_step').Policy({}));
    expect(replaced.getPolicy().deniedTools).toBeUndefined();
  });

  it('copies the names it is given', () => {
    const names = ['policy_other'];
    const builder = new AgentBuilder().DeniedTools(...names);
    names.push('policy_step');
    expect(builder.Provider(mockLLM([{ content: 'x' }])).Build().getPolicy().deniedTools).toEqual(['policy_other']);
  });
});

describe('pattern matchers are public exports', () => {
  it('are exported from the package entry', () => {
    expect(matchesToolPattern('mcp_*', 'mcp_fs_read')).toBe(true);
    expect(matchesAnyToolPattern(['a', 'mcp_*'], 'mcp_x')).toBe(true);
    expect(matchesAnyToolPattern([], 'mcp_x')).toBe(false);
  });
});
