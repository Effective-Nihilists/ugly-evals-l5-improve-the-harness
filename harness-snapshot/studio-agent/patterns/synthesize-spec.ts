/**
 * synthesize-spec — mid-mode super-spec builder.
 *
 * Mid-mode (CODING.md §17.13) spawns N cheap peers for SPEC only,
 * then collapses to ONE peer for EDIT/REVISE/VERIFY. The collapse
 * boundary needs a single ground-truth spec to inject into the
 * survivor's session, replacing the divergent N peer specs with one
 * consolidated view.
 *
 * That's what `synthesizeSpec` does. A frontier model reads:
 *   - the original user request (the ticket)
 *   - all N peer SPEC artifacts
 * and emits ONE consolidated super-spec. The system prompt explicitly
 * forbids:
 *   - diff suggestions / code blocks (frontier model is meant to PLAN,
 *     not implement — implementation belongs to the cheap survivor)
 *   - file path hints beyond what peers already named (lets the
 *     survivor explore based on its own context)
 *   - hedging / "consider X or Y" framing (super-spec must be
 *     decisive — the survivor needs ground truth, not more options)
 *
 * Cross-bias note: the synthesis output is then injected into the
 * survivor session as a synthetic user message ("Great spec, here's a
 * corrected version from teammate review"). The survivor reads this
 * and treats it as authoritative — same channel as a real user
 * correction. Reasoning continuity is preserved BECAUSE the survivor
 * was one of the SPEC-writers; its own conversation history aligns
 * with the user-correction message.
 */
import type { PeerProvider } from './peerTypes';

const DEFAULT_SYNTHESIS_MODEL = 'deepseek_v4_pro';
const MAX_CANDIDATE_CHARS = 12_000;
// Raised from 4_000 → 12_000 (2026-05-19) for the feature-spec redesign.
// The new synthesizer prompt asks for enumerated sections (Data Model /
// API Endpoints / UI / Background Work / User Flows) which can run
// 8-10K chars on a non-trivial feature. The prior 4K cap silently
// truncated the synthesizer mid-section, dropping the User Flows or
// half the API endpoint list — observed in the 2026-05-18
// nanny-tracker run where 6+ enumerated endpoints collapsed to one.
const MAX_SUPER_SPEC_CHARS = 12_000;

