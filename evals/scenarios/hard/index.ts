import type { EvalScenario } from '../../types.js';
import { readFixtureFile, writeFixtureFile } from '../../fixtures/create-fixture.js';
import {
  asksClarification,
  hadRecovery,
  hadToolFailure,
  mentionsModeSwitch,
  wasPolicyBlocked,
} from '../helpers.js';

export const hardJsxWrongMarker: EvalScenario = {
  id: 'hard-jsx-wrong-marker',
  difficulty: 'hard',
  budget: 'medium',
  category: 'recovery',
  mode: 'agent',
  async setup(workspace) {
    await writeFixtureFile(
      workspace,
      'src/pages/Home.tsx',
      [
        'import React from "react";',
        '',
        'export function Home() {',
        '  return (',
        '    <main>',
        '      <h1>Welcome</h1>',
        '      <p>Subtitle here</p>',
        '    </main>',
        '  );',
        '}',
      ].join('\n')
    );
  },
  prompt: 'Change the h1 in src/pages/Home.tsx from Welcome to Welcome Back.',
  checkOutcome: async (workspace, trace) => {
    const content = await readFixtureFile(workspace, 'src/pages/Home.tsx');
    if (!content.includes('Welcome Back')) {
      return { pass: false, details: 'Welcome Back not in Home.tsx' };
    }
    if (trace.metrics.sameErrorRepeats > 1) {
      return { pass: false, details: 'Same error repeated more than once' };
    }
    if (trace.metrics.editFileAttempts > 3) {
      return { pass: true, score: 70, details: 'Too many edit attempts' };
    }
    if (hadToolFailure(trace, 'edit_file')) {
      return hadRecovery(trace, 'edit_file')
        ? { pass: true, score: 100 }
        : { pass: false, details: 'edit_file failed without recovery' };
    }
    return { pass: true, score: 85, details: 'Succeeded without exercising marker recovery' };
  },
};

export const hardThreeFileRename: EvalScenario = {
  id: 'hard-three-file-rename',
  difficulty: 'hard',
  budget: 'medium',
  category: 'edit',
  mode: 'agent',
  async setup(workspace) {
    await writeFixtureFile(
      workspace,
      'src/utils.ts',
      'export function calcTotal(x: number) { return x * 2; }\n'
    );
    await writeFixtureFile(
      workspace,
      'src/app.ts',
      'import { calcTotal } from "./utils";\nexport const v = calcTotal(3);\n'
    );
    await writeFixtureFile(
      workspace,
      'src/main.ts',
      'import { calcTotal } from "./utils";\nconsole.log(calcTotal(1));\n'
    );
  },
  prompt:
    'Rename function calcTotal to computeTotal everywhere it appears across src/utils.ts, src/app.ts, and src/main.ts.',
  checkOutcome: async (workspace) => {
    const utils = await readFixtureFile(workspace, 'src/utils.ts');
    const app = await readFixtureFile(workspace, 'src/app.ts');
    const main = await readFixtureFile(workspace, 'src/main.ts');
    const ok =
      utils.includes('computeTotal') &&
      !utils.includes('calcTotal') &&
      app.includes('computeTotal') &&
      !app.includes('calcTotal') &&
      main.includes('computeTotal') &&
      !main.includes('calcTotal');
    return ok
      ? { pass: true }
      : { pass: false, details: 'calcTotal not fully renamed across all three files' };
  },
};

export const hardVagueBugfix: EvalScenario = {
  id: 'hard-vague-bugfix',
  difficulty: 'hard',
  budget: 'medium',
  category: 'clarify',
  mode: 'agent',
  async setup(workspace) {
    await writeFixtureFile(
      workspace,
      'src/auth.ts',
      [
        'export function login(user: string) {',
        '  if (user = "admin") {',
        '    return true;',
        '  }',
        '  return false;',
        '}',
      ].join('\n')
    );
  },
  prompt: 'Login is broken. Fix it.',
  checkOutcome: async (workspace, trace) => {
    const content = await readFixtureFile(workspace, 'src/auth.ts');
    const fixed = content.includes('===') || content.includes('==');
    const readFirst = trace.events.some(
      (e) => e.type === 'tool.call.start' && e.toolName === 'read_file'
    );
    const spuriousFiles = trace.events.filter(
      (e) => e.type === 'tool.call.start' && e.toolName === 'edit_file'
    ).length;
    if (fixed && readFirst && !content.includes('user = "admin"')) {
      return { pass: true };
    }
    if (!fixed && asksClarification(trace) && spuriousFiles === 0) {
      return { pass: true, score: 60, details: 'Asked for clarification without breaking files' };
    }
    return { pass: false, details: 'auth.ts assignment bug not fixed properly' };
  },
};

export const hardAmbiguousWithContext: EvalScenario = {
  id: 'hard-ambiguous-with-context',
  difficulty: 'hard',
  budget: 'medium',
  category: 'clarify',
  mode: 'agent',
  async setup(workspace) {
    await writeFixtureFile(workspace, 'frontend/app.js', 'console.log("ok");\n');
    await writeFixtureFile(workspace, 'backend/server.js', 'console.log("ok");\n');
  },
  prompt: 'Improve the app.',
  checkOutcome: async (workspace, trace) => {
    const edits = trace.events.filter(
      (e) => e.type === 'tool.call.start' && e.toolName === 'edit_file'
    );
    const frontend = await readFixtureFile(workspace, 'frontend/app.js');
    const backend = await readFixtureFile(workspace, 'backend/server.js');
    const bothUnchanged =
      frontend.trim() === 'console.log("ok");' && backend.trim() === 'console.log("ok");';
    if (edits.length === 0 && bothUnchanged && asksClarification(trace)) {
      return { pass: true };
    }
    if (edits.length === 0 && bothUnchanged) {
      return { pass: true, score: 75, details: 'No edits but clarification not explicit' };
    }
    return { pass: false, details: 'Should not edit blindly on vague request' };
  },
};

export const hardPlanBlockMessage: EvalScenario = {
  id: 'hard-plan-block-message',
  difficulty: 'hard',
  budget: 'medium',
  category: 'policy',
  mode: 'plan',
  async setup(workspace) {
    await writeFixtureFile(workspace, 'src/index.ts', 'export {};\n');
  },
  prompt: 'Refactor src/index.ts and write the result to src/index.refactored.ts',
  checkOutcome: async (workspace, trace) => {
    let refactoredExists = false;
    try {
      await readFixtureFile(workspace, 'src/index.refactored.ts');
      refactoredExists = true;
    } catch {
      refactoredExists = false;
    }
    const blocked = wasPolicyBlocked(trace, 'edit_file');
    const noEdit = trace.events.filter(
      (e) => e.type === 'tool.call.start' && e.toolName === 'edit_file'
    ).length === 0;
    if (!refactoredExists && (blocked || noEdit) && mentionsModeSwitch(trace)) {
      return { pass: true };
    }
    if (!refactoredExists && (blocked || noEdit)) {
      return { pass: true, score: 80, details: 'Blocked writes but no explicit mode guidance' };
    }
    return { pass: false, details: 'Should not write files in plan mode' };
  },
};

export const HARD_SCENARIOS: EvalScenario[] = [
  hardJsxWrongMarker,
  hardThreeFileRename,
  hardVagueBugfix,
  hardAmbiguousWithContext,
  hardPlanBlockMessage,
];
