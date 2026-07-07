// Joint router / pattern classifier for `patternMode: 'auto'` — ported from
// ugly-studio f5a74c2^:server/coding-agent/patterns/classify.ts, adapted to a
// governed judge() call (one no-tools completion) instead of a raw provider stream.
//
// A single call decides: which base pattern fits, and how hard the task is. A
// deterministic post-processor promotes spec-build-verify → super-spec-build-verify
// and investigate-fix → super-investigate-fix when difficulty ≥ DEFAULT_MAX_THRESHOLD.
// Confidence < 0.4 OR top-2 within 0.10 → caller falls back to a plain single-send.
import { CLASSIFIABLE_PATTERN_IDS } from './registry';
import type { Judge } from './judge';
import type { PatternId } from './types';

export interface ClassifyOutput {
  pattern: PatternId;
  confidence: number;
  runnerUp?: PatternId;
  runnerUpConfidence?: number;
  /** 0..1. ≥ DEFAULT_MAX_THRESHOLD promotes eligible base patterns to super. */
  difficulty: number;
  reason: string;
  /** Set when the classifier failed to produce parseable JSON; caller falls back. */
  parseError?: string;
}

/** Difficulty at/above which eligible base patterns promote to their super variant. */
export const DEFAULT_MAX_THRESHOLD = 0.7;

const FALLBACK: ClassifyOutput = {
  pattern: 'spec-build-verify',
  confidence: 0,
  difficulty: 0.5,
  reason: 'classifier failed; falling back to spec-build-verify / 0.5 difficulty (safest defaults)',
  parseError: 'no parseable response',
};

const SYSTEM_PROMPT = [
  "You are a routing classifier for a coding agent. Given the user's first message of a session, decide which execution pattern to run and how difficult the task is (which determines whether to fan out N parallel models).",
  '',
  'PATTERNS:',
  '  - spec-build-verify — genuinely-novel behavior or new surface area (new pages, new tools, new endpoints, new features). Bug repair, perf fixes, and "something is broken" requests are NEVER spec-build-verify — they belong in investigate-fix even when the cause is unclear.',
  '    Examples: "add a settings page with theme toggle", "build a webhook receiver for stripe", "add a new /export endpoint that streams CSV".',
  '  - quick-edit — one-shot small change (typo, copy, one-liner, simple rename).',
  '    Examples: "fix the typo on the landing page", "rename foo to bar in this file", "change the error message".',
  '  - investigate-fix — any request to repair, fix, restore, or unbreak existing behavior — including bare imperatives like "fix it", "this is broken", "X stopped working", "regression". Use this even when no stacktrace is provided; diagnosis happens INSIDE the pattern (repro → diagnose → fix → verify). Also covers perf issues with unknown cause.',
  '    Examples: "fix it", "the login button is broken", "this query is slow", a pasted stacktrace, an attached `git diff`.',
  '  - chat-qa — direct factual or how-it-works answer. No code edits. Bare questions with no imperative verb.',
  '    Examples: "what is the cheapest LLM provider?", "how does the authentication work in this repo?".',
  '  - chat-advisory — open-ended planning / strategy that wants a researched proposal, not an edit.',
  '',
  'Output the BASE pattern name (`spec-build-verify` / `quick-edit` / `investigate-fix` / `chat-qa` / `chat-advisory`). Do NOT prefix with `super-`. The harness automatically promotes `spec-build-verify` → `super-spec-build-verify` and `investigate-fix` → `super-investigate-fix` when difficulty ≥ 0.7. Your job is to set difficulty honestly; the promotion is deterministic.',
  '',
  "`spec-build-verify` is the most expensive pattern. Pick it ONLY when the user is clearly asking for NEW behavior. If the prompt could plausibly be repair (fix / repair / unbreak / restore / patch, or \"X is broken\", \"X doesn't work\", \"regression in Y\"), prefer investigate-fix.",
  '',
  'DIFFICULTY (0..1) — bias TOWARD the higher end when any deceptive-scope cue applies, even if the surface sounds local:',
  '  - 0.0 .. 0.3 — trivial. Typo, single-line change, simple rename in one file.',
  '  - 0.3 .. 0.6 — routine. Bug fix in a known location, single-component feature, scoped multi-file rename with explicit call sites.',
  '  - 0.6 .. 0.8 — non-trivial. Multi-file refactor without an explicit callsite list, feature touching several components, debug with non-obvious cause.',
  '  - 0.8 .. 1.0 — hard. Architectural change, novel system, stub-trap (a method that exists but "doesn\'t work"), data-layer perf, misleading stack trace, "why is X broken/flaky/slow" with no obvious local fix.',
  '',
  'OUTPUT (strict JSON, no prose, no fences):',
  '  {"pattern": "<spec-build-verify | quick-edit | investigate-fix | chat-qa | chat-advisory>", "confidence": <0..1>, "runnerUp": "<optional pattern id>", "runnerUpConfidence": <optional 0..1>, "difficulty": <0..1>, "reason": "<ONE short sentence, under 25 words>"}',
  '',
  'Output the JSON object and nothing else.',
].join('\n');

