# l5-improve-the-harness — the "singularity test"

A Level 5 (real-world agentic) eval task from
[ugly-code](https://github.com/Effective-Nihilists/ugly-code): the agent must
research the state of the art in AI coding agents, review a real snapshot of
ugly-code's own **coding harness** (`harness-snapshot/` — the agent engine, tools,
context management, and orchestration that generate code), and write a prioritized
`DESIGN.md` for how to make it the best possible harness.

Scope is the coding harness only — the Studio UI, the eval/grading machinery, and
the ugly-app LLM transport are out of scope.

**Kind:** `planning` · **Level:** 5 · **Tags:** `planning`, `design-doc`, `research`, `self-improvement`

There is no code to change and no test suite. Grading is by an LLM judge on the
depth, accuracy (does it cite the real code?), research grounding, prioritization,
feasibility, and insight of the produced `DESIGN.md`. See [TICKET.md](./TICKET.md).

Requires web tools (`web_search` / `web_fetch`) for the "current research" part.
