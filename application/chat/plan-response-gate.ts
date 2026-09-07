/** Max retries after rejecting a Plan-mode code dump before sanitizing. */
export const PLAN_CODE_DUMP_RETRY_BUDGET = 2;

/** Fenced body this many lines or more counts as a dump even without a language tag. */
const FENCE_LINE_THRESHOLD = 12;

const FENCE_RE = /```([a-zA-Z0-9_+-]*)\r?\n([\s\S]*?)```/g;

const IMPLEMENTATION_LANGS = new Set([
  'html',
  'htm',
  'css',
  'scss',
  'less',
  'js',
  'javascript',
  'ts',
  'typescript',
  'tsx',
  'jsx',
  'python',
  'py',
  'java',
  'go',
  'rust',
  'c',
  'cpp',
  'csharp',
  'cs',
  'php',
  'ruby',
  'swift',
  'kotlin',
  'sql',
  'bash',
  'shell',
  'sh',
  'powershell',
  'ps1',
  'json',
  'yaml',
  'yml',
  'xml',
  'vue',
  'svelte',
]);

const DUMP_MARKERS = [
  /<!DOCTYPE\s+html/i,
  /<html[\s>]/i,
  /\bfunction\s+\w+\s*\(/,
  /\bexport\s+(default\s+)?(function|class|const)\b/,
  /\bpackage\s+main\b/,
  /\bdef\s+\w+\s*\(/,
];

function countLines(text: string): number {
  if (!text) return 0;
  return text.replace(/\r\n/g, '\n').split('\n').length;
}

/**
 * True when the assistant reply looks like an implementable code dump
 * rather than a high-level Plan-mode step list.
 */
export function looksLikeCodeDump(content: string | undefined | null): boolean {
  if (!content || !content.trim()) return false;

  const fences = [...content.matchAll(FENCE_RE)];
  for (const match of fences) {
    const lang = (match[1] || '').trim().toLowerCase();
    const body = match[2] || '';
    if (lang && IMPLEMENTATION_LANGS.has(lang)) return true;
    if (countLines(body) >= FENCE_LINE_THRESHOLD) return true;
    if (DUMP_MARKERS.some((re) => re.test(body))) return true;
  }

  // Unfenced full HTML documents still count.
  if (/<!DOCTYPE\s+html/i.test(content) && countLines(content) >= FENCE_LINE_THRESHOLD) {
    return true;
  }

  return false;
}

export function buildPlanCodeDumpNotice(): string {
  return (
    `<system_reminder>\n` +
    `PLAN mode rejected your reply: it contained implementable code (fenced blocks or a full document). ` +
    `Do NOT paste HTML/CSS/JS or any full file contents.\n` +
    `Rewrite now as a Plan-only answer:\n` +
    `1. Call todo_write once (merge: false) with the implementation steps if you have not already this turn.\n` +
    `2. Present a short numbered step list with rationale only — file names ok, no fenced code.\n` +
    `3. End with the exact instruction to switch using /mode agent to apply changes.\n` +
    `</system_reminder>`
  );
}

/**
 * Remove fenced code blocks for a last-resort Plan reply after retry budget is spent.
 */
export function stripCodeFences(content: string): string {
  const withoutFences = content.replace(FENCE_RE, '').replace(/\n{3,}/g, '\n\n').trim();
  const body =
    withoutFences ||
    'Plan mode blocked a code dump. Switch to Agent mode with /mode agent to implement files.';

  const hasModeHint = /\/mode\s+agent/i.test(body);
  const footer = hasModeHint
    ? ''
    : '\n\nTo apply changes, switch to Agent mode with `/mode agent`.';

  return (
    `${body}${footer}\n\n` +
    `(Code blocks were removed because PLAN mode does not allow implementable dumps.)`
  );
}

export function buildPlanCodeDumpExhaustedMessage(rawContent: string): string {
  return stripCodeFences(rawContent);
}

/** Max retries when Plan ends with a step list but never called todo_write. */
export const PLAN_MISSING_TODO_RETRY_BUDGET = 2;

/** True when the reply looks like a multi-step plan that should be persisted. */
export function looksLikePlanStepList(content: string | undefined | null): boolean {
  if (!content || !content.trim()) return false;
  const numbered = content.match(/^\s*\d+[\.)]\s+\S+/gm);
  if (numbered && numbered.length >= 2) return true;
  if (/\/mode\s+agent/i.test(content) && /^\s*[-*]\s+\S+/m.test(content)) return true;
  return false;
}

export function buildPlanMissingTodoNotice(): string {
  return (
    `<system_reminder>\n` +
    `PLAN mode requires you to persist the plan with todo_write before finishing. ` +
    `You wrote steps in plain text but did not call todo_write.\n` +
    `Call todo_write once now with merge: false and one pending item per step (id + content). ` +
    `Do not use fenced code. After the tool result, briefly restate the plan and end with /mode agent.\n` +
    `</system_reminder>`
  );
}
