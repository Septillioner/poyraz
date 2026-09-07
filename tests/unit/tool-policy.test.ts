import { describe, expect, it, beforeEach } from 'vitest';
import { createToolPolicyGuard } from '../../application/chat/tool-policy.js';

describe('createToolPolicyGuard', () => {
  let guard: ReturnType<typeof createToolPolicyGuard>;

  beforeEach(() => {
    guard = createToolPolicyGuard({
      maxToolRounds: 10,
      repeatCallLimit: 2,
      deterministicMode: true,
      deniedTools: ['edit_file', 'run_terminal_cmd'],
    });
  });

  it('blocks denied tools', async () => {
    const decision = await guard.canExecute('edit_file');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('disabled');
  });

  it('allows non-denied tools', async () => {
    const decision = await guard.canExecute('read_file');
    expect(decision.allowed).toBe(true);
  });

  it('increments signature counts', () => {
    const sig = 'edit_file:abc123';
    expect(guard.markAndCountSignature(sig)).toBe(1);
    expect(guard.markAndCountSignature(sig)).toBe(2);
    expect(guard.markAndCountSignature(sig)).toBe(3);
  });

  it('tracks repair attempts per signature', () => {
    const sig = 'list_dir:def456';
    expect(guard.getRepairAttempts(sig)).toBe(0);
    expect(guard.markRepairAttempt(sig)).toBe(1);
    expect(guard.getRepairAttempts(sig)).toBe(1);
    expect(guard.markRepairAttempt(sig)).toBe(2);
  });

  it('reset clears all counters', () => {
    const sig = 'grep:xyz';
    guard.markAndCountSignature(sig);
    guard.markRepairAttempt(sig);
    guard.reset();
    expect(guard.getRepairAttempts(sig)).toBe(0);
    expect(guard.markAndCountSignature(sig)).toBe(1);
  });

  it('exposes policy via getPolicy', () => {
    expect(guard.getPolicy().repeatCallLimit).toBe(2);
    expect(guard.getPolicy().deniedTools).toContain('edit_file');
  });
});
