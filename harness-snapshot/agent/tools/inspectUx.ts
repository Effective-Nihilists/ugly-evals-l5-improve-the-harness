// `inspect_ux` — run the UX inspector (window.__uglyInspect) against the running
// app to surface objective defects (CLS, jank, overlap, safe-area). Ported from
// ugly-studio f5a74c2^:server/coding-agent/tools/inspect-ux.ts. Requires the
// studio inspect surface; degrades clearly when unavailable.

import type { TextGenTool } from 'ugly-app/shared';
import type { ToolModule } from './registry';

type InspectFn = (opts: unknown) => Promise<unknown>;

const SPEC: TextGenTool = {
  name: 'inspect_ux',
  description:
    'Probe the running app for objective UX defects (layout shift, animation ' +
    'jank, control overlap, safe-area violations, keyboard covering inputs). ' +
    'Run after UI changes.',
  parameters: {
    type: 'object',
    properties: {
      url_path: { type: 'string', description: 'Route to inspect, e.g. "/feed".' },
      device: { type: 'string', enum: ['desktop', 'ios', 'android'] },
      actions: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Interactions to drive.' },
    },
    required: [],
    additionalProperties: false,
  },
};

export const inspectUxTool: ToolModule = {
  name: 'inspect_ux',
  spec: SPEC,
  async run(input) {
    const fn = (globalThis as unknown as { __uglyInspect?: InspectFn }).__uglyInspect;
    if (typeof fn !== 'function') {
      return '(inspect_ux unavailable — the studio inspect surface is not present in this context)';
    }
    try {
      const report = await fn(input);
      return JSON.stringify(report, null, 2);
    } catch (e) {
      console.error('[inspectUxTool:inspect]', JSON.stringify({ input, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined);
      return `inspect_ux failed: ${(e as Error).message}`;
    }
  },
};
