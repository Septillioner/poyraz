import { describe, expect, it } from 'vitest';
import {
  isMcpToolName,
  MCP_TOOL_PREFIX,
  mcpToolName,
  resolveMcpToolPrefix,
} from '../../infrastructure/mcp/mcp-tool-bridge.js';
import { createMcpClientManager, mcpClientManager } from '../../infrastructure/mcp/mcp-client-manager.js';

describe('mcp tool prefix', () => {
  it('defaults to mcp_ and ignores an empty or blank prefix', () => {
    expect(resolveMcpToolPrefix()).toBe(MCP_TOOL_PREFIX);
    expect(resolveMcpToolPrefix('')).toBe(MCP_TOOL_PREFIX);
    expect(resolveMcpToolPrefix('   ')).toBe(MCP_TOOL_PREFIX);
  });

  it('keeps a configured prefix, limited to provider-safe characters', () => {
    expect(resolveMcpToolPrefix('ext_')).toBe('ext_');
    expect(resolveMcpToolPrefix(' my tools.')).toBe('my_tools_');
  });

  it('builds names with the prefix and keeps the default when none is given', () => {
    expect(mcpToolName('docs', 'search')).toBe('mcp_docs__search');
    expect(mcpToolName('docs', 'search', undefined, 'ext_')).toBe('ext_docs__search');
  });

  it('collision suffixes still work with a custom prefix', () => {
    const used = new Set<string>();
    expect(mcpToolName('a', 'x', used, 'ext_')).toBe('ext_a__x');
    expect(mcpToolName('a', 'x', used, 'ext_')).toBe('ext_a__x_2');
  });

  it('isMcpToolName follows the prefix', () => {
    expect(isMcpToolName('mcp_docs__search')).toBe(true);
    expect(isMcpToolName('ext_docs__search')).toBe(false);
    expect(isMcpToolName('ext_docs__search', 'ext_')).toBe(true);
    expect(isMcpToolName('mcp_docs__search', 'ext_')).toBe(false);
  });

  it('managers are independent instances with their own prefix', () => {
    const a = createMcpClientManager({ toolPrefix: 'ext_' });
    const b = createMcpClientManager();
    expect(a.getToolPrefix()).toBe('ext_');
    expect(b.getToolPrefix()).toBe(MCP_TOOL_PREFIX);
    expect(a).not.toBe(mcpClientManager);
    expect(a.listStates()).toEqual([]);
    expect(a.getTools()).toEqual({});
  });
});
