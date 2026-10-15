import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('../../infrastructure/persistence/chat-debug-log.js', () => ({
  writeChatDebugLog: vi.fn(async () => {}),
}));

import { AgentBuilder } from '../../application/agent/agent-builder.js';
import { isToolResultLimitActive, limitToolResult } from '../../application/chat/tool-result-limit.js';
import { defineTool } from '../../tools/core/define-tool.js';
import { mockLLM, toolCall } from '../integration/mock-llm.js';

const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

describe('limitToolResult', () => {
  it('returns the content untouched without a limit or within it', () => {
    const text = 'x'.repeat(1000);
    expect(limitToolResult(text)).toEqual({ content: text });
    expect(limitToolResult(text, {})).toEqual({ content: text });
    expect(limitToolResult(text, { maxChars: 1000 }).content).toBe(text);
    expect(limitToolResult(text, { maxBytes: 1000 }).content).toBe(text);
    // unusable values mean "no limit", not "cut everything"
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      expect(limitToolResult(text, { maxChars: bad as number, maxBytes: bad as number }).content).toBe(text);
    }
    expect(isToolResultLimitActive({ maxChars: 0 })).toBe(false);
    expect(isToolResultLimitActive({ maxBytes: 10 })).toBe(true);
  });

  it('cuts to maxChars, keeps the start, and appends a truncated note that counts against the limit', () => {
    const text = `HEAD${'x'.repeat(5000)}`;
    const result = limitToolResult(text, { maxChars: 300 });
    expect(result.content.length).toBeLessThanOrEqual(300);
    expect(result.content.startsWith('HEAD')).toBe(true);
    expect(result.content).toContain('[truncated');
    expect(result.content).toContain('5004 characters');
    expect(result.truncation).toMatchObject({ originalChars: 5004, originalBytes: 5004 });
    expect(result.truncation!.keptChars).toBe(result.content.indexOf('\n[truncated'));
  });

  it('cuts to maxBytes on a character boundary (multi-byte and surrogate pairs stay whole)', () => {
    const text = 'çğış😀'.repeat(400);
    const result = limitToolResult(text, { maxBytes: 400 });
    expect(bytes(result.content)).toBeLessThanOrEqual(400);
    expect(result.content).toContain('[truncated');
    expect(result.content).not.toContain('\uFFFD');
    const kept = result.content.slice(0, result.content.indexOf('\n[truncated'));
    expect(text.startsWith(kept)).toBe(true);
    expect(result.truncation!.originalBytes).toBe(bytes(text));
    expect(result.truncation!.keptBytes).toBe(bytes(kept));
  });

  it('applies both limits when both are set', () => {
    const text = 'a'.repeat(2000);
    const result = limitToolResult(text, { maxChars: 1500, maxBytes: 200 });
    expect(bytes(result.content)).toBeLessThanOrEqual(200);
    expect(limitToolResult(text, { maxChars: 150, maxBytes: 1900 }).content.length).toBeLessThanOrEqual(150);
  });

  it('a limit smaller than the note leaves only the note', () => {
    const result = limitToolResult('x'.repeat(100), { maxChars: 5 });
    expect(result.content.startsWith('\n[truncated')).toBe(true);
    expect(result.truncation!.keptChars).toBe(0);
  });
});

describe('toolResultMaxChars / toolResultMaxBytes in an agent', () => {
  const big = defineTool({
    name: 'limit_test_big',
    description: 'returns a long text',
    inputSchema: z.object({}),
    execute: async () => ({ content: `START${'y'.repeat(4000)}` }),
  });

  async function toolMessageSeenByModel(configure: (builder: AgentBuilder) => AgentBuilder): Promise<string> {
    const llm = mockLLM([{ tool_calls: [toolCall(big.name, {})] }, { content: 'done' }]);
    const agent = configure(new AgentBuilder().Provider(llm).RegisterTool(big).Policy({ allowedTools: undefined })).Build();
    await agent.init();
    await agent.chat('go');
    expect(llm.calls).toHaveLength(2);
    return llm.calls[1].messages.find((m) => m.role === 'tool')!.content;
  }

  it('is off by default: the result reaches the model as the tool returned it', async () => {
    const content = await toolMessageSeenByModel((b) => b);
    expect(content).toBe(`START${'y'.repeat(4000)}`);
  });

  it('cuts the result for the model and says so', async () => {
    const content = await toolMessageSeenByModel((b) => b.ToolResultMaxChars(500));
    expect(content.length).toBeLessThanOrEqual(500);
    expect(content.startsWith('START')).toBe(true);
    expect(content).toContain('[truncated');
  });

  it('maxBytes works the same way, and FromJSON reads both fields', async () => {
    const content = await toolMessageSeenByModel((b) => b.ToolResultMaxBytes(400));
    expect(bytes(content)).toBeLessThanOrEqual(400);
    expect(content).toContain('[truncated');

    const fromJson = new AgentBuilder().FromJSON({ name: 'n', toolResultMaxChars: 123.9, toolResultMaxBytes: 456 } as any);
    const config = fromJson.Provider(mockLLM([{ content: 'x' }])).Build().getConfig();
    expect(config.toolResultMaxChars).toBe(123);
    expect(config.toolResultMaxBytes).toBe(456);
  });

  it('a result within the limit is not touched', async () => {
    const content = await toolMessageSeenByModel((b) => b.ToolResultMaxChars(100_000));
    expect(content).toBe(`START${'y'.repeat(4000)}`);
  });

  it('ignores invalid values like every other builder number', () => {
    const config = new AgentBuilder().ToolResultMaxChars(0).ToolResultMaxBytes(-1).Provider(mockLLM([{ content: 'x' }])).Build().getConfig();
    expect(config.toolResultMaxChars).toBeUndefined();
    expect(config.toolResultMaxBytes).toBeUndefined();
  });
});
