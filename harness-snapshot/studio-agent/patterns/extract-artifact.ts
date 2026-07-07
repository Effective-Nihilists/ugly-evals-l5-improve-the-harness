/**
 * extract-artifact — read the canonical artifact a step produced.
 *
 * Used by the patterns engine for two things:
 *   - cross-pollination max-mode: feed N candidate artifacts into the
 *     insights extractor between steps (see patterns/extract-insights.ts).
 *   - end-of-pattern picker: compare candidate artifacts in max-mode at
 *     the terminal step to choose a winner.
 *
 * In the monolith this walked each peer's `getHistory()` message log and
 * shelled out to git/fs to recover the artifact. In ugly-code we don't
 * expose per-peer history; the host materializes the peer's git diff and
 * its `.specs` doc for us (via MaxModeCallbacks.getPeerDiff / getPeerSpec)
 * and hands the already-extracted text in as `ExtractInput`. So this
 * module is now a pure per-kind selector over those fields.
 *
 * Each artifact kind has a stable extraction strategy with a fallback
 * shaped by the consumer:
 *
 *   - PROSE-shaped kinds (`prose`, `research-notes`, `spec`,
 *     `diagnosis`, `proposal`) feed into an LLM picker / insights
 *     extractor. An empty string would skew the LLM's comparison —
 *     fall back to the last assistant text so a candidate that ran
 *     and produced rationale isn't misranked vs one that didn't.
 *
 *   - MACHINE-shaped kinds (`diff`, `repro`, `verify-output`) feed
 *     into deterministic consumers (`git apply`, a bash runner, a
 *     test-output parser). Prose is worse than empty here: the
 *     grader's `git apply <prose>` emits "No valid patches in input"
 *     instead of the correct "empty diff" path. Return empty string
 *     so consumers handle the no-output case explicitly.
 *
 * Observed 2026-05-09 group-A-cheap on ansible: a hung peer's diff
 * extracted as the prose `(empty)` (the lastAssistantText fallback
 * for a peer that produced no text), then the SBP grader rejected
 * it as not-a-patch and reported 0/5 with a confusing "No valid
 * patches" error instead of the correct "empty diff" 0/5 path.
 */
import type { PickerArtifactKind } from './types';

export interface ExtractInput {
  /** Which artifact this step produces — selects the extraction strategy. */
  kind: PickerArtifactKind;
  /**
   * Materialized git diff for the candidate session (host-read via
   * `getPeerDiff`). Source for the `diff` kind. Empty string = no diff.
   */
  diff: string;
  /**
   * Materialized spec/diagnosis/proposal/research-notes doc text
   * (host-read from `<cwd>/.specs/*.md` via `getPeerSpec`). Source for
   * the prose-doc kinds. Empty string = no doc written.
   */
  spec: string;
  /**
   * Last non-empty assistant text from the candidate's turn — the
   * universal prose fallback, and the direct source for the
   * `prose` / `verify-output` / `repro` kinds.
   */
  lastAssistantText?: string;
}

const MAX_ARTIFACT_CHARS = 12_000;

function clamp(s: string): string {
  return s.length <= MAX_ARTIFACT_CHARS
    ? s
    : `${s.slice(0, MAX_ARTIFACT_CHARS)}\n... [truncated; ${
        s.length - MAX_ARTIFACT_CHARS
      } chars cut]`;
}

export function extractArtifact(input: ExtractInput): string {
  const { kind, diff, spec } = input;
  const lastAssistantText = input.lastAssistantText ?? '';
  switch (kind) {
    case 'spec':
    case 'diagnosis':
    case 'research-notes':
    case 'proposal': {
      // Prose-shaped — fed to the LLM picker / insights extractor. Fall
      // back to the last assistant text so a candidate that produced
      // rationale but no `.specs` doc isn't misranked vs one that did.
      if (spec.trim().length > 0) return clamp(spec);
      return clamp(lastAssistantText.length > 0 ? lastAssistantText : '(empty)');
    }
    case 'diff': {
      // Machine-shaped — fed to `git apply` in the SBP grader.
      // Empty string for "no diff", never prose. See file header.
      return diff ? clamp(diff) : '';
    }
    case 'repro':
    case 'verify-output': {
      // Machine-shaped — the recipe/output is fed to a bash runner or a
      // test-output parser. Empty string, never prose, when the host
      // materialized no assistant text for this step.
      return lastAssistantText ? clamp(lastAssistantText) : '';
    }
    case 'prose': {
      return clamp(lastAssistantText.length > 0 ? lastAssistantText : '(empty)');
    }
    default: {
      // Exhaustiveness guard — surface a clear error if a new kind is
      // added to the union without a case here.
      const _exhaustive: never = kind;
      throw new Error(`extractArtifact: unhandled kind ${String(_exhaustive)}`);
    }
  }
}
