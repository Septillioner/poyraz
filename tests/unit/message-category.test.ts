import { describe, expect, it } from 'vitest';
import { createMessageContext } from '../../application/context/message-context.js';
import { SUMMARY_MESSAGE_PREFIX } from '../../application/context/summarizer.js';
import { createTokenEstimator } from '../../application/context/token-estimate.js';
import type { ChatMessage, ToolCall } from '../../domain/llm.js';
import { LOAD_SKILL_TOOL_NAME } from '../../tools/definitions/skills.js';

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, type: 'function', function: { name, arguments: args } };
}

describe('message categories assigned at storage', () => {
  const estimator = createTokenEstimator({ charsPerToken: 4, messageOverheadTokens: 0 });

  it('files each message under its category', () => {
    const ctx = createMessageContext({ estimator });
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: `${SUMMARY_MESSAGE_PREFIX} earlier work` },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'calling', tool_calls: [call('c1', 'read_file', { path: 'a.txt' })] },
      { role: 'tool', content: 'file body', tool_call_id: 'c1' },
      { role: 'assistant', content: 'done' },
    ];
    for (const message of messages) ctx.addMessage(message);

    expect(messages.map((m) => ctx.getMessageMeta(m).category)).toEqual([
      'system',
      'summary',
      'conversation',
      'toolCalls',
      'toolResults',
      'conversation',
    ]);
  });

  it('files load_skill results under skills, other tool results under toolResults', () => {
    const ctx = createMessageContext({ estimator });
    const loadCall: ChatMessage = {
      role: 'assistant',
      content: '',
      tool_calls: [call('s1', LOAD_SKILL_TOOL_NAME, { name: 'deploy' }), call('t1', 'grep', { pattern: 'x' })],
    };
    const skillResult: ChatMessage = { role: 'tool', content: 'SKILL BODY', tool_call_id: 's1' };
    const grepResult: ChatMessage = { role: 'tool', content: 'match', tool_call_id: 't1' };
    for (const m of [loadCall, skillResult, grepResult]) ctx.addMessage(m);

    expect(ctx.getMessageMeta(skillResult).category).toBe('skills');
    expect(ctx.getMessageMeta(grepResult).category).toBe('toolResults');
  });

  it('keeps the classification when history is replaced with setMessages', () => {
    const ctx = createMessageContext({ estimator });
    const history: ChatMessage[] = [
      { role: 'assistant', content: '', tool_calls: [call('s1', LOAD_SKILL_TOOL_NAME, { name: 'deploy' })] },
      { role: 'tool', content: 'SKILL BODY', tool_call_id: 's1' },
    ];
    ctx.setMessages(history);
    expect(ctx.getMessageEntries().map((e) => e.meta.category)).toEqual(['toolCalls', 'skills']);
  });

  it('splits an assistant tool-call message across conversation and toolCalls', () => {
    const ctx = createMessageContext({ estimator });
    const message: ChatMessage = {
      role: 'assistant',
      content: 'a'.repeat(40),
      tool_calls: [call('c1', 'edit_file', { path: 'src/x.ts', text: 'b'.repeat(100) })],
    };
    ctx.addMessage(message);
    const meta = ctx.getMessageMeta(message);
    expect(meta.category).toBe('toolCalls');
    expect(meta.chars.conversation).toBe(40);
    expect(meta.chars.toolCalls).toBeGreaterThan(100);
    expect(meta.tokens.conversation).toBe(10);
    expect(meta.tokens.toolCalls).toBe(Math.ceil((meta.chars.toolCalls ?? 0) / 4));
  });

  it('charges providerMeta only for what exceeds the text and calls it replaces', () => {
    const ctx = createMessageContext({ estimator });
    const small: ChatMessage = {
      role: 'assistant',
      content: 'x'.repeat(500),
      providerMeta: { openai: { outputItems: [{ type: 'message' }] } },
    };
    const big: ChatMessage = {
      role: 'assistant',
      content: 'hi',
      tool_calls: [call('c1', 'noop', {})],
      providerMeta: { openai: { outputItems: [{ type: 'reasoning', summary: 'r'.repeat(400) }] } },
    };
    ctx.addMessage(small);
    ctx.addMessage(big);
    expect(ctx.getMessageMeta(small).chars.providerMeta).toBeUndefined();
    expect(ctx.getMessageMeta(big).chars.providerMeta).toBeGreaterThan(300);
  });

  it('adds per-message overhead to the primary category and computes metadata for messages pushed around the API', () => {
    const ctx = createMessageContext({ estimator: createTokenEstimator({ charsPerToken: 4, messageOverheadTokens: 3 }) });
    const message: ChatMessage = { role: 'user', content: 'abcdefgh' };
    ctx.addMessage(message);
    expect(ctx.getMessageMeta(message).tokens.conversation).toBe(2 + 3);

    const sneaky: ChatMessage = { role: 'tool', content: 'abcd', tool_call_id: 'zz' };
    ctx.getMessages().push(sneaky);
    expect(ctx.getMessageEntries().at(-1)?.meta.category).toBe('toolResults');
  });

  it('keeps existing MessageContext behaviour', () => {
    const ctx = createMessageContext({ limit: 2, estimator });
    for (let i = 0; i < 6; i++) ctx.addMessage({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` });
    expect(ctx.shouldManage()).toBe(true);
    ctx.trim();
    expect(ctx.getMessages().length).toBeLessThan(6);
    expect(ctx.getMessageEntries()).toHaveLength(ctx.getMessages().length);
  });
});
