// The session-persistence seam. `sessionApi` (serverSessionApi.ts) delegates
// here so the surface (studio → server, CLI → filesystem) can be swapped without
// touching the agent loop. The server impl is registered as the default.
import type { StoredRole, StoredMessageRow, SessionListRow } from './serverSessionApi';

export interface SessionStore {
  upsert(i: {
    sessionId: string;
    projectId: string;
    title?: string;
    kind?: 'main' | 'session';
    model?: string;
    status?: 'running' | 'idle' | 'done' | 'error';
    messageCount?: number;
    costUsd?: number;
    // Cumulative token usage, persisted so analyzeRun/scorecards can report
    // cache-hit rate + tokens (the CLI fs store keeps these; the server store
    // may ignore them). Optional — not every agent path tracks tokens.
    promptTokens?: number;
    completionTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  }): Promise<{ ok: boolean } | null>;
  appendMessage(i: { sessionId: string; seq: number; role: StoredRole; content: string }): Promise<{ ok: boolean } | null>;
  compact(i: { sessionId: string; droppedIds: string[]; summaryId: string; summarySeq: number; summaryText: string }): Promise<{ ok: boolean } | null>;
  listMessages(i: { sessionId: string; limit?: number; includeCompacted?: boolean }): Promise<{ messages: StoredMessageRow[] } | null>;
  list(i: { projectId: string }): Promise<{ sessions: SessionListRow[] } | null>;
  archive(i: { sessionId: string }): Promise<{ ok: boolean } | null>;
  clearMessages(i: { sessionId: string }): Promise<{ ok: boolean; deleted: number } | null>;
}

let activeStore: SessionStore | undefined;
export function setSessionStore(s: SessionStore): void { activeStore = s; }
export function getSessionStore(): SessionStore {
  if (!activeStore) throw new Error('session store not initialised');
  return activeStore;
}
