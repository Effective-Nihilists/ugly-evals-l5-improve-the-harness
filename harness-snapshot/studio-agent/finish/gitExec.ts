/**
 * Git/process execution harness for the Finish pipeline — the task-bundle port
 * of the monolith's server/git.ts helpers, adapted from node:child_process to
 * `native.process` (createNodeUglyNative in the coding task → real host git).
 *
 * Everything funnels through one process-wide FIFO queue (runInGitQueue) so
 * concurrent callers don't race on `.git/index.lock`. Git is resolved from PATH
 * (the task child runs in the bundled-binary env, so `git` is present) — no
 * getGitBinary/getGitEnv indirection.
 */
import { native } from 'ugly-app/native';
import type { AdapterCommand, FinishEventPayload, FinishStage } from './types';

// ── Global git queue ─────────────────────────────────────────────────
// Cross-repo serialization is over-conservative but git ops are ms-scale, so
// the throughput cost is invisible and it removes every index.lock race.
let gitQueueTail: Promise<unknown> = Promise.resolve();
export function runInGitQueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = gitQueueTail.then(fn, fn);
  gitQueueTail = next.catch(() => undefined);
  return next;
}

export interface GitRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn a process (unqueued), collecting stdout/stderr, resolving on exit. */
function spawnCollect(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<GitRun> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    try {
      const proc = native.process.spawn(cmd, args, {
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.env ? { env: opts.env } : {}),
      });
      proc.onStdout((c) => (stdout += c));
      proc.onStderr((c) => (stderr += c));
      proc.onError((e) => { resolve({ code: -1, stdout, stderr: `${stderr}\n${e}` }); });
      proc.onExit((code) => { resolve({ code: code ?? -1, stdout, stderr }); });
    } catch (e) {
      resolve({ code: -1, stdout, stderr: String(e) });
    }
  });
}

function formatGitFailure(args: string[], run: GitRun): string {
  const parts: string[] = [];
  const err = run.stderr.trim();
  const out = run.stdout.trim();
  if (err.length > 0) parts.push(err);
  if (out.length > 0) parts.push(`stdout: ${out}`);
  const detail = parts.length > 0 ? `: ${parts.join('\n')}` : '';
  return `git ${args.join(' ')} failed (${run.code})${detail}`;
}

/**
 * Run a git command through the queue and return stdout. Rejects on any exit
 * code not in `allowExitCodes` (default `[0]`).
 */
export function runGitCommand(
  cwd: string,
  args: string[],
  opts: { allowExitCodes?: number[] } = {},
): Promise<string> {
  return runInGitQueue(async () => {
    const run = await spawnCollect('git', args, { cwd });
    const allowed = opts.allowExitCodes ?? [0];
    if (allowed.includes(run.code)) return run.stdout;
    throw new Error(formatGitFailure(args, run));
  });
}

/** Convenience: queued git run that returns the full result (never throws). */
export function git(cwd: string, args: string[]): Promise<GitRun> {
  return runInGitQueue(() => spawnCollect('git', args, { cwd }));
}

/** Bare (UNqueued) git run — only for use INSIDE a runInGitQueue callback that
 *  needs several git ops to stay atomic on one queue slot (e.g. commit +
 *  rev-parse). Calling this outside the queue re-introduces the index.lock race. */
export function gitUnqueued(cwd: string, args: string[]): Promise<GitRun> {
  return spawnCollect('git', args, { cwd });
}

/** Squash-merge `sourceBranch` into the current branch of `projectPath`. */
export async function gitMergeSquash(
  projectPath: string,
  sourceBranch: string,
): Promise<{ ok: boolean; conflicts: string[] }> {
  try {
    await runGitCommand(projectPath, ['merge', '--squash', sourceBranch]);
    return { ok: true, conflicts: [] };
  } catch (err) {
    const conflicts = await gitStatusConflicts(projectPath);
    if (conflicts.length > 0) return { ok: false, conflicts };
    throw err;
  }
}

