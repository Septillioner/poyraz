import type { PromptHintTier } from '../../domain/model-profile.js';

interface ToolHint {
  required: string[];
  optional?: string[];
  example: string;
  altExamples?: string[];
}

interface ToolGuidance {
  whenToUse: string[];
  whenNotToUse: string[];
  examples: string[];
}

const TOOL_HINTS: Record<string, ToolHint> = {
  read_file: {
    required: ['target_file'],
    optional: ['offset', 'limit'],
    example: '{ "target_file": "src/index.ts" }',
    altExamples: [
      '{ "target_file": "poyraz/application/prompt/system-prompt.ts", "offset": 100, "limit": 40 }',
    ],
  },
  edit_file: {
    required: ['target_file', 'code_edit'],
    optional: ['instructions'],
    example:
      '{ "target_file": "index.js", "code_edit": "// ... existing code ...\\nconsole.log(\\"hello\\");\\n// ... existing code ..." }',
    altExamples: [
      '{ "target_file": "POYRAZ.md", "instructions": "Append user preference note.", "code_edit": "## User\\n- Name: Ege" }',
    ],
  },
  list_dir: {
    required: ['target_directory'],
    optional: ['ignore_globs'],
    example: '{ "target_directory": "poyraz/application" }',
    altExamples: ['{ "target_directory": ".", "ignore_globs": ["**/node_modules/**"] }'],
  },
  glob_file_search: {
    required: ['glob_pattern'],
    optional: ['target_directory'],
    example: '{ "glob_pattern": "**/index.ts" }',
    altExamples: ['{ "glob_pattern": "**/test_*.ts", "target_directory": "poyraz" }'],
  },
  delete_file: {
    required: ['target_file'],
    example: '{ "target_file": "temp.txt" }',
  },
  grep: {
    required: ['pattern'],
    optional: [
      'path',
      'glob',
      'output_mode',
      '-B',
      '-A',
      '-C',
      '-i',
      'type',
      'head_limit',
      'multiline',
    ],
    example: '{ "pattern": "buildSystemPrompt", "path": "poyraz" }',
    altExamples: [
      '{ "pattern": "todo_write", "glob": "*.ts", "head_limit": 20, "-A": 2 }',
      '{ "pattern": "export function", "output_mode": "files_with_matches", "path": "poyraz" }',
    ],
  },
  run_terminal_cmd: {
    required: ['command', 'is_background'],
    optional: ['explanation'],
    example: '{ "command": "npm run build", "is_background": false }',
    altExamples: [
      '{ "command": "mkdir my-app && cd my-app && mkdir frontend && mkdir backend", "is_background": false }',
      '{ "command": "cd my-app && npm install", "is_background": false }',
      '{ "command": "cd my-app && npm run dev", "is_background": true }',
      '{ "command": "npm create vite@latest my-app -- --template react", "is_background": false }',
    ],
  },
  todo_write: {
    required: ['merge', 'todos'],
    example:
      '{ "merge": false, "todos": [{ "id": "1", "content": "Step one", "status": "pending" }, { "id": "2", "content": "Step two", "status": "pending" }] }',
    altExamples: [
      '{ "merge": true, "todos": [{ "id": "1", "content": "Step one", "status": "completed" }] }',
      '{ "merge": true, "todos": [{ "id": "2", "content": "Step two", "status": "blocked", "blockedReason": "Missing API credentials" }] }',
    ],
  },
  http_request: {
    required: ['url', 'method'],
    optional: ['headers', 'body'],
    example: '{ "url": "https://api.example.com/health", "method": "GET" }',
  },
};

