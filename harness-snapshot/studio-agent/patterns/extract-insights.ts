/**
 * extract-insights — cross-pollination peer-insights extractor.
 *
 * Ported and generalized from studio/evals/scripts/max-cross.ts (the
 * winning design). Given N candidate artifacts produced by parallel
 * sessions on the same step, identify points of disagreement —
 * "contested claims" — and emit them as plain prose to inject as a
 * synthetic user nudge into each session before the next step.
 *
 * Per-step variants give different framing to the LLM because what
 * "contested" looks like differs by artifact type:
 *   - spec / diagnosis / proposal — root-cause / scope / recommendation
 *     disagreements.
 *   - diff — implementation choices (which method, real vs stub,
 *     scope creep).
 *   - repro — determinism, scope of the failure.
 *   - prose-answer / research-notes — contradictory factual claims.
 *
 * Output style is fixed across variants: 2–5 short prose sentences,
 * no bullets, no JSON, never takes a side. The injection text becomes
 * a `PEER INSIGHTS` block in each session's next-step prompt.
 *
 * Cheap model — DeepSeek-flash by default — because this fires once
 * per step boundary and the picker thesis is "many cheap calls beat
 * one expensive call." Cross-bias risk acknowledged; rotate via
 * `INSIGHTS_MODEL_ID` env var when validating.
 *
 * In ugly-code the pollinator call routes through the host's
 * `PeerProvider.complete` (a governed, metered no-tools /api/agentStep
 * completion) instead of the monolith's streaming `LlmProvider` — so
 * the pollinator can reach any model the parent session can route to.
 */
import type { PeerProvider } from './peerTypes';
import type { StepVariantId } from './types';

const DEFAULT_INSIGHTS_MODEL = 'deepseek_v4_flash';

const MAX_CANDIDATE_CHARS = 6_000;
const MAX_INSIGHTS_OUTPUT_CHARS = 1_200;

const INSIGHTS_FRAMING: Record<StepVariantId, string> = {
  'spec':
    'parallel SPEC outputs from coding agents working on the same task. Look for disagreements about acceptance criteria, named files, or root-cause hypotheses.',
  'edit':
    'parallel EDIT diffs from coding agents working on the same task. For each method body or function added/changed in the diffs, ask: do candidates disagree on whether it does real work or is a no-op stub? Do they target different methods entirely? Do they delete code one peer added? Surface disagreements at the level of named methods/functions, not whole-file framing.',
  'verify':
    'parallel VERIFY outputs from coding agents. Look for disagreements about which assertions actually exercise the bug, vacuous-green vs real-green test runs, or whether failures are pre-existing.',
  'diagnosis':
    'parallel DIAGNOSIS notes from coding agents investigating the same bug. Look for competing root causes, contested code locations, or proposed-fix disagreements.',
  'repro':
    'parallel REPRO recipes from coding agents trying to reproduce the same bug. Look for disagreements about whether the failure is deterministic, the minimal repro steps, or environmental dependencies.',
  'quick-edit':
    'parallel small-change diffs from coding agents on the same task. Look for disagreements about scope (what is in vs out), which file is the right target, and whether unrelated cleanup snuck in.',
  'verify-touched':
    'parallel touched-file lint/tsc outputs from coding agents. Look for disagreements about whether failures are pre-existing or caused by the change, and what counts as "touched".',
  'prose-answer':
    'parallel prose answers from coding agents to the same question. Look for contradictory factual claims, citations that disagree with each other, or one answer relying on something another contests.',
  'research-notes':
    'parallel research notes from coding agents on an open-ended advisory question. Look for conflicting source claims, over- vs under-scoped research, or different framings of the same dimension.',
  'proposal':
    'parallel proposals from coding agents synthesizing an advisory answer. Look for contested recommendations across proposals, frameworks one cites that another rejects, and concrete vs generic disagreements.',
};

const INSIGHTS_SYSTEM_PROMPT =
  'You analyze parallel coding-agent outputs for contested claims. Your output is plain prose. Never take a side. Never use bullets, numbers, or JSON.';

