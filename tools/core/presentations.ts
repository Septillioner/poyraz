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


};

export function withPresentation(name: string, presentation?: Partial<ToolPresentation>): ToolPresentation {
  const base = TOOL_PRESENTATIONS[name] ?? { label: name, icon: 'Wrench' };
  return {
    ...base,
    ...presentation,
    summarizeResult: presentation?.summarizeResult ?? base.summarizeResult ?? defaultSummarizeResult,
  };
}
