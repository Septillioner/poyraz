import { describe, expect, it } from 'vitest';
import {
  buildMeter,
  completeRecord,
  computeDrift,
  estimateRequest,
  realSnapshot,
  scaleCategoriesToTotal,
} from '../../application/context/context-report.js';
import { createMessageContext } from '../../application/context/message-context.js';
import { buildSystemPrompt } from '../../application/prompt/system-prompt.js';
import { createTokenEstimator } from '../../application/context/token-estimate.js';
import {
  CONTEXT_CATEGORIES,
  emptyCategoryTokens,
  type ContextCategoryTokens,
  type ContextRequestRecord,
} from '../../domain/context.js';

const estimator = createTokenEstimator({ charsPerToken: 4, messageOverheadTokens: 0 });

function sum(categories: ContextCategoryTokens): number {
  return CONTEXT_CATEGORIES.reduce((acc, key) => acc + categories[key], 0);
}

describe('buildSystemPrompt parts', () => {
  it('exposes system, rules and skills separately while content stays system + rules', () => {
    const built = buildSystemPrompt('  be brief ', ['rule one', '', ' rule two '], [
      { name: 'deploy', description: 'ship it', content: 'steps' },
    ]);
    expect(built.content).toBe('be brief\n\nrule one\n\nrule two');
    expect(built.parts).toEqual({
      system: 'be brief',
      rules: 'rule one\n\nrule two',
      skills: 'deploy: ship it',
    });
  });

  it('stays backward compatible with the two-argument call', () => {
    const built = buildSystemPrompt('only system');
    expect(built.content).toBe('only system');
    expect(built.parts.rules).toBe('');
    expect(built.parts.skills).toBe('');
  });
});

describe('estimateRequest', () => {
  it('counts messages per category, splits system from rules and adds tool schemas', () => {
    const built = buildSystemPrompt('s'.repeat(40), ['r'.repeat(20)]);
    const ctx = createMessageContext({ estimator });
    ctx.addMessage({ role: 'system', content: built.content });
    ctx.addMessage({ role: 'user', content: 'u'.repeat(80) });
    ctx.addMessage({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: { a: 'b' } } }],
    });
    ctx.addMessage({ role: 'tool', content: 't'.repeat(400), tool_call_id: 'c1' });

    const estimate = estimateRequest({
      entries: ctx.getMessageEntries(),
      toolSchemas: [
        { name: 'read_file', category: 'tools', chars: 200 },
        { name: 'mcp__srv__q', category: 'mcp', chars: 80 },
        { name: 'load_skill', category: 'skills', chars: 40 },
      ],
      systemPrompt: built,
      estimator,
    });

    // 62 chars in the message: 20 are rules, the other 42 (text + blank-line separator) stay system.
    expect(estimate.categories.system).toBe(11);
    expect(estimate.categories.rules).toBe(5);
    expect(estimate.categories.conversation).toBe(20);
    expect(estimate.categories.toolResults).toBe(100);
    expect(estimate.categories.toolCalls).toBeGreaterThan(0);
    expect(estimate.categories.tools).toBe(50);
    expect(estimate.categories.mcp).toBe(20);
    expect(estimate.categories.skills).toBe(10);
    expect(estimate.total).toBe(sum(estimate.categories));
    expect(estimate.chars).toBeGreaterThan(estimate.total);
  });

  it('treats a system message that differs from the built prompt as plain system', () => {
    const built = buildSystemPrompt('a', ['b']);
    const ctx = createMessageContext({ estimator });
    ctx.addMessage({ role: 'system', content: 'z'.repeat(40) });
    const estimate = estimateRequest({ entries: ctx.getMessageEntries(), toolSchemas: [], systemPrompt: built, estimator });
    expect(estimate.categories.system).toBe(10);
    expect(estimate.categories.rules).toBe(0);
  });

  it('applies a recalibrated ratio to messages that are already stored', () => {
    const ctx = createMessageContext({ estimator: createTokenEstimator({ charsPerToken: 4, messageOverheadTokens: 0 }) });
    ctx.addMessage({ role: 'user', content: 'u'.repeat(400) });
    const live = createTokenEstimator({ charsPerToken: 4, messageOverheadTokens: 0 });
    const before = estimateRequest({ entries: ctx.getMessageEntries(), toolSchemas: [], estimator: live });
    live.calibrate({ chars: 400, realTokens: 200 }, 1);
    const after = estimateRequest({ entries: ctx.getMessageEntries(), toolSchemas: [], estimator: live });
    expect(before.total).toBe(100);
    expect(after.total).toBe(200);
  });

  it('includes tool call arguments and provider replay payload', () => {
    const ctx = createMessageContext({ estimator });
    ctx.addMessage({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: { text: 'q'.repeat(400) } } }],
      providerMeta: { openai: { outputItems: [{ type: 'reasoning', text: 'w'.repeat(800) }] } },
    });
    const estimate = estimateRequest({ entries: ctx.getMessageEntries(), toolSchemas: [], estimator });
    expect(estimate.categories.toolCalls).toBeGreaterThan(100);
    expect(estimate.categories.providerMeta).toBeGreaterThan(100);
  });
});

