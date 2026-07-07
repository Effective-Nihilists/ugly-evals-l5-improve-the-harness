// `grep` — ported from ugly-studio f5a74c2^:server/coding-agent/tools/grep.ts.
// The merged search tool: exact regex (ripgrep), `semantic` (embedding index via
// the host `codebase.search` channel — the monolith folded the old
// `codebase_search` tool in here), and LSP modes (defs/refs/impls) + the
// auto-supplement. The `.specs` virtual path is still dropped.

import type { TextGenTool } from 'ugly-app/shared';
import { installUglyNative } from 'ugly-app/native';
import { formatSearchResult, type SearchResponse } from './searchResponse';
import { drainDirty } from './codebaseDirty';
import type { ToolModule } from './registry';
import type { ToolContext } from '../tools';
import { projectRoot, lspForProject } from './lspForProject';
import { fileUriToPath } from '../../studio/agent/lsp/client';
import { spawnCollect } from './spawn';
import { HARD_EXCLUDES } from './pathExcludes';

/** Strip `cwd` from an absolute path for model-facing display. Separator- and
 *  case-insensitive on Windows so `C:\proj\a.ts` under a `C:\proj` cwd still
 *  relativizes (a plain `cwd + '/'` prefix never matches backslash paths). */
function displayRelative(p: string, cwd: string): string {
  if (!cwd) return p;
  const isWin = cwd.includes('\\') && !cwd.startsWith('/');
  if (isWin) {
    const norm = (s: string): string => s.replace(/\//g, '\\').toLowerCase();
    const np = norm(p);
    const nc = norm(cwd.replace(/[\\/]+$/, ''));
    return np.startsWith(nc + '\\') ? p.slice(nc.length + 1) : p;
  }
  return p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p;
}

export type GrepMode =
  | 'auto'
  | 'exact'
  | 'fts'
  | 'semantic'
  | 'mixed'
  | 'lsp-defs'
  | 'lsp-refs'
  | 'lsp-impls'
  | 'lsp-diagnostics';

export interface GrepArgs {
  pattern: string;
  path?: string;
  include?: string;
  literal_text?: boolean;
  caseInsensitive?: boolean;
  include_ignored?: boolean;
  mode?: GrepMode;
  output_mode?: 'content' | 'files_with_matches' | 'count';
  head_limit?: number;
  before_lines?: number;
  after_lines?: number;
  /** Caps the semantic pass (mode="semantic"). Default 10. */
  limit?: number;
}

/** Index-backed search over the host (`codebase.search`): `fts` (BM25 keyword),
 *  `semantic` (embedding), or `mixed` (both, cross-encoder re-ranked). `codebase.*`
 *  is a host-only UglyNative channel, scoped to the open project; the worktree
 *  (if any) rides as the overlay so the agent sees its own uncommitted edits.
 *  Returns the discriminated `SearchResponse` formatted for the model (an
 *  indexing / model-download / unavailable state surfaces a reason, never a
 *  silent empty list). */
async function runIndexSearch(
  mode: 'fts' | 'semantic' | 'mixed',
  args: GrepArgs,
  ctx: ToolContext | undefined,
): Promise<string> {
  const projectPath = ctx?.projectDir ?? '';
  if (!projectPath) return `grep mode=${mode} unavailable: no project is open.`;
  // Freshness: push this session's edits into the index before searching, so
  // fts/semantic/mixed reflect the agent's own uncommitted changes.
  const dirtyFiles = ctx?.sessionId ? drainDirty(ctx.sessionId) : [];
  if (dirtyFiles.length) {
    try {
      await installUglyNative().invoke('codebase.update' as never, {
        projectPath,
        files: dirtyFiles,
        ...(ctx?.workspaceDir ? { worktreeRoot: ctx.workspaceDir } : {}),
      } as never);
    } catch {
      /* best-effort freshness — search proceeds on the current index */
    }
  }
  const resp = (await installUglyNative().invoke('codebase.search' as never, {
    projectPath,
    mode,
    query: args.pattern,
    limit: typeof args.limit === 'number' ? args.limit : 10,
    ...(ctx?.workspaceDir ? { worktreeRoot: ctx.workspaceDir } : {}),
  } as never)) as SearchResponse;
  return formatSearchResult(resp);
}

/** Map grep args → ripgrep argv. Pure, exported for test. */
export function buildRgArgs(args: GrepArgs): string[] {
  const a: string[] = [];
  const mode = args.output_mode ?? 'content';
  if (args.caseInsensitive) a.push('-i');
  if (args.include_ignored) a.push('--no-ignore');
  for (const dir of HARD_EXCLUDES) a.push('-g', `!${dir}`);
  if (args.include) a.push('-g', args.include);
  if (mode === 'files_with_matches') {
    a.push('-l');
  } else if (mode === 'count') {
    a.push('-c');
  } else {
    a.push('-n', '--no-heading');
    if (args.before_lines) a.push('-B', String(args.before_lines));
    if (args.after_lines) a.push('-A', String(args.after_lines));
  }
  if (args.head_limit) a.push('-m', String(args.head_limit));
  if (args.literal_text) a.push('-F');
  a.push('-e', args.pattern);
  if (args.path) a.push(args.path);
  return a;
}

/** The exact ripgrep pass. */
async function runExact(args: GrepArgs, ctx: ToolContext | undefined): Promise<string> {
  const root = projectRoot(ctx) ?? undefined;
  const { stdout, stderr, code } = await spawnCollect('rg', buildRgArgs(args), {
    ...(root ? { cwd: root } : {}),
  });
  // ripgrep: 0 = matches, 1 = no matches, 2 = error.
  if (code === 1) return `(no matches for ${JSON.stringify(args.pattern)})`;
  if (code !== 0 && code !== null) {
    return `(grep error, exit ${code})\n${(stderr || stdout).trim()}`;
  }
  return stdout.trimEnd() || `(no matches for ${JSON.stringify(args.pattern)})`;
}

interface LspHit { uri: string; line: number; character: number }

const BARE_IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const LSP_SUPPLEMENT_MAX = 20;

/** Identifiers eligible for the LSP-definitions supplement: a bare identifier
 *  ("AppTabPicker") or a `|`-union of them ("Foo|Bar"). Anything with regex
 *  metacharacters, or names shorter than 3 chars, disqualifies. Deduped, capped
 *  at 5. Pure, exported for test. Ported from the monolith `extractIdentSymbols`. */
export function extractIdentSymbols(pattern: string): string[] {
  const parts = pattern.split('|');
  for (const p of parts) {
    if (!BARE_IDENT_RE.test(p) || p.length < 3) return [];
  }
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of parts) {
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
    if (unique.length >= 5) break;
  }
  return unique;
}

