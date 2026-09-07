import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      include: [
        'tools/core/edit-diff.ts',
        'tools/core/edit-merge.ts',
        'tools/core/shell-session.ts',
        'application/chat/tool-policy.ts',
        'application/chat/tool-execution.ts',
        'domain/agent-mode.ts',
        'application/prompt/tool-schema-hints.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 85,
        branches: 60,
        statements: 80,
      },
    },
  },
});
