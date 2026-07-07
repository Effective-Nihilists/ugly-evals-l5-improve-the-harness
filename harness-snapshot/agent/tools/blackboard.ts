// `blackboard_post` — a per-session shared note board that delegated sub-agents
// can read for coordination. Ported from ugly-studio f5a74c2^:.../blackboard.ts.

import type { TextGenTool } from 'ugly-app/shared';
import type { ToolModule } from './registry';

interface Note { message: string; tag?: string }
const boards = new Map<string, Note[]>();

/** Read all notes posted for a session (used by sub-agents / tests). */
export function readBlackboard(sessionId: string): Note[] {
  return boards.get(sessionId) ?? [];
}

const SPEC: TextGenTool = {
  name: 'blackboard_post',
  description:
    'Post a short coordination note to a shared board that your delegated ' +
    'sub-agents can read. Use to share decisions/context across sub-agents.',
  parameters: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'The note to post.' },
      tag: { type: 'string', description: 'Optional category tag.' },
    },
    required: ['message'],
    additionalProperties: false,
  },
};

export const blackboardPostTool: ToolModule = {
  name: 'blackboard_post',
  spec: SPEC,
  // eslint-disable-next-line @typescript-eslint/require-await
  async run(input, ctx) {
    const sid = ctx?.sessionId ?? 'default';
    const message = (typeof input.message === 'string' ? input.message : '').trim();
    if (!message) return 'blackboard_post: `message` is required';
    const notes = boards.get(sid) ?? [];
    notes.push({ message, ...(input.tag ? { tag: (typeof input.tag === 'string' ? input.tag : '') } : {}) });
    boards.set(sid, notes);
    return `posted to blackboard (${notes.length} note(s))`;
  },
};
