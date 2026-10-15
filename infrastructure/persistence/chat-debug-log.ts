import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import type { ChatMessage, TokenUsage } from '../../domain/llm.js';
import { getConfiguredLogDir } from '../../shared/logger.js';

/** Free-text origin tag of a chat turn (e.g. `'cli'`, `'http'`, `'worker-3'`). */
export type ChatDebugLogSource = string;

export interface ChatDebugLogEntry {
  timestamp: string;
  /** Free text; omitted when the host set no source. */
  source?: ChatDebugLogSource;
  sessionId?: string;
  agentName: string;
  model: string;
  userInput: string;
  systemPrompt: string | null;
  messages: ChatMessage[];
  usage?: TokenUsage;
  error?: string;
}

/**
 * Writes one JSON file per chat turn into `logDir` (the agent's own log dir). Without `logDir`
 * it falls back to the process-wide log dir of `configureFileLogging`; with neither, nothing is written.
 * Callers decide whether to call it at all (`logging.chatDebugLog`).
 */
export async function writeChatDebugLog(entry: ChatDebugLogEntry, logDir?: string): Promise<void> {
  try {
    const dir = logDir ?? getConfiguredLogDir();
    if (!dir) return;

    const now = new Date();
    const dateDir = now.toISOString().slice(0, 10);
    const timeSuffix = now.toISOString().slice(11, 19).replace(/:/g, '');
    const sessionPart = entry.sessionId?.slice(0, 8) ?? 'nosession';
    const baseDir = path.join(dir, dateDir);
    await mkdir(baseDir, { recursive: true });
    const filePath = path.join(baseDir, `${sessionPart}-${timeSuffix}.json`);
    await writeFile(filePath, JSON.stringify(entry, null, 2), 'utf-8');
  } catch {
    // debug logging must not break chat
  }
}
