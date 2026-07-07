/**
 * Claude Code CLI runner — an alternative coding-agent backend that drives the
 * user's LOCAL `claude` binary over the native bridge (instead of routing model
 * calls through ugly.bot's /api/agentTurn). Per-turn spawn with stream-json I/O:
 *
 *   claude --print --output-format stream-json --input-format stream-json \
 *          --verbose --include-partial-messages \
 *          (--session-id <uuid> | --resume <uuid>) [--model <tier>] \
 *          --dangerously-skip-permissions
 *
 * Conversation continuity is the CLI's own (it persists a transcript on disk and
 * rehydrates via --resume). We ALSO persist each message to the project's Neon
 * backend so the session shows in the list + replays on reload (reusing the same
 * row format + transforms as the in-process agent). Yolo only (skip-permissions,
 * the CLI's built-in tools); no MCP bridge in this port.
 */

import { native } from 'ugly-app/native';
import type { ContentPart } from 'ugly-app/agent/client';
import { getActiveProjectPath } from '../hooks/useSocket';
import { assistantParts, type Part } from './sessionDisplay';
import {
  sessionApi,
  resolveProjectId,
  type StoredRole,
  type ToolResultPayload,
} from './serverSessionApi';
import { detectClaudeCli } from './claudeCliDetect';
import { ensureSessionWorkspace } from './sessionWorkspace';

type Emit = (msg: { type: string; [k: string]: unknown }) => void;

const rid = (): string => 'msg_' + Math.random().toString(36).slice(2, 11);
const uuid = (): string =>
  ((): string => {
    try { return crypto.randomUUID(); } catch { /* fall through */ }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.floor(Math.random() * 16));
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  })();

/** Map a studio model id → the CLI `--model` tier (or null for the default). */
function cliModelFlag(model: string): string | null {
  if (model.startsWith('claude-code:')) return model.slice('claude-code:'.length);
  return null; // 'claude-code' / 'claude-cli' → default tier
}

interface ClaudeState {
  claudeUuid: string;
  started: boolean;
  emit: Emit;
  proc: ReturnType<typeof native.process.spawn> | null;
  // streaming: map a CLI message id → the studio bubble id (partial updates).
  bubbleByMsgId: Map<string, string>;
  // persistence
  projectId: string;
  seq: number;
  seqSeeded: boolean;
  title: string;
  cost: number;
  messageCount: number;
}

const sessions = new Map<string, ClaudeState>();
const uuidKey = (sid: string): string => `ugly-studio:claudeUuid:${sid}`;

function getState(sessionId: string, emit: Emit): ClaudeState {
  const existing = sessions.get(sessionId);
  if (existing) { existing.emit = emit; return existing; }
  let claudeUuid: string;
  let started = false;
  try {
    const saved = localStorage.getItem(uuidKey(sessionId));
    if (saved) { claudeUuid = saved; started = true; }
    else { claudeUuid = uuid(); localStorage.setItem(uuidKey(sessionId), claudeUuid); }
  } catch {
    claudeUuid = uuid();
  }
  const state: ClaudeState = {
    claudeUuid, started, emit, proc: null, bubbleByMsgId: new Map(),
    projectId: '', seq: 0, seqSeeded: false, title: '', cost: 0, messageCount: 0,
  };
  sessions.set(sessionId, state);
  return state;
}

function emitMessage(emit: Emit, sessionId: string, role: string, parts: Part[], opts: { id?: string; action?: 'created' | 'updated'; model?: string } = {}): void {
  try {
    emit({
      type: 'codingAgent:event',
      sessionId,
      event: { type: 'message', payload: { type: opts.action ?? 'created', payload: {
        id: opts.id ?? rid(), role, parts, created_at: Date.now(), ...(opts.model ? { model: opts.model } : {}),
      } } },
    });
  } catch (e) { console.error('[claudeCli] emit failed', e); }
}

function emitFinished(emit: Emit, sessionId: string): void {
  try {
    emit({ type: 'codingAgent:event', sessionId, event: { type: 'agent_event', payload: { payload: { type: 'agent_finished' } } } });
  } catch { /* ignore */ }
}

