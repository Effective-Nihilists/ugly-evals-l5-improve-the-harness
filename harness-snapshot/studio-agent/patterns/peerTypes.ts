// Shared contract for the model axis (max / mid / group multi-peer orchestration).
// Ported from ugly-studio f5a74c2^:server/coding-agent/patterns/max-mode-host.ts
// (MaxModePeer / PeerStepToolPolicy / MaxModeCallbacks) + a `PeerProvider`
// abstraction that maps the monolith's streaming `LlmProvider` onto ugly-code's
// governed /api/agentStep completion. The three hosts and the pure helper modules
// (synthesize-spec / extract-insights / extract-artifact / picker / peer-personas)
// depend ONLY on this file + ./types + ./judge, so they port near-verbatim and the
// ugly-code integration (peerHost.ts) implements MaxModeCallbacks against the real
// session-management surface.
import type { ToolName } from '../../../../shared/agent';

/** One LLM message for a no-tools peer/aux completion. */
export interface PeerMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface PeerCompletionRequest {
  /** ugly-code model id (underscore form, e.g. `deepseek_v4_flash`). */
  model: string;
  messages: PeerMessage[];
  maxTokens?: number;
  temperature?: number;
}

/**
 * No-tools completion provider for the aux calls (synthesis, insights, picker).
 * Concrete impl lives in peerHost.ts (`makePeerProvider`) wrapping /api/agentStep;
 * the pure modules accept this interface so they stay host-agnostic + testable
 * with a stub.
 */
export interface PeerProvider {
  complete(req: PeerCompletionRequest, signal?: AbortSignal): Promise<string>;
}

/**
 * Lifecycle handle the host uses to drive one peer. peerHost wires these against
 * ugly-code's session map + worktree layer.
 */
export interface MaxModePeer {
  /** Sub-session id (`<parentSessionId>:peer<i>`) — stable for telemetry. */
  id: string;
  /** Pinned model id for this peer. */
  modelId: string;
  /** Working directory for artifact extraction (worktree path, or project root
   *  for a survivor). */
  cwd: string;
  /** Dispositional persona (group mode); undefined for max/mid peers. */
  persona?: string;
}

/**
 * Per-step tool policy applied to a peer's vanilla (`Pattern: none`) turn:
 * `allowedTools` hard-filters the tool list to a subset; `descriptionSuffixes`
 * appends per-tool addenda (read-only step reshaping of bash/python_exec).
 */
export interface PeerStepToolPolicy {
  allowedTools?: readonly ToolName[];
  descriptionSuffixes?: Partial<Record<ToolName, string>>;
}

/** What the caller (peerHost) provides to drive peers. */
export interface MaxModeCallbacks {
  /**
   * Create N peers, one per `modelIds[i]`, each a fresh `Pattern: none` sub-session.
   * `survivor` (mid mode): the matching peer skips worktree provisioning and runs
   * on the project root (its diff is canonical); losers each get a worktree.
   * `peerKind: 'group'` registers the blackboard/ask_peer tools for the peer.
   */
  spawnPeers(
    modelIds: readonly string[],
    opts?: {
      survivor?: string;
      peerKind?: 'single' | 'group';
      personas?: readonly (string | undefined)[];
    },
  ): Promise<MaxModePeer[]>;
  /** Deliver one synthetic user message to a peer and await turn settle. */
  sendToPeerAndSettle(peer: MaxModePeer, text: string, policy?: PeerStepToolPolicy): Promise<void>;
  /** Best-effort teardown (dispose controller + remove worktree). */
  tearDownPeer(peer: MaxModePeer): Promise<void>;
  /** The peer's uncommitted diff vs its baseline (for artifact extraction / grading). */
  getPeerDiff(peer: MaxModePeer): Promise<string>;
  /** The peer's spec/diagnosis doc text, if it wrote one (synthesis input). */
  getPeerSpec(peer: MaxModePeer): Promise<string>;
}
