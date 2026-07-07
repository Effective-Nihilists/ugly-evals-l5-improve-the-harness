/**
 * LSP client for codingAgent.
 *
 * Spawns a real `typescript-language-server --stdio` child process,
 * speaks JSON-RPC over LSP content-length framing, and maintains a
 * per-file diagnostics map. The session uses this to:
 *
 *   1. Inject "current diagnostics for recently-touched files" into
 *      the LLM system prompt before each turn.
 *   2. Emit `lsp_event` envelopes so the IDE client (or
 *      compatible consumers) see diagnostic updates as wire events,
 *      matching how the tool surfaces LSP state.
 *
 * This module is independent of server/lsp.ts. That module is a dumb
 * stdio passthrough between the editor and an LSP child — the editor's
 * monaco-languageclient is the actual LSP client. We don't share that
 * connection because (a) it's owned by the editor's lifecycle, not the
 * agent's, and (b) the agent needs to drive its own didOpen/didChange
 * sequence based on which files the tools touch, decoupled from what
 * the user has open in Monaco.
 *
 * Performance: spawning typescript-language-server is several hundred
 * ms cold-start, and the first didOpen on a large project blocks for
 * a few seconds while the server walks node_modules for type info.
 * After that, individual `didChange`s are <100ms. We only open files
 * the agent actually touches, so a turn that only edits one file pays
 * exactly one initialization cost.
 *
 * Failure modes are best-effort: if typescript-language-server isn't
 * installed, the client falls into a `disabled` state and every method
 * is a no-op. The agent runs without diagnostics; nothing breaks.
 */

import path from 'path';
import { native } from 'ugly-app/native';
import type { UglyProcess } from 'ugly-app/native';

export interface LspDiagnostic {
  /** 1-indexed line number for human display. */
  line: number;
  /** 1-indexed column. */
  column: number;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  source?: string;
  code?: string | number;
}

export type LspState =
  | 'initializing'
  | 'ready'
  | 'error'
  | 'disabled'
  | 'closed';

export type LspLanguage = 'typescript' | 'python';

