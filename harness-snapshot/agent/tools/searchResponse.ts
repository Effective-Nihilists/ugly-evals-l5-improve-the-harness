// Client mirror of the host `codebase.search` contract (ugly-studio
// server/coding-agent/indexer/client.ts) + the agent-facing text formatter.
// The discriminated status means a cold/failed index surfaces a reason instead
// of a silent empty list.

export type SearchMode = 'grep' | 'fts' | 'semantic' | 'mixed';

export interface SearchHit {
  file_path: string;
  start_line: number;
  end_line: number;
  content: string;
  mode: SearchMode;
  score: number;
  fts_rank?: number;
  semantic_score?: number;
  rerank_score?: number | null;
}

export type SearchResponse =
  | { status: 'ready'; results: SearchHit[] }
  | { status: 'indexing' | 'provisioning' | 'downloading-model' }
  | { status: 'unavailable'; error: string };

/** Provenance suffix like `mixed 0.87 · fts#3 · sem 0.71` — shows which
 *  retriever(s) matched and their sub-scores. */
export function provenance(h: SearchHit): string {
  const parts = [`${h.mode} ${h.score.toFixed(2)}`];
  if (h.fts_rank !== undefined) parts.push(`fts#${h.fts_rank}`);
  if (h.semantic_score !== undefined) parts.push(`sem ${h.semantic_score.toFixed(2)}`);
  return parts.join(' · ');
}

/** Agent-facing text for a search response — never a silent empty list. */
export function formatSearchResult(resp: SearchResponse): string {
  if (resp.status !== 'ready') {
    if (resp.status === 'unavailable') return `(search unavailable: ${resp.error})`;
    if (resp.status === 'indexing') {
      return '(codebase indexing still in progress — retry shortly, or use mode="exact")';
    }
    // provisioning | downloading-model
    return '(search model still downloading — retry shortly, or use mode="exact"/"fts")';
  }
  if (resp.results.length === 0) {
    return '(no matches — try mode="exact" or a different query)';
  }
  return resp.results
    .map((h) => `${h.file_path}:${h.start_line}-${h.end_line}  (${provenance(h)})\n${h.content}`)
    .join('\n\n---\n\n');
}