const TOOL_GUIDANCE: Record<string, ToolGuidance> = {
  read_file: {
    whenToUse: [
      'Read a known file path before editing or explaining it',
      'Verify file contents after a failed edit',
      'Read POYRAZ.md at task start for persistent context',
      'Use offset/limit for large files instead of reading entirely',
    ],
    whenNotToUse: [
      'Finding which files exist — use glob_file_search or list_dir first',
      'Searching for a symbol across the repo — use grep',
      'Editing without reading when you are unsure of current content',
    ],
    examples: [
      '<example>\nGood: Batch-read related files in parallel before a refactor.\nread_file: { "target_file": "poyraz/application/agent/agent.ts" }\nread_file: { "target_file": "poyraz/application/prompt/system-prompt.ts" }\n</example>',
      '<example>\nBad: Guess file contents and call edit_file without reading.\n</example>',
      '<example>\nGood: Large file — read a window:\n{ "target_file": "references/cursor_prompt.txt", "offset": 500, "limit": 80 }\n</example>',
    ],
  },
  edit_file: {
    whenToUse: [
      'Create, modify, or delete content in a file (including POYRAZ.md notes)',
      'User asks for code, examples, or "örnek" — write files, do not dump code in chat',
      'Apply fixes after reading the current file state',
      'Small files (~150 lines) with UI structure changes — full file in code_edit',
    ],
    whenNotToUse: [
      'Plan or Ask mode (read-only) — tell user to switch to Agent mode',
      'Showing code only when user said "just show me" without writing files',
      'Deleting an entire file — prefer delete_file when appropriate',
      'Marker-less snippet on existing file — rejected; use markers or full rewrite',
    ],
    examples: [
      '<example>\nGood: Partial edit with markers:\n{ "target_file": "src/app.ts", "code_edit": "// ... existing code ...\\nimport { foo } from \'./foo\';\\n// ... existing code ..." }\n</example>',
      '<example>\nGood: JSX partial inside return:\n{ "target_file": "src/App.jsx", "code_edit": "{/* ... existing code ... */}\\n<section>New</section>\\n{/* ... existing code ... */}" }\n</example>',
      '<example>\nBad: Snippet without markers on existing file — rejected.\n</example>',
      '<example>\nBad: Stacking partial fixes after PARSE_ERROR — read full file and rewrite.\n</example>',
    ],
  },
  list_dir: {
    whenToUse: [
      'Explore directory structure when path is unknown',
      'See what modules or folders exist under a path',
    ],
    whenNotToUse: [
      'Finding files by name pattern — use glob_file_search',
      'Searching file contents — use grep',
    ],
    examples: [
      '<example>\nGood: Explore a package layout:\n{ "target_directory": "poyraz/application" }\n</example>',
      '<example>\nGood: Skip noise:\n{ "target_directory": ".", "ignore_globs": ["**/node_modules/**", "**/.git/**"] }\n</example>',
      '<example>\nBad: Use "path" instead of target_directory — will fail schema validation.\n</example>',
    ],
  },
  glob_file_search: {
    whenToUse: [
      'Find files by name or extension pattern',
      'Locate test files, configs, or entry points',
    ],
    whenNotToUse: [
      'Search inside file contents — use grep',
      'List immediate children only — use list_dir',
    ],
    examples: [
      '<example>\nGood: Find all TypeScript entry files:\n{ "glob_pattern": "**/index.ts" }\n</example>',
      '<example>\nGood: Scoped search:\n{ "glob_pattern": "**/*.test.ts", "target_directory": "poyraz" }\n</example>',
      '<example>\nBad: Use grep pattern field for file names — use glob_pattern.\n</example>',
    ],
  },
  grep: {
    whenToUse: [
      'Exact symbol, string, or regex search across files',
      'Find definitions, usages, imports, or error strings',
      'Narrow with path, glob, type, or output_mode',
    ],
    whenNotToUse: [
      'Vague one-word exploration without context — refine the pattern or use multiple greps',
      'Terminal grep/rg when this tool is available',
      'Use "limit" — the parameter is head_limit',
    ],
    examples: [
      '<example>\nGood: Find symbol in a directory:\n{ "pattern": "buildSystemPrompt", "path": "poyraz/application/prompt" }\n</example>',
      '<example>\nGood: List files containing a pattern:\n{ "pattern": "todo_write", "output_mode": "files_with_matches", "glob": "*.ts" }\n</example>',
      '<example>\nBad: { "pattern": "auth", "limit": 10 } — use head_limit instead.\n</example>',
    ],
  },
  run_terminal_cmd: {
    whenToUse: [
      'Change directory: cd my-app (persists for the session) or cd my-app && npm install',
      'Create project layout: mkdir parent && cd parent && mkdir frontend && mkdir backend (one mkdir per directory on Windows)',
      'When already inside a project folder, cd backend — not cd my-app/backend (session cwd is relative)',
      'When session cwd is already the project root, start dev server with npm run dev and is_background: true — no cd prefix',
      'Scaffold new projects: npm create vite@latest my-app -- --template react (foreground)',
      'Install dependencies: npm install, npm add (runs in session cwd)',
      'Build or test: npm run build, npm test',
      'Long-running dev servers — cd into project first, then npm run dev with is_background: true',
    ],
    whenNotToUse: [
      'Plan or Ask mode',
      'npm run dev with is_background: false — blocked by policy',
      'Interactive prompts without non-interactive flags',
      'mkdir dir1 dir2 on Windows — use separate mkdir calls or mkdir parent && cd parent && mkdir dir1 && mkdir dir2',
    ],
    examples: [
      '<example>\nGood: cd then later commands use same directory:\n{ "command": "cd my-app", "is_background": false }\n</example>',
      '<example>\nGood: Scaffold layout with compound cd sync:\n{ "command": "mkdir my-project && cd my-project && mkdir frontend && mkdir backend", "is_background": false }\n</example>',
      '<example>\nGood: Chained cd + install:\n{ "command": "cd my-app && npm install", "is_background": false }\n</example>',
      '<example>\nGood: Dev server when cwd is already my-app:\n{ "command": "npm run dev", "is_background": true }\n</example>',
      '<example>\nGood: Dev server from workspace root:\n{ "command": "cd my-app && npm run dev", "is_background": true }\n</example>',
      '<example>\nBad: Redundant cd when already in my-app:\n{ "command": "cd my-app && npm run dev", "is_background": true }\n</example>',
      '<example>\nBad: mkdir frontend backend — unreliable on Windows; use two mkdir calls.\n</example>',
      '<example>\nBad: Dev server in foreground — blocked:\n{ "command": "npm run dev", "is_background": false }\n</example>',
    ],
  },
  todo_write: {
    whenToUse: [
      'Complex multi-step tasks (3+ steps) in Agent mode',
      'Record the full plan once in Plan mode (merge: false), then present plan in text',
      'Mark items completed immediately after each step',
      'Mark a step blocked with blockedReason when progress is impossible',
    ],
    whenNotToUse: [
      'Simple one-step tasks',
      'Ask or Chat mode',
      'Calling todo_write more than once in the same Plan-mode user turn',
    ],
    examples: [
      '<example>\nGood: Initial task list:\n{ "merge": false, "todos": [{ "id": "explore", "content": "Map prompt modules", "status": "in_progress" }, { "id": "implement", "content": "Expand behavior sections", "status": "pending" }] }\n</example>',
      '<example>\nGood: Mark one done:\n{ "merge": true, "todos": [{ "id": "explore", "content": "Map prompt modules", "status": "completed" }] }\n</example>',
      '<example>\nGood: Mark blocked:\n{ "merge": true, "todos": [{ "id": "deploy", "content": "Deploy service", "status": "blocked", "blockedReason": "No production credentials available" }] }\n</example>',
      '<example>\nBad: { "tasks": [{ "title": "Step 1" }] } — use todos, id, content, status.\n</example>',
    ],
  },
  delete_file: {
    whenToUse: [
      'Remove temporary or obsolete files the user asked to delete',
      'Clean up generated artifacts when appropriate',
    ],
    whenNotToUse: [
      'Plan or Ask mode',
      'Deleting without user intent or policy allowance',
    ],
    examples: [
      '<example>\nGood: Remove a temp file:\n{ "target_file": "temp-scratch.txt" }\n</example>',
      '<example>\nBad: Delete source files to "clean up" without explicit request.\n</example>',
    ],
  },
  http_request: {
    whenToUse: [
      'Call HTTP APIs when no dedicated tool exists',
      'Health checks or fetching remote JSON',
    ],
    whenNotToUse: [
      'Operations better done with run_terminal_cmd and curl when policy allows',
      'Sending secrets in plain text without user approval',
    ],
    examples: [
      '<example>\nGood: GET health endpoint:\n{ "url": "https://api.example.com/health", "method": "GET" }\n</example>',
    ],
  },
};

