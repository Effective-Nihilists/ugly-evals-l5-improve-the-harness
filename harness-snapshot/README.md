# ugly-code coding-harness snapshot

A real snapshot of ugly-code's **coding harness** — the engine that drives the AI
coding agent, runs its tools, manages context, and turns a task into working code.
This is the same machinery running the agent that is reading this right now.

The UI layer (Studio panels/pages/React) and the eval/grading machinery are
intentionally NOT included — they are out of scope.

## Layout

- `agent/` — the tool layer (from `client/agent/`):
  - `engine.ts` — the agent engine entry.
  - `tools.ts`, `tools/registry.ts`, `tools/catalog.ts` — tool wiring + catalog.
  - `tools/*.ts` — ~40 tool implementations: `applyEdit`/`multiedit`, `grep`/`glob`,
    `spawn`, `pythonExec`/`pythonOneShot`, `lspForProject`, `subagent`/`delegate`,
    `toolSearch`, `todos`, `memory`, `blackboard`, `scratchpad`, `devServer`,
    `webFetch`/`webSearch`, `outputTruncate`, `hashline`, `gating`, …

- `studio-agent/` — the run engine (from `client/studio/agent/`):
  - `clientAgent.ts` — the main agent loop: turn handling, context compaction,
    token budget, tool dispatch.
  - `claudeCliAgent.ts` — the claude-cli agent path.
  - `sessionStore.ts` / `fsSessionStore.ts` / `sessionWorkspace.ts` /
    `sessionSnapshot.ts` — session + workspace state.
  - `toolsets.ts` — which tools are enabled per mode.
  - `patterns/` — multi-model orchestration: `judge`, `classify`,
    `synthesize-spec`, `peer-personas`, `mid-mode-host`, `max-mode-host`,
    `group-mode-host`, `picker`, `extract-insights`.
  - `lsp/` — the LSP client + handlers used for code intelligence.
  - `finish/` — the finish/commit pipeline (squash-merge, git exec, languages).

- `shared/agent.ts` — **the model-facing contract**: `AGENT_SYSTEM_PROMPT` (the
  full system instruction, including the `<critical_rules>`), `AGENT_TOOLS` (the
  tool names + descriptions + JSON parameter schemas the model actually sees), and
  the tool-name/binary constants. This is the single most load-bearing file in the
  harness — how the agent is told to behave and what its tools look like.

## Note

The LLM transport that actually calls the model (streaming, tool-call parsing)
lives in the separate **ugly-app** framework and is a black box here — do not
design changes to it.
