// Group-mode host — N persona-seeded peers work the SAME task concurrently in
// isolated worktrees with NO step structure, then a picker selects the winner over
// their final diffs. Ported in spirit from ugly-studio f5a74c2^:server/coding-agent/
// patterns/group-mode-host.ts.
//
// SIMPLIFICATION vs the monolith: each peer gets ONE persona-prepended kickoff turn
// (run to settle) rather than a multi-turn shared-blackboard loop with directed
// ask_peer / answer_peer. The `blackboard_post` tool is registered for group peers
// (peerKind: 'group') so peers CAN post, but the parent-keyed board auto-injection
// and directed peer Q&A are a documented follow-up. The winner-selection behaviour
// (persona diversity → picker over diffs) is faithful.
import type { MaxModeCallbacks, MaxModePeer, PeerProvider } from './peerTypes';
import { pickWinner } from './picker';
import { getPersona, isPersonaId, applyPersonaToInitialPrompt, type PersonaId } from './peer-personas';

/** Round-robin persona assignment across the pool (contrarian always represented). */
const DEFAULT_PERSONA_ROTATION: PersonaId[] = [
  'safe-engineer',
  'creative',
  'contrarian',
  'architect-reviewer',
  'default',
];

export interface GroupModeInput {
  userRequest: string;
  /** The model pool — one peer per id. */
  peerModels: readonly string[];
  /** Optional explicit persona per model id (else round-robin). */
  personas?: Record<string, string>;
  callbacks: MaxModeCallbacks;
  provider: PeerProvider;
  pickerModel?: string;
  signal?: AbortSignal;
  onProgress?: (msg: string) => void;
}

export interface GroupModeResult {
  winner: MaxModePeer;
  winnerDiff: string;
  reason: string;
  /** Per-peer diffs captured before teardown (for eval / debugging). */
  peerDiffs: readonly { peerId: string; model: string; persona: string; diff: string; isWinner: boolean }[];
}

export async function runGroupMode(input: GroupModeInput): Promise<GroupModeResult> {
  if (input.peerModels.length === 0) throw new Error('group-mode: empty model pool');
  const personaIds = input.peerModels.map((modelId, i) => {
    const explicit = input.personas?.[modelId];
    if (explicit && isPersonaId(explicit)) return explicit;
    return DEFAULT_PERSONA_ROTATION[i % DEFAULT_PERSONA_ROTATION.length];
  });
  input.onProgress?.(`Spawning ${input.peerModels.length} group peers (${personaIds.join(', ')})…`);
  const peers = await input.callbacks.spawnPeers(input.peerModels, {
    peerKind: 'group',
    personas: personaIds,
  });
  try {
    // One persona-prepended kickoff turn per peer, in parallel; run to settle.
    await Promise.all(
      peers.map((peer, i) => {
        const persona = getPersona(personaIds[i]);
        return input.callbacks.sendToPeerAndSettle(peer, applyPersonaToInitialPrompt(input.userRequest, persona));
      }),
    );
    // Capture each peer's diff before any teardown.
    const diffs = await Promise.all(
      peers.map(async (peer, i) => ({
        peer,
        model: peer.modelId,
        persona: personaIds[i],
        diff: await input.callbacks.getPeerDiff(peer),
      })),
    );
    input.onProgress?.('Picking the winner over peer diffs…');
    let winnerIndex = 0;
    let reason = 'first non-empty diff (picker unavailable)';
    try {
      const pick = await pickWinner({
        variant: 'edit',
        ticket: input.userRequest,
        candidates: diffs.map((d) => ({ model: d.model, artifact: d.diff })),
        provider: input.provider,
        ...(input.pickerModel ? { pickerModel: input.pickerModel } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      winnerIndex = pick.winnerIndex;
      reason = pick.reason;
    } catch {
      // Picker failed — fall back to the first peer with a non-empty diff.
      const idx = diffs.findIndex((d) => d.diff.trim().length > 0);
      winnerIndex = idx >= 0 ? idx : 0;
    }
    const winner = peers[winnerIndex] ?? peers[0];
    const winnerDiff = diffs[winnerIndex]?.diff ?? '';
    const peerDiffs = diffs.map((d) => ({
      peerId: d.peer.id,
      model: d.model,
      persona: d.persona,
      diff: d.diff,
      isWinner: d.peer.id === winner.id,
    }));
    // Tear down losers; keep the winner's worktree for the caller to apply.
    await Promise.all(peers.filter((p) => p.id !== winner.id).map((p) => input.callbacks.tearDownPeer(p).catch(() => undefined)));
    return { winner, winnerDiff, reason, peerDiffs };
  } catch (err) {
    await Promise.all(peers.map((p) => input.callbacks.tearDownPeer(p).catch(() => undefined)));
    throw err;
  }
}