const STACKTRACE_RE =
  /(?:^|\n)(?:\s*at\s+\w[\w.$]*\s*\([^\n]+:\d+:\d+\)|^\s*Error:|TypeError:|SyntaxError:|stack\s*trace)/im;
const DIFF_RE = /^\s*(?:diff --git|---\s+[ab]\/|\+\+\+\s+[ab]\/)/m;
const TRACE_WORD_RE = /(?:^|\W)(?:traceback|stacktrace|panic:)/i;
const QUESTION_RE = /^(?:what|which|how|when|where|why|who|does|do|is|are|can)\b/i;
const CODE_REF_RE =
  /(?:`[^`]+`|\.[a-z]{1,4}\b|\/[a-z]+|implement|build|fix|add|remove|delete|refactor|rename)/i;

/** Cheap deterministic shortcuts for obvious cases (skip the LLM call). */
export function heuristicShortcut(userMessage: string): ClassifyOutput | null {
  const text = userMessage.trim();
  if (STACKTRACE_RE.test(text) || DIFF_RE.test(text) || TRACE_WORD_RE.test(text)) {
    return {
      pattern: 'investigate-fix',
      confidence: 0.92,
      difficulty: 0.55,
      reason: 'message contains a stacktrace / error signature / git diff — clearly an investigation.',
    };
  }
  if (text.length < 200 && QUESTION_RE.test(text) && !CODE_REF_RE.test(text) && text.includes('?')) {
    return {
      pattern: 'chat-qa',
      confidence: 0.85,
      difficulty: 0.15,
      reason: 'short bare question with no imperative verb and no code references.',
    };
  }
  return null;
}

function isClassifiable(s: string): s is PatternId {
  return (CLASSIFIABLE_PATTERN_IDS as string[]).includes(s);
}

/** Promote base → super when difficulty signals a hard task (deterministic). */
export function promoteSuperIfHard(out: ClassifyOutput): ClassifyOutput {
  if (out.difficulty < DEFAULT_MAX_THRESHOLD) return out;
  if (out.pattern === 'spec-build-verify') return { ...out, pattern: 'super-spec-build-verify' };
  if (out.pattern === 'investigate-fix') return { ...out, pattern: 'super-investigate-fix' };
  return out;
}

function parseClassifier(raw: string): ClassifyOutput {
  const m = /\{[\s\S]*\}/.exec(raw);
  if (!m) return { ...FALLBACK, parseError: 'no JSON object found' };
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(m[0]) as Record<string, unknown>;
  } catch (err) {
    return { ...FALLBACK, parseError: `JSON.parse failed: ${(err as Error).message}` };
  }
  const patternRaw = o.pattern;
  if (typeof patternRaw !== 'string' || !isClassifiable(patternRaw)) {
    return { ...FALLBACK, parseError: `invalid pattern: ${String(patternRaw)}` };
  }
  const clamp = (n: unknown, d: number): number =>
    typeof n === 'number' && n >= 0 && n <= 1 ? n : d;
  const runnerUpRaw = o.runnerUp;
  const runnerUp =
    typeof runnerUpRaw === 'string' && isClassifiable(runnerUpRaw) && runnerUpRaw !== patternRaw
      ? (runnerUpRaw)
      : undefined;
  const runnerUpConfRaw = o.runnerUpConfidence;
  const runnerUpConfidence =
    typeof runnerUpConfRaw === 'number' && runnerUpConfRaw >= 0 && runnerUpConfRaw <= 1
      ? runnerUpConfRaw
      : undefined;
  return {
    pattern: patternRaw,
    confidence: clamp(o.confidence, 0),
    difficulty: clamp(o.difficulty, 0.5),
    reason: typeof o.reason === 'string' ? o.reason.slice(0, 200) : '(no reason)',
    ...(runnerUp ? { runnerUp } : {}),
    ...(runnerUpConfidence !== undefined ? { runnerUpConfidence } : {}),
  };
}

/** Classify the first user message: heuristic shortcut, else one cheap judge call. */
export async function classifyForAuto(userText: string, judge: Judge): Promise<ClassifyOutput> {
  const cleaned = userText.replace(/<project_index>[\s\S]*?<\/project_index>\s*/g, '').trim();
  const shortcut = heuristicShortcut(cleaned);
  if (shortcut) return promoteSuperIfHard(shortcut);
  let raw: string;
  try {
    raw = await judge(SYSTEM_PROMPT, cleaned.slice(0, 4000), 1500);
  } catch (err) {
    return { ...FALLBACK, parseError: `classifier call failed: ${(err as Error).message}` };
  }
  return promoteSuperIfHard(parseClassifier(raw));
}

/**
 * Confident enough to run the classified pattern without disambiguation?
 * Confidence ≥ 0.4 AND (no close runner-up). Not confident → plain single-send.
 */
export function isClassificationConfident(out: ClassifyOutput): boolean {
  if (out.confidence < 0.4) return false;
  if (
    out.runnerUp &&
    out.runnerUpConfidence !== undefined &&
    out.confidence - out.runnerUpConfidence < 0.1
  ) {
    return false;
  }
  return true;
}
