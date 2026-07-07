// Subagent runner — runs a scoped task in a nested engine loop (client/agent/
// engine.runAgent) with the parent's model-call `step`, a bounded step budget,
// and a hard recursion guard (a subagent can't spawn further subagents).

import { runAgent, type StepFn } from '../engine';
import { dispatchTool, type ToolContext } from '../tools';
import type { AgentMessage } from '../../../shared/agent';

const NO_RECURSE = new Set(['delegate', 'delegate_parallel', 'agent']);

export interface SubAgentOpts {
  step: StepFn;
  ctx?: ToolContext;
  maxSteps?: number;
  model?: string;
  /** If set, only these tools are available to the subagent (delegation tools
   *  are always blocked regardless). */
  allowedTools?: string[];
  system?: string;
}

/** Extract the final assistant text from a completed run. */
function finalText(history: AgentMessage[]): string {
  const last = [...history].reverse().find((m) => m.role === 'assistant');
  if (!last) return '(subagent produced no output)';
  if (typeof last.content === 'string') return last.content;
  return (
    last.content
      .map((p) => (p as { text?: string }).text ?? '')
      .filter(Boolean)
      .join('\n') || '(subagent produced no text output)'
  );
}

export async function runSubAgent(task: string, opts: SubAgentOpts): Promise<string> {
  const history: AgentMessage[] = [];
  if (opts.system) history.push({ role: 'system', content: opts.system });
  history.push({ role: 'user', content: task });
  const allow = opts.allowedTools ? new Set(opts.allowedTools) : null;
  const dispatch = (name: string, input: unknown): Promise<string> => {
    if (NO_RECURSE.has(name)) return Promise.resolve(`(nested delegation is disabled)`);
    if (allow && !allow.has(name)) return Promise.resolve(`(tool ${name} not available to this subagent)`);
    return dispatchTool(name, input, opts.ctx);
  };
  const out = await runAgent({
    history,
    step: opts.step,
    dispatch,
    maxSteps: opts.maxSteps ?? 8,
    ...(opts.model ? { model: opts.model } : {}),
  });
  return finalText(out);
}
