import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('../../infrastructure/persistence/chat-debug-log.js', () => ({
  writeChatDebugLog: vi.fn(async () => {}),
}));

import { AgentBuilder } from '../../application/agent/agent-builder.js';
import { resolveMaxToolRounds } from '../../application/agent/tool-resolver.js';
import {
  matchesAnyToolPattern,
  matchesToolPattern,
  resolvePolicyDenied,
  resolvePolicyTools,
  type AgentPolicy,
} from '../../domain/agent-policy.js';
import type { ChatMessage } from '../../domain/llm.js';
import { defineTool } from '../../tools/core/define-tool.js';
import { mockLLM, toolCall } from '../integration/mock-llm.js';

const TOOLS = ['read_file', 'edit_file', 'mcp_fs_read', 'mcp_fs_write', 'mcp_web_search', 'load_skill'];

describe('matchesToolPattern', () => {
  it('a pattern without * is an exact, case-sensitive match', () => {
    expect(matchesToolPattern('read_file', 'read_file')).toBe(true);
    expect(matchesToolPattern('read_file', 'read_files')).toBe(false);
    expect(matchesToolPattern('read_file', 'Read_File')).toBe(false);
    expect(matchesToolPattern('', '')).toBe(true);
    expect(matchesToolPattern('', 'x')).toBe(false);
  });

  it('* is a prefix, suffix or infix wildcard and matches any run of characters, including none', () => {
    expect(matchesToolPattern('mcp_*', 'mcp_fs_read')).toBe(true);
    expect(matchesToolPattern('mcp_*', 'mcp_')).toBe(true);
    expect(matchesToolPattern('mcp_*', 'xmcp_fs')).toBe(false);
    expect(matchesToolPattern('*_read', 'mcp_fs_read')).toBe(true);
    expect(matchesToolPattern('*_read', 'mcp_fs_write')).toBe(false);
    expect(matchesToolPattern('mcp_*_read', 'mcp_fs_read')).toBe(true);
    expect(matchesToolPattern('mcp_*_read', 'mcp__read')).toBe(true);
    expect(matchesToolPattern('mcp_*_read', 'mcp_read')).toBe(false);
    expect(matchesToolPattern('*', 'anything')).toBe(true);
    expect(matchesToolPattern('*', '')).toBe(true);
    expect(matchesToolPattern('a**b', 'a-x-b')).toBe(true);
  });

  it('every other character is literal, regex syntax included', () => {
    expect(matchesToolPattern('a.b*', 'a.bc')).toBe(true);
    expect(matchesToolPattern('a.b*', 'axbc')).toBe(false);
    expect(matchesToolPattern('srv(1)_*', 'srv(1)_tool')).toBe(true);
    expect(matchesToolPattern('srv[1]_*', 'srv1_tool')).toBe(false);
    expect(matchesToolPattern('srv[1]_*', 'srv[1]_tool')).toBe(true);
    expect(matchesToolPattern('a?b', 'axb')).toBe(false);
    expect(matchesToolPattern('a?b', 'a?b')).toBe(true);
    expect(matchesToolPattern('x\\*', 'x\\y')).toBe(true);
  });

  it('matchesAnyToolPattern: any entry is enough, an empty list matches nothing', () => {
    expect(matchesAnyToolPattern(['read_file', 'mcp_*'], 'mcp_x')).toBe(true);
    expect(matchesAnyToolPattern(['read_file', 'mcp_*'], 'edit_file')).toBe(false);
    expect(matchesAnyToolPattern([], 'edit_file')).toBe(false);
  });
});

describe('resolvePolicyTools / resolvePolicyDenied with patterns and deniedTools', () => {
  it("allowedTools: ['mcp_*'] allows the whole prefix, in the agent tool order", () => {
    const policy: AgentPolicy = { id: 'p', allowedTools: ['mcp_*'] };
    expect(resolvePolicyTools(TOOLS, policy)).toEqual(['mcp_fs_read', 'mcp_fs_write', 'mcp_web_search']);
    expect(resolvePolicyDenied(TOOLS, policy)).toEqual(['read_file', 'edit_file', 'load_skill']);
  });

  it('exact names and patterns mix in one list', () => {
    const policy: AgentPolicy = { id: 'p', allowedTools: ['load_skill', 'read_file', 'mcp_fs_*'] };
    expect(resolvePolicyTools(TOOLS, policy)).toEqual(['read_file', 'mcp_fs_read', 'mcp_fs_write', 'load_skill']);
  });

  it('deniedTools removes tools from an allow-list; deny wins over allow, patterns included', () => {
    const policy: AgentPolicy = { id: 'p', allowedTools: ['mcp_*', 'read_file'], deniedTools: ['mcp_*_write', 'read_file'] };
    expect(resolvePolicyTools(TOOLS, policy)).toEqual(['mcp_fs_read', 'mcp_web_search']);
    expect(resolvePolicyDenied(TOOLS, policy)).toEqual(['read_file', 'edit_file', 'mcp_fs_write', 'load_skill']);
  });

  it("allowedTools 'all' with deniedTools allows everything except the denied tools", () => {
    const policy: AgentPolicy = { id: 'p', allowedTools: 'all', deniedTools: ['mcp_*', 'edit_file'] };
    expect(resolvePolicyTools(TOOLS, policy)).toEqual(['read_file', 'load_skill']);
    expect(resolvePolicyDenied(TOOLS, policy)).toEqual(['edit_file', 'mcp_fs_read', 'mcp_fs_write', 'mcp_web_search']);
  });

  it('an unset or empty deniedTools denies nothing; deniedTools [*] denies everything', () => {
    expect(resolvePolicyTools(TOOLS, { id: 'p', allowedTools: 'all', deniedTools: [] })).toEqual(TOOLS);
    expect(resolvePolicyTools(TOOLS, { id: 'p', allowedTools: 'all' })).toEqual(TOOLS);
    expect(resolvePolicyTools(TOOLS, { id: 'p', allowedTools: 'all', deniedTools: ['*'] })).toEqual([]);
  });

  it('plain exact lists keep their old behaviour', () => {
    const policy: AgentPolicy = { id: 'p', allowedTools: ['read_file', 'not_registered'] };
    expect(resolvePolicyTools(TOOLS, policy)).toEqual(['read_file']);
  });
});

