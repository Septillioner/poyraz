import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { defineTool } from '../core/define-tool.js';
import { withPresentation } from '../core/presentations.js';
import type { ToolResult } from '../core/types.js';
import {
  computeChangedLineRanges,
  formatEditResultContent,
  isSuspiciousPartialMerge,
  type EditFileStructuredResult,
  type EditKind,
} from '../core/edit-diff.js';
import {
  applyMarkerMerge,
  hasExistingCodeMarker,
  validateEditRequest,
} from '../core/edit-merge.js';

const MAX_READ_BYTES = 50 * 1024;
const EDIT_READY_HINT =
  'Next edit_file: paste FULL file in code_edit OR use markers on both sides of your change.';

export interface ReadFileStructuredResult {
  target_file: string;
  line_count: number;
  edit_ready: true;
  edit_hint: string;
}

function buildEditReadyFooter(targetFile: string, lineCount: number): string {
  return (
    `\n---\nEDIT_READY: ${targetFile} (${lineCount} lines). ${EDIT_READY_HINT}`
  );
}

export const readFileSchema = z.object({
  target_file: z.string().describe('The path of the file to read.'),
  offset: z.number().int().min(0).optional().describe('The line number to start reading from (1-based); 0 is treated as the file start.'),
  limit: z.number().int().positive().optional().describe('The number of lines to read.'),
});

export async function readFile(args: z.infer<typeof readFileSchema>): Promise<ToolResult | string> {
  try {
    const fullPath = path.resolve(process.cwd(), args.target_file);
    const content = await fs.readFile(fullPath, 'utf-8');
    const lines = content.split('\n');
    const totalLines = lines.length;
    const startLine = args.offset ? Math.max(1, args.offset) : 1;
    const endLine = args.limit ? startLine + args.limit - 1 : lines.length;
    const slice = lines.slice(startLine - 1, endLine);

    const numbered = slice.map((line, i) => {
      const lineNo = String(startLine + i).padStart(6, ' ');
      return `${lineNo}|${line}`;
    });

    const structured: ReadFileStructuredResult = {
      target_file: args.target_file,
      line_count: totalLines,
      edit_ready: true,
      edit_hint: EDIT_READY_HINT,
    };

    if (!args.offset && !args.limit && content.length > MAX_READ_BYTES) {
      const truncated = content.slice(0, MAX_READ_BYTES);
      const truncatedLines = truncated.split('\n');
      const numberedTruncated = truncatedLines.map((line, i) => {
        const lineNo = String(i + 1).padStart(6, ' ');
        return `${lineNo}|${line}`;
      });
      return {
        content:
          numberedTruncated.join('\n') +
          `\n\n... (truncated, file is ${(content.length / 1024).toFixed(1)}KB — use offset/limit for large files)` +
          buildEditReadyFooter(args.target_file, totalLines),
        structured,
      };
    }

    const body = numbered.join('\n') || 'File is empty.';
    return {
      content: body + buildEditReadyFooter(args.target_file, totalLines),
      structured,
    };
  } catch (error: any) {
    return `Error reading file: ${error.message}`;
  }
}

export const editFileSchema = z.object({
  target_file: z.string().describe('The target file to modify.'),
  instructions: z
    .string()
    .optional()
    .describe('A single sentence instruction describing what you are going to do for the sketched edit.'),
  code_edit: z
    .string()
    .describe(
      'Specify ONLY the precise lines of code that you wish to edit. Represent unchanged code using the comment `// ... existing code ...`'
    ),
});

function editValidationError(message: string): ToolResult {
  return {
    content: JSON.stringify({ error: { code: 'VALIDATION_ERROR', message } }),
    isError: true,
  };
}

export async function editFile(args: z.infer<typeof editFileSchema>): Promise<ToolResult | string> {
  try {
    const fullPath = path.resolve(process.cwd(), args.target_file);
    let existingContent = '';
    let fileExists = false;

    try {
      existingContent = await fs.readFile(fullPath, 'utf-8');
      fileExists = true;
    } catch {
      fileExists = false;
    }

    const validationError = validateEditRequest(
      args.target_file,
      args.code_edit,
      fileExists,
      existingContent
    );
    if (validationError) {
      return editValidationError(validationError);
    }

    const hasMarker = hasExistingCodeMarker(args.code_edit);
    let editKind: EditKind;
    if (!fileExists) {
      editKind = 'new';
    } else if (hasMarker) {
      editKind = 'partial';
    } else {
      editKind = 'full';
    }

    let finalContent: string;
    if (!fileExists || !hasMarker) {
      finalContent = args.code_edit;
    } else {
      const mergeResult = applyMarkerMerge(existingContent, args.code_edit);
      if (!mergeResult.ok) {
        return editValidationError(mergeResult.message);
      }
      finalContent = mergeResult.content;
    }

    const changedRanges = computeChangedLineRanges(fileExists ? existingContent : '', finalContent);
    const codeEditLines = args.code_edit ? args.code_edit.split('\n').length : 0;

    if (isSuspiciousPartialMerge(editKind, changedRanges)) {
      return editValidationError(
        'Partial merge added many lines without removing any — likely a broken edit. ' +
          'Read the full file with read_file and rewrite with complete code_edit or correct markers.'
      );
    }

    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, finalContent, 'utf-8');

    const structured: EditFileStructuredResult = {
      target_file: args.target_file,
      is_new_file: !fileExists,
      changed_ranges: changedRanges,
      edit_kind: editKind,
      code_edit_lines: codeEditLines,
    };

    return {
      content: formatEditResultContent(args.target_file, changedRanges),
      structured,
    };
  } catch (error: any) {
    return `Error editing file: ${error.message}`;
  }
}

