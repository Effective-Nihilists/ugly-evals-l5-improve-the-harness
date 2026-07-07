/**
 * Max-mode picker — terminal-step winner selector.
 *
 * Given N candidate artifacts produced by parallel agent runs at the
 * SAME step, select the winner. The picker is itself an LLM call —
 * `deepseek_v4_flash` by default, an open-source non-reasoning model
 * with a structured-judgment training signal. Cross-bias risk with the
 * candidate pool is acknowledged (deepseek-flash is also a candidate);
 * validate empirically by rotating in a thinking model if the bias is
 * observable in scoring data.
 *
 * In the cross-pollination design (the winning max-mode strategy), the
 * picker fires ONLY at the end of a pattern (typically the verify step)
 * — between non-terminal steps the candidates exchange peer insights via
 * `patterns/extract-insights.ts` and continue running their own sessions.
 *
 * The picker ALWAYS returns a single winner index + a short reason.
 * Ties resolve to lowest index (stable, deterministic).
 */
import type { PeerMessage, PeerProvider } from './peerTypes';
import type { StepVariantId } from './types';

/**
 * Variant id passed into pickWinner. Generalized from the legacy
 * 'spec | edit | verify' triple to one variant per step type so the
 * picker has step-appropriate criteria. Aliased on `StepVariantId` so
 * adding a new step automatically requires a picker prompt.
 */
export type PickerVariantId = StepVariantId;

export interface Candidate {
  /** Slug for the candidate model — e.g. "kimi_k2_7_code". */
  model: string;
  /** Phase artifact: spec markdown / unified diff / test output. */
  artifact: string;
}

export interface PickerInput {
  /** Step variant — selects the per-variant prompt block. */
  variant: PickerVariantId;
  /** The original ticket text the candidates are addressing. */
  ticket: string;
  /** N candidate artifacts (typically 3-5). */
  candidates: Candidate[];
  /** No-tools completion provider the picker call routes through. */
  provider: PeerProvider;
  /** Picker model id. Defaults to `deepseek_v4_flash`. */
  pickerModel?: string;
  /** AbortSignal threaded from the driver. */
  signal?: AbortSignal;
}

export interface PickerOutput {
  winnerIndex: number;
  winnerModel: string;
  reason: string;
  /** Raw judge response for debugging. */
  raw: string;
}

const DEFAULT_PICKER = 'deepseek_v4_flash';

