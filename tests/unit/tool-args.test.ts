import { describe, expect, it } from 'vitest';
import { parseRawToolArgs, executeToolCall } from '../../application/chat/tool-execution.js';
import { createToolPolicyGuard } from '../../application/chat/tool-policy.js';
import { listDirSchema } from '../../tools/definitions/fs.js';
import { defineTool } from '../../tools/core/define-tool.js';
import type { ToolContext } from '../../tools/core/types.js';

describe('parseRawToolArgs', () => {
  it('shallow-copies plain objects', () => {
    const input = { target_directory: '.' };
    const result = parseRawToolArgs(input);
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
  });

  it('parses JSON strings', () => {
    expect(parseRawToolArgs('{"target_directory":"."}')).toEqual({ target_directory: '.' });
  });

  it('returns empty object for malformed JSON', () => {
    expect(parseRawToolArgs('{bad json')).toEqual({});
  });

  it('returns empty object for arrays', () => {
    expect(parseRawToolArgs('[1,2,3]')).toEqual({});
  });

  it('returns empty object for null', () => {
    expect(parseRawToolArgs(null)).toEqual({});
  });
});

describe('executeToolCall validation', () => {
  const listDirTool = defineTool({
    name: 'list_dir',
    description: 'list',
    inputSchema: listDirSchema,
    execute: async () => '(empty)',
  });

  const tools = { list_dir: listDirTool };
  const policyGuard = createToolPolicyGuard({
    maxToolRounds: 10,
    repeatCallLimit: 3,
    deterministicMode: true,
  });
  const context: ToolContext = {};

  it('returns VALIDATION_ERROR with example hint for missing target_directory', async () => {
    const outcome = await executeToolCall(
      tools,
      policyGuard,
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'list_dir', arguments: {} },
      },
      context
    );

    expect(outcome.message.content).toContain('VALIDATION_ERROR');
    expect(outcome.message.content).toContain('REPAIR:');
    expect(outcome.message.content).toContain('target_directory');
  });

  it('executes tool successfully when args are valid', async () => {
    const outcome = await executeToolCall(
      tools,
      policyGuard,
      {
        id: 'call_ok',
        type: 'function',
        function: { name: 'list_dir', arguments: { target_directory: '.' } },
      },
      context
    );
    expect(outcome.message.content).toBe('(empty)');
    expect(outcome.message.content).not.toContain('error');
  });

  it('returns TOOL_NOT_FOUND with repair for unknown tools', async () => {
    const outcome = await executeToolCall(
      tools,
      policyGuard,
      {
        id: 'call_missing',
        type: 'function',
        function: { name: 'missing_tool', arguments: {} },
      },
      context
    );
    expect(outcome.message.content).toContain('TOOL_NOT_FOUND');
    expect(outcome.message.content).toContain('REPAIR:');
  });
});
