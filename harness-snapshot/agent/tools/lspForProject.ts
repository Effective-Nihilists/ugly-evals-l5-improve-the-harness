// Resolve the TypeScript LSP client for a tool's project context. Reused by the
// LSP-backed tools (grep LSP modes, lsp_diagnostics). The agent task context
// gets its own registry LspClient per workspace — separate from the editor's.

import { getEditorLspClient } from '../../studio/agent/lsp/registry';
import { getActiveProjectPath } from '../../studio/hooks/useSocket';
import type { LspClient } from '../../studio/agent/lsp/client';
import type { ToolContext } from '../tools';

/** The project root a tool operates in: explicit ctx dirs, else the open project. */
export function projectRoot(ctx: ToolContext | undefined): string | null {
  return ctx?.projectDir ?? ctx?.workspaceDir ?? getActiveProjectPath() ?? null;
}

/** The TypeScript LSP client for the ctx's project, or null when unavailable
 *  (no project, or the server failed to start). Never throws. */
export async function lspForProject(
  ctx: ToolContext | undefined,
): Promise<LspClient | null> {
  const root = projectRoot(ctx);
  if (!root) return null;
  try {
    return await getEditorLspClient(root, 'typescript');
  } catch {
    return null;
  }
}
