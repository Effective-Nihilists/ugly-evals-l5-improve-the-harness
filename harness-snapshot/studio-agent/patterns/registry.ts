/**
 * Pattern registry — the static data for every named pattern.
 * Ported from ugly-studio f5a74c2^:server/coding-agent/patterns/registry.ts;
 * allow-lists intersected with ugly-code's ToolName union (shared/agent.ts) —
 * note `dev_server_screenshot` is monolith-only and intentionally absent here.
 *
 * The `super-*` variants reuse the base patterns' `steps` arrays literally
 * (reference equality). The runtime translates super ids to base ids at the
 * dispatch boundary via `superToBasePattern()`; the super id lives only at the
 * model-axis (mid-mode) orchestration layer.
 *
 * `gradeAfter` marks the write-capable steps (build / fix / edit) after which the
 * driver runs the acceptance-rubric grade loop before advancing — ugly-code's
 * natural-stop analog of the monolith's per-iter judge.
 */
import type { ToolName } from '../../../../shared/agent';
import type { Pattern, PatternId, Step } from './types';

// Read-only-flavored allow-list (hard-removes the edit family at the tool layer).
// bash + python_exec stay callable for tests / AST walks; the suffixes below warn
// against mutating the workspace through them.
const READ_ONLY_TOOL_ALLOWLIST: readonly ToolName[] = [
  'read',
  'grep',
  'glob',
  'bash',
  'python_exec',
  'python_libraries',
  'spec_write',
  'spec_read',
  'ask_user',
  'web_search',
  'web_fetch',
  'dep_docs',
  'analyze_image',
  'scratchpad',
  'memory_read',
  'memory_save',
  'memory_list',
  'memory_delete',
  'todos',
  'dev_server_start',
  'dev_server_stop',
  'dev_server_logs',
  'dev_server_errors',
];

const READ_ONLY_TOOL_SUFFIXES: Partial<Record<ToolName, string>> = {
  bash: '\n\nREAD-ONLY STEP RULE: Do NOT modify the workspace via this shell — no file writes (redirects > / >> to source files), no in-place edits (sed -i, perl -i, awk -i), no destructive ops (rm, mv on tracked files). Read-only queries (cat, ls, grep, git status, test runners) and tempfile work under /tmp are fine. The dedicated `edit` / `multiedit` / `write` tools are unavailable this step — they will be re-enabled when the next step opens.',
  python_exec:
    "\n\nREAD-ONLY STEP RULE: Do NOT mutate workspace files in this script — no `open(path, 'w'/'a')` on source paths, no `Path.write_text` / pathlib writes, no `shutil` mutations under cwd. AST walks, libcst inspect, pathlib reads, requests fetches are all fine. Tempfile work under /tmp is fine. The dedicated edit tools are unavailable this step.",
};

// SPEC gets the read-only base PLUS the edit family (the user often asks for a
// visual scaffold alongside the spec; a model without `write` fakes it via bash
// heredocs and burns turns). Only SPEC opens edit; DIAGNOSE / REPRO / RESEARCH
// stay strictly read-only.
const SPEC_TOOL_ALLOWLIST: readonly ToolName[] = [
  ...READ_ONLY_TOOL_ALLOWLIST,
  'write',
  'edit',
  'multiedit',
];

