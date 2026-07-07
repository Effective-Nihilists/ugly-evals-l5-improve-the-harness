// `web_fetch` — GET a URL and return readable content. Uses native.browse
// (headless Chromium) so it works client-side without CORS limits. Ported from
// ugly-studio f5a74c2^:server/coding-agent/tools/web-fetch.ts.

import { native } from 'ugly-app/native';
import type { TextGenTool } from 'ugly-app/shared';
import type { ToolModule } from './registry';

const SPEC: TextGenTool = {
  name: 'web_fetch',
  description:
    'Fetch a web page and return its readable content. `format`: "readability" ' +
    '(article text, default), "text" (visible text), or "html" (raw). Follow a ' +
    'web_search result with this to read the page.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'http/https URL to fetch.' },
      format: { type: 'string', enum: ['readability', 'text', 'html'], description: 'Extraction format.' },
    },
    required: ['url'],
    additionalProperties: false,
  },
};

export const webFetchTool: ToolModule = {
  name: 'web_fetch',
  spec: SPEC,
  async run(input) {
    const url = (typeof input.url === 'string' ? input.url : '');
    if (!/^https?:\/\//i.test(url)) return `web_fetch: only http/https URLs are supported (got ${url})`;
    const format = input.format === 'html' || input.format === 'text' ? input.format : 'readability';
    try {
      const page = await native.browse.extract(url, { format });
      return `# ${page.title}\n${page.url}\n\n${page.content.slice(0, 20000)}`;
    } catch (e) {
      console.error('[webFetchTool:extract]', JSON.stringify({ url, format, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined);
      return `web_fetch failed: ${(e as Error).message}`;
    }
  },
};
