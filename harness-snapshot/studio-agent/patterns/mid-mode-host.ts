// Mid-mode host — "wide pre-edit, narrow edit" (the engine behind the super-* patterns).
// Ported in spirit from ugly-studio f5a74c2^:server/coding-agent/patterns/mid-mode-host.ts
// (the parent-as-survivor `runFanOutSynthesis` path).
//
// N cheap peers run the pattern's PRE-EDIT phase (SPEC, or REPRO+DIAGNOSE for
// investigate-fix) in isolated worktrees; a frontier model synthesizes their
// artifacts into one super-spec; the losers are torn down; the super-spec is
// injected into the PARENT (the survivor, running on the project root), which then
// runs the remaining EDIT/VERIFY steps solo. Host-agnostic: the peer surface is the
// injected `MaxModeCallbacks`, so this is unit-testable with stub callbacks.
import type { MaxModeCallbacks, PeerProvider, PeerStepToolPolicy } from './peerTypes';
import type { Pattern, Step } from './types';
import { synthesizeSpec, extractSynthesisInputForPeer, buildSurvivorInjectionPrompt } from './synthesize-spec';
import { renderStepDecoration, decorateForStep } from './decorate';

/** Steps that mutate source — the synthesis boundary is the first such step. */
function isEditStep(step: Step): boolean {
  return step.id === 'build' || step.id === 'fix' || step.id === 'edit';
}

/** Index of the first edit-family step (the synthesis boundary). Everything before
 *  it is the "wide" phase peers run; everything from it on is the survivor's. */
export function synthBoundaryOf(pattern: Pattern): number {
  const idx = pattern.steps.findIndex(isEditStep);
  return idx < 0 ? pattern.steps.length : idx;
}

function policyFor(step: Step): PeerStepToolPolicy {
  return {
    ...(step.allowedTools ? { allowedTools: step.allowedTools } : {}),
    ...(step.toolDescriptionSuffixes ? { descriptionSuffixes: step.toolDescriptionSuffixes } : {}),
  };
}

export interface MidModeInput {
  /** Base pattern (already super→base translated). */
  pattern: Pattern;
  userRequest: string;
  /** The cheap SPEC/DIAGNOSE peer pool (loser model ids). */
  peerModels: readonly string[];
  callbacks: MaxModeCallbacks;
  provider: PeerProvider;
  synthesisModel?: string;
  injectionStyle?: 'advisory' | 'imperative';
  signal?: AbortSignal;
  onProgress?: (msg: string) => void;
}

export interface MidModeResult {
  /** The consolidated super-spec. */
  superSpec: string;
  /** Index the survivor (parent) resumes the step loop from. */
  synthBoundary: number;
  /** Message to inject into the parent as the survivor-phase kickoff. */
  injection: string;
}

/**
 * Run the wide pre-edit fan-out + synthesis. Returns the super-spec + the boundary
 * the caller resumes the parent's step loop from (with `injection` as the first
 * survivor-phase message). Losers are always torn down before returning.
 */
export async function runMidFanout(input: MidModeInput): Promise<MidModeResult> {
  const boundary = synthBoundaryOf(input.pattern);
  const preSteps = input.pattern.steps.slice(0, boundary);
  if (preSteps.length === 0 || input.peerModels.length === 0) {
    // Nothing to widen (no pre-edit phase / no pool) — degenerate to a no-op fan-out.
    return { superSpec: '', synthBoundary: 0, injection: '' };
  }
  input.onProgress?.(`Fanning out ${input.peerModels.length} peers for the ${preSteps.map((s) => s.label).join(' + ')} phase…`);
  const peers = await input.callbacks.spawnPeers(input.peerModels, { peerKind: 'single' });
  try {
    // Each peer runs the pre-edit steps sequentially; peers run in parallel.
    await Promise.all(
      peers.map(async (peer) => {
        for (let i = 0; i < preSteps.length; i++) {
          const step = preSteps[i];
          const text = i === 0 ? decorateForStep(input.userRequest, step) : renderStepDecoration(step);
          await input.callbacks.sendToPeerAndSettle(peer, text, policyFor(step));
        }
      }),
    );
    const artifacts = await Promise.all(
      peers.map(async (peer) => ({
        name: peer.modelId,
        content: extractSynthesisInputForPeer({ spec: await input.callbacks.getPeerSpec(peer) }),
      })),
    );
    input.onProgress?.('Synthesizing the peer specs into one super-spec…');
    const { superSpec } = await synthesizeSpec({
      userRequest: input.userRequest,
      artifacts,
      provider: input.provider,
      ...(input.synthesisModel ? { modelOverride: input.synthesisModel } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return { superSpec, synthBoundary: boundary, injection: buildSurvivorInjectionPrompt(superSpec, input.injectionStyle) };
  } finally {
    await Promise.all(peers.map((p) => input.callbacks.tearDownPeer(p).catch(() => { /* best effort */ })));
  }
}
