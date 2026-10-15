import { describe, expect, it, vi } from 'vitest';
import {
  applyContextManagement,
  summarizeHistory,
  SUMMARY_MESSAGE_PREFIX,
} from '../../application/context/summarizer.js';
import { createMessageContext } from '../../application/context/message-context.js';
import {
  buildSummaryPrompt,
  DEFAULT_KEEP_RATIO,
  DEFAULT_SUMMARY_MESSAGE_PREFIX,
  DEFAULT_SUMMARY_PROMPT,
  DEFAULT_SUMMARY_THRESHOLD_RATIO,
  isSummaryMessage,
  normalizeKeepRatio,
  normalizeSummaryThreshold,
  resolveSummaryPrefix,
} from '../../application/context/summary-settings.js';
import type { ChatMessage } from '../../domain/llm.js';
import { mockLLM, toolCall } from '../integration/mock-llm.js';

function fill(count: number, limit?: number) {
  const ctx = createMessageContext({ limit });
  for (let i = 0; i < count; i++) ctx.addMessage({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` });
  return ctx;
}

describe('summarization defaults are neutral and have one source', () => {
  it('default prompt and prefix are plain ASCII English, the old constant is the default prefix', () => {
    expect(DEFAULT_SUMMARY_PROMPT).not.toMatch(/[^\x00-\x7F]/);
    expect(DEFAULT_SUMMARY_MESSAGE_PREFIX).not.toMatch(/[^\x00-\x7F]/);
    expect(SUMMARY_MESSAGE_PREFIX).toBe(DEFAULT_SUMMARY_MESSAGE_PREFIX);
    expect(DEFAULT_SUMMARY_PROMPT).toContain('{{conversation}}');
  });

  it('threshold: default 0.8, clamped to 0.5..0.95; keep ratio: default 0.6, clamped to 0.1..0.9', () => {
    expect(DEFAULT_SUMMARY_THRESHOLD_RATIO).toBe(0.8);
    expect(normalizeSummaryThreshold(undefined)).toBe(0.8);
    expect(normalizeSummaryThreshold(Number.NaN)).toBe(0.8);
    expect(normalizeSummaryThreshold(0.1)).toBe(0.5);
    expect(normalizeSummaryThreshold(2)).toBe(0.95);
    expect(normalizeSummaryThreshold(0.7)).toBe(0.7);
    expect(DEFAULT_KEEP_RATIO).toBe(0.6);
    expect(normalizeKeepRatio(undefined)).toBe(0.6);
    expect(normalizeKeepRatio(Number.POSITIVE_INFINITY)).toBe(0.6);
    expect(normalizeKeepRatio(0)).toBe(0.1);
    expect(normalizeKeepRatio(5)).toBe(0.9);
    expect(normalizeKeepRatio(0.3)).toBe(0.3);
  });
});

describe('summary prefix and detection', () => {
  it('blank prefix falls back to the default', () => {
    expect(resolveSummaryPrefix(undefined)).toBe(DEFAULT_SUMMARY_MESSAGE_PREFIX);
    expect(resolveSummaryPrefix('   ')).toBe(DEFAULT_SUMMARY_MESSAGE_PREFIX);
    expect(resolveSummaryPrefix(' RECAP: ')).toBe('RECAP:');
  });

  it('isSummaryMessage follows the configured prefix and only matches user messages', () => {
    const custom: ChatMessage = { role: 'user', content: 'RECAP: earlier' };
    const dflt: ChatMessage = { role: 'user', content: `${DEFAULT_SUMMARY_MESSAGE_PREFIX} earlier` };
    expect(isSummaryMessage(custom, 'RECAP:')).toBe(true);
    expect(isSummaryMessage(custom)).toBe(false);
    expect(isSummaryMessage(dflt)).toBe(true);
    expect(isSummaryMessage(dflt, 'RECAP:')).toBe(false);
    expect(isSummaryMessage({ role: 'assistant', content: 'RECAP: x' }, 'RECAP:')).toBe(false);
  });
});

describe('buildSummaryPrompt', () => {
  it('replaces the placeholder (literally, no replacement patterns)', () => {
    expect(buildSummaryPrompt('A $& B', 'Condense:\n{{conversation}}\nEnd')).toBe('Condense:\nA $& B\nEnd');
  });

  it('appends the conversation when the string has no placeholder', () => {
    expect(buildSummaryPrompt('chat', 'Shorten this.')).toBe('Shorten this.\n\nchat');
  });

  it('calls a builder with the conversation', () => {
    expect(buildSummaryPrompt('chat', (conversation) => `>> ${conversation} <<`)).toBe('>> chat <<');
  });

  it('uses the default prompt when omitted or blank', () => {
    expect(buildSummaryPrompt('chat')).toBe(DEFAULT_SUMMARY_PROMPT.replace('{{conversation}}', 'chat'));
    expect(buildSummaryPrompt('chat', '  ')).toBe(buildSummaryPrompt('chat'));
  });
});

describe('summarizeHistory options', () => {
  it('sends the custom prompt, truncates tool results, stores the custom prefix and keeps the tail', async () => {
    const ctx = createMessageContext({ limit: 10 });
    ctx.addMessage({ role: 'user', content: 'first question' });
    ctx.addMessage({ role: 'assistant', content: '', tool_calls: [toolCall('grep', { q: 'x' }, 'c1')] });
    ctx.addMessage({ role: 'tool', content: 'T'.repeat(500), tool_call_id: 'c1' });
    for (let i = 0; i < 9; i++) ctx.addMessage({ role: i % 2 ? 'assistant' : 'user', content: `tail${i}` });
    const llm = mockLLM([{ content: 'the gist' }]);

    await summarizeHistory(ctx, llm, 'm', undefined, undefined, {
      prompt: 'Condense:\n{{conversation}}\nEnd.',
      prefix: 'RECAP>',
      keepRatio: 0.3,
      toolResultMaxChars: 20,
    });

    const sent = llm.calls[0].messages[0].content as string;
    expect(sent.startsWith('Condense:\n')).toBe(true);
    expect(sent.endsWith('\nEnd.')).toBe(true);
    expect(sent).toContain('[user] first question');
    expect(sent).toContain(`[tool] ${'T'.repeat(20)}`);
    expect(sent).not.toContain('T'.repeat(21));

    const messages = ctx.getMessages();
    expect(messages[0]).toEqual({ role: 'user', content: 'RECAP> the gist' });
    // keepRatio 0.3 of limit 10 -> the last 3 conversation turns stay verbatim
    expect(messages).toHaveLength(4);
    expect(isSummaryMessage(messages[0], 'RECAP>')).toBe(true);
  });

  it('keepRatio changes how much of the tail stays; the default is 0.6', async () => {
    const run = async (keepRatio?: number) => {
      const ctx = fill(12, 10);
      await summarizeHistory(ctx, mockLLM([{ content: 's' }]), 'm', undefined, undefined, { keepRatio });
      return ctx.getMessages().length;
    };
    expect(await run(undefined)).toBe(1 + 6);
    expect(await run(0.3)).toBe(1 + 3);
    expect(await run(0.9)).toBe(1 + 9);
  });

  it('a previous summary with the custom prefix goes into the next summary input as is', async () => {
    const ctx = createMessageContext({ limit: 4 });
    ctx.addMessage({ role: 'user', content: 'RECAP> old gist' });
    for (let i = 0; i < 6; i++) ctx.addMessage({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` });
    const llm = mockLLM([{ content: 'new gist' }]);
    await summarizeHistory(ctx, llm, 'm', undefined, undefined, { prefix: 'RECAP>' });
    expect(llm.calls[0].messages[0].content).toContain('RECAP> old gist');
    expect(llm.calls[0].messages[0].content).not.toContain('[user] RECAP> old gist');
  });

  it('with no options it uses the neutral defaults', async () => {
    const ctx = fill(12, 10);
    const llm = mockLLM([{ content: 's' }]);
    await summarizeHistory(ctx, llm, 'm');
    expect(llm.calls[0].messages[0].content).toContain(DEFAULT_SUMMARY_PROMPT.split('\n\n')[0]);
    expect(ctx.getMessages()[0].content).toBe(`${DEFAULT_SUMMARY_MESSAGE_PREFIX} s`);
  });

  it('falls back to trimming when the summary request fails', async () => {
    const ctx = fill(12, 10);
    const provider = { chat: vi.fn(async () => { throw new Error('boom'); }) };
    await summarizeHistory(ctx, provider as any, 'm');
    expect(ctx.getMessages().some((m) => isSummaryMessage(m))).toBe(false);
    expect(ctx.getMessages().length).toBeLessThan(12);
  });
});

