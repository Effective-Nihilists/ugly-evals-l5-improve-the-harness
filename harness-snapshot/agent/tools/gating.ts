// Static per-session tool gating — the monolith's model (f5a74c2^:tools/index.ts
// + session.ts:buildTurnRegistry), replacing the earlier dynamic tool_search /
// tool_request catalog. A session's tools = COMMON (always) + the single- or
// group-mode set + the ugly-app project set (when the open project is an
// ugly-app project) + feature gates. tool_search / tool_request stay as
// single-mode utility tools (discovery / wishlist), NOT the gating mechanism.

import type { AgentToolSpec, ToolName } from '../../../shared/agent';
import { fullCatalog } from './catalog';

/** COMMON — always available, both modes. */
const COMMON_TOOLS: ToolName[] = [
  'read', 'write', 'edit', 'multiedit', 'glob', 'grep', 'bash', 'todos',
  'python_exec', 'web_fetch',
];

/** Added only in single (default interactive) mode. */
const SINGLE_MODE_TOOLS: ToolName[] = [
  'spec_read', 'spec_write', 'scratchpad',
  'memory_read', 'memory_save', 'memory_list', 'memory_delete',
  'delegate', 'delegate_parallel', 'ask_user', 'web_search',
  'analyze_image', 'dep_docs', 'python_libraries',
  'tool_search', 'tool_request',
];

/** Added only in group (multi-model) mode. */
const GROUP_MODE_TOOLS: ToolName[] = ['blackboard_post'];

/** Added (either mode) only when the open project is an ugly-app project. */
const UGLY_APP_TOOLS: ToolName[] = [
  'database', 'database_sql_query',
  'dev_server_start', 'dev_server_stop', 'dev_server_logs', 'dev_server_errors',
  'inspect_ux',
];

/** Feature gates. Defaults mirror the monolith: multiAgent OFF by default;
 *  memory + specs on; interactive (ask_user) on. */
export interface GatingFeatures {
  memoryRead: boolean;
  memoryWrite: boolean;
  multiAgent: boolean;
  specs: boolean;
  interactive: boolean;
}
export const DEFAULT_FEATURES: GatingFeatures = {
  memoryRead: true,
  memoryWrite: true,
  multiAgent: false,
  specs: true,
  interactive: true,
};

export interface GatingInput {
  mode: 'single' | 'group';
  isUglyApp: boolean;
  features?: Partial<GatingFeatures>;
}

/** The set of tool names allowed for a session, per the static gating model. */
export function allowedToolNames(input: GatingInput): Set<ToolName> {
  const f = { ...DEFAULT_FEATURES, ...input.features };
  const s = new Set<ToolName>(COMMON_TOOLS);
  (input.mode === 'group' ? GROUP_MODE_TOOLS : SINGLE_MODE_TOOLS).forEach((t) => s.add(t));
  if (input.isUglyApp) UGLY_APP_TOOLS.forEach((t) => s.add(t));
  if (!f.specs) { s.delete('spec_read'); s.delete('spec_write'); }
  if (!f.memoryRead) { s.delete('memory_read'); s.delete('memory_list'); }
  if (!f.memoryWrite) { s.delete('memory_save'); s.delete('memory_delete'); }
  if (!f.multiAgent) { s.delete('delegate'); s.delete('delegate_parallel'); }
  if (!f.interactive) s.delete('ask_user');
  return s;
}

/** The model-facing specs allowed for a session (what the getter returns each
 *  turn). Names not backed by a defined tool are simply absent from the
 *  catalog, so gating may reference a tool before it exists (e.g. dev_server_*
 *  until their host channels land) without breaking. */
export function sessionToolSpecs(input: GatingInput): AgentToolSpec[] {
  const allowed = allowedToolNames(input);
  return fullCatalog().filter((t) => allowed.has(t.name));
}
