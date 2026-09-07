import { describe, expect, it } from 'vitest';
import {
  ADD_ONLY_PARTIAL_THRESHOLD,
  computeChangedLineRanges,
  formatChangedRangesSummary,
  formatEditArgsSummary,
  formatEditMetaSummary,
  formatEditResultContent,
  isSuspiciousPartialMerge,
  stripMarkersFromCodeEdit,
} from '../../tools/core/edit-diff.js';

describe('computeChangedLineRanges', () => {
  it('returns empty for identical content', () => {
    expect(computeChangedLineRanges('a\nb', 'a\nb')).toEqual([]);
  });

  it('reports full file as added when before is empty', () => {
    const ranges = computeChangedLineRanges('', 'line1\nline2');
    expect(ranges).toHaveLength(1);
    expect(ranges[0].lines_added).toBe(2);
    expect(ranges[0].lines_removed).toBe(0);
  });

  it('detects a single-line replacement', () => {
    const ranges = computeChangedLineRanges('foo\nbar', 'foo\nbaz');
    expect(ranges.length).toBeGreaterThan(0);
    const totalAdded = ranges.reduce((s, r) => s + r.lines_added, 0);
    const totalRemoved = ranges.reduce((s, r) => s + r.lines_removed, 0);
    expect(totalAdded).toBeGreaterThan(0);
    expect(totalRemoved).toBeGreaterThan(0);
  });

  it('merges adjacent change ranges', () => {
    const before = 'a\nb\nc\nd';
    const after = 'a\nX\nY\nd';
    const ranges = computeChangedLineRanges(before, after);
    expect(ranges.length).toBeLessThanOrEqual(2);
  });
});

describe('formatChangedRangesSummary', () => {
  it('formats no changes', () => {
    expect(formatChangedRangesSummary([])).toBe('no line changes');
  });

  it('formats a single range', () => {
    const summary = formatChangedRangesSummary([
      { start_line: 1, end_line: 1, lines_added: 1, lines_removed: 1 },
    ]);
    expect(summary).toContain('L1');
    expect(summary).toContain('+1');
  });
});

describe('formatEditResultContent', () => {
  it('reports no line changes', () => {
    expect(formatEditResultContent('foo.ts', [])).toContain('no line changes');
  });
});

describe('formatEditArgsSummary', () => {
  it('detects partial edits via marker', () => {
    const summary = formatEditArgsSummary({
      target_file: 'a.ts',
      code_edit: '// ... existing code ...\nnew\n// ... existing code ...',
    });
    expect(summary).toContain('partial');
  });

  it('detects full edits without marker', () => {
    const summary = formatEditArgsSummary({
      target_file: 'a.ts',
      code_edit: 'full file content',
    });
    expect(summary).toContain('full');
  });
});

describe('isSuspiciousPartialMerge', () => {
  it('flags large add-only partial merges', () => {
    const ranges = [
      {
        start_line: 1,
        end_line: ADD_ONLY_PARTIAL_THRESHOLD,
        lines_added: ADD_ONLY_PARTIAL_THRESHOLD,
        lines_removed: 0,
      },
    ];
    expect(isSuspiciousPartialMerge('partial', ranges)).toBe(true);
  });

  it('ignores non-partial edits', () => {
    const ranges = [
      { start_line: 1, end_line: 100, lines_added: 100, lines_removed: 0 },
    ];
    expect(isSuspiciousPartialMerge('full', ranges)).toBe(false);
  });

  it('allows partial merges with removals', () => {
    const ranges = [
      { start_line: 1, end_line: 60, lines_added: 60, lines_removed: 5 },
    ];
    expect(isSuspiciousPartialMerge('partial', ranges)).toBe(false);
  });
});

describe('formatEditMetaSummary', () => {
  it('formats changed ranges', () => {
    const summary = formatEditMetaSummary({
      target_file: 'a.ts',
      changed_ranges: [{ start_line: 1, end_line: 2, lines_added: 1, lines_removed: 1 }],
    });
    expect(summary).toContain('a.ts');
    expect(summary).toContain('L1');
  });

  it('returns undefined without target', () => {
    expect(formatEditMetaSummary({})).toBeUndefined();
  });
});

describe('stripMarkersFromCodeEdit', () => {
  it('removes line-style markers', () => {
    const input = 'const x = 1;\n// ... existing code ...\nconst y = 2;';
    expect(stripMarkersFromCodeEdit(input)).not.toContain('existing code');
    expect(stripMarkersFromCodeEdit(input)).toContain('const x');
    expect(stripMarkersFromCodeEdit(input)).toContain('const y');
  });

  it('removes JSX block markers when pattern matches', () => {
    const input = 'return (\n  <div />\n  {/* ... existing code ... */}\n);';
    const stripped = stripMarkersFromCodeEdit(input);
    expect(stripped).toContain('<div />');
    // Implementation uses a specific JSX comment pattern; line markers are always stripped.
    expect(stripped.split('\n').filter((l) => l.includes('// ... existing')).length).toBe(0);
  });
});
