/**
 * "Finish session" pipeline — task-bundle port of the monolith's
 * server/coding-agent/finish-pipeline.ts (deleted from ugly-studio in f5a74c2f).
 * Runs inside the coding background task against the session's worktree.
 *
 * Stages (each emits a `finish_event` for inline chat progress):
 *   0. Precheck: main repo must be clean (or commit its dirt when opted in)
 *   1. Flush + snapshot: git add -A, git commit in the worktree
 *   2/3. Merge parent into the worktree — surface conflicts for the user
 *   4. Typecheck / Lint / Tests (each skippable, each Stop-able)
 *   5. Squash-merge the session branch into the parent in the main tree
 *   6. Cleanup (worktree preserved; Delete removes it explicitly)
 */
import {
  git,
  gitHasInProgressMerge,
  gitStatusConflicts,
  runGateStreaming,
  runInGitQueue,
  type RunningGate,
} from './gitExec';
import { resolveLintGate, resolveTestGate, resolveTypecheckGate } from './languages';
import { derivedCommitMessage, squashMergeSession } from './squashMerge';
import { refreshWorktree, teardownWorktree } from './worktreeOps';
import type {
  AdapterCommand,
  FinishEventPayload,
  FinishOptions,
  FinishResult,
  FinishStage,
  SessionWorktree,
} from './types';

type EmitFn = (payload: FinishEventPayload) => void;

export interface RunningFinish {
  stop(stage: FinishStage): boolean;
  result: Promise<FinishResult>;
}

/** Dirty tracked/staged/untracked files in the main repo (porcelain -z). */
async function getMainRepoDirtyFiles(mainRepo: string): Promise<string[]> {
  const r = await git(mainRepo, ['status', '--porcelain=v1', '-z', '-uall']);
  if (r.code !== 0) return [];
  const files: string[] = [];
  const parts = r.stdout.split('\0');
  let i = 0;
  while (i < parts.length) {
    const entry = parts[i];
    if (!entry || entry.length < 3) {
      i++;
      continue;
    }
    const status = entry.slice(0, 2);
    files.push(entry.slice(3));
    // Rename/copy entries carry a second (old) name in the next slot — skip it.
    if (status.startsWith('R') || status.startsWith('C')) i += 2;
    else i++;
  }
  return files;
}

/** `git add -A && git commit` the main repo's dirt using the USER's identity. */
async function commitMainRepoDirty(mainRepo: string, compositeId: string): Promise<void> {
  const add = await git(mainRepo, ['add', '-A']);
  if (add.code !== 0) throw new Error(`git add -A failed (${add.code}): ${add.stderr.trim()}`);
  const message = `Local changes saved before ugly-studio session ${compositeId.slice(0, 12)} merge`;
  const commit = await git(mainRepo, ['commit', '-m', message]);
  if (commit.code !== 0) throw new Error(`git commit failed (${commit.code}): ${commit.stderr.trim()}`);
}

/**
 * Stage + commit pending worktree changes, then report whether the session
 * branch is ahead of the parent (anything for the squash to carry). Handles the
 * retry case: a prior run committed but failed a gate, so there's nothing new to
 * stage yet a commit still sits ahead of parent.
 */
async function stageAndCheckAhead(
  worktreePath: string,
  parentBranch: string,
  compositeId: string,
): Promise<boolean> {
  return runInGitQueue(async () => {
    const add = await git(worktreePath, ['add', '-A']);
    if (add.code !== 0) throw new Error(`git add -A failed (${add.code}): ${add.stderr.trim()}`);

    const staged = await git(worktreePath, ['diff', '--cached', '--name-only']);
    if (staged.code !== 0) {
      throw new Error(`git diff --cached failed (${staged.code}): ${staged.stderr.trim()}`);
    }
    if (staged.stdout.trim().length > 0) {
      const commit = await git(worktreePath, [
        '-c', 'user.name=ugly-studio',
        '-c', 'user.email=session@ugly-studio.local',
        'commit', '-m', `ugly-studio session ${compositeId}`,
      ]);
      if (commit.code !== 0) throw new Error(`git commit failed (${commit.code}): ${commit.stderr.trim()}`);
    }

    const ahead = await git(worktreePath, ['rev-list', '--count', `${parentBranch}..HEAD`]);
    return (parseInt(ahead.stdout.trim(), 10) || 0) > 0;
  });
}

/**
 * Run the Finish pipeline. Returns a handle exposing `stop(stage)` (targets an
 * in-flight validation gate) and a promise resolving with the final result.
 */