const SPEC_STEP: Step = {
  id: 'spec',
  label: 'Spec',
  allowedTools: SPEC_TOOL_ALLOWLIST,
  systemPromptTail: [
    'Step: SPEC. You are designing a NEW FEATURE. The output of this step is a buildable design document — not a bug-investigation report.',
    '',
    'Before writing the spec, perform FEATURE DESIGN ANALYSIS:',
    '',
    '(1) DATA MODEL. Enumerate every collection / table the feature needs. For each: name, key fields, scope (per-user / per-family / global), real-time sync requirements. Use the framework idioms you find in the existing codebase (e.g. ugly-app projects: Zod schemas + defineCollections in shared/collections.ts).',
    '',
    '(2) API SURFACE. List EVERY endpoint by its concrete name and the action it performs. Do NOT collapse multiple actions into a generic "respond" or "action" endpoint — if the user mentions snooze, no-show, reschedule, mark-arrived, and mark-left, the spec must name FIVE distinct endpoints. Granularity at the design layer is mandatory; the executor cannot re-derive endpoint names from a generic description. For each endpoint: name, auth shape (req / authReq), input keys, output keys, and the side-effect (DB write, push broadcast, etc.).',
    '',
    '(3) UI SURFACE. Enumerate pages, routes, and the components on each. For each user-visible action, name the endpoint it calls. If the user asked for multiple design variants, name each variant explicitly (e.g. "Calm / Sharp / Warm / Minimal / Playful") so the executor knows what to render.',
    '',
    "(4) BACKGROUND WORK. List cron jobs, scheduled notifications, webhook handlers, etc. with their trigger conditions and what they do. Don't abstract a 7:30 AM check-in and a 5:30 PM check-out into one generic 'scheduled notification job' — name each one.",
    '',
    '(5) USER FLOWS. Walk through the 3-5 most important flows end-to-end. Each flow names the entry point (UI click / push notification tap), the endpoint hit, the data mutated, and the resulting broadcast / notification. Flows reveal missing endpoints faster than feature-list reviews.',
    '',
    'Write the spec via `spec_write` covering goal, scope, non-goals, the five analysis sections above, and testable acceptance criteria. Every acceptance criterion must cite a specific endpoint, collection, page, or job by NAME — not just describe desired user-facing behavior.',
    '',
    "ARTIFACTS ALONGSIDE THE SPEC: when the user explicitly asks for a visualization (interactive HTML demo, mockup page, schema sketch, etc.), produce it via the `write` / `edit` / `multiedit` tools as part of this step — do NOT fake it through `bash` heredocs or `python_exec` triple-quoted strings. Don't write implementation code in SPEC; the BUILD step implements the design against the real codebase.",
    '',
    'Once the spec exists and any explicitly-requested demo artifact is written, END YOUR TURN. Do not keep working — the orchestrator advances to BUILD on its own.',
  ].join('\n'),
  askUserClause:
    'You may call `ask_user` (budget 2) when the requested scope is genuinely ambiguous, but never to ask the user to approve your plan.',
  advanceCriteria:
    'Spec exists with all four sections (goal / scope / non-goals / acceptance criteria) and acceptance criteria are testable.',
  judgePromptOverride: [
    'You are judging the SPEC step of the spec-build-verify pattern.',
    'Verdict `advance` once a spec doc exists with all four sections (goal / scope / non-goals / testable acceptance criteria), even if the model has also produced an explicitly-requested demo/mockup artifact alongside it. Do not hold the step open waiting for additional polish — the user reviews the spec at the gate that fires after this step.',
    'Verdict `intervene` only if the model is refactoring existing source (renaming functions, restructuring modules, etc.) — those edits belong in BUILD, not SPEC. Standalone new files (demos, mockups, scaffolds) are fine when the user asked for them.',
  ].join('\n'),
  stepVariant: 'spec',
  pickerArtifact: 'spec',
  pauseForUserReviewAfter: true,
};