const TOOL_GUIDANCE_EXPLICIT: Partial<Record<string, ToolGuidance>> = {
  read_file: {
    whenToUse: [
      'ALWAYS read_file before edit_file on an existing file',
      'Read the full file when it is under ~150 lines',
    ],
    whenNotToUse: [
      'Skipping read_file then guessing file contents for edit_file',
    ],
    examples: [
      '<example>\nStep 1 — read:\n{ "target_file": "src/App.jsx" }\n</example>',
      '<example>\nStep 2 — edit uses read content (see EDIT_READY footer in result).\n</example>',
      '<example>\nBad: edit_file without reading first.\n</example>',
    ],
  },
  edit_file: {
    whenToUse: [
      'After read_file — use FULL file in code_edit for small files',
      'Partial edit ONLY with TWO markers and anchor lines from read_file',
    ],
    whenNotToUse: [
      'WRONG: code_edit with only a JSX snippet — rejected',
      'One marker only — rejected',
      'Stacking partial fixes after parse errors',
    ],
    examples: [
      '<example>\nWRONG (rejected): { "target_file": "src/App.jsx", "code_edit": "<section>New</section>" }\n</example>',
      '<example>\nRIGHT (full file): { "target_file": "src/App.jsx", "code_edit": "import ... entire 129 lines ..." }\n</example>',
      '<example>\nRIGHT (partial): { "target_file": "src/App.jsx", "code_edit": "{/* ... existing code ... */}\\n<section>New</section>\\n{/* ... existing code ... */}" }\n</example>',
    ],
  },
  run_terminal_cmd: {
    whenToUse: [
      'npm run dev / vite → is_background: true',
      'When cwd already in project → npm run dev without cd prefix',
      'mkdir one directory per command on Windows',
    ],
    whenNotToUse: [
      'npm run dev with is_background: false — blocked',
      'cd my-app when already inside my-app',
    ],
    examples: [
      '<example>\nRIGHT: { "command": "npm run dev", "is_background": true } when cwd is my-app\n</example>',
      '<example>\nWRONG: { "command": "cd my-app && npm run dev", "is_background": true } when cwd is already my-app\n</example>',
    ],
  },
};

