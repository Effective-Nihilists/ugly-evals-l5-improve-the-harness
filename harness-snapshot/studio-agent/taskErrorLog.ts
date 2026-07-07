// Ships the coding-agent BACKGROUND TASK's console.error/warn to the app's own
// errorLog (POST /api/errorLogCaptureNoAuth → captureClientErrors → the project's
// Postgres/D1 `errorLog`), mirroring the browser client's Logger.
//
// Why this exists: the task runs as a SEPARATE Node child (coding-task.ts) that
// installs createNodeUglyNative but NOT ugly-app's browser Logger — so its
// console.error was previously lost (not in the electron-*.log file, not in
// errorLog). That made agent-loop failures on the host invisible, and made
// multi-machine debugging (mobile driving the task over the Ugly Proxy) hard.
// Self-contained: Node `fetch` only, fully fail-safe (telemetry must never crash
// the task). Entries are tagged `source: 'coding-task'` so they're filterable
// from browser rows in the same errorLog.

interface Entry {
  level: string;
  message: string;
  stack?: string;
  url: string;
  timestamp: number;
  source: string;
  type: 'console';
}

const MAX_LOGS = 50;
const MAX_SEND = 200;
const FLUSH_MS = 2000;

let installed = false;

function stringifyArg(a: unknown): string {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return `${a.message}${a.stack ? `\n${a.stack}` : ''}`;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

/**
 * Patch console + process handlers to ship error/warn to the app's errorLog.
 * `origin` is the app origin (e.g. https://code.ugly.bot); a falsy origin or a
 * runtime without `fetch` makes this a no-op. Idempotent.
 */
export function installTaskErrorLog(opts: { origin: string; sessionId: string; source?: string }): void {
  if (installed) return;
  const origin = (opts.origin || '').replace(/\/$/, '');
  if (!origin || typeof fetch !== 'function') return;
  installed = true;

  const url = `${origin}/api/errorLogCaptureNoAuth`;
  const pageUrl = `${origin}/?session=${encodeURIComponent(opts.sessionId)}`;
  const source = opts.source ?? 'coding-task';
  const consoleBuffer: { timestamp: number; level: string; message: string }[] = [];
  const sendBuffer: Entry[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let flushing = false;

  const flush = async (): Promise<void> => {
    if (flushing || sendBuffer.length === 0) return;
    flushing = true;
    const entries = sendBuffer.splice(0, 50);
    const logs = consoleBuffer.slice(-MAX_LOGS);
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: { entries, logs } }),
        keepalive: true,
      });
    } catch {
      /* fire-and-forget — never block or throw on telemetry */
    } finally {
      flushing = false;
    }
  };
  const schedule = (): void => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, FLUSH_MS);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- setTimeout returns a bare number (no unref) in browser-like task runtimes
    timer.unref?.();
  };

  const record = (level: string, args: unknown[]): void => {
    try {
      const message = args.map(stringifyArg).join(' ').slice(0, 8000);
      if (!message) return;
      const ts = Date.now();
      consoleBuffer.push({ timestamp: ts, level, message });
      if (consoleBuffer.length > MAX_LOGS) consoleBuffer.shift();
      if (level === 'error' || level === 'warn') {
        const errArg = args.find((x): x is Error => x instanceof Error);
        if (sendBuffer.length < MAX_SEND) {
          sendBuffer.push({
            level,
            message,
            ...(errArg?.stack ? { stack: errArg.stack } : {}),
            url: pageUrl,
            timestamp: ts,
            source,
            type: 'console',
          });
        }
        schedule();
      }
    } catch {
      /* never throw from a logging path */
    }
  };

  // Wrap console: capture all levels for the rolling `logs` context snapshot,
  // ship only error/warn as their own errorLog rows (matches the browser Logger).
  const wrap = (level: 'log' | 'info' | 'debug' | 'warn' | 'error'): void => {
    const orig = (console[level] as (...a: unknown[]) => void).bind(console);
    console[level] = (...args: unknown[]): void => {
      orig(...args);
      record(level, args);
    };
  };
  (['log', 'info', 'debug', 'warn', 'error'] as const).forEach(wrap);

  // A dead IPC channel (ERR_IPC_CHANNEL_CLOSED / "channel closed") is a NORMAL task
  // shutdown — the host closes our channel to stop us, and a late heartbeat send()
  // then throws asynchronously. It is NOT a real error. Logging it shipped ~1 row
  // per task teardown to errorLog, flooding it (400+ rows) and burying genuine
  // failures. Skip it here, mirroring taskRunner.mjs's isChannelClosed shutdown path.
  const isChannelClosed = (e: unknown): boolean => {
    const err = e as { code?: string; message?: string } | null;
    return !!err && (err.code === 'ERR_IPC_CHANNEL_CLOSED' || /channel closed/i.test(err.message ?? ''));
  };
  const proc = (globalThis as { process?: NodeJS.Process }).process;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a browser-shimmed `process` may expose no `.on`
  proc?.on?.('uncaughtException', (err: Error) => {
    if (isChannelClosed(err)) return; // clean shutdown, not a fault — don't flood errorLog
    record('error', [`[coding-task] uncaughtException: ${err.message}`, err]);
    void flush();
  });
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a browser-shimmed `process` may expose no `.on`
  proc?.on?.('unhandledRejection', (reason: unknown) => {
    if (isChannelClosed(reason)) return; // clean shutdown, not a fault
    record('error', [
      `[coding-task] unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`,
      ...(reason instanceof Error ? [reason] : []),
    ]);
    void flush();
  });
}
