import { describe, expect, it } from 'vitest';
import {
  resolvePolicyDenied,
  resolvePolicyTools,
  type AgentPolicy,
} from '../../domain/agent-policy.js';
import {
  buildActiveToolsSection,
  buildToolGuidanceSection,
  getToolExampleShape,
} from '../../application/prompt/tool-schema-hints.js';

const ALL_TOOLS = [
  'read_file',
  'edit_file',
  'list_dir',
  'glob_file_search',
  'grep',
  'run_terminal_cmd',
  'todo_write',
  'delete_file',
];

const PLAN_LIKE: AgentPolicy = {
  id: 'plan',
  allowedTools: ['read_file', 'list_dir', 'glob_file_search', 'grep', 'todo_write'],
};

const ASK_LIKE: AgentPolicy = {
  id: 'ask',
  allowedTools: ['read_file', 'list_dir', 'glob_file_search', 'grep'],
};

const AGENT_LIKE: AgentPolicy = {
  id: 'agent',
  allowedTools: 'all',
};

const CHAT_LIKE: AgentPolicy = {
  id: 'chat',
  allowedTools: [],
};

describe('resolvePolicyTools / resolvePolicyDenied', () => {
  it('plan-like policy denies edit and shell tools', () => {
    const denied = resolvePolicyDenied(ALL_TOOLS, PLAN_LIKE);
    expect(denied).toContain('edit_file');
    expect(denied).toContain('run_terminal_cmd');
    expect(denied).toContain('delete_file');
    expect(denied).not.toContain('read_file');
    expect(denied).not.toContain('todo_write');
  });

  it('ask-like policy allows only read tools', () => {
    const allowed = resolvePolicyTools(ALL_TOOLS, ASK_LIKE);
    expect(allowed).toEqual(['read_file', 'list_dir', 'glob_file_search', 'grep']);
    const denied = resolvePolicyDenied(ALL_TOOLS, ASK_LIKE);
    expect(denied).toContain('edit_file');
    expect(denied).toContain('todo_write');
  });

  it('all-tools policy allows every tool', () => {
    expect(resolvePolicyTools(ALL_TOOLS, AGENT_LIKE)).toEqual(ALL_TOOLS);
    expect(resolvePolicyDenied(ALL_TOOLS, AGENT_LIKE)).toEqual([]);
  });

  it('empty allow-list denies all tools', () => {
    expect(resolvePolicyTools(ALL_TOOLS, CHAT_LIKE)).toEqual([]);
    expect(resolvePolicyDenied(ALL_TOOLS, CHAT_LIKE)).toEqual(ALL_TOOLS);
  });
});

describe('buildActiveToolsSection', () => {
  it('lists only provided tool names in available_tools', () => {
    const section = buildActiveToolsSection(['read_file', 'grep'], 'standard');
    const toolsBlock = section.split('</available_tools>')[0];
    expect(toolsBlock).toContain('<available_tools>');
    expect(toolsBlock).toContain('read_file');
    expect(toolsBlock).toContain('grep');
    expect(toolsBlock).not.toContain('edit_file');
  });

  it('includes explicit guidance for small models', () => {
    const section = buildActiveToolsSection(['read_file', 'edit_file'], 'explicit');
    expect(section).toContain('<tool_guidance>');
    expect(section).toContain('edit_file');
  });

  it('returns empty string when no tools', () => {
    expect(buildActiveToolsSection([])).toBe('');
  });

  it('handles unknown tool names', () => {
    const section = buildActiveToolsSection(['custom_unknown_tool'], 'standard');
    expect(section).toContain('custom_unknown_tool');
  });
});

describe('tool-schema-hints utilities', () => {
  it('getToolExampleShape returns list_dir example', () => {
    expect(getToolExampleShape('list_dir')).toContain('target_directory');
  });

  it('buildToolGuidanceSection returns guidance block', () => {
    const section = buildToolGuidanceSection(['read_file'], 'explicit');
    expect(section).toContain('read_file');
  });
});
