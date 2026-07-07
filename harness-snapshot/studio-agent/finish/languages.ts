/**
 * Gate-detection for the Finish pipeline — a faithful port of the monolith's
 * coding-agent language adapters (server/coding-agent/languages/{registry,node,
 * python,probe,types,toolchain-note}.ts).
 *
 * WHAT THIS DOES
 * --------------
 * Given a session worktree `cwd`, decide which command the Finish pipeline
 * should run for each validation gate:
 *   - typecheck  (tsc --noEmit / the project's `typecheck` script / pyright|mypy)
 *   - lint       (eslint / the project's `lint` script / ruff)
 *   - test       (vitest|jest via the project's `test` script / pytest)
 * Each resolver returns an `AdapterCommand` or `null`. A `null` gate is safely
 * "skipped" by the pipeline, so returning null when we're unsure is the correct,
 * conservative behavior.
 *
 * We walk the project's detected languages in declaration order — Node/TS first,
 * then Python — and return the FIRST non-null resolver result for the requested
 * gate. Declaration order matters for the common case where a Node project also
 * carries a `pyproject.toml` for ML scripts: Node stays primary and answers the
 * gate, so the Python resolver is never consulted.
 *
 * ADAPTATION FROM THE MONOLITH
 * ----------------------------
 * The monolith ran in the studio sidecar with `node:fs` / `child_process` and a
 * `getGitBinary`/binaries-path indirection to reach bundled tools. This port runs
 * inside the coding background task (coding-task.ts), which must go through the
 * native facade instead of node built-ins, and where the bundled toolchain
 * (tsc via npx/node_modules, eslint, vitest, pnpm/npm, uv) is already on PATH:
 *   - `node:fs` -> `native.fs.readFile` / `native.fs.readdir` / `exists()` (stat).
 *   - `child_process` is dropped entirely: gate DETECTION only reads
 *     package.json / probes for lockfiles + config files. No spawning here.
 *   - `getGitBinary`/`getUvBinary`/bundled-path resolution collapses to plain
 *     PATH command names: `npx`, `pnpm`, `npm`, `node`, `uv`.
 *
 * Detection is intentionally uncached — a caller may write a `package.json` into
 * the worktree after provisioning (e.g. the finish-pipeline test), and caching
 * would make us miss it.
 */

import { native } from 'ugly-app/native';
import type { AdapterCommand } from './types';

// ---------------------------------------------------------------------------
// native.fs helpers (mirrors the pattern in ../sessionWorkspace.ts)
// ---------------------------------------------------------------------------

/** True iff `path` exists (file or dir). `native.fs.stat` throws when missing. */
async function exists(path: string): Promise<boolean> {
  try {
    await native.fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Read a UTF-8 file, or return null if it's missing/unreadable. */
async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await native.fs.readFile(path);
  } catch {
    return null;
  }
}

/** Join a dir and a child segment with a single `/` (worktrees are posix paths). */
function join(dir: string, child: string): string {
  return dir.endsWith('/') ? `${dir}${child}` : `${dir}/${child}`;
}

// ---------------------------------------------------------------------------
// package.json + package-manager detection (Node/TS)
// ---------------------------------------------------------------------------

interface PackageJsonShape {
  scripts?: Record<string, string>;
}

