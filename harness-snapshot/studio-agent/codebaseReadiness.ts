// Drives the chat header's codebaseReadiness pill from the client agent (the host task):
// kicks off the host's semantic indexer + architecture doc on session start, then polls
// status and hands each reading back so the session folds it into its session_state stream.
// `codebase.*` is a host-only native channel (server/coding-agent/codebaseNative.ts); the
// task reaches it directly on desktop and via the host bridge on the proxy.
import { installUglyNative } from 'ugly-app/native';

/** SessionSnapshot.codebaseReadiness shape (kept loose to avoid a cross-package type dep). */
export interface CodebaseReadiness {
  indexer?: { status?: string; indexedChunks?: number; totalChunks?: number; totalFiles?: number };
  architecture?: { status?: string; filesAnalyzed?: number; filesTotal?: number };
}

const pollers = new Map<string, ReturnType<typeof setInterval>>();

/** One-shot fresh read of the host indexer/architecture status for a project.
 *  Used to enrich feedback reports (a "codebase: loading" report should carry
 *  the actual indexer state at submit time, not just the last polled snapshot). */
export async function fetchCodebaseStatus(cwd: string): Promise<unknown> {
  return inv('codebase.status', { projectPath: cwd });
}

// The raw UglyNative (with .invoke) — the facade exposes typed namespaces but no generic
// invoke, and `codebase.*` is a host-only channel with no facade method.
const inv = (channel: string, payload: unknown): Promise<unknown> =>
  installUglyNative().invoke(channel as never, payload as never);

// Sessions whose worktree overlay has been reconciled once (on first 'ready').
const reconciled = new Set<string>();

/** Kick off indexing + poll readiness every 1.5s until both surfaces settle.
 *  When a `worktreeRoot` is given, repair its overlay against on-disk state
 *  once the base index reports ready (semantic-search freshness). */
export function startCodebasePoll(
  sessionId: string,
  cwd: string,
  onReadiness: (r: CodebaseReadiness) => void,
  worktreeRoot?: string,
): void {
  if (!cwd || pollers.has(sessionId)) return;
  void inv('codebase.ensureIndex', { projectPath: cwd }).catch(() => undefined);
  const tick = async (): Promise<void> => {
    try {
      const r = (await inv('codebase.status', { projectPath: cwd })) as CodebaseReadiness;
      onReadiness(r);
      const idx = r.indexer?.status;
      if (idx === 'ready' && worktreeRoot && worktreeRoot !== cwd && !reconciled.has(sessionId)) {
        reconciled.add(sessionId);
        void inv('codebase.reconcile', { projectPath: cwd, worktreeRoot }).catch(() => undefined);
      }
      const arch = r.architecture?.status;
      const idxDone = idx === 'ready' || idx === 'error';
      const archDone = !arch || arch === 'ready' || arch === 'failed';
      if (idxDone && archDone) stopCodebasePoll(sessionId);
    } catch {
      /* transient (daemon spinning up / forwarding blip) — keep polling */
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), 1500);
  pollers.set(sessionId, timer);
}

export function stopCodebasePoll(sessionId: string): void {
  const t = pollers.get(sessionId);
  if (t) {
    clearInterval(t);
    pollers.delete(sessionId);
  }
  reconciled.delete(sessionId);
}

/** Read the host-generated ARCHITECTURE.md for a project (null if absent/not built yet).
 *  Newer hosts write it to the project ROOT (<project>/ARCHITECTURE.md); older hosts
 *  wrote <project>/.ugly-studio/ARCHITECTURE.md — try root first, then fall back so
 *  the pill works across the desktop auto-update lag. */
export async function fetchArchitectureDoc(cwd: string): Promise<string | null> {
  if (!cwd) return null;
  // Follow the cwd's separator style so Windows paths stay all-backslash
  // (a mixed `C:\proj/...` blob is fragile on native.fs).
  const sep = cwd.includes('\\') && !cwd.startsWith('/') ? '\\' : '/';
  const root = cwd.replace(/[\\/]+$/, '');
  const paths = [`${root}${sep}ARCHITECTURE.md`, `${root}${sep}.ugly-studio${sep}ARCHITECTURE.md`];
  for (const path of paths) {
    try {
      const res = (await inv('fs.readFile', { path })) as { content?: string } | undefined;
      const content = res?.content;
      if (content?.trim()) return content;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}
