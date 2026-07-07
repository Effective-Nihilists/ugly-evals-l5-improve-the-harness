/**
 * resolve-model — turn a `modelHint` (`cheap` / `balanced` / `strong`)
 * into a concrete model id from the project's allowlist.
 *
 * Used by session.ts when auto-mode resolves a single model for the
 * session. The classifier no longer emits per-task hints; auto-mode
 * pins to the default tier (`balanced`) at session start.
 *
 * Design choice: hard-code one provider per tier rather than picking
 * randomly across tiers. Diverse models on the same hint tier add
 * variance to the eval signal without giving the user any benefit
 * — they want predictable behavior. The max-mode pool is where
 * diversity earns its keep (cross-pollination across distinct
 * model families).
 *
 * OSS-only by construction: no `claude-*` ids in any tier (cf. memory
 * `feedback_no_haiku_use_oss.md`).
 */

/** Strict union for the model-hint axis. */
export type ModelHint = 'cheap' | 'balanced' | 'strong';

/**
 * Default model id per tier. Picked for: free/cheap availability,
 * structured-JSON adherence, and reasonable agentic behavior on the
 * eval suite.
 *
 * - cheap → deepseek_v4_flash (cheap; ships solid JSON; same model as
 *   the pollinator + picker so the auxiliary path is single-provider).
 * - balanced → minimax_m2_7 (mid tier)
 * - strong → deepseek_v4_pro (strongest available; reasoning-capable;
 *   the `AGENT_DEFAULT_MODEL`).
 *
 * ugly-code model ids are the underscore catalog form (see
 * `client/studio/shared/model-rankings.ts` DEFAULT_POOL_PINNED_IDS).
 */
const DEFAULT_TIER: Record<ModelHint, string> = {
  cheap: 'deepseek_v4_flash',
  balanced: 'minimax_m2_7',
  strong: 'deepseek_v4_pro',
};

export interface ResolveModelInput {
  hint: ModelHint;
  /**
   * Project allowlist override. When provided, the resolver picks
   * the highest-tier model from `allowlist` that's ≤ the hint's
   * default tier. Useful for projects that pin a specific provider.
   * Empty array = no allowlist (fall back to default).
   */
  allowlist?: readonly string[];
}

/**
 * Resolve a ModelHint to a concrete ugly-code model id.
 *
 * Resolution order:
 *   1. If allowlist non-empty and contains the hint's default → use it.
 *   2. If allowlist non-empty otherwise → first allowlist entry (the
 *      project explicitly opted into this set; honor it).
 *   3. Else default tier.
 */
export function resolveModel(input: ResolveModelInput): string {
  const candidate = DEFAULT_TIER[input.hint];
  if (input.allowlist && input.allowlist.length > 0) {
    if (input.allowlist.includes(candidate)) return candidate;
    // Fall back to the first allowed model. The project explicitly
    // pinned this set; we honor it even if it doesn't match the
    // hint's default tier.
    const first = input.allowlist[0];
    if (first) return first;
  }
  return candidate;
}
