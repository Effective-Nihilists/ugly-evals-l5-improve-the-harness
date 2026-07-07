// Boundary criteria-grader judge — ported from ugly-studio f5a74c2^:
// server/coding-agent/patterns/{derive-criteria,grade-against-criteria}.ts,
// adapted to a `judge(system,user)` completion (no-tools /api/agentStep) instead
// of a raw provider. Governed + metered (unlike a private recursive_llm socket).
//
// Flow: derive an acceptance rubric from the request/spec → grade the BUILD diff
// per-criterion → REVISE prompt from the failing subset. Every LLM call is
// best-effort: a failure degrades to "no criteria / no REVISE pressure".

/** No-tools LLM completion. Returns the raw model text. */
export type Judge = (system: string, user: string, maxTokens?: number) => Promise<string>;

export interface AcceptanceCriterion { id: string; statement: string; rationale: string }
export interface CriterionVerdict { id: string; pass: boolean; reason: string; evidence?: string }
export interface GradeResult { verdicts: CriterionVerdict[]; parsed: boolean; failing: CriterionVerdict[] }

const MAX_CRITERIA = 12;
const MIN_CRITERIA = 2;
const MAX_DIFF_CHARS = 12_000;

const DERIVE_SYSTEM = [
  'You convert a software-engineering request into a CHECKABLE acceptance rubric.',
  '',
  'Each criterion you emit must be:',
  '- SPECIFIC. Name the file, function, method, or symbol involved.',
  '- INDEPENDENTLY VERIFIABLE. A reviewer reading the diff should be able to decide pass/fail by inspecting the change alone.',
  '- ATOMIC. One claim per criterion.',
  "- GROUNDED in the user's request and the spec. Do not invent requirements neither describes.",
  '',
  'Output strict JSON only — no preamble, no markdown fences. Schema:',
  '[',
  '  {"id": "C1", "statement": "<one sentence>", "rationale": "<one sentence — why this matters>"}',
  ']',
  '',
  'Return 4-8 criteria. Skew toward fewer + sharper. Every item must be one a maintainer reviewing the diff would actually check.',
].join('\n');

const GRADE_SYSTEM = [
  'You are a code-review judge. You evaluate whether a code diff satisfies an explicit acceptance rubric. One verdict per criterion. Be specific and falsifiable; cite file/line or the relevant diff snippet when calling pass.',
  '',
  'For each criterion, decide pass or fail:',
  '- pass = the diff demonstrably satisfies the criterion. Cite the line or symbol that proves it.',
  '- fail = the diff does not satisfy the criterion (missing, wrong key/type, wrong path, or the file/function the criterion names is unchanged).',
  '',
  'When uncertain, prefer fail with a specific reason — the survivor will get a chance to revise. False-pass is worse than false-fail.',
  '',
  'Output strict JSON only — no preamble, no markdown fences. Schema:',
  '[',
  '  {"id": "C1", "pass": true, "reason": "<one sentence>", "evidence": "<file:line or snippet>"}',
  ']',
  '',
  'Use the criterion ids exactly as given. One verdict per criterion. No commentary outside the JSON.',
].join('\n');

