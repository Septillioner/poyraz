import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeChatDebugLog } from '../../infrastructure/persistence/chat-debug-log.js';
import {
  createLogger,
  isFileLoggingEnabled,
  LogLevel,
  logger,
  runWithLogger,
  scopeToLogger,
} from '../../shared/logger.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'poyraz-log-'));
  dirs.push(dir);
  return dir;
}
function logText(dir: string): string {
  const file = path.join(dir, 'agent.log');
  return existsSync(file) ? readFileSync(file, 'utf-8') : '';
}

afterEach(() => {
  logger.setLevel(LogLevel.INFO);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('per-instance logger', () => {
  it('writes to its own file only, and leaves the shared logger untouched', async () => {
    const dir = tempDir();
    const own = createLogger({ level: LogLevel.DEBUG, file: { enabled: true, logDir: dir } });

    await own.debug('own message', { a: 1 });

    expect(logText(dir)).toContain('[DEBUG] own message');
    expect(own.getLogDir()).toBe(dir);
    expect(isFileLoggingEnabled()).toBe(false);
    expect(logger.getLogDir()).toBeNull();
    expect(logger.getLevel()).toBe(LogLevel.INFO);
  });

  it('applies its own level', async () => {
    const dir = tempDir();
    const own = createLogger({ level: LogLevel.ERROR, file: { enabled: true, logDir: dir } });
    await own.info('quiet');
    await own.error('loud');
    expect(logText(dir)).not.toContain('quiet');
    expect(logText(dir)).toContain('loud');
  });

  it('has no file and no output by default', async () => {
    const own = createLogger();
    expect(own.getLogDir()).toBeNull();
    await own.error('nowhere');
  });

  it('the shared logger forwards to the active scoped logger, level and file included', async () => {
    const dir = tempDir();
    const scoped = createLogger({ level: LogLevel.WARN, file: { enabled: true, logDir: dir } });

    await runWithLogger(scoped, async () => {
      await logger.info('below the scoped level');
      await logger.warn('through the shared logger');
    });
    await logger.warn('outside the scope');

    const text = logText(dir);
    expect(text).toContain('through the shared logger');
    expect(text).not.toContain('below the scoped level');
    expect(text).not.toContain('outside the scope');
  });

  it('scopes survive awaits and stay separate between concurrent scopes', async () => {
    const dirA = tempDir();
    const dirB = tempDir();
    const a = createLogger({ file: { enabled: true, logDir: dirA } });
    const b = createLogger({ file: { enabled: true, logDir: dirB } });
    const run = (target: ReturnType<typeof createLogger>, label: string) =>
      scopeToLogger(target, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        await logger.info(label);
      })();

    await Promise.all([run(a, 'from-a'), run(b, 'from-b')]);

    expect(logText(dirA)).toContain('from-a');
    expect(logText(dirA)).not.toContain('from-b');
    expect(logText(dirB)).toContain('from-b');
    expect(logText(dirB)).not.toContain('from-a');
  });

  it('an instance logger is not redirected by an active scope', async () => {
    const dirOwn = tempDir();
    const dirScoped = tempDir();
    const own = createLogger({ file: { enabled: true, logDir: dirOwn } });
    const scoped = createLogger({ file: { enabled: true, logDir: dirScoped } });

    await runWithLogger(scoped, () => own.info('stays with its owner'));

    expect(logText(dirOwn)).toContain('stays with its owner');
    expect(logText(dirScoped)).toBe('');
  });
});

describe('writeChatDebugLog', () => {
  const entry = {
    timestamp: '2026-10-15T00:00:00.000Z',
    agentName: 'a',
    model: 'm',
    userInput: 'hi',
    systemPrompt: null,
    messages: [],
  };

  function written(dir: string): Array<Record<string, unknown>> {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .flatMap((d) => readdirSync(path.join(dir, d.name)).map((f) => path.join(dir, d.name, f)))
      .map((file) => JSON.parse(readFileSync(file, 'utf-8')));
  }

  it('writes into the given log dir with a free-text source', async () => {
    const dir = tempDir();
    await writeChatDebugLog({ ...entry, source: 'worker-3' }, dir);
    expect(written(dir)).toEqual([expect.objectContaining({ source: 'worker-3', userInput: 'hi' })]);
  });

  it('leaves the source out when none was set (no default tag)', async () => {
    const dir = tempDir();
    await writeChatDebugLog(entry, dir);
    expect(written(dir)[0]).not.toHaveProperty('source');
  });

  it('writes nothing without a dir and without process-wide file logging', async () => {
    const before = vi.spyOn(console, 'error');
    await writeChatDebugLog({ ...entry, source: 'cli' });
    expect(isFileLoggingEnabled()).toBe(false);
    expect(before).not.toHaveBeenCalled();
    before.mockRestore();
  });
});
