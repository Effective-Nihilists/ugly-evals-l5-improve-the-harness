/**
 * Phase 4 — the coding agent as a thin ADAPTER over the standardized framework
 * loop (`ugly-app/agent`). Runs CLIENT-SIDE over window.UglyNative; the model
 * call goes to the project's own `/api/agentTurn` (the framework agent handler);
 * tools execute locally over native.fs / native.process.
 *
 * It maps the framework runAgent's callbacks onto the studio chat's existing
 * `codingAgent:event` protocol (unchanged), and additionally:
 *   - establishes per-turn token/cost TELEMETRY in the chat (a `session_state`
 *     snapshot — best-effort, wrapped so a consumer error can't break the loop),
 *   - writes the COMPLETE, uncompacted session history to a local FS JSONL log
 *     (`<project>/.ugly-studio/sessions/<sessionId>.jsonl`) — the debug artifact,
 *     unaffected by compaction.
 */

import {
  runAgent,
  emptyTelemetryTotals,
  type AgentController,
  type AgentMessage,
  type MsgTelemetry,
  type RunAgentSocket,
} from 'ugly-app/agent/client';
import { dispatchTool, isUglyAppProject, killSessionBashProcs } from '../../agent/tools';
import { registeredToolSpecs } from '../../agent/tools/registry';
import { sessionToolSpecs } from '../../agent/tools/gating';
import { discoverSkills, formatAvailableSkills } from '../hooks/skillDiscovery';
import type { StepFn } from '../../agent/engine';
import {
  AGENT_TOOL_NAMES,
  AGENT_SYSTEM_PROMPT,
  AGENT_DEFAULT_MODEL,
} from '../../../shared/agent';
import { getActiveProjectPath } from '../projectPath';
import { SessionLog } from './sessionLog';
import {
  sessionApi,
  resolveProjectId,
  planCompaction,
  reconstructResumeContext,
  type ActiveRow,
  type StoredRole,
  type ToolResultPayload,
  type ToolRowPayload,
} from './serverSessionApi';
import { assistantParts, type Part } from './sessionDisplay';
import { ensureSessionWorkspace, getSessionWorkspace, removeSessionWorkspace } from './sessionWorkspace';
import type { ToolName } from '../../../shared/agent';
import { getPattern } from './patterns/registry';
import { decorateForStep, renderStepDecoration, filterToolsForStep } from './patterns/decorate';
import { type Step, type Pattern, type PatternId, isPatternId, isSuperPattern, superToBasePattern } from './patterns/types';
import { deriveCriteria, gradeAgainstCriteria, buildRevisePrompt, type Judge } from './patterns/judge';
import { classifyForAuto, isClassificationConfident } from './patterns/classify';
import { runMidFanout } from './patterns/mid-mode-host';
import { runMaxMode } from './patterns/max-mode-host';
import { runGroupMode } from './patterns/group-mode-host';
import { awaitStepReview, rejectStepReviewsForSession } from './stepReviewBroker';
import { native } from 'ugly-app/native';
import { getCodingAgentModels } from 'ugly-app/shared';
import { filterToolsByToolset, type Toolset } from './toolsets';
import { spawnCollect } from '../../agent/tools/spawn';

// Per-session toolset override (e.g. the CLI's `--toolset no-python` A/B). Read by
// the live `tools` getter; set before the first turn. Session-scoped map so it
// survives independent of the SessionAgentState lifecycle.
const toolsetBySession = new Map<string, Toolset>();
export function setSessionToolset(sessionId: string, toolset: Toolset): void {
  toolsetBySession.set(sessionId, toolset);
}

// Eval-session marker. The SBV criteria-grader judge (derive rubric → grade the
// BUILD diff → REVISE) is a MEASUREMENT mechanism, not something to impose on
// every user turn — it only runs for sessions triggered from the eval flow (the
// CLI, or the studio eval popup). Normal studio SBV sessions advance on natural
// stop with no grader. Mirrors the monolith's eval-session gate (SessionSnapshot.eval).
const evalSessions = new Set<string>();
export function setSessionEval(sessionId: string, isEval: boolean): void {
  if (isEval) evalSessions.add(sessionId); else evalSessions.delete(sessionId);
}

// Per-session agent-step budget override. The interactive default is 12 (a
// per-message cap so a chat turn can't run away), but an eval must honor the
// TASK's declared budget.maxTurns — a long-horizon task (e.g. the 80-turn ORM
// migration) was being cut off at turn 12, so deepseek/glm never finished while
// claude-cli (its own loop) ran freely. Set before the first turn; default 12.
const maxTurnsBySession = new Map<string, number>();
export function setSessionMaxTurns(sessionId: string, maxTurns: number): void {
  if (Number.isFinite(maxTurns) && maxTurns > 0) maxTurnsBySession.set(sessionId, Math.floor(maxTurns));
}

/** No-tools LLM completion for the criteria grader — the same governed,
 *  metered /api/agentStep endpoint the main loop + delegate use. */
const agentStepJudge: Judge = async (system, user, maxTokens = 512) => {
  const res = await fetch('/api/agentStep', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    // noTools → clean completion (no injected agent system prompt, no tools) so the
    // judge/classifier get exactly the JSON/prose their own prompt asks for.
    body: JSON.stringify({ input: { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], noTools: true, maxTokens } }),
  });
  const json = (await res.json()) as { result?: { message?: { content?: unknown } }; error?: string };
  if (json.error) throw new Error(json.error);
  const content = json.result?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b as { text?: string }).text ?? '').join('');
  return '';
};

// ── Always-on agent-loop debug telemetry ────────────────────────────────────
// Every session streams a structured event log to
// ~/.ugly-code/session/<id>/debug.jsonl (turn timing, tokens, stream errors +
// how long the request ran before failing, retries, compaction). This is the
// diagnostic surface: when a run fails (e.g. `proxy stream: operation aborted`),
// the log shows WHERE and HOW LONG — so failures are root-caused from telemetry
// rather than reproduced. Extend `debugLog(...)` call sites as new questions arise.
const debugEvents = new Map<string, Record<string, unknown>[]>();
const debugClock = new Map<string, { start: number; last: number }>();
function debugTick(sessionId: string): { sinceStartMs: number; sinceLastMs: number } {
  const now = Date.now();
  const c = debugClock.get(sessionId) ?? { start: now, last: now };
  const r = { sinceStartMs: now - c.start, sinceLastMs: now - c.last };
  c.last = now;
  debugClock.set(sessionId, c);
  return r;
}
function debugLog(sessionId: string, kind: string, data: Record<string, unknown> = {}): void {
  try {
    const arr = debugEvents.get(sessionId) ?? [];
    arr.push({ ts: Date.now(), kind, ...data });
    debugEvents.set(sessionId, arr);
    const home = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.HOME ?? '.';
    const dir = `${home}/.ugly-code/session/${sessionId.replace(/[^a-zA-Z0-9_.:-]/g, '_')}`;
    void native.fs
      .mkdir(dir, true)
      .then(() => native.fs.writeFile(`${dir}/debug.jsonl`, arr.map((e) => JSON.stringify(e)).join('\n') + '\n'))
      .catch(() => { /* debug logging must never break a run */ });
  } catch { /* never throw from telemetry */ }
}

/** The session's uncommitted diff vs the baseline commit (the agent's edits). */
async function sessionGitDiff(dir: string | null): Promise<string> {
  if (!dir) return '';
  try { return (await spawnCollect('git', ['-C', dir, 'diff', 'HEAD'], {})).stdout; } catch { return ''; }
}

const MAX_REVISE = 2;
import type { ReasoningEffort, SessionSnapshot } from '../shared/api';
import { composeSessionSnapshot, type PerModelAcc } from './sessionSnapshot';
export { composeSessionSnapshot };
import { startCodebasePoll, stopCodebasePoll, fetchArchitectureDoc } from './codebaseReadiness';

type Emit = (msg: { type: string; [k: string]: unknown }) => void;

/**
 * The user-controlled session axes the chat header surfaces. The client agent
 * runs a single CONCRETE model — it has no auto-router / pattern engine — so
 * `modelMode` and `patternMode` are passthrough state: it must echo the user's
 * picks back in every `session_state` snapshot or the chat header silently
 * resets them each turn (picked deepseek_v4_flash → flipped to sonnet; pattern
 * "none" → flipped to "auto"). Plumbed in from useSocket via the coding task.
 */
export interface AgentSelection {
  model?: string;
  reasoningEffort?: ReasoningEffort;
  permissionMode?: SessionSnapshot['permissionMode'];
  modelMode?: SessionSnapshot['modelMode'];
  patternMode?: SessionSnapshot['patternMode'];
}

