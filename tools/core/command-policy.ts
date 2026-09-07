export interface CommandPolicyResult {
  blocked: boolean;
  reason?: string;
}

const SAFE_FOREGROUND_PATTERNS: RegExp[] = [
  /\b(npm|pnpm|yarn|bun)\s+create\s+\S+/i,
  /\bnpx\s+create-\S+/i,
  /\b(npm|pnpm|yarn|bun)\s+(install|add|ci|update)\b/i,
  /\b(npm|pnpm|yarn|bun)\s+run\s+build\b/i,
];

const CMD_SEGMENT_START = /(?:^|[;&|]\s*|\s&&\s*)/;

const LONG_RUNNING_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\b(npm|pnpm|yarn|bun)\s+run\s+(dev|start|serve|watch)\b/i,
    reason: 'package dev/start/serve/watch scripts start long-running processes',
  },
  {
    pattern: /\bnpx\s+(?!create-)(vite|next|nuxt|webpack|parcel|astro|remix)\b/i,
    reason: 'dev server commands run indefinitely',
  },
  {
    pattern: new RegExp(
      `${CMD_SEGMENT_START.source}(vite(\\s+(dev|preview))?|next\\s+dev|nuxt\\s+dev|webpack-dev-server|parcel\\s+serve)(\\s|$)`,
      'i'
    ),
    reason: 'dev server commands run indefinitely',
  },
  {
    pattern: /\b(tsc|jest|vitest|mocha)\b.*\b(--watch|-w)\b/i,
    reason: 'watch mode runs indefinitely',
  },
  {
    pattern: /\b--watch\b/,
    reason: 'watch flag starts a long-running process',
  },
  {
    pattern: /\btail\s+(-f|--follow)\b/i,
    reason: 'tail -f produces continuous output',
  },
  {
    pattern: /\b(journalctl|kubectl\s+logs)\s+.*\s(-f|--follow)\b/i,
    reason: 'log follow commands run indefinitely',
  },
  {
    pattern: /\bping\b/i,
    reason: 'ping runs continuously',
  },
  {
    pattern: /\bwatch\s+\d/i,
    reason: 'watch command repeats indefinitely',
  },
  {
    pattern: /\b(less|more|vim|vi|nano|top|htop|tmux|screen)\b/i,
    reason: 'interactive pager/editor/terminal multiplexer',
  },
];

function isSafeForegroundCommand(command: string): boolean {
  return SAFE_FOREGROUND_PATTERNS.some((pattern) => pattern.test(command));
}

export function checkCommandPolicy(command: string, isBackground = false): CommandPolicyResult {
  const trimmed = command.trim();
  if (!trimmed) return { blocked: false };

  if (isBackground) {
    return { blocked: false };
  }

  if (isSafeForegroundCommand(trimmed)) {
    return { blocked: false };
  }

  for (const { pattern, reason } of LONG_RUNNING_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        blocked: true,
        reason:
          `ERROR: This command cannot be run via run_terminal_cmd (${reason}). ` +
          'Use is_background: true for long-running processes, or ask the user to run it in their own terminal.',
      };
    }
  }

  return { blocked: false };
}