const SYSTEM_PROMPT = [
  'You consolidate parallel coding-agent FEATURE-DESIGN specs into one buildable super-spec for the executing agent.',
  '',
  "Each peer block contains whatever they produced — typically a structured spec with sections for data model, API surface, UI, background work, and user flows. Synthesize the BEST design you can from the peer specs, grounded in the user's original request.",
  '',
  'CORE PRINCIPLE: PRESERVE ENUMERATION.',
  'The peers did the hard work of enumerating endpoints, collections, pages, jobs, and flows by name. The executor cannot re-derive those names from abstract prose. Your job is to PICK and MERGE — not COMPRESS. If two peers list the same five endpoints, the consolidated spec lists those five endpoints by name. If peers disagree on a name, pick one (with a one-line tiebreaker) and use it throughout. NEVER collapse "snooze, no-show, reschedule, mark-arrived, mark-left" into "an interaction endpoint with an action field" — granularity is the deliverable.',
  '',
  'OUTPUT STRUCTURE (use these section headers verbatim; omit a section ONLY when the user request and peer specs have no content for it):',
  '',
  '## Goal',
  'One paragraph: what the feature does, who uses it, what the success criterion is.',
  '',
  '## Data Model',
  "List each collection / table by name. For each: key fields (in code-style backticks), scope (`per-user` / `per-family` / `global`), real-time sync requirements, and any cross-collection links. Use the framework idiom from the user's project (e.g. ugly-app projects: `defineCollections` + Zod schemas in `shared/collections.ts`).",
  '',
  '## API Endpoints',
  'Bullet-list EVERY endpoint by name. One line per endpoint: `endpointName` (req | authReq) — input shape, output shape, side-effects. Resolve peer name disagreements here with a one-line decision. NEVER abstract multiple action endpoints into one generic dispatcher — if the peers enumerated 5 endpoints, list 5 endpoints.',
  '',
  '## UI',
  'List each page / route by name and the components on each. For each user-visible action, name the endpoint it calls. When the user asked for multiple design variants, name each variant (e.g. "Calm / Sharp / Warm / Minimal / Playful") and state which is the default-built one.',
  '',
  '## Background Work',
  "Cron jobs, scheduled notifications, webhook handlers. Each with trigger, frequency, and what it does. Don't abstract a 7:30 AM check-in and a 5:30 PM check-out into one generic 'scheduled notification job' — name each.",
  '',
  '## User Flows',
  'Walk through the 3-5 most important flows end-to-end. Each flow: entry → endpoint hit → data mutated → broadcast/notification. Flows reveal missing endpoints; if a flow you write requires an endpoint not in the API section, add the endpoint.',
  '',
  'OUTPUT RULES:',
  '- Plain prose + bullet lists. No code blocks, no diffs, no function bodies.',
  '- NO hedging ("consider X or Y", "might want to"). Pick and commit.',
  '- NO "I cannot synthesize" — author the spec yourself from the user request + peer fragments. Silence means the executor gets nothing.',
  '- When peers contradict on a NAME, pick one with a one-line tiebreaker. When they contradict on STRUCTURE, pick the structure that better fits the user request.',
  "- Length is whatever it takes to preserve enumeration. Do NOT compress; the spec is the executor's source of truth and the API endpoint names need to survive the round-trip verbatim.",
  '',
  'CONTRARIAN REVIEWER (handling a tagged minority view). One peer block may be marked `[CONTRARIAN REVIEWER — minority view, NOT consensus]`. Treat that peer separately:',
  '- The other peers form the CONSENSUS reading — merge them as above.',
  '- The contrarian offers a structurally adversarial ALTERNATIVE design. Their spec is NOT a vote — do not blend into consensus prose.',
  '- If the contrarian explicitly stated "I cannot find a credible alternative" (or equivalent), OMIT any alternative section.',
  '- If the contrarian proposed a credible alternative architecture, append a section labelled `## Alternative Architecture (from contrarian reviewer)` AFTER the consensus spec body. Two short paragraphs: (a) the alternative design, (b) the strongest piece of evidence supporting it.',
  '- Do NOT argue for or against the alternative. Surface it; the executor weighs it during BUILD if the consensus path fails.',
].join('\n');

export interface SynthesizeSpecInput {
  /** Original user request — the ticket. */
  userRequest: string;
  /**
   * N peer SPEC artifacts. Index = peer ordinal, name = model id.
   * `isContrarian` flags one peer as the structural dissenter
   * (CODING.md §17.19) — their spec is rendered as a tagged minority
   * view in the synthesizer's input so the prompt can preserve the
   * alternative reading instead of blending it into consensus prose.
   */
  artifacts: { name: string; content: string; isContrarian?: boolean }[];
  /** AbortSignal threaded from the driver. */
  signal?: AbortSignal;
  /** No-tools completion provider used to issue the synthesis call. */
  provider: PeerProvider;
  /** Override the default synthesizer model. */
  modelOverride?: string;
}

export interface SynthesizeSpecResult {
  superSpec: string;
}

function clampCandidate(s: string): string {
  return s.length <= MAX_CANDIDATE_CHARS
    ? s
    : `${s.slice(0, MAX_CANDIDATE_CHARS)}\n... [truncated]`;
}

/**
 * Build a rich per-peer synthesis input from spec.md + recent
 * exploration text. In ugly-code the host provides the peer's spec
 * text and (optionally) the last assistant/exploration text directly
 * — the synthesizer needs broader context than spec.md alone, since
 * peers that hit phase-timeout mid-exploration may have written only a
 * single sentence of spec.
 *
 * Returns: spec.md (if any) + recent exploration text, joined with
 * section markers. Total clamped to MAX_CANDIDATE_CHARS.
 */
