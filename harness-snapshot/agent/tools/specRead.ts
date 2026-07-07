// `spec_read` / `spec_write` — read/write a project spec on ugly.bot. Ported
// from ugly-studio f5a74c2^:server/coding-agent/tools/spec-tools.ts + spec-vfs.ts.
// Both degrade cleanly when the spec service isn't reachable / no specs exist.

import { native } from 'ugly-app/native';
import type { TextGenTool } from 'ugly-app/shared';
import type { ToolModule } from './registry';

const SPEC: TextGenTool = {
  name: 'spec_read',
  description:
    'Read a project spec (design/requirements doc) hosted on ugly.bot. Omit ' +
    '`id` to list available specs.',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string', description: 'Spec id/path; omit to list.' } },
    required: [],
    additionalProperties: false,
  },
};

export const specReadTool: ToolModule = {
  name: 'spec_read',
  spec: SPEC,
  async run(input) {
    const id = typeof input.id === 'string' ? input.id : '';
    try {
      const res = (await native.uglybot.request('specRead', id ? { id } : {})) as
        | { content?: string; specs?: { id: string; title?: string }[]; error?: string }
        | string;
      if (typeof res === 'string') return res;
      if (res.error) return `spec_read unavailable: ${res.error}`;
      if (res.content) return res.content;
      if (res.specs) {
        return res.specs.length
          ? res.specs.map((s) => `- ${s.id}${s.title ? `: ${s.title}` : ''}`).join('\n')
          : '(no specs for this project)';
      }
      return '(no spec content)';
    } catch (e) {
      console.error('[specReadTool:request]', JSON.stringify({ id, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined);
      return `spec_read unavailable: ${(e as Error).message}`;
    }
  },
};

const SPEC_WRITE: TextGenTool = {
  name: 'spec_write',
  description:
    'Write/replace the current project spec (design/requirements doc) hosted on ' +
    'ugly.bot. Pass the full spec `content`.',
  parameters: {
    type: 'object',
    properties: { content: { type: 'string', description: 'The full spec content to store.' } },
    required: ['content'],
    additionalProperties: false,
  },
};

export const specWriteTool: ToolModule = {
  name: 'spec_write',
  spec: SPEC_WRITE,
  async run(input) {
    const content = typeof input.content === 'string' ? input.content : '';
    if (!content) return 'spec_write: `content` is required.';
    try {
      const res = (await native.uglybot.request('specWrite', { content })) as
        | { ok?: boolean; error?: string }
        | string;
      if (typeof res === 'string') return res;
      if (res.error) return `spec_write unavailable: ${res.error}`;
      return 'Spec written.';
    } catch (e) {
      console.error('[specWriteTool:request]', JSON.stringify({ contentLength: content.length, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined);
      return `spec_write unavailable: ${(e as Error).message}`;
    }
  },
};