const rid = (): string => 'msg_' + Math.random().toString(36).slice(2, 11);

/** A socket shim: the framework loop's requests go to the project's /api/*. */
const fetchSocket: RunAgentSocket = {
  async request(name, input, opts) {
    const res = await fetch('/api/' + name, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ input }),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
    const json = (await res.json()) as { result?: unknown; error?: string };
    if (json.error) throw new Error(json.error);
    return json.result;
  },
  // No hub/trackDocs over the native bridge — instead we stream the agent's
  // frames over the agentTurn HTTP response (the framework's SSE mode). Each
  // `data:` line is an agent frame; a terminal `__result__`/`__error__` frame
  // carries the authoritative turn. runAgent prefers this when present.
  async requestStream(name, input, onFrame, opts) {
    const res = await fetch('/api/' + name, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      credentials: 'include',
      body: JSON.stringify({ input }),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
    if (!res.ok || !res.body) {
      // Fall back to the buffered turn if streaming isn't available.
      const json = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string };
      if (json.error) throw new Error(json.error);
      return json.result;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let result: unknown;
    let gotResult = false;
    let done = false;
    while (!done) {
      const { value, done: rdone } = await reader.read();
      if (rdone) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trimStart();
        if (!data) continue;
        let frame: { type?: string; result?: unknown; error?: string };
        try {
          frame = JSON.parse(data) as typeof frame;
        } catch {
          continue;
        }
        if (frame.type === '__result__') {
          result = frame.result;
          gotResult = true;
          done = true;
          break;
        }
        if (frame.type === '__error__') {
          throw new Error(frame.error ?? 'agent turn failed');
        }
        onFrame(frame);
      }
    }
    // The stream ended without a terminal frame → the SSE response was cut mid-turn
    // (server/edge closed the long-lived connection). Fail loudly instead of
    // returning `undefined`, which the runAgent loop would deref as
    // `resp.content` → a cryptic "Cannot read properties of undefined". A clear
    // error routes through the normal error/retry path.
    if (!gotResult) {
      throw new Error('agent stream ended without a result (connection cut mid-turn)');
    }
    return result;
  },
  trackDocs: () => () => {/* noop */},
};

// Per-session tool handlers. They resolve the session's workspace at CALL time:
// a worktree-isolated session runs its fs ops + run_command in its own worktree
// dir (with its PORT), while the main session falls back to the open project
// (relative paths pass through, unchanged behavior). getSessionWorkspace is sync
// (cached); ensureSessionWorkspace runs once up-front per session (see below).
function makeToolHandlers(sessionId: string): Record<string, (input: unknown) => Promise<string>> {
  // Core tools (legacy inline switch) + every registered tool — both dispatch
  // through dispatchTool, which routes the registry first.
  const names = [...AGENT_TOOL_NAMES, ...registeredToolSpecs().map((s) => s.name)];
  return Object.fromEntries(
    names.map((n) => [
      n,
      (input: unknown) => {
        const ws = getSessionWorkspace(sessionId);
        const dir = ws?.isWorktree ? ws.dir : getActiveProjectPath();
        return dispatchTool(n, input, {
          sessionId,
          projectDir: dir,
          // Carry the session's real permission axis to the daemon SandboxMode
          // (read live — this closure runs at tool-call time, after the state is
          // registered) so the axis actually affects the runtime: 'yolo' skips the
          // sandbox, 'edit' applies the normal edit-mode ACL. Previously hardcoded
          // 'edit', so 'yolo' had no effect for in-process (ugly.bot) sessions.
          mode: sessions.get(sessionId)?.permissionMode ?? 'edit',
          // Model-call for subagents (delegate/agent): one turn via the same
          // agentStep endpoint the main loop uses.
          step: ((req: unknown) =>
            fetchSocket.request('agentStep', req)) as unknown as StepFn,
          ...(ws?.isWorktree ? { workspaceDir: ws.dir } : {}),
          ...(ws?.port ? { port: ws.port } : {}),
          ...(ws?.databaseUrl ? { databaseUrl: ws.databaseUrl } : {}),
        });
      },
    ]),
  );
}

interface SessionAgentState {
  controller: AgentController;
  emitRef: { current: Emit };
  log: SessionLog;
  // Cumulative telemetry across the session (for the chat header + sidebar).
  cost: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  messageCount: number;
  perModel: Map<string, PerModelAcc>;
  createdAt: number;
  // Live-streaming state for the in-flight assistant turn: the stable bubble id
  // (null until the first token) + accumulated text, so onText updates one
  // message in place and onTurn finalizes it.
  streamMsgId: string | null;
  streamText: string;
  // ── Server persistence (survive reload) ──
  // Append-only transcript bookkeeping: `seq` is the next row index; `activeRows`
  // is the ordered set of currently-uncompacted rows ({seq,id}) — it MUST mirror
  // runAgent's working-context message order so compaction drops the same window.
  seq: number;
  activeRows: ActiveRow[];
  projectId: string;
  title: string;
  titleSet: boolean;
  resumed: boolean;
  /** The first user message (the task), pinned verbatim into every compaction
   *  summary so the original instruction is never lost to the context window. */
  taskText: string;
  // ── User-selected axes (drive the run + echoed in every session_state) ──
  // `model` is authoritative for the runAgent loop (read live each turn via a
  // getter on its config); the rest are passthrough state the header reads back.
  model: string;
  reasoningEffort: ReasoningEffort;
  permissionMode: SessionSnapshot['permissionMode'];
  modelMode: SessionSnapshot['modelMode'];
  patternMode: SessionSnapshot['patternMode'];
  /** The active step during a pattern-driven turn (null otherwise). Read by
   *  the live `tools` getter to gate the model's tool list per step. */
  currentStep: Step | null;
  /** The resolved pattern id for the current/last turn (post-classifier, may be
   *  a `super-*` id). Echoed in `session_state` so PatternStrip renders the strip. */
  resolvedPattern: SessionSnapshot['resolvedPattern'];
  /** Revise-iteration index within the active step (0-based). Echoed to the UI. */
  currentStepIter: number;
  /** Parked `pauseForUserReviewAfter` gates awaiting the user's approve/iterate
   *  reply. Echoed in `session_state` so the IDE renders the StepReviewCard. */
  pendingStepReviews: SessionSnapshot['pendingStepReviews'];
}

// Codebase analysis (semantic index + architecture doc) runs per SESSION, decoupled from the
// agent controller, so the header pill tracks indexing the moment the session task BOOTS — not
// on the first turn (the old coupling left a freshly-opened session's pill stuck on "loading"
// until the user sent a message, which never happens if they're waiting for it to be "ready").
// Keyed by sessionId; lives for the task process. See `ensureCodebaseAnalysis`.
const codebaseReadinessBySession = new Map<string, SessionSnapshot['codebaseReadiness']>();
const architectureDocBySession = new Map<string, string>();
// Rendered <available_skills> block per session (discovered once, async, then
// read synchronously by the systemPrompt getter — mirrors architectureDoc).
const skillsBlockBySession = new Map<string, string>();
function ensureSkillsDiscovered(sessionId: string): void {
  if (skillsBlockBySession.has(sessionId)) return;
  skillsBlockBySession.set(sessionId, formatAvailableSkills([])); // seed so the getter never blocks
  void discoverSkills()
    .then((skills) => skillsBlockBySession.set(sessionId, formatAvailableSkills(skills)))
    .catch(() => { /* best-effort — keep the empty block */ });
}

// Is the open project an ugly-app project? Resolved once (async) per session,
// then read synchronously by the `tools` getter (default false until resolved)
// to gate the UGLY_APP tool set — mirrors the skills/architecture pattern.
const uglyAppBySession = new Map<string, boolean>();
function ensureUglyAppFlag(sessionId: string): void {
  if (uglyAppBySession.has(sessionId)) return;
  const ws = getSessionWorkspace(sessionId);
  const dir = (ws?.isWorktree ? ws.dir : getActiveProjectPath()) ?? '';
  if (!dir) return; // no project yet — re-resolved on a later turn
  uglyAppBySession.set(sessionId, false); // seed so the getter never blocks
  void isUglyAppProject(dir)
    .then((v) => uglyAppBySession.set(sessionId, v))
    .catch(() => { /* best-effort — treat as not-ugly-app */ });
}

/** Fold a (partial) user selection onto the session state. Called on create and
 *  on every subsequent turn so a mid-session model/mode swap takes effect. */
