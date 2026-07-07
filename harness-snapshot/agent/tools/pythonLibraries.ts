// `python_libraries` — list installed Python libraries in the project env.
// Ported from ugly-studio f5a74c2^:server/coding-agent/tools/python-libraries.ts.

import type { TextGenTool } from 'ugly-app/shared';
import type { ToolModule } from './registry';
import { projectRoot } from './lspForProject';
import { spawnCollect } from './spawn';

const SPEC: TextGenTool = {
  name: 'python_libraries',
  description:
    'List the Python libraries installed in the project environment (uv pip ' +
    'list). Optionally filter by a substring of the package name.',
  parameters: {
    type: 'object',
    properties: {
      filter: { type: 'string', description: 'Case-insensitive substring to filter package names.' },
    },
    required: [],
    additionalProperties: false,
  },
};

export const pythonLibrariesTool: ToolModule = {
  name: 'python_libraries',
  spec: SPEC,
  async run(input, ctx) {
    const root = projectRoot(ctx) ?? undefined;
    const opts = root ? { cwd: root } : {};
    let res = await spawnCollect('uv', ['pip', 'list'], opts);
    // Fall back to plain pip when uv isn't available.
    if (res.code !== 0 && res.code !== null) {
      res = await spawnCollect('python', ['-m', 'pip', 'list'], opts);
    }
    const filter = typeof input.filter === 'string' ? input.filter.toLowerCase() : '';
    const lines = res.stdout
      .split('\n')
      .filter((l) => l.trim())
      .filter((l) => !filter || l.toLowerCase().includes(filter));
    if (lines.length === 0) {
      return filter ? `(no installed packages match ${JSON.stringify(filter)})` : '(no packages found)';
    }
    return lines.join('\n');
  },
};
