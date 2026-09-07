import type { EvalScenario } from '../../types.js';
import { readFixtureFile, writeFixtureFile } from '../../fixtures/create-fixture.js';
import {
  hadRecovery,
  hadToolFailure,
  mentionsModeSwitch,
  wasPolicyBlocked,
} from '../helpers.js';

export const challengingLargePartialRecovery: EvalScenario = {
  id: 'challenging-large-partial-recovery',
  difficulty: 'challenging',
  budget: 'medium',
  category: 'recovery',
  mode: 'agent',
  async setup(workspace) {
    const lines = Array.from({ length: 30 }, (_, i) => `line${i + 1} = ${i + 1};`);
    await writeFixtureFile(workspace, 'src/large.ts', lines.join('\n') + '\n');
  },
  prompt: 'Change line5 assignment to 99 in src/large.ts.',
  checkOutcome: async (workspace, trace) => {
    const content = await readFixtureFile(workspace, 'src/large.ts');
    if (!content.includes('line5 = 99')) {
      return { pass: false, details: 'line5 not updated' };
    }
    if (trace.metrics.sameErrorRepeats > 1) {
      return { pass: false, details: 'Error loop detected' };
    }
    if (trace.metrics.editFileAttempts > 3) {
      return { pass: true, score: 65, details: 'Too many edit attempts' };
    }
    if (hadToolFailure(trace, 'edit_file') && !hadRecovery(trace, 'edit_file')) {
      return { pass: false, details: 'edit failed without recovery' };
    }
    if (hadRecovery(trace, 'edit_file')) {
      return { pass: true, score: 100 };
    }
    return { pass: true, score: 80, details: 'Succeeded without exercising recovery path' };
  },
};

export const challengingMultiFileRefactor: EvalScenario = {
  id: 'challenging-multi-file-refactor',
  difficulty: 'challenging',
  budget: 'medium',
  category: 'edit',
  mode: 'agent',
  async setup(workspace) {
    await writeFixtureFile(
      workspace,
      'src/core/math.ts',
      'export function calcTotal(x: number) { return x * 2; }\n'
    );
    await writeFixtureFile(
      workspace,
      'src/app.ts',
      'import { calcTotal } from "./core/math";\nexport const value = calcTotal(3);\n'
    );
    await writeFixtureFile(
      workspace,
      'src/main.ts',
      'import { calcTotal } from "./core/math";\nconsole.log(calcTotal(1));\n'
    );
    await writeFixtureFile(
      workspace,
      'src/report.ts',
      'import { calcTotal } from "./core/math";\nexport const report = calcTotal(10);\n'
    );
  },
  prompt:
    'Rename calcTotal to computeTotal across all files under src/ that use it. Update imports and call sites consistently.',
  checkOutcome: async (workspace) => {
    const files = ['src/core/math.ts', 'src/app.ts', 'src/main.ts', 'src/report.ts'];
    for (const file of files) {
      const content = await readFixtureFile(workspace, file);
      if (!content.includes('computeTotal') || content.includes('calcTotal')) {
        return { pass: false, details: `${file} not fully renamed` };
      }
    }
    return { pass: true };
  },
};

export const challengingJsxNestedMarker: EvalScenario = {
  id: 'challenging-jsx-nested-marker',
  difficulty: 'challenging',
  budget: 'medium',
  category: 'recovery',
  mode: 'agent',
  async setup(workspace) {
    await writeFixtureFile(
      workspace,
      'src/Dashboard.tsx',
      [
        'import React from "react";',
        '',
        'export function Dashboard() {',
        '  return (',
        '    <div className="dashboard">',
        '      <header>',
        '        <h1>Dashboard</h1>',
        '      </header>',
        '      <section>',
        '        <p>Welcome user</p>',
        '      </section>',
        '    </div>',
        '  );',
        '}',
      ].join('\n')
    );
  },
  prompt: 'Change the h1 text in src/Dashboard.tsx from Dashboard to Control Panel.',
  checkOutcome: async (workspace, trace) => {
    const content = await readFixtureFile(workspace, 'src/Dashboard.tsx');
    if (!content.includes('Control Panel')) {
      return { pass: false, details: 'Control Panel not found in Dashboard.tsx' };
    }
    if (trace.metrics.sameErrorRepeats > 1) {
      return { pass: false, details: 'Same error repeated more than once' };
    }
    if (hadToolFailure(trace, 'edit_file')) {
      return hadRecovery(trace, 'edit_file')
        ? { pass: true, score: 100 }
        : { pass: false, details: 'JSX marker edit failed without recovery' };
    }
    return { pass: true, score: 75, details: 'No failure path exercised' };
  },
};

export const challengingCrossFileBugfix: EvalScenario = {
  id: 'challenging-cross-file-bugfix',
  difficulty: 'challenging',
  budget: 'medium',
  category: 'clarify',
  mode: 'agent',
  async setup(workspace) {
    await writeFixtureFile(
      workspace,
      'src/api/client.ts',
      [
        'import { getBaseUrl } from "./config";',
        'export function fetchUser() {',
        '  return fetch(getBaseUrl() + "/user");',
        '}',
      ].join('\n')
    );
    await writeFixtureFile(
      workspace,
      'src/api/config.ts',
      'export function getBaseUrl() { return "http://localhost:3000"; }\n'
    );
    await writeFixtureFile(
      workspace,
      'logs/error.log',
      'ERROR: GET /user returned 404 - endpoint not found at /user\n'
    );
  },
  prompt: 'API calls are failing. Fix the issue.',
  checkOutcome: async (workspace, trace) => {
    const client = await readFixtureFile(workspace, 'src/api/client.ts');
    const explored = trace.events.some(
      (e) =>
        e.type === 'tool.call.start' &&
        (e.toolName === 'read_file' || e.toolName === 'grep')
    );
    if (!explored) {
      return { pass: false, details: 'Did not explore files before editing' };
    }
    if (client.includes('/users')) {
      return { pass: true };
    }
    if (client.includes('/user')) {
      return { pass: false, details: 'Still using wrong /user endpoint' };
    }
    return { pass: false, details: 'API endpoint not fixed' };
  },
};

export const challengingPlanThenAgent: EvalScenario = {
  id: 'challenging-plan-then-agent',
  difficulty: 'challenging',
  budget: 'medium',
  category: 'policy',
  mode: 'plan',
  async setup(workspace) {
    await writeFixtureFile(workspace, 'src/feature.ts', 'export const enabled = false;\n');
  },
  prompt:
    'Implement a new file src/feature.config.ts that exports { enabled: true } and update src/feature.ts to import from it.',
  checkOutcome: async (workspace, trace) => {
    let configExists = false;
    try {
      await readFixtureFile(workspace, 'src/feature.config.ts');
      configExists = true;
    } catch {
      configExists = false;
    }
    const blocked = wasPolicyBlocked(trace, 'edit_file');
    const noEdit =
      trace.events.filter((e) => e.type === 'tool.call.start' && e.toolName === 'edit_file')
        .length === 0;
    if (!configExists && (blocked || noEdit) && mentionsModeSwitch(trace)) {
      return { pass: true };
    }
    if (!configExists && (blocked || noEdit)) {
      return { pass: true, score: 80, details: 'Blocked writes but no explicit mode guidance' };
    }
    return { pass: false, details: 'Should not create files in plan mode' };
  },
};

export const CHALLENGING_SCENARIOS: EvalScenario[] = [
  challengingLargePartialRecovery,
  challengingMultiFileRefactor,
  challengingJsxNestedMarker,
  challengingCrossFileBugfix,
  challengingPlanThenAgent,
];
