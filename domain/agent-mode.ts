export type AgentMode = 'agent' | 'plan' | 'ask' | 'chat';

export interface AgentModeDef {
  id: AgentMode;
  label: string;
  description: string;
  allowTools: 'all' | string[];
  directive: string;
}

export const DEFAULT_AGENT_MODE: AgentMode = 'agent';

export const AGENT_MODE_CYCLE: AgentMode[] = ['agent', 'plan', 'ask', 'chat'];

export const AGENT_MODES: Record<AgentMode, AgentModeDef> = {
  agent: {
    id: 'agent',
    label: 'Agent',
    description: 'Full access: read, write, run commands',
    allowTools: 'all',
    directive:
      'Active mode: AGENT. Use all appropriate tools to fulfill the user instructions. Keep going until the task is resolved. ' +
      'When a todo list exists for this session, do not end your turn while any item is still pending or in_progress — ' +
      'complete items, or mark truly impossible ones blocked with blockedReason. ' +
      'When the user asks you to write, create, or implement code or files — including "example" or "örnek" requests — ALWAYS use edit_file to write files. Do NOT dump code in chat. ' +
      'Do NOT wait for approval before implementing; you are already in AGENT mode.',
  },
  plan: {
    id: 'plan',
    label: 'Plan',
    description: 'Read-only exploration + todo_write; no edits or commands',
    allowTools: ['read_file', 'list_dir', 'glob_file_search', 'grep', 'todo_write'],
    directive:
      'Active mode: PLAN. Read and explore the codebase with read-only tools when needed. ' +
      'Even when the user asks you to write, create, or build a site/app: do NOT implement and do NOT use fenced code blocks (```) in any language. ' +
      'Call todo_write at most ONCE per user turn (merge: false) to record the full plan, then stop using tools. ' +
      'Present the plan in plain text as a numbered step list with short rationale and intended file names only — no full file contents, no HTML/CSS/JS snippets, no implementable patches. ' +
      'Do not rewrite or update the plan with more todo_write calls in this turn. ' +
      'Do NOT use edit_file, delete_file, or run_terminal_cmd. Do NOT start implementing. ' +
      'End your reply with the exact instruction to switch to Agent mode with "/mode agent" to apply changes. ' +
      'Do NOT ask whether to proceed instead of suggesting the switch, and do NOT call edit_file.',
  },
  ask: {
    id: 'ask',
    label: 'Ask',
    description: 'Read-only: read_file, list_dir, glob_file_search, grep',
    allowTools: ['read_file', 'list_dir', 'glob_file_search', 'grep'],
    directive:
      'Active mode: ASK. Answer questions using read-only tools only. Do not edit files, run commands, or create todos.',
  },
  chat: {
    id: 'chat',
    label: 'Chat',
    description: 'Tool-free conversation',
    allowTools: [],
    directive:
      'Active mode: CHAT. Do not use tools. Respond with direct text only.',
  },
};

const AGENT_MODE_SET = new Set<string>(Object.keys(AGENT_MODES));

export function isAgentMode(value: string): value is AgentMode {
  return AGENT_MODE_SET.has(value.trim().toLowerCase());
}

export function nextAgentMode(current: AgentMode): AgentMode {
  const index = AGENT_MODE_CYCLE.indexOf(current);
  if (index === -1) return DEFAULT_AGENT_MODE;
  return AGENT_MODE_CYCLE[(index + 1) % AGENT_MODE_CYCLE.length];
}

export function resolveAgentMode(value: string): AgentMode | undefined {
  const normalized = value.trim().toLowerCase();
  return isAgentMode(normalized) ? normalized : undefined;
}

export function resolveModeTools(baseTools: string[], mode: AgentMode): string[] {
  const def = AGENT_MODES[mode];
  if (def.allowTools === 'all') return [...baseTools];
  const allowed = new Set(def.allowTools);
  return baseTools.filter((tool) => allowed.has(tool));
}

export function resolveModeDenied(baseTools: string[], mode: AgentMode): string[] {
  const allowed = new Set(resolveModeTools(baseTools, mode));
  return baseTools.filter((tool) => !allowed.has(tool));
}
