import fs from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'path';

export const LogLevel = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
} as const;

export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

const LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.INFO]: 'INFO',
  [LogLevel.WARN]: 'WARN',
  [LogLevel.ERROR]: 'ERROR',
};

export interface FileLoggingConfig {
  enabled: boolean;
  logDir?: string;
}

export interface LoggerOptions {
  /** Minimum level of this logger. Omitted -> `LogLevel.INFO`. */
  level?: LogLevel;
  /** File logging (`agent.log` in `logDir`) of this logger only. Omitted -> off. */
  file?: FileLoggingConfig;
}

/**
 * The logger of the agent whose call is currently running (set by `runWithLogger`).
 * The shared `logger` forwards to it, so modules that log through the shared
 * singleton still honour the level and file of the agent they run for, without any
 * process-wide state being changed.
 */
const activeLogger = new AsyncLocalStorage<Logger>();

/**
 * A logger with its own level and its own file. Two flavours:
 * - the shared `logger` singleton, which forwards to the active scoped logger when one is set;
 * - instances from `createLogger()`, which never touch the shared singleton.
 */
export class Logger {
  private logFile: string | null = null;
  private logDir: string | null = null;
  private fileLoggingEnabled = false;
  private currentLevel: LogLevel = LogLevel.INFO;

  constructor(private readonly followsScope = false) {}

  configureFileLogging(config: FileLoggingConfig) {
    this.fileLoggingEnabled = config.enabled;
    if (!config.enabled || !config.logDir) {
      this.logFile = null;
      this.logDir = null;
      return;
    }

    if (!existsSync(config.logDir)) {
      mkdirSync(config.logDir, { recursive: true });
    }

    this.logDir = config.logDir;
    this.logFile = path.join(config.logDir, 'agent.log');
  }

  getLogDir(): string | null {
    return this.fileLoggingEnabled ? this.logDir : null;
  }

  isFileLoggingEnabled(): boolean {
    return this.fileLoggingEnabled;
  }

  setLevel(level: LogLevel) {
    this.currentLevel = level;
  }

  getLevel(): LogLevel {
    return this.currentLevel;
  }

  private async write(level: LogLevel, message: string, data?: any) {
    if (level < this.currentLevel) return;
    if (!this.fileLoggingEnabled || !this.logFile) return;

    const timestamp = new Date().toISOString();
    const levelStr = LEVEL_NAMES[level];

    let logEntry = `[${timestamp}] [${levelStr}] ${message}`;

    if (data) {
      if (typeof data === 'string') {
        logEntry += `\nData: ${data}`;
      } else {
        logEntry += `\nData: ${JSON.stringify(data, null, 2)}`;
      }
    }

    logEntry += '\n' + '-'.repeat(50) + '\n';

    try {
      await fs.appendFile(this.logFile, logEntry, 'utf-8');
    } catch (error) {
      console.error('Logging to file failed:', error);
    }
  }

  private log(level: LogLevel, message: string, data?: any) {
    const scoped = this.followsScope ? activeLogger.getStore() : undefined;
    const target = scoped && scoped !== this ? scoped : this;
    return target.write(level, message, data);
  }

  debug(message: string, data?: any) {
    return this.log(LogLevel.DEBUG, message, data);
  }
  info(message: string, data?: any) {
    return this.log(LogLevel.INFO, message, data);
  }
  warn(message: string, data?: any) {
    return this.log(LogLevel.WARN, message, data);
  }
  error(message: string, data?: any) {
    return this.log(LogLevel.ERROR, message, data);
  }
}

/**
 * Process-wide logger. Silent (no file) until the host calls `configureFileLogging` / `logger.setLevel`.
 * `AgentBuilder` never changes it: an agent's `logging` config applies to that agent's own logger.
 */
export const logger = new Logger(true);

/** An independent logger: its own level and its own optional file, the shared `logger` is untouched. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const instance = new Logger(false);
  if (options.level !== undefined) instance.setLevel(options.level);
  if (options.file) instance.configureFileLogging(options.file);
  return instance;
}

/** Runs `fn` with `scoped` as the target of everything logged through the shared `logger` meanwhile (also across awaits). */
export function runWithLogger<T>(scoped: Logger, fn: () => T): T {
  return activeLogger.run(scoped, fn);
}

/** Wraps `fn` so every call runs inside `runWithLogger(scoped, ...)`. */
export function scopeToLogger<A extends unknown[], R>(
  scoped: Logger,
  fn: (...args: A) => R
): (...args: A) => R {
  return (...args) => runWithLogger(scoped, () => fn(...args));
}

/** Global (process-wide) file logging; hosts that want it for the whole process call this once. */
export function configureFileLogging(config: FileLoggingConfig): void {
  logger.configureFileLogging(config);
}

export function getConfiguredLogDir(): string | null {
  return logger.getLogDir();
}

export function isFileLoggingEnabled(): boolean {
  return logger.isFileLoggingEnabled();
}