export function extractSynthesisInputForPeer(args: {
  spec: string;
  recentText?: string;
}): string {
  const sections: string[] = [];
  const trimmedSpec = args.spec.trim();
  if (trimmedSpec && trimmedSpec.length > 0) {
    sections.push(`(spec.md)\n${trimmedSpec.slice(0, 4000)}`);
  }
  const recent = args.recentText?.trim();
  if (recent && recent.length > 0) {
    sections.push(`(recent exploration)\n${recent}`);
  }
  if (sections.length === 0) {
    return '(no exploration captured)';
  }
  return clampCandidate(sections.join('\n\n'));
}

/**
 * Build the consolidated super-spec from N peer SPECs. Throws if the
 * frontier model fails — caller decides whether to abort the run or
 * fall back to one peer's individual spec.
 */
export async function synthesizeSpec(
  input: SynthesizeSpecInput,
): Promise<SynthesizeSpecResult> {
  if (input.artifacts.length === 0) {
    throw new Error('synthesizeSpec: artifacts[] empty');
  }
  const consensusCount = input.artifacts.filter((a) => !a.isContrarian).length;
  const contrarianCount = input.artifacts.length - consensusCount;
  const candidatesBlock = input.artifacts
    .map((a, i) => {
      const tag = a.isContrarian
        ? ' [CONTRARIAN REVIEWER — minority view, NOT consensus]'
        : '';
      return `=== AGENT ${i + 1} (${a.name})${tag} ===\n${clampCandidate(
        a.content,
      )}`;
    })
    .join('\n\n');
  const headerLine =
    contrarianCount > 0
      ? `You are reviewing ${consensusCount} parallel CONSENSUS SPEC outputs and ${contrarianCount} CONTRARIAN minority-view spec(s) from coding agents working on the same user request. Consolidate the consensus peers into ONE super-spec the executing agent will use as ground truth; surface the contrarian's view separately per the rules above (handle "no credible alternative" outputs by omitting the alternative section).`
      : `You are reviewing ${input.artifacts.length} parallel SPEC outputs from coding agents working on the same user request. Consolidate them into ONE super-spec the executing agent will use as ground truth.`;
  const promptText = [
    headerLine,
    '',
    `USER REQUEST:\n${input.userRequest.slice(0, 4000)}`,
    '',
    'Produce the consolidated super-spec using the section headers (`## Goal`, `## Data Model`, `## API Endpoints`, `## UI`, `## Background Work`, `## User Flows`) and rules from the system prompt above. Preserve every name the peers enumerated; resolve disagreements with explicit judgment.',
    '',
    candidatesBlock,
  ].join('\n');

  const provider = input.provider;
  const model = input.modelOverride ?? DEFAULT_SYNTHESIS_MODEL;
  const text = await provider.complete(
    {
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: promptText },
      ],
      // Raised from 4_000 → 8_000 (2026-05-19): enumerated feature spec
      // sections need ~6-8K output tokens to preserve API endpoint lists
      // + user flows without mid-section truncation.
      maxTokens: 8_000,
      temperature: 0,
    },
    input.signal,
  );
  const superSpec = text.trim().slice(0, MAX_SUPER_SPEC_CHARS);
  console.log(
    `[synthesize-spec] model=${model} text=${JSON.stringify(superSpec)}`,
  );
  return { superSpec };
}

/**
 * Two injection styles:
 *
 * `'advisory'` (default) — soft framing: "great spec, here are
 * corrections." Preserves the model's sense of agency / continuity
 * with its own draft. Used when the survivor's pre-synthesis context
 * is reasonably focused.
 *
 * `'imperative'` — directive framing: "execute this spec now, use
 * edit/multiedit/write, stop exploring." Used when the survivor's
 * pre-synthesis context was confused (synth-A v4 scored 0/5 because
 * advisory framing reinforced the survivor's already-existing
 * tendency to explore rather than edit).
 *
 * Toggled via `UGLY_MID_INJECT_STYLE=imperative` env var read in
 * mid-mode-host.
 */
export type InjectionStyle = 'advisory' | 'imperative';