describe('applyContextManagement', () => {
  const pressure = { promptTokens: 9_000, contextWindowTokens: 10_000 };

  it('with autoSummary off nothing is ever summarized, not even under token pressure', async () => {
    const summarize = vi.fn(async () => {});
    await applyContextManagement(fill(40), false, undefined, summarize, pressure);
    await applyContextManagement(fill(40, 10), false, undefined, summarize, pressure);
    expect(summarize).not.toHaveBeenCalled();
  });

  it('with autoSummary off the turn limit still trims', async () => {
    const ctx = fill(12, 10);
    await applyContextManagement(ctx, false, undefined, async () => {}, pressure);
    expect(ctx.getMessages().length).toBeLessThan(12);
  });

  it('with autoSummary on token pressure or the turn limit summarizes', async () => {
    const summarize = vi.fn(async () => {});
    await applyContextManagement(fill(4), true, undefined, summarize, pressure);
    expect(summarize).toHaveBeenCalledTimes(1);
    await applyContextManagement(fill(12, 10), true, undefined, summarize);
    expect(summarize).toHaveBeenCalledTimes(2);
    await applyContextManagement(fill(4, 10), true, undefined, summarize, { promptTokens: 100, contextWindowTokens: 10_000 });
    expect(summarize).toHaveBeenCalledTimes(2);
  });
});

