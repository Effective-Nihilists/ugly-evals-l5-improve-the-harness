// The full tool catalog + a discovery search. Per-session tool availability is
// decided statically by gating.ts (COMMON + mode + project + feature gates —
// the monolith's model); `tool_search` uses `searchCatalog` for discovery and
// `tool_request` uses `fullCatalog` to explain why a tool is out of scope.

import type { AgentToolSpec } from '../../../shared/agent';
import { AGENT_TOOLS } from '../../../shared/agent';
import { registeredToolSpecs } from './registry';

/** Every tool the agent could use (legacy specs + registry). Called lazily so
 *  the registry is fully populated (avoids an import-time cycle). */
export function fullCatalog(): AgentToolSpec[] {
  return [...AGENT_TOOLS, ...registeredToolSpecs()];
}

/** Rank the full catalog against a natural-language query by word overlap. */
export function searchCatalog(query: string): { name: string; description: string; score: number }[] {
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  return fullCatalog()
    .map((t) => {
      const hay = `${t.name} ${t.description}`.toLowerCase();
      const score = words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
      return { name: t.name, description: t.description, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}
