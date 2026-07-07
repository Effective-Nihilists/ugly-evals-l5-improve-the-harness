/**
 * Hashline anchor edit helpers — ported from ugly-studio
 * f5a74c2^:server/coding-agent/tools/hashline.ts.
 *
 * Line-hash anchors replace fragile string-matching for edits: `read_file`
 * annotates every line as `<line>:<hash>|<content>`, and edits reference a
 * `<line>:<hash>` anchor whose hash is re-verified at apply time — catching the
 * "old_string not found"/stale-context failure class. The hash is OPTIONAL: a
 * bare line number opts out of stale-edit protection.
 *
 * Source: https://blog.can.ac/2026/02/12/the-harness-problem/
 */

/**
 * Compute a 2-hex-char line hash. Deterministic + synchronous + browser-safe
 * (node crypto isn't available in the renderer). FNV-1a over content + '\n' +
 * lineIdx, low byte as 2 hex chars. Collision resistance is cosmetic — this only
 * guards against accidental line drift; annotate + verify use the same function
 * so it's self-consistent regardless of the exact values.
 */
export function computeLineHash(content: string, lineIdx: number): string {
  const s = `${content}\n${lineIdx}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) & 0xff).toString(16).padStart(2, '0');
}

export const DEFAULT_READ_LIMIT = 2000;

/** Render a file body as hashline-annotated `read_file` output: each line as
 *  `<n>:<hash>|<content>`, wrapped in a <file> element, with offset/limit slicing
 *  and a truncation notice. Line hashes use the ABSOLUTE line index so an anchor
 *  copied from this output verifies against the full file. Pure. */
export function formatHashlineRead(
  path: string,
  body: string,
  offset = 0,
  limit: number = DEFAULT_READ_LIMIT,
): string {
  const stripped = body.endsWith('\n') ? body.slice(0, -1) : body;
  const allLines = stripped.length === 0 ? [] : stripped.split('\n');
  const off = Math.max(0, offset);
  const lim = Math.max(1, limit);
  const slice = allLines.slice(off, off + lim);
  const rendered = slice
    .map((line, i) => {
      const lineIdx = off + i;
      const num = String(lineIdx + 1).padStart(6, ' ');
      return `${num}:${computeLineHash(line, lineIdx)}|${line}`;
    })
    .join('\n');
  const wrapped = `<file path="${path}">\n${rendered}${rendered.length > 0 ? '\n' : ''}</file>\n`;
  const truncated =
    allLines.length > off + lim
      ? `[truncated: ${allLines.length - off - lim} more lines]\n`
      : '';
  return wrapped + truncated;
}

/** One annotated line as `read_file` emits it. */
export interface AnnotatedLine {
  lineNumber: number; // 1-based for display
  hash: string;
  content: string;
  /** The full anchor string, e.g. "42:a3". */
  anchor: string;
}

/** Split a file body into annotated lines with hash anchors. */
export function annotateLines(body: string): AnnotatedLine[] {
  const stripped = body.endsWith('\n') ? body.slice(0, -1) : body;
  const lines = stripped.length === 0 ? [] : stripped.split('\n');
  return lines.map((content, idx) => {
    const hash = computeLineHash(content, idx);
    const lineNumber = idx + 1;
    return { lineNumber, hash, content, anchor: `${lineNumber}:${hash}` };
  });
}

export interface ParsedAnchor {
  lineNumber: number;
  /** 2-hex content hash. Absent → verification trusts the line number. */
  hash?: string;
}

/**
 * Parse an anchor reference. Accepts "42:a3", "42", 42, or a verbatim `read_file`
 * line "42:a3|<content...>". Hash optional. Null on bad input.
 */
export function parseAnchor(ref: string | number): ParsedAnchor | null {
  if (typeof ref === 'number') {
    if (!Number.isInteger(ref) || ref < 1) return null;
    return { lineNumber: ref };
  }
  const trimmed = ref.trim();
  const withHash = /^(\d+):([0-9a-fA-F]{2})(?:\|.*)?$/s.exec(trimmed);
  if (withHash) {
    const lineNumber = parseInt(withHash[1], 10);
    if (!Number.isFinite(lineNumber) || lineNumber < 1) return null;
    return { lineNumber, hash: withHash[2].toLowerCase() };
  }
  if (/^\d+$/.test(trimmed)) {
    const lineNumber = parseInt(trimmed, 10);
    if (!Number.isFinite(lineNumber) || lineNumber < 1) return null;
    return { lineNumber };
  }
  return null;
}

export interface ParsedRange {
  start: ParsedAnchor;
  end: ParsedAnchor;
}

/** Parse an inclusive range "42:a3..47:b1" / "42..47" / "42:a3..47". Null on bad input. */
export function parseAnchorRange(ref: string): ParsedRange | null {
  const parts = ref.split('..');
  if (parts.length !== 2) return null;
  const start = parseAnchor(parts[0].trim());
  const end = parseAnchor(parts[1].trim());
  if (!start || !end) return null;
  if (end.lineNumber < start.lineNumber) return null;
  return { start, end };
}

export interface HashMismatchDiagnostic {
  requestedAnchor: string;
  requestedLineNumber: number;
  requestedHash: string | undefined;
  actualHash: string | null; // null when the line does not exist
  actualLineCount: number;
  actualContent: string | null;
}

/** Verify an anchor against the current file. Null when valid; a diagnostic otherwise. */
export function verifyAnchor(
  body: string,
  anchor: ParsedAnchor,
): HashMismatchDiagnostic | null {
  const annotated = annotateLines(body);
  const anchorStr = anchor.hash
    ? `${anchor.lineNumber}:${anchor.hash}`
    : `${anchor.lineNumber}`;
  if (anchor.lineNumber > annotated.length) {
    return {
      requestedAnchor: anchorStr,
      requestedLineNumber: anchor.lineNumber,
      requestedHash: anchor.hash,
      actualHash: null,
      actualLineCount: annotated.length,
      actualContent: null,
    };
  }
  if (anchor.hash === undefined) return null;
  const row = annotated[anchor.lineNumber - 1];
  if (row.hash !== anchor.hash) {
    return {
      requestedAnchor: anchorStr,
      requestedLineNumber: anchor.lineNumber,
      requestedHash: anchor.hash,
      actualHash: row.hash,
      actualLineCount: annotated.length,
      actualContent: row.content,
    };
  }
  return null;
}

export type HashlineOp =
  | { kind: 'replace_line'; anchor: ParsedAnchor; newContent: string }
  | { kind: 'replace_range'; range: ParsedRange; newContent: string }
  | { kind: 'insert_after'; anchor: ParsedAnchor; newContent: string }
  | { kind: 'delete_range'; range: ParsedRange };

export interface ApplyResult {
  ok: boolean;
  newBody?: string;
  diagnostic?: string;
}

export function applyHashlineOp(body: string, op: HashlineOp): ApplyResult {
  const stripped = body.endsWith('\n') ? body.slice(0, -1) : body;
  const trailingNewline = body.endsWith('\n');
  const lines = stripped.length === 0 ? [] : stripped.split('\n');
  const diag = (msg: string): ApplyResult => ({ ok: false, diagnostic: msg });

  const checkAnchor = (anchor: ParsedAnchor, label: string): string | null => {
    const mismatch = verifyAnchor(body, anchor);
    if (!mismatch) return null;
    if (mismatch.actualHash === null) {
      return `${label} anchor ${mismatch.requestedAnchor} refers to line ${mismatch.requestedLineNumber}, but the file only has ${mismatch.actualLineCount} lines. Re-read the file and pick an anchor in range.`;
    }
    return `${label} anchor ${mismatch.requestedAnchor} has a stale hash — line ${mismatch.requestedLineNumber} is now anchor ${mismatch.requestedLineNumber}:${mismatch.actualHash}, content: ${JSON.stringify(mismatch.actualContent)}. Re-read the file and retry with the current anchor.`;
  };

  if (op.kind === 'replace_line') {
    const err = checkAnchor(op.anchor, 'replace_line');
    if (err) return diag(err);
    const out = [
      ...lines.slice(0, op.anchor.lineNumber - 1),
      ...op.newContent.split('\n'),
      ...lines.slice(op.anchor.lineNumber),
    ];
    return { ok: true, newBody: out.join('\n') + (trailingNewline ? '\n' : '') };
  }

  if (op.kind === 'replace_range') {
    const errStart = checkAnchor(op.range.start, 'replace_range start');
    if (errStart) return diag(errStart);
    const errEnd = checkAnchor(op.range.end, 'replace_range end');
    if (errEnd) return diag(errEnd);
    const out = [
      ...lines.slice(0, op.range.start.lineNumber - 1),
      ...op.newContent.split('\n'),
      ...lines.slice(op.range.end.lineNumber),
    ];
    return { ok: true, newBody: out.join('\n') + (trailingNewline ? '\n' : '') };
  }

  if (op.kind === 'insert_after') {
    const err = checkAnchor(op.anchor, 'insert_after');
    if (err) return diag(err);
    const out = [
      ...lines.slice(0, op.anchor.lineNumber),
      ...op.newContent.split('\n'),
      ...lines.slice(op.anchor.lineNumber),
    ];
    return { ok: true, newBody: out.join('\n') + (trailingNewline ? '\n' : '') };
  }

  // op.kind is type-narrowed to 'delete_range' here; keep the explicit guard +
  // trailing diag() as a runtime safety net for a malformed op.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (op.kind === 'delete_range') {
    const errStart = checkAnchor(op.range.start, 'delete_range start');
    if (errStart) return diag(errStart);
    const errEnd = checkAnchor(op.range.end, 'delete_range end');
    if (errEnd) return diag(errEnd);
    const out = [
      ...lines.slice(0, op.range.start.lineNumber - 1),
      ...lines.slice(op.range.end.lineNumber),
    ];
    return { ok: true, newBody: out.join('\n') + (trailingNewline ? '\n' : '') };
  }

  return diag('unknown hashline op');
}