function extractJsonArray(text: string): unknown[] | null {
  const first = text.indexOf('[');
  const last = text.lastIndexOf(']');
  if (first === -1 || last === -1 || last <= first) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(first, last + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function clampDiff(s: string): string {
  return s.length <= MAX_DIFF_CHARS ? s : `${s.slice(0, MAX_DIFF_CHARS)}\n... [truncated ${s.length - MAX_DIFF_CHARS} chars]`;
}

/** Derive an acceptance rubric from the request (+ optional spec text). */
export async function deriveCriteria(userRequest: string, spec: string, judge: Judge): Promise<AcceptanceCriterion[]> {
  const user = [
    `USER REQUEST:\n${userRequest.slice(0, 2000)}`,
    ...(spec.trim() ? ['', `SPEC:\n${spec.slice(0, 4000)}`] : []),
    '',
    'Return the JSON array of criteria. No preamble, no fences.',
  ].join('\n');
  let raw: string;
  try { raw = await judge(DERIVE_SYSTEM, user, 4000); } catch { return []; }
  const arr = extractJsonArray(raw);
  if (!arr) return [];
  const criteria: AcceptanceCriterion[] = [];
  for (const item of arr) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id.trim() : '';
    const statement = typeof r.statement === 'string' ? r.statement.trim() : '';
    if (!id || !statement) continue;
    criteria.push({ id, statement, rationale: typeof r.rationale === 'string' ? r.rationale.trim() : '' });
    if (criteria.length >= MAX_CRITERIA) break;
  }
  return criteria.length >= MIN_CRITERIA ? criteria : [];
}

/** Grade a diff against acceptance criteria; reconcile missing verdicts as fail. */
export async function gradeAgainstCriteria(userRequest: string, criteria: AcceptanceCriterion[], diff: string, judge: Judge): Promise<GradeResult> {
  if (criteria.length === 0) return { verdicts: [], parsed: false, failing: [] };
  const criteriaBlock = criteria.map((c) => `${c.id}. ${c.statement}\n   Rationale: ${c.rationale}`).join('\n\n');
  const diffBlock = clampDiff(diff.trim());
  const user = [
    'Grade the diff below against the acceptance criteria. Emit one verdict per criterion.',
    '',
    `USER REQUEST:\n${userRequest.slice(0, 2000)}`,
    '',
    'ACCEPTANCE CRITERIA:',
    criteriaBlock,
    '',
    'DIFF:',
    diffBlock.length > 0 ? diffBlock : '(empty diff — no files were edited)',
    '',
    'Return the JSON array of verdicts. One per criterion, ids matching exactly. No preamble, no fences.',
  ].join('\n');
  let raw: string;
  try { raw = await judge(GRADE_SYSTEM, user, 4000); } catch { return { verdicts: [], parsed: false, failing: [] }; }
  const arr = extractJsonArray(raw);
  if (!arr) return { verdicts: [], parsed: false, failing: [] };
  const byId = new Map<string, CriterionVerdict>();
  for (const item of arr) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id.trim() : '';
    if (!id) continue;
    const evidence = typeof r.evidence === 'string' && r.evidence.trim() ? r.evidence.trim() : undefined;
    byId.set(id, { id, pass: r.pass === true, reason: typeof r.reason === 'string' ? r.reason.trim() : '', ...(evidence ? { evidence } : {}) });
  }
  // Reconcile to the ordered criteria list — missing → fail (keeps REVISE deterministic).
  const verdicts: CriterionVerdict[] = criteria.map((c) => byId.get(c.id) ?? { id: c.id, pass: false, reason: '(grader did not return a verdict for this criterion)' });
  return { verdicts, parsed: true, failing: verdicts.filter((v) => !v.pass) };
}

/** Detect REMOVAL/REPLACEMENT-style criteria (the add-without-remove failure mode). */
function isRemovalCriterion(statement: string, reason: string): boolean {
  const text = `${statement} ${reason}`.toLowerCase();
  return (
    /\b(remove|removed|removal|delete|deleted|deletion|drop)\b/.test(text) ||
    /\bno longer\b/.test(text) || /\bnot present\b/.test(text) || /\bnot allowed\b/.test(text) || /\bmust not\b/.test(text) ||
    /\breplaced (?:by|with)\b/.test(text) || /\binstead of\b/.test(text) || /\brather than\b/.test(text) || /\bin place of\b/.test(text)
  );
}

/** Build the targeted REVISE body from failing criteria. Empty when nothing fails. */
export function buildRevisePrompt(failing: CriterionVerdict[]): string {
  if (failing.length === 0) return '';
  const items = failing.map((v) => {
    const base = `- ${v.id}: ${v.reason}${v.evidence ? ` [${v.evidence}]` : ''}`;
    return isRemovalCriterion('', v.reason)
      ? `${base}\n  → DELETE THE OLD CODE — do not just add the replacement next to it.`
      : base;
  });
  return [
    'REVISE. The implementation does not yet satisfy these acceptance criteria:',
    '',
    ...items,
    '',
    'Fix exactly these gaps. Do not re-spec or expand scope. When done, end your turn.',
  ].join('\n');
}