interface ExtractInsightsInput {
  variant: StepVariantId;
  /** N candidates' artifacts. Index = candidate ordinal, name = model id. */
  artifacts: { name: string; content: string }[];
  /** Original user request — gives the model context for what the agents are working on. */
  userRequest: string;
  /** AbortSignal threaded from the driver. */
  signal: AbortSignal;
  /**
   * Provider used to issue the pollinator completion. The host passes its
   * own composite provider through so the pollinator can route to any
   * model the parent session can route to (framework / BYO / OAuth) —
   * not just deepseek/z-ai/kimi.
   */
  provider: PeerProvider;
  /**
   * Override the default insights model. Useful for cross-bias
   * validation in evals. Falls back to deepseek-v4-flash.
   */
  modelOverride?: string;
}

/** Call-count breakdown emitted by one pollinator invocation. */
export interface PollinatorUsage {
  calls: number;
}

const ZERO_USAGE: PollinatorUsage = { calls: 0 };

export interface PollinatorResult {
  insights: string;
  usage: PollinatorUsage;
}

function clampCandidate(s: string): string {
  return s.length <= MAX_CANDIDATE_CHARS
    ? s
    : `${s.slice(0, MAX_CANDIDATE_CHARS)}\n... [truncated]`;
}

/**
 * Run the insights extractor and return the prose nudge body. Empty
 * string when fewer than 2 candidates (no peers to disagree). Empty
 * string on call failure — the caller treats that as "no insights"
 * and just runs the next step without a nudge.
 */
export async function extractInsights(
  input: ExtractInsightsInput,
): Promise<PollinatorResult> {
  if (input.artifacts.length < 2)
    return { insights: '', usage: { ...ZERO_USAGE } };
  const framing = INSIGHTS_FRAMING[input.variant];
  const candidatesBlock = input.artifacts
    .map(
      (a, i) =>
        `=== AGENT ${i + 1} (${a.name}) ===\n${clampCandidate(a.content)}`,
    )
    .join('\n\n');
  const promptText = [
    `You are reviewing ${input.artifacts.length} ${framing}`,
    '',
    `USER REQUEST:\n${input.userRequest.slice(0, 1500)}`,
    '',
    'Identify points where the agents DISAGREE in a way that affects whether the work is correct. Focus on contested claims — places where some agents say X and others say NOT X.',
    '',
    'Output 2-5 contested points as plain prose (no bullets, no JSON). For each, briefly state the disagreement WITHOUT saying which side is right. Format like:',
    '',
    'Several agents disagreed on whether <X>. Some argued <A> while others argued <B>.',
    '',
    'Then a second sentence on a different contested point. Then a third. Output prose only.',
    '',
    candidatesBlock,
  ].join('\n');
  const model = input.modelOverride ?? DEFAULT_INSIGHTS_MODEL;
  let text: string;
  try {
    text = await input.provider.complete(
      {
        model,
        messages: [
          { role: 'system', content: INSIGHTS_SYSTEM_PROMPT },
          { role: 'user', content: promptText },
        ],
        maxTokens: 4_000,
        temperature: 0,
      },
      input.signal,
    );
  } catch (err) {
    console.warn(
      `[extractInsights] failed: ${
        (err as Error).message
      } — returning empty insights`,
    );
    return { insights: '', usage: { ...ZERO_USAGE } };
  }
  const insights = text.trim().slice(0, MAX_INSIGHTS_OUTPUT_CHARS);
  console.log(
    `[pollinator/${input.variant}/insights] model=${model} text=${JSON.stringify(
      insights,
    )}`,
  );
  return { insights, usage: { calls: 1 } };
}

/**
 * Adversarial pollinator — second pass between EDIT and VERIFY that
 * argues *against* whatever the consensus diff appears to do. The
 * normal `extractInsights` finds disagreements; when peers all wrote
 * structurally similar diffs (the failure mode observed in the
 * 2026-05-02 sweep where 4/4 peers tied at 2/5 with the same failing
 * test), there ARE no disagreements and the regular insights are
 * empty. The adversarial pass instead asks "if every peer is wrong,
 * what's the most likely reason?" and surfaces it as a contestable
 * claim. This breaks correlated-failure modes by giving each peer a
 * concrete alternative to consider during VERIFY.
 *
 * Output style matches `extractInsights`: 2-4 short prose sentences,
 * no bullets, no JSON, framed as "if the consensus is wrong, X may be
 * the reason." The pollinator does NOT claim the consensus IS wrong
 * — it surfaces a plausible failure mode for the candidates to weigh
 * against their own reasoning.
 */