const BUILD_STEP: Step = {
  id: 'build',
  label: 'Build',
  systemPromptTail: [
    'Step: BUILD.',
    'Implement the spec produced in the previous step. Edits + targeted reads only.',
    'Do not re-spec. The spec is fixed at this point.',
    '',
    'THREE-FIX RULE: if you have already cycled BUILD → VERIFY 3 times without resolving the failing tests, STOP iterating on the current direction. End your turn with an explicit statement: "I have tried 3 fix-cycles without success; the bug may be at a different architectural layer than I have targeted. Possible structural causes: [enumerate the alternative directions you have considered]." The orchestrator will route this back for re-spec rather than letting you thrash on the same surface fix.',
  ].join(' '),
  askUserClause:
    'You may call `ask_user` (budget 2) only when you discover a real spec/implementation conflict that requires the user to resolve.',
  advanceCriteria: 'Implementation matches every acceptance criterion in the spec.',
  judgePromptOverride: [
    'You are judging the BUILD step of the spec-build-verify pattern.',
    'Verdict `advance` when the implementation satisfies every acceptance criterion stated in the spec.',
    'Verdict `intervene` if the model is re-specifying or scope-creeping beyond the spec.',
  ].join('\n'),
  stepVariant: 'edit',
  pickerArtifact: 'diff',
  gradeAfter: true,
};

const VERIFY_STEP: Step = {
  id: 'verify',
  label: 'Verify',
  systemPromptTail: [
    'Step: VERIFY.',
    'Run tests, lint, and tsc on touched modules. Fix only regressions caused by the change.',
    'Do not refactor or expand scope.',
    '',
    'RED-GREEN-REVERT-RED-GREEN PROTOCOL: for any test that the user referenced as a regression guard for this change, validate that the test is actually load-bearing for your fix.',
    '(1) Run the test against the current (post-fix) state. Confirm GREEN.',
    '(2) Revert your fix temporarily — `git stash`, or comment out the change.',
    '(3) Re-run the test. It must turn RED, and the failure message must match the symptom your fix addresses. If the test stays GREEN here, the test is NOT testing your fix — it was passing for unrelated reasons. Investigate before claiming completion.',
    '(4) Restore the fix (`git stash pop`, or uncomment) and re-run. Confirm GREEN again.',
    'Skip this protocol only when the change does not affect any user-named test (e.g. pure refactor, doc update).',
  ].join(' '),
  advanceCriteria: 'All gates pass, or only pre-existing failures remain.',
  judgePromptOverride: [
    'You are judging the VERIFY step.',
    'Verdict `advance` when all relevant gates (tests, lint, tsc) pass — or when only pre-existing failures remain.',
    'Verdict `intervene` if the model is rewriting code beyond regression fixes.',
  ].join('\n'),
  stepVariant: 'verify',
  pickerArtifact: 'verify-output',
  isTerminal: true,
};

const SPEC_BUILD_VERIFY: Pattern = {
  id: 'spec-build-verify',
  label: 'Spec → Build → Verify',
  description:
    'Non-trivial new behavior or any change with unclear scope. Spec is approved before code is written; verify gates ensure the spec is met.',
  steps: [SPEC_STEP, BUILD_STEP, VERIFY_STEP],
};

const SUPER_SPEC_BUILD_VERIFY: Pattern = {
  id: 'super-spec-build-verify',
  label: 'Super Spec → Build → Verify',
  description:
    'Hard novel features. Wide SPEC (N peers + frontier synthesis), narrow BUILD/VERIFY (single survivor). Same steps as spec-build-verify; the orchestrator routes through mid-mode-host.',
  steps: SPEC_BUILD_VERIFY.steps,
};

