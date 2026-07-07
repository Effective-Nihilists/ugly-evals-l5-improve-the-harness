// `tool_search` — find tools in the full catalog by intent. Ported from
// ugly-studio f5a74c2^:server/coding-agent/tools/tool-search.ts.

import type { TextGenTool } from 'ugly-app/shared';
import type { ToolModule } from './registry';
import { searchCatalog } from './catalog';

const SPEC: TextGenTool = {
  name: 'tool_search',
  description:
    'Search for a tool by describing the capability you need (e.g. "download a ' +
    'file", "analyze an image"). Returns matching tool names; activate one with ' +
    'tool_request before using it.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'What you want to do.' } },
    required: ['query'],
    additionalProperties: false,
  },
};

export const toolSearchTool: ToolModule = {
  name: 'tool_search',
  spec: SPEC,
  // eslint-disable-next-line @typescript-eslint/require-await
  async run(input) {
    const query = (typeof input.query === 'string' ? input.query : '').trim();
    if (!query) return 'tool_search: `query` is required';
    const hits = searchCatalog(query);
    if (hits.length === 0) return `(no tools match ${JSON.stringify(query)})`;
    return hits.map((h) => `- ${h.name}: ${h.description}`).join('\n');
  },
};