export function startFinishPipeline(args: {
  sessionId: string;
  compositeId: string;
  worktree: SessionWorktree;
  opts: FinishOptions;
  firstUserMessageText: string | null;
  sessionTitle: string | null;
  emit: EmitFn;
}): RunningFinish {
  const { sessionId, compositeId, worktree, opts, firstUserMessageText, sessionTitle, emit } = args;

  const activeGates = new Map<FinishStage, RunningGate>();
  const stop = (stage: FinishStage): boolean => {
    const gate = activeGates.get(stage);
    if (!gate) return false;
    gate.kill();
    return true;
  };

  const runGate = async (
    stage: 'tsc' | 'lint' | 'tests',
    cmd: AdapterCommand | null,
  ): Promise<FinishResult | null> => {
    if (!cmd) {
      emit({ session_id: sessionId, kind: 'stage_skipped', stage, message: 'No runner detected' });
      return null;
    }
    emit({ session_id: sessionId, kind: 'stage_start', stage, command: cmd.label });
    const gate = runGateStreaming({ cwd: worktree.path, cmd, stage, sessionId, emit });
    activeGates.set(stage, gate);
    const outcome = await gate.done;
    activeGates.delete(stage);
    emit({ session_id: sessionId, kind: 'stage_end', stage, exitCode: outcome.exitCode, stopped: outcome.stopped });
    if (outcome.stopped) {
      emit({ session_id: sessionId, kind: 'failed', stage, message: 'Stopped' });
      return { ok: false, stage, message: 'Stopped' };
    }
    if (outcome.exitCode !== 0) {
      emit({ session_id: sessionId, kind: 'failed', stage, message: `${stage} exited ${outcome.exitCode}` });
      return { ok: false, stage, message: `${stage} exited ${outcome.exitCode}` };
    }
    return null;
  };

  const result = (async (): Promise<FinishResult> => {
    emit({ session_id: sessionId, kind: 'started' });

    // ── 0. Precheck: main repo must be clean ───────────────────
    const mainDirty = await getMainRepoDirtyFiles(worktree.mainRepo);
    if (mainDirty.length > 0) {
      if (opts.commitDirtyMainBeforeMerge) {
        emit({
          session_id: sessionId, kind: 'stage_start', stage: 'precheck_dirty_main',
          command: `git add -A && git commit (${mainDirty.length} file${mainDirty.length === 1 ? '' : 's'})`,
        });
        try {
          await commitMainRepoDirty(worktree.mainRepo, compositeId);
        } catch (err) {
          emit({ session_id: sessionId, kind: 'stage_end', stage: 'precheck_dirty_main', exitCode: 1 });
          emit({ session_id: sessionId, kind: 'failed', stage: 'precheck_dirty_main', message: `Failed to commit dirty files in main repo: ${(err as Error).message}` });
          return { ok: false, stage: 'precheck_dirty_main', dirtyFiles: mainDirty, message: (err as Error).message };
        }
        emit({ session_id: sessionId, kind: 'stage_end', stage: 'precheck_dirty_main', exitCode: 0 });
      } else {
        emit({
          session_id: sessionId, kind: 'failed', stage: 'precheck_dirty_main',
          message: `${mainDirty.length} uncommitted file${mainDirty.length === 1 ? '' : 's'} in main repo would block the squash-merge.`,
        });
        return {
          ok: false, stage: 'precheck_dirty_main', dirtyFiles: mainDirty,
          message: 'Main repo has uncommitted changes that would block the squash-merge.',
        };
      }
    }

    // ── 1. Flush + snapshot ─────────────────────────────────────
    let hadCommit = false;
    try {
      hadCommit = await stageAndCheckAhead(worktree.path, worktree.parentBranch, compositeId);
    } catch (err) {
      emit({ session_id: sessionId, kind: 'failed', stage: 'merge_parent', message: `Commit failed: ${(err as Error).message}` });
      return { ok: false, stage: 'merge_parent', message: `Commit failed: ${(err as Error).message}` };
    }
    if (!hadCommit) {
      emit({ session_id: sessionId, kind: 'stage_skipped', stage: 'merge_squash', message: 'No changes to merge' });
      await teardownWorktree(worktree, { force: true });
      emit({ session_id: sessionId, kind: 'done', message: 'No-op finish' });
      return { ok: true, stage: 'done' };
    }

    // ── 2/3. Merge parent into the worktree ─────────────────────
    emit({ session_id: sessionId, kind: 'stage_start', stage: 'merge_parent', command: `git merge ${worktree.parentBranch}` });
    const refresh = await (async () => {
      if (await gitHasInProgressMerge(worktree.path)) {
        return { kind: 'conflict' as const, conflicts: await gitStatusConflicts(worktree.path) };
      }
      return refreshWorktree(worktree);
    })();
    if (refresh.kind === 'conflict') {
      emit({ session_id: sessionId, kind: 'stage_end', stage: 'merge_parent', exitCode: 1 });
      emit({ session_id: sessionId, kind: 'conflict', stage: 'merge_parent', conflicts: refresh.conflicts });
      return { ok: false, stage: 'conflict', conflicts: refresh.conflicts, message: 'Merge from parent produced conflicts' };
    }
    emit({ session_id: sessionId, kind: 'stage_end', stage: 'merge_parent', exitCode: 0 });

    // ── 4. Validation gates ─────────────────────────────────────
    if (opts.runTypecheck) {
      const r = await runGate('tsc', await resolveTypecheckGate(worktree.path));
      if (r) return r;
    } else {
      emit({ session_id: sessionId, kind: 'stage_skipped', stage: 'tsc', message: 'Skipped by user' });
    }
    if (opts.runLint) {
      const r = await runGate('lint', await resolveLintGate(worktree.path));
      if (r) return r;
    } else {
      emit({ session_id: sessionId, kind: 'stage_skipped', stage: 'lint', message: 'Skipped by user' });
    }
    if (opts.runTests) {
      const r = await runGate('tests', await resolveTestGate(worktree.path));
      if (r) return r;
    } else {
      emit({ session_id: sessionId, kind: 'stage_skipped', stage: 'tests', message: 'Skipped by user' });
    }

    // ── 5/6. Squash-merge + cleanup (or pause for review) ───────
    const proposedCommitMessage = derivedCommitMessage({ title: sessionTitle, firstUserMessageText, compositeId });
    if (opts.pauseBeforeSquash) {
      emit({ session_id: sessionId, kind: 'awaiting_review', proposedCommitMessage });
      return {
        ok: false, stage: 'awaiting_review', proposedCommitMessage,
        parentBranch: worktree.parentBranch, sessionBranch: worktree.branch, worktreePath: worktree.path,
      };
    }
    return runSquashAndCleanup({ sessionId, worktree, commitMessage: proposedCommitMessage, emit });
  })();

  return { stop, result };
}

