// `scratchpad` — durable per-session scratch notes, persisted via native.fs so
// they survive across turns. Ported from ugly-studio f5a74c2^:.../scratchpad.ts.

import { native } from 'ugly-app/native';
import type { TextGenTool } from 'ugly-app/shared';
import type { ToolModule } from './registry';
import { projectRoot } from './lspForProject';

function scratchPath(root: string, sessionId: string): string {
  const slug = sessionId.replace(/[^A-Za-z0-9_-]/g, '_');
  return `${root.replace(/\/+$/, '')}/.ugly-studio/scratch/${slug}.md`;
}

const SPEC: TextGenTool = {
  name: 'scratchpad',
  description:
    'A durable scratchpad for notes/plans across the session. action: "append" ' +
    'adds content, "read" returns everything, "clear" empties it.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['append', 'read', 'clear'] },
      content: { type: 'string', description: 'Text to append (for action=append).' },
    },
    required: ['action'],
    additionalProperties: false,
  },
};

export const scratchpadTool: ToolModule = {
  name: 'scratchpad',
  spec: SPEC,
  async run(input, ctx) {
    const root = projectRoot(ctx);
    if (!root) return '(no project open)';
    const sid = ctx?.sessionId ?? 'default';
    const file = scratchPath(root, sid);
    const action = (typeof input.action === 'string' ? input.action : 'read');
    const readCur = async (): Promise<string> => {
      try {
        return await native.fs.readFile(file);
      } catch {
        return '';
      }
    };
    if (action === 'read') {
      const cur = await readCur();
      return cur.trim() || '(scratchpad is empty)';
    }
    await native.fs.mkdir(`${root.replace(/\/+$/, '')}/.ugly-studio/scratch`, true);
    if (action === 'clear') {
      await native.fs.writeFile(file, '');
      return 'scratchpad cleared';
    }
    // append
    const cur = await readCur();
    const next = (cur ? cur.replace(/\n*$/, '\n') : '') + (typeof input.content === 'string' ? input.content : '') + '\n';
    await native.fs.writeFile(file, next);
    return 'appended to scratchpad';
  },
};
