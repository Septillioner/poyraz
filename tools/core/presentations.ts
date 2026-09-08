import { ToolPresentation } from './types.js';
import { tryParseToolError } from '../../application/chat/tool-errors.js';
import { formatEditArgsSummary, formatEditMetaSummary } from './edit-diff.js';

function defaultSummarizeResult(content: string) {
  const err = tryParseToolError(content);
  if (err?.code === 'POLICY_BLOCKED') {
    return { preview: err.message, status: 'blocked' as const };
  }
  if (err) {
    return { preview: err.message, status: 'error' as const };
  }
  const oneLine = content.replace(/\s+/g, ' ').trim();
  const preview = oneLine.length > 220 ? `${oneLine.slice(0, 220)}...` : oneLine;
  return { preview, status: 'success' as const };
}

export const TOOL_PRESENTATIONS: Record<string, ToolPresentation> = {
  todo_write: {
    label: 'Managing Tasks',
    icon: 'ListTodo',
    category: 'planning',
    summarizeArgs: (args) => {
      const todos = args.todos as
        | Array<{ id?: string; content?: string; status?: string; blockedReason?: string }>
        | undefined;
      if (!todos?.length) return undefined;
      const completed = todos.filter((t) => t.status === 'completed').length;
      const blocked = todos.filter((t) => t.status === 'blocked').length;
      const inProgress = todos.find((t) => t.status === 'in_progress');
      const parts = [`${completed}/${todos.length} done`];
      if (inProgress?.content) parts.push(`active: ${inProgress.content}`);
      else if (todos[0]?.content) parts.push(todos[0].content);
      if (blocked > 0) {
        const reason = todos.find((t) => t.status === 'blocked')?.blockedReason;
        parts.push(reason ? `blocked: ${reason}` : `${blocked} blocked`);
      }
      return parts.join(' · ');
    },
    summarizeResult: (content) => {
      const err = tryParseToolError(content);
      if (err?.code === 'POLICY_BLOCKED') {
        return { preview: err.message, status: 'blocked' as const };
      }
      if (err) {
        return { preview: err.message, status: 'error' as const };
      }
      const lines = content
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const header = lines[0] ?? 'Todos updated';
      const items = lines.slice(1);
      const completed = items.filter((l) => l.includes('[completed]')).length;
      const blocked = items.filter((l) => l.includes('[blocked]')).length;
      const open = items.filter(
        (l) => l.includes('[pending]') || l.includes('[in_progress]')
      ).length;
      const preview = `${header} · ${completed} done · ${open} open${
        blocked ? ` · ${blocked} blocked` : ''
      }`;
      return { preview, status: 'success' as const };
    },
  },
  read_file: {
    label: 'Reading File',
    icon: 'Code2',
    category: 'file',
    summarizeArgs: (args) => (args.target_file as string | undefined),
  },
  edit_file: {
    label: 'Editing File',
    icon: 'FileText',
    category: 'file',
    summarizeArgs: (args) => formatEditArgsSummary(args),
    summarizeResult: (content) => {
      const err = tryParseToolError(content);
      if (err) {
        return { preview: err.message, status: err.code === 'POLICY_BLOCKED' ? 'blocked' : 'error' };
      }
      const oneLine = content.replace(/\s+/g, ' ').trim();
      return {
        preview: oneLine.length > 220 ? `${oneLine.slice(0, 220)}...` : oneLine,
        status: 'success',
      };
    },
  },
  list_dir: {
    label: 'Listing Directory',
    icon: 'FolderOpen',
    category: 'file',
    summarizeArgs: (args) => {
      const dir = args.target_directory;
      return typeof dir === 'string' && dir.trim() ? dir : '(eksik)';
    },
  },
  glob_file_search: {
    label: 'Searching Files',
    icon: 'FolderOpen',
    category: 'file',
    summarizeArgs: (args) => args.glob_pattern as string | undefined,
  },
  delete_file: {
    label: 'Deleting File',
    icon: 'FileText',
    category: 'file',
    summarizeArgs: (args) => (args.target_file as string | undefined),
  },
  run_terminal_cmd: {
    label: 'Running Command',
    icon: 'Terminal',
    category: 'shell',
    summarizeArgs: (args) => args.command as string | undefined,
    sensitiveArgKeys: ['command'],
  },
  grep: {
    label: 'Searching Codebase',
    icon: 'Search',
    category: 'file',
    summarizeArgs: (args) => args.pattern as string | undefined,
  },
  delegate_task: {
    label: 'Delegating Task',
    runningLabel: 'Delegating to subagent',
    icon: 'ListTodo',
    category: 'planning',
    summarizeArgs: (args) => {
      const task = args.task;
      if (typeof task !== 'string' || !task.trim()) return undefined;
      const oneLine = task.replace(/\s+/g, ' ').trim();
      return oneLine.length > 120 ? `${oneLine.slice(0, 120)}...` : oneLine;
    },
  },
};

export function withPresentation(name: string, presentation?: Partial<ToolPresentation>): ToolPresentation {
  const base = TOOL_PRESENTATIONS[name] ?? { label: name, icon: 'Wrench' };
  return {
    ...base,
    ...presentation,
    summarizeResult: presentation?.summarizeResult ?? base.summarizeResult ?? defaultSummarizeResult,
  };
}