const QUICK_EDIT: Pattern = {
  id: 'quick-edit',
  label: 'Quick edit',
  description:
    'One-shot small change (typo, copy, one-liner). No spec. Escalates to investigate-fix if the change turns out to be larger than expected.',
  steps: [
    {
      id: 'edit',
      label: 'Edit',
      systemPromptTail: [
        'Step: QUICK EDIT.',
        'Make the smallest change that satisfies the user request. One edit, maybe two.',
        'No spec, no refactor. If the change appears to need more than this, the harness will escalate to a richer pattern automatically.',
        'If the request mentions multiple call sites, files, or symbols (e.g. "rename X across all callers", "update the function and all consumers"), you MUST locate and edit ALL of them — not just the first one. Use grep/glob to find every site, then edit each one.',
      ].join(' '),
      askUserClause:
        'You may call `ask_user` (budget 1) only when there is a genuine referent ambiguity (e.g. "which button?").',
      advanceCriteria:
        'A targeted edit (or set of edits) was actually applied via `edit` / `multiedit` / `write` tool calls AND the agent has confirmed it covered every call site / file the request mentioned. Reading source files alone is NOT sufficient — the diff must contain real edits.',
      judgePromptOverride: [
        'You are judging the EDIT step of the quick-edit pattern.',
        'Verdict `advance` ONLY when the agent has actually executed `edit` / `multiedit` / `write` tool calls AND those edits cover every call site / file the user request mentioned. Read / grep tool calls alone are NOT enough — there must be real edits in the conversation history.',
        'Verdict `continue` when the agent has only read / grepped but has not yet edited; or when it edited only a partial subset of the call sites the request named (the model needs to keep going).',
        'Verdict `intervene` only if the model is over-scoping (touching unrelated files or refactoring).',
      ].join('\n'),
      stepVariant: 'quick-edit',
      pickerArtifact: 'diff',
      gradeAfter: true,
    },
    {
      id: 'verify-touched',
      label: 'Verify (touched files)',
      systemPromptTail: [
        'Step: VERIFY-TOUCHED.',
        'Run lint and tsc on touched files only. Fix regressions in those files. Stop.',
      ].join(' '),
      advanceCriteria:
        'Lint and tsc pass on touched files (pre-existing failures elsewhere are fine).',
      judgePromptOverride: [
        'You are judging the VERIFY-TOUCHED step.',
        'Verdict `advance` when lint and tsc pass on the files touched by the prior step.',
      ].join('\n'),
      stepVariant: 'verify-touched',
      pickerArtifact: 'verify-output',
      isTerminal: true,
    },
  ],
};

