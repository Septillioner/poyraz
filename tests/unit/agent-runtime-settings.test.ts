import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent } from '../../application/agent/agent.js';
import { AgentBuilder } from '../../application/agent/agent-builder.js';
import { AgentConfigError } from '../../application/agent/config.js';
import type { ChatOptions, ChatResponse, LLMProvider } from '../../domain/llm.js';
import { defineTool } from '../../tools/core/define-tool.js';
import { mockLLM, toolCall } from '../integration/mock-llm.js';

const echo = defineTool({
  name: 'settings_echo',
  description: 'echoes',
  inputSchema: z.object({ n: z.number() }),
  execute: async (args) => ({ content: `echo:${String(args.n)}` }),
});

/** Endless distinct tool calls: only the round budget can stop the turn. */
const endlessTools = () => Array.from({ length: 30 }, (_, i) => ({ tool_calls: [toolCall(echo.name, { n: i }, `c${i}`)] }));

describe('Agent runtime settings: reasoning', () => {
  it('applies to the next turn, reads back, shows in getConfig and clears', async () => {
    const llm = mockLLM([{ content: 'ok' }]);
    const agent = new AgentBuilder().Provider(llm).Build();

    await agent.chat('a');
    expect(llm.calls[0].options.reasoning).toBeUndefined();

    agent.setReasoning({ effort: 'high' });
    expect(agent.getReasoning()).toEqual({ effort: 'high' });
    expect(agent.getConfig().reasoning).toEqual({ effort: 'high' });
    await agent.chat('b');
    expect(llm.calls[1].options.reasoning).toEqual({ effort: 'high' });

    agent.setReasoning();
    expect(agent.getReasoning()).toBeUndefined();
    expect('reasoning' in agent.getConfig() && agent.getConfig().reasoning !== undefined).toBe(false);
    await agent.chat('c');
    expect(llm.calls[2].options.reasoning).toBeUndefined();

    agent.setReasoning({});
    expect(agent.getReasoning()).toBeUndefined();
  });

  it('rejects an unknown effort with AgentConfigError and keeps the old value', () => {
    const agent = new AgentBuilder().Provider(mockLLM([{ content: 'x' }])).Reasoning({ effort: 'low' }).Build();
    expect(() => agent.setReasoning({ effort: 'extreme' as never })).toThrow(AgentConfigError);
    expect(() => agent.setReasoning({ effort: 'extreme' as never })).toThrow('Unknown reasoning effort');
    expect(agent.getReasoning()).toEqual({ effort: 'low' });
  });

  it('the builder keeps its own rule and message', () => {
    expect(() => new AgentBuilder().Reasoning({ effort: 'extreme' as never })).toThrow('Unknown reasoning effort');
  });
});

describe('Agent runtime settings: service tier', () => {
  it('applies to the next turn, reads back and clears', async () => {
    const llm = mockLLM([{ content: 'ok' }]);
    const agent = new AgentBuilder().Provider(llm).Build();

    agent.setServiceTier('priority');
    expect(agent.getServiceTier()).toBe('priority');
    expect(agent.getConfig().serviceTier).toBe('priority');
    await agent.chat('a');
    expect(llm.calls[0].options.serviceTier).toBe('priority');

    agent.setServiceTier();
    expect(agent.getServiceTier()).toBeUndefined();
    await agent.chat('b');
    expect(llm.calls[1].options.serviceTier).toBeUndefined();
  });

  it('rejects an unknown tier with AgentConfigError and keeps the old value', () => {
    const agent = new AgentBuilder().Provider(mockLLM([{ content: 'x' }])).ServiceTier('flex').Build();
    expect(() => agent.setServiceTier('turbo' as never)).toThrow(AgentConfigError);
    expect(agent.getServiceTier()).toBe('flex');
  });
});

describe('Agent runtime settings: context window', () => {
  it('feeds the meter and getConfig; floors; clears', () => {
    const agent = new AgentBuilder().Provider(mockLLM([{ content: 'x' }])).Build();
    expect(agent.getContextWindow()).toBeUndefined();
    expect(agent.getContextMeterEstimate().windowTokens).toBeNull();

    agent.setContextWindow(10_000.8);
    expect(agent.getContextWindow()).toBe(10_000);
    expect(agent.getConfig().contextWindowTokens).toBe(10_000);
    expect(agent.getContextMeterEstimate().windowTokens).toBe(10_000);

    agent.setContextWindow();
    expect(agent.getContextWindow()).toBeUndefined();
    expect(agent.getContextMeterEstimate().windowTokens).toBeNull();
  });

  it('rejects numbers the builder would ignore, and keeps the old value', () => {
    const agent = new AgentBuilder().Provider(mockLLM([{ content: 'x' }])).ContextWindow(8_000).Build();
    for (const bad of [999, 0, -1, NaN, Infinity, '8000' as never]) {
      expect(() => agent.setContextWindow(bad)).toThrow(AgentConfigError);
    }
    expect(agent.getContextWindow()).toBe(8_000);
    // the builder still ignores them silently
    expect(new AgentBuilder().ContextWindow(999).Provider(mockLLM([{ content: 'x' }])).Build().getContextWindow()).toBeUndefined();
  });

  it('turns token-based summarization on for the next turn', async () => {
    const usage = { promptTokens: 9_000, completionTokens: 1, totalTokens: 9_001 };
    const llm = mockLLM([{ content: 'ok', usage }]);
    const agent = new AgentBuilder().Provider(llm).Summarization({ enabled: true }).Build();

    await agent.chat('one');
    await agent.chat('two');
    expect(llm.calls).toHaveLength(2); // no window: no token pressure

    agent.setContextWindow(10_000);
    await agent.chat('three');
    expect(llm.calls).toHaveLength(4); // the turn, then the summary
  });
});

