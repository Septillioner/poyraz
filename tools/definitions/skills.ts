import { z } from 'zod';
import {
  DEFAULT_LOAD_SKILL_TOOL_NAME,
  type Skill,
  type SkillToolConfig,
} from '../../application/agent/config.js';
import {
  createToolError,
  serializeToolError,
  TOOL_ERROR_CODES,
} from '../../application/chat/tool-errors.js';
import { defineTool } from '../core/define-tool.js';
import type { ToolDefinition } from '../core/types.js';

/** Default name of the skill-loading tool (same value as `DEFAULT_LOAD_SKILL_TOOL_NAME`). */
export const LOAD_SKILL_TOOL_NAME = DEFAULT_LOAD_SKILL_TOOL_NAME;

export function normalizeSkills(skills: Skill[] | undefined): Skill[] {
  const byName = new Map<string, Skill>();
  for (const skill of skills ?? []) {
    const name = skill.name?.trim() ?? '';
    const description = skill.description?.trim() ?? '';
    const content = skill.content?.trim() ?? '';
    if (!name || !description || !content) continue;
    byName.set(name, { name, description, content });
  }
  return [...byName.values()];
}

/** The configured tool name, or `load_skill` when it is missing or blank. */
export function resolveSkillToolName(config?: SkillToolConfig): string {
  return config?.toolName?.trim() || LOAD_SKILL_TOOL_NAME;
}

/**
 * Whether the skill-loading tool is exposed: needs at least one skill and
 * `skillTool.enabled` not `false`. (`excludeTools` and the policy still apply on top.)
 */
export function isSkillToolEnabled(skills: Skill[] | undefined, config?: SkillToolConfig): boolean {
  return normalizeSkills(skills).length > 0 && config?.enabled !== false;
}

/** `name: description` per line. The model sees it inside the skill tool's description. */
export function buildSkillCatalog(skills: Skill[] | undefined): string {
  return normalizeSkills(skills)
    .map((skill) => `${skill.name}: ${skill.description}`)
    .join('\n');
}

/** Builds the skill-loading tool. `toolName` is the name the model sees (default `load_skill`). */
export function createLoadSkillTool(
  skills: Skill[],
  toolName: string = LOAD_SKILL_TOOL_NAME
): ToolDefinition {
  const name = toolName.trim() || LOAD_SKILL_TOOL_NAME;
  const catalog = skills.map((skill) => `${skill.name}: ${skill.description}`).join('\n');
  const names = skills.map((skill) => skill.name) as [string, ...string[]];

  return defineTool({
    name,
    description: `Load the instructions for one named skill.\n\n${catalog}`,
    inputSchema: z.object({
      name: z.enum(names).describe('Skill name'),
    }),
    presentation: {
      label: 'Loading skill',
      icon: 'BookOpen',
      category: 'memory',
      summarizeArgs: (args) => (typeof args.name === 'string' ? args.name : undefined),
    },
    execute: async (args) => {
      const requested = typeof args.name === 'string' ? args.name : '';
      const skill = skills.find((item) => item.name === requested);
      if (!skill) {
        return serializeToolError(
          createToolError(TOOL_ERROR_CODES.validationError, `Unknown skill: ${requested}`, {
            toolName: name,
          })
        );
      }
      return { content: skill.content };
    },
  });
}
