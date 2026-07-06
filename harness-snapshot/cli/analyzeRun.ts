// Post-hoc run analyzer — mines a session's transcript (+ metadata) for the
// efficiency signals a reviewer needs to find improvement opportunities: tool-call
// mix, tool-error rate, read/edit ratio, turns-to-first-edit, narration ratio,
// compaction count, and (from persisted telemetry) cache-hit rate + per-model cost.
import { readFile } from 'node:fs/promises';

const READ_TOOLS = new Set(['read', 'grep', 'glob', 'todos']);
const EDIT_TOOLS = new Set(['edit', 'write', 'multiedit']);

interface Row { seq: number; role: string; kind: string; content: string }
interface AssistantContent { content?: { type?: string; name?: string; text?: string }[] }
interface ToolContent { results?: { is_error?: boolean }[] }

export interface RunAnalysis {
  assistantTurns: number;
  toolCalls: Record<string, number>;
  totalToolCalls: number;
  toolErrors: number;
  toolErrorRate: number;
  reads: number;
  edits: number;
  readToEditRatio: number;
  turnsToFirstEdit: number | null;
  narrationOnlyTurns: number;
  compactions: number;
  // From metadata.json / persisted telemetry (undefined when not persisted):
  costUsd?: number;
  cacheHitRate?: number;
  perModel?: Record<string, { cost: number; turnCount: number }>;
}

export function analyzeTranscript(rows: Row[]): Omit<RunAnalysis, 'costUsd' | 'cacheHitRate' | 'perModel'> {
  const toolCalls: Record<string, number> = {};
  let assistantTurns = 0, totalToolCalls = 0, toolErrors = 0, reads = 0, edits = 0, narration = 0, compactions = 0;
  let turnsToFirstEdit: number | null = null;
  let assistantIdx = 0;
  for (const r of rows) {
    if (r.kind === 'summary') { compactions++; continue; }
    let c: unknown;
    try { c = JSON.parse(r.content); } catch { continue; }
    if (r.role === 'assistant') {
      assistantTurns++; assistantIdx++;
      const uses = ((c as AssistantContent).content ?? []).filter((b) => b.type === 'tool_use');
      if (uses.length === 0) narration++;
      for (const u of uses) {
        const name = u.name ?? 'unknown';
        toolCalls[name] = (toolCalls[name] ?? 0) + 1;
        totalToolCalls++;
        if (READ_TOOLS.has(name)) reads++;
        if (EDIT_TOOLS.has(name)) { edits++; turnsToFirstEdit ??= assistantIdx; }
      }
    } else if (r.role === 'tool') {
      for (const res of (c as ToolContent).results ?? []) if (res.is_error) toolErrors++;
    }
  }
  return {
    assistantTurns,
    toolCalls,
    totalToolCalls,
    toolErrors,
    toolErrorRate: totalToolCalls ? toolErrors / totalToolCalls : 0,
    reads,
    edits,
    readToEditRatio: edits ? reads / edits : reads,
    turnsToFirstEdit,
    narrationOnlyTurns: narration,
    compactions,
  };
}

export async function analyzeRun(sessionId: string): Promise<RunAnalysis> {
  const dir = `${process.env.HOME ?? '.'}/.ugly-code/session/${sessionId.replace(/[^a-zA-Z0-9_.:-]/g, '_')}`;
  const raw = await readFile(`${dir}/messages.jsonl`, 'utf8').catch(() => '');
  const rows = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Row);
  const base = analyzeTranscript(rows);
  const meta = await readFile(`${dir}/metadata.json`, 'utf8').then((s) => JSON.parse(s) as Record<string, unknown>).catch((): Record<string, unknown> => ({}));
  const cacheRead = Number(meta.cacheReadTokens ?? 0);
  const input = Number(meta.promptTokens ?? 0);
  return {
    ...base,
    costUsd: typeof meta.costUsd === 'number' ? meta.costUsd : undefined,
    cacheHitRate: cacheRead + input > 0 ? cacheRead / (cacheRead + input) : undefined,
    perModel: (meta.perModel as RunAnalysis['perModel']) ?? undefined,
  };
}

export function renderAnalysis(sessionId: string, a: RunAnalysis): string {
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
  const tools = Object.entries(a.toolCalls).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}:${v}`).join(' ');
  return [
    `run ${sessionId}`,
    `  assistant turns: ${a.assistantTurns} | tool calls: ${a.totalToolCalls} | narration-only: ${a.narrationOnlyTurns} | compactions: ${a.compactions}`,
    `  tool-error rate: ${pct(a.toolErrorRate)} (${a.toolErrors}/${a.totalToolCalls})`,
    `  reads: ${a.reads} | edits: ${a.edits} | read:edit ratio: ${a.readToEditRatio.toFixed(1)} | turns-to-first-edit: ${a.turnsToFirstEdit ?? 'never'}`,
    `  tools: ${tools}`,
    a.cacheHitRate !== undefined ? `  cache-hit rate: ${pct(a.cacheHitRate)}` : `  cache-hit rate: (not persisted)`,
    a.costUsd !== undefined ? `  cost: $${a.costUsd.toFixed(4)}` : '',
  ].filter(Boolean).join('\n');
}
