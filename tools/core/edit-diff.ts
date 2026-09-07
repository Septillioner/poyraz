export interface ChangedLineRange {
  start_line: number;
  end_line: number;
  lines_added: number;
  lines_removed: number;
}

export type EditKind = 'partial' | 'full' | 'new';

export interface EditFileStructuredResult {
  target_file: string;
  is_new_file: boolean;
  changed_ranges: ChangedLineRange[];
  edit_kind: EditKind;
  code_edit_lines: number;
}

export function computeChangedLineRanges(before: string, after: string): ChangedLineRange[] {
  if (before === after) return [];

  const oldLines = before.split('\n');
  const newLines = after.split('\n');

  if (before === '') {
    const count = newLines.length;
    return [
      {
        start_line: 1,
        end_line: Math.max(1, count),
        lines_added: count,
        lines_removed: 0,
      },
    ];
  }

  const ranges: ChangedLineRange[] = [];
  let i = 0;
  let j = 0;

  while (i < oldLines.length || j < newLines.length) {
    while (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      i++;
      j++;
    }
    if (i >= oldLines.length && j >= newLines.length) break;

    const oldStart = i;
    const newStart = j;
    const startLine = j + 1;

    while (i < oldLines.length || j < newLines.length) {
      if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
        break;
      }
      if (i < oldLines.length && j < newLines.length) {
        const nextOldInNew =
          j + 1 < newLines.length ? newLines.indexOf(oldLines[i], j + 1) : -1;
        const nextNewInOld =
          i + 1 < oldLines.length ? oldLines.indexOf(newLines[j], i + 1) : -1;

        if (nextOldInNew !== -1 && (nextNewInOld === -1 || nextOldInNew - j <= nextNewInOld - i)) {
          j++;
        } else if (nextNewInOld !== -1) {
          i++;
        } else {
          i++;
          j++;
        }
      } else if (i < oldLines.length) {
        i++;
      } else {
        j++;
      }
    }

    const linesRemoved = i - oldStart;
    const linesAdded = j - newStart;
    if (linesAdded > 0 || linesRemoved > 0) {
      ranges.push({
        start_line: startLine,
        end_line: linesAdded > 0 ? startLine + linesAdded - 1 : startLine,
        lines_added: linesAdded,
        lines_removed: linesRemoved,
      });
    }
  }

  return mergeAdjacentRanges(ranges);
}

function mergeAdjacentRanges(ranges: ChangedLineRange[]): ChangedLineRange[] {
  if (ranges.length <= 1) return ranges;

  const merged: ChangedLineRange[] = [{ ...ranges[0] }];
  for (let k = 1; k < ranges.length; k++) {
    const prev = merged[merged.length - 1];
    const cur = ranges[k];
    if (cur.start_line <= prev.end_line + 1) {
      prev.end_line = Math.max(prev.end_line, cur.end_line);
      prev.lines_added += cur.lines_added;
      prev.lines_removed += cur.lines_removed;
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

export function formatChangedRangesSummary(ranges: ChangedLineRange[]): string {
  if (ranges.length === 0) return 'no line changes';
  return ranges
    .map((r) => {
      const loc =
        r.start_line === r.end_line ? `L${r.start_line}` : `L${r.start_line}-${r.end_line}`;
      return `${loc} (+${r.lines_added} -${r.lines_removed})`;
    })
    .join(', ');
}

export function formatEditResultContent(targetFile: string, ranges: ChangedLineRange[]): string {
  if (ranges.length === 0) {
    return `Edited ${targetFile} (no line changes)`;
  }
  return `Edited ${targetFile}: ${formatChangedRangesSummary(ranges)}`;
}

export function formatEditMetaSummary(meta: Record<string, unknown>): string | undefined {
  const ranges = meta.changed_ranges as ChangedLineRange[] | undefined;
  const target = meta.target_file as string | undefined;
  if (!target) return undefined;
  if (!ranges?.length) return `${target} (no line changes)`;
  return `${target} · ${formatChangedRangesSummary(ranges)}`;
}

export function formatEditArgsSummary(args: Record<string, unknown>): string | undefined {
  const target = args.target_file as string | undefined;
  if (!target) return undefined;

  const codeEdit = typeof args.code_edit === 'string' ? args.code_edit : '';
  const lineCount = codeEdit ? codeEdit.split('\n').length : 0;
  const hasMarker = /existing code/i.test(codeEdit);
  const kind = hasMarker ? 'partial' : lineCount > 0 ? 'full' : 'edit';

  const parts = [`${target} (${kind}, ${lineCount} lines)`];
  const instructions = args.instructions;
  if (typeof instructions === 'string' && instructions.trim()) {
    const short =
      instructions.length > 60 ? `${instructions.slice(0, 57)}...` : instructions;
    parts.push(short);
  }
  return parts.join(' — ');
}

export const ADD_ONLY_PARTIAL_THRESHOLD = 50;

/** Partial merge that only adds many lines with no removals — likely a broken splice. */
export function isSuspiciousPartialMerge(
  editKind: EditKind,
  ranges: ChangedLineRange[]
): boolean {
  if (editKind !== 'partial') return false;
  const linesAdded = ranges.reduce((sum, r) => sum + r.lines_added, 0);
  const linesRemoved = ranges.reduce((sum, r) => sum + r.lines_removed, 0);
  return linesAdded >= ADD_ONLY_PARTIAL_THRESHOLD && linesRemoved === 0;
}

export function stripMarkersFromCodeEdit(codeEdit: string): string {
  const withoutLineMarkers = codeEdit
    .split('\n')
    .filter((line) => !/^\s*(\/\/|#|\/\*|<!--).*\.\.\. existing code \.\.\./i.test(line))
    .join('\n');
  return withoutLineMarkers
    .replace(/\{\s*\/\*\s*\.\.\.\s*existing code\s*\.\.\.\s*\/\*\s*\}/gi, '')
    .trim();
}
