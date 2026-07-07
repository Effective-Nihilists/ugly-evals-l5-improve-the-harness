// `delegate` / `delegate_parallel` — run subtasks in nested agent loops. Ported
// from ugly-studio f5a74c2^:.../{delegate,delegate-parallel}.ts. Both degrade to
// a clear message when no model-call `step` is available. (The monolith's `agent`
// tool was retired 2026-04-25 — `delegate` is the single canonical sub-agent
// primitive — so it is not ported here.)

import type { TextGenTool } from 'ugly-app/shared';
import type { ToolModule } from './registry';
import { runSubAgent } from './subagent';

function noStep(): string {
  return '(delegation unavailable — the agent loop did not provide a model step in this context)';
}

export const delegateTool: ToolModule = {
  name: 'delegate',
  spec: {
    name: 'delegate',
    description:
      'Run a focused subtask in an isolated sub-agent (fresh context, bounded ' +
      'steps) and get back its result. Use for a self-contained chunk you can ' +
      'describe precisely (e.g. "find all callers of X and list them").',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The subtask, described in full (the sub-agent has no other context).' },
        tools: { type: 'array', items: { type: 'string' }, description: 'Optional: restrict the sub-agent to these tool names.' },
      },
      required: ['task'],
      additionalProperties: false,
    },
  } satisfies TextGenTool,
  async run(input, ctx) {
    const step = (ctx)?.step;
    if (!step) return noStep();
    const allowedTools = Array.isArray(input.tools) ? (input.tools as unknown[]).map(String) : undefined;
    return runSubAgent((typeof input.task === 'string' ? input.task : ''), {
      step,
      ctx,
      ...(allowedTools ? { allowedTools } : {}),
    });
  },
};

export const delegateParallelTool: ToolModule = {
  name: 'delegate_parallel',
  spec: {
    name: 'delegate_parallel',
    description:
      'Run several independent subtasks concurrently in sub-agents and get all ' +
      'their results. Use when the subtasks do not depend on each other.',
    parameters: {
      type: 'object',
      properties: {
        tasks: { type: 'array', items: { type: 'string' }, description: 'The independent subtasks.' },
      },
      required: ['tasks'],
      additionalProperties: false,
    },
  } satisfies TextGenTool,
  async run(input, ctx) {
    const step = (ctx)?.step;
    if (!step) return noStep();
    const tasks = Array.isArray(input.tasks) ? (input.tasks as unknown[]).map(String) : [];
    if (tasks.length === 0) return 'delegate_parallel: `tasks` must be a non-empty array';
    const results = await Promise.all(
      tasks.map((t, i) =>
        runSubAgent(t, { step, ctx }).then(
          (r) => `## Subtask ${i + 1}: ${t}\n${r}`,
          (e: unknown) => `## Subtask ${i + 1}: ${t}\n(failed: ${(e as Error).message})`,
        ),
      ),
    );
    return results.join('\n\n');
  },
};