/** Parallel `workspaceSymbol` for each identifier, exact-name filtered + deduped
 *  + capped — the declaration sites appended as an `LSP DEFINITIONS` section. */
async function lspSupplementDefs(
  lsp: NonNullable<Awaited<ReturnType<typeof lspForProject>>>,
  symbols: string[],
): Promise<LspHit[]> {
  const perSymbol = await Promise.all(
    symbols.map(async (s) => {
      try {
        return (await lsp.workspaceSymbol(s)).filter((h) => h.name === s);
      } catch {
        return [];
      }
    }),
  );
  const seen = new Set<string>();
  const defs: LspHit[] = [];
  for (const hits of perSymbol) {
    for (const h of hits) {
      const key = `${h.uri}:${h.line}:${h.character}`;
      if (seen.has(key)) continue;
      seen.add(key);
      defs.push({ uri: h.uri, line: h.line, character: h.character });
      if (defs.length >= LSP_SUPPLEMENT_MAX) return defs;
    }
  }
  return defs;
}

/** Format LSP hits as cwd-relative `path:line:col`. Ported from the monolith
 *  `formatLspHits`. */
function formatLspHits(
  mode: 'lsp-defs' | 'lsp-refs' | 'lsp-impls',
  symbol: string,
  hits: LspHit[],
  cwd: string | null,
): string {
  const label =
    mode === 'lsp-impls'
      ? 'implementations'
      : mode === 'lsp-refs'
        ? 'references'
        : 'definitions';
  if (hits.length === 0) return `(no ${label} for ${JSON.stringify(symbol)})`;
  const lines = hits.map((h) => {
    const p = displayRelative(fileUriToPath(h.uri), cwd ?? '');
    return `${p}:${h.line}:${h.character}`;
  });
  return `Found ${hits.length} ${label} for ${JSON.stringify(symbol)}\n${lines.join('\n')}\n`;
}