const mk = (name: string) =>
  defineTool({
    name,
    description: `tool ${name}`,
    inputSchema: z.object({ text: z.string().optional() }),
    execute: async () => ({ content: `ran:${name}` }),
  });

const names = (agent: { getTools(): Record<string, unknown> | string[] | Array<{ name?: string }> }): string[] => {
  const tools = agent.getTools() as any;
  if (Array.isArray(tools)) return tools.map((t) => (typeof t === 'string' ? t : t.name)).sort();
  return Object.keys(tools).sort();
};

describe('agent: pattern allow-list and deny list at runtime', () => {
  const tools = ['mcp_fs_read', 'mcp_fs_write', 'plain_tool'].map(mk);

  it("Policy({ allowedTools: ['mcp_*'], deniedTools: [...] }) filters what the model sees and what can run", async () => {
    const llm = mockLLM([
      { tool_calls: [toolCall('mcp_fs_write', {}, 'w1'), toolCall('mcp_fs_read', {}, 'r1'), toolCall('plain_tool', {}, 'p1')] },
      { content: 'done' },
    ]);
    let builder = new AgentBuilder().Provider(llm).MaxToolRounds(5);
    for (const tool of tools) builder = builder.RegisterTool(tool);
    const agent = builder.Policy({ allowedTools: ['mcp_*'], deniedTools: ['*_write'] }).Build();

    expect(names(agent)).toEqual(['mcp_fs_read']);
    await agent.chat('go');

    const sentTools = (llm.calls[0].options.tools ?? []).map((t: any) => t.function.name);
    expect(sentTools).toEqual(['mcp_fs_read']);
    const results = agent.getHistory().filter((m: ChatMessage) => m.role === 'tool');
    expect(results).toHaveLength(3);
    expect(results[0].content).toContain('POLICY_BLOCKED');
    expect(results[1].content).toBe('ran:mcp_fs_read');
    expect(results[2].content).toContain('POLICY_BLOCKED');
  });

  it('AllowedTools([...patterns]) works the same, and setPolicy swaps the pattern set', () => {
    let builder = new AgentBuilder().Provider(mockLLM([{ content: 'x' }]));
    for (const tool of tools) builder = builder.RegisterTool(tool);
    const agent = builder.AllowedTools(['mcp_fs_*']).Build();
    expect(names(agent)).toEqual(['mcp_fs_read', 'mcp_fs_write']);

    agent.setPolicy({ id: 'next', allowedTools: 'all', deniedTools: ['mcp_*'] });
    expect(names(agent)).toEqual(['plain_tool']);
  });
});

describe('maxToolRounds inside the policy', () => {
  const loopOnce = () => mockLLM([{ tool_calls: [toolCall('mcp_fs_read', { text: 'again' })] }]);
  const build = (configure: (b: AgentBuilder) => AgentBuilder) =>
    configure(new AgentBuilder().Provider(loopOnce()).RegisterTool(mk('mcp_fs_read'))).Build();

  it('policy.maxToolRounds wins over routingPolicy and options', async () => {
    const agent = build((b) =>
      b.Options({ max_tool_rounds: 8 }).RoutingPolicy({ maxToolRounds: 6 }).Policy({ maxToolRounds: 2 })
    );
    expect((await agent.chat('x')).content).toContain('Tool loop limit reached (2)');
  });

  it('the top-level maxToolRounds still wins over the policy', async () => {
    const agent = build((b) => b.MaxToolRounds(3).Policy({ maxToolRounds: 2 }));
    expect((await agent.chat('x')).content).toContain('Tool loop limit reached (3)');
  });

  it('without a policy value routingPolicy and options decide as before; invalid values are ignored', async () => {
    const viaRouting = build((b) => b.RoutingPolicy({ maxToolRounds: 4 }).Policy({ maxToolRounds: 0 }));
    expect((await viaRouting.chat('x')).content).toContain('Tool loop limit reached (4)');
    const viaOptions = build((b) => b.Options({ max_tool_rounds: 5 }).Policy({ id: 'only-id' }));
    expect((await viaOptions.chat('x')).content).toContain('Tool loop limit reached (5)');
  });

  it('resolveMaxToolRounds order: maxToolRounds, policy, routingPolicy, options, 10', () => {
    const base = { maxToolRounds: undefined } as any;
    expect(resolveMaxToolRounds({ ...base, policy: { maxToolRounds: 7 }, routingPolicy: { maxToolRounds: 6 }, options: { max_tool_rounds: 5 } })).toBe(7);
    expect(resolveMaxToolRounds({ ...base, maxToolRounds: 9, policy: { maxToolRounds: 7 } })).toBe(9);
    expect(resolveMaxToolRounds({ ...base, routingPolicy: { maxToolRounds: 6 } })).toBe(6);
    expect(resolveMaxToolRounds({ ...base, policy: {} })).toBe(10);
    expect(resolveMaxToolRounds({ ...base, policy: { maxToolRounds: 2.9 } })).toBe(2);
  });
});
