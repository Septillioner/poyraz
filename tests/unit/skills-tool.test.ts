import { describe, expect, it } from 'vitest';
import { AgentBuilder } from '../../application/agent/agent-builder.js';
import { isSummaryMessage } from '../../application/context/summarizer.js';
import { buildSystemPrompt } from '../../application/prompt/system-prompt.js';
import {
  buildSkillCatalog,
  createLoadSkillTool,
  isSkillToolEnabled,
  LOAD_SKILL_TOOL_NAME,
  resolveSkillToolName,
} from '../../tools/definitions/skills.js';
import { mockLLM } from '../integration/mock-llm.js';

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

describe('builder behaviour of system / rules / skills / summary switches', () => {
  const build = () => new AgentBuilder().Provider(mockLLM([{ content: 'ok' }]));

  it('AddSkill and AddSkills throw on an incomplete skill', () => {
    expect(() => build().AddSkill({ name: 'a', description: '', content: 'x' })).toThrow(/Skill requires/);
    expect(() => build().AddSkills([skills[0], { name: '', description: 'd', content: 'c' }])).toThrow(/Skill requires/);
  });

  it('setSkills drops incomplete skills silently; the tool and parts.skills follow', () => {
    const agent = build().AddSkill(skills[0]).Build();
    expect(agent.getTools()).toEqual(['load_skill']);
    agent.setSkills([{ name: 'a', description: '', content: 'x' }]);
    expect(agent.getTools()).toEqual([]);
    expect(agent.compileRequest().parts.skills).toBe('');
    agent.setSkills(skills);
    expect(agent.getTools()).toEqual(['load_skill']);
    expect(agent.compileRequest().parts.skills).toBe('deploy: How to deploy\nreview: How to review');
  });

  it('Rules(...) replaces the earlier list, drops blanks and clears with no arguments', () => {
    expect(build().Rules('a').Rules('b', '  ').Build().getConfig().rules).toEqual(['b']);
    expect(build().Rules('a').Rules().Build().getConfig().rules).toBeUndefined();
  });

  it('setRules / setSystemPrompt rebuild the system message; clearing both removes it', async () => {
    const agent = build().Build();
    await agent.init();
    expect(agent.getHistory()).toEqual([]);
    agent.setSystemPrompt('Be brief.');
    agent.setRules(['No emojis.']);
    expect(agent.getHistory()[0]).toEqual({ role: 'system', content: 'Be brief.\n\nNo emojis.' });
    agent.setRules(undefined);
    expect(agent.getHistory()[0]).toEqual({ role: 'system', content: 'Be brief.' });
    agent.setSystemPrompt('');
    expect(agent.getHistory()).toEqual([]);
  });

  it('summarization.enabled wins over the legacy autoSummary switch', async () => {
    const run = async (builder: AgentBuilder) => {
      const agent = builder.ContextLimit(4).Build();
      await agent.init();
      for (let i = 0; i < 6; i++) await agent.chat('turn ' + i);
      return agent.getHistory().some((m) => isSummaryMessage(m));
    };
    expect(await run(build().AutoSummary(true))).toBe(true);
    expect(await run(build().AutoSummary(true).Summarization({ enabled: false }))).toBe(false);
    expect(await run(build().AutoSummary(false).Summarization({ enabled: true }))).toBe(true);
  });
});