/** `lsp-diagnostics` mode: TypeScript diagnostics from the language server —
 *  authoritative for "does this compile". With a file (via `path`, or a
 *  path-like `pattern`) returns that file's diagnostics; otherwise a
 *  project-wide summary. Merged in from the former standalone lsp_diagnostics. */
async function runDiagnostics(args: GrepArgs, ctx: ToolContext | undefined): Promise<string> {
  const lsp = await lspForProject(ctx);
  if (!lsp) return '(lsp not available — no project open or the TypeScript server failed to start)';
  await lsp.ensureProjectLoaded();
  const file = args.path ?? (/[/.]/.test(args.pattern) ? args.pattern : undefined);
  if (file) {
    const diags = lsp.getDiagnostics(file);
    if (diags.length === 0) return `(no diagnostics for ${file})`;
    return diags
      .map((d) => `${file}:${d.line}:${d.column} ${d.severity}: ${d.message}${d.code !== undefined ? ` [${d.code}]` : ''}`)
      .join('\n');
  }
  return lsp.formatSummary() || '(no diagnostics)';
}

/** LSP-mode grep: `symbol` is a name → workspaceSymbol → defs directly, or
 *  refs/impls dispatched from the first few declaration sites. Ported from the
 *  monolith `runLspMode`; `ctx.lsp` → `lspForProject(ctx)`. */
