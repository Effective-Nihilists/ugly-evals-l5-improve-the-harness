// Toolset overrides — gate the agent's model-facing tool list by a named set,
// so A/B evals can compare the same task with vs without a capability (the Ep 04
// python_exec pro/con: AST-walk with python vs grep/read without). Applied in the
// live `tools` getter, composing after the SBV per-step filter.
import type { AgentToolSpec } from '../../../shared/agent';

export type Toolset = 'default' | 'no-python';

const PYTHON_TOOLS = new Set<string>(['python_exec', 'python_libraries']);

export function isToolset(s: string): s is Toolset {
  return s === 'default' || s === 'no-python';
}

/** Filter tool specs by the named toolset (default = unchanged). */
export function filterToolsByToolset(specs: AgentToolSpec[], toolset: Toolset | null | undefined): AgentToolSpec[] {
  if (toolset === 'no-python') return specs.filter((s) => !PYTHON_TOOLS.has(s.name));
  return specs;
}
