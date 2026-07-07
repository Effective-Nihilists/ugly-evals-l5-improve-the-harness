// `tool_request` — record a wishlist request for a capability the session
// doesn't expose. Ported from ugly-studio f5a74c2^:.../tool-request.ts. Tool
// availability is STATIC (per mode / project / feature — see gating.ts), so this
// no longer "activates" anything; it's the signal-a-gap primitive the monolith
// used. If the named tool exists but is out of the current session's set, the
// reply says why (wrong mode / not an ugly-app project / feature off).

import type { TextGenTool } from 'ugly-app/shared';
import type { ToolModule } from './registry';
import { fullCatalog } from './catalog';

const SPEC: TextGenTool = {
  name: 'tool_request',
  description:
    'Request a capability the current session does not expose (a wishlist ' +
    'signal). Tool availability is fixed per session, so this does not grant a ' +
    'tool — use it to flag a genuine gap. Give the tool name (or a description) ' +
    'and why you need it.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Exact tool name, or a short description of the capability.' },
      purpose: { type: 'string', description: 'Why you need it.' },
    },
    required: ['name'],
    additionalProperties: false,
  },
};

export const toolRequestTool: ToolModule = {
  name: 'tool_request',
  spec: SPEC,
  // eslint-disable-next-line @typescript-eslint/require-await
  async run(input) {
    const name = (typeof input.name === 'string' ? input.name : '').trim();
    if (!name) return 'tool_request: `name` is required';
    const exists = fullCatalog().some((t) => t.name === name);
    if (exists) {
      return `${JSON.stringify(name)} exists but isn't in this session's tool set — it's gated (wrong mode, not an ugly-app project, or the feature is off). Proceed with the tools you have.`;
    }
    return `Recorded a request for ${JSON.stringify(name)}. No such tool exists; use tool_search to find the closest available one.`;
  },
};