function resolveToolGuidance(name: string, hintTier: PromptHintTier): ToolGuidance | undefined {
  if (hintTier === 'explicit' && TOOL_GUIDANCE_EXPLICIT[name]) {
    return TOOL_GUIDANCE_EXPLICIT[name];
  }
  return TOOL_GUIDANCE[name];
}

function formatToolHintLine(name: string, hint: ToolHint): string[] {
  const required =
    hint.required.length > 0 ? ` (required: ${hint.required.join(', ')})` : '';
  const lines = [`- ${name}: ${hint.example}${required}`];
  if (hint.optional && hint.optional.length > 0) {
    lines.push(`  Optional: ${hint.optional.join(', ')}`);
  }
  for (const alt of hint.altExamples ?? []) {
    lines.push(`  Example: ${alt}`);
  }
  return lines;
}

function formatToolGuidance(name: string, guidance: ToolGuidance): string[] {
  const lines = [`### ${name}`, '', 'When to use:'];
  for (const item of guidance.whenToUse) {
    lines.push(`- ${item}`);
  }
  lines.push('', 'When NOT to use:');
  for (const item of guidance.whenNotToUse) {
    lines.push(`- ${item}`);
  }
  lines.push('', 'Examples:');
  for (const example of guidance.examples) {
    lines.push(example);
  }
  lines.push('');
  return lines;
}

export function buildActiveToolsSection(
  toolNames: string[],
  hintTier: PromptHintTier = 'standard'
): string {
  if (toolNames.length === 0) {
    return '';
  }

  const toolLines: string[] = [];
  for (const name of toolNames) {
    const hint = TOOL_HINTS[name];
    if (!hint) {
      toolLines.push(`- ${name}`);
      continue;
    }
    toolLines.push(...formatToolHintLine(name, hint));
  }

  const guidanceSection = buildToolGuidanceSection(toolNames, hintTier);

  const parts = [
    '<available_tools>',
    ...toolLines,
    'Only call tools listed here. Use exact parameter names from the examples; do not use aliases.',
    '</available_tools>',
  ];

  if (guidanceSection) {
    parts.push('', guidanceSection);
  }

  return parts.join('\n');
}

export function buildToolGuidanceSection(
  toolNames: string[],
  hintTier: PromptHintTier = 'standard'
): string {
  const blocks: string[] = [];

  for (const name of toolNames) {
    const guidance = resolveToolGuidance(name, hintTier);
    if (!guidance) continue;
    blocks.push(...formatToolGuidance(name, guidance));
  }

  if (blocks.length === 0) {
    return '';
  }

  return ['<tool_guidance>', ...blocks, '</tool_guidance>'].join('\n');
}

export function getToolExampleShape(toolName: string): string | undefined {
  return TOOL_HINTS[toolName]?.example;
}
