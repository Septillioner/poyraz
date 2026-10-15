import { describe, expect, it, vi } from 'vitest';

vi.mock('../../infrastructure/persistence/chat-debug-log.js', () => ({
  writeChatDebugLog: vi.fn(async () => {}),
}));

import { AgentBuilder } from '../../application/agent/agent-builder.js';
import type { SummarizedContext } from '../../application/agent/config.js';
import { createMessageContext } from '../../application/context/message-context.js';
import { summarizeHistory } from '../../application/context/summarizer.js';
import { DEFAULT_SUMMARY_MESSAGE_PREFIX } from '../../application/context/summary-settings.js';
import type { ChatMessage } from '../../domain/llm.js';
import { mockLLM } from '../integration/mock-llm.js';

/** A system message, then `turns` long user/assistant messages: enough for a real summary to shrink them. */
function longContext(turns = 12) {
  const ctx = createMessageContext({ limit: 10 });
  ctx.addMessage({ role: 'system', content: 'be brief' });
  for (let i = 0; i < turns; i++) {
    ctx.addMessage({ role: i % 2 ? 'assistant' : 'user', content: `message ${i} ${'lorem ipsum '.repeat(40)}` });
  }
  return ctx;
}

const OPTIONS = { keepRatio: 0.3 };

describe('summarization onSummarized hook', () => {
  it('is off by default: no hook, the summary message is exactly prefix + summary', async () => {
    const ctx = longContext();
    await summarizeHistory(ctx, mockLLM([{ content: 'the gist' }]), 'm', undefined, undefined, OPTIONS);
    const messages = ctx.getMessages();
    expect(messages[0].role).toBe('system');
    expect(messages[1]).toEqual({ role: 'user', content: `${DEFAULT_SUMMARY_MESSAGE_PREFIX} the gist` });
  });

  it('receives the summary, counts, token estimates before / after and a snapshot of the new history', async () => {
    const ctx = longContext();
    const total = ctx.getMessages().length;
    const seen: SummarizedContext[] = [];
    await summarizeHistory(ctx, mockLLM([{ content: 'the gist' }]), 'm', undefined, undefined, {
      ...OPTIONS,
      prefix: 'RECAP>',
      onSummarized: (summarized) => {
        seen.push(summarized);
      },
    });

    expect(seen).toHaveLength(1);
    const info = seen[0];
    expect(info.summary).toBe('the gist');
    expect(info.prefix).toBe('RECAP>');
    expect(info.summarizedMessages).toBeGreaterThan(0);
    expect(info.keptMessages).toBeGreaterThan(0);
    // system message + summarized + kept == the old history
    expect(1 + info.summarizedMessages + info.keptMessages).toBe(total);
    expect(info.tokensBefore).toBeGreaterThan(info.tokensAfter);
    expect(info.tokensAfter).toBeGreaterThan(0);
    // snapshot of the history after the summary: system, summary, kept tail
    expect(info.messages).toHaveLength(2 + info.keptMessages);
    expect(info.messages[0].role).toBe('system');
    expect(info.messages[1]).toEqual({ role: 'user', content: 'RECAP> the gist' });
    expect(info.messages).toEqual(ctx.getMessages());
    expect(info.sessionId).toBeUndefined();
  });

  it('the returned text is appended to the end of the summary message after a newline', async () => {
    const ctx = longContext();
    await summarizeHistory(ctx, mockLLM([{ content: 'the gist' }]), 'm', undefined, undefined, {
      ...OPTIONS,
      onSummarized: async ({ summarizedMessages }) => `  Pinned: ${summarizedMessages} messages were folded.  `,
    });
    const summary = ctx.getMessages()[1];
    expect(summary.role).toBe('user');
    expect(summary.content).toMatch(new RegExp(`^${DEFAULT_SUMMARY_MESSAGE_PREFIX} the gist\\nPinned: \\d+ messages were folded\\.$`));
  });

  it.each([undefined, null, '', '   \n', 42])('a non-text or blank result (%j) adds nothing', async (result) => {
    const ctx = longContext();
    await summarizeHistory(ctx, mockLLM([{ content: 'the gist' }]), 'm', undefined, undefined, {
      ...OPTIONS,
      onSummarized: () => result as unknown as string,
    });
    expect(ctx.getMessages()[1].content).toBe(`${DEFAULT_SUMMARY_MESSAGE_PREFIX} the gist`);
  });

  it('a throwing hook is ignored: the summary is kept and the history is valid', async () => {
    for (const hook of [
      () => {
        throw new Error('boom');
      },
      async () => {
        throw new Error('async boom');
      },
    ]) {
      const ctx = longContext();
      await expect(
        summarizeHistory(ctx, mockLLM([{ content: 'the gist' }]), 'm', undefined, undefined, { ...OPTIONS, onSummarized: hook })
      ).resolves.toBeUndefined();
      const messages: ChatMessage[] = ctx.getMessages();
      expect(messages[1].content).toBe(`${DEFAULT_SUMMARY_MESSAGE_PREFIX} the gist`);
    }
  });

  it('is not called when there is nothing to summarize', async () => {
    const ctx = createMessageContext({ limit: 10 });
    // exactly the kept tail (default keep ratio 0.6 of limit 10 = 6 turns): nothing is left to fold
    for (let i = 0; i < 6; i++) ctx.addMessage({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` });
    const hook = vi.fn();
    await summarizeHistory(ctx, mockLLM([{ content: 'x' }]), 'm', undefined, undefined, { onSummarized: hook });
    expect(hook).not.toHaveBeenCalled();
  });

  it('is not called when the summary request fails (the existing fallback trims the history)', async () => {
    const ctx = longContext();
    const hook = vi.fn();
    const failing = {
      async chat(): Promise<never> {
        throw new Error('provider down');
      },
    };
    await summarizeHistory(ctx, failing as any, 'm', undefined, undefined, { ...OPTIONS, onSummarized: hook });
    expect(hook).not.toHaveBeenCalled();
    expect(ctx.getMessages().some((m) => typeof m.content === 'string' && m.content.startsWith(DEFAULT_SUMMARY_MESSAGE_PREFIX))).toBe(false);
  });
});

describe('agent: OnSummarized / summarization.onSummarized', () => {
  const history = (): ChatMessage[] =>
    Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 ? ('assistant' as const) : ('user' as const),
      content: `message ${i} ${'lorem ipsum '.repeat(40)}`,
    }));

  it('summarize() runs the hook with the session id and appends its text to the summary', async () => {
    const hook = vi.fn(async (summarized: SummarizedContext) => `Open files: ${summarized.summarizedMessages}`);
    const agent = new AgentBuilder()
      .Provider(mockLLM([{ content: 'the gist' }]))
      .ContextLimit(10)
      .Summarization({ keepRatio: 0.3 })
      .OnSummarized(hook)
      .Build();
    agent.setSessionId('s-1');
    agent.loadHistory(history());

    await agent.summarize();

    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0][0].sessionId).toBe('s-1');
    expect(hook.mock.calls[0][0].summary).toBe('the gist');
    const summary = agent.getHistory().find((m) => m.content.startsWith(DEFAULT_SUMMARY_MESSAGE_PREFIX));
    expect(summary?.content).toMatch(/the gist\nOpen files: \d+$/);
  });

  it('the hook does not enable summarization by itself, and OnSummarized() clears it', async () => {
    const hook = vi.fn();
    const agent = new AgentBuilder().Provider(mockLLM([{ content: 'ok' }])).OnSummarized(hook).Build();
    expect(agent.getConfig().summarization?.enabled).toBeUndefined();
    const cleared = new AgentBuilder().Provider(mockLLM([{ content: 'ok' }])).OnSummarized(hook).OnSummarized().Build();
    expect(cleared.getConfig().summarization).toBeUndefined();
  });
});

describe('summarizing a history shorter than the kept tail', () => {
  it.each([0, 1, 2, 5])('%i conversation message(s): nothing to summarize, no throw, no hook, history untouched', async (count) => {
    const ctx = createMessageContext({ limit: 10 });
    for (let i = 0; i < count; i++) ctx.addMessage({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` });
    const before = ctx.getMessages().map((m) => m.content);
    const hook = vi.fn();
    const llm = mockLLM([{ content: 'x' }]);

    expect(ctx.getMessagesToSummarize().toSummarize).toEqual([]);
    await expect(summarizeHistory(ctx, llm, 'm', undefined, undefined, { onSummarized: hook })).resolves.toBeUndefined();

    expect(hook).not.toHaveBeenCalled();
    expect(llm.calls).toHaveLength(0);
    expect(ctx.getMessages().map((m) => m.content)).toEqual(before);
  });

  it('the same with a pinned system message, and with a limit-less context', async () => {
    const pinned = createMessageContext({ limit: 10 });
    pinned.addMessage({ role: 'system', content: 'sys' });
    pinned.addMessage({ role: 'user', content: 'hi' });
    pinned.addMessage({ role: 'assistant', content: 'hello' });
    expect(pinned.getMessagesToSummarize()).toEqual({ toSummarize: [], keepIndex: 1 });
    await summarizeHistory(pinned, mockLLM([{ content: 'x' }]), 'm');
    expect(pinned.getMessages()).toHaveLength(3);

    const unlimited = createMessageContext({});
    unlimited.addMessage({ role: 'user', content: 'hi' });
    unlimited.addMessage({ role: 'assistant', content: 'hello' });
    await expect(summarizeHistory(unlimited, mockLLM([{ content: 'x' }]), 'm')).resolves.toBeUndefined();
  });

  it('trim() on a short history is a no-op', () => {
    const ctx = createMessageContext({ limit: 10 });
    ctx.addMessage({ role: 'user', content: 'hi' });
    ctx.addMessage({ role: 'assistant', content: 'hello' });
    ctx.trim();
    expect(ctx.getMessages()).toHaveLength(2);
  });

  it('agent.summarize() on a two-message history resolves and leaves the history alone', async () => {
    const hook = vi.fn();
    const agent = new AgentBuilder()
      .Provider(mockLLM([{ content: 'x' }]))
      .ContextLimit(10)
      .OnSummarized(hook)
      .Build();
    agent.loadHistory([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
    await expect(agent.summarize()).resolves.toBeUndefined();
    expect(hook).not.toHaveBeenCalled();
    expect(agent.getHistory().map((m) => m.content)).toEqual(['hi', 'hello']);
  });
});
