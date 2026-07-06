# The Singularity Test — make this coding harness the best it can be

You are being evaluated **by** the ugly-code coding harness. Your task is to
improve **it**. Can an AI coding agent meaningfully improve the very system it
runs on?

## What you have

`harness-snapshot/` is a real snapshot of ugly-code's eval harness — the same
machinery grading this run:

- `harness-snapshot/evals/registry.ts` — task registry + the **derived**
  difficulty heuristic + the curated level ladder field.
- `harness-snapshot/evals/grader.ts` — gate-based + LLM-judge (0–5) grading.
- `harness-snapshot/evals/sbpGrader.ts` — the Docker-free SWE-bench-Pro grader.
- `harness-snapshot/cli/*.ts` — the run loop (`evalRun.ts`), CLI arg handling
  (`evalCli.ts`), the A/B `compare.ts`, transcript `analyzeRun.ts`, and the
  in-process agent `taskDriver.ts`.

The full project lives at https://github.com/Effective-Nihilists/ugly-code — use
`web_fetch` / `web_search` to read more of it if useful.

## What to produce

Write a single file, **`DESIGN.md`**, at the repo root: a concrete, prioritized
design for how to make ugly-code the best possible coding-agent harness. It must:

1. **Read the real code.** Cite specific files/mechanisms from
   `harness-snapshot/` (e.g. the derived-vs-authored difficulty, how judge gates
   get their evidence, the no-edit nudge, the SBP fail_to_pass/pass_to_pass path)
   and name concrete weaknesses or gaps you find.
2. **Ground it in current research.** Research the state of the art in
   coding-agent evaluation and agent design (recent benchmarks like SWE-bench /
   SWE-bench-Pro / Terminal-Bench, judging methodology, contamination, reward
   hacking, agent scaffolds). Reference specific, real techniques — not
   generalities.
3. **Propose improvements, prioritized.** For each: what to change, why (tie it
   to a real limitation you found in the code), and roughly how hard it is.
   Distinguish quick wins from larger bets.
4. **Be feasible.** Proposals must be actionable against *this* codebase, not a
   greenfield rewrite.
5. **Find at least one non-obvious lever** — an insight a shallow pass would miss.

## Definition of done

`DESIGN.md` exists at the repo root and delivers the above. There is no code to
change and no test to pass — you are graded on the depth, accuracy, grounding,
and usefulness of the design.
