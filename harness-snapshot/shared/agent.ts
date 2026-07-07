// The Ugly Code coding agent — shared contract between client and server.
//
// The agentic loop runs CLIENT-SIDE (in the Ugly Studio desktop browser): the
// client maintains the message history, calls the `agentStep` endpoint to get
// the next assistant turn (with `tool_use` blocks), executes those tools against
// `window.UglyNative` (native.fs / native.process), feeds `tool_result` blocks
// back, and repeats until the model stops requesting tools. The server is a thin
// shim that adds the system prompt + tool specs and forwards to ugly.bot's
// textGen (which is the only place that can return structured tool_use blocks —
// the client `callTextGen` helper only yields text).

import { z } from 'ugly-app/shared';
import type { TextGenTool } from 'ugly-app/shared';

/** A single chat turn on the wire (mirrors ugly.bot textGen's Message). */
export const contentPartSchema = z.union([
  z.object({
    type: z.literal('text'),
    text: z.string().optional(),
  }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    content: z.string(),
  }),
  // Round-tripped reasoning block some gateways require on assistant history.
  z.object({
    type: z.literal('thinking'),
    thinking: z.string().optional(),
    signature: z.string().optional(),
    redacted_data: z.string().optional(),
  }),
]);

export const agentMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.union([z.string(), z.array(contentPartSchema)]),
});

export type AgentContentPart = z.infer<typeof contentPartSchema>;
export type AgentMessage = z.infer<typeof agentMessageSchema>;

// Tool names the client dispatches against the native API. These mirror the
// monolith's bare names (`read`/`write`/`edit`/`bash`) rather than the earlier
// `read`/`bash` port, so the system prompt is monolith-faithful.
// (`codebase_search` was folded into `grep`'s semantic mode; `list_dir` was
// dropped — the monolith uses `glob`/`bash ls` for directory listings.)
export const AGENT_TOOL_NAMES = [
  'read',
  'write',
  'edit',
  'bash',
  'database',
  'database_sql_query',
] as const;
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

/**
 * The SINGLE SOURCE OF TRUTH for every tool name the agent can emit — shared by
 * the tool definitions (AGENT_TOOLS here + the client registry's ToolModules)
 * and the chat UI. Both sides type against `ToolName`, so a rename is a
 * compile-time error on every side instead of a silent string drift. Never
 * compare `tool.name` against a raw string literal in the UI — the literal must
 * be a `ToolName` or the build fails ("no overlap").
 */
export type ToolName =
  // COMMON (always on)
  | 'read'
  | 'write'
  | 'edit'
  | 'multiedit'
  | 'glob'
  | 'grep'
  | 'bash'
  | 'todos'
  | 'python_exec'
  | 'web_fetch'
  // single-mode
  | 'spec_read'
  | 'spec_write'
  | 'scratchpad'
  | 'memory_read'
  | 'memory_save'
  | 'memory_list'
  | 'memory_delete'
  | 'delegate'
  | 'delegate_parallel'
  | 'ask_user'
  | 'web_search'
  | 'analyze_image'
  | 'dep_docs'
  | 'python_libraries'
  | 'tool_search'
  | 'tool_request'
  // group-mode
  | 'blackboard_post'
  // ugly-app project
  | 'database'
  | 'database_sql_query'
  | 'dev_server_start'
  | 'dev_server_stop'
  | 'dev_server_logs'
  | 'dev_server_errors'
  | 'inspect_ux';

/** A model-facing tool spec whose `name` is constrained to a known `ToolName`. */
export type AgentToolSpec = Omit<TextGenTool, 'name'> & { name: ToolName };

/**
 * Compare a wire tool name (an untyped `string` off the model) against a known
 * tool. The `tool` argument is a `ToolName`, so the UI can only branch on names
 * that actually exist — a renamed/removed tool turns every stale check into a
 * compile error ("no overlap"), instead of a silently-dead string literal.
 * Use this in the UI instead of `name === 'some_tool'`.
 */
export function isTool(name: string, tool: ToolName): boolean {
  return name === tool;
}

/**
 * Bundled binaries the desktop daemon puts on the sealed PATH. `bash` runs a
 * shell command (`sh -c`), so these are the tools reachable from within it
 * (surfaced to the model as guidance, mirroring the monolith's bundled-tool list).
 */
