import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDecisionLoop, CONSECUTIVE_SAME_ERROR_LIMIT } from '../../application/chat/decision-loop.js';
import { createToolPolicyGuard } from '../../application/chat/tool-policy.js';
import { createMessageContext } from '../../application/context/message-context.js';
import { editFileSchema, editFile } from '../../tools/definitions/fs.js';
import { defineTool } from '../../tools/core/define-tool.js';
import type { ToolContext, ToolDefinition } from '../../tools/core/types.js';
import { toolRegistry } from '../../tools/core/registry.js';
import { containsRepairFor, mockLLM, toolCall } from './mock-llm.js';

describe('decision-loop tool error recovery', () => {
  let tmpDir: string;
  let prevCwd: string;
  let toolDefs: Record<string, ToolDefinition>;
  const context: ToolContext = {};

  beforeEach(async () => {
    prevCwd = process.cwd();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'poyraz-loop-'));
    process.chdir(tmpDir);
    await fs.writeFile(path.join(tmpDir, 'sample.txt'), 'line1\nline2\nline3\n', 'utf-8');

    toolDefs = {
      edit_file: defineTool({
        name: 'edit_file',
        description: 'edit',
        inputSchema: editFileSchema,
        execute: (args, _ctx) => editFile(args),
      }),
      noop: defineTool({
        name: 'noop',
        description: 'always fails',
        inputSchema: editFileSchema,
        execute: async () => ({
          content: JSON.stringify({
            error: { code: 'VALIDATION_ERROR', message: 'intentional noop failure' },
          }),
          isError: true,
        }),
      }),
    };
  });

  afterEach(async () => {
    process.chdir(prevCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function runLoop(
    provider: ReturnType<typeof mockLLM>,
    steps: Parameters<typeof mockLLM>[0],
    mode: 'agent' | 'plan' | 'ask' | 'chat' = 'agent'
  ) {
    const llm = provider ?? mockLLM(steps);
    const messageContext = createMessageContext({ limit: 50, autoSummary: false, totalCapacity: 128000 });
    messageContext.addMessage({ role: 'user', content: 'edit the file' });

    const policyGuard = createToolPolicyGuard({
      maxToolRounds: 10,
      repeatCallLimit: 5,
      deterministicMode: true,
      mode,
    });

    return runDecisionLoop(
      {
        provider: llm,
        model: 'test-model',
        options: {},
        tools: toolRegistry.toOpenAISchemas(Object.keys(toolDefs)),
        policy: { maxToolRounds: 10 },
        mode,
      },
      toolDefs,
      policyGuard,
      {
        getMessages: () => messageContext.getMessages(),
        addMessage: (m) => messageContext.addMessage(m),
        buildToolContext: () => context,
      }
    ).then((result) => ({ result, messages: messageContext.getMessages(), llm }));
  }

  it('injects REPAIR into tool message after edit_file marker error', async () => {
    const { messages } = await runLoop(
      mockLLM([
        {
          tool_calls: [
            toolCall('edit_file', {
              target_file: 'sample.txt',
              code_edit: 'partial snippet only',
            }),
          ],
        },
        { content: 'Retrying with full content.' },
      ]),
      []
    );

    expect(containsRepairFor(messages, 'edit_file')).toBe(true);
  });

  it('injects NOTICE after same error twice and blocks further tool calls', async () => {
    const llm = mockLLM([
      { tool_calls: [toolCall('noop', { target_file: 'x', code_edit: 'a' }, 'c1')] },
      { tool_calls: [toolCall('noop', { target_file: 'x', code_edit: 'a' }, 'c2')] },
      { tool_calls: [toolCall('noop', { target_file: 'x', code_edit: 'a' }, 'c3')] },
      { content: 'Giving up in text.' },
    ]);

    const { messages } = await runLoop(llm, [], 'plan');

    const notices = messages.filter((m) => m.role === 'user' && m.content.includes('NOTICE:'));
    expect(notices.length).toBeGreaterThanOrEqual(1);
    expect(notices[0].content).toContain('same error twice');

    const lastAssistantWithTools = [...messages]
      .reverse()
      .find((m) => m.role === 'assistant' && m.tool_calls !== undefined);
    if (lastAssistantWithTools) {
      const idx = messages.indexOf(lastAssistantWithTools);
      const afterNotice = messages.slice(idx);
      const blockedRound = afterNotice.find(
        (m) => m.role === 'assistant' && m.content === 'Giving up in text.'
      );
      expect(blockedRound?.tool_calls).toBeUndefined();
    }

    expect(CONSECUTIVE_SAME_ERROR_LIMIT).toBe(2);
  });

  it('resets error streak after successful tool call', async () => {
    const llm = mockLLM([
      {
        tool_calls: [
          toolCall('edit_file', {
            target_file: 'sample.txt',
            code_edit: 'line1\nline2\nline3\nline4\n',
          }),
        ],
      },
      { content: 'Done.' },
    ]);

    const { messages } = await runLoop(llm, []);
    const notices = messages.filter((m) => m.role === 'user' && m.content.includes('NOTICE:'));
    expect(notices).toHaveLength(0);
  });

  it('strips tool_calls from assistant message when circuit breaker is active', async () => {
    const llm = mockLLM([
      { tool_calls: [toolCall('noop', { target_file: 'a', code_edit: 'b' }, 'c1')] },
      { tool_calls: [toolCall('noop', { target_file: 'a', code_edit: 'b' }, 'c2')] },
      {
        tool_calls: [toolCall('noop', { target_file: 'a', code_edit: 'b' }, 'c3')],
        content: 'Final text only.',
      },
    ]);

    const { messages } = await runLoop(llm, [], 'plan');

    const assistants = messages.filter((m) => m.role === 'assistant');
    expect(assistants.length).toBeGreaterThanOrEqual(3);
    expect(assistants[2].tool_calls).toBeUndefined();
    expect(assistants[2].content).toBe('Final text only.');
  });
});