const INVESTIGATE_FIX: Pattern = {
  id: 'investigate-fix',
  label: 'Investigate → Fix',
  description:
    'Bug or perf issue with unknown root cause. Diagnoses first, fixes second. Escalates to spec-build-verify if the diagnosis reveals a need for architectural work.',
  steps: [
    {
      id: 'repro',
      label: 'Repro',
      allowedTools: READ_ONLY_TOOL_ALLOWLIST,
      toolDescriptionSuffixes: READ_ONLY_TOOL_SUFFIXES,
      systemPromptTail: [
        'Step: REPRO.',
        'Reproduce the bug yourself. Run the failing test (or a minimal command that triggers it) via `bash` and confirm you SEE the failure output. Reading the test file is not enough — you must actually execute the failing path and confirm the failure.',
        'Use grep, codebase-search, read, and bash as needed.',
        'Do not edit source in this step — investigation only.',
        'After you confirm the failure, the harness will automatically advance you to the DIAGNOSE step where you write the diagnosis. Do NOT stop your turn here — keep working until the failure is reproduced.',
      ].join(' '),
      askUserClause:
        'You may call `ask_user` (budget 1) only when reproducing requires information only the user has (account, env, exact steps).',
      advanceCriteria:
        'A concrete repro recipe has been EXECUTED and confirmed to fail. A bash tool call ran the relevant test/command and the agent has the failure output in its history. Reading source files alone is NOT sufficient.',
      judgePromptOverride: [
        'You are judging the REPRO step of the investigate-fix pattern.',
        'Verdict `advance` ONLY when the agent has actually executed (via bash) the failing test or a minimal trigger command AND has the failure output in the conversation history. Reading test source files without running them is NOT enough — investigate-fix is the harder pattern and requires real repro evidence before diagnosis.',
        'Verdict `continue` when the agent has only viewed source files but not run anything yet. The agent should make a bash call to run the test before this step can advance.',
        'Verdict `intervene` if the model edited source files (this is out-of-scope for REPRO).',
      ].join('\n'),
      stepVariant: 'repro',
      pickerArtifact: 'repro',
    },
    {
      id: 'diagnose',
      label: 'Diagnose',
      allowedTools: READ_ONLY_TOOL_ALLOWLIST,
      toolDescriptionSuffixes: READ_ONLY_TOOL_SUFFIXES,
      systemPromptTail: [
        'Step: DIAGNOSE.',
        '',
        'Before writing the diagnosis, perform STRUCTURAL ANALYSIS:',
        '',
        '(1) CALL-SITE ENUMERATION. For every symbol implicated in the failure, grep / glob to find every call site. List them in the diagnosis. A parameter threaded through many call sites without modification is a smell — it may belong at module scope.',
        '',
        "(2) RUN THE FAILING TEST FIRST. When the user's request names (or clearly implicates) a failing test, EXECUTE it via `bash` (pytest / jest / go test / cargo test / etc.) BEFORE writing your diagnosis — capture the actual failure traceback in your context. Then read the test source literally: argument count, types, monkeypatched module attributes, expected return shape. Ground the diagnosis in OBSERVED output, not hypothesized output. The traceback is your evidence; the diagnosis must agree with it. Skip this step ONLY if no failing test is named.",
        '',
        '(3) SYMPTOM vs CAUSE. The user describes user-visible pain. Ask: what STRUCTURAL change would make the pain dissolve as a side-effect? Surface fixes often patch a symptom whose root is one architectural layer up.',
        '',
        '(4) SCOPE EXPANSION IS ALLOWED. If your analysis surfaces an architectural change the user did not request but that cleanly resolves the reported issue, propose it as the candidate fix AND flag the expansion explicitly. Do not be timid about going broader when the analysis warrants it; do tell the reviewer.',
        '',
        'Write findings to `spec_write` as a diagnosis note: symptom, root cause (cited to specific code locations), candidate fixes with tradeoffs (including any scope expansion). Do not edit source — wait for the FIX step.',
        '',
        'After spec_write, the harness will automatically advance you to FIX where you make the edits. Do NOT stop your turn here — call spec_write before the turn ends.',
      ].join('\n'),
      askUserClause:
        'You may call `ask_user` (budget 1) only when there are 2+ root causes with materially different blast radius.',
      advanceCriteria:
        'Diagnosis names a single root cause and at least one candidate fix.',
      judgePromptOverride: [
        'You are judging the DIAGNOSE step.',
        'Verdict `advance` when the diagnosis names a single root cause with code-pointer evidence and at least one candidate fix.',
        'Verdict `intervene` if the model edited source instead of diagnosing.',
      ].join('\n'),
      stepVariant: 'diagnosis',
      pickerArtifact: 'diagnosis',
      pauseForUserReviewAfter: true,
    },
    {
      id: 'fix',
      label: 'Fix',
      systemPromptTail: [
        'Step: FIX.',
        'Apply the chosen fix from the diagnosis via real `edit` / `multiedit` / `write` tool calls. Stay within the scope of the named root cause.',
        '',
        'THREE-FIX RULE: if you have already cycled FIX → VERIFY 3 times without resolving the failing tests, STOP iterating on the current direction. End your turn with an explicit statement: "I have tried 3 fix-cycles without success; the bug may be at a different architectural layer than I have targeted. Possible structural causes: [enumerate the alternative directions you have considered]." The orchestrator will route this back for re-diagnosis rather than letting you thrash on the same surface fix.',
        '',
        'After your edits, the harness will automatically advance you to VERIFY where you re-run the test. Do NOT stop your turn here on the first iteration — keep working until the edits are in place.',
      ].join(' '),
      askUserClause:
        'You may call `ask_user` (budget 1) when a workaround vs root-cause fix would diverge in user-visible blast radius.',
      advanceCriteria:
        'Real edits have been applied via `edit` / `multiedit` / `write` tool calls AND those edits implement the fix from the diagnosis. The conversation history must contain the actual edit tool calls, not just a written description.',
      judgePromptOverride: [
        'You are judging the FIX step of the investigate-fix pattern.',
        'Verdict `advance` ONLY when the agent has actually executed `edit` / `multiedit` / `write` tool calls implementing the fix described in the prior diagnosis step. Reading or describing the fix is NOT enough.',
        'Verdict `continue` when the agent has not yet made the actual edits.',
        'Verdict `intervene` if the fix expands scope beyond the diagnosis.',
      ].join('\n'),
      stepVariant: 'edit',
      pickerArtifact: 'diff',
      gradeAfter: true,
    },
    {
      id: 'verify',
      label: 'Verify',
      systemPromptTail: [
        'Step: VERIFY.',
        'Re-run the repro. Run tests, lint, tsc on the touched paths.',
        '',
        'RED-GREEN-REVERT-RED-GREEN PROTOCOL: validate that the failing test you reproduced in REPRO is actually load-bearing for your fix.',
        '(1) Run the test against the current (post-fix) state. Confirm GREEN.',
        '(2) Revert your fix temporarily — `git stash`, or comment out the change.',
        '(3) Re-run the test. It must turn RED, and the failure message must match the symptom from REPRO. If the test stays GREEN here, the test is NOT testing your fix — it was passing for unrelated reasons. Investigate before claiming completion.',
        '(4) Restore the fix (`git stash pop`, or uncomment) and re-run. Confirm GREEN again.',
      ].join(' '),
      advanceCriteria: 'Repro no longer reproduces and gates pass.',
      judgePromptOverride: [
        'You are judging the VERIFY step.',
        'Verdict `advance` when the repro no longer reproduces and gates pass.',
      ].join('\n'),
      stepVariant: 'verify',
      pickerArtifact: 'verify-output',
      isTerminal: true,
    },
  ],
};

