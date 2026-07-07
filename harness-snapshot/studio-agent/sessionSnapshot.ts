// Pure session-snapshot composition, shared by the task-side client agent
// (clientAgent.ts, which emits `session_state` each turn) and the renderer-side
// socket handlers (useSocket.ts `getCodingAgentSnapshot`, the mount-time read).
// Kept dependency-free (types only) so the renderer doesn't pull the agent's
// task-only tree just to echo the selected axes.
import type { ReasoningEffort, SessionSnapshot } from '../shared/api';

export interface PerModelAcc {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cost: number;
  turnCount: number;
}

/**
 * Build the `session_state` snapshot payload from the session's live telemetry
 * + the user's selected axes. Pure (no emit) so the echo-the-selection contract
 * is unit-testable. The chat hook's `applySnapshot` reads `finishPipeline`
 * WITHOUT guards, so the empty shape is always present (the client agent has no
 * finish pipeline).
 */
export function composeSessionSnapshot(args: {
  sessionId: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  model: string;
  reasoningEffort: ReasoningEffort;
  permissionMode: SessionSnapshot['permissionMode'];
  modelMode: SessionSnapshot['modelMode'];
  patternMode: SessionSnapshot['patternMode'];
  resolvedPattern?: SessionSnapshot['resolvedPattern'];
  currentStepId?: SessionSnapshot['currentStepId'];
  currentStepIter?: number;
  pendingStepReviews?: SessionSnapshot['pendingStepReviews'];
  cost: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  perModel: PerModelAcc[];
  messageCount: number;
}): SessionSnapshot {
  return {
    compositeId: args.sessionId,
    workspaceId: args.sessionId.split(':')[0] ?? '',
    sessionId: args.sessionId.split(':')[1] ?? args.sessionId,
    title: '',
    cwd: args.cwd,
    createdAt: args.createdAt,
    updatedAt: args.updatedAt,
    mode: args.permissionMode === 'yolo' ? ('yolo' as const) : ('edit' as const),
    model: args.model,
    reasoningEffort: args.reasoningEffort,
    supportsReasoning: false,
    permissionMode: args.permissionMode,
    modelMode: args.modelMode,
    patternMode: args.patternMode,
    resolvedPattern: args.resolvedPattern ?? null,
    currentStepId: args.currentStepId ?? null,
    currentStepIter: args.currentStepIter ?? 0,
    currentStepFinished: false,
    worktree: null,
    worktreeBlocked: false,
    worktreeStatus: null,
    finishPipeline: { running: false, done: false, ok: false, stages: [] },
    cost: args.cost,
    promptTokens: args.promptTokens,
    completionTokens: args.completionTokens,
    cacheReadTokens: args.cacheReadTokens,
    cacheCreationTokens: args.cacheCreationTokens,
    perModel: args.perModel,
    messageCount: args.messageCount,
    // Complete the snapshot so the mount/cast consumer (applySnapshot) can read
    // these without a guard — an omitted array here surfaced as
    // "Cannot read properties of undefined (reading 'map')". The granular path's
    // safeParse fills these via zod `.default([])`, but the cast path doesn't parse.
    modelDisplayLabel: '',
    lastViewedAt: 0,
    pendingPermissions: [],
    pendingAskUsers: [],
    pendingStepReviews: args.pendingStepReviews ?? [],
    eval: null,
  };
}