describe('real breakdown matches the provider total', () => {
  it('scales category shares to exactly the target with largest-remainder rounding', () => {
    const shares = { ...emptyCategoryTokens(), system: 10, tools: 10, conversation: 10 };
    const scaled = scaleCategoriesToTotal(shares, 100);
    expect(sum(scaled)).toBe(100);
    expect(scaled.rules).toBe(0);
    expect(Math.max(scaled.system, scaled.tools, scaled.conversation)).toBe(34);
  });

  it('puts the whole target in conversation when nothing was estimated and returns zeros for 0', () => {
    expect(scaleCategoriesToTotal(emptyCategoryTokens(), 42).conversation).toBe(42);
    expect(sum(scaleCategoriesToTotal({ ...emptyCategoryTokens(), system: 5 }, 0))).toBe(0);
    expect(sum(scaleCategoriesToTotal({ ...emptyCategoryTokens(), system: 5 }, Number.NaN))).toBe(0);
  });

  it('always sums to the target for awkward shares', () => {
    for (const target of [1, 7, 99, 1234, 100000]) {
      const shares = { ...emptyCategoryTokens(), system: 3, rules: 1, mcp: 7, toolResults: 13, conversation: 2 };
      expect(sum(scaleCategoriesToTotal(shares, target))).toBe(target);
    }
  });

  it('pairs estimate and real, reports drift and a snapshot whose parts equal promptTokens', () => {
    const estimate = {
      categories: { ...emptyCategoryTokens(), system: 100, mcp: 300, conversation: 600 },
      total: 1000,
      chars: 3500,
      overheadTokens: 0,
    };
    const pending: ContextRequestRecord = { seq: 1, at: 1, model: 'm', estimate };
    expect(realSnapshot(pending)).toBeUndefined();

    const done = completeRecord(pending, { promptTokens: 800, completionTokens: 5, totalTokens: 805 });
    expect(done.drift).toEqual({ tokens: 200, ratio: 1.25, percent: 25 });

    const snapshot = realSnapshot(done)!;
    expect(snapshot.total).toBe(800);
    expect(sum(snapshot.categories)).toBe(800);
    expect(snapshot.categories).toMatchObject({ system: 80, mcp: 240, conversation: 480 });
    expect(snapshot.estimate.total).toBe(1000);
    expect(snapshot.drift.tokens).toBe(200);
  });

  it('handles drift against a zero real total', () => {
    expect(computeDrift(10, 0)).toEqual({ tokens: 10, ratio: null, percent: null });
    expect(computeDrift(90, 100).percent).toBe(-10);
  });
});

describe('buildMeter', () => {
  it('computes percent against the window and tolerates a missing one', () => {
    const categories = { ...emptyCategoryTokens(), conversation: 250 };
    expect(buildMeter('estimate', categories, 250, 1000)).toMatchObject({
      source: 'estimate',
      total: 250,
      windowTokens: 1000,
      percent: 25,
    });
    expect(buildMeter('real', categories, 250, undefined)).toMatchObject({ windowTokens: null, percent: null });
    expect(buildMeter('real', categories, 250, 0).windowTokens).toBeNull();
  });
});
