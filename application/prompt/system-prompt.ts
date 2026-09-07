import { createHash } from 'crypto';
import { BASE_PROMPT } from './sections/behavior.js';

export interface SystemPromptConfig {
  modeDirective?: string;
  persona?: string;
  activeToolsSection?: string;
  /** Dynamic session todos; appended after BASE_PROMPT (not in prefix cache key). */
  currentTodosSection?: string;
}

export interface BuiltSystemPrompt {
  content: string;
  cacheKey: string;
}

function hashStaticContent(
  modeDirective: string,
  persona: string,
  activeToolsSection: string
): string {
  return createHash('sha256')
    .update(
      `${modeDirective}\n---\n${persona}\n---\n${activeToolsSection}\n---\n${BASE_PROMPT}`
    )
    .digest('hex')
    .slice(0, 16);
}

export function buildSystemPrompt(config: SystemPromptConfig = {}): BuiltSystemPrompt {
  const modeDirective = config.modeDirective?.trim() || '';
  const persona = config.persona?.trim() || '';
  const activeToolsSection = config.activeToolsSection?.trim() || '';
  const currentTodosSection = config.currentTodosSection?.trim() || '';

  const parts: string[] = [];

  if (modeDirective) {
    parts.push(`[MODE]\n${modeDirective}`);
  }

  if (persona) {
    parts.push(`<custom_persona>\n${persona}\n</custom_persona>`);
  }

  if (activeToolsSection) {
    parts.push(activeToolsSection);
  }

  parts.push(BASE_PROMPT);

  if (currentTodosSection) {
    parts.push(currentTodosSection);
  }

  const cacheKey = hashStaticContent(modeDirective, persona, activeToolsSection);

  return {
    content: parts.join('\n\n'),
    cacheKey,
  };
}

export { BASE_PROMPT } from './sections/behavior.js';