function applySelection(s: SessionAgentState, sel?: AgentSelection): void {
  if (!sel) return;
  if (sel.model) s.model = sel.model;
  if (sel.reasoningEffort) s.reasoningEffort = sel.reasoningEffort;
  if (sel.permissionMode) s.permissionMode = sel.permissionMode;
  if (sel.modelMode) s.modelMode = sel.modelMode;
  if (sel.patternMode) s.patternMode = sel.patternMode;
}

// composeSessionSnapshot moved to ./sessionSnapshot (shared with the renderer's
// getCodingAgentSnapshot); re-exported above.

/**
 * Build the compaction summary. Compaction replaces the oldest turns with this
 * text in the model's working context, so it MUST carry forward (a) the original
 * task verbatim and (b) a log of what was already done — otherwise a long session
 * forgets its goal. Structural (no extra AI call): the task + a bulleted trail of
 * the assistant's text + tool calls from the dropped turns.
 */
function mechanicalSummary(taskText: string, dropped: AgentMessage[]): string {
  const trail: string[] = [];
  for (const m of dropped) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === 'text' && b.text?.trim()) {
        trail.push(`• ${b.text.trim().replace(/\s+/g, ' ').slice(0, 200)}`);
      } else if (b.type === 'tool_use') {
        const arg =
          typeof b.input === 'object' && b.input
            ? (Object.values(b.input as Record<string, unknown>).find((v) => typeof v === 'string'))
            : undefined;
        trail.push(`• ran ${b.name}${arg ? `(${arg.slice(0, 80)})` : ''}`);
      }
    }
  }
  const parts = ['[Earlier turns were compacted to stay within the context window.]'];
  if (taskText) parts.push(`\nOriginal task:\n${taskText.slice(0, 1000)}`);
  if (trail.length) parts.push(`\nWork done so far (most recent last):\n${trail.slice(-50).join('\n')}`);
  return parts.join('\n');
}

/** Render dropped turns (assistant text + tool CALLS + tool RESULTS) into a transcript
 *  for the summariser — capped so the summary call itself stays small. The old
 *  mechanical trail logged only WHICH tools ran, dropping every result; this keeps the
 *  results (test failures, file contents read, command output) that the summary needs. */
function renderDropped(dropped: AgentMessage[]): string {
  const lines: string[] = [];
  for (const m of dropped) {
    if (!Array.isArray(m.content)) {
      if (typeof m.content === 'string' && m.content.trim()) lines.push(`${m.role.toUpperCase()}: ${m.content.trim().slice(0, 600)}`);
      continue;
    }
    for (const b of m.content as Record<string, unknown>[]) {
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        lines.push(`${m.role === 'assistant' ? 'ASSISTANT' : 'NOTE'}: ${b.text.trim().slice(0, 600)}`);
      } else if (b.type === 'tool_use') {
        lines.push(`TOOL_CALL ${String(b.name)}: ${JSON.stringify(b.input ?? {}).slice(0, 300)}`);
      } else if (b.type === 'tool_result') {
        const c = b.content;
        const s = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x as { text?: string }).text ?? '').join('') : JSON.stringify(c ?? '');
        if (s.trim()) lines.push(`TOOL_RESULT: ${s.trim().slice(0, 900)}`);
      }
    }
  }
  const out = lines.join('\n');
  return out.length > 44_000 ? out.slice(-44_000) : out; // keep most-recent if huge
}

/** Content-preserving compaction: an LLM condenses the dropped turns into a dense
 *  summary that keeps the FINDINGS (reference material read, discoveries), what was
 *  tried and WHY it failed, current file state, and next steps — not just a log of
 *  which tools ran. The old mechanical trail dropped every tool result, so a model
 *  that had read a library's source or gathered debug findings lost them on
 *  compaction (observed: glm re-reading its file in a stuck loop). Falls back to the
 *  mechanical trail if the summariser call fails. */
async function buildCompactionSummary(taskText: string, dropped: AgentMessage[], judge: Judge): Promise<string> {
  const transcript = renderDropped(dropped);
  if (!transcript.trim()) return mechanicalSummary(taskText, dropped);
  const system =
    'You compress an in-progress coding-agent session so it can continue after the older turns below are removed from its context. Write a DENSE, CONCRETE summary that preserves everything needed to keep working WITHOUT the removed turns: ' +
    '(1) key facts / reference material the agent discovered (relevant file contents, API/algorithm details, regexes, specific values) — quote the important bits; ' +
    '(2) what it tried and the OUTCOME — which tests/checks fail and the SPECIFIC error or reason; ' +
    '(3) files created/modified and their current state; ' +
    '(4) the concrete next steps / remaining plan. ' +
    'Omit greetings and narration. Prefer specifics (names, numbers, error messages) over generalities. Output only the summary.';
  const user = `## Original task\n${taskText.slice(0, 2000)}\n\n## Session so far (oldest first) — compress this:\n${transcript}`;
  try {
    const s = (await judge(system, user, 3000)).trim();
    return s ? `[Earlier turns were compacted into this summary.]\n\n${s}` : mechanicalSummary(taskText, dropped);
  } catch (e) {
    console.error('[compaction] LLM summary failed; using mechanical fallback', e instanceof Error ? e.message : String(e));
    return mechanicalSummary(taskText, dropped);
  }
}

// Model context windows (from the catalog) → a model-aware compaction threshold.
const modelCtxWindow = new Map<string, number>();
function contextWindowFor(model: string | undefined): number {
  if (!model) return 128_000;
  if (modelCtxWindow.size === 0) {
    try { for (const m of getCodingAgentModels()) modelCtxWindow.set(m.id, m.contextWindow); } catch { /* fall back to default */ }
  }
  return modelCtxWindow.get(model) ?? 128_000;
}
/** Compact well below the model's real window (leaving response headroom), capped
 *  for cost/latency. Fixes premature compaction of large-window models: glm/deepseek
 *  have ~1M windows, but the old flat 120k compacted the VERBOSE one (glm) at ~11% of
 *  capacity, throwing away reference material + debug findings mid-task. */
function compactionThreshold(model: string | undefined): number {
  const RESPONSE_MARGIN = 48_000, FLOOR = 96_000;
  const CEILING = Number(process.env.UGLY_MAX_CONTEXT ?? 400_000);
  return Math.max(FLOOR, Math.min(contextWindowFor(model) - RESPONSE_MARGIN, CEILING));
}

const sessions = new Map<string, SessionAgentState>();

function safeEmit(emit: Emit, msg: { type: string; [k: string]: unknown }): void {
  try {
    emit(msg);
  } catch (e) {
    console.error('[clientAgent] emit failed (ignored)', e);
  }
}

function emitMessage(
  emit: Emit,
  sessionId: string,
  role: string,
  parts: Part[],
  opts: { id?: string; action?: 'created' | 'updated'; model?: string } = {},
): void {
  safeEmit(emit, {
    type: 'codingAgent:event',
    sessionId,
    event: {
      type: 'message',
      payload: {
        type: opts.action ?? 'created',
        // `model` (when known) drives the per-message model badge in the chat.
        payload: {
          id: opts.id ?? rid(),
          role,
          parts,
          created_at: Date.now(),
          ...(opts.model ? { model: opts.model } : {}),
        },
      },
    },
  });
}


// ── Server persistence helpers (all best-effort; never break the loop) ───────

/** Append one transcript row + track its seq/id for the compaction window. */
function persistRow(s: SessionAgentState, sessionId: string, role: StoredRole, payload: unknown): string {
  const seq = s.seq++;
  const id = `${sessionId}:${seq}`;
  s.activeRows.push({ seq, id });
  void sessionApi.appendMessage({ sessionId, seq, role, content: JSON.stringify(payload) });
  return id;
}

/**
 * Persist a compaction structurally: flag the oldest `droppedCount` active rows
 * compacted + insert one summary row at the dropped block's seq. Mirrors
 * runAgent's in-loop `[summary, ...recent]` exactly, so the server's "normal"
 * query == the model's post-compaction working context (no re-compaction on
 * reload). Summary `_id`/seq reuse the boundary seq → idempotent across reloads.
 */
function persistCompaction(s: SessionAgentState, sessionId: string, droppedCount: number, summaryText: string): void {
  const plan = planCompaction(s.activeRows, droppedCount, sessionId);
  if (!plan) return;
  s.activeRows = plan.newActiveRows;
  void sessionApi.compact({
    sessionId,
    droppedIds: plan.droppedIds,
    summaryId: plan.summaryId,
    summarySeq: plan.summarySeq,
    summaryText,
  });
}