export async function extractAdversarialInsights(
  input: ExtractInsightsInput,
): Promise<PollinatorResult> {
  // N=1 allowed — mid-mode (CODING.md §17.13) collapses to one peer
  // post-synthesis; adversarial framing ("if this fix is wrong, why?")
  // works on a single artifact, just becomes a critique instead of
  // a comparison.
  if (input.artifacts.length < 1)
    return { insights: '', usage: { ...ZERO_USAGE } };
  const candidatesBlock = input.artifacts
    .map(
      (a, i) =>
        `=== AGENT ${i + 1} (${a.name}) ===\n${clampCandidate(a.content)}`,
    )
    .join('\n\n');
  const promptText = [
    `You are reviewing ${input.artifacts.length} parallel EDIT diffs from coding agents working on the same task. The peers may have converged on a similar fix (correlated reasoning), or genuinely disagreed.`,
    '',
    `USER REQUEST:\n${input.userRequest.slice(0, 1500)}`,
    '',
    'Assume the consensus diff is WRONG. What is the most likely reason it would fail to fix the bug? Consider:',
    '- A method body is a no-op stub when it should do real work.',
    '- The wrong file or class was modified — the actual bug is elsewhere.',
    '- An off-by-one, null-check, or boundary case the peers all missed.',
    '- The diff fixes a symptom, not the root cause.',
    '- The diff breaks an unrelated invariant the failing test does not exercise.',
    '',
    'Output 2-4 short prose sentences. No bullets, no JSON. Frame as "if this fix is wrong, the most likely reason is X" or "the consensus may have missed Y." Never claim the fix IS wrong — frame as a plausible failure mode for peers to weigh.',
    '',
    candidatesBlock,
  ].join('\n');
  const model = input.modelOverride ?? DEFAULT_INSIGHTS_MODEL;
  let text: string;
  try {
    text = await input.provider.complete(
      {
        model,
        messages: [
          { role: 'system', content: INSIGHTS_SYSTEM_PROMPT },
          { role: 'user', content: promptText },
        ],
        maxTokens: 4_000,
        temperature: 0,
      },
      input.signal,
    );
  } catch (err) {
    console.warn(
      `[extractAdversarialInsights] failed: ${
        (err as Error).message
      } — returning empty insights`,
    );
    return { insights: '', usage: { ...ZERO_USAGE } };
  }
  const insights = text.trim().slice(0, MAX_INSIGHTS_OUTPUT_CHARS);
  console.log(
    `[pollinator/${input.variant}/adversarial] model=${model} text=${JSON.stringify(
      insights,
    )}`,
  );
  return { insights, usage: { calls: 1 } };
}

/**
 * Combine normal + adversarial insights into a single nudge body.
 * Empty string when both are empty.
 */
export function buildAdversarialNudge(
  normalInsights: string,
  adversarialInsights: string,
): string {
  const parts: string[] = [];
  const n = normalInsights.trim();
  const a = adversarialInsights.trim();
  if (n.length > 0) {
    parts.push('PEER DISAGREEMENTS (where peers contested each other):', n, '');
  }
  if (a.length > 0) {
    parts.push(
      'POSSIBLE FAILURE MODES (if the consensus fix is wrong, why might it be wrong?):',
      a,
      '',
    );
  }
  if (parts.length === 0) return '';
  parts.push(
    'These are NOT directives. Engage where relevant; ignore where your own evidence is stronger. Use them to sanity-check your VERIFY plan.',
  );
  return parts.join('\n');
}

/**
 * Build the user-message-prefix nudge that gets injected into each
 * session before the next step. Empty string when insights is empty.
 */
export function buildPeerInsightsNudge(insights: string): string {
  if (!insights.trim()) return '';
  return [
    'PEER INSIGHTS (from parallel agents working on the same task; consider both sides without bias):',
    insights.trim(),
    '',
    'These are points of disagreement among peers — not directives. Engage with them where relevant; ignore them where your own evidence is stronger.',
  ].join('\n');
}
