// The eval run: clone the task's fixture, drive the agent's turns in-process, then
// grade the on-disk project with the existing gradeProject. Turn data is persisted
// by the CLI's filesystem session store (installed in bootDriver), not the server.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { getEvalTask, firstTurnPrompt } from '../studio/evals/registry';
import { gradeProject, type GradeDeps } from '../studio/evals/grader';
import { isSbpTask } from '../studio/evals/sbp/registry';
import { gradeSbp } from '../studio/evals/sbpGrader';
import { analyzeTranscript } from './analyzeRun';
import { ensureUv } from '../agent/binaries/resolve';
import type { EvalGradeResult, SessionSnapshot } from '../studio/shared/api';
import { spawnCollect } from '../agent/tools/spawn';
import { bootDriver, runTurn } from './taskDriver';
import { isClaudeCliModel } from '../studio/agent/claudeCliAgent';
import { setSessionToolset, setSessionEval } from '../studio/agent/clientAgent';
import { isToolset } from '../studio/agent/toolsets';
import { appendRunHistory } from '../studio/evals/history';

const execFileP = promisify(execFile);

const ZERO_TOTALS: EvalGradeResult['runTotals'] = {
  durationMs: 0,
  turns: 0,
  cost: { total: 0, input: 0, output: 0, cacheRead: 0 },
  tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
};

/** Clone the task's fixture repo into ~/.ugly-code/eval-projects/<task>-<stamp> and re-init git. */
async function cloneFixture(taskName: string, repoUrl: string | undefined): Promise<string> {
  const safe = taskName.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const stamp = String(Date.now());
  const base = `$HOME/.ugly-code/eval-projects/${safe}-${stamp}`;
  // Strip the grader's own code (`eval/`) from the agent's workspace before seeding —
  // an integrity fix: the agent must not read checker.ts/check-helpers.ts and grade to
  // the test. (It also trims ~34KB of context, though that alone did NOT stop the
  // cheap-model "terminated" crashes on rrule — those are a deployed-proxy limit on
  // long generation, not context size.) No grader path reads the fixture's eval/
  // (vitestScore→test/, SBP→vendored metadata).
  const seedGit =
    `rm -rf .git eval && git init -b main -q && git add -A && ` +
    `git -c user.email=eval@ugly.bot -c user.name=eval commit -q -m "eval: seed ${safe}"`;
  const cmd = repoUrl
    ? `mkdir -p "$HOME/.ugly-code/eval-projects" && ` +
      `git clone --depth 1 "${repoUrl.replace(/"/g, '\\"')}" "${base}" && cd "${base}" && ` +
      `${seedGit} && pwd`
    : `mkdir -p "${base}" && cd "${base}" && ` +
      `printf '{"name":"%s","version":"0.0.0","private":true}\\n' "${safe}" > package.json && ` +
      `${seedGit} && pwd`;
  // Node child_process (not native.process) — this is CLI infra that runs before
  // the agent's UglyNative + permissions are installed.
  const { stdout } = await execFileP('bash', ['-lc', cmd], { maxBuffer: 16 * 1024 * 1024 });
  const path = stdout.trim().split('\n').pop() ?? '';
  if (!path) throw new Error('fixture clone failed (no path printed)');
  return path;
}

/** Run a task's reproSetup (SBP: uv venv + pip install) so the agent + grader can
 *  run the repo's tests. `uv` is resolved via ~/.ugly-bot/binaries and put on PATH. */
async function runReproSetup(task: { reproSetup?: { commands: string[] } }, projectPath: string): Promise<void> {
  const cmds = task.reproSetup?.commands;
  if (!cmds?.length) return;
  const uv = await ensureUv();
  const uvDir = uv.slice(0, uv.lastIndexOf('/'));
  for (const cmd of cmds) {
    const r = await spawnCollect('bash', ['-lc', `cd ${JSON.stringify(projectPath)} && export PATH=${JSON.stringify(uvDir)}:"$PATH" && ${cmd}`], {});
    if (r.code !== 0 && r.code !== null) process.stderr.write(`[reproSetup] '${cmd.slice(0, 60)}' exit ${r.code}: ${r.stderr.slice(-300)}\n`);
  }
}

const cliGradeDeps: GradeDeps = {
  run: async (cmd, args, cwd) => {
    const r = await spawnCollect(cmd, args, { cwd });
    return { out: r.stdout + r.stderr, code: r.code };
  },
  readFile: async (p) => {
    const { native } = await import('ugly-app/native');
    return native.fs.readFile(p);
  },
  exists: async (p) => {
    const { native } = await import('ugly-app/native');
    return native.fs.exists(p);
  },
  // 5-level grader judge — a STRONG LOCAL critic (claude-cli, default Sonnet) grades
  // the rubric, per CODING.md §17.13 ("critic quality is load-bearing"). Local so it
  // doesn't depend on the deployed server exposing /api/agentStep (which the current
  // deploy does not). One-shot `claude --print`; billed to the user's Claude plan.
  judge: claudeJudge,
};

