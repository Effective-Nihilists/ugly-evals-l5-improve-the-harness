// Per-session set of files the agent has edited since the last index search.
// Drained (and sent to the host `codebase.update`) before an index-backed
// search so `fts`/`semantic`/`mixed` reflect the agent's own edits, per the
// semantic-search freshness fix.

const dirty = new Map<string, Set<string>>();

/** Record that `path` changed in this session (write/edit/multiedit). */
export function markDirty(sessionId: string, path: string): void {
  if (!sessionId || !path) return;
  let s = dirty.get(sessionId);
  if (!s) {
    s = new Set();
    dirty.set(sessionId, s);
  }
  s.add(path);
}

/** Return and clear this session's dirty paths (empty array if none). */
export function drainDirty(sessionId: string): string[] {
  const s = dirty.get(sessionId);
  if (!s || s.size === 0) return [];
  const out = [...s];
  s.clear();
  return out;
}