describe('Agent runtime settings: max tool rounds', () => {
  it('limits the next turn, reads back, shows in getConfig and falls back when cleared', async () => {
    const llm = mockLLM(endlessTools());
    const agent = new AgentBuilder().Provider(llm).RegisterTool(echo).RoutingPolicy({ maxToolRounds: 5 }).Build();
    expect(agent.getMaxToolRounds()).toBe(5);

    agent.setMaxToolRounds(2);
    expect(agent.getMaxToolRounds()).toBe(2);
    expect(agent.getConfig().maxToolRounds).toBe(2);
    await agent.chat('go');
    expect(llm.calls).toHaveLength(2);

    agent.setMaxToolRounds();
    expect(agent.getMaxToolRounds()).toBe(5);
    expect(agent.getConfig().maxToolRounds).toBeUndefined();

    expect(new AgentBuilder().Provider(mockLLM([{ content: 'x' }])).Build().getMaxToolRounds()).toBe(10);
  });

  it('floors and rejects non-positive or non-finite values, keeping the old one', () => {
    const agent = new AgentBuilder().Provider(mockLLM([{ content: 'x' }])).MaxToolRounds(7).Build();
    agent.setMaxToolRounds(3.9);
    expect(agent.getMaxToolRounds()).toBe(3);
    for (const bad of [0, -2, NaN, Infinity, '4' as never]) {
      expect(() => agent.setMaxToolRounds(bad)).toThrow(AgentConfigError);
    }
    expect(agent.getMaxToolRounds()).toBe(3);
  });
});

describe('Agent runtime settings: a running turn keeps its values', () => {
  it('changes made during a turn apply from the next one', async () => {
    const requests: ChatOptions[] = [];
    const toolRounds: ChatResponse[] = [
      ...[0, 1, 2].map((i) => ({ content: '', tool_calls: [toolCall(echo.name, { n: i }, `c${i}`)] })),
      { content: 'done' },
    ];
    let script: ChatResponse[] = [{ content: 'warm' }];
    let call = 0;
    let armed = false;
    let agent!: Agent;
    const provider: LLMProvider = {
      async chat(options) {
        requests.push({ ...options });
        if (armed) {
          armed = false;
          agent.setMaxToolRounds(1);
          agent.setReasoning({ effort: 'low' });
          agent.setServiceTier('flex');
          agent.setContextWindow(10_000);
        }
        const step = script[Math.min(call, script.length - 1)];
        call++;
        return { ...step, usage: { promptTokens: 9_000, completionTokens: 1, totalTokens: 9_001 } };
      },
    };
    agent = new AgentBuilder().Provider(provider).RegisterTool(echo).MaxToolRounds(4).Summarization({ enabled: true }).Build();

    await agent.chat('warm up'); // gives the next turn history that a summary could replace

    requests.length = 0;
    call = 0;
    script = toolRounds;
    armed = true;
    await agent.chat('first turn');
    // the turn that was running kept its round budget, reasoning, tier and (unset) window:
    // four requests, none with the new options, and no summary request at its end
    expect(requests).toHaveLength(4);
    for (const request of requests) {
      expect(request.reasoning).toBeUndefined();
      expect(request.serviceTier).toBeUndefined();
    }
    expect(agent.getMaxToolRounds()).toBe(1);
    expect(agent.getContextWindow()).toBe(10_000);

    requests.length = 0;
    call = 0;
    script = [{ content: 'plain' }];
    await agent.chat('second turn');
    expect(requests[0].reasoning).toEqual({ effort: 'low' });
    expect(requests[0].serviceTier).toBe('flex');
    expect(requests).toHaveLength(2); // the turn, then a summary: the window now applies
  });
});

describe('Agent runtime settings do not touch the caller config', () => {
  it('copies the config object', () => {
    const config = { provider: mockLLM([{ content: 'x' }]) };
    const agent = new Agent(config);
    agent.setReasoning({ effort: 'high' });
    agent.setContextWindow(5_000);
    expect('reasoning' in config).toBe(false);
    expect('contextWindowTokens' in config).toBe(false);
  });
});