/** Upsert the session metadata row (title/status/tokens/cost). */
function persistMeta(s: SessionAgentState, sessionId: string, status: 'running' | 'idle' | 'done' | 'error'): void {
  if (!s.projectId) return;
  void sessionApi.upsert({
    sessionId,
    projectId: s.projectId,
    title: s.title,
    model: s.model,
    status,
    messageCount: s.messageCount,
    costUsd: s.cost,
    promptTokens: s.promptTokens,
    completionTokens: s.completionTokens,
    cacheReadTokens: s.cacheReadTokens,
    cacheCreationTokens: s.cacheCreationTokens,
  });
}

/**
 * Lazily reconstruct a prior session into the live controller on the first turn
 * after a reload. Loads the "normal" transcript (compaction excluded) — which is
 * exactly runAgent's post-compaction working context — and seeds it via
 * controller.resume so the next turn continues with full context, no recompaction.
 */
async function ensureResumed(s: SessionAgentState, sessionId: string): Promise<void> {
  if (s.resumed) return;
  s.resumed = true;
  s.projectId = await resolveProjectId(getActiveProjectPath());
  const data = await sessionApi.listMessages({ sessionId, limit: 2000 });
  const rows = data?.messages ?? [];
  if (rows.length === 0) return; // brand-new session — nothing to resume
  // Restore cumulative metadata so the next persistMeta doesn't regress the
  // stored messageCount/costUsd (the in-memory accumulators restart at 0).
  const listed = await sessionApi.list({ projectId: s.projectId });
  const meta = listed?.sessions.find((x) => x.sessionId === sessionId);
  if (meta) {
    s.messageCount = meta.messageCount;
    s.cost = meta.costUsd;
    if (meta.title) {
      s.title = meta.title;
      s.titleSet = true;
    }
  }
  const { messages, activeRows, nextSeq } = reconstructResumeContext(rows, sessionId);
  s.activeRows = activeRows;
  s.seq = nextSeq;
  s.titleSet = true; // a resumed session already has its title
  // Restore the pinned task so post-reload compaction still preserves it: the
  // first user row, or (if already compacted) parsed back out of the summary.
  if (!s.taskText) {
    const firstUser = rows.find((r) => r.role === 'user' && r.kind === 'message');
    if (firstUser) {
      try { s.taskText = String(JSON.parse(firstUser.content)); } catch { /* ignore */ }
    } else {
      const summaryRow = rows.find((r) => r.kind === 'summary');
      if (summaryRow) {
        try {
          const m = /Original task:\n([\s\S]*?)(?:\n\n|$)/.exec(String(JSON.parse(summaryRow.content)));
          if (m) s.taskText = m[1];
        } catch { /* ignore */ }
      }
    }
  }

  // (Row→message mapping + interrupted-ending healing now live in
  // reconstructResumeContext above, so they're unit-tested.)
  try {
    await s.controller.resume({
      sessionId,
      model: s.model,
      messages,
      status: 'idle',
      updatedAt: Date.now(),
      telemetryTotals: emptyTelemetryTotals(),
    });
  } catch (e) {
    // Resume is best-effort context seeding — a failure must NOT swallow the
    // user's turn. Log and continue; the send below still runs.
    console.error('[clientAgent] resume failed (continuing without prior context)', e);
  }
}

/** Fold one turn's usage into the session accumulators. */
function accrue(s: SessionAgentState, t: MsgTelemetry): void {
  const model = t.model ?? s.model;
  const input = t.inputTokens ?? 0;
  const output = t.outputTokens ?? 0;
  const cacheRead = t.cacheReadTokens ?? 0;
  const cacheCreation = t.cacheCreationTokens ?? 0;
  const cost = t.costUsd ?? 0;
  s.cost += cost;
  s.promptTokens += input;
  s.completionTokens += output;
  s.cacheReadTokens += cacheRead;
  s.cacheCreationTokens += cacheCreation;
  const pm = s.perModel.get(model) ?? {
    model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 0, turnCount: 0,
  };
  pm.inputTokens += input;
  pm.outputTokens += output;
  pm.cacheReadTokens += cacheRead;
  pm.cacheCreationTokens += cacheCreation;
  pm.cost += cost;
  pm.turnCount += 1;
  s.perModel.set(model, pm);
}

/**
 * Emit a `session_state` snapshot so the chat header + session sidebar show
 * live tokens/cost (today they read 0). Non-token fields mirror the chat hook's
 * initial defaults so we change ONLY the telemetry (no clobbering); the whole
 * thing is best-effort via safeEmit.
 */
function emitTelemetry(s: SessionAgentState, sessionId: string): void {
  const snap = composeSessionSnapshot({
    sessionId,
    cwd: getActiveProjectPath() ?? '',
    createdAt: s.createdAt,
    updatedAt: Date.now(),
    model: s.model,
    reasoningEffort: s.reasoningEffort,
    permissionMode: s.permissionMode,
    modelMode: s.modelMode,
    patternMode: s.patternMode,
    resolvedPattern: s.resolvedPattern,
    currentStepId: s.currentStep?.id ?? null,
    currentStepIter: s.currentStepIter,
    pendingStepReviews: s.pendingStepReviews,
    cost: s.cost,
    promptTokens: s.promptTokens,
    completionTokens: s.completionTokens,
    cacheReadTokens: s.cacheReadTokens,
    cacheCreationTokens: s.cacheCreationTokens,
    perModel: [...s.perModel.values()],
    messageCount: s.messageCount,
  });
  // Fold in the latest codebase readiness (the indexer poll updates the per-session map and
  // re-emits) so every session_state carries it too — applySnapshot only reads what's present.
  const readiness = codebaseReadinessBySession.get(sessionId);
  if (readiness !== undefined) snap.codebaseReadiness = readiness;
  safeEmit(s.emitRef.current, {
    type: 'codingAgent:event',
    sessionId,
    event: { type: 'session_state', payload: { payload: snap } },
  });
}

/**
 * Start (idempotently) the host's semantic index + architecture analysis for this session's
 * project and stream readiness to the viewer as a standalone `codebase_readiness` event.
 *
 * Called BOTH at task boot (coding-task) and from getOrCreate, so the header's codebase pill
 * tracks indexing whether or not the user has sent a turn yet. `startCodebasePoll` is keyed by
 * sessionId and no-ops if already running, so the two call sites can't double-poll.
 *
 * The event carries ONLY readiness (never a full session_state snapshot): a boot-time snapshot
 * would zero-out cost/tokens and clobber a resumed session's live telemetry header while the
 * indexer runs. session_state still folds readiness in during turns (emitTelemetry) for the
 * mount-snapshot path.
 */
export function ensureCodebaseAnalysis(sessionId: string, emit: Emit): void {
  const cwd = getActiveProjectPath() ?? '';
  // Worktree-isolated sessions reconcile their overlay against disk once ready.
  const ws = getSessionWorkspace(sessionId);
  const worktreeRoot = ws?.isWorktree ? ws.dir : undefined;
  startCodebasePoll(sessionId, cwd, (r) => {
    codebaseReadinessBySession.set(sessionId, r as SessionSnapshot['codebaseReadiness']);
    safeEmit(emit, {
      type: 'codingAgent:event',
      sessionId,
      event: { type: 'codebase_readiness', payload: { payload: r } },
    });
    // Once the architecture doc is ready, fetch it once (injected via the systemPrompt getter).
    if (!architectureDocBySession.has(sessionId) && r.architecture?.status === 'ready') {
      void fetchArchitectureDoc(cwd).then((doc) => {
        if (doc) architectureDocBySession.set(sessionId, doc);
      });
    }
  }, worktreeRoot);
}

