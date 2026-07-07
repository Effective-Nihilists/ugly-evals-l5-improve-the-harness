// One-shot Python runner — write the snippet to a temp file and `uv run --script`.
// Ported from ugly-studio python-runtime/one-shot.ts, adapted to native.process/fs
// and the ~/.ugly-bot/binaries uv resolver. Guard-mode + recursive_llm are Plan 2b.
import { native } from 'ugly-app/native';
import { ensureUv } from '../binaries/resolve';
import { truncateOutput } from './outputTruncate';

export type PythonGuardMode = 'spec' | 'edit';
export interface OneShotOptions { code: string; cwd?: string; timeoutMs?: number; signal?: AbortSignal; mode?: PythonGuardMode }
export interface OneShotResult { output: string; isError: boolean; timedOut: boolean; exitCode: number | null }

const MAX_BUF = 400_000;
const DEFAULT_TIMEOUT = 60_000;

function tmpDir(): string {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  return env.TMPDIR ?? '/tmp';
}

/** Absolute path to the bundled Python package dir (contains ugly_studio/).
 *  Converts the module-relative file: URL to a filesystem path WITHOUT importing
 *  node:url (which Vite can't bundle into the client build). */
export function bridgeLibPath(): string {
  const u = new URL('../python-lib', import.meta.url);
  // file:///C:/… → C:/… on Windows; file:///Users/… → /Users/… on posix.
  return decodeURIComponent(u.pathname.replace(/^\/([A-Za-z]:)/, '$1'));
}

export async function runPythonOneShot(opts: OneShotOptions): Promise<OneShotResult> {
  const uv = await ensureUv();
  const pid = (globalThis as { process?: { pid?: number } }).process?.pid ?? 0;
  const tmpFile = `${tmpDir()}/ugly-code-pyexec-${pid}-${Date.now()}.py`;
  // In a guarded step, prepend the import that installs the write hooks before
  // the user's code runs. The guard reads UGLY_STUDIO_GUARD_MODE/_CWD from env.
  const guardActive = opts.mode !== undefined;
  const scriptContent = guardActive ? `import ugly_studio._guard  # ugly-studio guard\n${opts.code}` : opts.code;
  await native.fs.writeFile(tmpFile, scriptContent);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  try {
    return await new Promise<OneShotResult>((resolve) => {
      const spawnOpts: { cwd?: string; env?: Record<string, string> } = opts.cwd ? { cwd: opts.cwd } : {};
      if (guardActive) {
        const existing = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.PYTHONPATH;
        spawnOpts.env = {
          UGLY_STUDIO_GUARD_MODE: opts.mode!,
          UGLY_STUDIO_GUARD_CWD: opts.cwd ?? '',
          PYTHONPATH: existing ? `${bridgeLibPath()}:${existing}` : bridgeLibPath(),
        };
      }
      const proc = native.process.spawn(uv, ['run', '--script', tmpFile], spawnOpts);
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      proc.onStdout((c) => { if (stdout.length < MAX_BUF) stdout += c; });
      proc.onStderr((c) => { if (stderr.length < MAX_BUF) stderr += c; });
      const timer = setTimeout(() => {
        timedOut = true;
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }, 2000).unref();
      }, timeoutMs);
      timer.unref();
      const onAbort = (): void => { try { proc.kill('SIGTERM'); } catch { /* ignore */ } };
      opts.signal?.addEventListener('abort', onAbort);
      const finish = (result: OneShotResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };
      proc.onError((err) => { finish({ output: `python_exec spawn error: ${err}`, isError: true, timedOut: false, exitCode: null }); });
      proc.onExit((code) => {
        const parts: string[] = [];
        if (stdout) parts.push(stdout);
        if (stderr) parts.push(stderr);
        if (timedOut) parts.push(`\n[timed out after ${timeoutMs}ms]`);
        if (!timedOut && code !== null && code !== 0) parts.push(`\n[exit ${code}]`);
        let combined = parts.join('').trim();
        if (combined.length === 0) {
          combined = code === 0
            ? '(no stdout or stderr; script exited 0)\n\nThe script ran but printed nothing — remember to print() your result (e.g. print(json.dumps(results))).'
            : `(no output; script exited ${code ?? 'null'})`;
        }
        finish({ output: truncateOutput(combined), isError: timedOut || (code !== null && code !== 0), timedOut, exitCode: code });
      });
    });
  } finally {
    try { await native.fs.rm(tmpFile, { force: true }); } catch { /* ignore */ }
  }
}
