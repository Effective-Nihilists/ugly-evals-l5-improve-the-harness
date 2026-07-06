// A/B comparison harness — run a task (or set of tasks) under a matrix of
// configs (model × pattern) and render a scoreboard of score / cost / turns per
// cell. This is the machinery that produces the episodes' pro/con numbers.
import { runEval, type EvalRunResult } from './evalRun';

export interface CompareConfig { label: string; model?: string; pattern?: string; toolset?: string }
export interface CompareSpec { tasks: string[]; configs: CompareConfig[] }
export interface Cell extends EvalRunResult { task: string; config: string }
export interface ComparisonResult { cells: Cell[]; ranAt: number }

/** Run every (task × config) cell sequentially. `runOne` is injected for tests. */
export async function runComparison(
  spec: CompareSpec,
  ctx: { origin: string; token: string; ranAt: number },
  runOne: (cfg: { taskName: string; origin: string; token: string; model?: string; pattern?: string; toolset?: string }) => Promise<EvalRunResult> = runEval,
): Promise<ComparisonResult> {
  const cells: Cell[] = [];
  for (const task of spec.tasks) {
    for (const config of spec.configs) {
      try {
        const r = await runOne({
          taskName: task,
          origin: ctx.origin,
          token: ctx.token,
          ...(config.model ? { model: config.model } : {}),
          ...(config.pattern ? { pattern: config.pattern } : {}),
          ...(config.toolset ? { toolset: config.toolset } : {}),
        });
        cells.push({ task, config: config.label, ...r });
      } catch (e) {
        cells.push({ task, config: config.label, score: 0, scoreMax: 0, costUsd: 0, turns: 0, resolvedPattern: null });
        process.stderr.write(`[compare] ${task} / ${config.label} failed: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }
  }
  return { cells, ranAt: ctx.ranAt };
}

/** Render the comparison as a fixed-width scoreboard: one row per task, one
 *  column group per config, cells = "score/max $cost Nturns". */
export function renderScoreboard(result: ComparisonResult): string {
  const tasks = [...new Set(result.cells.map((c) => c.task))];
  const configs = [...new Set(result.cells.map((c) => c.config))];
  const cell = (t: string, cfg: string): string => {
    const c = result.cells.find((x) => x.task === t && x.config === cfg);
    if (!c) return '—';
    return `${c.score}/${c.scoreMax} $${c.costUsd.toFixed(4)} ${c.turns}t`;
  };
  const taskW = Math.max(4, ...tasks.map((t) => t.length));
  const colW = Math.max(...configs.map((cfg) => cfg.length), ...tasks.flatMap((t) => configs.map((cfg) => cell(t, cfg).length)));
  const pad = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - s.length));
  const header = `${pad('task', taskW)} | ${configs.map((cfg) => pad(cfg, colW)).join(' | ')}`;
  const sep = '-'.repeat(header.length);
  const rows = tasks.map((t) => `${pad(t, taskW)} | ${configs.map((cfg) => pad(cell(t, cfg), colW)).join(' | ')}`);
  return [header, sep, ...rows].join('\n');
}