const VARIANT_INSTRUCTIONS: Record<PickerVariantId, string> = {
  'spec': [
    'You are picking the best PLAN among N candidates for fixing a bug or implementing a feature described in a ticket.',
    '',
    'Evaluate each plan against:',
    '  1. Does it correctly identify the root cause / scope? Plans that justify no-op stubs or claim "this method does not need to be implemented" while existing methods on the same class are stubs are usually WRONG — those existing stubs ARE the bug.',
    '  2. Does it propose verifiable concrete steps (file paths, exact methods, code snippets)?',
    '  3. Does it address the actual behavior the ticket describes, not just adjacent symptoms?',
    '',
    'Anti-patterns that should disqualify a plan:',
    '  - Adds a NEW method that returns Promise.resolve() / null / no-op next to existing methods that already do the same thing.',
    '  - Plans that say "minimal change" while ignoring obvious storage-layer gaps the ticket describes.',
    '',
    'Test-file edits — INTENT-DEPENDENT, do not pattern-match:',
    '  - If the ticket is a bug-fix shape (existing failing tests are the verification target, or the ticket says "make X pass"): plans that propose editing those tests are gaming the grader. Disqualify.',
    '  - If the ticket asks for new test coverage / a regression test / "add tests for X": plans that propose NO test work are incomplete. Disqualify.',
    '  - Read the ticket. The correct answer is not "always avoid tests" or "always edit tests" — it depends on what the ticket is asking for.',
  ].join('\n'),
  'edit': [
    'You are picking the best DIFF among N candidates implementing a bug fix.',
    '',
    'Evaluate each diff against:',
    '  1. Does the code change actually fix the bug or just add scaffolding?',
    '  2. Are method bodies real implementations, not no-op returns? `return Promise.resolve()` next to a sibling stub is almost always wrong.',
    '  3. Are the modified files appropriate to the task (see test-file rule below)?',
    '  4. Does the diff fill in existing stubs when the bug is about state that should be tracked? A real `Map<...>` / SQL DELETE / etc. for storage operations.',
    '',
    'Anti-patterns that should disqualify a diff:',
    '  - Net-new stub methods (`return Promise.resolve()` body).',
    '  - Touch-only changes to an interface without backing real implementation.',
    '',
    'Test-file edits — INTENT-DEPENDENT:',
    '  - If the ticket designates specific tests as the verification target (e.g. fail_to_pass / pass_to_pass lists, "make tests/X pass"): editing those tests is grader-gaming. Disqualify.',
    '  - If the ticket asks for new/updated tests as part of the deliverable: a diff with no test work is incomplete. Disqualify.',
    '  - Read the ticket to decide which case applies.',
  ].join('\n'),
  'verify': [
    'You are picking the best VERIFICATION OUTPUT among N candidates.',
    '',
    'Evaluate each verification against:',
    '  1. Does the verification execute the EXACT scenario the ticket describes (concrete values, sequence of operations, the asserted post-condition)?',
    '  2. Was the verification actually run, with concrete pass/fail output? Or did the candidate write a script and never execute it?',
    '  3. Were the assertions tied to the bug behavior, not generic compile checks?',
    '  4. Did the candidate verify against the ORIGINAL tests, or against tests it modified itself? See test-file rule below.',
    '',
    'Anti-patterns:',
    '  - "I wrote the verification but the test runner failed to load" — incomplete.',
    '  - Tests that pass without exercising the bug (vacuous green).',
    '  - Tests that only check the new method exists (signature check), not that it changes state.',
    '',
    'Self-modified-test trap (CRITICAL — recent failure mode):',
    '  - If the ticket designates specific tests as the verification target (bug-fix shape, fail_to_pass list, "make these tests pass"), and a candidate ran "1 passed" only after editing those very tests to fit its new API, that is grader-gaming, not verification. STRONGLY prefer candidates that left the designated tests intact and made the unmodified tests pass — even if their pytest output looks less impressive.',
    '  - When two candidates show similar pass/fail output, the candidate that did NOT modify the designated test files is the better verifier.',
    '  - When the ticket asks for NEW test coverage as the deliverable, the opposite holds — a verification with no new tests fails the task.',
    '  - Read the ticket and decide which shape this is before applying the rule.',
  ].join('\n'),
  'diagnosis': [
    'You are picking the best DIAGNOSIS NOTE among N candidates investigating the same bug.',
    '',
    'Evaluate each diagnosis against:',
    '  1. Does it name a SINGLE concrete root cause with code-pointer evidence (file/method/line)?',
    '  2. Does the proposed fix actually target the named cause (not the symptom)?',
    '  3. If it lists multiple candidate fixes, are tradeoffs explicit (blast radius, scope, reversibility)?',
    '',
    'Anti-patterns that should disqualify a diagnosis:',
    '  - Restates the symptom as the cause ("the function returns the wrong value because the function returns the wrong value").',
    '  - Multiple unranked causes with no recommendation.',
    '  - Fixes that obviously do not address the named cause.',
  ].join('\n'),
  'repro': [
    'You are picking the best REPRO RECIPE among N candidates trying to reproduce the same bug.',
    '',
    'Evaluate each repro against:',
    '  1. Is it deterministic, minimal, and locally executable on the current main branch?',
    '  2. Does the failure it produces actually match the bug described in the ticket?',
    "  3. Does it stand alone (no dependence on the user's machine state, account, network)?",
    '',
    'Anti-patterns:',
    '  - "Should fail somewhere" guesses with no concrete invocation.',
    "  - Repros that depend on the user's machine state, login, or external network state.",
    "  - Repros that don't actually fail when run against the buggy code.",
  ].join('\n'),
  'quick-edit': [
    'You are picking the best SMALL DIFF among N candidates implementing a one-shot user request (typo, copy, one-liner, simple rename).',
    '',
    'Evaluate each diff against:',
    "  1. Is it the smallest correct change that addresses the user's request?",
    '  2. Does it touch only the files the request implies, with zero scope creep?',
    '  3. Are the modified lines confined to the obvious target?',
    '',
    'Anti-patterns:',
    '  - Bundles unrelated cleanup or "while I was here" refactors.',
    '  - Touches files outside the obvious target.',
    '  - Adds new abstractions / helpers when an in-place edit would do.',
  ].join('\n'),
  'verify-touched': [
    'You are picking the best TOUCHED-FILE GATE OUTPUT (lint + tsc on touched files only) among N candidates.',
    '',
    'Evaluate each output against:',
    '  1. Are the touched-file gates green, with regressions caused by the change fixed?',
    '  2. Are pre-existing failures (in untouched code paths) clearly distinguished from new ones?',
    '',
    'Anti-patterns:',
    '  - Pre-existing failures dressed up as new fixes (scope creep into untouched code).',
    '  - Output shows lingering touched-file errors the candidate could have fixed.',
  ].join('\n'),
  'prose-answer': [
    "You are picking the best DIRECT ANSWER among N candidates responding to a user's question.",
    '',
    'Evaluate each answer against:',
    '  1. Is it factually correct (or correctly says "I don\'t know" with a path forward)?',
    '  2. Is it concise — directly answers the question without padding?',
    '  3. Does it cite grounding when claims need support (file references, repo signals, sources)?',
    '',
    'Anti-patterns:',
    '  - Hedging walls of text that never commit to an answer.',
    '  - Restates the question instead of answering it.',
    '  - Adds irrelevant tangents not relevant to what was asked.',
  ].join('\n'),
  'research-notes': [
    'You are picking the best RESEARCH NOTES among N candidates gathering context for an open-ended advisory question.',
    '',
    'Evaluate each set of notes against:',
    "  1. Do the cited sources / repo signals cover every dimension the user's prompt implies?",
    '  2. Are sources concrete and specific (paths, URLs, function names) — not vague summaries?',
    '  3. Is it scoped tightly — no bloat, no padding?',
    '',
    'Anti-patterns:',
    '  - Generic web-search dumps with no synthesis.',
    "  - Sources that don't actually address the question.",
    "  - Padding the notes with content that won't be used in synthesis.",
  ].join('\n'),
  'proposal': [
    'You are picking the best ADVISORY PROPOSAL among N candidates synthesizing an answer to an open-ended planning / strategy question.',
    '',
    'Evaluate each proposal against:',
    '  1. Are the recommendations concrete and tied to specifics from the prompt and the prior research?',
    '  2. Does it cover every dimension the user asked about?',
    '  3. Does it commit to a specific path, with tradeoffs named — rather than offering a generic framework?',
    '',
    'Anti-patterns:',
    '  - Generic frameworks ("identify your audience, set goals, measure") with no specifics.',
    '  - Recommendations that ignore facts surfaced in the prior research notes.',
    '  - Bullet lists of buzzwords without commitments.',
  ].join('\n'),
};

