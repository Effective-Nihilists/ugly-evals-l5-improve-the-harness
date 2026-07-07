/**
 * Types for the "Finish session" pipeline — ported from the monolith's
 * coding-agent backend (server/coding-agent/{types,finish-pipeline}.ts, deleted
 * from ugly-studio in commit f5a74c2f). The pipeline now runs inside the coding
 * background task (coding-task.ts) against the session's git worktree, using the
 * host git via `native.process` (see ./gitExec.ts). Return/event shapes match the
 * studio chat UI's existing expectations verbatim.
 */

/** A provisioned per-session git worktree (subset the finish pipeline needs). */
export interface SessionWorktree {
  /** Absolute path to the worktree directory (session cwd). */
  path: string;
  /** Branch name inside the main repo that backs this worktree. */
  branch: string;
  /** Branch we forked from — the merge target when Finish runs. */
  parentBranch: string;
  /** Absolute path to the repo the worktree belongs to (main tree). */
  mainRepo: string;
}

export type FinishStage =
  | 'precheck_dirty_main'
  | 'merge_parent'
  | 'tsc'
  | 'lint'
  | 'tests'
  | 'merge_squash'
  | 'cleanup';

export interface FinishOptions {
  runTypecheck: boolean;
  runLint: boolean;
  runTests: boolean;
  /** Commit the main repo's dirty tracked files before the squash-merge instead
   *  of aborting at the dirty-main precheck. */
  commitDirtyMainBeforeMerge?: boolean;
  /** Run the gates then PAUSE before the squash-merge, returning
   *  `stage: 'awaiting_review'` + a proposed commit message for the review modal. */
  pauseBeforeSquash?: boolean;
}

export interface FinishResult {
  ok: boolean;
  stage?: FinishStage | 'conflict' | 'done' | 'awaiting_review';
  squashSha?: string;
  conflicts?: string[];
  dirtyFiles?: string[];
  proposedCommitMessage?: string;
  parentBranch?: string;
  sessionBranch?: string;
  worktreePath?: string;
  message?: string;
}

/** Streaming progress events emitted by the pipeline (rendered inline in chat). */
export interface FinishEventPayload {
  session_id: string;
  kind:
    | 'started'
    | 'stage_start'
    | 'stage_output'
    | 'stage_end'
    | 'stage_skipped'
    | 'conflict'
    | 'awaiting_review'
    | 'merged'
    | 'done'
    | 'failed';
  stage?: FinishStage;
  command?: string;
  stream?: 'stdout' | 'stderr';
  chunk?: string;
  exitCode?: number;
  stopped?: boolean;
  conflicts?: string[];
  squashSha?: string;
  proposedCommitMessage?: string;
  message?: string;
}

/** A resolved validation-gate command (typecheck / lint / test). */
export interface AdapterCommand {
  /** Human-readable label shown in the chat (`stage_start.command`). */
  label: string;
  command: string;
  args: string[];
  /** Extra env overlaid on the gate spawn (e.g. Python UV_* vars). */
  env?: Record<string, string>;
}
