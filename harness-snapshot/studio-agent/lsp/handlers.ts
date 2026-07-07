/**
 * Editor lsp* request handlers — the real implementations behind the orphaned
 * `lspDefinition` / `lspImplementation` / `lspReferences` / `lspHover` API
 * contract. They run in the studio renderer, drive a per-workspace LspClient
 * (from the registry) over the UglyNative process/fs facades, and shape results
 * to match `client/studio/shared/api.ts`:
 *
 *   - input positions are 0-indexed (LSP convention); results are 1-indexed
 *     (the client already maps `line + 1` for the editor's reveal API)
 *   - result `uri`s are converted back to filesystem paths
 *   - each hit gets a best-effort one-line `preview` read from disk
 *   - unknown languages / errors degrade to empty results (never throw)
 *
 * Handlers take `activeProjectPath` explicitly (rather than importing the
 * projectPath module) so they stay trivially unit-testable.
 */

import { native } from 'ugly-app/native';
import { getEditorLspClient, languageIdForPath } from './registry';
import { fileUriToPath } from './client';

export interface LspLocationInput {
  path: string;
  line: number;
  character: number;
  cwd?: string;
  /** Live editor buffer for unsaved-edit accuracy; synced via openFile(path, content). */
  content?: string;
}

export interface LspLocation {
  path: string;
  line: number;
  character: number;
  preview?: string;
}

/** Dirname without node:path — fall back to the whole path if there's no slash. */
function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i > 0 ? p.slice(0, i) : p;
}

/** Best-effort trimmed source line (1-indexed) for a navigation result. */
async function previewLine(
  absPath: string,
  line1: number,
): Promise<string | undefined> {
  try {
    const content = await native.fs.readFile(absPath);
    const trimmed = content.split('\n')[line1 - 1]?.trim();
    return trimmed ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

async function locations(
  method: 'findDefinition' | 'findImplementations' | 'findReferences',
  input: LspLocationInput,
  activeProjectPath: string | null,
  ensureProject: boolean,
): Promise<{ results: LspLocation[] }> {
  const lang = languageIdForPath(input.path);
  if (!lang) return { results: [] };
  try {
    const root = input.cwd ?? activeProjectPath ?? dirOf(input.path);
    const client = await getEditorLspClient(root, lang);
    // References/implementations are cross-file — the whole project graph must
    // be loaded, not just the cursor file. Definition resolves from the
    // containing project that opening the cursor file already loads.
    if (ensureProject) await client.ensureProjectLoaded();
    await client.openFile(input.path, input.content);
    const raw = await client[method](input.path, input.line, input.character);
    const results = await Promise.all(
      raw.map(async (r): Promise<LspLocation> => {
        const path = fileUriToPath(r.uri);
        const preview = await previewLine(path, r.line);
        return preview === undefined
          ? { path, line: r.line, character: r.character }
          : { path, line: r.line, character: r.character, preview };
      }),
    );
    return { results };
  } catch (e) {
    console.error('[lspHandlers:locations]', JSON.stringify({ method, path: input.path, line: input.line, character: input.character, cwd: input.cwd, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined);
    return { results: [] };
  }
}

export function lspDefinition(
  input: LspLocationInput,
  activeProjectPath: string | null,
): Promise<{ results: LspLocation[] }> {
  return locations('findDefinition', input, activeProjectPath, false);
}

export function lspImplementation(
  input: LspLocationInput,
  activeProjectPath: string | null,
): Promise<{ results: LspLocation[] }> {
  return locations('findImplementations', input, activeProjectPath, true);
}

export function lspReferences(
  input: LspLocationInput,
  activeProjectPath: string | null,
): Promise<{ results: LspLocation[] }> {
  return locations('findReferences', input, activeProjectPath, true);
}

export async function lspHover(
  input: LspLocationInput,
  activeProjectPath: string | null,
): Promise<{ contents: string | null }> {
  const lang = languageIdForPath(input.path);
  if (!lang) return { contents: null };
  try {
    const root = input.cwd ?? activeProjectPath ?? dirOf(input.path);
    const client = await getEditorLspClient(root, lang);
    await client.openFile(input.path, input.content);
    return { contents: await client.hover(input.path, input.line, input.character) };
  } catch (e) {
    console.error('[lspHandlers:lspHover]', JSON.stringify({ path: input.path, line: input.line, character: input.character, cwd: input.cwd, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined);
    return { contents: null };
  }
}