const SUPER_INVESTIGATE_FIX: Pattern = {
  id: 'super-investigate-fix',
  label: 'Super Investigate → Fix',
  description:
    'Hard bugs (stub-traps, misleading stack traces, data-layer perf). Wide REPRO+DIAGNOSE (N peers + frontier synthesis), narrow FIX/VERIFY (single survivor). Same steps as investigate-fix; the orchestrator routes through mid-mode-host.',
  steps: INVESTIGATE_FIX.steps,
};

const CHAT_QA: Pattern = {
  id: 'chat-qa',
  label: 'Chat (Q&A)',
  description:
    'Direct factual or how-it-works answer. No code edits. Escalates to chat-advisory if the question is judged open-ended enough to warrant a researched proposal.',
  steps: [
    {
      id: 'answer',
      label: 'Answer',
      systemPromptTail: [
        'Step: ANSWER.',
        "Answer the user's question directly. No code edits, no spec.",
        'Use web_search / web_fetch only if you need a current fact. Use grep/read only if the answer requires repo context.',
        'Keep the response tight. Do not pad with caveats unless the user explicitly asked for completeness.',
      ].join(' '),
      askUserClause:
        'You may call `ask_user` (budget 1) only when the question is genuinely under-specified (e.g. "which one?" / "in what context?").',
      advanceCriteria:
        'A non-empty answer was produced. The judge pins to advance after the first non-empty assistant message.',
      judgePromptOverride: [
        'You are judging the ANSWER step of the chat-qa pattern.',
        'Verdict `advance` after the first non-empty assistant message.',
        'Verdict `intervene` only if the model started editing source files (clear misroute).',
      ].join('\n'),
      loops: 'one-shot',
      stepVariant: 'prose-answer',
      pickerArtifact: 'prose',
      isTerminal: true,
    },
  ],
};

