// Docker-free SWE-bench-Pro grader (Python subset). Ported from the grading logic
// in ugly-studio f5a74c2^:evals/tasks/sbpro-*/eval/check.ts — but run HOST-side:
// the agent already edited the cloned worktree; we apply the hidden test_patch on
// top, run pytest against the venv (created by the task's reproSetup), and score
// the deterministic 1+3+1 = 0–5 rubric:
//   1 — test_patch applies cleanly
//   3 — every fail_to_pass test now passes
//   1 — every pass_to_pass test still passes (no regression; empty = free point)
import type { GradeDeps, GradeInput } from './grader';
import type { EvalGradeResult } from '../shared/api';
import { getSbpMeta, parseSbpArray } from './sbp/registry';

interface Check { name: string; passed: boolean; detail?: string }

/** pytest -v prints `<path>::<name> PASSED|FAILED`. A test passes iff we see it
 *  followed by PASSED (and not FAILED). */
function pytestPassed(output: string, name: string): boolean {
  const trimmed = name.replace(/^\[|\]$/g, '').replace(/^['"]|['"]$/g, '').trim();
  const esc = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`${esc}\\s+FAILED`).test(output)) return false;
  if (new RegExp(`${esc}\\s+PASSED`).test(output)) return true;
  // Fallback: single selected test + a clean pytest summary.
  return output.includes(trimmed) && /\b\d+ passed\b/.test(output) && !/\bfailed\b/.test(output);
}

function countPass(output: string, names: string[]): { pass: number; failed: string[] } {
  const failed: string[] = [];
  let pass = 0;
  for (const n of names) {
    if (pytestPassed(output, n)) pass++;
    else failed.push(n);
  }
  return { pass, failed };
}

export async function gradeSbp(input: GradeInput, deps: GradeDeps): Promise<EvalGradeResult> {
  const meta = getSbpMeta(input.taskName)!;
  const checks: Check[] = [];
  const cwd = input.projectPath;

  // 1) Apply the hidden test_patch onto the agent-edited worktree.
  const patchPath = `${cwd}/.sbp-test.patch`;
  await deps.run('bash', ['-lc', `cat > ${JSON.stringify(patchPath)} <<'UGLY_SBP_EOF'\n${meta.test_patch}\nUGLY_SBP_EOF`], cwd);
  const applied = await deps.run('git', ['-C', cwd, 'apply', '--whitespace=nowarn', patchPath], cwd);
  const patchOk = applied.code === 0;
  checks.push({ name: 'test_patch applies', passed: patchOk, detail: patchOk ? undefined : applied.out.slice(-300) });
  if (!patchOk) {
    return result(input, 0, checks, `SBP: test_patch failed to apply → 0/5.`);
  }

  // 2) Run pytest against the reproSetup venv.
  const files = parseSbpArray(meta.selected_test_files_to_run);
  const pyCmd =
    `cd ${JSON.stringify(cwd)} && PYTHONPATH=test:lib ` +
    `${JSON.stringify(`${cwd}/.venv/bin/python`)} -m pytest --tb=short -v ` +
    files.map((f) => JSON.stringify(f)).join(' ');
  const run = await deps.run('bash', ['-lc', pyCmd], cwd);
  const out = run.out;

  // 3) Score.
  const f2p = parseSbpArray(meta.fail_to_pass);
  const p2p = parseSbpArray(meta.pass_to_pass);
  const f2pRes = countPass(out, f2p);
  const p2pRes = countPass(out, p2p);
  const f2pOk = f2p.length > 0 && f2pRes.pass === f2p.length;
  const p2pOk = p2p.length === 0 || p2pRes.pass === p2p.length;
  checks.push({ name: `fail_to_pass (${f2pRes.pass}/${f2p.length})`, passed: f2pOk, detail: f2pRes.failed.join(', ') || undefined });
  checks.push({ name: `pass_to_pass (${p2pRes.pass}/${p2p.length})`, passed: p2pOk, detail: p2pRes.failed.join(', ') || undefined });

  const score = 1 + (f2pOk ? 3 : 0) + (p2pOk ? 1 : 0);
  return result(input, score, checks, `SBP ${score}/5: patch ✓, fail_to_pass ${f2pRes.pass}/${f2p.length}, pass_to_pass ${p2pRes.pass}/${p2p.length}.`);
}

function result(input: GradeInput, score: number, checks: Check[], summary: string): EvalGradeResult {
  return {
    taskName: input.taskName,
    gradedAt: new Date().toISOString(),
    score,
    scoreMax: 5,
    summary,
    checks,
    tscExit: null,
    tscErrors: 0,
    runTotals: input.runTotals,
  };
}
