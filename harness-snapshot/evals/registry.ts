// Eval task registry — ported from app/studio's eval-bridge.ts. The 59 task
// DEFINITIONS (extracted from evals/tasks/*/task.ts via the monolith loader)
// live in tasks.json; this module derives the picker's listing (difficulty +
// "why interesting") exactly as the monolith's listEvalTasks did.
//
// Each task's FIXTURE (the buggy/seed code) is published as a public repo —
// github.com/Effective-Nihilists/ugly-evals-<task> — recorded as `repoUrl` on
// 57/59 tasks. evalCreateProject git-clones it (see useSocket), so the agent
// works against the real code; the few fixture-less tasks get an empty project.
// Automated grading (the cloned repo's eval/ graders + judge gates) is a
// follow-up — runs aren't scored yet.

import rawTasksJson from './tasks.json';

export type EvalTaskKind = 'bug-fix' | 'feature' | 'planning';

export interface EvalGate {
  name: string;
  points: number;
  kind: string;
  description?: string;
}

export interface RawEvalTask {
  name: string;
  kind: EvalTaskKind;
  turns: string[];
  successCriteria: string;
  budget: { maxTurns: number; maxCostUsd: number; timeoutMs: number };
  tags?: string[];
  fixture?: string;
  setup?: unknown;
  repoUrl?: string;
  ticketPath?: string;
  gates?: EvalGate[];
  /** Host-side workspace prep run after clone (SBP tasks: uv venv + pip install)
   *  so the agent + grader can run the repo's tests. */
  reproSetup?: { commands: string[]; perCommandTimeoutMs?: number; env?: Record<string, string> };
  /** Curated capability-ladder level 1-5 (simple bug fix → real-world agentic).
   *  Authored on the 25 ladder tasks; when absent the picker falls back to the
   *  derived `difficulty`. Purely a UI grouping signal — the CLI ignores it. */
  level?: number;
}

export interface ListedEvalTask {
  name: string;
  kind: EvalTaskKind;
  turns: string[];
  ticketPath?: string;
  successCriteria: string;
  hasFixture: boolean;
  hasSetup: boolean;
  hasChecker: boolean;
  gates?: EvalGate[];
  tags?: string[];
  difficulty: number;
  /** Curated ladder level 1-5 for grouping in the picker. Authored `level` when
   *  present, else the derived `difficulty` so every task still buckets. */
  level: number;
  whyInteresting: string;
}

const RAW_TASKS = rawTasksJson as unknown as RawEvalTask[];

/** Heuristic difficulty 1-5 from observable task signals (port of
 *  eval-bridge.describeTaskDifficulty). */
function describeTaskDifficulty(task: RawEvalTask): number {
  const tags = task.tags ?? [];
  const has = (t: string): boolean => tags.includes(t);
  let score = 2;
  if (task.kind === 'feature') score += 1;
  if (task.turns.length > 1) score += 1;
  if (task.budget.maxTurns >= 40 || task.budget.maxCostUsd >= 4) score += 1;
  if (has('agentic') || has('impossible') || has('boss')) score += 1;
  if (has('tournament-discriminator')) score += 1;
  if (has('short-adversarial') || has('simple') || has('smoke') || has('harness-health')) score -= 1;
  if (task.name.startsWith('smoke-')) score -= 1;
  return Math.max(1, Math.min(5, score));
}

/** One-line "why this is interesting" blurb (port of
 *  eval-bridge.describeTaskInterest). */
