import { z } from 'zod';
import type { Skill } from '../../application/agent/config.js';
import {
  createToolError,
  serializeToolError,
  TOOL_ERROR_CODES,
} from '../../application/chat/tool-errors.js';
import { defineTool } from '../core/define-tool.js';
import type { ToolDefinition } from '../core/types.js';

export const LOAD_SKILL_TOOL_NAME = 'load_skill';

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

export function createLoadSkillTool(skills: Skill[]): ToolDefinition {
  const catalog = skills.map((skill) => `${skill.name}: ${skill.description}`).join('\n');
  const names = skills.map((skill) => skill.name) as [string, ...string[]];

  return defineTool({
    name: LOAD_SKILL_TOOL_NAME,
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
      const name = typeof args.name === 'string' ? args.name : '';
      const skill = skills.find((item) => item.name === name);
      if (!skill) {
        return serializeToolError(
          createToolError(TOOL_ERROR_CODES.validationError, `Unknown skill: ${name}`, {
            toolName: LOAD_SKILL_TOOL_NAME,
          })
        );
      }
      return { content: skill.content };
    },
  });
}