/** True when the worktree is mid-merge (user left unresolved conflicts). */
export async function gitHasInProgressMerge(projectPath: string): Promise<boolean> {
  try {
    const out = await runGitCommand(
      projectPath,
      ['rev-parse', '--verify', '-q', 'MERGE_HEAD'],
      { allowExitCodes: [0, 1] },
    );
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/** Conflicted file paths from `git status --porcelain=v1`. */
export async function gitStatusConflicts(projectPath: string): Promise<string[]> {
  let output = '';
  try {
    output = await runGitCommand(projectPath, ['status', '--porcelain=v1']);
  } catch {
    return [];
  }
  return output
    .split('\n')
    .filter(
      (line) =>
        line.startsWith('UU') ||
        line.startsWith('AA') ||
        line.startsWith('DD') ||
        line.startsWith('AU') ||
        line.startsWith('UA') ||
        line.startsWith('DU') ||
        line.startsWith('UD'),
    )
    .map((line) => line.substring(3).trim());
}

// ── Streaming gate runner (typecheck / lint / tests) ─────────────────
// Not queued (these are long-running, not git-index ops). Supports Stop via the
// returned handle's kill(), streams chunks to `emit`, strips ANSI noise.

/** Strip ANSI CSI/OSC escape sequences so the chat `<pre>` shows clean text. */
function stripAnsi(s: string): string {
  return s.replace(
    // eslint-disable-next-line no-control-regex
    /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\))/g,
    '',
  );
}

export interface GateOutcome {
  exitCode: number;
  stopped: boolean;
  stdout: string;
  stderr: string;
}

/** A running gate: `kill()` stops it (SIGTERM→SIGKILL); `done` resolves on exit. */
export interface RunningGate {
  kill(): void;
  done: Promise<GateOutcome>;
}

export function runGateStreaming(args: {
  cwd: string;
  cmd: AdapterCommand;
  stage: FinishStage;
  sessionId: string;
  emit: (payload: FinishEventPayload) => void;
}): RunningGate {
  const { cwd, cmd, stage, sessionId, emit } = args;
  let stopped = false;
  let killProc: (() => void) | null = null;
  let sigkillTimer: ReturnType<typeof setTimeout> | null = null;

  const kill = (): void => {
    if (stopped) return;
    stopped = true;
    try {
      killProc?.();
    } catch {
      /* ignore */
    }
  };

  const done = new Promise<GateOutcome>((resolve) => {
    let stdout = '';
    let stderr = '';
    try {
      const proc = native.process.spawn(cmd.command, cmd.args, {
        cwd,
        // Overlay only — host env/PATH is preserved (native.process merges unless
        // replaceEnv). Force monochrome; adapter env (e.g. Python UV_*) wins.
        env: { NO_COLOR: '1', FORCE_COLOR: '0', CI: '1', ...(cmd.env ?? {}) },
      });
      killProc = () => {
        try {
          proc.kill('SIGTERM');
        } catch {
          /* ignore */
        }
        sigkillTimer = setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {
            /* already dead */
          }
        }, 5000);
      };
      proc.onStdout((c) => {
        const text = stripAnsi(c);
        stdout += text;
        emit({ session_id: sessionId, kind: 'stage_output', stage, stream: 'stdout', chunk: text });
      });
      proc.onStderr((c) => {
        const text = stripAnsi(c);
        stderr += text;
        emit({ session_id: sessionId, kind: 'stage_output', stage, stream: 'stderr', chunk: text });
      });
      proc.onError((e) => {
        if (sigkillTimer) clearTimeout(sigkillTimer);
        resolve({ exitCode: -1, stopped, stdout, stderr: `${stderr}\n${e}` });
      });
      proc.onExit((code) => {
        if (sigkillTimer) clearTimeout(sigkillTimer);
        resolve({ exitCode: code ?? -1, stopped, stdout, stderr });
      });
    } catch (e) {
      resolve({ exitCode: -1, stopped, stdout, stderr: String(e) });
    }
  });

  return { kill, done };
}