function getOrCreate(sessionId: string, emit: Emit, selection?: AgentSelection, opts?: { peer?: boolean }): SessionAgentState {
  const existing = sessions.get(sessionId);
  if (existing) {
    existing.emitRef.current = emit;
    applySelection(existing, selection);
    return existing;
  }
  const emitRef = { current: emit };
  const state: SessionAgentState = {
    controller: undefined as unknown as AgentController,
    emitRef,
    log: new SessionLog(sessionId, getActiveProjectPath()),
    cost: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    messageCount: 0,
    perModel: new Map(),
    createdAt: Date.now(),
    streamMsgId: null,
    streamText: '',
    seq: 0,
    activeRows: [],
    projectId: '',
    title: '',
    titleSet: false,
    resumed: false,
    taskText: '',
    // Selection defaults — overwritten by `selection` (and any subsequent
    // turn's selection) via applySelection. Default to the framework model so a
    // session that somehow arrives without a pick still runs.
    model: AGENT_DEFAULT_MODEL,
    reasoningEffort: 'medium',
    permissionMode: 'edit',
    modelMode: { kind: 'auto' },
    patternMode: 'auto',
    currentStep: null,
    resolvedPattern: null,
    currentStepIter: 0,
    pendingStepReviews: [],
  };
  applySelection(state, selection);
  state.log.append({ ts: Date.now(), type: 'session_start', sessionId, model: state.model });

  // Kick off (idempotently) the host's semantic index + architecture doc and stream readiness
  // to the header pill. Also runs at task boot (coding-task) so the pill fills in BEFORE the
  // first turn — see ensureCodebaseAnalysis. Peer sub-sessions (model axis) skip this: they run
  // vanilla and share the parent's project, so re-indexing per peer is wasteful.
  if (!opts?.peer) {
    ensureCodebaseAnalysis(sessionId, emitRef.current);
    ensureSkillsDiscovered(sessionId);
    ensureUglyAppFlag(sessionId);
  }

  state.controller = runAgent({
    socket: fetchSocket,
    sessionId,
    // Live getter: runAgent reads `config.model` afresh on every turn request,
    // so a mid-session model swap (applySelection on the next send) takes effect
    // without rebuilding the controller. This is what actually routes the turn
    // to the user's pick (e.g. deepseek_v4_flash) instead of the default.
    get model() {
      return state.model;
    },
    // Live getter (read per turn, like model): once the host's architecture analysis is
    // ready we fetch ARCHITECTURE.md and append it as a codebase map, so the agent gets
    // structural context up front without spending turns reading files.
    get systemPrompt() {
      const architectureDoc = architectureDocBySession.get(sessionId);
      const base = architectureDoc
        ? `${AGENT_SYSTEM_PROMPT}\n\n# Project architecture (auto-generated map — exports, types, inheritance)\n\n${architectureDoc}`
        : AGENT_SYSTEM_PROMPT;
      // Real per-turn <env> (replaces the monolith's hardcoded sample block).
      const ws = getSessionWorkspace(sessionId);
      const cwd = (ws?.isWorktree ? ws.dir : getActiveProjectPath()) ?? '(no project open)';
      const env = `<env>\nWorking directory: ${cwd}\nToday's date: ${new Date().toISOString().slice(0, 10)}\n</env>`;
      // Dynamic <available_skills> (discovered once per session; see below).
      const skillsBlock = skillsBlockBySession.get(sessionId) ?? formatAvailableSkills([]);
      return `${base.replace('{{AVAILABLE_SKILLS}}', skillsBlock)}\n\n${env}`;
    },
    // Static per-session gating (read afresh each turn): COMMON + single/group
    // mode set + the ugly-app project set (when applicable) + feature gates —
    // the monolith's model. `modelMode.kind` of 'auto' resolves to single mode.
    get tools() {
      const mode = state.modelMode.kind === 'group' ? 'group' : 'single';
      const isUglyApp = uglyAppBySession.get(sessionId) ?? false;
      // Gate to the current SBV step's allow-list (no-op when no pattern step is
      // active), then apply any session toolset override (e.g. --toolset no-python).
      const stepGated = filterToolsForStep(sessionToolSpecs({ mode, isUglyApp }), state.currentStep);
      return filterToolsByToolset(stepGated, toolsetBySession.get(sessionId));
    },
    toolHandlers: makeToolHandlers(sessionId),
    budget: { maxTurns: maxTurnsBySession.get(sessionId) ?? 12 },
    // Pin the task + a work-log into every summary so a long session never loses
    // its original instruction (the system prompt is sent separately and is never
    // compacted; this preserves the user's goal across compactions).
    compaction: {
      maxContextTokens: compactionThreshold(state.model),
      keepRecentTurns: 8,
      summarize: (dropped) => buildCompactionSummary(state.taskText, dropped, agentStepJudge),
    },
    // Live token streaming: create the assistant bubble on the first token, then
    // update it in place as text arrives (onTurn finalizes it authoritatively).
    onText: (_msgId, delta) => {
      state.streamText += delta;
      const parts: Part[] = [{ type: 'text', data: { text: state.streamText } }];
      if (!state.streamMsgId) {
        state.streamMsgId = rid();
        emitMessage(emitRef.current, sessionId, 'assistant', parts, { id: state.streamMsgId, action: 'created' });
      } else {
        emitMessage(emitRef.current, sessionId, 'assistant', parts, { id: state.streamMsgId, action: 'updated' });
      }
    },
    onTurn: (turn, telemetry) => {
      const content = Array.isArray(turn.content)
        ? turn.content
        : [{ type: 'text' as const, text: turn.content }];
      // The model that produced this turn — drives the per-message badge.
      const model = telemetry?.model;
      const modelOpt = model ? { model } : {};
      // Finalize the streamed bubble in place (same id) when we streamed text;
      // otherwise (tool-only turn) emit a fresh bubble.
      if (state.streamMsgId) {
        emitMessage(emitRef.current, sessionId, 'assistant', assistantParts(content), {
          id: state.streamMsgId,
          action: 'updated',
          ...modelOpt,
        });
      } else {
        emitMessage(emitRef.current, sessionId, 'assistant', assistantParts(content), modelOpt);
      }
      state.streamMsgId = null;
      state.streamText = '';
      state.messageCount += 1;
      state.log.append({ ts: Date.now(), type: 'assistant', content, ...(telemetry ? { telemetry } : {}) });
      // Persist the assistant turn verbatim (one row, matches one working-context
      // message) — content + model so the badge survives reload.
      persistRow(state, sessionId, 'assistant', { content, ...modelOpt });
      if (telemetry) {
        accrue(state, telemetry);
        state.log.append({ ts: Date.now(), type: 'telemetry', telemetry });
        emitTelemetry(state, sessionId);
      }
      persistMeta(state, sessionId, 'running');
      const clk = debugTick(sessionId);
      debugLog(sessionId, 'turn', {
        turnMs: clk.sinceLastMs, // wall-time of this model turn (since prior activity)
        model: telemetry?.model ?? state.model,
        contentChars: JSON.stringify(content).length,
        toolCalls: content.filter((b) => b.type === 'tool_use').length,
        ...(telemetry ? { inputTokens: telemetry.inputTokens, outputTokens: telemetry.outputTokens, cacheReadTokens: telemetry.cacheReadTokens, costUsd: telemetry.costUsd } : {}),
        msgCount: state.messageCount,
      });
    },
    onEvent: (e) => {
      if (e.type === 'tool_result') {
        // Emit ONE studio message per result (live UI is unchanged), but persist
        // ALL of a turn's results as ONE row — runAgent folds them into a single
        // working-context message, so the server transcript must too (keeps the
        // compaction seq-mapping exact).
        const bundle: ToolResultPayload[] = [];
        for (const r of e.results) {
          if (r.type !== 'tool_result') continue;
          const content = r.content;
          const isError = content.startsWith('Error:');
          emitMessage(emitRef.current, sessionId, 'tool', [
            { type: 'tool_result', data: { tool_call_id: r.tool_use_id, content, is_error: isError } },
          ]);
          state.messageCount += 1;
          state.log.append({ ts: Date.now(), type: 'tool_result', tool_use_id: r.tool_use_id, content, is_error: isError });
          bundle.push({ tool_use_id: r.tool_use_id, content, is_error: isError });
        }
        if (bundle.length > 0) {
          persistRow(state, sessionId, 'tool', { results: bundle } satisfies ToolRowPayload);
        }
      } else if (e.type === 'compaction') {
        state.log.append({ ts: Date.now(), type: 'compaction', droppedCount: e.droppedCount, ...(e.summary ? { summary: e.summary } : {}) });
        debugLog(sessionId, 'compaction', { droppedCount: e.droppedCount, summaryChars: e.summary?.length ?? 0, promptTokens: state.promptTokens, cacheReadTokens: state.cacheReadTokens });
        if (e.summary) persistCompaction(state, sessionId, e.droppedCount, e.summary);
      } else if (e.type === 'error') {
        console.error('[clientAgent:error]', sessionId, e.message);
        // KEY diagnostic: how long the failing request ran before erroring
        // (sinceLastMs), the total session age, and the error text — this is what
        // distinguishes a fixed-duration timeout/abort from a transient blip.
        const clk = debugTick(sessionId);
        debugLog(sessionId, 'error', { message: e.message, ranMsBeforeError: clk.sinceLastMs, sessionAgeMs: clk.sinceStartMs, model: state.model, msgCount: state.messageCount, promptTokens: state.promptTokens });
        emitMessage(emitRef.current, sessionId, 'assistant', [
          { type: 'text', data: { text: '⚠ ' + e.message } },
          { type: 'finish' },
        ]);
        state.log.append({ ts: Date.now(), type: 'error', message: e.message });
      }
      if (e.type === 'done' || e.type === 'error' || e.type === 'aborted' || e.type === 'budget_exceeded') {
        if (e.type !== 'error') debugLog(sessionId, 'finish', { reason: e.type, ...debugTick(sessionId) });
        state.log.append({ ts: Date.now(), type: 'finish', reason: e.type });
        persistMeta(state, sessionId, e.type === 'error' ? 'error' : 'idle');
        safeEmit(emitRef.current, {
          type: 'codingAgent:event',
          sessionId,
          event: { type: 'agent_event', payload: { payload: { type: 'agent_finished', reason: e.type } } },
        });
      }
    },
  });

  sessions.set(sessionId, state);
  return state;
}

