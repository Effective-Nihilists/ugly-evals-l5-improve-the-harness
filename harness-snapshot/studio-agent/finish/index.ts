/**
 * Session-level Finish API — the surface the coding background task's onCall
 * handlers use (see coding-task.ts). Builds a SessionWorktree from the provisioned
 * workspace + main repo, holds the in-flight pipeline handle so Stop can target a
 * running gate, and maps outcomes onto the shapes the studio chat expects.
 */
import { ensureSessionWorkspace } from '../sessionWorkspace';
import { git } from './gitExec';
import { derivedCommitMessage } from './squashMerge';
import { runSquashAndCleanup, startFinishPipeline, type RunningFinish } from './finishPipeline';
import { refreshWorktree, teardownWorktree, worktreeAheadCount, worktreeBehindCount } from './worktreeOps';
import type { FinishEventPayload, FinishOptions, FinishResult, FinishStage, SessionWorktree } from './types';

export type { FinishEventPayload, FinishOptions, FinishResult, FinishStage } from './types';

// One in-flight pipeline per session (for Stop). A session finishes serially, so
// a single-slot map is enough.
const running = new Map<string, RunningFinish>();

/** Build the worktree descriptor, or null when the session isn't isolated. */
async function resolveWorktree(sessionId: string, projectPath: string | null): Promise<SessionWorktree | null> {
  if (!projectPath) return null;
  const ws = await ensureSessionWorkspace(sessionId, projectPath);
  if (!ws.isWorktree || !ws.dir || !ws.branch) return null;
  // Parent = the main repo's current branch (the merge target). Recorded at
  // finish time; the common case is the branch the worktree forked from.
  const head = await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const parentBranch = head.stdout.trim() || 'main';
  return { path: ws.dir, branch: ws.branch, parentBranch, mainRepo: projectPath };
}

/** Run the Finish pipeline. Emits finish_event frames via `emit`. */
export async function runFinish(args: {
  sessionId: string;
  projectPath: string | null;
  opts: FinishOptions;
  sessionTitle: string | null;
  firstUserMessageText: string | null;
  emit: (e: FinishEventPayload) => void;
}): Promise<FinishResult> {
  const worktree = await resolveWorktree(args.sessionId, args.projectPath);
  if (!worktree) {
    return { ok: false, message: 'This session has no isolated worktree to finish (main session or un-provisioned).' };
  }
  const handle = startFinishPipeline({
    sessionId: args.sessionId,
    compositeId: args.sessionId,
    worktree,
    opts: args.opts,
    firstUserMessageText: args.firstUserMessageText,
    sessionTitle: args.sessionTitle,
    emit: args.emit,
  });
  running.set(args.sessionId, handle);
  try {
    return await handle.result;
  } finally {
    running.delete(args.sessionId);
  }
}

/** Stop an in-flight validation gate (tsc/lint/tests). */
export function stopFinish(sessionId: string, stage: FinishStage): boolean {
  return running.get(sessionId)?.stop(stage) ?? false;
}

/** Run the squash-merge tail after the review modal is accepted. */
export async function mergeFinished(args: {
  sessionId: string;
  projectPath: string | null;
  commitMessage: string;
  emit: (e: FinishEventPayload) => void;
}): Promise<FinishResult> {
  const worktree = await resolveWorktree(args.sessionId, args.projectPath);
  if (!worktree) return { ok: false, message: 'No isolated worktree to merge.' };
  // Empty message (user cleared the review field) → derive a safe fallback so
  // `git commit -m` never runs with an empty subject.
  const commitMessage =
    args.commitMessage.trim() ||
    derivedCommitMessage({ title: null, firstUserMessageText: null, compositeId: args.sessionId });
  return runSquashAndCleanup({ sessionId: args.sessionId, worktree, commitMessage, emit: args.emit });
}

/** Abandon: discard the worktree + branch without merging. */
export async function abandonSession(sessionId: string, projectPath: string | null): Promise<{ ok: boolean; error?: string }> {
  const worktree = await resolveWorktree(sessionId, projectPath);
  if (!worktree) return { ok: true }; // nothing isolated to tear down
  try {
    await teardownWorktree(worktree, { force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export interface RefreshResult {
  ok: boolean;
  blocked?: boolean;
  conflicts?: string[];
  conflictKind?: 'merge' | 'stash_apply';
  error?: string;
}

/** Pull from parent: merge the parent branch into the worktree. */
export async function refreshSession(sessionId: string, projectPath: string | null): Promise<RefreshResult> {
  const worktree = await resolveWorktree(sessionId, projectPath);
  if (!worktree) return { ok: true };
  const outcome = await refreshWorktree(worktree);
  switch (outcome.kind) {
    case 'conflict':
      return { ok: false, blocked: true, conflicts: outcome.conflicts, conflictKind: 'merge' };
    case 'skipped':
    case 'noop':
    case 'merged':
      return { ok: true };
  }
}

/** Commits the session branch is ahead of parent (0 when not a worktree). */
export async function aheadCount(sessionId: string, projectPath: string | null): Promise<number> {
  const worktree = await resolveWorktree(sessionId, projectPath);
  if (!worktree) return 0;
  const n = await worktreeAheadCount(worktree);
  return n < 0 ? 0 : n;
}

/** Commits the parent is ahead of the worktree (0 when not a worktree). */
export async function behindCount(sessionId: string, projectPath: string | null): Promise<number> {
  const worktree = await resolveWorktree(sessionId, projectPath);
  if (!worktree) return 0;
  const n = await worktreeBehindCount(worktree);
  return n < 0 ? 0 : n;
}
