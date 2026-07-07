// Pattern engine types — ported from ugly-studio f5a74c2^:server/coding-agent/patterns/types.ts.
// ugly-code advances steps on natural stop (no per-iter judge in the turn loop), so
// the judge-only fields (`judgePromptOverride`, `maxIters`, `askUserBudget`) are kept
// optional for registry parity but unused by the client-agent driver. `stepVariant` /
// `pickerArtifact` are consumed by the model-axis hosts (extract-insights / extract-artifact /
// picker).
import type { ToolName } from '../../../../shared/agent';

/** PatternIds for resolved (post-classifier) patterns. */
export type PatternId =
  | 'spec-build-verify'
  | 'super-spec-build-verify'
  | 'quick-edit'
  | 'investigate-fix'
  | 'super-investigate-fix'
  | 'chat-qa'
  | 'chat-advisory';

export const NAMED_PATTERN_IDS: readonly PatternId[] = [
  'spec-build-verify',
  'super-spec-build-verify',
  'quick-edit',
  'investigate-fix',
  'super-investigate-fix',
  'chat-qa',
  'chat-advisory',
] as const;

export function isPatternId(s: unknown): s is PatternId {
  return typeof s === 'string' && (NAMED_PATTERN_IDS as readonly string[]).includes(s);
}

export type SuperPatternId = 'super-spec-build-verify' | 'super-investigate-fix';

export function isSuperPattern(p: PatternId | null): p is SuperPatternId {
  return p === 'super-spec-build-verify' || p === 'super-investigate-fix';
}

/**
 * Map a super pattern id to the base pattern id whose step sequence it shares
 * (identity for non-super ids). Used at the dispatch boundary so step lookups
 * and mid-mode-host run against the base pattern; the super id lives only at
 * the orchestration layer.
 */
export function superToBasePattern(p: PatternId): PatternId {
  if (p === 'super-spec-build-verify') return 'spec-build-verify';
  if (p === 'super-investigate-fix') return 'investigate-fix';
  return p;
}

/**
 * Every step id across all named patterns. Steps are unique within a pattern,
 * not globally (e.g. `verify` appears in spec-build-verify and investigate-fix).
 *   spec-build-verify: spec, build, verify
 *   quick-edit:        edit, verify-touched
 *   investigate-fix:   repro, diagnose, fix, verify
 *   chat-qa:           answer
 *   chat-advisory:     research, synthesize
 */
export type StepId =
  | 'spec'
  | 'build'
  | 'verify'
  | 'edit'
  | 'verify-touched'
  | 'repro'
  | 'diagnose'
  | 'fix'
  | 'answer'
  | 'research'
  | 'synthesize';

export const ALL_STEP_IDS: readonly StepId[] = [
  'spec',
  'build',
  'verify',
  'edit',
  'verify-touched',
  'repro',
  'diagnose',
  'fix',
  'answer',
  'research',
  'synthesize',
] as const;

export function isStepId(s: unknown): s is StepId {
  return typeof s === 'string' && (ALL_STEP_IDS as readonly string[]).includes(s);
}

/** Step variant id — selects insightsPrompt and (if terminal) finalPickerPrompt. */
export type StepVariantId =
  | 'spec'
  | 'edit'
  | 'verify'
  | 'diagnosis'
  | 'repro'
  | 'quick-edit'
  | 'verify-touched'
  | 'prose-answer'
  | 'research-notes'
  | 'proposal';

/** Artifact kind extracted from a step's run for picker / insights / carryover. */
export type PickerArtifactKind =
  | 'spec'
  | 'diagnosis'
  | 'diff'
  | 'repro'
  | 'verify-output'
  | 'prose'
  | 'research-notes'
  | 'proposal';

export interface Step {
  /** Stable strict-typed id used for telemetry / UI / snapshot. */
  id: StepId;
  /** Display label for the step strip. */
  label: string;
  /** Injected via user-message decoration (not the system prompt), so the
   *  cacheable system prefix stays byte-stable across step transitions. */
  systemPromptTail: string;
  /** Production-only fragment that mentions `ask_user`; appended to the step
   *  decoration by `renderStepDecoration`. */
  askUserClause?: string;
  /** Hard allow-list — the live `tools` getter filters to only these. Unset =
   *  full tool access (BUILD / VERIFY / FIX / EDIT). */
  allowedTools?: readonly ToolName[];
  toolDescriptionSuffixes?: Partial<Record<ToolName, string>>;
  /** Replaces the per-iter judge system prompt (unused under natural-stop). */
  judgePromptOverride?: string;
  /** Natural-language criterion the judge checks for "step done". */
  advanceCriteria: string;
  /** Advisory only under natural-stop advancement (kept for registry parity). */
  maxIters?: number;
  askUserBudget?: number;
  /** Default 'until-judge-advances'. 'one-shot' → the driver sends once. */
  loops?: 'until-judge-advances' | 'one-shot';
  /** Selects insights + final-picker prompt variants (model axis). */
  stepVariant: StepVariantId;
  /** Artifact kind extracted at step end for picker/insights/carryover. */
  pickerArtifact: PickerArtifactKind;
  /** When true, this step's stepVariant supplies the finalPickerPrompt. */
  isTerminal?: boolean;
  /**
   * When true, the driver pauses after this step and waits for the user to
   * approve advancing or send feedback that loops the model back through this
   * same step. Ignored on terminal steps. Set on SPEC + DIAGNOSE.
   */
  pauseForUserReviewAfter?: boolean;
  /**
   * When true, after this (write-capable) step the driver runs the acceptance
   * rubric grade loop (deriveCriteria → gradeAgainstCriteria → REVISE) before
   * advancing. Set on BUILD / FIX / EDIT. Replaces the monolith's hardcoded
   * `step.id === 'build'` gate.
   */
  gradeAfter?: boolean;
}

export interface Pattern {
  id: PatternId;
  /** Display label for the pattern strip header. */
  label: string;
  /** One-line description shown in tooltips and docs. */
  description: string;
  steps: Step[];
}