const SYSTEM_PROMPT = [
  'You are an evaluating judge. You compare candidate outputs from parallel coding-agent runs and pick the best one.',
  'Output STRICT JSON with two fields:',
  '  { "winner": <integer index, 0-based>, "reason": "<one-sentence explanation>" }',
  'No prose, no fences, no leading explanation. Only the JSON object.',
].join('\n');

const MAX_ARTIFACT_CHARS = 6000;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... [truncated; ${s.length - max} chars cut]`;
}

function renderUserMessage(input: PickerInput): string {
  const sections: string[] = [];
  sections.push(`STEP VARIANT: ${input.variant}`);
  sections.push('');
  sections.push(VARIANT_INSTRUCTIONS[input.variant]);
  sections.push('');
  sections.push('TICKET:');
  sections.push(truncate(input.ticket, 2000));
  sections.push('');
  for (let i = 0; i < input.candidates.length; i++) {
    const c = input.candidates[i];
    sections.push(`=== CANDIDATE ${i} (model: ${c.model}) ===`);
    sections.push(truncate(c.artifact, MAX_ARTIFACT_CHARS));
    sections.push('');
  }
  sections.push('Pick the best candidate. Output JSON only.');
  return sections.join('\n');
}

function parsePickerResponse(
  raw: string,
  numCandidates: number,
): { winnerIndex: number; reason: string } {
  // Strip optional code fences and find the first JSON object.
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const match = /\{[\s\S]*?"winner"[\s\S]*?\}/.exec(stripped);
  const blob = match ? match[0] : stripped;
  try {
    const parsed = JSON.parse(blob) as { winner?: number; reason?: string };
    const w =
      typeof parsed.winner === 'number' &&
      parsed.winner >= 0 &&
      parsed.winner < numCandidates
        ? parsed.winner
        : 0;
    const reason =
      typeof parsed.reason === 'string' ? parsed.reason : '(no reason)';
    return { winnerIndex: w, reason };
  } catch {
    return { winnerIndex: 0, reason: `(parse failure: ${raw.slice(0, 100)})` };
  }
}

/**
 * Run the picker and return the winning candidate. Falls back to
 * candidate 0 with a `(parse failure)` reason if the judge returns
 * malformed output — the caller can decide whether to retry.
 */
export async function pickWinner(input: PickerInput): Promise<PickerOutput> {
  if (input.candidates.length === 0) {
    throw new Error('pickWinner: candidates[] empty');
  }
  if (input.candidates.length === 1) {
    const only = input.candidates[0];
    return {
      winnerIndex: 0,
      winnerModel: only.model,
      reason: 'only candidate',
      raw: '',
    };
  }
  const messages: PeerMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: renderUserMessage(input) },
  ];
  const provider = input.provider;
  const model = input.pickerModel ?? DEFAULT_PICKER;
  // Cap at 16K — picker prompts can be ~25KB (4-5 candidate diffs +
  // ticket + instructions), and deepseek-flash reasons before text.
  // Without enough headroom the response gets truncated mid-reasoning
  // and no JSON arrives.
  const raw = await provider.complete(
    {
      model,
      messages,
      maxTokens: 16_000,
      temperature: 0,
    },
    input.signal,
  );
  const parsed = parsePickerResponse(raw, input.candidates.length);
  return {
    winnerIndex: parsed.winnerIndex,
    winnerModel: input.candidates[parsed.winnerIndex].model,
    reason: parsed.reason,
    raw,
  };
}
