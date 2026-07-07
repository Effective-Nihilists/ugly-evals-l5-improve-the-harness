/**
 * The COMPLETE, uncompacted, append-only coding-session log on local disk.
 *
 * Hard requirement: ugly-code persists the ENTIRE session history to the local
 * FS so it has everything and is NOT affected by compaction. Compaction only
 * shrinks the working context the model sees; this log keeps every original
 * event verbatim — it's the artifact used to analyze a reported issue and
 * improve the harness, and the canonical record for resume.
 *
 * native.fs has no append, so we keep the JSONL in memory and rewrite the whole
 * file after each event (sessions are small; correctness > IO). Writes are
 * best-effort: a logging failure must never break the agent loop.
 */

import { native } from 'ugly-app/native';

export interface SessionLogEntry {
  ts: number;
  type:
    | 'session_start'
    | 'user'
    | 'assistant'
    | 'tool_result'
    | 'telemetry'
    | 'compaction'
    | 'error'
    | 'finish';
  [k: string]: unknown;
}

export class SessionLog {
  private readonly lines: string[] = [];
  private dir: string | null = null;
  private file: string | null = null;
  private ensured = false;

  constructor(
    private readonly sessionId: string,
    projectPath: string | null,
  ) {
    if (projectPath) {
      this.dir = `${projectPath}/.ugly-studio/sessions`;
      // Sanitize the sessionId for a filename (compositeIds contain ':').
      const safe = sessionId.replace(/[^a-zA-Z0-9_.-]/g, '_');
      this.file = `${this.dir}/${safe}.jsonl`;
    }
  }

  /** Append one event and flush the full log to disk (best-effort). */
  append(entry: SessionLogEntry): void {
    this.lines.push(JSON.stringify(entry));
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (!this.file || !this.dir) return;
    try {
      if (!this.ensured) {
        await native.fs.mkdir(this.dir, true);
        this.ensured = true;
      }
      await native.fs.writeFile(this.file, this.lines.join('\n') + '\n');
    } catch {
      /* logging is best-effort — never break the loop */
    }
  }

  /** The on-disk path (for the issue-report bundle), or null in non-native runtimes. */
  path(): string | null {
    return this.file;
  }
}