describe('message context options', () => {
  it('keepRatio on the context drives trim and the summary cut; the call argument wins', () => {
    const trimmed = createMessageContext({ limit: 10, keepRatio: 0.3 });
    for (let i = 0; i < 12; i++) trimmed.addMessage({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` });
    trimmed.trim();
    expect(trimmed.getMessages()).toHaveLength(3);

    const ctx = fill(12, 10);
    expect(ctx.getMessagesToSummarize().keepIndex).toBe(6);
    expect(ctx.getMessagesToSummarize(0.3).keepIndex).toBe(9);
    expect(createMessageContext({ limit: 10, keepRatio: 0.3 }).getMessagesToSummarize().toSummarize).toEqual([]);
  });

  it('summaryPrefix and skillToolName decide the meter categories', () => {
    const ctx = createMessageContext({ summaryPrefix: 'RECAP>', skillToolName: 'skills_load' });
    const summary: ChatMessage = { role: 'user', content: 'RECAP> before' };
    const legacy: ChatMessage = { role: 'user', content: `${DEFAULT_SUMMARY_MESSAGE_PREFIX} before` };
    const call: ChatMessage = {
      role: 'assistant',
      content: '',
      tool_calls: [toolCall('skills_load', { name: 'a' }, 's1'), toolCall('load_skill', { name: 'a' }, 's2')],
    };
    const custom: ChatMessage = { role: 'tool', content: 'BODY', tool_call_id: 's1' };
    const other: ChatMessage = { role: 'tool', content: 'BODY', tool_call_id: 's2' };
    for (const m of [summary, legacy, call, custom, other]) ctx.addMessage(m);
    expect(ctx.getMessageMeta(summary).category).toBe('summary');
    expect(ctx.getMessageMeta(legacy).category).toBe('conversation');
    expect(ctx.getMessageMeta(custom).category).toBe('skills');
    expect(ctx.getMessageMeta(other).category).toBe('toolResults');
  });
});