/**
 * Squash-merge the session branch into its parent + emit cleanup events. Shared
 * by the inline path and the post-review Accept (mergeFinishedCodingAgentSession).
 */
export async function runSquashAndCleanup(args: {
  sessionId: string;
  worktree: SessionWorktree;
  commitMessage: string;
  emit: EmitFn;
}): Promise<FinishResult> {
  const { sessionId, worktree, commitMessage, emit } = args;
  emit({ session_id: sessionId, kind: 'stage_start', stage: 'merge_squash', command: `git merge --squash ${worktree.branch}` });
  let squash;
  try {
    squash = await squashMergeSession({
      mainRepo: worktree.mainRepo,
      parentBranch: worktree.parentBranch,
      sessionBranch: worktree.branch,
      commitMessage,
    });
  } catch (err) {
    emit({ session_id: sessionId, kind: 'stage_end', stage: 'merge_squash', exitCode: 1 });
    emit({ session_id: sessionId, kind: 'failed', stage: 'merge_squash', message: (err as Error).message });
    return { ok: false, stage: 'merge_squash', message: (err as Error).message };
  }
  if (!squash.ok) {
    emit({ session_id: sessionId, kind: 'stage_end', stage: 'merge_squash', exitCode: 1 });
    emit({ session_id: sessionId, kind: 'conflict', stage: 'merge_squash', conflicts: squash.conflicts });
    return { ok: false, stage: 'conflict', conflicts: squash.conflicts, message: 'Squash merge produced conflicts in the main tree' };
  }
  emit({ session_id: sessionId, kind: 'stage_end', stage: 'merge_squash', exitCode: 0 });
  emit({ session_id: sessionId, kind: 'merged', stage: 'merge_squash', squashSha: squash.sha });
  // Preserve the worktree after a successful merge — Delete removes it explicitly.
  emit({ session_id: sessionId, kind: 'stage_start', stage: 'cleanup', command: 'preserving worktree (use Delete to remove)' });
  emit({ session_id: sessionId, kind: 'stage_end', stage: 'cleanup', exitCode: 0 });
  emit({ session_id: sessionId, kind: 'done', squashSha: squash.sha });
  return { ok: true, stage: 'done', squashSha: squash.sha };
}