/** Append a transcript row (best-effort) — display + session list on reload. */
function persistRow(s: ClaudeState, sessionId: string, role: StoredRole, payload: unknown): void {
  const seq = s.seq++;
  void sessionApi.appendMessage({ sessionId, seq, role, content: JSON.stringify(payload) });
}

function persistMeta(s: ClaudeState, sessionId: string, model: string, status: 'running' | 'idle' | 'error'): void {
  if (!s.projectId) return;
  void sessionApi.upsert({ sessionId, projectId: s.projectId, title: s.title, model, status, messageCount: s.messageCount, costUsd: s.cost });
}

/** Whether this is a Claude Code CLI model id. */
export function isClaudeCliModel(model: string | null | undefined): boolean {
  return !!model && (model === 'claude-cli' || model === 'claude-code' || model.startsWith('claude-code:'));
}

/** Run one turn of the local Claude CLI for `sessionId`. */
export async function runClaudeCliTurn(sessionId: string, userText: string, model: string, emit: Emit): Promise<void> {
  const projectPath = getActiveProjectPath();
  const bin = await detectClaudeCli(projectPath);
  if (!bin) {
    emitMessage(emit, sessionId, 'assistant', [
      { type: 'text', data: { text: '⚠ The Claude CLI was not found. Install it (`claude`) and ensure it is on your PATH.' } },
      { type: 'finish' },
    ]);
    emitFinished(emit, sessionId);
    return;
  }

  const s = getState(sessionId, emit);
  if (!s.projectId) s.projectId = await resolveProjectId(projectPath);
  // Seed the persistence seq from existing rows once (so reload appends continue).
  if (!s.seqSeeded) {
    s.seqSeeded = true;
    const existing = await sessionApi.listMessages({ sessionId, limit: 2000, includeCompacted: true });
    const maxSeq = (existing?.messages ?? []).reduce((m, r) => Math.max(m, r.seq), -1);
    s.seq = maxSeq + 1;
    if ((existing?.messages.length ?? 0) > 0) s.started = true;
  }
  if (!s.title) s.title = userText.slice(0, 120);

  // Provision the isolated workspace (worktree + deps) before spawning claude;
  // it runs its built-in tools in this cwd. Streams setup progress into the chat.
  let wsProgressCreated = false;
  const wsProgressId = rid();
  const ws = await ensureSessionWorkspace(sessionId, projectPath, (stage, text) => {
    const label = stage === 'creating' ? 'Setting up isolated workspace' : stage === 'installing' ? 'Installing dependencies' : stage === 'ready' ? 'Workspace ready' : 'Workspace';
    emitMessage(emit, sessionId, 'assistant', [{ type: 'text', data: { text: `${label}\n\n${text}` } }, { type: 'finish' }], { id: wsProgressId, action: wsProgressCreated ? 'updated' : 'created' });
    wsProgressCreated = true;
  });
  const cwd = ws.dir !== '' ? ws.dir : (projectPath ?? '');

  s.messageCount += 1;
  persistRow(s, sessionId, 'user', userText);
  persistMeta(s, sessionId, model, 'running');

  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    s.started ? '--resume' : '--session-id', s.claudeUuid,
    '--dangerously-skip-permissions',
  ];
  const tier = cliModelFlag(model);
  if (tier) args.push('--model', tier);

  await new Promise<void>((resolve) => {
    let buffer = '';
    let proc: ReturnType<typeof native.process.spawn>;
    try {
      proc = native.process.spawn(bin, args, {
        ...(cwd ? { cwd } : {}),
        ...((ws.port || ws.databaseUrl) ? { env: {
          ...(ws.port ? { PORT: String(ws.port) } : {}),
          ...(ws.databaseUrl ? { DATABASE_URL: ws.databaseUrl } : {}),
        } } : {}),
      });
    } catch (e) {
      console.error('[claudeCliAgent:spawn]', JSON.stringify({ sessionId, bin, model, cwd, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined);
      emitMessage(emit, sessionId, 'assistant', [{ type: 'text', data: { text: '⚠ Failed to spawn claude: ' + String(e) } }, { type: 'finish' }]);
      emitFinished(emit, sessionId);
      resolve();
      return;
    }
    s.proc = proc;
    s.bubbleByMsgId = new Map();

    const finish = (): void => {
      s.started = true;
      s.proc = null;
      persistMeta(s, sessionId, model, 'idle');
      emitFinished(emit, sessionId);
      resolve();
    };

    proc.onStdout((chunk) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let ev: ClaudeEvent;
        try { ev = JSON.parse(line) as ClaudeEvent; } catch { continue; }
        handleEvent(s, sessionId, model, ev);
        if (ev.type === 'result') {
          try { proc.closeStdin(); } catch { /* ignore */ }
        }
      }
    });
    proc.onError((err) => {
      emitMessage(emit, sessionId, 'assistant', [{ type: 'text', data: { text: '⚠ claude error: ' + err } }, { type: 'finish' }]);
      persistMeta(s, sessionId, model, 'error');
    });
    proc.onExit(() => { finish(); });

    // Send the user message as a stream-json frame.
    try {
      proc.write(JSON.stringify({ type: 'user', message: { role: 'user', content: userText } }) + '\n');
    } catch (e) {
      console.error('[claudeCliAgent:write-user-message]', JSON.stringify({ sessionId, model, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined);
      emitMessage(emit, sessionId, 'assistant', [{ type: 'text', data: { text: '⚠ Failed to write to claude: ' + String(e) } }, { type: 'finish' }]);
      finish();
    }
  });
}

export function abortClaudeCli(sessionId: string): void {
  const s = sessions.get(sessionId);
  try { s?.proc?.kill(); } catch { /* ignore */ }
}

// ── stream-json event handling ───────────────────────────────────────────────

interface ClaudeBlock { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown }
interface ClaudeEvent {
  type: string;
  subtype?: string;
  message?: { id?: string; role?: string; model?: string; content?: ClaudeBlock[] };
  total_cost_usd?: number;
}

function handleEvent(s: ClaudeState, sessionId: string, model: string, ev: ClaudeEvent): void {
  if (ev.type === 'assistant' && ev.message) {
    const content = (ev.message.content ?? []).filter((b) => b.type === 'text' || b.type === 'tool_use') as ContentPart[];
    if (content.length === 0) return;
    const msgId = ev.message.id ?? rid();
    let bubble = s.bubbleByMsgId.get(msgId);
    const action: 'created' | 'updated' = bubble ? 'updated' : 'created';
    if (!bubble) { bubble = rid(); s.bubbleByMsgId.set(msgId, bubble); }
    emitMessage(s.emit, sessionId, 'assistant', assistantParts(content), { id: bubble, action, model });
    if (action === 'created') {
      s.messageCount += 1;
      persistRow(s, sessionId, 'assistant', { content, model });
    }
  } else if (ev.type === 'user' && ev.message) {
    // tool_result blocks coming back from the CLI's built-in tools.
    const results: ToolResultPayload[] = [];
    for (const b of ev.message.content ?? []) {
      if (b.type !== 'tool_result') continue;
      const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
      const isError = /^Error/i.test(text);
      emitMessage(s.emit, sessionId, 'tool', [{ type: 'tool_result', data: { tool_call_id: b.tool_use_id, content: text, is_error: isError } }]);
      results.push({ tool_use_id: b.tool_use_id ?? '', content: text, is_error: isError });
    }
    if (results.length > 0) { s.messageCount += 1; persistRow(s, sessionId, 'tool', { results }); }
  } else if (ev.type === 'result') {
    if (typeof ev.total_cost_usd === 'number') s.cost += ev.total_cost_usd;
  } else if (ev.type === 'error') {
    emitMessage(s.emit, sessionId, 'assistant', [{ type: 'text', data: { text: '⚠ ' + (ev.subtype ?? 'claude error') } }, { type: 'finish' }]);
  }
}