/**
 * Provision the session's isolated workspace before its first turn, streaming
 * worktree-create + dependency-install progress into the chat as one updating
 * bubble. Resolves immediately for the main session (no worktree) or once cached.
 */
async function ensureWorkspaceStep(sessionId: string, emit: Emit): Promise<void> {
  if (getSessionWorkspace(sessionId)) return; // already provisioned
  const progressId = rid();
  let created = false;
  const label: Record<string, string> = {
    creating: 'Setting up isolated workspace',
    installing: 'Installing dependencies',
    ready: 'Workspace ready',
    error: 'Workspace',
  };
  await ensureSessionWorkspace(sessionId, getActiveProjectPath(), (stage, text) => {
    emitMessage(
      emit,
      sessionId,
      'assistant',
      [{ type: 'text', data: { text: `${label[stage] ?? 'Workspace'}\n\n${text}` } }, { type: 'finish' }],
      { id: progressId, action: created ? 'updated' : 'created' },
    );
    created = true;
  });
}

/** Run one user turn to completion (model ↔ tools), streaming studio events. */
export async function runClientAgentTurn(
  sessionId: string,
  userText: string,
  emit: Emit,
  selection?: AgentSelection,
): Promise<void> {
  const state = getOrCreate(sessionId, emit, selection);
  // Provision the session's isolated workspace (worktree + deps install) before
  // the first turn so the agent's tools operate in it. Streams progress into the
  // chat; a no-op for the main session (runs on the project) or once cached.
  await ensureWorkspaceStep(sessionId, emit);
  // On the first turn after a reload, rebuild the prior context into the live
  // controller before sending (no-op for a brand-new session).
  await ensureResumed(state, sessionId);
  state.messageCount += 1;
  state.log.append({ ts: Date.now(), type: 'user', text: userText });
  debugLog(sessionId, 'send', { textChars: userText.length, model: state.model, msgCount: state.messageCount, maxContextTokens: compactionThreshold(state.model), ...debugTick(sessionId) });
  if (!state.taskText) state.taskText = userText; // pin the original task for summaries
  if (!state.titleSet) {
    state.title = userText.slice(0, 120);
    state.titleSet = true;
  }
  const userMsgId = persistRow(state, sessionId, 'user', userText);
  // Emit the user prompt as a task event so OTHER devices viewing this session render it
  // live. Only assistant + tool messages were emitted, so a remote viewer saw the replies
  // with no prompt above them. Uses the persisted row id, so a later history reload dedupes;
  // the sender already shows an optimistic bubble and its reconciliation adopts this id.
  emitMessage(emit, sessionId, 'user', [{ type: 'text', data: { text: userText } }], {
    id: userMsgId,
    action: 'created',
  });
  persistMeta(state, sessionId, 'running');
  // Resolve the pattern axis: `none` → plain single-send; an explicit PatternId
  // pin runs that pattern; `auto` classifies and runs the routed pattern (or, when
  // the classifier isn't confident, falls through to a plain send). `super-*` ids
  // share their base pattern's steps; the super id is retained for the model axis.
  const resolvedId = await resolvePatternForTurn(state, userText);
  state.resolvedPattern = resolvedId;
  const pattern = resolvedId ? getPattern(superToBasePattern(resolvedId)) : undefined;
  const projectDir = mainProjectDir(sessionId);
  try {
    // Model axis dispatch. Priority: group (own peers, no steps) → max (peers run
    // the base pattern, picker) → super-* (mid-mode parent-as-survivor fan-out) →
    // single-controller step loop → plain send.
    if (state.modelMode.kind === 'group') {
      await runGroupModeTurn(state, sessionId, emit, userText, projectDir);
    } else if (state.modelMode.kind === 'max' && pattern) {
      await runMaxModeTurn(state, sessionId, emit, userText, pattern, projectDir);
    } else if (pattern && isSuperPattern(resolvedId)) {
      await runMidModeTurn(state, sessionId, emit, userText, pattern, resolvedId, projectDir);
    } else if (pattern) {
      await runPatternStepsOnMain({ state, sessionId, emit, userText, pattern, resolvedId, startIdx: 0, injection: null, projectDir });
    } else {
      await state.controller.send(userText);
    }
  } finally {
    state.currentStep = null;
    state.currentStepIter = 0;
    state.pendingStepReviews = [];
    emitTelemetry(state, sessionId); // clear the active-step highlight + any gate
  }
}

/** The parent session's working directory (worktree dir, or the project root). */
function mainProjectDir(sessionId: string): string | null {
  const ws = getSessionWorkspace(sessionId);
  return (ws?.isWorktree ? ws.dir : getActiveProjectPath()) ?? null;
}

/** Emit a one-off assistant progress bubble (model-axis narration). */
function emitProgress(emit: Emit, sessionId: string, text: string): void {
  emitMessage(emit, sessionId, 'assistant', [{ type: 'text', data: { text } }, { type: 'finish' }]);
}

/**
 * Run a pattern's steps on the MAIN controller from `startIdx`, natural-stop
 * advance, with per-step tool gating, the eval-only rubric grade loop after
 * write-steps, and the SPEC/DIAGNOSE review gate. `injection` (mid-mode) is
 * appended to the first executed step's message (the survivor's super-spec).
 */
async function runPatternStepsOnMain(args: {
  state: SessionAgentState;
  sessionId: string;
  emit: Emit;
  userText: string;
  pattern: Pattern;
  resolvedId: PatternId | null;
  startIdx: number;
  injection: string | null;
  projectDir: string | null;
}): Promise<void> {
  const { state, sessionId, emit, userText, pattern, resolvedId, startIdx, injection, projectDir } = args;
  // The criteria-grader runs ONLY for eval-flow sessions — it's a measurement +
  // REVISE-pressure mechanism, not a per-user-turn cost. Normal sessions leave
  // `criteria` empty → the write-step gate is a no-op.
  const criteria = evalSessions.has(sessionId)
    ? await deriveCriteria(userText, '', agentStepJudge).catch(() => [])
    : [];
  let reviewFeedback: string | null = null;
  for (let i = Math.max(0, startIdx); i < pattern.steps.length; i++) {
    const step = pattern.steps[i];
    state.currentStep = step;
    state.currentStepIter = 0;
    emitTelemetry(state, sessionId); // live PatternStrip: highlight this step
    const isFirstExecuted = i === Math.max(0, startIdx);
    const base = isFirstExecuted ? decorateForStep(userText, step) : renderStepDecoration(step);
    const withInjection = isFirstExecuted && injection ? `${base}\n\n${injection}` : base;
    const msg = reviewFeedback
      ? `${withInjection}\n\n---\n\nUSER REVIEW FEEDBACK (revise this step accordingly):\n${reviewFeedback}`
      : withInjection;
    reviewFeedback = null;
    await state.controller.send(msg);
    // Governed judge after a write-capable step (BUILD / FIX / EDIT): grade the
    // diff against the rubric; if criteria fail, loop the same step with a
    // targeted REVISE (bounded) before advancing. `one-shot` steps never grade.
    if (step.gradeAfter && step.loops !== 'one-shot' && criteria.length > 0) {
      for (let r = 0; r < MAX_REVISE; r++) {
        const diff = await sessionGitDiff(projectDir);
        const grade = await gradeAgainstCriteria(userText, criteria, diff, agentStepJudge);
        emit({ type: 'codingAgent:event', sessionId, event: { type: 'criteria_verdicts', payload: { verdicts: grade.verdicts, failing: grade.failing } } });
        if (!grade.parsed || grade.failing.length === 0) break;
        state.currentStepIter = r + 1;
        emitTelemetry(state, sessionId);
        await state.controller.send(`${renderStepDecoration(step)}\n\n${buildRevisePrompt(grade.failing)}`);
      }
    }
    // Review gate: after a `pauseForUserReviewAfter` step (SPEC / DIAGNOSE), park
    // for the user's approve/iterate reply. Skipped on terminal + eval sessions.
    if (step.pauseForUserReviewAfter && !step.isTerminal && !evalSessions.has(sessionId)) {
      const reply = await parkForStepReview(state, sessionId, step, resolvedId);
      if (reply.action === 'iterate') {
        reviewFeedback = reply.feedback ?? '(no specific feedback provided)';
        i -= 1; // re-run this step (the for-loop's i++ returns to it)
      }
    }
  }
}

