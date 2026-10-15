import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AGENT_POLICY,
  resolvePolicyDenied,
  resolvePolicyTools,
  type AgentPolicy,
} from '../../domain/agent-policy.js';

const ALL_TOOLS = [
  'read_file',
  'edit_file',
  'list_dir',
  'glob_file_search',
  'grep',
  'run_terminal_cmd',
  'delete_file',
];

const READ_ONLY_TOOLS = ['read_file', 'list_dir', 'glob_file_search', 'grep'];

const READ_ONLY: AgentPolicy = { id: 'read-only', allowedTools: READ_ONLY_TOOLS };
const ALLOW_ALL: AgentPolicy = { id: 'allow-all', allowedTools: 'all' };
const ALLOW_NONE: AgentPolicy = { id: 'allow-none', allowedTools: [] };

describe('resolvePolicyTools / resolvePolicyDenied', () => {
  it('an allow-list denies every tool outside it', () => {
    const denied = resolvePolicyDenied(ALL_TOOLS, READ_ONLY);
    expect(denied).toEqual(['edit_file', 'run_terminal_cmd', 'delete_file']);
    expect(denied).not.toContain('read_file');
    expect(denied).not.toContain('grep');
  });

  it('an allow-list keeps only the listed tools, in the agent tool order', () => {
    expect(resolvePolicyTools(ALL_TOOLS, READ_ONLY)).toEqual(READ_ONLY_TOOLS);
  });

  it("'all' allows every tool", () => {
    expect(resolvePolicyTools(ALL_TOOLS, ALLOW_ALL)).toEqual(ALL_TOOLS);
    expect(resolvePolicyDenied(ALL_TOOLS, ALLOW_ALL)).toEqual([]);
  });

  it('the default policy allows every tool', () => {
    expect(resolvePolicyTools(ALL_TOOLS, DEFAULT_AGENT_POLICY)).toEqual(ALL_TOOLS);
    expect(resolvePolicyDenied(ALL_TOOLS, DEFAULT_AGENT_POLICY)).toEqual([]);
  });

  it('an empty allow-list denies all tools', () => {
    expect(resolvePolicyTools(ALL_TOOLS, ALLOW_NONE)).toEqual([]);
    expect(resolvePolicyDenied(ALL_TOOLS, ALLOW_NONE)).toEqual(ALL_TOOLS);
  });

  it('names missing from the agent are ignored by the allow-list', () => {
    const policy: AgentPolicy = { id: 'p', allowedTools: ['read_file', 'not_registered'] };
    expect(resolvePolicyTools(['read_file', 'grep'], policy)).toEqual(['read_file']);
    expect(resolvePolicyDenied(['read_file', 'grep'], policy)).toEqual(['grep']);
  });
});
