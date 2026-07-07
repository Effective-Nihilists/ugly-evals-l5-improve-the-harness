// Registry of restored agent tools. `dispatchTool` consults this first; a name
// it doesn't recognise falls through to the legacy inline switch. Each restored
// tool is a self-contained module implementing ToolModule and pushing itself
// (or being registered) here — mirroring the monolith's tools/<tool>.ts layout.

import type { TextGenTool } from 'ugly-app/shared';
import type { AgentToolSpec, ToolName } from '../../../shared/agent';
import type { ToolContext } from '../tools';
import { grepTool } from './grep';
import { globTool } from './glob';
import { multieditTool } from './multiedit';
import { pythonExecTool } from './pythonExec';
import { pythonLibrariesTool } from './pythonLibraries';
import { devServerLogsTool } from './devServerLogs';
import { devServerStartTool, devServerStopTool, devServerErrorsTool } from './devServer';
import { webFetchTool } from './webFetch';
import { webSearchTool } from './webSearch';
import { depDocsTool } from './depDocs';
import { todosTool } from './todos';
import { scratchpadTool } from './scratchpad';
import { memorySaveTool, memoryReadTool, memoryListTool, memoryDeleteTool } from './memory';
import { askUserTool } from './askUser';
import { delegateTool, delegateParallelTool } from './delegate';
import { blackboardPostTool } from './blackboard';
import { toolSearchTool } from './toolSearch';
import { toolRequestTool } from './toolRequest';
import { specReadTool, specWriteTool } from './specRead';
import { analyzeImageTool } from './analyzeImage';
import { inspectUxTool } from './inspectUx';

export interface ToolModule {
  /** Typed against the shared `ToolName` union — a registry tool whose name
   *  isn't a known `ToolName` fails to compile (keeps the UI + specs in sync).
   *  This is the authoritative dispatch name; `registeredToolSpecs()` stamps it
   *  onto the model-facing spec so the wire name can't drift from it. */
  name: ToolName;
  /** Model-facing JSON-schema spec (added to AGENT_TOOLS). Its `name` is
   *  overwritten with `this.name` when specs are assembled. */
  spec: TextGenTool;
  /** Execute the tool; returns the string fed back as tool_result. */
  run(
    input: Record<string, unknown>,
    ctx: ToolContext | undefined,
  ): Promise<string>;
}

export const TOOL_REGISTRY: ToolModule[] = [grepTool, globTool, multieditTool, pythonExecTool, pythonLibrariesTool, devServerLogsTool, devServerStartTool, devServerStopTool, devServerErrorsTool, webFetchTool, webSearchTool, depDocsTool, todosTool, scratchpadTool, memorySaveTool, memoryReadTool, memoryListTool, memoryDeleteTool, askUserTool, delegateTool, delegateParallelTool, blackboardPostTool, toolSearchTool, toolRequestTool, specReadTool, specWriteTool, analyzeImageTool, inspectUxTool];

/** Model-facing specs for every registered tool (appended to AGENT_TOOLS when
 *  assembling the per-turn tool list). */
export function registeredToolSpecs(): AgentToolSpec[] {
  // Stamp the typed dispatch name onto the model-facing spec so the wire name is
  // always the `ToolName` the UI + dispatcher match on (no string drift).
  return TOOL_REGISTRY.map((t) => ({ ...t.spec, name: t.name }));
}

/** Run a registered tool. Returns undefined when `name` is not registered, so
 *  the caller can fall back to the legacy dispatch switch. */
export async function runRegisteredTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext | undefined,
): Promise<string | undefined> {
  const mod = TOOL_REGISTRY.find((t) => t.name === name);
  if (!mod) return undefined;
  return mod.run(input, ctx);
}
