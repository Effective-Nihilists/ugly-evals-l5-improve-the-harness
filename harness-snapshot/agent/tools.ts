// Client-side tool dispatcher — turns a model `tool_use` block into a real
// operation against the unified native API (fulfilled by the Ugly Studio
// desktop daemon). Returns a string the agent loop feeds back as `tool_result`.

import { native } from 'ugly-app/native';
import type { SandboxMode, UglyProcess } from 'ugly-app/native';
import type { AgentToolName } from '../../shared/agent';
import type { StepFn } from './engine';
import { DB_SCRIPT } from '../studio/db/dbScript';
import { runRegisteredTool } from './tools/registry';
import { formatHashlineRead } from './tools/hashline';
import { applyEdit, type EditOp } from './tools/applyEdit';
import { markDirty } from './tools/codebaseDirty';

/** Project + mode context so tool subprocesses can be OS-user sandboxed by the
 *  daemon. Resolved by the agent loop (clientAgent) per turn. */
export interface ToolContext {
  /** The agent session this tool call belongs to (for per-session tool state:
   *  todos, scratchpad, blackboard). */
  sessionId?: string;
  projectDir?: string | null;
  /** Absolute root for resolving the model's (workspace-relative) fs paths. Set
   *  ONLY for worktree-isolated sessions; when unset, relative paths pass through
   *  unchanged (the daemon resolves them against the open project). */
  workspaceDir?: string | null;
  mode?: SandboxMode;
  /** Unique dev-server port, injected as PORT into run_command spawns. */
  port?: number;
  /** Local dev DB connection string, injected as DATABASE_URL into run_command. */
  databaseUrl?: string;
  /** Model-call function for subagents (delegate/agent). Provided by the agent
   *  loop; absent → delegation tools degrade gracefully. */
  step?: StepFn;
}

/** Coerce an `unknown` tool-input value to a string. Strings pass through;
 *  objects are JSON-encoded (instead of the useless `[object Object]`); other
 *  primitives use their default string form. */
function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** The base a model-supplied relative path resolves against: the worktree root
 *  when the session is worktree-isolated, else the open project dir. */
function resolutionBase(ctx: ToolContext | undefined): string | null {
  return ctx?.workspaceDir ?? ctx?.projectDir ?? null;
}

/** A Windows-absolute path: drive-letter (`C:\`, `C:/`) or UNC (`\\host\share`). */
function isWindowsAbsolute(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

/** Whether a path uses Windows conventions (drive/UNC root or backslash seps).
 *  Used to pick the join separator so a Windows base keeps producing Windows
 *  paths (mixed `C:\a/b` blobs corrupt native.fs + codebase.update on Windows). */
function isWindowsPath(p: string): boolean {
  return isWindowsAbsolute(p) || p.includes('\\');
}

/** The separator to build paths with, inferred from the resolution base. */
function sepFor(p: string): '\\' | '/' {
  return isWindowsPath(p) ? '\\' : '/';
}

/** Best-effort home dir from the absolute project/worktree path. Handles
 *  macOS/Linux (`/Users/x`, `/home/x`, `/root`) and Windows (`C:\Users\x`). */
function deriveHome(ctx: ToolContext | undefined): string | null {
  const p = ctx?.workspaceDir ?? ctx?.projectDir ?? '';
  const win = /^([a-zA-Z]:[\\/]Users[\\/][^\\/]+)/.exec(p);
  if (win) return win[1];
  const posix = /^(\/Users\/[^/]+|\/home\/[^/]+|\/root)/.exec(p);
  return posix ? posix[1] : null;
}

/** Collapse `.`/`..` segments (no fs access). Splits on both `/` and `\` and
 *  re-joins with `sep`, preserving a leading POSIX `/`, drive (`C:\`), or UNC
 *  (`\\host\share\`) root so `..` never climbs past it. */
function normalizePath(p: string, sep: '\\' | '/'): string {
  const winAbs = isWindowsAbsolute(p);
  const isAbs = winAbs || p.startsWith('/');
  let prefix = '';
  let rest = p;
  if (winAbs) {
    const m = /^([a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])/.exec(p);
    if (m) {
      prefix = m[1].replace(/[\\/]+$/, '') + sep;
      rest = p.slice(m[1].length);
    }
  } else if (isAbs) {
    prefix = sep;
    rest = p.slice(1);
  }
  const out: string[] = [];
  for (const seg of rest.split(/[\\/]+/)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!isAbs) out.push('..');
    } else {
      out.push(seg);
    }
  }
  return prefix + out.join(sep);
}

