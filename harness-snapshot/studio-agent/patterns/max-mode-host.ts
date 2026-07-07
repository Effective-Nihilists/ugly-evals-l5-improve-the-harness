// Max-mode host — N worktree-isolated peers run the SAME pattern in parallel, with
// peer-insight cross-pollination nudges between non-trivial steps, and a terminal
// picker selecting the winner. Ported in spirit from ugly-studio f5a74c2^:
// server/coding-agent/patterns/max-mode-host.ts, trimmed to the core cross-
// pollination flow (the eval-only levers — peerTemps, peerVariants, adversarial
// revise, zero-diff recovery — are omitted). Host-agnostic via MaxModeCallbacks.
import type { MaxModeCallbacks, MaxModePeer, PeerProvider, PeerStepToolPolicy } from './peerTypes';
import type { Pattern, Step } from './types';
import { extractArtifact } from './extract-artifact';
import { extractInsights, buildPeerInsightsNudge } from './extract-insights';
import { pickWinner } from './picker';
import { renderStepDecoration, decorateForStep } from './decorate';

function policyFor(step: Step): PeerStepToolPolicy {
  return {
    ...(step.allowedTools ? { allowedTools: step.allowedTools } : {}),
    ...(step.toolDescriptionSuffixes ? { descriptionSuffixes: step.toolDescriptionSuffixes } : {}),
  };
}

/** Build a peer's artifact for the current step (diff for edit steps; spec/prose
 *  otherwise), sourced from the host callbacks. */
async function peerArtifact(cb: MaxModeCallbacks, peer: MaxModePeer, step: Step): Promise<string> {
  const [diff, spec] = await Promise.all([cb.getPeerDiff(peer), cb.getPeerSpec(peer)]);
  return extractArtifact({ kind: step.pickerArtifact, diff, spec, lastAssistantText: spec });
}

export interface MaxModeInput {
  pattern: Pattern;
  userRequest: string;
  /** The model pool — one peer per id (typically 3-5 distinct OSS models). */
  peerModels: readonly string[];
  callbacks: MaxModeCallbacks;
  provider: PeerProvider;
  /** Pollinator model id for insight extraction; the literal `'none'` disables cross-pollination. */
  pollinator?: string;
  pickerModel?: string;
  signal?: AbortSignal;
  onProgress?: (msg: string) => void;
}

export interface MaxModeResult {
  winner: MaxModePeer;
  /** The winner's final diff (the caller applies it to the parent project). */
  winnerDiff: string;
  reason: string;
}

/**
 * Run the pattern across N peers with cross-pollination and pick a winner. The
 * winner peer is NOT torn down (its diff is returned for the caller to apply);
 * all losers are torn down. Throws if the pool is empty.
 */
export async function runMaxMode(input: MaxModeInput): Promise<MaxModeResult> {
  if (input.peerModels.length === 0) throw new Error('max-mode: empty model pool');
  const steps = input.pattern.steps;
  // Per-peer pending insight nudge for the next step (index-aligned with `peers`).
  const pendingNudges: string[] = [];
  input.onProgress?.(`Spawning ${input.peerModels.length} peers for max-mode (${input.pattern.label})…`);
  const peers = await input.callbacks.spawnPeers(input.peerModels, { peerKind: 'single' });
  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const isFirst = i === 0;
      // Deliver this step to every peer in parallel.
      await Promise.all(
        peers.map((peer, pi) => {
          const base = isFirst ? decorateForStep(input.userRequest, step) : renderStepDecoration(step);
          const nudge = pendingNudges[pi];
          const text = nudge ? `${base}\n\n${nudge}` : base;
          return input.callbacks.sendToPeerAndSettle(peer, text, policyFor(step));
        }),
      );
      pendingNudges.length = 0;
      // Cross-pollinate between non-terminal steps: summarize each peer's artifact
      // and inject the peer-insights nudge into every peer's NEXT step.
      if (!step.isTerminal && input.pollinator !== 'none') {
        const artifacts = await Promise.all(
          peers.map(async (peer) => ({ name: peer.modelId, content: await peerArtifact(input.callbacks, peer, step) })),
        );
        try {
          const { insights } = await extractInsights({
            variant: step.stepVariant,
            artifacts,
            userRequest: input.userRequest,
            provider: input.provider,
            signal: input.signal ?? new AbortController().signal,
            ...(input.pollinator ? { modelOverride: input.pollinator } : {}),
          });
          const nudge = buildPeerInsightsNudge(insights);
          for (let p = 0; p < peers.length; p++) pendingNudges[p] = nudge;
        } catch {
          /* pollinator best-effort — peers proceed without a nudge */
        }
      }
    }
    // Terminal picker over the final artifacts.
    const terminal = steps[steps.length - 1];
    const candidates = await Promise.all(
      peers.map(async (peer) => ({ model: peer.modelId, artifact: await peerArtifact(input.callbacks, peer, terminal) })),
    );
    input.onProgress?.('Picking the winner…');
    const pick = await pickWinner({
      variant: terminal.stepVariant,
      ticket: input.userRequest,
      candidates,
      provider: input.provider,
      ...(input.pickerModel ? { pickerModel: input.pickerModel } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const winner = peers[pick.winnerIndex] ?? peers[0];
    const winnerDiff = await input.callbacks.getPeerDiff(winner);
    // Tear down losers only; the winner's worktree survives for the caller to apply.
    await Promise.all(peers.filter((p) => p.id !== winner.id).map((p) => input.callbacks.tearDownPeer(p).catch(() => undefined)));
    return { winner, winnerDiff, reason: pick.reason };
  } catch (err) {
    await Promise.all(peers.map((p) => input.callbacks.tearDownPeer(p).catch(() => undefined)));
    throw err;
  }
}
