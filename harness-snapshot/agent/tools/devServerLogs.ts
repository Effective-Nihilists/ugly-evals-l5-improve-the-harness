// `dev_server_logs` — tail the project's dev server output. The dev server is
// owned by PreviewPanel (renderer); it persists its rolling log to a per-project
// file (client/studio/panels/devServerLog.ts) that this tool reads from the
// agent's task context.

import type { TextGenTool } from 'ugly-app/shared';
import type { ToolModule } from './registry';
import { projectRoot } from './lspForProject';
import { readDevLog } from '../../studio/panels/devServerLog';

const SPEC: TextGenTool = {
  name: 'dev_server_logs',
  description:
    'Read recent output from the project\'s dev server (pnpm dev). Use to check ' +
    'for compile errors, crashes, or request logs after making changes. Returns ' +
    'the tail of the log; optionally filter by a substring.',
  parameters: {
    type: 'object',
    properties: {
      lines: { type: 'number', description: 'How many trailing lines to return (default 100).' },
      filter: { type: 'string', description: 'Only return lines containing this substring.' },
    },
    required: [],
    additionalProperties: false,
  },
};

export const devServerLogsTool: ToolModule = {
  name: 'dev_server_logs',
  spec: SPEC,
  async run(input, ctx) {
    const root = projectRoot(ctx);
    if (!root) return '(no project open)';
    const raw = await readDevLog(root);
    if (!raw.trim()) {
      return '(no dev-server log — the dev server may not be running; start Preview to boot it)';
    }
    const filter = typeof input.filter === 'string' ? input.filter : '';
    const n = typeof input.lines === 'number' && input.lines > 0 ? Math.floor(input.lines) : 100;
    let lines = raw.replace(/\n+$/, '').split('\n');
    if (filter) lines = lines.filter((l) => l.includes(filter));
    return lines.slice(-n).join('\n').trimEnd() || `(no lines match ${JSON.stringify(filter)})`;
  },
};
