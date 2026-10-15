import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../../application/prompt/system-prompt.js';
import {
  buildSkillCatalog,
  createLoadSkillTool,
  isSkillToolEnabled,
  LOAD_SKILL_TOOL_NAME,
  resolveSkillToolName,
} from '../../tools/definitions/skills.js';

const skills = [
  { name: 'deploy', description: 'How to deploy', content: 'Run the deploy steps.' },
  { name: 'review', description: 'How to review', content: 'Read the diff first.' },
];

async function run(tool: ReturnType<typeof createLoadSkillTool>, args: Record<string, unknown>): Promise<string> {
  const out: any = await (tool as any).execute(args, {});
  return typeof out === 'string' ? out : out.content;
}

describe('createLoadSkillTool', () => {
  it('defaults to load_skill', () => {
    expect(createLoadSkillTool(skills).name).toBe('load_skill');
    expect(LOAD_SKILL_TOOL_NAME).toBe('load_skill');
  });

  it('takes the tool name as a parameter; blank falls back to the default', () => {
    expect(createLoadSkillTool(skills, 'skills_load').name).toBe('skills_load');
    expect(createLoadSkillTool(skills, '  ').name).toBe('load_skill');
  });

  it('lists the skills in its description and returns a skill body', async () => {
    const tool = createLoadSkillTool(skills, 'skills_load');
    expect(tool.description).toContain('deploy: How to deploy');
    expect(tool.description).toContain('review: How to review');
    expect(tool.description).toBe(`Load the instructions for one named skill.\n\n${buildSkillCatalog(skills)}`);
    expect(await run(tool, { name: 'review' })).toBe('Read the diff first.');
  });

  it('unknown skill errors carry the configured tool name, not load_skill', async () => {
    const tool = createLoadSkillTool(skills, 'skills_load');
    const body = JSON.parse(await run(tool, { name: 'nope' }));
    expect(body.error.message).toBe('Unknown skill: nope');
    expect(body.error.details).toEqual({ toolName: 'skills_load' });
    const dflt = JSON.parse(await run(createLoadSkillTool(skills), { name: 'nope' }));
    expect(dflt.error.details).toEqual({ toolName: 'load_skill' });
  });
});

describe('skill tool config helpers', () => {
  it('resolveSkillToolName: configured name, default when missing or blank', () => {
    expect(resolveSkillToolName()).toBe('load_skill');
    expect(resolveSkillToolName({ toolName: '  ' })).toBe('load_skill');
    expect(resolveSkillToolName({ toolName: ' skills ' })).toBe('skills');
  });

  it('isSkillToolEnabled: needs skills and enabled !== false', () => {
    expect(isSkillToolEnabled(undefined)).toBe(false);
    expect(isSkillToolEnabled([])).toBe(false);
    expect(isSkillToolEnabled([{ name: 'a', description: '', content: 'x' }])).toBe(false);
    expect(isSkillToolEnabled(skills)).toBe(true);
    expect(isSkillToolEnabled(skills, { enabled: true })).toBe(true);
    expect(isSkillToolEnabled(skills, { enabled: false })).toBe(false);
  });
});

describe('buildSystemPrompt adds nothing by itself', () => {
  it('no system, rules or skills gives empty content', () => {
    const built = buildSystemPrompt();
    expect(built.content).toBe('');
    expect(built.parts).toEqual({ system: '', rules: '', skills: '' });
  });

  it('skills alone never create system content; the catalog is only reported in parts', () => {
    const built = buildSystemPrompt(undefined, undefined, skills);
    expect(built.content).toBe('');
    expect(built.parts.skills).toBe('deploy: How to deploy\nreview: How to review');
  });

  it('skillCatalog:false (skill tool not exposed) empties parts.skills', () => {
    expect(buildSystemPrompt('s', ['r'], skills, { skillCatalog: false }).parts.skills).toBe('');
    expect(buildSystemPrompt('s', ['r'], skills, { skillCatalog: true }).parts.skills).not.toBe('');
  });

  it('system and rules only, as given', () => {
    expect(buildSystemPrompt(' sys ', ['r1', ' ', 'r2']).content).toBe('sys\n\nr1\n\nr2');
  });
});
