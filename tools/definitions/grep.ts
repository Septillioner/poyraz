import { z } from 'zod';
import path from 'path';
import { execa } from 'execa';
import { defineTool } from '../core/define-tool.js';
import { withPresentation } from '../core/presentations.js';

export const grepSchema = z.object({
  pattern: z.string().describe('The regular expression pattern to search for in file contents (rg --regexp).'),
  path: z
    .string()
    .optional()
    .describe('File or directory to search in. Defaults to workspace root.'),
  glob: z.string().optional().describe('Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}").'),
  output_mode: z
    .enum(['content', 'files_with_matches', 'count'])
    .optional()
    .describe('Output mode. Defaults to "content".'),
  '-B': z.number().optional().describe('Lines to show before each match.'),
  '-A': z.number().optional().describe('Lines to show after each match.'),
  '-C': z.number().optional().describe('Lines to show before and after each match.'),
  '-i': z.boolean().optional().describe('Case insensitive search.'),
  type: z.string().optional().describe('File type to search (rg --type).'),
  head_limit: z.number().optional().describe('Limit output to first N lines/entries.'),
  multiline: z.boolean().optional().describe('Enable multiline mode (rg -U --multiline-dotall).'),
});

export async function grep(args: z.infer<typeof grepSchema>) {
  const searchPath = path.resolve(process.cwd(), args.path || '.');
  const rgArgs: string[] = ['--regexp', args.pattern];

  if (args['-i']) rgArgs.push('-i');
  if (args.multiline) rgArgs.push('-U', '--multiline-dotall');
  if (args.type) rgArgs.push('--type', args.type);
  if (args.glob) rgArgs.push('--glob', args.glob);

  const outputMode = args.output_mode || 'content';
  if (outputMode === 'files_with_matches') {
    rgArgs.push('-l');
  } else if (outputMode === 'count') {
    rgArgs.push('-c');
  }

  if (args['-B'] !== undefined) rgArgs.push('-B', String(args['-B']));
  if (args['-A'] !== undefined) rgArgs.push('-A', String(args['-A']));
  if (args['-C'] !== undefined) rgArgs.push('-C', String(args['-C']));

  rgArgs.push('--', searchPath);

  try {
    const { stdout, stderr, exitCode } = await execa('rg', rgArgs, {
      reject: false,
      timeout: 30000,
    });

    if (stderr && !stdout && exitCode !== 0 && exitCode !== 1) {
      if (stderr.includes('not recognized') || stderr.includes('ENOENT')) {
        return 'ERROR: ripgrep (rg) is not installed or not in PATH. Install ripgrep to use grep.';
      }
      return `Grep error: ${stderr.trim()}`;
    }

    let output = stdout.trim();
    if (!output) {
      return exitCode === 1 ? 'No matches found.' : 'No matches found.';
    }

    if (args.head_limit && args.head_limit > 0) {
      const lines = output.split('\n');
      if (lines.length > args.head_limit) {
        output = lines.slice(0, args.head_limit).join('\n') + `\n\n... (truncated to ${args.head_limit} lines)`;
      }
    }

    return output;
  } catch (error: any) {
    if (error.code === 'ENOENT' || error.message?.includes('ENOENT')) {
      return 'ERROR: ripgrep (rg) is not installed or not in PATH. Install ripgrep to use grep.';
    }
    if (error.timedOut) {
      return 'Grep timed out after 30 seconds.';
    }
    return `Grep error: ${error.message}`;
  }
}

export const grepToolDefinitions = [
  defineTool({
    name: 'grep',
    description:
      'A powerful search tool built on ripgrep. Prefer grep for exact symbol/string searches. ' +
      'Supports full regex syntax. Output modes: content, files_with_matches, count. ' +
      'Respects .gitignore. Results are capped for responsiveness. ' +
      'Use head_limit (not "limit") to cap output lines. ' +
      'Examples: { "pattern": "buildSystemPrompt", "path": "poyraz" }; ' +
      '{ "pattern": "todo_write", "glob": "*.ts", "head_limit": 20, "-A": 2 }.',
    inputSchema: grepSchema,
    execute: (args, _ctx) => grep(args),
    presentation: withPresentation('grep'),
    meta: { category: 'file' },
  }),
];