/** Default cheap peer pool for the model axis (max / mid / group) — mirrors the
 *  monolith's known-good super-spec trio. Overridable via env in a follow-up. */
const DEFAULT_PEER_POOL = ['deepseek_v4_flash', 'glm_5_1', 'minimax_m2_7'];
const SYNTHESIS_MODEL = 'deepseek_v4_pro';
const AUX_MODEL = 'deepseek_v4_flash';

/** Mid-mode (super-*): fan out the pre-edit phase to cheap peers, synthesize a
 *  super-spec, then run the remaining steps on the parent (the survivor). */
async function runMidModeTurn(
  state: SessionAgentState,
  sessionId: string,
  emit: Emit,
  userText: string,
  pattern: Pattern,
  resolvedId: PatternId | null,
  projectDir: string | null,
): Promise<void> {
  const pool = DEFAULT_PEER_POOL.filter((m) => m !== state.model);
  let result: Awaited<ReturnType<typeof runMidFanout>> | null = null;
  try {
    result = await runMidFanout({
      pattern,
      userRequest: userText,
      peerModels: pool,
      callbacks: makePeerCallbacks(sessionId),
      provider: makePeerProvider(),
      synthesisModel: SYNTHESIS_MODEL,
      injectionStyle: resolvedId === 'super-investigate-fix' ? 'imperative' : 'advisory',
      onProgress: (m) => { emitProgress(emit, sessionId, m); },
    });
  } catch (e) {
    emitProgress(emit, sessionId, `Wide fan-out failed (${(e as Error).message}); running the base pattern directly.`);
  }
  if (!result || result.synthBoundary === 0 || !result.injection) {
    await runPatternStepsOnMain({ state, sessionId, emit, userText, pattern, resolvedId, startIdx: 0, injection: null, projectDir });
    return;
  }
  await runPatternStepsOnMain({ state, sessionId, emit, userText, pattern, resolvedId, startIdx: result.synthBoundary, injection: result.injection, projectDir });
}

/** Max-mode: run the base pattern across N peers with cross-pollination, pick a
 *  winner, and apply its diff to the parent project. */
async function runMaxModeTurn(
  state: SessionAgentState,
  sessionId: string,
  emit: Emit,
  userText: string,
  pattern: Pattern,
  projectDir: string | null,
): Promise<void> {
  try {
    const res = await runMaxMode({
      pattern,
      userRequest: userText,
      peerModels: DEFAULT_PEER_POOL,
      callbacks: makePeerCallbacks(sessionId),
      provider: makePeerProvider(),
      pollinator: AUX_MODEL,
      pickerModel: AUX_MODEL,
      onProgress: (m) => { emitProgress(emit, sessionId, m); },
    });
    emitProgress(emit, sessionId, `Winner: ${res.winner.modelId} — ${res.reason}`);
    await applyWinnerDiff(sessionId, projectDir, res.winnerDiff, emit);
    accruePeerCostToParent(sessionId, res.winner.id);
    await disposePeerSession(res.winner.id);
  } catch (e) {
    emitProgress(emit, sessionId, `Max-mode failed (${(e as Error).message}); running a single pass.`);
    await runPatternStepsOnMain({ state, sessionId, emit, userText, pattern, resolvedId: pattern.id, startIdx: 0, injection: null, projectDir });
  }
}

/** Group-mode: persona peers work the task concurrently; a picker chooses the
 *  winner over their diffs, which is applied to the parent. */
async function runGroupModeTurn(
  state: SessionAgentState,
  sessionId: string,
  emit: Emit,
  userText: string,
  projectDir: string | null,
): Promise<void> {
  const mm = state.modelMode;
  const models = mm.kind === 'group' && mm.models.length > 0 ? mm.models : DEFAULT_PEER_POOL;
  const personas = mm.kind === 'group' ? mm.personas : undefined;
  try {
    const res = await runGroupMode({
      userRequest: userText,
      peerModels: models,
      ...(personas ? { personas } : {}),
      callbacks: makePeerCallbacks(sessionId),
      provider: makePeerProvider(),
      pickerModel: AUX_MODEL,
      onProgress: (m) => { emitProgress(emit, sessionId, m); },
    });
    emitProgress(emit, sessionId, `Winner: ${res.winner.modelId} (${res.reason})`);
    await applyWinnerDiff(sessionId, projectDir, res.winnerDiff, emit);
    accruePeerCostToParent(sessionId, res.winner.id);
    await disposePeerSession(res.winner.id);
  } catch (e) {
    emitProgress(emit, sessionId, `Group-mode failed (${(e as Error).message}); running a single pass.`);
    await state.controller.send(userText);
  }
}

/** Apply a winning peer's diff to the parent project via `git apply`. Best-effort;
 *  narrates success/failure into the chat (never silent). */
async function applyWinnerDiff(sessionId: string, projectDir: string | null, diff: string, emit: Emit): Promise<void> {
  if (!projectDir) { emitProgress(emit, sessionId, 'No project directory — cannot apply the winning changes.'); return; }
  if (!diff.trim()) { emitProgress(emit, sessionId, 'The winner made no file changes.'); return; }
  const patchPath = `${projectDir}/.ugly-winner.patch`;
  try {
    await native.fs.writeFile(patchPath, diff);
    const r = await spawnCollect('git', ['-C', projectDir, 'apply', '--reject', '--whitespace=nowarn', patchPath], {});
    await spawnCollect('bash', ['-lc', `rm -f ${JSON.stringify(patchPath)}`], {}).catch(() => undefined);
    if ((r.code ?? 0) !== 0) {
      emitProgress(emit, sessionId, `Could not cleanly apply the winner's diff (some hunks may be in .rej files):\n${r.stderr.slice(-800)}`);
    } else {
      emitProgress(emit, sessionId, "Applied the winning peer's changes to your project.");
    }
  } catch (e) {
    emitProgress(emit, sessionId, `Failed to apply the winner's diff: ${(e as Error).message}`);
  }
}

/**
 * Resolve which pattern (if any) drives this turn from the session's
 * `patternMode`: `none` → null (plain send); an explicit PatternId → that
 * pattern; `auto` → the classifier's routed pattern, or null when the
 * classifier isn't confident (plain send fallback). Returns the possibly-super
 * id so the caller can echo `resolvedPattern` and dispatch the model axis.
 */
async function resolvePatternForTurn(
  state: SessionAgentState,
  userText: string,
): Promise<PatternId | null> {
  const mode = state.patternMode;
  if (mode === 'none') return null;
  if (mode === 'auto') {
    const cls = await classifyForAuto(userText, agentStepJudge).catch(() => null);
    return cls && isClassificationConfident(cls) ? cls.pattern : null;
  }
  return isPatternId(mode) ? mode : null;
}

/**
 * Park the driver after a `pauseForUserReviewAfter` step: publish a pending
 * step-review into the snapshot (so the IDE renders the StepReviewCard) and
 * await the user's approve/iterate reply via the broker. Clears the pending
 * entry before returning.
 */
async function parkForStepReview(
  state: SessionAgentState,
  sessionId: string,
  step: Step,
  patternId: PatternId | null,
): Promise<import('./stepReviewBroker').StepReviewReply> {
  const id = rid();
  state.pendingStepReviews = [
    ...state.pendingStepReviews,
    {
      id,
      sessionId,
      stepId: step.id,
      stepLabel: step.label,
      patternId: patternId ?? '',
      createdAt: Date.now(),
    },
  ];
  emitTelemetry(state, sessionId);
  try {
    return await awaitStepReview(id, sessionId);
  } finally {
    state.pendingStepReviews = state.pendingStepReviews.filter((p) => p.id !== id);
    emitTelemetry(state, sessionId);
  }
}

/** Cancel the in-flight turn for a session (the chat's Stop button). Also kills
 *  any live `bash` subprocess — aborting the model loop alone leaves the spawned
 *  shell running on the host ("clicked stop, bash still running"). */
export function abortClientAgent(sessionId: string): void {
  rejectStepReviewsForSession(sessionId); // release any parked review gate first
  const killed = killSessionBashProcs(sessionId);
  if (killed) console.info('[clientAgent:abort]', JSON.stringify({ sessionId, killedBashProcs: killed }));
  sessions.get(sessionId)?.controller.abort();
}