export function buildSurvivorInjectionPrompt(
  superSpec: string,
  style: InjectionStyle = 'advisory',
): string {
  if (style === 'imperative') {
    // Bug-fix shape. Used by super-investigate-fix where the spec
    // describes a concrete fix to apply and a failing test to verify
    // against. "End your turn" is correct because the diagnosis loop
    // is complete; iteration would be re-spec'ing instead of fixing.
    return [
      'EXECUTE THIS SPEC NOW.',
      '',
      'A reviewer consolidated the team analysis into the authoritative spec below. Take it as ground truth — your prior exploration is superseded.',
      '',
      'CONSOLIDATED SPEC:',
      superSpec,
      '',
      'Apply the fix using `edit` / `multiedit` / `write`. The diagnosis is COMPLETE — do NOT continue exploring, do not write more spec, do not run more diagnostic commands beyond what the spec calls for. After editing, run the failing test once to verify it passes, then end your turn.',
    ].join('\n');
  }
  // Feature-build shape (default for super-spec-build-verify). The
  // consolidated spec is a buildable design with enumerated sections
  // (Data Model / API Endpoints / UI / Background Work / User Flows).
  // The survivor builds from it and IS EXPECTED to iterate when it
  // discovers gaps the synthesizer's compression dropped — e.g. a
  // user flow that requires an endpoint not listed in the API
  // section. The framing must permit iteration; "end your turn" is
  // wrong here because the BUILD step is naturally multi-iter.
  //
  // Strengthened 2026-05-19 after r5 baseline (8/25 vs flash single
  // 20/25): the soft "team explored / use as authoritative design"
  // opener was being treated as additive context by the survivor
  // (deepseek_v4_flash), which then implemented only the things
  // mentioned in the ORIGINAL user prompt (family + scheduler + demo)
  // and ignored the spec's 13 enumerated endpoints. The replacement
  // below opens with an explicit supersedure of the prior user
  // message, enumerates the implementation contract with a concrete
  // checklist + file paths, and adds a verification clause that
  // requires touching every section before the turn can end.
  return [
    'BUILD CONTRACT — this message supersedes the original task brief in this conversation. Treat the spec below as the authoritative source of truth for what to implement; the original prompt was a feature request, this is the design you build to.',
    '',
    'CONSOLIDATED SPEC:',
    superSpec,
    '',
    'IMPLEMENTATION CONTRACT:',
    '1. EVERY collection in `## Data Model` becomes a `defineCollections` entry in `shared/collections.ts` with its Zod schema + indexes.',
    '2. EVERY endpoint in `## API Endpoints` becomes BOTH (a) an `authReq()` (or `req()`) declaration in `shared/api.ts` AND (b) a matching handler in the `requests` object in `server/index.ts`. The endpoint NAMES in the spec are the wire names — do not rename, do not consolidate two named endpoints into one generic dispatcher.',
    '3. EVERY page in `## UI` becomes a React component under `client/pages/`, registered in `client/allPages.ts` and routed via `shared/pages.ts`. If the spec named UI variants (e.g. Calm / Sharp / Warm / Minimal / Playful), build the default variant fully; the other variants can be sketched as separate pages or as a variant prop on shared components, but their NAMES must appear somewhere in the codebase.',
    '4. EVERY job in `## Background Work` is a real scheduled/triggered handler in `server/`, named as the spec named it.',
    '5. EVERY flow in `## User Flows` must work end-to-end against the endpoints and collections you built. If a flow needs an endpoint the spec did not enumerate, ADD IT (the spec is a starting design, not an exhaustive contract) — but do not skip a flow because its endpoint is missing.',
    '',
    'BEFORE ENDING YOUR TURN:',
    '- Confirm every section above has at least one corresponding file change in the diff.',
    '- Run `tsc --noEmit` (via the bash tool) — must exit 0.',
    '- If any section is unimplemented at turn end, the build is INCOMPLETE; keep iterating.',
    '',
    'NOTE: this consolidated spec is also persisted as the session spec — `spec_read` (or reading the project spec via the file tools) returns this same text. Use that if you need to reload the spec mid-build after history compaction; do not re-synthesize.',
  ].join('\n');
}
