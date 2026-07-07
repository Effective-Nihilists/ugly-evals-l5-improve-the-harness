/**
 * Detect the local Claude Code CLI over the native bridge. The web app can't run
 * `which`, so we spawn a login shell and resolve `command -v claude` (falling back
 * to the well-known install locations). Cached for the session. Returns the
 * absolute binary path, or null when unavailable (no native bridge / not installed).
 */

import { native } from 'ugly-app/native';

let cached: string | null | undefined;
let inflight: Promise<string | null> | null = null;

const WELL_KNOWN = (home: string): string[] => [
  `${home}/.local/bin/claude`,
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
];

function homeFromPath(p: string | null): string | null {
  if (!p) return null;
  const m = /^(\/Users\/[^/]+|\/home\/[^/]+|\/root)/.exec(p);
  return m ? m[1] : null;
}

/** Run a command to completion, returning trimmed stdout (or '' on any failure). */
function runCapture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    try {
      let out = '';
      const proc = native.process.spawn(cmd, args);
      proc.onStdout((c) => (out += c));
      proc.onError(() => { resolve(''); });
      proc.onExit(() => { resolve(out.trim()); });
    } catch {
      resolve('');
    }
  });
}

export async function detectClaudeCli(projectPath: string | null): Promise<string | null> {
  if (cached !== undefined) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    // 1) well-known paths (fast, no shell)
    const home = homeFromPath(projectPath);
    if (home) {
      for (const candidate of WELL_KNOWN(home)) {
        try {
          const st = await native.fs.stat(candidate);
          if (st.isFile) { cached = candidate; return candidate; }
        } catch { /* not there */ }
      }
    }
    // 2) PATH lookup via a login shell
    const found = (await runCapture('bash', ['-lc', 'command -v claude'])).split('\n')[0] ?? '';
    cached = found.startsWith('/') ? found : null;
    return cached;
  })().finally(() => { inflight = null; });
  return inflight;
}

/** Synchronous cached read for render paths (null until detectClaudeCli resolves). */
export function claudeCliPathCached(): string | null {
  return cached ?? null;
}
