import { createHash } from 'crypto';
import type { SystemPromptParts } from '../../domain/context.js';
import type { Skill } from '../agent/config.js';
import { buildSkillCatalog } from '../../tools/definitions/skills.js';

export type { SystemPromptParts };

export interface BuiltSystemPrompt {
  /** The system message content: host system text, then host rules. Skills are not part of it. */
  content: string;
  cacheKey: string;
  /** The same text split by origin, for per-part measurement. */
  parts: SystemPromptParts;
}

export interface BuildSystemPromptOptions {
  /** Report the skill catalog in `parts.skills`. Default `true`; `false` when the skill tool is not exposed. */
  skillCatalog?: boolean;
}

function hostText(value: string | undefined): string {
  return value?.trim() ?? '';
}

/**
 * Host system text, then host rules, joined by a blank line. Empty → no system message.
 * `parts` exposes system / rules / skills separately. The skill catalog is reported
 * in `parts.skills` but stays out of `content`: the model reads it from the
 * skill tool's description (`load_skill` by default), so counting it here too would
 * double count it. With `options.skillCatalog: false` (skill tool disabled or hidden)
 * the model sees no catalog, so `parts.skills` is empty.
 * Nothing is added by the library: no system / rules / skills means empty `content`.
 */
export function buildSystemPrompt(
  systemPrompt?: string,
  rules?: string[],
  skills?: Skill[],
  options: BuildSystemPromptOptions = {}
): BuiltSystemPrompt {
  const parts: string[] = [];
  const prompt = hostText(systemPrompt);
  if (prompt) parts.push(prompt);
  const ruleTexts: string[] = [];
  for (const rule of rules ?? []) {
    const text = hostText(rule);
    if (text) ruleTexts.push(text);
  }
  parts.push(...ruleTexts);
  const content = parts.join('\n\n');
  const cacheKey = createHash('sha256').update(content).digest('hex').slice(0, 16);
  return {
    content,
    cacheKey,
    parts: {
      system: prompt,
      rules: ruleTexts.join('\n\n'),
      skills: options.skillCatalog === false ? '' : buildSkillCatalog(skills),
    },
  };
}
