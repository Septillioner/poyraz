import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import type { ChatMessage, TokenUsage } from '../../domain/llm.js';
import { getConfiguredLogDir, isFileLoggingEnabled } from '../../shared/logger.js';

export type ChatDebugLogSource = 'cli' | 'http';

export interface ChatDebugLogEntry {
  timestamp: string;
  source: ChatDebugLogSource;
  sessionId?: string;
  agentName: string;
  model: string;
  userInput: string;
  systemPrompt: string | null;
  messages: ChatMessage[];
  usage?: TokenUsage;
  error?: string;
}

export async function writeChatDebugLog(entry: ChatDebugLogEntry): Promise<void> {
  try {
    if (!isFileLoggingEnabled()) return;

    const logDir = getConfiguredLogDir();
    if (!logDir) return;

    const now = new Date();
    const dateDir = now.toISOString().slice(0, 10);
    const timeSuffix = now.toISOString().slice(11, 19).replace(/:/g, '');
    const sessionPart = entry.sessionId?.slice(0, 8) ?? 'nosession';
    const baseDir = path.join(logDir, dateDir);
    await mkdir(baseDir, { recursive: true });
    const filePath = path.join(baseDir, `${sessionPart}-${timeSuffix}.json`);
    await writeFile(filePath, JSON.stringify(entry, null, 2), 'utf-8');
  } catch {
    // debug logging must not break chat
  }
}
