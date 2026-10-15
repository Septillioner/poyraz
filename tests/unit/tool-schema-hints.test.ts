import { describe, expect, it } from 'vitest';
import {
  buildActiveToolsSection,
  buildToolGuidanceSection,
  getToolExampleShape,
} from '../../application/prompt/tool-schema-hints.js';

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
