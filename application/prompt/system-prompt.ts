import { createHash } from 'crypto';

export interface BuiltSystemPrompt {
  content: string;
  cacheKey: string;
}

function hostText(value: string | undefined): string {
  return value?.trim() ?? '';
}

/** Host system text, then host rules, joined by a blank line. Empty → no system message. */
export function buildSystemPrompt(systemPrompt?: string, rules?: string[]): BuiltSystemPrompt {
  const parts: string[] = [];
  const prompt = hostText(systemPrompt);
  if (prompt) parts.push(prompt);
  for (const rule of rules ?? []) {
    const text = hostText(rule);
    if (text) parts.push(text);
  }
  const content = parts.join('\n\n');
  const cacheKey = createHash('sha256').update(content).digest('hex').slice(0, 16);
  return { content, cacheKey };
}

export { BASE_PROMPT } from './sections/behavior.js';
