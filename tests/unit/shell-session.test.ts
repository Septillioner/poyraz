import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getShellCwd,
  prepareShellCommand,
  resetShellSessions,
  resolveCdChain,
  setShellCwd,
  shellResultMeta,
  syncSessionCwdFromCommand,
} from '../../tools/core/shell-session.js';

describe('shell-session', () => {
  const sessionId = 'test-session';

  beforeEach(() => {
    resetShellSessions();
  });

  afterEach(() => {
    resetShellSessions();
    vi.restoreAllMocks();
  });

  it('resolveCdChain walks multiple cd targets', () => {
    const root = path.resolve('C:\\workspace');
    const subA = path.join(root, 'a');
    const subB = path.join(subA, 'b');

    vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      const s = String(p);
      return s === subA || s === subB || s === root;
    });
    vi.spyOn(fs, 'statSync').mockImplementation((p) => {
      const s = String(p);
      if (s === subA || s === subB || s === root) {
        return { isDirectory: () => true } as fs.Stats;
      }
      throw new Error('not found');
    });

    const result = resolveCdChain('cd a && cd b && npm test', root, sessionId);
    expect(result).toBe(subB);
  });

  it('returns cdOnly for redundant cd-only command', () => {
    const cwd = path.resolve('C:\\project');
    setShellCwd(sessionId, cwd);

    const prepared = prepareShellCommand('cd .', sessionId);
    expect(prepared.cdOnly).toBe(true);
    expect(prepared.cdMessage).toContain('Already in');
    expect(getShellCwd(sessionId)).toBe(cwd);
  });

  it('does not update cwd for redundant cd prefix in compound command', () => {
    const cwd = path.resolve('C:\\project');
    setShellCwd(sessionId, cwd);

    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'statSync').mockReturnValue({ isDirectory: () => true } as fs.Stats);

    const prepared = prepareShellCommand('cd . && npm test', sessionId);
    expect(prepared.command).toBe('npm test');
    expect(getShellCwd(sessionId)).toBe(cwd);
  });

  it('updates cwd when cd target resolves to new directory', () => {
    const cwd = path.resolve('C:\\project');
    const sub = path.join(cwd, 'src');
    setShellCwd(sessionId, cwd);

    vi.spyOn(fs, 'existsSync').mockImplementation((p) => String(p) === sub || String(p) === cwd);
    vi.spyOn(fs, 'statSync').mockImplementation((p) => {
      const s = String(p);
      if (s === sub || s === cwd) {
        return { isDirectory: () => true } as fs.Stats;
      }
      throw new Error('not found');
    });

    const prepared = prepareShellCommand('cd src', sessionId);
    expect(prepared.cdOnly).toBe(true);
    expect(getShellCwd(sessionId)).toBe(sub);
  });

  it('syncSessionCwdFromCommand updates session after compound cd', () => {
    const cwd = path.resolve('C:\\project');
    const sub = path.join(cwd, 'lib');
    setShellCwd(sessionId, cwd);

    vi.spyOn(fs, 'existsSync').mockImplementation((p) => String(p) === sub || String(p) === cwd);
    vi.spyOn(fs, 'statSync').mockImplementation((p) => {
      const s = String(p);
      if (s === sub || s === cwd) {
        return { isDirectory: () => true } as fs.Stats;
      }
      throw new Error('not found');
    });

    const result = syncSessionCwdFromCommand('cd lib && npm test', sessionId, cwd);
    expect(result).toBe(sub);
  });

  it('shellResultMeta returns cwd and command', () => {
    expect(shellResultMeta('/tmp', 'echo hi')).toEqual({ cwd: '/tmp', command: 'echo hi' });
  });

  it('returns error for missing cd target directory', () => {
    const cwd = path.resolve('C:\\project');
    setShellCwd(sessionId, cwd);
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const prepared = prepareShellCommand('cd missing-dir', sessionId);
    expect(prepared.error).toContain('ERROR');
  });
});
