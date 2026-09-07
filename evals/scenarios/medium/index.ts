import type { EvalScenario } from '../../types.js';
import { readFixtureFile, writeFixtureFile } from '../../fixtures/create-fixture.js';
import {
  hadRecovery,
  hadToolFailure,
  hadToolSuccess,
} from '../helpers.js';

export const mediumJsxRename: EvalScenario = {
  id: 'medium-jsx-rename',
  difficulty: 'medium',
  budget: 'medium',
  category: 'edit',
  mode: 'agent',
  async setup(workspace) {
    await writeFixtureFile(
      workspace,
      'src/App.tsx',
      [
        'export function App() {',
        '  return (',
        '    <div className="app">',
        '      <h1>Hello</h1>',
        '    </div>',
        '  );',
        '}',
      ].join('\n')
    );
  },
  prompt: 'Change the h1 text in src/App.tsx from Hello to Hello World.',
  checkOutcome: async (workspace, trace) => {
    const content = await readFixtureFile(workspace, 'src/App.tsx');
    if (!content.includes('Hello World')) {
      return { pass: false, details: 'Hello World not found in App.tsx' };
    }
    if (hadToolFailure(trace, 'edit_file')) {
      return hadRecovery(trace, 'edit_file')
        ? { pass: true, score: 100 }
        : { pass: false, details: 'edit_file failed without recovery' };
    }
    return { pass: true, score: 100 };
  },
};

export const mediumTwoFileMerge: EvalScenario = {
  id: 'medium-two-file-merge',
  difficulty: 'medium',
  budget: 'medium',
  category: 'chain',
  mode: 'agent',
  async setup(workspace) {
    await writeFixtureFile(workspace, 'pkg/a.txt', 'alpha\n');
    await writeFixtureFile(workspace, 'pkg/b.txt', 'beta\n');
  },
  prompt:
    'Read pkg/a.txt and pkg/b.txt, then create pkg/combined.txt with both contents separated by a newline.',
  checkOutcome: async (workspace, trace) => {
    const reads = trace.events.filter(
      (e) => e.type === 'tool.call.start' && e.toolName === 'read_file'
    );
    try {
      const combined = await readFixtureFile(workspace, 'pkg/combined.txt');
      const ok = combined.includes('alpha') && combined.includes('beta');
      if (ok && reads.length >= 2) return { pass: true };
      return { pass: false, details: 'combined.txt wrong or insufficient reads' };
    } catch {
      return { pass: false, details: 'pkg/combined.txt not created' };
    }
  },
};

export const mediumListDirRecovery: EvalScenario = {
  id: 'medium-list-dir-recovery',
  difficulty: 'medium',
  budget: 'medium',
  category: 'recovery',
  mode: 'agent',
  async setup(workspace) {
    await writeFixtureFile(workspace, 'data/item.txt', 'x\n');
  },
  prompt: 'List what files are in the workspace root.',
  checkOutcome: (_workspace, trace) => {
    if (!hadToolSuccess(trace, 'list_dir')) {
      return { pass: false, details: 'list_dir never succeeded' };
    }
    if (hadToolFailure(trace, 'list_dir') && hadRecovery(trace, 'list_dir')) {
      return { pass: true, score: 100 };
    }
    if (hadToolFailure(trace, 'list_dir')) {
      return { pass: true, score: 85, details: 'Succeeded after validation error but no clear recovery streak' };
    }
    return { pass: true, score: 90, details: 'Succeeded first try without exercising recovery' };
  },
};

export const mediumCssPartial: EvalScenario = {
  id: 'medium-css-partial',
  difficulty: 'medium',
  budget: 'medium',
  category: 'edit',
  mode: 'agent',
  async setup(workspace) {
    await writeFixtureFile(
      workspace,
      'app.css',
      ['.btn {', '  color: blue;', '  padding: 8px;', '}', ''].join('\n')
    );
  },
  prompt: 'In app.css change the button text color from blue to green using a partial edit.',
  checkOutcome: async (workspace, trace) => {
    const content = await readFixtureFile(workspace, 'app.css');
    if (!content.includes('green')) {
      return { pass: false, details: 'color not updated to green' };
    }
    if (hadToolFailure(trace, 'edit_file')) {
      return hadRecovery(trace, 'edit_file')
        ? { pass: true, score: 100 }
        : { pass: true, score: 75, details: 'Edit succeeded after failures without clean recovery' };
    }
    return { pass: true };
  },
};

export const mediumReadBeforeEdit: EvalScenario = {
  id: 'medium-read-before-edit',
  difficulty: 'medium',
  budget: 'medium',
  category: 'chain',
  mode: 'agent',
  async setup(workspace) {
    await writeFixtureFile(workspace, 'src/util.ts', 'export const VERSION = 1;\n');
  },
  prompt: 'Bump VERSION from 1 to 2 in src/util.ts.',
  checkOutcome: async (workspace, trace) => {
    const content = await readFixtureFile(workspace, 'src/util.ts');
    const read = trace.events.some(
      (e) => e.type === 'tool.call.start' && e.toolName === 'read_file'
    );
    if (content.includes('VERSION = 2') && read) {
      return { pass: true };
    }
    return { pass: false, details: 'VERSION not updated or file not read first' };
  },
};

export const mediumGrepThenEdit: EvalScenario = {
  id: 'medium-grep-then-edit',
  difficulty: 'medium',
  budget: 'medium',
  category: 'chain',
  mode: 'agent',
  async setup(workspace) {
    await writeFixtureFile(workspace, 'lib/math.ts', 'export function add(a: number, b: number) { return a + b; }\n');
    await writeFixtureFile(workspace, 'lib/string.ts', 'export function join(a: string, b: string) { return a + b; }\n');
  },
  prompt:
    'Find which file under lib/ defines the add function, then rename add to sum in that file only.',
  checkOutcome: async (workspace, trace) => {
    const math = await readFixtureFile(workspace, 'lib/math.ts');
    const str = await readFixtureFile(workspace, 'lib/string.ts');
    const grepUsed = trace.events.some((e) => e.type === 'tool.call.start' && e.toolName === 'grep');
    const readOrGrep = grepUsed ||
      trace.events.some((e) => e.type === 'tool.call.start' && e.toolName === 'read_file');
    if (math.includes('function sum') && !str.includes('function sum') && readOrGrep) {
      return { pass: true };
    }
    return { pass: false, details: 'add not renamed correctly in math.ts only' };
  },
};

export const MEDIUM_SCENARIOS: EvalScenario[] = [
  mediumJsxRename,
  mediumTwoFileMerge,
  mediumListDirRecovery,
  mediumCssPartial,
  mediumReadBeforeEdit,
  mediumGrepThenEdit,
];
