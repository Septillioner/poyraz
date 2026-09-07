import { describe, expect, it } from 'vitest';
import {
  isAgentMode,
  nextAgentMode,
  resolveAgentMode,
  resolveModeDenied,
  resolveModeTools,
} from '../../domain/agent-mode.js';
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

describe('agent-mode helpers', () => {
  it('isAgentMode recognizes valid modes', () => {
    expect(isAgentMode('agent')).toBe(true);
    expect(isAgentMode('PLAN')).toBe(true);
    expect(isAgentMode('invalid')).toBe(false);
  });

  it('nextAgentMode cycles through modes', () => {
    expect(nextAgentMode('agent')).toBe('plan');
    expect(nextAgentMode('chat')).toBe('agent');
  });

  it('resolveAgentMode returns undefined for unknown', () => {
    expect(resolveAgentMode('nope')).toBeUndefined();
    expect(resolveAgentMode('ask')).toBe('ask');
  });
});

describe('resolveModeTools / resolveModeDenied', () => {
  it('plan mode denies edit and shell tools', () => {
    const denied = resolveModeDenied(ALL_TOOLS, 'plan');
    expect(denied).toContain('edit_file');
    expect(denied).toContain('run_terminal_cmd');
    expect(denied).toContain('delete_file');
    expect(denied).not.toContain('read_file');
    expect(denied).not.toContain('todo_write');
  });

  it('ask mode allows only read tools', () => {
    const allowed = resolveModeTools(ALL_TOOLS, 'ask');
    expect(allowed).toEqual(['read_file', 'list_dir', 'glob_file_search', 'grep']);
    const denied = resolveModeDenied(ALL_TOOLS, 'ask');
    expect(denied).toContain('edit_file');
    expect(denied).toContain('todo_write');
  });

  it('agent mode allows all tools', () => {
    expect(resolveModeTools(ALL_TOOLS, 'agent')).toEqual(ALL_TOOLS);
    expect(resolveModeDenied(ALL_TOOLS, 'agent')).toEqual([]);
  });

  it('chat mode denies all tools', () => {
    expect(resolveModeTools(ALL_TOOLS, 'chat')).toEqual([]);
    expect(resolveModeDenied(ALL_TOOLS, 'chat')).toEqual(ALL_TOOLS);
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