export const listDirSchema = z.object({
  target_directory: z.string().describe('Path to directory to list contents of.'),
  ignore_globs: z
    .array(z.string())
    .optional()
    .describe('Optional array of glob patterns to ignore.'),
});

function matchesIgnore(name: string, relPath: string, patterns?: string[]): boolean {
  if (!patterns?.length) return false;
  for (const pattern of patterns) {
    const normalized = pattern.startsWith('**/') ? pattern : `**/${pattern}`;
    const regex = globToRegex(normalized);
    if (regex.test(name) || regex.test(relPath)) return true;
  }
  return false;
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '<<<GLOBSTAR>>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<<GLOBSTAR>>>/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

export async function listDir(args: z.infer<typeof listDirSchema>) {
  try {
    const fullPath = path.resolve(process.cwd(), args.target_directory);
    const entries = await fs.readdir(fullPath, { withFileTypes: true });
    const lines: string[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const rel = path.join(args.target_directory, entry.name).replace(/\\/g, '/');
      if (matchesIgnore(entry.name, rel, args.ignore_globs)) continue;
      lines.push(entry.isDirectory() ? `${rel}/` : rel);
    }

    return lines.length > 0 ? lines.join('\n') : '(empty directory)';
  } catch (error: any) {
    return `Error listing directory: ${error.message}`;
  }
}

export const globFileSearchSchema = z.object({
  target_directory: z
    .string()
    .optional()
    .describe('Path to directory to search for files in. Defaults to workspace root.'),
  glob_pattern: z
    .string()
    .describe('The glob pattern to match files against. Patterns not starting with "**/" are prepended with "**/".'),
});

async function walkForGlob(
  dir: string,
  pattern: string,
  results: string[],
  maxResults: number
): Promise<void> {
  if (results.length >= maxResults) return;

  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (results.length >= maxResults) break;
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(process.cwd(), fullPath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      await walkForGlob(fullPath, pattern, results, maxResults);
    } else if (entry.isFile()) {
      const normalizedPattern = pattern.startsWith('**/') ? pattern : `**/${pattern}`;
      const regex = globToRegex(normalizedPattern);
      if (regex.test(relPath) || regex.test(entry.name)) {
        results.push(relPath);
      }
    }
  }
}

export async function globFileSearch(args: z.infer<typeof globFileSearchSchema>) {
  try {
    const startDir = path.resolve(process.cwd(), args.target_directory || '.');
    const results: string[] = [];
    await walkForGlob(startDir, args.glob_pattern, results, 200);
    return results.length > 0 ? results.join('\n') : 'No files found.';
  } catch (error: any) {
    return `Error searching files: ${error.message}`;
  }
}

export const deleteFileSchema = z.object({
  target_file: z.string().describe('The path of the file to delete, relative to the workspace root.'),
  explanation: z
    .string()
    .optional()
    .describe('One sentence explanation as to why this tool is being used.'),
});

export async function deleteFile(args: z.infer<typeof deleteFileSchema>) {
  try {
    const fullPath = path.resolve(process.cwd(), args.target_file);
    await fs.unlink(fullPath);
    return `Successfully deleted ${args.target_file}`;
  } catch (error: any) {
    return `Error deleting file: ${error.message}`;
  }
}

export const fsToolDefinitions = [
  defineTool({
    name: 'read_file',
    description:
      'Reads a file from the local filesystem. Lines are numbered starting at 1 (LINE_NUMBER|LINE_CONTENT). ' +
      'Optionally specify offset and limit for large files. Can read image files (jpeg, png, gif, webp).',
    inputSchema: readFileSchema,
    execute: (args, _ctx) => readFile(args),
    presentation: withPresentation('read_file'),
    meta: { category: 'file' },
  }),
  defineTool({
    name: 'edit_file',
    description:
      'Propose an edit to an existing file or create a new file. ' +
      'Use `// ... existing code ...` to represent unchanged lines when editing existing files. ' +
      'For new files, provide the full file content in code_edit. ' +
      'Required shape: { "target_file": "path/to/file", "code_edit": "..." }. ' +
      'Use target_file (not path) and code_edit (not code).',
    inputSchema: editFileSchema,
    execute: (args, _ctx) => editFile(args),
    presentation: withPresentation('edit_file'),
    meta: { category: 'file', destructive: true },
  }),
  defineTool({
    name: 'list_dir',
    description:
      'Lists files and directories in a given path. Does not display dot-files and dot-directories. ' +
      'Required JSON: { "target_directory": "." } — use target_directory exactly (not path or dir).',
    inputSchema: listDirSchema,
    execute: (args, _ctx) => listDir(args),
    presentation: withPresentation('list_dir'),
    meta: { category: 'file' },
  }),
  defineTool({
    name: 'glob_file_search',
    description:
      'Search for files matching a glob pattern. Returns matching file paths sorted by discovery order. ' +
      'Required JSON: { "glob_pattern": "**/index.js" } — use glob_pattern exactly (not pattern).',
    inputSchema: globFileSearchSchema,
    execute: (args, _ctx) => globFileSearch(args),
    presentation: withPresentation('glob_file_search'),
    meta: { category: 'file' },
  }),
  defineTool({
    name: 'delete_file',
    description: 'Deletes a file at the specified path.',
    inputSchema: deleteFileSchema,
    execute: (args, _ctx) => deleteFile(args),
    presentation: withPresentation('delete_file'),
    meta: { category: 'file', destructive: true },
  }),
];
