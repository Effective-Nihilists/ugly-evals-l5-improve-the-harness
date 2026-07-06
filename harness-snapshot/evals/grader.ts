// Client-side eval grader. Runs the task's `gates[]` against the project on
// disk (via native process/fs) and produces the EvalGradeResult the scorecard
// renders. Deterministic gate kinds are auto-scored; judge/custom gates are
// surfaced for manual review (the LLM-judge + repo-specific checkers are a
// follow-up). When a task defines no gates we still run tsc + the test script
// as universal signals so every run gets a score.

import type { EvalGate } from './registry';
import type { EvalGradeResult } from '../shared/api';
import { deriveCriteria, gradeAgainstCriteria, type Judge as JudgeFn } from '../agent/patterns/judge';

/** IO seam so the gate logic is unit-testable without a real daemon. */
export interface GradeDeps {
  /** Run a command in `cwd`; resolve combined output + exit code. */
  run(cmd: string, args: string[], cwd: string): Promise<{ out: string; code: number | null }>;
  readFile(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  /**
   * One-shot LLM completion for `judge:*` gates. Omitted in unit tests (judge
   * gates then stay pending); in production it calls the model via the agent's
   * textGen path. Returns the raw model text.
   */
  judge?(system: string, user: string): Promise<string>;
}

interface Check { name: string; passed: boolean; detail?: string }
type Judge = NonNullable<EvalGradeResult['judgeResults']>[number];

const COUNT_TS_ERRORS = /error TS\d+:/g;
function countTscErrors(out: string): number {
  return (out.match(COUNT_TS_ERRORS) ?? []).length;
}

/** Parse a vitest run's summary line into pass/total counts, for proportional
 *  (0–N) scoring of a fixture's own vector suite. Reads the last `Tests …` line:
 *  `Tests  30 passed | 20 failed (50)` → {30, 50}. Total falls back to
 *  passed+failed when the `(N)` is absent; {0,0} when no suite ran. */
export function parseVitestCounts(out: string): { passed: number; total: number } {
  const line = out.split('\n').reverse().find((l) => /Tests\s+\d+\s+(passed|failed)/.test(l)) ?? '';
  const passed = Number(/(\d+)\s+passed/.exec(line)?.[1] ?? 0);
  const failed = Number(/(\d+)\s+failed/.exec(line)?.[1] ?? 0);
  const totalMatch = /\((\d+)\)/.exec(line);
  const total = totalMatch ? Number(totalMatch[1]) : passed + failed;
  return { passed, total };
}

/** `fileMatches:<path>:<regex>` — split off the path, the rest is the regex
 *  (which may itself contain colons). */
function splitFileMatches(rest: string): { path: string; regex: string } {
  const i = rest.indexOf(':');
  return i === -1 ? { path: rest, regex: '' } : { path: rest.slice(0, i), regex: rest.slice(i + 1) };
}

export interface GradeInput {
  taskName: string;
  projectPath: string;
  gates?: EvalGate[];
  /** Prose success criteria — given to the LLM judge as the rubric. */
  successCriteria?: string;
  /** The agent's final assistant message — extra evidence for judge grading of
   *  planning / write-to-spec tasks where the "output" isn't a code diff. */
  finalText?: string;
  runTotals: EvalGradeResult['runTotals'];
}

/** Parse the judge's `{"points": n, "verdict": "..."}` reply, tolerant of
 *  code fences / prose around the JSON. */
export function parseJudge(text: string, max: number): { points: number; verdict: string } {
  const m = /\{[\s\S]*\}/.exec(text);
  if (m) {
    try {
      const o = JSON.parse(m[0]) as { points?: unknown; verdict?: unknown };
      const pts = Math.max(0, Math.min(max, Math.round(Number(o.points) || 0)));
      const v = o.verdict;
      const verdictRaw =
        typeof v === 'string'
          ? v
          : v == null
            ? ''
            : typeof v === 'object'
              ? JSON.stringify(v)
              : typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint'
                ? v.toString()
                : typeof v === 'symbol'
                  ? v.toString()
                  : (v as (...args: unknown[]) => unknown).toString();
      return { points: pts, verdict: verdictRaw.slice(0, 600) || 'no verdict' };
    } catch {
      /* fall through */
    }
  }
  return { points: 0, verdict: `unparseable judge reply: ${text.slice(0, 200)}` };
}

export async function gradeProject(input: GradeInput, deps: GradeDeps): Promise<EvalGradeResult> {
  const checks: Check[] = [];
  const judgeResults: Judge[] = [];
  let tscExit: number | null = null;
  let tscErrors = 0;
  let tscErrorSample: string | undefined;
  let detScore = 0;
  let detMax = 0;
  const manual: string[] = [];

  // Run + cache `tsc` / `vitest` once even if referenced by multiple gates.
  let tscRun: { out: string; code: number | null } | null = null;
  const tsc = async (): Promise<{ out: string; code: number | null }> => {
    tscRun ??= await deps.run('npx', ['tsc', '--noEmit'], input.projectPath);
    return tscRun;
  };

  const gates = input.gates ?? [];

  for (const gate of gates) {
    const kind = gate.kind;
    const pts = gate.points;

    if (kind === 'tsc') {
      const r = await tsc();
      tscExit = r.code;
      tscErrors = countTscErrors(r.out);
      const passed = r.code === 0 && tscErrors === 0;
      if (!passed) tscErrorSample = r.out.slice(0, 800);
      checks.push({ name: gate.name, passed, detail: passed ? undefined : `${tscErrors} type error(s)` });
      detMax += pts;
      if (passed) detScore += pts;
    } else if (kind === 'vitest' || kind.startsWith('vitest:')) {
      const file = kind.startsWith('vitest:') ? kind.slice('vitest:'.length) : '';
      const r = await deps.run('npx', ['vitest', 'run', ...(file ? [file] : [])], input.projectPath);
      const passed = r.code === 0;
      checks.push({ name: gate.name, passed, detail: passed ? undefined : `vitest exit ${r.code ?? 'null'}` });
      detMax += pts;
      if (passed) detScore += pts;
    } else if (kind === 'vitestScore' || kind.startsWith('vitestScore:')) {
      // Proportional pass-rate scoring against the fixture's own vitest suite
      // (e.g. rrule's 50 RFC-5545 vectors): award round(pts · passed/total) so a
      // partial implementation earns partial credit and improvements are visible.
      const file = kind.startsWith('vitestScore:') ? kind.slice('vitestScore:'.length) : '';
      const r = await deps.run('npx', ['vitest', 'run', ...(file ? [file] : [])], input.projectPath);
      const { passed: np, total: nt } = parseVitestCounts(r.out);
      const awarded = nt > 0 ? Math.round((pts * np) / nt) : 0;
      checks.push({ name: `${gate.name} (${np}/${nt})`, passed: nt > 0 && np === nt, detail: nt > 0 ? undefined : `no vitest suite ran (exit ${r.code ?? 'null'})` });
      detMax += pts;
      detScore += awarded;
    } else if (kind.startsWith('fileExists:')) {
      const rel = kind.slice('fileExists:'.length);
      const passed = await deps.exists(joinPath(input.projectPath, rel));
      checks.push({ name: gate.name, passed, detail: passed ? undefined : `${rel} not found` });
      detMax += pts;
      if (passed) detScore += pts;
    } else if (kind.startsWith('fileMatches:')) {
      const { path, regex } = splitFileMatches(kind.slice('fileMatches:'.length));
      let passed = false;
      try {
        passed = new RegExp(regex).test(await deps.readFile(joinPath(input.projectPath, path)));
      } catch {
        passed = false;
      }
      checks.push({ name: gate.name, passed, detail: passed ? undefined : `/${regex}/ not in ${path}` });
      detMax += pts;
      if (passed) detScore += pts;
    } else if (kind.startsWith('judge:')) {
      const rubricKey = kind.slice('judge:'.length);
      if (deps.judge) {
        // Score against the success criteria + the gate description, given the
        // agent's diff as evidence.
        const diff = await collectDiff(input.projectPath, deps);
        const system =
          'You are a strict automated code-eval judge. Award an INTEGER number of points from 0 ' +
          `to ${pts} based ONLY on the criteria below. Respond with JSON only: ` +
          '{"points": <int>, "verdict": "<one sentence>"}.';
        const user =
          `## Success criteria\n${input.successCriteria ?? '(none provided)'}\n\n` +
          `## Gate: ${gate.name} (max ${pts} points)\n${gate.description ?? rubricKey}\n\n` +
          `## The agent's diff\n${diff || '(no changes detected)'}`;
        let awarded = { points: 0, verdict: '' };
        try {
          awarded = parseJudge(await deps.judge(system, user), pts);
        } catch (e) {
          console.error('[grader:judge]', JSON.stringify({ gateName: gate.name, rubricKey, points: pts, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined);
          awarded = { points: 0, verdict: `judge call failed: ${(e as Error).message}` };
        }
        judgeResults.push({ gateName: gate.name, points: pts, pointsAwarded: awarded.points, rubricKey, verdict: awarded.verdict });
      } else {
        // No judge available (unit tests) — surface as pending.
        judgeResults.push({
          gateName: gate.name,
          points: pts,
          pointsAwarded: 0,
          rubricKey,
          verdict: 'LLM judge unavailable — review against the rubric manually.',
        });
        manual.push(gate.name);
      }
    } else {
      // custom:<id> — repo-specific checker; not generically runnable client-side.
      checks.push({ name: gate.name, passed: false, detail: 'manual: run the task’s eval/ checker' });
      manual.push(gate.name);
    }
  }

  // No gates defined → 5-level judge rubric: derive an acceptance rubric from
  // successCriteria, grade the diff (+ final message) per-criterion, map to 0–5.
  // Falls back to the coarse tsc+npm signals when no judge is available (unit
  // tests) or a rubric can't be derived.
  if (gates.length === 0) {
    let graded = false;
    if (deps.judge && input.successCriteria && input.successCriteria.trim().length > 0) {
      const judgeFn: JudgeFn = (system, user) => deps.judge!(system, user);
      const diff = await collectDiff(input.projectPath, deps);
      const evidence = input.finalText
        ? `${diff}\n\n## Agent's final message\n${input.finalText.slice(0, 8000)}`
        : diff;
      try {
        const criteria = await deriveCriteria(input.successCriteria, '', judgeFn);
        if (criteria.length >= 2) {
          const g = await gradeAgainstCriteria(input.successCriteria, criteria, evidence, judgeFn);
          if (g.parsed && g.verdicts.length > 0) {
            const stmt = new Map(criteria.map((c) => [c.id, c.statement]));
            for (const v of g.verdicts) {
              checks.push({
                name: `${v.id}: ${stmt.get(v.id) ?? ''}`.slice(0, 200),
                passed: v.pass,
                detail: v.reason + (v.evidence ? ` [${v.evidence}]` : ''),
              });
            }
            const passed = g.verdicts.filter((v) => v.pass).length;
            detScore = Math.round(5 * (passed / g.verdicts.length));
            detMax = 5;
            graded = true;
          }
        }
        if (!graded) {
          // Per-criterion derivation was too thin to grade — score the whole rubric
          // in one 0–5 call so every judge-capable run still yields a /5 (no /2 blip).
          const system =
            'You are a strict automated code-eval judge. Award an INTEGER from 0 to 5 for how fully ' +
            'the change satisfies the success criteria (5 = fully; 3 = mostly; 0 = not at all). ' +
            'Respond with JSON only: {"points": <int 0-5>, "verdict": "<one sentence>"}.';
          const user = `## Success criteria\n${input.successCriteria}\n\n## The agent's change + final message\n${evidence || '(no changes detected)'}`;
          const awarded = parseJudge(await deps.judge(system, user), 5);
          checks.push({ name: 'rubric (0–5)', passed: awarded.points >= 3, detail: awarded.verdict });
          detScore = awarded.points;
          detMax = 5;
          graded = true;
        }
      } catch (e) {
        console.error('[grader:judge0to5]', JSON.stringify({ taskName: input.taskName, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined);
      }
    }
    if (!graded) {
      // Coarse fallback (0–2): tsc clean for TS projects + the test script. tsc is
      // only counted when a tsconfig.json exists (else `npx tsc` fails spuriously).
      const isTsProject = await deps.exists(`${input.projectPath}/tsconfig.json`);
      if (isTsProject) {
        const r = await tsc();
        tscExit = r.code;
        tscErrors = countTscErrors(r.out);
        const tscOk = r.code === 0 && tscErrors === 0;
        if (!tscOk) tscErrorSample = r.out.slice(0, 800);
        checks.push({ name: 'tsc clean', passed: tscOk, detail: tscOk ? undefined : `${tscErrors} type error(s)` });
        detMax += 1;
        if (tscOk) detScore += 1;
      }
      const t = await deps.run('npm', ['test', '--silent'], input.projectPath);
      const testsOk = t.code === 0;
      checks.push({ name: 'tests pass', passed: testsOk, detail: testsOk ? undefined : `npm test exit ${t.code ?? 'null'}` });
      detMax += 1;
      if (testsOk) detScore += 1;
    }
  }

  const judgeMax = judgeResults.reduce((a, j) => a + j.points, 0);
  const judgeAwarded = judgeResults.reduce((a, j) => a + j.pointsAwarded, 0);
  const score = detScore + judgeAwarded;
  const scoreMax = detMax + judgeMax;
  const summary = buildSummary(detScore, detMax, judgeResults.length, manual);

  return {
    taskName: input.taskName,
    gradedAt: new Date().toISOString(),
    score,
    scoreMax,
    summary,
    checks,
    tscExit,
    tscErrors,
    ...(tscErrorSample ? { tscErrorSample } : {}),
    ...(judgeResults.length ? { judgeResults } : {}),
    runTotals: input.runTotals,
  };
}

function buildSummary(score: number, max: number, judgeCount: number, manual: string[]): string {
  let s = `Auto-graded ${score}/${max} deterministic point(s).`;
  if (judgeCount) s += ` ${judgeCount} LLM-judge gate(s) pending manual review.`;
  if (manual.length) s += ` Manual gates: ${manual.join(', ')}.`;
  return s;
}

function joinPath(base: string, rel: string): string {
  return `${base.replace(/\/$/, '')}/${rel.replace(/^\//, '')}`;
}

/** The agent's changes (capped) — evidence for the LLM judge. Stages everything
 *  first (`git add -A`) then diffs the index, so NEW/untracked files the agent
 *  wrote (e.g. DESIGN.md / DECISION.md for planning + write-to-spec tasks) are
 *  included — plain `git diff` only shows modified tracked files and would feed
 *  the judge an empty diff for doc-producing tasks. `cloneFixture` commits a
 *  baseline seed, so `--cached` diffs against that; with no baseline commit it
 *  diffs against the empty tree (still shows the new files). */
async function collectDiff(projectPath: string, deps: GradeDeps): Promise<string> {
  await deps.run('git', ['add', '-A'], projectPath);
  const r = await deps.run('git', ['diff', '--cached', '--no-color'], projectPath);
  const out = r.out;
  return out.length > 20_000 ? out.slice(0, 20_000) + '\n…(diff truncated)' : out;
}
