import { createHash } from 'crypto';

export interface BuiltSystemPrompt {
  content: string;
  cacheKey: string;
}

/** System message is the host string verbatim. Empty → no system message. */
export function buildSystemPrompt(systemPrompt?: string): BuiltSystemPrompt {
  const content = systemPrompt?.trim() || '';
  const cacheKey = createHash('sha256').update(content).digest('hex').slice(0, 16);
  return { content, cacheKey };
}

export { BASE_PROMPT } from './sections/behavior.js';
