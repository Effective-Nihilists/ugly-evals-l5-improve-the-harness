// `analyze_image` — vision analysis of an image via the ugly.bot proxy. Ported
// from ugly-studio f5a74c2^:server/coding-agent/tools/analyze-image.ts.

import { native } from 'ugly-app/native';
import type { TextGenTool } from 'ugly-app/shared';
import type { ToolModule } from './registry';
import { resolvePath } from '../tools';

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

const SPEC: TextGenTool = {
  name: 'analyze_image',
  description:
    'Analyze an image (a screenshot, diagram, or photo) with a vision model. ' +
    'Provide a file `path` in the workspace or a `url`, plus an optional prompt.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace image file path.' },
      url: { type: 'string', description: 'Image URL (alternative to path).' },
      prompt: { type: 'string', description: 'What to look for (default: describe it).' },
    },
    required: [],
    additionalProperties: false,
  },
};

export const analyzeImageTool: ToolModule = {
  name: 'analyze_image',
  spec: SPEC,
  async run(input, ctx) {
    const prompt = (typeof input.prompt === 'string' ? input.prompt : 'Describe this image in detail.');
    let imageUrl: string;
    if (typeof input.url === 'string' && input.url) {
      imageUrl = input.url;
    } else if (typeof input.path === 'string' && input.path) {
      try {
        const bytes = await native.fs.readFileBytes(resolvePath(ctx, input.path));
        imageUrl = `data:image/png;base64,${bytesToBase64(bytes)}`;
      } catch (e) {
        console.error('[analyzeImageTool:readFile]', JSON.stringify({ path: input.path, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined);
        return `analyze_image: could not read ${input.path}: ${(e as Error).message}`;
      }
    } else {
      return 'analyze_image: provide a `path` or `url`';
    }
    try {
      const res = (await native.uglybot.request('textGen', {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image', image: imageUrl },
            ],
          },
        ],
      })) as { text?: string; content?: string } | string;
      if (typeof res === 'string') return res;
      return res.text ?? res.content ?? '(no analysis returned)';
    } catch (e) {
      console.error('[analyzeImageTool:textGen]', JSON.stringify({ hasUrl: typeof input.url === 'string' && !!input.url, path: input.path, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined);
      return `analyze_image failed (vision unavailable?): ${(e as Error).message}`;
    }
  },
};
