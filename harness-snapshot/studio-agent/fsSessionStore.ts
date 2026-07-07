// Filesystem SessionStore for the CLI: ~/.ugly-code/session/<id>/{metadata.json,messages.jsonl}.
// native.fs has no append, so we rewrite messages.jsonl each call (mirrors sessionLog.ts).
import { native } from 'ugly-app/native';
import type { SessionStore } from './sessionStore';
import type { StoredMessageRow, SessionListRow } from './serverSessionApi';

interface StoredRowFull extends StoredMessageRow { id: string }

function sessionDir(root: string, sessionId: string): string {
  return `${root}/${sessionId.replace(/[^a-zA-Z0-9_.:-]/g, '_')}`;
}

// native.fs has no append, so every mutation is a read-modify-write of the whole
// file. Concurrent mutations (multiple persist calls in flight during a dense
// multi-step turn) would interleave and clobber rows, so serialize all mutations
// per session dir through a promise chain.
const writeChains = new Map<string, Promise<unknown>>();
function serialize<T>(dir: string, op: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(dir) ?? Promise.resolve();
  const next = prev.then(op, op);
  writeChains.set(dir, next.catch(() => undefined));
  return next;
}

async function readRows(dir: string): Promise<StoredRowFull[]> {
  try {
    const raw = await native.fs.readFile(`${dir}/messages.jsonl`);
    return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as StoredRowFull);
  } catch {
    return [];
  }
}

async function writeRows(dir: string, rows: StoredRowFull[]): Promise<void> {
  await native.fs.mkdir(dir, true);
  await native.fs.writeFile(`${dir}/messages.jsonl`, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

export function makeFsSessionStore(root: string): SessionStore {
  return {
    upsert(i) {
      const dir = sessionDir(root, i.sessionId);
      return serialize(dir, async () => {
        await native.fs.mkdir(dir, true);
        let prev: Record<string, unknown> = {};
        try { prev = JSON.parse(await native.fs.readFile(`${dir}/metadata.json`)) as Record<string, unknown>; } catch { /* first */ }
        const next = { ...prev, ...i, updated: Date.now(), created: (prev.created as number | undefined) ?? Date.now() };
        await native.fs.writeFile(`${dir}/metadata.json`, JSON.stringify(next, null, 2));
        return { ok: true };
      });
    },
    appendMessage(i) {
      const dir = sessionDir(root, i.sessionId);
      return serialize(dir, async () => {
        const rows = await readRows(dir);
        rows.push({ id: `${i.sessionId}:${i.seq}`, seq: i.seq, role: i.role, kind: 'message', compacted: false, content: i.content });
        await writeRows(dir, rows);
        return { ok: true };
      });
    },
    compact(i) {
      const dir = sessionDir(root, i.sessionId);
      return serialize(dir, async () => {
        const rows = await readRows(dir);
        for (const r of rows) if (i.droppedIds.includes(r.id)) r.compacted = true;
        rows.push({ id: i.summaryId, seq: i.summarySeq, role: 'user', kind: 'summary', compacted: false, content: JSON.stringify(i.summaryText) });
        rows.sort((a, b) => a.seq - b.seq || Number(a.kind === 'summary') - Number(b.kind === 'summary'));
        await writeRows(dir, rows);
        return { ok: true };
      });
    },
    async listMessages(i) {
      const rows = await readRows(sessionDir(root, i.sessionId));
      const filtered = (i.includeCompacted ? rows : rows.filter((r) => !r.compacted)).sort((a, b) => a.seq - b.seq);
      const limited = i.limit ? filtered.slice(-i.limit) : filtered;
      return { messages: limited.map(({ id: _id, ...m }) => m) };
    },
    // Single-session CLI runs don't need a sidebar list.
    list(_i): Promise<{ sessions: SessionListRow[] } | null> {
      return Promise.resolve({ sessions: [] });
    },
    archive(_i) {
      return Promise.resolve({ ok: true });
    },
    clearMessages(i) {
      const dir = sessionDir(root, i.sessionId);
      return serialize(dir, async () => {
        const n = (await readRows(dir)).length;
        await writeRows(dir, []);
        return { ok: true, deleted: n };
      });
    },
  };
}