function describeTaskInterest(task: RawEvalTask): string {
  const tags = task.tags ?? [];
  const has = (t: string): boolean => tags.includes(t);
  if (has('misleading-error') || has('misleading-stack')) return 'Misleading error — symptom is far from the real cause';
  if (has('misleading-evidence')) return 'Misleading evidence — bait toward the wrong fix';
  if (has('indirect-symptom') || has('indirect')) return 'Indirect symptom — fix lives where you wouldn’t look first';
  if (has('workaround-trap')) return 'Workaround trap — easy fix masks the real bug';
  if (has('taste')) return 'Subjective taste / visual polish judgment';
  if (has('discipline')) return 'Discipline check — the obvious fix breaks the contract';
  if (has('constraint')) return 'Constrained — fix must live in a specific subtree';
  if (has('ordering')) return 'Multi-file refactor where order matters';
  if (has('multi-file')) return 'Multi-file change that must stay coherent';
  if (has('leak-check')) return 'Leak check — must release every acquired resource';
  if (has('concurrency')) return 'Concurrent state — race + ordering invariants';
  if (has('async')) return 'Async correctness under partial failure';
  if (has('idempotency')) return 'Idempotency invariant — re-runs must be no-ops';
  if (has('config')) return 'Bug is in the config, not the source';
  if (has('doc-contract')) return 'Agent must read the doc, not just the test';
  if (has('spec-from-tests')) return 'Tests are the spec — infer behavior from assertions';
  if (has('vague') || has('open-ended') || has('scoping')) return 'Vague brief — agent has to scope and decide';
  if (has('verification-required')) return 'Verification required — write the fix and prove it';
  if (has('plan-quality')) return 'Plan-quality judgment — coherent plan, no code edits';
  if (has('real-world-regression')) return 'Real-world regression scenario';
  if (has('incident')) return 'Live incident response — reconstruct what happened';
  if (has('breaking-change') || has('callers')) return 'Find every caller of a changed API';
  if (has('rfc-conformance')) return 'Conform to an external RFC / standard';
  if (has('cron')) return 'Cron / scheduler correctness';
  if (has('compaction')) return 'History compaction edge case';
  if (has('cross-review')) return 'Cross-model review pass after the run';
  if (has('multi-strategy')) return 'Multiple viable strategies — agent must commit to one';
  if (has('tournament-discriminator')) return 'Designed to separate strong models from weak';
  if (has('impossible')) return 'Looks unsolvable — discipline matters more than the fix';
  if (has('boss')) return 'Boss-level — scaffold a real app from scratch';
  if (has('agentic')) return 'Long-horizon investigation, no obvious path';
  if (has('short-adversarial') || has('edge-cases')) return 'Short trap with adversarial edge cases';
  if (has('algorithm')) return 'Algorithm correctness on edge inputs';
  if (has('numeric')) return 'Numeric overflow / precision edge case';
  if (has('regex')) return 'Regex precision under tricky inputs';
  if (has('animation') || has('css') || has('html')) return 'Frontend / visual polish';
  if (has('react')) return 'React-specific behavior';
  if (has('full-stack')) return 'Full-stack change touching client + server';
  if (has('tsc')) return 'TypeScript correctness';
  if (has('simple') || has('smoke') || has('harness-health')) return 'Trivial smoke check — does anything work at all?';
  if (task.kind === 'planning') return 'Planning task — produce a plan, no code edits';
  if (task.kind === 'feature') return 'Feature addition with structural constraints';
  return 'Bug fix with non-obvious invariants';
}

/** The picker's task list — derived from the bundled defs, sorted easy → hard. */
export function listEvalTasks(): { tasks: ListedEvalTask[]; dockerOnlyHidden: number } {
  const tasks: ListedEvalTask[] = RAW_TASKS.map((t) => ({
    name: t.name,
    kind: t.kind,
    turns: t.turns,
    ...(t.ticketPath ? { ticketPath: t.ticketPath } : {}),
    successCriteria: t.successCriteria,
    hasFixture: !!t.fixture || !!t.repoUrl,
    hasSetup: !!t.setup,
    hasChecker: false, // graders not ported yet
    ...(t.gates ? { gates: t.gates } : {}),
    ...(t.tags ? { tags: t.tags } : {}),
    difficulty: describeTaskDifficulty(t),
    level: t.level ?? describeTaskDifficulty(t),
    whyInteresting: describeTaskInterest(t),
  }));
  // Group easy → hard by ladder level, then by derived difficulty, then name.
  tasks.sort((a, b) =>
    a.level !== b.level ? a.level - b.level : a.difficulty !== b.difficulty ? a.difficulty - b.difficulty : a.name.localeCompare(b.name),
  );
  return { tasks, dockerOnlyHidden: 0 };
}

export function getEvalTask(name: string): RawEvalTask | undefined {
  return RAW_TASKS.find((t) => t.name === name);
}

/** The prompt to pre-fill for a task's first turn (port of computeFirstTurnPrompt). */
export function firstTurnPrompt(task: RawEvalTask): string {
  const turn0 = task.turns[0] ?? '';
  if (task.ticketPath && turn0.length === 0) {
    return `Read ${task.ticketPath}, then complete the task it describes.`;
  }
  return turn0;
}
