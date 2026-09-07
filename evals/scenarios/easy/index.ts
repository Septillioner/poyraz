import type { EvalScenario } from '../../types.js';
import { readFixtureFile, writeFixtureFile } from '../../fixtures/create-fixture.js';
import {
  hadToolFailure,
  mentionsModeSwitch,
  wasPolicyBlocked,
} from '../helpers.js';

export const easyCssAddRule: EvalScenario = {
  id: 'easy-css-add-rule',
  difficulty: 'easy',
  budget: 'simple',
  category: 'edit',
  mode: 'agent',
  async setup(workspace) {
    await writeFixtureFile(
      workspace,
      'styles/main.css',
      ['body {', '  margin: 0;', '  padding: 0;', '}', ''].join('\n')
    );
  },
  prompt:
    'Add `box-sizing: border-box;` to the body rule in styles/main.css. You may use edit_file with markers or a full rewrite.',
  checkOutcome: async (workspace) => {
    const content = await readFixtureFile(workspace, 'styles/main.css');
    if (content.includes('box-sizing: border-box')) {
      return { pass: true };
    }
    return { pass: false, details: 'box-sizing rule missing from main.css' };
  },
};

export const easyReadAndAnswer: EvalScenario = {
  id: 'easy-read-and-answer',
  difficulty: 'easy',
  budget: 'simple',
  category: 'read',
  mode: 'agent',
  async setup(workspace) {
    await writeFixtureFile(workspace, 'config.txt', 'app_name=MyApp\nversion=2\n');
  },
  prompt: 'Read config.txt and tell me the value of app_name.',
  checkOutcome: (_workspace, trace) => {
    const readOk = trace.events.some(
      (e) => e.type === 'tool.call.result' && e.toolName === 'read_file' && e.ok
    );
    const text = trace.messages
      .filter((m) => m.role === 'assistant')
      .map((m) => m.content)
      .join(' ');
    if (readOk && text.includes('MyApp')) {
      return { pass: true };
    }
    return { pass: false, details: 'Expected read_file success and MyApp in response' };
  },
};

export const easyPlanNoWrite: EvalScenario = {
  id: 'easy-plan-no-write',
  difficulty: 'easy',
  budget: 'simple',
  category: 'policy',
  mode: 'plan',
  async setup(workspace) {
    await writeFixtureFile(workspace, 'README.md', '# Sample\n');
  },
  prompt: 'Create a new file output.txt with the text "done".',
  checkOutcome: async (workspace, trace) => {
    const editCalls = trace.events.filter(
      (e) => e.type === 'tool.call.start' && e.toolName === 'edit_file'
    );
    let outputExists = false;
    try {
      await readFixtureFile(workspace, 'output.txt');
      outputExists = true;
    } catch {
      outputExists = false;
    }
    if (wasPolicyBlocked(trace, 'edit_file') || (editCalls.length === 0 && !outputExists)) {
      const score = mentionsModeSwitch(trace) || wasPolicyBlocked(trace, 'edit_file') ? 100 : 85;
      return { pass: !outputExists, score };
    }
    return { pass: false, details: 'edit_file should be blocked in plan mode' };
  },
};

export const easyCreateFile: EvalScenario = {
  id: 'easy-create-file',
  difficulty: 'easy',
  budget: 'simple',
  category: 'edit',
  mode: 'agent',
  async setup(_workspace) {},
  prompt: 'Create hello.txt in the workspace root with the single line: Hello World',
  checkOutcome: async (workspace) => {
    try {
      const content = await readFixtureFile(workspace, 'hello.txt');
      if (content.trim() === 'Hello World') return { pass: true };
      return { pass: false, details: 'hello.txt content mismatch' };
    } catch {
      return { pass: false, details: 'hello.txt was not created' };
    }
  },
};

export const easyListRoot: EvalScenario = {
  id: 'easy-list-root',
  difficulty: 'easy',
  budget: 'simple',
  category: 'read',
  mode: 'agent',
  async setup(workspace) {
    await writeFixtureFile(workspace, 'alpha.txt', 'a\n');
    await writeFixtureFile(workspace, 'beta.txt', 'b\n');
  },
  prompt:
    'List files in the workspace root directory using list_dir with target_directory "."',
  checkOutcome: (_workspace, trace) => {
    const ok = trace.events.some(
      (e) => e.type === 'tool.call.result' && e.toolName === 'list_dir' && e.ok
    );
    return ok ? { pass: true } : { pass: false, details: 'list_dir did not succeed' };
  },
};

export const easyNoSpuriousEdit: EvalScenario = {
  id: 'easy-no-spurious-edit',
  difficulty: 'easy',
  budget: 'simple',
  category: 'read',
  mode: 'agent',
  async setup(workspace) {
    await writeFixtureFile(workspace, 'notes.md', '# Notes\nNothing to change.\n');
  },
  prompt: 'Read notes.md and summarize it in one sentence. Do not modify any files.',
  checkOutcome: async (workspace, trace) => {
    const edits = trace.events.filter(
      (e) => e.type === 'tool.call.start' && e.toolName === 'edit_file'
    );
    const content = await readFixtureFile(workspace, 'notes.md');
    if (edits.length === 0 && content.includes('Nothing to change')) {
      return { pass: true };
    }
    return { pass: false, details: 'File should remain unchanged' };
  },
};

export const EASY_SCENARIOS: EvalScenario[] = [
  easyCssAddRule,
  easyReadAndAnswer,
  easyPlanNoWrite,
  easyCreateFile,
  easyListRoot,
  easyNoSpuriousEdit,
];
