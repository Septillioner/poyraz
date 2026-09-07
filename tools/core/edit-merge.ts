import path from 'path';

export const EXISTING_CODE_MARKERS = [
  '// ... existing code ...',
  '# ... existing code ...',
  '/* ... existing code ... */',
  '<!-- ... existing code ... -->',
  '{/* ... existing code ... */}',
] as const;

export const JSX_EXTENSIONS = new Set(['.jsx', '.tsx']);
export const JS_LINE_MARKER = '// ... existing code ...';
export const JSX_BLOCK_MARKER = '{/* ... existing code ... */}';

export type MergeResult = { ok: true; content: string } | { ok: false; message: string };

export function hasExistingCodeMarker(codeEdit: string): boolean {
  return EXISTING_CODE_MARKERS.some((marker) => codeEdit.includes(marker));
}

export function getActiveMarker(codeEdit: string): string | undefined {
  return EXISTING_CODE_MARKERS.find((marker) => codeEdit.includes(marker));
}

export function countActiveMarkers(codeEdit: string, marker: string): number {
  return codeEdit.split(marker).length - 1;
}

export function validateEditRequest(
  targetFile: string,
  codeEdit: string,
  fileExists: boolean,
  existingContent: string
): string | null {
  if (!fileExists) return null;

  const hasMarker = hasExistingCodeMarker(codeEdit);
  // A single trailing newline is not a content line; counting it makes a
  // genuine full rewrite (which usually omits the trailing blank) look like a
  // shorter partial snippet and get rejected.
  const existingLineCount = existingContent.replace(/\n$/, '').split('\n').length;
  const editLineCount = codeEdit.replace(/\n$/, '').split('\n').length;

  if (!hasMarker && editLineCount < existingLineCount) {
    return (
      'Partial edit on an existing file requires markers or the full file in code_edit. ' +
      'Read the file and resend with // ... existing code ... markers or a complete rewrite.'
    );
  }

  const marker = getActiveMarker(codeEdit);
  if (marker && countActiveMarkers(codeEdit, marker) === 1) {
    return (
      'Partial edit requires BOTH before and after markers (at least two markers). ' +
      'Include unchanged code spans on each side of your change.'
    );
  }

  const ext = path.extname(targetFile).toLowerCase();
  if (
    JSX_EXTENSIONS.has(ext) &&
    codeEdit.includes(JS_LINE_MARKER) &&
    !codeEdit.includes(JSX_BLOCK_MARKER)
  ) {
    return (
      'JSX/TSX files: use {/* ... existing code ... */} inside return (...), ' +
      'not // ... existing code .... Or rewrite the full file.'
    );
  }

  return null;
}

function findLineIndex(lines: string[], needle: string, fromIndex = 0): number {
  const trimmed = needle.trim();
  for (let i = fromIndex; i < lines.length; i++) {
    if (lines[i].trim() === trimmed || lines[i].includes(trimmed)) {
      return i;
    }
  }
  return -1;
}

// A marker-adjacent part (text before/after "... existing code ...") often carries
// blank lines from the marker boundary. Those are not real content, so trim them
// while preserving indentation and interior blank lines.
function toContentLines(part: string): string[] {
  const lines = part.split('\n');
  while (lines.length > 0 && lines[0].trim().length === 0) lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim().length === 0) lines.pop();
  return lines;
}

export function mergeTwoParts(existingContent: string, before: string, after: string): MergeResult {
  const existingLines = existingContent.split('\n');
  const beforeLines = toContentLines(before);
  const afterLines = toContentLines(after);

  // Anchor the before block by its FIRST line and the after block by its LAST
  // line. This keeps the outer file content intact and lets the marker preserve
  // the untouched span between the two blocks, instead of re-appending the
  // anchor lines (which duplicated content in the previous implementation).
  const beforeFirst = beforeLines.length > 0 ? findLineIndex(existingLines, beforeLines[0]) : 0;
  if (beforeLines.length > 0 && beforeFirst < 0) {
    return {
      ok: false,
      message:
        'Could not locate before-context anchor in the file. Read the file and include unique anchor lines from it.',
    };
  }

  const beforeLast =
    beforeLines.length > 0
      ? findLineIndex(existingLines, beforeLines[beforeLines.length - 1], Math.max(beforeFirst, 0))
      : -1;

  const afterSearchFrom = beforeLast >= 0 ? beforeLast + 1 : Math.max(beforeFirst, 0);
  const afterFirst =
    afterLines.length > 0
      ? findLineIndex(existingLines, afterLines[0], afterSearchFrom)
      : existingLines.length;
  if (afterLines.length > 0 && afterFirst < 0) {
    return {
      ok: false,
      message:
        'Could not locate after-context anchor in the file. Read the file and include unique anchor lines from it.',
    };
  }

  const afterLast =
    afterLines.length > 0
      ? findLineIndex(existingLines, afterLines[afterLines.length - 1], afterFirst)
      : existingLines.length - 1;

  const outerBeforeEnd = beforeFirst >= 0 ? beforeFirst : 0;
  const middleStart = beforeLast >= 0 ? beforeLast + 1 : 0;
  const middleEnd = afterFirst >= 0 ? afterFirst : existingLines.length;
  const outerAfterStart = afterLast >= 0 ? afterLast + 1 : existingLines.length;

  const preservedMiddle =
    middleEnd > middleStart ? existingLines.slice(middleStart, middleEnd) : [];

  const merged = [
    ...existingLines.slice(0, outerBeforeEnd),
    ...beforeLines,
    ...preservedMiddle,
    ...afterLines,
    ...existingLines.slice(outerAfterStart),
  ];
  return { ok: true, content: merged.join('\n') };
}

export function applyMarkerMerge(existingContent: string, codeEdit: string): MergeResult {
  const marker = getActiveMarker(codeEdit);
  if (!marker) return { ok: true, content: codeEdit };

  const parts = codeEdit.split(marker);
  if (parts.length === 2) {
    return mergeTwoParts(existingContent, parts[0], parts[1]);
  }

  if (parts.length > 2) {
    let currentContent = existingContent;
    for (let i = 0; i < parts.length - 1; i++) {
      const result = mergeTwoParts(currentContent, parts[i], parts[i + 1]);
      if (!result.ok) return result;
      currentContent = result.content;
    }
    return { ok: true, content: currentContent };
  }

  return { ok: true, content: codeEdit };
}