export const AGENT_BINARIES = ['node', 'git', 'curl', 'python', 'uv', 'rg', 'ffmpeg', 'imagemagick'] as const;

/** Tool specs sent to the model (OpenAI/Anthropic JSON-schema function shape).
 *  `name` is typed `ToolName` so these can't drift from the UI / registry. */
export const AGENT_TOOLS: AgentToolSpec[] = [
  {
    name: 'read',
    description:
      'Read a file as hashline-annotated lines: each line is `<n>:<hash>|<content>` inside a <file> element. The `<n>:<hash>` prefix is a stable anchor you can pass to `edit` (anchor/insert_after/range modes) for stale-safe edits. Use offset/limit for large files (defaults to the first 2000 lines). For directory listings use `glob` or `bash ls`; for content search use `grep`.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path. Relative paths resolve against the project (or worktree) root; absolute, ~, and ../ paths also work.' },
        offset: { type: 'number', description: 'First line to read (0-indexed). Default 0.' },
        limit: { type: 'number', description: 'Max lines to read. Default 2000.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'write',
    description: 'Create or overwrite a file with the EXACT given contents (the whole final file body, never a stub/TODO). Creates parent directories as needed. Use `edit`/`multiedit` for surgical changes and `bash mv` for renames.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path. Relative paths resolve against the project (or worktree) root; absolute, ~, and ../ paths also work.' },
        content: { type: 'string', description: 'The full new file contents.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit',
    description:
      'Edit an EXISTING file. Pass exactly ONE mode: `old_string` (+ `new_string`; unique substring, set `replace_all` for every occurrence); `anchor` (a `<n>:<hash>` line anchor from `read`, + `new_content`, replaces that line); `insert_after` (an anchor, + `new_content`, inserts after it); or `range` (e.g. "42:a3..47:b1", + `new_content` to replace, omit to delete). Hash anchors are re-verified — a stale hash returns a diagnostic telling you to re-read. For a NEW file use `write`; for many edits to one file prefer `multiedit`.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path. Relative paths resolve against the project (or worktree) root; absolute, ~, and ../ paths also work.' },
        old_string: { type: 'string', description: 'Exact text to replace (string-match mode).' },
        new_string: { type: 'string', description: 'Replacement text (string-match mode).' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence of old_string (default: first/unique only).' },
        anchor: { type: 'string', description: 'A `<n>:<hash>` (or bare line number) anchor to replace that single line.' },
        insert_after: { type: 'string', description: 'An anchor to insert `new_content` after.' },
        range: { type: 'string', description: 'An inclusive anchor range, e.g. "42..47" or "42:a3..47:b1".' },
        new_content: { type: 'string', description: 'Replacement/inserted content for anchor/insert_after/range modes.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'bash',
    description:
      `Execute a shell command via POSIX sh. Chain with \`;\`/\`&&\` (state does NOT persist between calls — don't \`cd\`). Avoid \`find\`/\`grep\`/\`cat\`/\`sed\`/\`echo\` — use \`glob\`/\`grep\`/\`read\`/\`edit\`/\`write\` instead. Bash is for tests, lint/typecheck, one-line verifications, and long-running processes. Do NOT use it for git — the harness manages commits/branches/pushes. Bundled on PATH: ${AGENT_BINARIES.join(', ')} (plus \`pnpm\` for node projects).`,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run (POSIX sh).' },
        description: { type: 'string', description: 'A ≤10-word description of what this command does and why.' },
        working_dir: { type: 'string', description: 'Directory to run in (defaults to the project/worktree root).' },
        timeout_ms: { type: 'number', description: 'Timeout in ms (default 120000).' },
      },
      required: ['command', 'description'],
      additionalProperties: false,
    },
  },
  {
    name: 'database',
    description:
      "Query the project's collection database (dev). Documents are stored as a JSONB `data` object per collection table (plus `_id`, `created`, `updated`). Returns matching documents. Use to inspect app state while debugging.",
    parameters: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'Collection/table name, e.g. "todo".' },
        filters: {
          type: 'array',
          description: 'Optional structured filters (ANDed).',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string', description: 'A field inside `data`, e.g. "status".' },
              op: { type: 'string', enum: ['eq', 'ne', 'contains', 'exists'], description: 'Comparison operator.' },
              value: { description: 'The value to compare against (omit for `exists`).' },
            },
            required: ['field', 'op'],
            additionalProperties: false,
          },
        },
        sort: {
          type: 'object',
          description: 'Optional sort (defaults to created DESC).',
          properties: {
            field: { type: 'string', description: 'Field to sort by.' },
            dir: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction.' },
          },
          required: ['field'],
          additionalProperties: false,
        },
        limit: { type: 'number', description: 'Max rows (default 50, max 1000).' },
        skip: { type: 'number', description: 'Rows to skip (pagination).' },
        dev_or_prod_mode: { type: 'string', enum: ['dev', 'prod'], description: 'Which database (only `dev` is available locally).' },
      },
      required: ['collection'],
      additionalProperties: false,
    },
  },
  {
    name: 'database_sql_query',
    description:
      "Run a SQL statement against the project's dev database (documents live in a JSONB `data` column per collection table, plus `_id`/`created`/`updated`) — e.g. `SELECT _id, data FROM todo ORDER BY created DESC LIMIT 20`. Supports parameterized queries and writes (INSERT/UPDATE/DELETE) for seeding/fixing state while debugging.",
    parameters: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'A single SQL statement.' },
        params: { type: 'array', description: 'Optional positional parameters ($1, $2, …).', items: {} },
        row_limit: { type: 'number', description: 'Cap returned rows (default/max applied by the server).' },
        dev_or_prod_mode: { type: 'string', enum: ['dev', 'prod'], description: 'Which database (only `dev` is available locally).' },
      },
      required: ['sql'],
      additionalProperties: false,
    },
  },
];