/**
 * `/clear`: discard this session's in-memory agent context so the conversation
 * starts fresh WITHOUT tearing down the worktree. We abort any in-flight turn,
 * dispose the runAgent controller, and drop the session entry — the next turn
 * rebuilds it via getOrCreate (seq back to 0, empty history) and `ensureResumed`
 * re-reads the persisted transcript, which the caller wipes server-side in the
 * same `/clear`. The provisioned workspace (separate map) is untouched, so no
 * worktree re-provision on the next message.
 */
export function clearClientAgentSession(sessionId: string): void {
  // Stop the poll first — it can be running from a boot-time ensureCodebaseAnalysis even when
  // no turn (and so no session state) exists yet. The readiness/architecture maps are kept:
  // the project is unchanged, so the pill stays accurate and the next turn reuses them.
  stopCodebasePoll(sessionId);
  rejectStepReviewsForSession(sessionId); // release any parked review gate
  killSessionBashProcs(sessionId); // stop any shell work before we drop the session
  const s = sessions.get(sessionId);
  if (!s) return;
  try { s.controller.abort(); } catch { /* no in-flight turn */ }
  try { s.controller.dispose(); } catch { /* already torn down */ }
  sessions.delete(sessionId);
}

// ── Model-axis peer primitives (composed by peerHost.ts) ─────────────────────
// A peer is a first-class coding-agent sub-session (its own runAgent controller +
// git worktree) keyed by `<parentSessionId>:peer<i>`. These primitives expose the
// module-private session/workspace surface so peerHost can implement MaxModeCallbacks
// without reaching into `sessions`. Peers run vanilla (`patternMode: 'none'`); the
// host owns step decomposition and sends one instruction message per step.

const noopEmit: Emit = () => { /* peers are internal — no studio UI emission */ };

/** Spawn (idempotently) a peer sub-session pinned to `modelId`, provisioning its
 *  worktree. `group` registers the blackboard/ask_peer tools for the peer. Returns
 *  the peer's working directory (worktree dir, or project root on fallback). */
export async function spawnPeerSession(
  peerId: string,
  modelId: string,
  opts?: { group?: boolean },
): Promise<{ id: string; modelId: string; cwd: string }> {
  const selection: AgentSelection = {
    model: modelId,
    patternMode: 'none',
    modelMode: opts?.group ? { kind: 'group', models: [modelId] } : { kind: 'single', model: modelId },
  };
  getOrCreate(peerId, noopEmit, selection, { peer: true });
  const projectPath = getActiveProjectPath();
  const ws = await ensureSessionWorkspace(peerId, projectPath);
  // ws.dir is '' for a non-worktree fallback → use the project root instead.
  return { id: peerId, modelId, cwd: ws.dir !== '' ? ws.dir : (projectPath ?? '') };
}

/** Deliver one synthetic user message to a peer and await turn settle. `policy`
 *  gates the peer's tool list for this turn (read-only steps), reusing the same
 *  per-step gating path as the main driver (the live `tools` getter reads
 *  `state.currentStep`). */
export async function sendPeerSession(
  peerId: string,
  text: string,
  policy?: { allowedTools?: readonly ToolName[]; descriptionSuffixes?: Partial<Record<ToolName, string>> },
): Promise<void> {
  const s = sessions.get(peerId);
  if (!s) throw new Error(`peer session not found: ${peerId}`);
  s.currentStep = policy?.allowedTools
    ? ({ allowedTools: policy.allowedTools, toolDescriptionSuffixes: policy.descriptionSuffixes } as unknown as Step)
    : null;
  try {
    await s.controller.send(text);
  } finally {
    s.currentStep = null;
  }
}

/** The peer's last assistant text (artifact extraction / synthesis input). */
export function peerHistoryText(peerId: string): string {
  const s = sessions.get(peerId);
  if (!s) return '';
  const msgs = s.controller.getMessages();
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as { role?: string; content?: unknown };
    if (m.role !== 'assistant') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) return m.content.map((b) => (b as { text?: string }).text ?? '').join('');
  }
  return '';
}

/** The peer's uncommitted diff vs its worktree baseline. */
export async function peerSessionDiff(peerId: string): Promise<string> {
  return sessionGitDiff(getSessionWorkspace(peerId)?.dir ?? null);
}

/** Cumulative cost the peer has accrued (for parent telemetry aggregation). */
export function peerSessionCost(peerId: string): number {
  return sessions.get(peerId)?.cost ?? 0;
}

/** Tear down a peer sub-session: abort + dispose the controller, drop the session,
 *  and remove its worktree. Best-effort. */
export async function disposePeerSession(peerId: string): Promise<void> {
  killSessionBashProcs(peerId);
  const s = sessions.get(peerId);
  if (s) {
    try { s.controller.abort(); } catch { /* no in-flight turn */ }
    try { s.controller.dispose(); } catch { /* already torn down */ }
    sessions.delete(peerId);
  }
  try { await removeSessionWorkspace(peerId, getActiveProjectPath()); } catch { /* best effort */ }
}

/** The main session's controller (the mid-mode survivor) — lets peerHost inject the
 *  synthesized super-spec into the parent and run the remaining steps on it. */
export function getMainController(sessionId: string): AgentController | null {
  return sessions.get(sessionId)?.controller ?? null;
}

/** The parent session's live diff (for merge/winner bookkeeping). */
export async function mainSessionDiff(sessionId: string): Promise<string> {
  const ws = getSessionWorkspace(sessionId);
  return sessionGitDiff((ws?.isWorktree ? ws.dir : getActiveProjectPath()) ?? null);
}

/** Aggregate a peer's accrued cost onto the parent session's telemetry + emit. */
export function accruePeerCostToParent(parentSessionId: string, peerId: string): void {
  const parent = sessions.get(parentSessionId);
  if (!parent) return;
  parent.cost += peerSessionCost(peerId);
  emitTelemetry(parent, parentSessionId);
}

/**
 * Build the `MaxModeCallbacks` bundle bound to a parent session — the ugly-code
 * implementation the model-axis hosts (mid/max/group) drive peers through. Lives
 * here (not a separate peerHost.ts) so it can reach the module-private peer
 * primitives without an import cycle (clientAgent → host → peerHost → clientAgent).
 */
export function makePeerCallbacks(parentSessionId: string): import('./patterns/peerTypes').MaxModeCallbacks {
  const peerId = (i: number): string => `${parentSessionId}:peer${i}`;
  return {
    async spawnPeers(modelIds, opts) {
      const group = opts?.peerKind === 'group';
      const peers = await Promise.all(
        modelIds.map(async (modelId, i) => {
          // A survivor peer (mid mode) is handled by the parent controller, not here;
          // spawnPeers only ever receives loser/participant model ids.
          const { id, cwd } = await spawnPeerSession(peerId(i), modelId, { group });
          const persona = opts?.personas?.[i];
          return { id, modelId, cwd, ...(persona ? { persona } : {}) };
        }),
      );
      return peers;
    },
    async sendToPeerAndSettle(peer, text, policy) {
      await sendPeerSession(peer.id, text, policy);
    },
    async tearDownPeer(peer) {
      accruePeerCostToParent(parentSessionId, peer.id); // fold peer spend onto the parent
      await disposePeerSession(peer.id);
    },
    async getPeerDiff(peer) {
      return peerSessionDiff(peer.id);
    },
    getPeerSpec(peer) {
      // The peer's last assistant text stands in for its spec/diagnosis artifact
      // (spec_write persists remotely; the summary text is the synthesis input).
      return Promise.resolve(peerHistoryText(peer.id));
    },
  };
}

/** No-tools completion provider for the aux calls (synthesis / insights / picker),
 *  routed through the same governed /api/agentStep endpoint as the judge. */
export function makePeerProvider(): import('./patterns/peerTypes').PeerProvider {
  return {
    async complete(req, signal) {
      const res = await fetch('/api/agentStep', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          input: {
            messages: req.messages,
            noTools: true, // synthesis / insights / picker want a clean completion
            ...(req.model ? { model: req.model } : {}),
            ...(req.maxTokens ? { maxTokens: req.maxTokens } : {}),
          },
        }),
        ...(signal ? { signal } : {}),
      });
      const json = (await res.json()) as { result?: { message?: { content?: unknown } }; error?: string };
      if (json.error) throw new Error(json.error);
      const content = json.result?.message?.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) return content.map((b) => (b as { text?: string }).text ?? '').join('');
      return '';
    },
  };
}
