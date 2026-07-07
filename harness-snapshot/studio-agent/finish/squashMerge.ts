/**
 * Squash-merge a session branch into its parent — the task-bundle port of the
 * monolith's server/coding-agent/squash-merge.ts, on top of ./gitExec.ts. Shared
 * by the auto-finish pipeline and the manual "merge this session" surface.
 */
import { gitMergeSquash, gitUnqueued, runGitCommand, runInGitQueue } from './gitExec';

const MAX_HEADER_LEN = 70;

export interface SquashMergeArgs {
  mainRepo: string;
  parentBranch: string;
  sessionBranch: string;
  commitMessage: string;
}

export type SquashMergeResult =
  | { ok: true; sha: string }
  | { ok: false; conflicts: string[] };

export interface DerivedCommitMessageArgs {
  /** Model-generated session title from `info.title`. Preferred when non-empty. */
  title: string | null;
  /** First non-empty line of the session's first user message. */
  firstUserMessageText: string | null;
  /** Composite session id; only the first 12 chars appear in the footer. */
  compositeId: string;
}

function cleanLine(s: string): string {
  return s.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function truncate(s: string): string {
  return s.length <= MAX_HEADER_LEN ? s : `${s.slice(0, MAX_HEADER_LEN - 3)}...`;
}

function pickHeader(args: DerivedCommitMessageArgs): string {
  const title = cleanLine(args.title ?? '');
  if (title.length > 0) return truncate(title);
  const fromUser =
    (args.firstUserMessageText ?? '').split('\n').map(cleanLine).find((l) => l.length > 0) ?? '';
  if (fromUser.length > 0) return truncate(fromUser);
  return `ugly-studio session ${args.compositeId.slice(0, 12)}`;
}

/** Three-tier squash commit message: title > first user message > short-id. */
export function derivedCommitMessage(args: DerivedCommitMessageArgs): string {
  const header = pickHeader(args);
  const shortId = args.compositeId.slice(0, 12);
  return `${header}\n\n(ugly-studio session ${shortId})`;
}

/**
 * Checkout `parentBranch`, squash-merge `sessionBranch` into it, commit with
 * `commitMessage`, return the resulting sha. Conflicts abort with the file list.
 * The commit + rev-parse share ONE queue slot so no other caller can move HEAD
 * between them.
 */
export async function squashMergeSession(args: SquashMergeArgs): Promise<SquashMergeResult> {
  const { mainRepo, parentBranch, sessionBranch, commitMessage } = args;

  await runGitCommand(mainRepo, ['checkout', parentBranch]);

  const merge = await gitMergeSquash(mainRepo, sessionBranch);
  if (!merge.ok) return { ok: false, conflicts: merge.conflicts };

  const sha = await runInGitQueue(async () => {
    const commitArgs = [
      '-c', 'user.name=ugly-studio',
      '-c', 'user.email=session@ugly-studio.local',
      'commit', '-m', commitMessage,
    ];
    const commit = await gitUnqueued(mainRepo, commitArgs);
    if (commit.code !== 0) {
      throw new Error(`git ${commitArgs.join(' ')} exited ${commit.code}: ${commit.stderr.trim()}`);
    }
    const rev = await gitUnqueued(mainRepo, ['rev-parse', 'HEAD']);
    return rev.stdout.trim();
  });

  return { ok: true, sha };
}
