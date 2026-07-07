// The agentic loop — runs CLIENT-SIDE. It calls `step` (one model turn via the
// server's agentStep endpoint) to get the next assistant message, executes any
// `tool_use` blocks via `dispatch`, feeds the `tool_result` blocks back as a
// user turn, and repeats until the model stops requesting tools (or a step cap).
//
// `history` is mutated in place so the caller (the panel) keeps the running
// conversation even if the loop is aborted mid-flight.

import type { AgentContentPart, AgentMessage } from '../../shared/agent';
import type { ToolDispatch } from './tools';

export type StepFn = (input: {
  messages: AgentMessage[];
  model?: string;
}) => Promise<{ message: AgentMessage }>;

export type AgentEvent =
  | { type: 'assistant'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; name: string; result: string; ok: boolean }
  | { type: 'done' }
  | { type: 'error'; message: string };

export interface RunAgentOpts {
  history: AgentMessage[];
  step: StepFn;
  dispatch: ToolDispatch;
  model?: string;
  maxSteps?: number;
  signal?: AbortSignal;
  onEvent?: (e: AgentEvent) => void;
}

export async function runAgent(opts: RunAgentOpts): Promise<AgentMessage[]> {
  const { history, step, dispatch, model, onEvent } = opts;
  const maxSteps = opts.maxSteps ?? 25;
  const emit = (e: AgentEvent): void => onEvent?.(e);

  for (let i = 0; i < maxSteps; i++) {
    if (opts.signal?.aborted) {
      emit({ type: 'error', message: 'Aborted' });
      return history;
    }

    const { message } = await step({ messages: history, ...(model ? { model } : {}) });
    history.push(message);

    const parts = normalizeParts(message.content);
    const text = parts
      .filter((p): p is Extract<AgentContentPart, { type: 'text' }> => p.type === 'text')
      .map((p) => p.text ?? '')
      .join('');
    if (text.trim()) emit({ type: 'assistant', text });

    const toolUses = parts.filter(
      (p): p is Extract<AgentContentPart, { type: 'tool_use' }> => p.type === 'tool_use',
    );
    if (toolUses.length === 0) {
      emit({ type: 'done' });
      return history;
    }

    const results: AgentContentPart[] = [];
    for (const tu of toolUses) {
      emit({ type: 'tool_call', id: tu.id, name: tu.name, input: tu.input });
      try {
        const result = await dispatch(tu.name, tu.input);
        emit({ type: 'tool_result', id: tu.id, name: tu.name, result, ok: true });
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: truncate(result) });
      } catch (e) {
        const msg = (e as Error).message;
        emit({ type: 'tool_result', id: tu.id, name: tu.name, result: msg, ok: false });
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: `Error: ${msg}` });
      }
    }
    history.push({ role: 'user', content: results });
  }

  emit({ type: 'error', message: `Reached step limit (${maxSteps})` });
  return history;
}

function normalizeParts(content: string | AgentContentPart[]): AgentContentPart[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}

function truncate(s: string, max = 30_000): string {
  return s.length > max ? `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]` : s;
}
