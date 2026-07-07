# The Singularity Test — make this coding harness the best it can be

You are being evaluated **by** ugly-code — an AI coding agent that generates code.
Your task is to improve the **coding harness itself**: the engine that drives the
agent, runs its tools, manages context, and turns a task into working code. Can an
AI coding agent meaningfully improve the very system it runs on?

## Scope — the coding harness ONLY

Focus **solely on the coding harness** (the agent engine). **Out of scope:** the
Studio UI (panels, pages, React components), the eval/grading machinery, and the
ugly-app LLM transport layer. Do not design changes to those.

The harness code is bundled under `harness-snapshot/`, mirroring its real layout:

- `harness-snapshot/agent/` — the **tool layer** (`client/agent/`): the agent
  engine (`engine.ts`), tool wiring + catalog (`tools.ts`, `tools/registry.ts`,
  `tools/catalog.ts`), and ~40 tool implementations under `tools/` — edit/multiedit,
  grep/glob, spawn, python exec, LSP, subagent/delegate, tool-search, todos,
  memory, blackboard, scratchpad, dev-server, web fetch/search, output truncation.
- `harness-snapshot/studio-agent/` — the **run engine** (`client/studio/agent/`):
  the main agent loop + context compaction + token budget (`clientAgent.ts`), the
  claude-cli path, session store/workspace, per-mode toolsets, the multi-model
  orchestration `patterns/` (judge, classify, synthesize-spec, peer personas,
  mid/max/group-mode hosts), the LSP client (`lsp/`), and the finish/commit
  pipeline (`finish/`).
- `harness-snapshot/shared/agent.ts` — the **model-facing contract**: the full
  system prompt (`AGENT_SYSTEM_PROMPT`, including its `<critical_rules>`) and the
  tool specs the model actually sees (`AGENT_TOOLS` — names, descriptions, JSON
  schemas). The prompt + tool descriptions are the single biggest lever on agent
  behavior, so scrutinize them closely.

See `harness-snapshot/README.md` for the full map. The full project lives at
https://github.com/Effective-Nihilists/ugly-code — use `web_fetch` / `web_search`
to read more of it if useful.

## What to produce

Write a single file, **`DESIGN.md`**, at the repo root: a concrete, prioritized
design for how to make ugly-code's coding harness the best possible engine for
generating **correct** code. It must:

1. **Read the real code.** Cite specific files/mechanisms you find in the snapshot
   and name concrete weaknesses or gaps — the actual weak points are yours to
   find, not handed to you.
2. **Ground it in current research.** Research the state of the art in AI coding
   agents — tool design, context/memory management, agentic scaffolds,
   verification/self-correction, model orchestration. Reference specific, real
   techniques, not generalities.
3. **Propose improvements, prioritized.** For each: what to change, why (tie it to
   a real limitation you found in the code), and roughly how hard it is.
   Distinguish quick wins from larger bets.
4. **Be feasible.** Proposals must be actionable against *this* codebase, not a
   greenfield rewrite.
5. **Find at least one non-obvious lever** — an insight a shallow pass would miss.

## Definition of done

`DESIGN.md` exists at the repo root and delivers the above. There is no code to
change and no test to pass — you are graded on the depth, accuracy, grounding, and
usefulness of the design.
