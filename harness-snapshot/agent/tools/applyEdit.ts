// Apply a single edit operation to a file body, in any of the monolith's modes:
// string-match (old_string/new_string/replace_all) or hashline anchors
// (anchor/insert_after/range + new_content). Pure — returns the new body or an
// error string. Shared by edit_file and multiedit.

import {
  parseAnchor,
  parseAnchorRange,
  applyHashlineOp,
  type HashlineOp,
} from './hashline';

export interface EditOp {
  old_string?: string;
  new_string?: string;
  replace_all?: boolean;
  anchor?: string | number;
  insert_after?: string | number;
  range?: string;
  new_content?: string;
}

export interface EditResult {
  ok: boolean;
  body?: string;
  error?: string;
}

export function applyEdit(body: string, e: EditOp): EditResult {
  const newContent = e.new_content ?? e.new_string ?? '';

  // ── Hashline anchor modes ──
  if (e.anchor != null || e.insert_after != null || e.range != null) {
    let op: HashlineOp;
    if (e.range != null) {
      const range = parseAnchorRange(e.range);
      if (!range) return { ok: false, error: `could not parse range ${JSON.stringify(e.range)} (expected "42..47" or "42:a3..47:b1")` };
      op = newContent ? { kind: 'replace_range', range, newContent } : { kind: 'delete_range', range };
    } else if (e.insert_after != null) {
      const anchor = parseAnchor(e.insert_after);
      if (!anchor) return { ok: false, error: `could not parse insert_after ${JSON.stringify(e.insert_after)}` };
      op = { kind: 'insert_after', anchor, newContent };
    } else {
      const anchor = parseAnchor(e.anchor!);
      if (!anchor) return { ok: false, error: `could not parse anchor ${JSON.stringify(e.anchor)} (expected "42" or "42:a3")` };
      op = { kind: 'replace_line', anchor, newContent };
    }
    const r = applyHashlineOp(body, op);
    return r.ok ? { ok: true, body: r.newBody } : { ok: false, error: r.diagnostic };
  }

  // ── String-match mode ──
  const oldStr = e.old_string ?? '';
  if (!oldStr) return { ok: false, error: 'provide one of old_string, anchor, insert_after, or range' };
  const newStr = e.new_string ?? '';
  if (e.replace_all) {
    if (!body.includes(oldStr)) return { ok: false, error: 'old_string not found' };
    return { ok: true, body: body.split(oldStr).join(newStr) };
  }
  const idx = body.indexOf(oldStr);
  if (idx === -1) return { ok: false, error: 'old_string not found' };
  if (body.includes(oldStr, idx + oldStr.length)) {
    return { ok: false, error: 'old_string is not unique — add surrounding context or use replace_all' };
  }
  return { ok: true, body: body.slice(0, idx) + newStr + body.slice(idx + oldStr.length) };
}
