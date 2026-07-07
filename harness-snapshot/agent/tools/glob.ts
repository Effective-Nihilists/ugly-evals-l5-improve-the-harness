// `glob` — file-name-pattern finding. Ported from ugly-studio
// f5a74c2^:server/coding-agent/tools/glob.ts; adapted to `rg --files -g`.

import { native } from 'ugly-app/native';
import type { TextGenTool } from 'ugly-app/shared';
import type { ToolModule } from './registry';
import { projectRoot } from './lspForProject';
import { spawnCollect } from './spawn';
import { HARD_EXCLUDES } from './pathExcludes';

export interface GlobArgs {
  pattern: string;
  path?: string;
  include_ignored?: boolean;
}

/** Map glob args → `rg --files` argv. Pure, exported for test. `extraExcludes`
 *  carries `.globignore` entries. Hard excludes are always applied — including
 *  when include_ignored adds --no-ignore — because `-g '!x'` overrides are honored
 *  regardless of ignore-file parsing. */
export function buildGlobArgs(args: GlobArgs, extraExcludes: string[] = []): string[] {
  const a = ['--files', '-g', args.pattern];
  if (args.include_ignored) a.push('--no-ignore');
  for (const dir of HARD_EXCLUDES) a.push('-g', `!${dir}`);
  for (const pat of extraExcludes) a.push('-g', `!${pat}`);
  if (args.path) a.push(args.path);
  return a;
}

/** Parse a `.globignore`: one glob per line; blank lines and `#` comments dropped.
 *  Pure, exported for test. */
export function parseGlobignore(content: string): string[] {
  return content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

/** Read `<root>/.globignore` if present (best-effort; missing file → no excludes). */
async function readGlobignore(root: string | undefined): Promise<string[]> {
  if (!root) return [];
  try {
    const raw = await native.fs.readFile(`${root}/.globignore`);
    return parseGlobignore(raw);
  } catch {
    return [];
  }
}

const SPEC: TextGenTool = {
  name: 'glob',
  description:
    'Find files by name pattern (glob), e.g. "**/*.test.ts" or "src/**/*.tsx". ' +
    'Returns matching file paths, one per line.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, e.g. "**/*.ts".' },
      path: { type: 'string', description: 'Optional directory to scope the search.' },
      include_ignored: { type: 'boolean', description: 'Also include .gitignore-d files.' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
};

export const globTool: ToolModule = {
  name: 'glob',
  spec: SPEC,
  async run(input, ctx) {
    const args = input as unknown as GlobArgs;
    const root = projectRoot(ctx) ?? undefined;
    const extraExcludes = await readGlobignore(root);
    const { stdout, stderr, code } = await spawnCollect('rg', buildGlobArgs(args, extraExcludes), {
      ...(root ? { cwd: root } : {}),
    });
    if (code === 1 || (code === 0 && !stdout.trim())) {
      return `(no files match ${JSON.stringify(args.pattern)})`;
    }
    if (code !== 0 && code !== null) {
      return `(glob error, exit ${code})\n${(stderr || stdout).trim()}`;
    }
    return stdout.trimEnd();
  },
};