export async function runLspMode(
  mode: 'lsp-defs' | 'lsp-refs' | 'lsp-impls',
  symbol: string,
  ctx: ToolContext | undefined,
): Promise<string> {
  const lsp = await lspForProject(ctx);
  if (!lsp) {
    return `(lsp not available — mode=${mode} requires the TypeScript language server)`;
  }
  if (lsp.getState() !== 'ready') {
    return `(lsp not yet initialized — state=${lsp.getState()}; retry shortly)`;
  }
  // Ensure the project graph is loaded so workspaceSymbol returns cross-file
  // results (memoized after the first call).
  await lsp.ensureProjectLoaded();
  const cwd = projectRoot(ctx);
  const symbols = await lsp.workspaceSymbol(symbol);
  if (symbols.length === 0) {
    return `(no LSP symbol named ${JSON.stringify(symbol)} found; it may still be indexing — retry, or check spelling)`;
  }
  if (mode === 'lsp-defs') {
    return formatLspHits(
      mode,
      symbol,
      symbols.map((s) => ({ uri: s.uri, line: s.line, character: s.character })),
      cwd,
    );
  }
  // refs / impls: dispatch from the first 3 declaration sites, dedupe.
  const seen = new Set<string>();
  const results: LspHit[] = [];
  for (const s of symbols.slice(0, 3)) {
    const filePath = fileUriToPath(s.uri);
    try {
      const line0 = Math.max(0, s.line - 1);
      const char0 = Math.max(0, s.character - 1);
      await lsp.openFile(filePath);
      const hits =
        mode === 'lsp-impls'
          ? await lsp.findImplementations(filePath, line0, char0)
          : await lsp.findReferences(filePath, line0, char0);
      for (const h of hits) {
        const key = `${h.uri}:${h.line}:${h.character}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push(h);
      }
    } catch {
      /* one site failing shouldn't kill the whole call */
    }
  }
  return formatLspHits(mode, symbol, results, cwd);
}

const SPEC: TextGenTool = {
  name: 'grep',
  description:
    'Search the workspace. mode "exact"/"auto" runs a regex (ripgrep). mode ' +
    '"fts" is ranked full-text keyword search (BM25). mode "semantic" finds code ' +
    'by meaning/intent (embedding search over the indexed codebase). mode "mixed" ' +
    '(recommended for natural-language lookups like "where websocket reconnect ' +
    'backoff is handled") fuses fts + semantic and re-ranks with a cross-encoder. ' +
    'mode "lsp-defs"/"lsp-refs"/"lsp-impls" takes a SYMBOL ' +
    'NAME and returns its definitions / references / implementations via the ' +
    'language server. mode "lsp-diagnostics" returns TypeScript errors/warnings ' +
    '(authoritative for "does this compile" — prefer over running tsc): pass a ' +
    'file via `path` for one file, or omit for a project-wide summary. Plain ' +
    'identifier searches in auto mode also get an appended LSP DEFINITIONS section.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex (exact/auto), natural language (semantic), symbol name (lsp-defs/refs/impls), or an optional file for lsp-diagnostics.' },
      path: { type: 'string', description: 'Optional file or directory to scope the search (or the file for lsp-diagnostics).' },
      include: { type: 'string', description: 'Glob filter, e.g. "*.ts".' },
      literal_text: { type: 'boolean', description: 'Treat pattern as a literal string, not a regex.' },
      caseInsensitive: { type: 'boolean', description: 'Case-insensitive match.' },
      include_ignored: { type: 'boolean', description: 'Also search .gitignore-d files.' },
      mode: { type: 'string', enum: ['auto', 'exact', 'fts', 'semantic', 'mixed', 'lsp-defs', 'lsp-refs', 'lsp-impls', 'lsp-diagnostics'] },
      output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] },
      head_limit: { type: 'number', description: 'Cap the number of exact-pass matches.' },
      before_lines: { type: 'number', description: 'Context lines before each match (content mode).' },
      after_lines: { type: 'number', description: 'Context lines after each match (content mode).' },
      limit: { type: 'number', description: 'Cap the semantic-pass results (mode="semantic"). Default 10.' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
};

export const grepTool: ToolModule = {
  name: 'grep',
  spec: SPEC,
  async run(input, ctx) {
    const args = input as unknown as GrepArgs;
    if (args.mode === 'fts' || args.mode === 'semantic' || args.mode === 'mixed') {
      return runIndexSearch(args.mode, args, ctx);
    }
    if (args.mode === 'lsp-diagnostics') {
      return runDiagnostics(args, ctx);
    }
    if (
      args.mode === 'lsp-defs' ||
      args.mode === 'lsp-refs' ||
      args.mode === 'lsp-impls'
    ) {
      return runLspMode(args.mode, args.pattern, ctx);
    }

    // Auto-supplement: for a bare-identifier auto grep, run the exact pass and
    // an LSP workspaceSymbol lookup in parallel; append the canonical
    // declaration site(s) as an `LSP DEFINITIONS` section when LSP is ready.
    const modeOk = args.mode === undefined || args.mode === 'auto';
    const symbols =
      modeOk && args.literal_text !== true ? extractIdentSymbols(args.pattern) : [];
    if (symbols.length === 0) return runExact(args, ctx);

    const [exact, lsp] = await Promise.all([runExact(args, ctx), lspForProject(ctx)]);
    if (lsp?.getState() !== 'ready') return exact;
    const defs = await lspSupplementDefs(lsp, symbols);
    if (defs.length === 0) return exact;
    const cwd = projectRoot(ctx);
    const defLines = defs.map((h) => {
      const p = displayRelative(fileUriToPath(h.uri), cwd ?? '');
      return `${p}:${h.line}:${h.character}`;
    });
    return `${exact}\n\nLSP DEFINITIONS\n${defLines.join('\n')}`;
  },
};