/** Parse the worktree's package.json, or null when absent / malformed. */
async function readPackageJson(cwd: string): Promise<PackageJsonShape | null> {
  const raw = await readFileOrNull(join(cwd, 'package.json'));
  if (raw == null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

type PackageManager = 'pnpm' | 'yarn' | 'npm' | 'bun';

/**
 * Detect the project's package manager from its lockfile (best-effort). Mirrors
 * the monolith's `detectPackageManager`, collapsed to a lockfile probe since the
 * managers themselves are all on PATH. Defaults to `npm` when nothing matches.
 */
async function detectPackageManager(cwd: string): Promise<PackageManager> {
  if (await exists(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await exists(join(cwd, 'yarn.lock'))) return 'yarn';
  if (await exists(join(cwd, 'bun.lockb'))) return 'bun';
  if (await exists(join(cwd, 'package-lock.json'))) return 'npm';
  return 'npm';
}

// ---------------------------------------------------------------------------
// Node / TypeScript adapter
// ---------------------------------------------------------------------------

const ESLINT_CONFIGS = [
  '.eslintrc.json',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.yaml',
  '.eslintrc.yml',
  '.eslintrc',
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
] as const;

/** A project is "Node" iff it has a package.json. */
async function nodeDetected(cwd: string): Promise<boolean> {
  return exists(join(cwd, 'package.json'));
}

async function nodeTypecheck(cwd: string): Promise<AdapterCommand | null> {
  const pkg = await readPackageJson(cwd);
  const scripts = pkg?.scripts ?? {};
  // Prefer an explicit project script — it encodes the project's own tsc flags
  // / multi-tsconfig setup better than a bare `tsc --noEmit` ever could.
  const scriptNames = ['typecheck', 'type-check', 'types', 'tsc'];
  const hit = scriptNames.find((n) => typeof scripts[n] === 'string');
  if (hit) {
    const pm = await detectPackageManager(cwd);
    return { command: pm, args: ['run', hit], label: `${pm} run ${hit}` };
  }
  // No script, but a tsconfig means TS is in play — run the compiler directly.
  // `npx --no-install` resolves the project-local tsc without ever hitting the
  // network (tsc is a dev-dependency in every ugly-app project).
  if (await exists(join(cwd, 'tsconfig.json'))) {
    return {
      command: 'npx',
      args: ['--no-install', 'tsc', '--noEmit'],
      label: 'npx tsc --noEmit',
    };
  }
  return null;
}

async function nodeLint(cwd: string): Promise<AdapterCommand | null> {
  const pkg = await readPackageJson(cwd);
  const scripts = pkg?.scripts ?? {};
  if (typeof scripts.lint === 'string') {
    const pm = await detectPackageManager(cwd);
    return { command: pm, args: ['run', 'lint'], label: `${pm} run lint` };
  }
  for (const cfg of ESLINT_CONFIGS) {
    if (await exists(join(cwd, cfg))) {
      return {
        command: 'npx',
        args: ['--no-install', 'eslint', '.', '--max-warnings=0'],
        label: 'npx eslint .',
      };
    }
  }
  return null;
}

async function nodeTest(cwd: string): Promise<AdapterCommand | null> {
  const pkg = await readPackageJson(cwd);
  if (typeof pkg?.scripts?.test !== 'string') return null;
  // Faithful to the monolith: invoke the project's `test` script and pass
  // `--run` through so vitest runs once and exits (jest ignores the extra flag).
  return { command: 'npm', args: ['test', '--', '--run'], label: 'npm test' };
}

// ---------------------------------------------------------------------------
// Python adapter (best-effort; null when unsure)
// ---------------------------------------------------------------------------
//
// Simplified from the monolith's uv-bundled adapter: we drop the bundled-uv
// binary/path/env indirection and invoke `uv` from PATH. Commands are only
// produced when the project actually declares the relevant tool (pyright/mypy/
// ruff/pytest); otherwise we return null so the gate is skipped rather than
// failing. `uv run <tool>` executes the tool inside the worktree's `.venv/`.

const PYTHON_MANIFESTS = [
  'pyproject.toml',
  'requirements.txt',
  'Pipfile',
  'setup.py',
  'uv.lock',
] as const;

/** A project is "Python" iff any python manifest is present in the root. */
async function pythonDetected(cwd: string): Promise<boolean> {
  for (const m of PYTHON_MANIFESTS) {
    if (await exists(join(cwd, m))) return true;
  }
  return false;
}

/** Read pyproject.toml text (for `[tool.*]` sniffing), or null if absent. */
async function readPyProject(cwd: string): Promise<string | null> {
  return readFileOrNull(join(cwd, 'pyproject.toml'));
}

async function pythonTypecheck(cwd: string): Promise<AdapterCommand | null> {
  const pyproject = await readPyProject(cwd);
  const hasPyright =
    (await exists(join(cwd, 'pyrightconfig.json'))) ||
    Boolean(pyproject?.includes('[tool.pyright]'));
  if (hasPyright) {
    return { command: 'uv', args: ['run', 'pyright'], label: 'uv run pyright' };
  }
  const hasMypy =
    (await exists(join(cwd, 'mypy.ini'))) ||
    (await exists(join(cwd, '.mypy.ini'))) ||
    Boolean(pyproject?.includes('[tool.mypy]'));
  if (hasMypy) {
    return { command: 'uv', args: ['run', 'mypy', '.'], label: 'uv run mypy .' };
  }
  return null;
}

async function pythonLint(cwd: string): Promise<AdapterCommand | null> {
  const pyproject = await readPyProject(cwd);
  const hasRuff =
    (await exists(join(cwd, 'ruff.toml'))) ||
    (await exists(join(cwd, '.ruff.toml'))) ||
    Boolean(pyproject && /\[tool\.ruff(\.|\])/.test(pyproject));
  if (!hasRuff) return null;
  return {
    command: 'uv',
    args: ['run', 'ruff', 'check', '.'],
    label: 'uv run ruff check .',
  };
}

async function pythonTest(cwd: string): Promise<AdapterCommand | null> {
  const pyproject = await readPyProject(cwd);
  const hasPytest =
    Boolean(pyproject && /\[tool\.pytest(\.|\])/.test(pyproject)) ||
    (await exists(join(cwd, 'pytest.ini'))) ||
    (await exists(join(cwd, 'tests')));
  if (!hasPytest) return null;
  return { command: 'uv', args: ['run', 'pytest', '-q'], label: 'uv run pytest -q' };
}

// ---------------------------------------------------------------------------
// Registry walk — Node first, then Python; first non-null gate wins.
// ---------------------------------------------------------------------------

interface GateAdapter {
  detected(cwd: string): Promise<boolean>;
  typecheck(cwd: string): Promise<AdapterCommand | null>;
  lint(cwd: string): Promise<AdapterCommand | null>;
  test(cwd: string): Promise<AdapterCommand | null>;
}

const NODE_ADAPTER: GateAdapter = {
  detected: nodeDetected,
  typecheck: nodeTypecheck,
  lint: nodeLint,
  test: nodeTest,
};

const PYTHON_ADAPTER: GateAdapter = {
  detected: pythonDetected,
  typecheck: pythonTypecheck,
  lint: pythonLint,
  test: pythonTest,
};

// Declaration order == priority order: Node/TS primary, Python secondary.
const ADAPTERS: readonly GateAdapter[] = [NODE_ADAPTER, PYTHON_ADAPTER];

/**
 * Walk detected languages (primary first) and return the first non-null result
 * of `gate` for a detected adapter. Returns null when nothing resolves — the
 * pipeline treats a null gate as "skipped".
 */
async function resolveGate(
  cwd: string,
  gate: (a: GateAdapter, cwd: string) => Promise<AdapterCommand | null>,
): Promise<AdapterCommand | null> {
  for (const adapter of ADAPTERS) {
    if (!(await adapter.detected(cwd))) continue;
    const cmd = await gate(adapter, cwd);
    if (cmd) return cmd;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API — called by the Finish pipeline.
// ---------------------------------------------------------------------------

export async function resolveTypecheckGate(
  cwd: string,
): Promise<AdapterCommand | null> {
  return resolveGate(cwd, (a, c) => a.typecheck(c));
}

export async function resolveLintGate(
  cwd: string,
): Promise<AdapterCommand | null> {
  return resolveGate(cwd, (a, c) => a.lint(c));
}

export async function resolveTestGate(
  cwd: string,
): Promise<AdapterCommand | null> {
  return resolveGate(cwd, (a, c) => a.test(c));
}