/** Resolve a model-supplied path to an absolute fs path. Handles POSIX and
 *  Windows absolute forms (`/foo`, `C:\foo`, `\\host\share`), home (`~/foo`),
 *  and relative (`foo`, `./foo`, `../foo`) forms; relative paths root at the
 *  worktree (if any) else the project dir, and follow the base's separator
 *  style. When no base is known, the path passes through so the daemon can
 *  resolve it. */
export function resolvePath(ctx: ToolContext | undefined, path: string): string {
  if (isWindowsAbsolute(path)) return normalizePath(path, '\\');
  if (path.startsWith('/')) return normalizePath(path, '/');
  if (path === '~' || path.startsWith('~/') || path.startsWith('~\\')) {
    const home = deriveHome(ctx);
    if (!home) return path;
    const sep = sepFor(home);
    return normalizePath(home + sep + path.slice(1).replace(/^[\\/]+/, ''), sep);
  }
  const base = resolutionBase(ctx);
  if (!base) return path;
  const sep = sepFor(base);
  return normalizePath(base.replace(/[\\/]+$/, '') + sep + path, sep);
}

/** Render an absolute fs path back as a base-relative path for the model (paths
 *  returned to the model must be relative — see TOOLS.md "Path handling"). Paths
 *  outside the base, or when no base is known, are returned unchanged. Windows
 *  comparison is separator- and case-insensitive. */
