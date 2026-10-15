/**
 * Size limit of a tool result before it goes back to the model. Both fields are optional and the
 * whole section is off by default: without a limit a result is passed on exactly as the tool returned it.
 */
export interface ToolResultLimit {
  /** Longest result in characters (UTF-16 code units, like `string.length`). Omitted / invalid -> no limit. */
  maxChars?: number;
  /** Longest result in UTF-8 bytes. Omitted / invalid -> no limit. */
  maxBytes?: number;
}

/** What a truncation cut away; reported in the tool call meta as `toolResultTruncated`. */
export interface ToolResultTruncation {
  originalChars: number;
  originalBytes: number;
  keptChars: number;
  keptBytes: number;
}

export interface LimitedToolResult {
  content: string;
  /** Set only when the content was cut. */
  truncation?: ToolResultTruncation;
}

function validLimit(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined;
}

/** True when the limit has at least one usable field. */
export function isToolResultLimitActive(limit?: ToolResultLimit): boolean {
  return validLimit(limit?.maxChars) !== undefined || validLimit(limit?.maxBytes) !== undefined;
}

function truncationNote(originalChars: number, originalBytes: number, keptChars: number): string {
  return `\n[truncated: the tool result was ${originalChars} characters (${originalBytes} bytes); only the first ${keptChars} characters are shown, the rest was cut]`;
}

/** Longest prefix of `text` (whole characters) that fits `maxChars` characters and `maxBytes` bytes. */
function headWithin(text: string, maxChars: number, maxBytes: number): string {
  let head = text.length > maxChars ? text.slice(0, maxChars) : text;
  // Never end on half of a surrogate pair.
  if (head.length < text.length && head.length > 0) {
    const last = head.charCodeAt(head.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  }
  const bytes = Buffer.from(head, 'utf8');
  if (bytes.length <= maxBytes) return head;
  let end = maxBytes;
  // A continuation byte at the cut means the cut is inside a character: step back to its start.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

/**
 * Cuts `content` to the limit and appends a `[truncated: ...]` note. The note counts against the
 * limit, so the returned content fits it, unless the limit is smaller than the note itself: then
 * only the note is returned. Content within the limit, and a missing limit, return the input as is.
 */
export function limitToolResult(content: string, limit?: ToolResultLimit): LimitedToolResult {
  const maxChars = validLimit(limit?.maxChars);
  const maxBytes = validLimit(limit?.maxBytes);
  if (maxChars === undefined && maxBytes === undefined) return { content };

  const originalChars = content.length;
  const originalBytes = Buffer.byteLength(content, 'utf8');
  if ((maxChars === undefined || originalChars <= maxChars) && (maxBytes === undefined || originalBytes <= maxBytes)) {
    return { content };
  }

  // The note names the kept length, which depends on the room the note leaves: settle it in two passes.
  const room = (note: string) => ({
    chars: maxChars === undefined ? Number.MAX_SAFE_INTEGER : Math.max(0, maxChars - note.length),
    bytes: maxBytes === undefined ? Number.MAX_SAFE_INTEGER : Math.max(0, maxBytes - Buffer.byteLength(note, 'utf8')),
  });
  let note = truncationNote(originalChars, originalBytes, originalChars);
  let budget = room(note);
  let head = headWithin(content, budget.chars, budget.bytes);
  note = truncationNote(originalChars, originalBytes, head.length);
  budget = room(note);
  head = headWithin(head, budget.chars, budget.bytes);
  note = truncationNote(originalChars, originalBytes, head.length);

  const limited = `${head}${note}`;
  return {
    content: limited,
    truncation: {
      originalChars,
      originalBytes,
      keptChars: head.length,
      keptBytes: Buffer.byteLength(head, 'utf8'),
    },
  };
}
