import fs from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
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

class Logger {
  private logFile: string | null = null;
  private fileLoggingEnabled = false;
  private currentLevel: LogLevel = LogLevel.INFO;

  configureFileLogging(config: FileLoggingConfig) {
    this.fileLoggingEnabled = config.enabled;
    if (!config.enabled || !config.logDir) {
      this.logFile = null;
      return;
    }

    if (!existsSync(config.logDir)) {
      mkdirSync(config.logDir, { recursive: true });
    }

    this.logFile = path.join(config.logDir, 'agent.log');
  }

  setLevel(level: LogLevel) {
    this.currentLevel = level;
  }

  private async log(level: LogLevel, message: string, data?: any) {
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

export const logger = new Logger();

export function configureFileLogging(config: FileLoggingConfig): void {
  logger.configureFileLogging(config);
}