export interface LspClientOptions {
  workspaceRoot: string;
  /** Which language server to spawn. Defaults to 'typescript'. */
  language?: LspLanguage;
  /** Override the LSP binary lookup. */
  binaryPath?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/**
 * The LSP severity int → human label. LSP spec values:
 * 1=Error, 2=Warning, 3=Information, 4=Hint.
 */
const SEVERITY_BY_NUM: Record<number, LspDiagnostic['severity']> = {
  1: 'error',
  2: 'warning',
  3: 'info',
  4: 'hint',
};

function log(msg: string, ...args: unknown[]) {
  console.log(`[coding-agent/lsp] ${msg}`, ...args);
}

// Flip to true locally to trace tsserver's stderr + request lifecycle. Kept a
// plain const (not process.env) because this client runs in the browser.
const DEBUG = false;
function debug(msg: string, ...args: unknown[]) {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- DEBUG is a compile-time toggle flipped to true locally when tracing
  if (DEBUG) console.log(`[lsp:debug] ${msg}`, ...args);
}

/** Convert an absolute path to a `file://` URI without Node's `url` module.
 *  POSIX paths get three slashes (`file:///Users/…`); Windows drive paths get
 *  their leading slash (`file:///C:/…`). */
function pathToFileUri(filePath: string): string {
  const p = filePath.replace(/\\/g, '/');
  const withSlash = p.startsWith('/') ? p : `/${p}`;
  return `file://${encodeURI(withSlash)}`;
}

/** Inverse of pathToFileUri — strip the scheme, decode, and drop the leading
 *  slash ahead of a Windows drive letter. */
export function fileUriToPath(uri: string): string {
  try {
    let p = decodeURIComponent(uri.replace(/^file:\/\//, ''));
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    return p;
  } catch {
    return uri;
  }
}

/** The single event this client broadcasts: LSP lifecycle + diagnostic updates,
 *  wire-compatible with the IDE's `lsp_event` envelope. */
export interface LspEventEnvelope {
  type: 'lsp_event';
  payload: {
    type: 'created' | 'updated' | 'deleted';
    payload: {
      state: LspState;
      file?: string;
      diagnostics?: LspDiagnostic[];
      totalErrors?: number;
      totalWarnings?: number;
      message?: string;
    };
  };
}

/** Minimal browser-safe replacement for node:events — one event channel, a
 *  Set of listeners, on()/off()/emit()/clear(). */
class Emitter {
  private readonly listeners = new Set<(event: LspEventEnvelope) => void>();
  on(listener: (event: LspEventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  off(listener: (event: LspEventEnvelope) => void): void {
    this.listeners.delete(listener);
  }
  emit(event: LspEventEnvelope): void {
    // Snapshot so a listener that unsubscribes mid-emit doesn't skip peers.
    for (const l of [...this.listeners]) l(event);
  }
  clear(): void {
    this.listeners.clear();
  }
}

/**
 * Bounded fs walk for the first source file under `dir` matching the
 * language pattern. Used to prime the LSP server with a project
 * context after init.
 */
async function findFirstSourceFile(
  dir: string,
  maxDepth: number,
  language: LspLanguage,
): Promise<string | null> {
  if (maxDepth < 0) return null;
  const matches = (name: string): boolean => {
    if (language === 'python') return name.endsWith('.py');
    return /\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts');
  };
  let entries: Awaited<ReturnType<typeof native.fs.readdir>>;
  try {
    entries = await native.fs.readdir(dir);
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isFile && matches(e.name)) {
      return full;
    }
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    if (e.isDirectory) {
      const hit = await findFirstSourceFile(
        path.join(dir, e.name),
        maxDepth - 1,
        language,
      );
      if (hit) return hit;
    }
  }
  return null;
}

/** How to launch a language server: the command + its argv. */
export interface LspSpawnSpec {
  cmd: string;
  args: string[];
}

/**
 * Resolve the spawn spec for a language. TypeScript launches via
 * `npx --yes typescript-language-server --stdio` — node/npx are provisioned by
 * the studio's bundled-binary system, and npx resolves the server from
 * node_modules/.bin (if provisioned as a dep) or downloads it on first use.
 * Python (pyright) is out of scope for v1 and returns null, which puts the
 * client into `disabled` state (every method degrades to an empty result).
 */
export function resolveLspSpawn(language: LspLanguage): LspSpawnSpec | null {
  if (language === 'typescript') {
    return {
      cmd: 'npx',
      args: ['--yes', 'typescript-language-server', '--stdio'],
    };
  }
  return null;
}

/**
 * Split an accumulated stdout string into complete LSP messages using
 * Content-Length framing, returning the raw JSON bodies plus the unconsumed
 * remainder to carry into the next chunk. Pure (no `this`) so the framing is
 * unit-testable without spawning a real language server.
 *
 * NOTE: Content-Length is a BYTE count, but `buffer` is a decoded JS string
 * (native.process delivers strings, not Buffers). For the ASCII/UTF-8 JSON that
 * language servers emit, char length and byte length line up in practice; a
 * multi-byte body could under-read by a few chars, which JSON.parse then
 * rejects and handleMessage drops. This is the standard tradeoff for a
 * string-based JS LSP client that never sees the raw bytes.
 */
export function parseMessages(buffer: string): {
  messages: string[];
  rest: string;
} {
  const messages: string[] = [];
  let buf = buffer;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- intentional loop with multiple internal break points
  while (true) {
    const headerEnd = buf.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;
    const header = buf.slice(0, headerEnd);
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      buf = buf.slice(headerEnd + 4);
      continue;
    }
    const contentLength = parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    const total = bodyStart + contentLength;
    if (buf.length < total) break;
    messages.push(buf.slice(bodyStart, total));
    buf = buf.slice(total);
  }
  return { messages, rest: buf };
}

export class LspClient {
  readonly events = new Emitter();
  private state: LspState = 'initializing';
  private proc: UglyProcess | null = null;
  private buffer = '';
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly diagnostics = new Map<string, LspDiagnostic[]>();
  /** Monotonic timestamp of the most recent publishDiagnostics per file. Used by waitForDiagnostics to distinguish "fresh publish" from "stale entry". */
  private readonly diagnosticsPublishedAt = new Map<string, number>();
  private readonly openDocuments = new Map<
    string,
    { content: string; version: number }
  >();
  private initPromise: Promise<void> | null = null;
  private readonly workspaceRoot: string;
  private readonly spawnSpec: LspSpawnSpec | null;
  private readonly language: LspLanguage;

  constructor(opts: LspClientOptions) {
    this.workspaceRoot = opts.workspaceRoot;
    this.language = opts.language ?? 'typescript';
    this.spawnSpec = opts.binaryPath
      ? { cmd: opts.binaryPath, args: ['--stdio'] }
      : resolveLspSpawn(this.language);
    if (!this.spawnSpec) {
      this.state = 'disabled';
      log(
        `no language server available for '${this.language}' — ` +
          `LSP integration disabled for this session`,
      );
    }
  }

  getLanguage(): LspLanguage {
    return this.language;
  }

  getState(): LspState {
    return this.state;
  }

  /**
   * Subscribe to LSP lifecycle and diagnostic events. Returns an
   * unsubscribe function. The event shape is the wire-compatible
   * `{ type: 'lsp_event', payload: { type, payload } }` envelope so
   * the session can forward it directly to the IDE broadcast.
   */
  onEvent(listener: (event: LspEventEnvelope) => void): () => void {
    return this.events.on(listener);
  }

  private emitState(
    subType: 'created' | 'updated' | 'deleted',
    extras: {
      file?: string;
      diagnostics?: LspDiagnostic[];
      message?: string;
    } = {},
  ): void {
    const totals = this.totals();
    this.events.emit({
      type: 'lsp_event',
      payload: {
        type: subType,
        payload: {
          state: this.state,
          ...extras,
          totalErrors: totals.errors,
          totalWarnings: totals.warnings,
        },
      },
    });
  }

  /** Start the LSP server and run the JSON-RPC initialize handshake. */
  async start(): Promise<void> {
    if (this.state === 'disabled') return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      try {
        await this.spawnAndInitialize();
        this.state = 'ready';
        this.emitState('created');
        // Prime tsserver with a project file so the first
        // workspaceSymbol call doesn't fail with "No Project".
        // Fire-and-forget: don't block readiness on it.
        void this.primeProject();
      } catch (err) {
        this.state = 'error';
        this.emitState('updated', { message: (err as Error).message });
        throw err;
      }
    })();
    return this.initPromise;
  }

  /**
   * Block until the project graph has finished its initial load. The
   * editor's LSP queries (find references, go to implementation) need
   * tsserver to have walked the configured project's tsconfig before
   * they return cross-file results — without this, references on a
   * symbol like a shared interface only find the cursor file itself.
   *
   * Strategy: open one source file from the workspace, wait for
   * diagnostics on it, then issue a `workspace/symbol` request.
   * typescript-language-server completes that request only after the
   * project's program has been built, so it doubles as a sync point.
   */
  private projectReadyPromise: Promise<void> | null = null;
  async ensureProjectLoaded(): Promise<void> {
    if (this.state === 'disabled') return;
    if (this.state !== 'ready') await this.start();
    if (this.state !== 'ready') return;
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- ??= would force reindenting the whole multi-line IIFE below
    if (!this.projectReadyPromise) {
      this.projectReadyPromise = (async () => {
        const t0 = Date.now();
        debug('ensureProjectLoaded begin', {
          workspace: this.workspaceRoot,
          language: this.language,
        });
        const roots = ['src', 'app', 'lib', 'packages', '.'];
        let primed: string | null = null;
        for (const root of roots) {
          const dir = path.join(this.workspaceRoot, root);
          const hit = await findFirstSourceFile(dir, 4, this.language);
          if (hit) {
            primed = hit;
            try {
              await this.openFile(hit);
              await this.waitForDiagnostics(hit, 3000);
            } catch {
              /* best effort */
            }
            break;
          }
        }
        debug('ensureProjectLoaded primed', {
          file: primed ? path.relative(this.workspaceRoot, primed) : null,
          elapsedMs: Date.now() - t0,
        });
        try {
          const symbols = (await this.sendRequest('workspace/symbol', {
            query: '',
          })) as unknown[] | null;
          debug('ensureProjectLoaded workspace/symbol returned', {
            count: Array.isArray(symbols) ? symbols.length : 0,
            elapsedMs: Date.now() - t0,
          });
        } catch (err) {
          debug(
            'ensureProjectLoaded workspace/symbol failed:',
            (err as Error).message,
          );
        }
      })();
    }
    await this.projectReadyPromise;
  }

  /**
   * Open one project source file so tsserver loads a project context.
   * Without this, `workspace/symbol` and `textDocument/definition`
   * fail with "No Project" until some other code path opens a file.
   */
  private async primeProject(): Promise<void> {
    const roots = ['src', 'app', 'lib', 'packages', '.'];
    for (const root of roots) {
      const dir = path.join(this.workspaceRoot, root);
      const hit = await findFirstSourceFile(dir, 4, this.language);
      if (hit) {
        try {
          await this.openFile(hit);
        } catch (err) {
          log('primeProject openFile failed:', (err as Error).message);
        }
        return;
      }
    }
  }

  private async spawnAndInitialize(): Promise<void> {
    if (!this.spawnSpec) throw new Error('LSP binary missing');
    const proc = native.process.spawn(this.spawnSpec.cmd, this.spawnSpec.args, {
      cwd: this.workspaceRoot,
    });
    this.proc = proc;

    // native.process delivers already-decoded strings on stdout/stderr.
    proc.onStdout((chunk) => { this.handleStdout(chunk); });
    proc.onStderr((text) => {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- DEBUG is a compile-time toggle flipped to true locally when tracing
      if (DEBUG) {
        // Full stderr passthrough when debugging — tsserver's
        // "Loading project ...", "No Project", and trace lines all
        // come through here.
        for (const line of text.split('\n')) {
          if (line.trim()) debug('stderr:', line);
        }
      } else {
        // typescript-language-server is chatty on stderr. Surface only
        // the first line of each chunk so test logs don't drown in it.
        const first = text.split('\n')[0];
        if (first.trim()) log('stderr:', first);
      }
    });
    proc.onExit((code) => {
      // Only react to the exit if THIS proc is still the active one.
      // During `restart()` the old proc exits AFTER shutdown() has
      // unset `this.proc` and start() has already spawned a new
      // child — the old exit event must not flip the new client
      // into an error state. Using identity comparison (instead of
      // a state check) makes this race-free regardless of the
      // state-machine step restart() happens to be on.
      if (this.proc !== proc) return;
      if (this.state === 'closed') return;
      log('LSP exited unexpectedly with code', code);
      this.state = 'error';
      this.emitState('updated', { message: `LSP exited with code ${code}` });
      this.failAllPending(new Error('LSP process exited'));
    });
    proc.onError((err) => {
      // native's onError covers spawn failures and stdin/pipe errors alike
      // (e.g. EPIPE if the server dies mid-write). Either way: mark the
      // session errored and fail every pending request so callers degrade.
      if (this.proc !== proc) return;
      log('LSP process error:', err);
      this.state = 'error';
      this.emitState('updated', { message: err });
      this.failAllPending(new Error(err));
    });

    // LSP initialize handshake. We declare bare minimum capabilities —
    // we only consume diagnostics and the publishDiagnostics
    // notification, so we don't need completion/hover/etc.
    await this.sendRequest('initialize', {
      // No OS pid in the browser; processId is informational to the server.
      processId: 0,
      clientInfo: { name: 'ugly-studio', version: '0.1.0' },
      rootUri: pathToFileUri(this.workspaceRoot),
      capabilities: {
        textDocument: {
          publishDiagnostics: { relatedInformation: true },
          synchronization: { didOpen: true, didChange: true, didClose: true },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          rename: { prepareSupport: true },
        },
        workspace: {
          workspaceFolders: true,
          workspaceEdit: { documentChanges: true },
        },
      },
      workspaceFolders: [
        { uri: pathToFileUri(this.workspaceRoot), name: 'workspace' },
      ],
    });
    this.sendNotification('initialized', {});
  }

  /**
   * Tell the server about a file. Idempotent — re-opening a file is
   * treated as a content sync via didChange.
   */
  async openFile(filePath: string, content?: string): Promise<void> {
    if (this.state === 'disabled') return;
    if (this.state !== 'ready') {
      try {
        await this.start();
      } catch {
        return;
      }
    }
    if (this.state !== 'ready') return;

    const abs = path.resolve(this.workspaceRoot, filePath);
    let body = content;
    if (body === undefined) {
      try {
        body = await native.fs.readFile(abs);
      } catch {
        return;
      }
    }
    const existing = this.openDocuments.get(abs);
    if (existing) {
      // Treat as a content sync.
      const version = existing.version + 1;
      this.openDocuments.set(abs, { content: body, version });
      this.sendNotification('textDocument/didChange', {
        textDocument: { uri: pathToFileUri(abs), version },
        contentChanges: [{ text: body }],
      });
    } else {
      this.openDocuments.set(abs, { content: body, version: 1 });
      this.sendNotification('textDocument/didOpen', {
        textDocument: {
          uri: pathToFileUri(abs),
          languageId: languageIdFor(abs),
          version: 1,
          text: body,
        },
      });
    }
  }

  closeFile(filePath: string): void {
    if (this.state === 'disabled') return;
    const abs = path.resolve(this.workspaceRoot, filePath);
    if (!this.openDocuments.has(abs)) return;
    this.openDocuments.delete(abs);
    this.diagnostics.delete(abs);
    this.diagnosticsPublishedAt.delete(abs);
    this.sendNotification('textDocument/didClose', {
      textDocument: { uri: pathToFileUri(abs) },
    });
  }

  /**
   * Wait until the server publishes diagnostics for a recently-changed
   * file. typescript-language-server publishes async after didOpen /
   * didChange — there's no synchronous "give me current diagnostics"
   * call. We wait for a publish whose timestamp is strictly newer than
   * the pre-existing one, so re-syncing an already-open file doesn't
   * return instantly on a stale cache entry.
   */
  async waitForDiagnostics(filePath: string, timeoutMs = 1500): Promise<void> {
    if (this.state !== 'ready') return;
    const abs = path.resolve(this.workspaceRoot, filePath);
    const baselinePublishedAt = this.diagnosticsPublishedAt.get(abs) ?? 0;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const latest = this.diagnosticsPublishedAt.get(abs) ?? 0;
      if (latest > baselinePublishedAt) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** Get the diagnostics for a file (by relative or absolute path). */
  getDiagnostics(filePath: string): LspDiagnostic[] {
    const abs = path.resolve(this.workspaceRoot, filePath);
    return this.diagnostics.get(abs) ?? [];
  }

  /** Get all diagnostics across all open files, keyed by relative path. */
  getAllDiagnostics(): Record<string, LspDiagnostic[]> {
    const out: Record<string, LspDiagnostic[]> = {};
    for (const [abs, diags] of this.diagnostics) {
      out[path.relative(this.workspaceRoot, abs)] = diags;
    }
    return out;
  }

  /** Compute total error/warning counts across the project. */
  totals(): { errors: number; warnings: number } {
    let errors = 0;
    let warnings = 0;
    for (const diags of this.diagnostics.values()) {
      for (const d of diags) {
        if (d.severity === 'error') errors++;
        else if (d.severity === 'warning') warnings++;
      }
    }
    return { errors, warnings };
  }

  /**
   * Format diagnostics as a human-readable summary suitable for
   * injection into the LLM system prompt. If `relevantFiles` is
   * supplied, only those files' diagnostics are included; otherwise
   * all currently-known diagnostics are surfaced.
   *
   * Format mirrors what tsc --pretty=false emits: `path:line:col`
   * prefix, severity, message. The model has seen this shape millions
   * of times in pretraining.
   */
  formatSummary(
    opts: { relevantFiles?: string[]; maxLines?: number } = {},
  ): string {
    if (this.state !== 'ready') return '';
    const max = opts.maxLines ?? 50;
    const all = this.getAllDiagnostics();
    const filtered = opts.relevantFiles
      ? Object.fromEntries(
          opts.relevantFiles
            .map((f) =>
              path.relative(
                this.workspaceRoot,
                path.resolve(this.workspaceRoot, f),
              ),
            )
            .map((rel) => [rel, all[rel] ?? []]),
        )
      : all;
    const lines: string[] = [];
    for (const [file, diags] of Object.entries(filtered)) {
      for (const d of diags) {
        lines.push(
          `${file}:${d.line}:${d.column} ${d.severity}: ${d.message}` +
            (d.code !== undefined ? ` [${d.code}]` : ''),
        );
        if (lines.length >= max) break;
      }
      if (lines.length >= max) break;
    }
    if (lines.length === 0) return '';
    const totals = this.totals();
    const header = `# Current project diagnostics (${totals.errors} error${
      totals.errors === 1 ? '' : 's'
    }, ${totals.warnings} warning${totals.warnings === 1 ? '' : 's'})`;
    return `${header}\n${lines.join('\n')}`;
  }

  /**
   * Return the full diagnostic index keyed by absolute file path.
   * Used by the `lsp_diagnostics` tool to answer project-wide
   * queries without the tool having to know about relative-path
   * resolution. Callers that only want one file should use
   * `getDiagnostics(filePath)` instead.
   */
  diagnosticsIndex(): Map<string, LspDiagnostic[]> {
    return new Map(this.diagnostics);
  }

  /**
   * LSP `textDocument/references` request. Returns every location
   * in every open file that references the symbol at the given
   * document position. Used by the `lsp_references` tool to answer
   * "where is this symbol used" queries without the model having
   * to grep the repo.
   *
   * The LSP server only knows about files that have been openFile'd
   * first, so callers should open the file containing the cursor
   * position before invoking this. Returns an empty array on
   * non-ready state so the caller can degrade gracefully.
   */
  async findReferences(
    filePath: string,
    line: number,
    character: number,
  ): Promise<{ uri: string; line: number; character: number }[]> {
    if (this.state !== 'ready') {
      debug('findReferences skipped — state=', this.state);
      return [];
    }
    const abs = path.resolve(this.workspaceRoot, filePath);
    debug('findReferences →', {
      file: path.relative(this.workspaceRoot, abs),
      line,
      character,
      openDocs: this.openDocuments.size,
      language: this.language,
    });
    try {
      const result = (await this.sendRequest('textDocument/references', {
        textDocument: { uri: pathToFileUri(abs) },
        position: { line, character },
        context: { includeDeclaration: true },
      })) as
        | {
            uri: string;
            range: { start: { line: number; character: number } };
          }[]
        | null;
      debug('findReferences ←', {
        count: Array.isArray(result) ? result.length : 0,
        sample: Array.isArray(result)
          ? result.slice(0, 3).map((r) => ({
              file: path.relative(this.workspaceRoot, fileUriToPath(r.uri)),
              line: r.range.start.line + 1,
            }))
          : null,
      });
      if (!Array.isArray(result)) return [];
      return result.map((r) => ({
        uri: r.uri,
        line: r.range.start.line + 1,
        character: r.range.start.character + 1,
      }));
    } catch (err) {
      log('findReferences failed:', (err as Error).message);
      return [];
    }
  }

  /**
   * LSP `workspace/symbol` request. Searches the workspace index
   * for symbols matching a query string and returns their
   * locations. This is a pre-filter the `lsp_references` tool uses
   * to map a user-supplied symbol name to its definition position
   * before requesting references.
   */
  async workspaceSymbol(
    query: string,
  ): Promise<{ name: string; uri: string; line: number; character: number }[]> {
    if (this.state !== 'ready') return [];
    try {
      const result = (await this.sendRequest('workspace/symbol', {
        query,
      })) as
        | {
            name: string;
            location: {
              uri: string;
              range: { start: { line: number; character: number } };
            };
          }[]
        | null;
      if (!Array.isArray(result)) return [];
      return result.map((s) => ({
        name: s.name,
        uri: s.location.uri,
        line: s.location.range.start.line + 1,
        character: s.location.range.start.character + 1,
      }));
    } catch (err) {
      log('workspaceSymbol failed:', (err as Error).message);
      return [];
    }
  }

  /**
   * LSP `textDocument/implementation` request. For an interface or
   * abstract method at the cursor, returns every concrete class /
   * method that implements it. The grep tool's `mode: 'lsp-impls'`
   * uses this — the typical "who implements X?" question that takes
   * a junior engineer 5 minutes of grep walks.
   *
   * Returns an empty array when LSP isn't ready or the cursor isn't
   * on an implementable symbol.
   */
  async findImplementations(
    filePath: string,
    line: number,
    character: number,
  ): Promise<{ uri: string; line: number; character: number }[]> {
    if (this.state !== 'ready') return [];
    const abs = path.resolve(this.workspaceRoot, filePath);
    try {
      const result = (await this.sendRequest('textDocument/implementation', {
        textDocument: { uri: pathToFileUri(abs) },
        position: { line, character },
      })) as
        | {
            uri: string;
            range: { start: { line: number; character: number } };
          }[]
        | null;
      if (!Array.isArray(result)) return [];
      return result.map((r) => ({
        uri: r.uri,
        line: r.range.start.line + 1,
        character: r.range.start.character + 1,
      }));
    } catch (err) {
      log('findImplementations failed:', (err as Error).message);
      return [];
    }
  }

  /**
   * LSP `textDocument/definition` request. Resolves "where is the
   * symbol at <pos> declared?" for jump-to-definition. The grep
   * tool's `mode: 'lsp-defs'` exposes this for symbol-name lookups.
   *
   * Returns an empty array on non-ready state or when the cursor
   * isn't on a resolvable symbol.
   */
  async findDefinition(
    filePath: string,
    line: number,
    character: number,
  ): Promise<{ uri: string; line: number; character: number }[]> {
    if (this.state !== 'ready') return [];
    const abs = path.resolve(this.workspaceRoot, filePath);
    try {
      const result = (await this.sendRequest('textDocument/definition', {
        textDocument: { uri: pathToFileUri(abs) },
        position: { line, character },
      })) as
        | {
            uri: string;
            range: { start: { line: number; character: number } };
          }[]
        | {
            uri: string;
            range: { start: { line: number; character: number } };
          }
        | null;
      if (!result) return [];
      const arr = Array.isArray(result) ? result : [result];
      return arr.map((r) => ({
        uri: r.uri,
        line: r.range.start.line + 1,
        character: r.range.start.character + 1,
      }));
    } catch (err) {
      log('findDefinition failed:', (err as Error).message);
      return [];
    }
  }

  /**
   * LSP `textDocument/hover` request. Returns formatted markdown for
   * the symbol at the given position, or null if no info is available.
   */
  async hover(
    filePath: string,
    line: number,
    character: number,
  ): Promise<string | null> {
    if (this.state !== 'ready') return null;
    const abs = path.resolve(this.workspaceRoot, filePath);
    try {
      const result = (await this.sendRequest('textDocument/hover', {
        textDocument: { uri: pathToFileUri(abs) },
        position: { line, character },
      })) as {
        contents:
          | string
          | { kind?: string; value: string }
          | (string | { language?: string; value: string })[];
      } | null;
      if (!result?.contents) return null;
      const c = result.contents;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) {
        return c
          .map((item) => (typeof item === 'string' ? item : item.value))
          .filter(Boolean)
          .join('\n\n');
      }
      return c.value;
    } catch (err) {
      log('hover failed:', (err as Error).message);
      return null;
    }
  }

  /**
   * LSP `textDocument/rename` request. Returns a workspace edit listing
   * every change required to rename the symbol at the given position.
   * Empty array on failure or non-renameable symbol.
   */
  async rename(
    filePath: string,
    line: number,
    character: number,
    newName: string,
  ): Promise<
    {
      uri: string;
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
      newText: string;
    }[]
  > {
    if (this.state !== 'ready') return [];
    const abs = path.resolve(this.workspaceRoot, filePath);
    try {
      const result = (await this.sendRequest('textDocument/rename', {
        textDocument: { uri: pathToFileUri(abs) },
        position: { line, character },
        newName,
      })) as {
        changes?: Record<
          string,
          {
            range: {
              start: { line: number; character: number };
              end: { line: number; character: number };
            };
            newText: string;
          }[]
        >;
        documentChanges?: {
          textDocument: { uri: string };
          edits: {
            range: {
              start: { line: number; character: number };
              end: { line: number; character: number };
            };
            newText: string;
          }[];
        }[];
      } | null;
      if (!result) return [];
      const out: {
        uri: string;
        range: {
          start: { line: number; character: number };
          end: { line: number; character: number };
        };
        newText: string;
      }[] = [];
      if (result.documentChanges) {
        for (const dc of result.documentChanges) {
          for (const edit of dc.edits) {
            out.push({
              uri: dc.textDocument.uri,
              range: edit.range,
              newText: edit.newText,
            });
          }
        }
      } else if (result.changes) {
        for (const [uri, edits] of Object.entries(result.changes)) {
          for (const edit of edits) {
            out.push({ uri, range: edit.range, newText: edit.newText });
          }
        }
      }
      return out;
    } catch (err) {
      log('rename failed:', (err as Error).message);
      return [];
    }
  }

  /**
   * Tear down the current LSP child process and respawn fresh.
   * Used by the `lsp_restart` tool when the server gets wedged
   * (typescript-language-server occasionally refuses to recompute
   * diagnostics after a large refactor, and restarting shakes it
   * loose). Preserves no state — callers must re-openFile every
   * document they care about.
   */
  async restart(): Promise<void> {
    if (this.state === 'disabled') return;
    await this.shutdown();
    // Reset state so start() actually spawns a new process. shutdown()
    // sets state='closed' which start() treats as "nothing to do".
    this.state = 'initializing';
    this.initPromise = null;
    this.buffer = '';
    this.openDocuments.clear();
    this.diagnostics.clear();
    this.diagnosticsPublishedAt.clear();
    await this.start();
  }

  async shutdown(): Promise<void> {
    if (this.state === 'disabled' || this.state === 'closed') return;
    try {
      if (this.state === 'ready') {
        await this.sendRequest('shutdown', null).catch(() => undefined);
        this.sendNotification('exit', null);
      }
    } finally {
      this.state = 'closed';
      this.emitState('deleted');
      this.failAllPending(new Error('LSP shutting down'));
      if (this.proc) {
        try {
          this.proc.kill();
        } catch {
          /* ignore */
        }
        this.proc = null;
      }
      this.events.clear();
    }
  }

  // ── JSON-RPC framing ─────────────────────────────────────────────

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    if (!this.proc) {
      return Promise.reject(new Error('LSP not writable'));
    }
    const id = this.nextRequestId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.writeMessage(payload);
      // 5s safety timeout for any single request.
      const t = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`LSP request ${method} timed out`));
        }
      }, 5000);
      // Typed as a Node Timeout (has unref), but in the browser setTimeout returns
      // a number with no unref — keep the optional call as a real runtime guard.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      t.unref?.();
    });
  }

  private sendNotification(method: string, params: unknown): void {
    if (!this.proc) return;
    this.writeMessage({ jsonrpc: '2.0', method, params });
  }

  private writeMessage(message: unknown): void {
    const json = JSON.stringify(message);
    // Content-Length is a BYTE count — compute it byte-accurately even though
    // native.process.write takes a string, so the server frames our request
    // correctly (a wrong length desyncs the whole JSON-RPC stream).
    const byteLen = new TextEncoder().encode(json).length;
    const header = `Content-Length: ${byteLen}\r\n\r\n`;
    try {
      this.proc?.write(header);
      this.proc?.write(json);
    } catch (err) {
      log('writeMessage failed:', (err as Error).message);
    }
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;
    const { messages, rest } = parseMessages(this.buffer);
    this.buffer = rest;
    for (const raw of messages) this.handleMessage(raw);
  }

  private handleMessage(raw: string): void {
    let message: {
      id?: number;
      method?: string;
      result?: unknown;
      error?: { message: string };
      params?: unknown;
    };
    try {
      // JSON.parse returns `any`; `message` keeps its declared shape and every
      // field is read defensively below. This is the local tsserver subprocess's
      // LSP protocol, not untrusted external input.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      message = JSON.parse(raw);
    } catch (err) {
      log('Failed to parse LSP message:', (err as Error).message);
      return;
    }

    // Response to a request we sent.
    if (
      typeof message.id === 'number' &&
      (message.result !== undefined || message.error !== undefined)
    ) {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      }
      return;
    }

    // Notification from the server.
    if (message.method === 'textDocument/publishDiagnostics') {
      this.handlePublishDiagnostics(
        message.params as {
          uri: string;
          diagnostics: {
            range: { start: { line: number; character: number } };
            severity?: number;
            message: string;
            source?: string;
            code?: string | number;
          }[];
        },
      );
      return;
    }

    // Other notifications (window/showMessage, $/progress, etc) — log and ignore.
    if (
      message.method?.startsWith('window/') ||
      message.method?.startsWith('$/')
    ) {
      return;
    }
  }

  private handlePublishDiagnostics(params: {
    uri: string;
    diagnostics: {
      range: { start: { line: number; character: number } };
      severity?: number;
      message: string;
      source?: string;
      code?: string | number;
    }[];
  }): void {
    const filePath = fileUriToPath(params.uri);
    const diags: LspDiagnostic[] = params.diagnostics.map((d) => ({
      line: d.range.start.line + 1,
      column: d.range.start.character + 1,
      severity: SEVERITY_BY_NUM[d.severity ?? 1] ?? 'error',
      message: d.message,
      ...(d.source !== undefined ? { source: d.source } : {}),
      ...(d.code !== undefined ? { code: d.code } : {}),
    }));
    if (diags.length === 0) {
      this.diagnostics.delete(filePath);
    } else {
      this.diagnostics.set(filePath, diags);
    }
    this.diagnosticsPublishedAt.set(filePath, Date.now());
    this.emitState('updated', {
      file: path.relative(this.workspaceRoot, filePath),
      diagnostics: diags,
    });
  }

  private failAllPending(err: Error): void {
    for (const [id, pending] of this.pending) {
      pending.reject(err);
      this.pending.delete(id);
    }
  }
}

function languageIdFor(filePath: string): string {
  if (filePath.endsWith('.tsx')) return 'typescriptreact';
  if (filePath.endsWith('.ts')) return 'typescript';
  if (filePath.endsWith('.jsx')) return 'javascriptreact';
  if (
    filePath.endsWith('.js') ||
    filePath.endsWith('.mjs') ||
    filePath.endsWith('.cjs')
  )
    return 'javascript';
  if (filePath.endsWith('.json')) return 'json';
  return 'plaintext';
}
