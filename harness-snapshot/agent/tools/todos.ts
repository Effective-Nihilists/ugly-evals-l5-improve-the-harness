// `todos` — the plan-first task list the system prompt mandates. The model sends
// the FULL list each call (Claude-Code semantics); we store the latest per
// session and render it. Ported from ugly-studio f5a74c2^:.../todos.ts.

import type { TextGenTool } from 'ugly-app/shared';
import type { ToolModule } from './registry';

export interface Todo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

const bySession = new Map<string, Todo[]>();

/** Current todos for a session (for header surfacing / tests). */
export function getTodos(sessionId: string): Todo[] {
  return bySession.get(sessionId) ?? [];
}

const MARK: Record<Todo['status'], string> = {
  pending: '[ ]',
  in_progress: '[~]',
  completed: '[x]',
};

const SPEC: TextGenTool = {
  name: 'todos',
  description:
    'Track your plan as a checklist. For any task with more than 2 steps, call ' +
    'this FIRST to enumerate 2-6 deliverables. Send the FULL list every call ' +
    '(it replaces the previous one). Mark an item in_progress before starting ' +
    'and completed immediately after.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The full todo list.',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Imperative description of the task.' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            activeForm: { type: 'string', description: 'Present-tense label shown while in progress.' },
          },
          required: ['content', 'status'],
          additionalProperties: false,
        },
      },
    },
    required: ['todos'],
    additionalProperties: false,
  },
};

export const todosTool: ToolModule = {
  name: 'todos',
  spec: SPEC,
  // eslint-disable-next-line @typescript-eslint/require-await -- ToolModule.run must return Promise<string>; this impl has no async work
  async run(input, ctx) {
    const todos = Array.isArray(input.todos) ? (input.todos as Todo[]) : [];
    const sid = ctx?.sessionId ?? 'default';
    bySession.set(sid, todos);
    if (todos.length === 0) return '(no todos)';
    // input.todos is an unchecked cast, so t.status may be an unexpected value at
    // runtime — keep the ?? fallback as a real safety net.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const lines = todos.map((t) => `${MARK[t.status] ?? '[ ]'} ${t.content}`);
    const done = todos.filter((t) => t.status === 'completed').length;
    return `${lines.join('\n')}\n(${done}/${todos.length} complete)`;
  },
};