/** Grader-judge model tier (claude-cli): sonnet by default; override via env. */
const GRADER_JUDGE_MODEL = process.env.UGLY_GRADER_MODEL ?? 'sonnet';

async function claudeJudge(system: string, user: string): Promise<string> {
  const prompt = `${system}\n\n${user}`;
  try {
    const { stdout } = await execFileP(
      'claude',
      ['--print', '--output-format', 'json', '--model', GRADER_JUDGE_MODEL, prompt],
      { maxBuffer: 32 * 1024 * 1024, timeout: 180_000 },
    );
    return (JSON.parse(stdout) as { result?: string }).result ?? '';
  } catch (e) {
    process.stderr.write(`[claudeJudge] FAILED (${GRADER_JUDGE_MODEL}): ${e instanceof Error ? e.message : String(e)}\n`);
    throw e;
  }
}

/** The single follow-up sent when an implementation run ends with zero edits. */
const NO_EDIT_NUDGE =
  'You ended your turn without editing any files. This task requires implementing a code ' +
  'change — edit/write the source (not just read it) so the failing tests pass. Continue now ' +
  'and make the necessary edits; do not end your turn until the change is implemented.';

/**
 * True when a run produced zero file edits but the task is an implementation task
 * (bug-fix / feature). Phase-5 telemetry lever: the cheap model sometimes investigates
 * a hard task then ends its turn (or crashes) with `turns-to-first-edit: never` → 0 diff
 * → 0 score. Planning tasks legitimately produce no diff, so they are never nudged.
 */
export function shouldNudgeForNoEdit(kind: string, editCount: number): boolean {
  return editCount === 0 && kind !== 'planning';
}

/** Parse a session's messages.jsonl into the row shape the analyzer/nudge consume. */
async function readTranscriptRows(
  storeRoot: string,
  sessionId: string,
): Promise<{ seq: number; role: string; kind: string; content: string }[]> {
  const dir = sessionId.replace(/[^a-zA-Z0-9_.:-]/g, '_');
  try {
    const raw = await readFile(`${storeRoot}/${dir}/messages.jsonl`, 'utf8');
    return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { seq: number; role: string; kind: string; content: string });
  } catch {
    return [];
  }
}

/** The agent's last assistant message text — evidence for judge grading of
 *  planning / write-to-spec tasks whose output isn't a code diff. */
async function readFinalText(storeRoot: string, sessionId: string): Promise<string | undefined> {
  const dir = sessionId.replace(/[^a-zA-Z0-9_.:-]/g, '_');
  try {
    const raw = await readFile(`${storeRoot}/${dir}/messages.jsonl`, 'utf8');
    const rows = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { role: string; content: string });
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].role !== 'assistant') continue;
      const parsed = JSON.parse(rows[i].content) as { content?: { type?: string; text?: string }[] };
      const text = (parsed.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n').trim();
      if (text) return text;
    }
  } catch { /* none */ }
  return undefined;
}

export interface EvalRunResult { score: number; scoreMax: number; costUsd: number; turns: number; resolvedPattern: string | null }

/** Follow-up sent to resume a session that crashed mid-run (status:error). */
const RESUME_NUDGE = 'Continue where you left off and complete the task.';

/** Read the run's cost + turn count from the fs session store's metadata. */
async function readRunTotals(storeRoot: string, sessionId: string): Promise<{ costUsd: number; turns: number }> {
  const dir = sessionId.replace(/[^a-zA-Z0-9_.:-]/g, '_');
  try {
    const m = JSON.parse(await readFile(`${storeRoot}/${dir}/metadata.json`, 'utf8')) as { costUsd?: number; messageCount?: number };
    return { costUsd: m.costUsd ?? 0, turns: m.messageCount ?? 0 };
  } catch {
    return { costUsd: 0, turns: 0 };
  }
}

