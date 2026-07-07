// `web_search` — web search via DuckDuckGo's HTML endpoint, read through
// native.browse (no CORS). Returns results as text; follow up with web_fetch for
// a specific page. Ported from ugly-studio f5a74c2^:.../web_search.ts.

import { native } from 'ugly-app/native';
import type { TextGenTool } from 'ugly-app/shared';
import type { ToolModule } from './registry';

const SPEC: TextGenTool = {
  name: 'web_search',
  description:
    'Search the web (DuckDuckGo) and return a short list of results (titles, ' +
    'snippets, URLs) as text. Do NOT use it to hunt for canonical bug fixes — ' +
    'trust the task description and edit. Follow a result with web_fetch to read it.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query.' },
    },
    required: ['query'],
    additionalProperties: false,
  },
};

export const webSearchTool: ToolModule = {
  name: 'web_search',
  spec: SPEC,
  async run(input) {
    const query = (typeof input.query === 'string' ? input.query : '').trim();
    if (!query) return 'web_search: `query` is required';
    const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
    try {
      const page = await native.browse.extract(url, { format: 'text' });
      const body = page.content.replace(/\n{3,}/g, '\n\n').slice(0, 8000);
      return body.trim() || `(no results for ${JSON.stringify(query)})`;
    } catch (e) {
      console.error('[webSearchTool:extract]', JSON.stringify({ query, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined);
      return `web_search failed: ${(e as Error).message}`;
    }
  },
};
