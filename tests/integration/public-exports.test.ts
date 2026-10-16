import { describe, expect, it } from 'vitest';
import * as poyraz from '../../index.js';

describe('public exports of the clean-builder work', () => {
  it.each([
    'builtinRepairResolvers',
    'RateLimitExceededError',
    'withRateLimitPolicy',
    'DISABLED_RATE_LIMIT',
    'RATE_LIMIT_DEFAULT_MAX_WAITS',
    'McpClientManager',
    'createMcpClientManager',
    'resolveMcpToolPrefix',
    'isMcpToolName',
    'Logger',
    'createLogger',
    'runWithLogger',
    'scopeToLogger',
    'chainContinuation',
    'resolveAgentPolicy',
    'resolveRateLimitConfig',
    'AgentConfigError',
    'calculateTokenCost',
    'isTokenPricing',
    'normalizeTokenPricing',
  ])('exports %s', (name) => {
    expect((poyraz as Record<string, unknown>)[name]).toBeDefined();
  });

  it('the Agent exposes the MCP and registry accessors', () => {
    for (const method of ['connectMcp', 'disconnectMcp', 'getMcpStates', 'getMcpToolPrefix', 'getToolRegistry']) {
      expect(typeof (poyraz.Agent.prototype as unknown as Record<string, unknown>)[method]).toBe('function');
    }
  });
});