const CHAT_ADVISORY: Pattern = {
  id: 'chat-advisory',
  label: 'Chat (advisory)',
  description:
    'Open-ended planning or strategy. Two steps: research, then synthesize into a proposal via spec_write.',
  steps: [
    {
      id: 'research',
      label: 'Research',
      allowedTools: READ_ONLY_TOOL_ALLOWLIST,
      toolDescriptionSuffixes: READ_ONLY_TOOL_SUFFIXES,
      systemPromptTail: [
        'Step: RESEARCH.',
        'Gather the context you need to answer well. Use web_search, web_fetch, codebase-search, and read as needed.',
        'Note key sources. Do not edit source. Do not synthesize the proposal yet — wait for the SYNTHESIZE step.',
      ].join(' '),
      askUserClause:
        'You may call `ask_user` (budget 1) when the user\'s framing is genuinely ambiguous (e.g. "for what audience?").',
      advanceCriteria:
        'The agent has cited concrete sources or repo signals covering the dimensions implied by the prompt.',
      judgePromptOverride: [
        'You are judging the RESEARCH step.',
        "Verdict `advance` when the agent has cited concrete sources or repo signals covering the dimensions of the user's prompt.",
        'Verdict `intervene` if the model edited source or wrote a proposal in this step.',
      ].join('\n'),
      stepVariant: 'research-notes',
      pickerArtifact: 'research-notes',
    },
    {
      id: 'synthesize',
      label: 'Synthesize',
      systemPromptTail: [
        'Step: SYNTHESIZE.',
        'Produce the proposal by calling `spec_write` with the full proposal as the body. Cover the dimensions the user asked about; cite the research from the previous step.',
        'Be concrete, not generic. After `spec_write` succeeds, end the turn — do not also restate the proposal as chat.',
      ].join(' '),
      advanceCriteria:
        "`spec_write` has been called with a body that addresses every dimension implied by the user's prompt with non-trivial recommendations.",
      judgePromptOverride: [
        'You are judging the SYNTHESIZE step.',
        "Verdict `advance` when `spec_write` has been called with a body that addresses every dimension implied by the user's prompt with non-trivial, concrete recommendations.",
        'Verdict `intervene` if the proposal is generic boilerplate or ignores the prior research notes.',
      ].join('\n'),
      stepVariant: 'proposal',
      pickerArtifact: 'proposal',
      isTerminal: true,
    },
  ],
};

export const PATTERN_REGISTRY: Record<PatternId, Pattern> = {
  'spec-build-verify': SPEC_BUILD_VERIFY,
  'super-spec-build-verify': SUPER_SPEC_BUILD_VERIFY,
  'quick-edit': QUICK_EDIT,
  'investigate-fix': INVESTIGATE_FIX,
  'super-investigate-fix': SUPER_INVESTIGATE_FIX,
  'chat-qa': CHAT_QA,
  'chat-advisory': CHAT_ADVISORY,
};

/** Patterns that can be picked by the classifier. */
export const CLASSIFIABLE_PATTERN_IDS: PatternId[] = [
  'spec-build-verify',
  'super-spec-build-verify',
  'quick-edit',
  'investigate-fix',
  'super-investigate-fix',
  'chat-qa',
  'chat-advisory',
];

/** Look up a pattern by id. Returns undefined for unknown ids (e.g. 'none'). */
export function getPattern(id: string): Pattern | undefined {
  return (PATTERN_REGISTRY as Record<string, Pattern>)[id];
}

export function getStep(patternId: PatternId, stepId: string): Step | undefined {
  return PATTERN_REGISTRY[patternId].steps.find((s) => s.id === stepId);
}

export function getTerminalStep(patternId: PatternId): Step {
  const terminal = PATTERN_REGISTRY[patternId].steps.find((s) => s.isTerminal);
  if (!terminal) throw new Error(`pattern ${patternId} has no terminal step`);
  return terminal;
}

export { READ_ONLY_TOOL_ALLOWLIST, SPEC_TOOL_ALLOWLIST, READ_ONLY_TOOL_SUFFIXES };
