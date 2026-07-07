// Reconstruct USER prompts a late-attaching viewer missed.
//
// The coding agent emits the user prompt as a task event at TURN START. A device that
// attaches a beat later (common right after the host task is (re)created) never sees it
// live, and the task snapshot carries no messages — so the reply renders with no prompt
// above it. On attach we re-pull the persisted transcript and splice the missing prompts
// back into the rendered list.
//
// Only USER rows are spliced: their id is the stable `${sessionId}:${seq}` (identical live
// and persisted), so this dedups by id. Assistant rows use a random live id that differs
// from their persisted seq-id, so replaying them here would DOUBLE-render — they stream
// live and are deliberately left alone.

export interface OrderableRow {
  id: string;
  role: string;
}

export interface HistoryRow {
  id: string;
  role: string;
  /** Extracted plain text of the row (empty rows are skipped). */
  text: string;
}

/**
 * Return `current` with any missing USER rows from `history` spliced in, each positioned by
 * its order in `history`. A `current` row absent from `history` (a live-streaming reply,
 * random id) is treated as NEWER than every history row, so a missing prompt lands just
 * before the in-flight reply. Pure + idempotent (rows already present by id are skipped).
 */
export function spliceMissingUserRows<M extends OrderableRow>(
  current: M[],
  history: HistoryRow[],
  makeUserRow: (id: string, text: string) => M,
): M[] {
  const histIds = history.map((h) => h.id);
  const have = new Set(current.map((m) => m.id));
  let out = current;
  for (let hi = 0; hi < history.length; hi++) {
    const hm = history[hi];
    if (hm.role !== 'user' || have.has(hm.id) || !hm.text) continue;
    // Insert before the first rendered row that appears AFTER this prompt in history; a
    // rendered row not in history (live-streaming) counts as after → prompt goes before it.
    let insertAt = out.length;
    for (let ri = 0; ri < out.length; ri++) {
      const pos = histIds.indexOf(out[ri].id);
      if (pos === -1 || pos > hi) {
        insertAt = ri;
        break;
      }
    }
    out = [...out.slice(0, insertAt), makeUserRow(hm.id, hm.text), ...out.slice(insertAt)];
    have.add(hm.id);
  }
  return out;
}