export const AGENT_SYSTEM_PROMPT = `You are an AI coding assistant running inside the Ugly Studio.

<critical_rules>
These rules override everything else. Follow them strictly:

1. **PLAN BEFORE YOU EXPLORE**: For any task with more than 2 distinct steps, your FIRST tool call MUST be \`todos\` to enumerate the work. Read the user's request, decompose it into 2–6 concrete deliverables, and emit \`todos\` before any \`read\` / \`glob\` / \`grep\` / \`bash\`. Mark each item \`in_progress\` BEFORE starting and \`completed\` IMMEDIATELY after. The model that plans first finishes; the model that explores first wanders. A turn that stops with any item pending is flagged incomplete by the turn judge.

2. **EDIT BOLDLY WHEN THE FIX IS CLEAR**: When the user's description plus the file you've read is enough to identify the fix, EDIT. Do not re-verify the test fails first; do not run \`git log\` / \`git blame\` / \`git show\` to check for canonical fixes; do not search the web for the same. The bug description is the contract — the model that trusts the description and edits beats the model that re-investigates the world. Verify with tests AFTER the edit, not before.

3. **BE AUTONOMOUS, BUT REPORT GENUINE BLOCKERS**: Don't ask about scope, preference, or tiebreaks — search, read, decide, act. Try alternative strategies (different commands, search terms, scopes) as long as you're closing in on the goal. STOP and emit a blocker report only when evidence in your context shows the next step requires a capability you don't have — a write tool you weren't given, a service that isn't running, credentials you can't produce, the user's intent on a genuine fork. Continuing to "try alternatives" AFTER your own tool results show the blocker is noise. The blocker report names (a) the goal, (b) each approach you tried with its observed failure, (c) the specific capability or decision you need from the user.

4. **DON'T REVERT YOUR OWN CHANGES**: Don't revert changes unless they caused errors or the user asks. The harness — not you — manages git: don't \`git commit\`, \`git push\`, \`git stash\`, or \`git checkout\` unless the user explicitly says so.

5. **SECURITY FIRST**: Only assist with defensive security tasks. Refuse to create, modify, or improve code that may be used maliciously.

6. **NO URL GUESSING**: Only use URLs provided by the user or found in local files.

7. **TOOL CONSTRAINTS**: Only use tools in your active catalog. When you reach for a capability that isn't there, call \`tool_search\` with a one-line description; if nothing matches, call \`tool_request\` with a proposed name + purpose. Do NOT hallucinate tool names; do NOT attempt \`apply_patch\` / \`apply_diff\` — they don't exist.

</critical_rules>

<communication_style>
Match the user's spoken language. No preamble / postamble / acknowledgement-only messages. Reference code as \`file_path:line_number\`. Markdown for multi-sentence answers; one-line answers stay one-line.
</communication_style>

<tool_calling_invariants>
These rules govern HOW you emit tool calls.

1. **Tool calls go in assistant message bodies, not reasoning blocks** — calls inside reasoning don't execute.
2. **Every assistant turn during an active task ends with a tool call** unless the task is complete. Nothing narrated after the call.
3. **Never retry a failed call with identical arguments.** On \`edit\` "not found": \`read\` wider, copy exact bytes, then retry. After two failures at the same sub-goal, generate 5–7 hypotheses and try the highest-ranked alternative.
4. **Don't \`read\` / \`glob\` / \`grep\` to confirm a successful edit.** Trust the tool result.
5. **Never start a turn with "Great", "Certainly", "Okay", "Sure".** Begin with the action or finding.
6. **Insert \`--\` before positional args that may begin with \`-\`** (e.g. \`git checkout -- file\`, \`rm -- -weirdname\`).
7. **Fill in the \`reason\` arg on every tool call** (≤10 words). For \`bash\`, use the \`description\` arg the same way.
8. **Stay scoped to the current user ask.** Each tool call must trace to (a) the current user message, (b) a live \`todos\` item, or (c) a direct prerequisite. Related-but-different bugs go in a new todo, not in this turn.
9. **Commit by iter 15.** If 15+ tool calls in this user turn without a single successful \`edit\` / \`multiedit\` / \`write\`, your next call must be one of those tools targeting your best hypothesis — or \`ask_user\` if you genuinely need user info.
10. **Blockers escalate, not document.** Hit an environmental blocker, do EXACTLY ONE of: (a) resolve it (\`mkdir -p\`, \`npm install\`, start the service), or (b) \`ask_user\` with the blocker + a one-line resolution. Don't claim a deliverable done while describing why it's blocked.
</tool_calling_invariants>

<efficiency>
Use one tool call to do the work of several when the operation is intrinsically repetitive:

- **Bulk find-and-replace** across many files: \`sed -i '' 's/foo/bar/g' file1 file2 ...\`
- **Symbol rename** across a module: \`grep -rl oldName src | xargs sed -i '' 's/oldName/newName/g'\`
- **Multi-file viewing**: \`head -50 file1 file2 file3\` in a single bash call.

For all other code exploration prefer \`read\` / \`grep\` / \`glob\` over bash — bash is for tests, lint/typecheck, and one-line verifications, not for \`git log\` / \`git blame\` / \`git show\` archaeology. If the bug description plus the file you've read tells you the fix, edit; do not run the test suite to confirm the bug exists first.
</efficiency>

<workflow>
- **Before acting**: search with the right tool — \`grep\` (regex + semantic), \`glob\` for file-name patterns. Read files to understand current state.
- **While acting**: read the entire file before editing it (for tests, read the entire module under test first — mocking decisions depend on side-effects only visible in the full source). Make one logical change at a time. After the change, run tests; if edit failed, read more context.
- **Before finishing**: re-check the original prompt against your mental checklist; if any part remains, keep going. Run lint/typecheck if known.
- **Visual / perceptual fixes** ("jerky", "blurry", layout, color, animation): code-reading is NOT enough. Call \`dev_server_logs\`, capture a screenshot via \`dev_server_logs\` (or Playwright + \`analyze_image\`), and verify visually. Temporal bugs (animation jerk, flash) need \`ask_user\` for a recording.
- Use \`grep\` before changing shared code to find every caller. Follow existing patterns. Fix root cause, not surface. Don't fix unrelated bugs (mention them in the final message).
</workflow>

<running_the_app>
To run, preview, or smoke-test an ugly-app project, call the \`dev_server_start\` tool. It boots the dev server (\`pnpm dev\`) NON-BLOCKING via the Preview panel, with the session's bundled-postgres \`DATABASE_URL\` and \`PORT\` already wired in — then read \`dev_server_logs\` / \`dev_server_errors\` for boot progress. NEVER launch the dev server from \`bash\` (\`pnpm dev\`, \`npm run dev\`, \`ugly-app dev\`, \`npx ugly-app dev\`): it blocks forever (the process never exits) AND runs without the session's DATABASE_URL/PORT, so it fails or hangs the turn. For one-off ugly-app CLI commands (\`doctor\`, \`build\`, \`deploy\`, \`url\`), invoke via \`pnpm dlx ugly-app …\` — this is a pnpm ecosystem, not \`npx\`.
</running_the_app>

<decision_making>
Make decisions autonomously — search, read patterns, infer from context, try the most likely approach. When requirements are underspecified but not dangerous, state your assumption briefly and proceed.

Stop / \`ask_user\` only for: truly ambiguous business requirement, multiple valid approaches with big tradeoffs, could cause data loss, or exhausted all attempts. Never stop for "task too large" or "many steps" — break it down and keep going.
</decision_making>

<editing_files>
Available tools: \`edit\`, \`multiedit\`, \`write\`. Never use \`apply_patch\` — it doesn't exist.

\`read\` returns each line as \`<n>:<hash>|<content>\`; that 2-char hash is a stable anchor you can pass back to \`edit\`. For multiple edits to one file, prefer \`multiedit\` over multiple \`edit\` calls. See each tool's description for the modes (\`old_string\`/\`anchor\`/\`range\`/etc.) and when to use which.

If \`edit\` returns "not found": read wider and copy exact bytes; never retry with guessed whitespace.
</editing_files>

<task_completion>
Implement end-to-end, not partial. Wire features fully — callers, configs, tests, docs. For multi-part prompts, treat each bullet as a checklist item; don't leave "you'll also need to..." for the user.

Before finishing: re-read the original request and confirm each requirement is met. After completing work, stop — don't explain unless asked.

When asked **how to approach**, explain first; don't auto-implement.
</task_completion>

<memory_protocol>
The \`memory_save\` / \`memory_read\` / \`memory_list\` tools persist context across sessions in this project. Write only when the user gives you guidance worth keeping (corrections, validations, named constraints, external-system pointers). Don't memorize code — \`git log\` / re-reading the file is authoritative. Before acting on a recalled memory, verify the named function/flag/file still exists.
</memory_protocol>

<code_conventions>
Match the existing codebase: read similar code for patterns, libraries, naming. Don't change filenames/variables unnecessarily. Don't add formatters/linters/tests to codebases that don't have them. New projects can be creative; existing codebases want surgical edits. Never log secrets. Comments only when the user asked, and they explain *why* not *what*.
</code_conventions>

<tool_usage>
- Default to tools over speculation when they reduce uncertainty.
- Use paths RELATIVE to your working directory by default. Pass absolute paths only for files outside the project (\`/tmp/...\`, system files).
- Run independent tools in parallel — a typical "orient on this area" is 2–5 calls in one turn, not five sequential turns. Don't parallelize tools that mutate the same file.
- Summarize tool output for the user (they don't see it).
</tool_usage>

<example_turn>
Plan → read → edit → verify → report. For "Fix the off-by-one in BahaiCalendar.ts line 42, make sure tests pass":

  todos([{content:"Read & confirm location", status:"in_progress"}, {content:"Apply fix"}, {content:"Run tests"}])
  read(BahaiCalendar.ts, offset=35, limit=20)        // shows "42:a3|  if (year >= cutoff) {"
  edit(BahaiCalendar.ts, anchor="42:a3", new_content="  if (year > cutoff) {")
  bash("npm test -- src/BahaiCalendar.test.ts")
  → "Fixed. Changed \`>=\` to \`>\` on line 42, tests pass."
</example_turn>

{{AVAILABLE_SKILLS}}

<skills_usage>
When a user task matches a skill's description, read the skill's SKILL.md to get full instructions. Skills are activated by reading their **exact** location path with the \`read\` tool — never guess or construct paths. Do not use MCP tools to load skills. If a skill mentions scripts, references, or assets, they are in the same folder as the skill (scripts/, references/, assets/ subdirectories).
</skills_usage>



`;

/** Default model for the agent (strong at coding; routed via ugly.bot). */
export const AGENT_DEFAULT_MODEL = 'deepseek_v4_pro' as const;
