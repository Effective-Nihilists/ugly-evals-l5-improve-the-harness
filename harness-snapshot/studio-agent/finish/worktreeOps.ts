/**
 * Worktree git operations for the Finish pipeline — task-bundle port of the
 * relevant slice of the monolith's server/coding-agent/worktree.ts, on top of
 * ./gitExec.ts. Covers: refresh (merge parent into the worktree), teardown
 * (remove worktree + branch), and ahead/behind commit counts.
 *
 * `parentBranch` is a LOCAL branch in the same repo the worktree forked from, so
 * the "parent tip" is just its current sha (no remote fetch needed for the common
 * "main advanced locally" case).
 */
import { native } from 'ugly-app/native';
import { git, gitHasInProgressMerge, gitStatusConflicts } from './gitExec';
import type { SessionWorktree } from './types';

export type RefreshOutcome =
  | { kind: 'conflict'; conflicts: string[] }
  | { kind: 'skipped'; reason: string }
  | { kind: 'noop' }
  | { kind: 'merged' };

/** `git rev-parse --verify -q <ref>` → sha, or null when the ref doesn't exist. */
async function revParse(cwd: string, ref: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', '--verify', '-q', ref]);
  const sha = r.stdout.trim();
  return r.code === 0 && sha.length > 0 ? sha : null;
}

/** True when `sha` is an ancestor of HEAD in `cwd` (already contained). */
async function isAncestorOfHead(cwd: string, sha: string): Promise<boolean> {
  const r = await git(cwd, ['merge-base', '--is-ancestor', sha, 'HEAD']);
  return r.code === 0;
}

/**
 * Merge `parentBranch` into the worktree. On conflict the merge is LEFT in place
 * (mid-merge) so the user/agent can resolve it — matching the monolith behavior;
 * the finish pipeline detects the in-progress merge on its next run.
 */
export async function refreshWorktree(worktree: SessionWorktree): Promise<RefreshOutcome> {
  if (await gitHasInProgressMerge(worktree.path)) {
    return { kind: 'conflict', conflicts: await gitStatusConflicts(worktree.path) };
  }
  const targetSha = await revParse(worktree.mainRepo, worktree.parentBranch);
  if (!targetSha) return { kind: 'skipped', reason: `Parent ref ${worktree.parentBranch} not found` };

  const currentHead = await revParse(worktree.path, 'HEAD');
  if (currentHead && currentHead === targetSha) return { kind: 'noop' };
  if (await isAncestorOfHead(worktree.path, targetSha)) return { kind: 'noop' };

  const merge = await git(worktree.path, ['merge', worktree.parentBranch]);
  if (merge.code === 0) return { kind: 'merged' };
  const conflicts = await gitStatusConflicts(worktree.path);
  return { kind: 'conflict', conflicts };
}

/** Remove the worktree dir + delete its branch. Best-effort (never throws). */
export async function teardownWorktree(
  worktree: SessionWorktree,
  opts: { force: boolean },
): Promise<void> {
  const { mainRepo } = worktree;
  const rm = await git(mainRepo, [
    'worktree', 'remove', ...(opts.force ? ['--force'] : []), worktree.path,
  ]);
  if (rm.code !== 0) {
    // git refused — remove the dir manually and prune the stale registration.
    try {
      await native.fs.rm(worktree.path, { recursive: true, force: true });
    } catch {
      /* already gone */
    }
    await git(mainRepo, ['worktree', 'prune']);
  }
  await git(mainRepo, ['branch', '-D', worktree.branch]);
}

/** Commits on the session branch not yet on the parent (`parent..HEAD`). -1 on error. */
export async function worktreeAheadCount(worktree: SessionWorktree): Promise<number> {
  const r = await git(worktree.path, ['rev-list', '--count', `${worktree.parentBranch}..HEAD`]);
  if (r.code !== 0) return -1;
  const n = parseInt(r.stdout.trim(), 10);
  return Number.isFinite(n) ? n : -1;
}

/** Commits on the parent not yet in the worktree (`HEAD..parent`). -1 on error. */
export async function worktreeBehindCount(worktree: SessionWorktree): Promise<number> {
  const targetSha = await revParse(worktree.mainRepo, worktree.parentBranch);
  if (!targetSha) return 0;
  const r = await git(worktree.path, ['rev-list', '--count', `HEAD..${worktree.parentBranch}`]);
  if (r.code !== 0) return -1;
  const n = parseInt(r.stdout.trim(), 10);
  return Number.isFinite(n) ? n : -1;
}