export async function runEval(cfg: {
  taskName: string;
  origin: string;
  token: string;
  model?: string;
  pattern?: string;
  toolset?: string;
  modelMode?: SessionSnapshot['modelMode'];
}): Promise<EvalRunResult> {
  const task = getEvalTask(cfg.taskName);
  if (!task) throw new Error(`Unknown eval task: ${cfg.taskName}`);
  const projectPath = await cloneFixture(task.name, task.repoUrl);
  const sessionId = `cli:${task.name}:${Date.now()}`;
  const storeRoot = `${process.env.HOME ?? '.'}/.ugly-code/session`;
  await bootDriver({ projectPath, sessionId, origin: cfg.origin, token: cfg.token, storeRoot });
  await runReproSetup(task, projectPath); // SBP tasks: uv venv + pip install before the agent
  setSessionEval(sessionId, true); // every CLI run is an eval → criteria judge active under SBV
  if (cfg.toolset && isToolset(cfg.toolset)) setSessionToolset(sessionId, cfg.toolset);
  const selection = cfg.model || cfg.pattern || cfg.modelMode
    ? {
        ...(cfg.model ? { model: cfg.model } : {}),
        ...(cfg.pattern ? { patternMode: cfg.pattern as never } : {}),
        ...(cfg.modelMode ? { modelMode: cfg.modelMode } : {}),
      }
    : undefined;
  // Capture the pattern the engine resolved to (echoed in every session_state
  // snapshot) so the CLI + e2e tests can assert classifier routing accuracy.
  let resolvedPattern: string | null = null;
  let lastTurnErrored = false;
  const onMsg = (msg: unknown): void => {
    const m = msg as { event?: { type?: string; payload?: { payload?: { resolvedPattern?: string | null; type?: string; reason?: string } } } };
    const inner = m.event?.payload?.payload;
    if (m.event?.type === 'session_state') {
      const rp = inner?.resolvedPattern;
      if (rp != null) resolvedPattern = rp;
    }
    // The turn finished — remember whether it crashed (transient "terminated"),
    // read synchronously from the event stream so the retry decision doesn't race
    // the async metadata flush.
    if (inner?.type === 'agent_finished') {
      lastTurnErrored = inner.reason === 'error';
      if (lastTurnErrored) process.stderr.write(`[eval:error] ${cfg.taskName}: agent turn ended in error\n`);
    }
  };
  const turns = [firstTurnPrompt(task), ...task.turns.slice(1)];
  for (const turn of turns) {
    await runTurn(sessionId, turn, onMsg, selection);
  }
  // Resume-on-error retries. The deployed agent core intermittently returns a
  // transient "terminated" mid-run (status:error) on cheap models — it crashed at
  // *different* points across runs, so it's flaky, not deterministic. Without this,
  // a task the model was actively solving scores 0 purely on transport luck. Resume
  // the crashed session up to 3× (claude-cli manages its own retries, so skip it).
  const usingClaudeCli = !!cfg.model && isClaudeCliModel(cfg.model);
  for (let attempt = 1; !usingClaudeCli && attempt <= 3 && lastTurnErrored; attempt++) {
    process.stderr.write(`[eval] ${task.name}: turn crashed — resume attempt ${attempt}/3\n`);
    lastTurnErrored = false;
    await runTurn(sessionId, RESUME_NUDGE, onMsg, selection);
  }
  // No-edit persistence guard (Phase-5 telemetry lever). Telemetry showed the cheap
  // model can investigate a hard task then end its turn — or crash mid-run — with
  // `turns-to-first-edit: never` (0 diff → 0 score) while passing cells all made edits.
  // One bounded nudge resumes the session and drives it to edit; a no-op when the
  // agent already edited or the task is planning (no diff). SKIP for claude-cli models:
  // the CLI persists its transcript after returning, so an edit-count check here races
  // the flush and always reads 0 → a spurious extra invocation that inflates cost/turns.
  // claude-cli (the Opus baseline) reliably edits and never needs the nudge anyway.
  if (!usingClaudeCli && shouldNudgeForNoEdit(task.kind, analyzeTranscript(await readTranscriptRows(storeRoot, sessionId)).edits)) {
    process.stderr.write(`[eval] ${task.name}: 0 edits after turns — sending no-edit nudge\n`);
    await runTurn(sessionId, NO_EDIT_NUDGE, onMsg, selection);
  }
  const finalText = await readFinalText(storeRoot, sessionId);
  const gradeInput = {
    taskName: task.name,
    projectPath,
    ...(task.gates ? { gates: task.gates } : {}),
    ...(task.successCriteria ? { successCriteria: task.successCriteria } : {}),
    ...(finalText ? { finalText } : {}),
    runTotals: ZERO_TOTALS,
  };
  // SBP tasks → deterministic 1+3+1 host-side grader; everything else → judge 0–5.
  const result = isSbpTask(task.name)
    ? await gradeSbp(gradeInput, cliGradeDeps)
    : await gradeProject(gradeInput, cliGradeDeps);
  const totals = await readRunTotals(storeRoot, sessionId);
  const nowIso = new Date().toISOString();
  await appendRunHistory({
    taskName: task.name,
    projectName: projectPath.split('/').pop() ?? task.name,
    projectPath,
    sessionId,
    createdAt: nowIso,
    gradedAt: nowIso,
    score: result.score ?? 0,
    scoreMax: result.scoreMax ?? 0,
    costUsd: totals.costUsd,
    turns: totals.turns,
    config: [cfg.model, cfg.pattern, cfg.modelMode?.kind, cfg.toolset].filter(Boolean).join('/') || 'default',
  }).catch(() => undefined);
  return { score: result.score ?? 0, scoreMax: result.scoreMax ?? 0, ...totals, resolvedPattern };
}