export function relativizePath(ctx: ToolContext | undefined, absPath: string): string {
  const base = resolutionBase(ctx);
  if (!base) return absPath;
  const root = base.replace(/[\\/]+$/, '');
  if (isWindowsPath(base)) {
    const norm = (s: string): string => s.replace(/\//g, '\\').toLowerCase();
    const a = norm(absPath);
    const r = norm(root);
    if (a === r) return '.';
    return a.startsWith(r + '\\') ? absPath.slice(root.length + 1) : absPath;
  }
  if (absPath === root) return '.';
  return absPath.startsWith(root + '/') ? absPath.slice(root.length + 1) : absPath;
}

export type ToolDispatch = (name: string, input: unknown, ctx?: ToolContext) => Promise<string>;

export const dispatchTool: ToolDispatch = async (name, input, ctx) => {
  const p = (input ?? {}) as Record<string, unknown>;
  // Restored tools live in the registry; a name it doesn't own falls through to
  // the legacy inline switch below.
  const fromRegistry = await runRegisteredTool(name, p, ctx);
  if (fromRegistry !== undefined) return fromRegistry;
  switch (name as AgentToolName) {
    case 'read': {
      const rawPath = String(p.path);
      const raw = await native.fs.readFile(resolvePath(ctx, rawPath));
      return formatHashlineRead(
        rawPath,
        raw,
        p.offset != null ? Number(p.offset) : 0,
        p.limit != null ? Number(p.limit) : undefined,
      );
    }
    case 'write': {
      const abs = resolvePath(ctx, String(p.path));
      await native.fs.writeFile(abs, str(p.content ?? ''));
      if (ctx?.sessionId) markDirty(ctx.sessionId, abs);
      return `Wrote ${relativizePath(ctx, abs)}`;
    }
    case 'edit': {
      const rawPath = String(p.path);
      const path = resolvePath(ctx, rawPath);
      const cur = await native.fs.readFile(path);
      // Accept `old`/`new` as aliases for old_string/new_string (legacy callers).
      const op: EditOp = {
        ...(p as EditOp),
        ...(p.old != null ? { old_string: str(p.old) } : {}),
        ...(p.new != null && p.new_string == null && p.new_content == null
          ? { new_string: str(p.new) }
          : {}),
      };
      const r = applyEdit(cur, op);
      if (!r.ok) return `edit failed in ${relativizePath(ctx, path)}: ${r.error}`;
      await native.fs.writeFile(path, r.body!);
      if (ctx?.sessionId) markDirty(ctx.sessionId, path);
      return `Edited ${relativizePath(ctx, path)}`;
    }
    case 'bash': {
      const command = str(p.command ?? '');
      const guard = await devServerBashGuard(command, ctx);
      if (guard) return guard;
      const timeoutMs = typeof p.timeout_ms === 'number' && p.timeout_ms > 0 ? p.timeout_ms : DEFAULT_BASH_TIMEOUT_MS;
      return runBash(command, await sandboxOptFor(ctx), ctx, p.working_dir != null ? str(p.working_dir) : undefined, timeoutMs);
    }
    case 'database':
      return runDb(ctx, 'getQuery', {
        collection: String(p.collection),
        ...(Array.isArray(p.filters) ? { filters: p.filters } : {}),
        ...(p.sort != null ? { sort: p.sort } : {}),
        ...(p.limit != null ? { limit: Number(p.limit) } : {}),
        ...(p.skip != null ? { skip: Number(p.skip) } : {}),
      });
    case 'database_sql_query':
      return runDb(ctx, 'exec', {
        sql: str(p.sql ?? ''),
        ...(Array.isArray(p.params) ? { params: p.params } : {}),
        // Raw SQL tool allows writes (seed/fix dev state); the daemon runs it
        // against the bundled local dev postgres.
        allowWrite: true,
      });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
};

/** Run one DB op (db/dbScript) against the project's local dev DB via a node
 *  subprocess — same plumbing the Database panel uses. Returns a JSON string the
 *  agent reads as the tool_result. The dev DB is the bundled local postgres
 *  (p_<projectId>), so this is the same data the app's dev server sees. */
function runDb(ctx: ToolContext | undefined, op: string, input: Record<string, unknown>): Promise<string> {
  const projectDir = ctx?.projectDir;
  if (!projectDir) return Promise.resolve('[error: no open project — db tools need a project]');
  return new Promise((resolve) => {
    let out = '';
    try {
      const proc = native.process.spawn('node', ['--input-type=module', '-e', DB_SCRIPT], {
        cwd: projectDir,
        env: {
          UGLY_DB_MODE: 'dev',
          UGLY_DB_PROJECT: projectDir,
          UGLY_DB_OP: op,
          UGLY_DB_INPUT: JSON.stringify(input),
        },
      });
      proc.onStdout((c) => (out += c));
      proc.onStderr((c) => (out += c));
      proc.onError((e) => { resolve(`[error: ${e}]`); });
      proc.onExit((code) => { resolve(code === 0 ? truncate(out.trim()) : `[error: ${out.trim().slice(-400) || 'node exited ' + String(code)}]`); });
    } catch (e) {
      console.error('[agentTools:runDbScript]', JSON.stringify({ op, projectDir, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined);
      resolve(`[error: ${(e as Error).message}]`);
    }
  });
}

/** Keep tool results bounded so a huge result set doesn't blow the context. Head+tail,
 *  not head-only: compilers and test runners put the summary line + failing traceback
 *  at the END, so a head-only cut hides the actual failure the model needs. Keep both ends. */
function truncate(s: string): string {
  const MAX = 12_000;
  if (s.length <= MAX) return s;
  const half = Math.floor(MAX / 2);
  return `${s.slice(0, half)}\n…[truncated ${s.length - MAX} chars from the middle]…\n${s.slice(-half)}`;
}

// `.uglyapp.projectId` per project dir — read once, cached (it never changes for
// an open project), so we don't re-read the file on every tool call.
const projectIdCache = new Map<string, string | null>();
async function readProjectId(projectDir: string): Promise<string | null> {
  const cached = projectIdCache.get(projectDir);
  if (cached !== undefined) return cached;
  let pid: string | null = null;
  try {
    pid = (JSON.parse(await native.fs.readFile(projectDir + '/.uglyapp')) as { projectId?: string }).projectId ?? null;
  } catch {
    pid = null;
  }
  projectIdCache.set(projectDir, pid);
  return pid;
}

// Cached per project dir — is this an ugly-app project? (Gates the UGLY_APP
// tool set.) Mirrors the monolith `isUglyAppProject`: a `.uglyapp` marker, or
// an `ugly-app` dependency in package.json.
const uglyAppCache = new Map<string, boolean>();
export async function isUglyAppProject(projectDir: string): Promise<boolean> {
  const cached = uglyAppCache.get(projectDir);
  if (cached !== undefined) return cached;
  let res = false;
  try {
    await native.fs.readFile(projectDir + '/.uglyapp');
    res = true;
  } catch {
    try {
      const pkg = JSON.parse(await native.fs.readFile(projectDir + '/package.json')) as {
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
      };
      res = pkg.dependencies?.['ugly-app'] !== undefined || pkg.devDependencies?.['ugly-app'] !== undefined;
    } catch {
      res = false;
    }
  }
  uglyAppCache.set(projectDir, res);
  return res;
}

/** Build the daemon sandbox spawn option for this tool call (or undefined when
 *  there's no project / projectId → spawn runs unsandboxed). */
async function sandboxOptFor(
  ctx?: ToolContext,
): Promise<{ projectId: string; mode: SandboxMode; projectDir: string } | undefined> {
  const mode = ctx?.mode ?? 'edit';
  const projectDir = ctx?.projectDir;
  if (!projectDir) return undefined;
  const projectId = await readProjectId(projectDir);
  if (!projectId) return undefined;
  return { projectId, projectDir, mode };
}

/** Matches a bash command whose intent is to start the (forever-blocking) dev
 *  server: `ugly-app dev` (with any `npx` / `pnpm dlx` / `pnpm exec` prefix), or
 *  the `dev` package script via pnpm / npm / yarn. The `(?![\w-])` tail keeps
 *  `pnpm run dev-check`, `devDependencies`, etc. from matching. */
const DEV_SERVER_CMD_RE =
  /(?:\bugly-app\s+dev(?![\w-]))|(?:\b(?:pnpm|yarn)\s+(?:run\s+)?dev(?![\w-]))|(?:\bnpm\s+run\s+dev(?![\w-]))/;

/** Intercept attempts to launch the dev server via `bash`. Running `ugly-app dev`
 *  / `pnpm dev` from bash blocks forever (the process never exits) and runs
 *  without the session's bundled-postgres DATABASE_URL/PORT, so it fails on
 *  DATABASE_URL or wedges the turn. The `dev_server_start` tool is the supported
 *  path — non-blocking, and boots via the Preview panel with the right env. Only
 *  fires for ugly-app projects (where `dev_server_start` exists); returns null
 *  otherwise so the command runs normally. */
async function devServerBashGuard(command: string, ctx?: ToolContext): Promise<string | null> {
  if (!DEV_SERVER_CMD_RE.test(command)) return null;
  const dir = ctx?.projectDir;
  if (!dir || !(await isUglyAppProject(dir))) return null;
  return (
    'Refusing to start the dev server from bash — it blocks forever (the process ' +
    "never exits) and runs without this session's DATABASE_URL/PORT, so it fails or " +
    'hangs the turn. Use the `dev_server_start` tool instead: it boots `pnpm dev` ' +
    'non-blocking via the Preview panel with the bundled-postgres DATABASE_URL + PORT ' +
    'already wired, then check `dev_server_logs` / `dev_server_errors` for boot progress.'
  );
}

/** Default wall-clock cap for a `bash` call — the spec advertises this, and
 *  without it a blocking command (a dev server, a hung install) runs forever and
 *  wedges the turn. Overridable per-call via the tool's `timeout_ms` param. */
export const DEFAULT_BASH_TIMEOUT_MS = 120_000;

/** Live `bash` subprocesses keyed by session — so `stop` (agent abort) can kill
 *  them. Without this the model loop stops but the spawned process keeps running
 *  on the host, which is exactly the "clicked stop, bash still running" report. */
const runningBashProcs = new Map<string, Set<UglyProcess>>();

/** Kill every live `bash` subprocess for a session. Called from the agent-abort
 *  path (clientAgent.abortClientAgent / reset) so stopping a turn also stops its
 *  shell work. Returns how many procs were signalled. */
export function killSessionBashProcs(sessionId: string): number {
  const set = runningBashProcs.get(sessionId);
  if (!set || set.size === 0) return 0;
  let n = 0;
  for (const proc of set) {
    try { proc.kill(); n += 1; } catch { /* already exited */ }
  }
  set.clear();
  runningBashProcs.delete(sessionId);
  return n;
}

function trackBashProc(sessionId: string | undefined, proc: UglyProcess): () => void {
  if (!sessionId) return () => undefined;
  let set = runningBashProcs.get(sessionId);
  if (!set) { set = new Set(); runningBashProcs.set(sessionId, set); }
  set.add(proc);
  return () => {
    const s = runningBashProcs.get(sessionId);
    if (!s) return;
    s.delete(proc);
    if (s.size === 0) runningBashProcs.delete(sessionId);
  };
}

/** Run a shell command through the daemon (POSIX `sh -c`), resolving with the
 *  combined output. The daemon OS-user-sandboxes the subprocess when `sandbox`
 *  is provided; PORT (so `pnpm dev` binds the session's port → Preview loads it)
 *  and DATABASE_URL (so the dev server boots against the bundled local DB) are
 *  injected. `workingDir` overrides the cwd (else the worktree/project root).
 *  `timeoutMs` kills the proc after that wall-clock (default DEFAULT_BASH_TIMEOUT_MS). */
function runBash(
  command: string,
  sandbox: { projectId: string; mode: SandboxMode; projectDir: string } | undefined,
  ctx: ToolContext | undefined,
  workingDir?: string,
  timeoutMs: number = DEFAULT_BASH_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    try {
      const cwd = workingDir
        ? resolvePath(ctx, workingDir)
        : ctx?.workspaceDir ?? ctx?.projectDir ?? undefined;
      const env: Record<string, string> = {
        ...(ctx?.port ? { PORT: String(ctx.port) } : {}),
        ...(ctx?.databaseUrl ? { DATABASE_URL: ctx.databaseUrl } : {}),
      };
      const opts: Parameters<typeof native.process.spawn>[2] = {
        ...(sandbox ? { sandbox } : {}),
        ...(cwd ? { cwd } : {}),
        ...(Object.keys(env).length ? { env } : {}),
      };
      const proc = native.process.spawn('sh', ['-c', command], opts);
      const untrack = trackBashProc(ctx?.sessionId, proc);
      // Single-shot settle: whichever of exit / error / timeout fires first wins,
      // then we stop tracking + clear the timer so nothing double-resolves.
      let settled = false;
      // eslint-disable-next-line prefer-const -- assigned once, but mutually referenced with settle() below (must be declared before both).
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (text: string): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        untrack();
        resolve(text);
      };
      timer = setTimeout(() => {
        try { proc.kill(); } catch { /* already gone */ }
        settle(`${out.trimEnd()}\n[timed out after ${Math.round(timeoutMs / 1000)}s — process killed. For a long-running dev server use the dev_server_start tool; otherwise pass a larger timeout_ms.]`);
      }, timeoutMs);
      proc.onStdout((c) => (out += c));
      proc.onStderr((c) => (out += c));
      proc.onError((e) => { settle(`${out}\n[error: ${e}]`); });
      proc.onExit((code) => { settle(truncate(`${out.trimEnd()}\n[exit ${code ?? 'null'}]`)); });
    } catch (e) {
      console.error('[agentTools:runBash]', JSON.stringify({ command, workingDir, projectDir: ctx?.projectDir, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined);
      resolve(`[error: ${(e as Error).message}]`);
    }
  });
}
