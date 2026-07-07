// `dep_docs` — fetch a dependency's docs (README / package.json) from the
// project's node_modules. Local-first (no network). Ported from ugly-studio
// f5a74c2^:server/coding-agent/tools/dep-docs.ts.

import { native } from 'ugly-app/native';
import type { TextGenTool } from 'ugly-app/shared';
import type { ToolModule } from './registry';
import { projectRoot } from './lspForProject';

const README_NAMES = ['README.md', 'readme.md', 'README', 'README.markdown', 'Readme.md'];

const SPEC: TextGenTool = {
  name: 'dep_docs',
  description:
    "Read a dependency's documentation (README, else package.json summary) from " +
    'the project node_modules. Use to learn a library\'s API before using it.',
  parameters: {
    type: 'object',
    properties: {
      package: { type: 'string', description: 'Package name, e.g. "zod" or "@scope/pkg".' },
    },
    required: ['package'],
    additionalProperties: false,
  },
};

export const depDocsTool: ToolModule = {
  name: 'dep_docs',
  spec: SPEC,
  async run(input, ctx) {
    const pkg = (typeof input.package === 'string' ? input.package : '').trim();
    if (!pkg) return 'dep_docs: `package` is required';
    const root = projectRoot(ctx);
    if (!root) return '(no project open)';
    const base = `${root.replace(/\/+$/, '')}/node_modules/${pkg}`;
    for (const name of README_NAMES) {
      try {
        const text = await native.fs.readFile(`${base}/${name}`);
        if (text.trim()) return text.slice(0, 20000);
      } catch {
        /* try next */
      }
    }
    try {
      const pj = JSON.parse(await native.fs.readFile(`${base}/package.json`)) as {
        description?: string;
        homepage?: string;
        version?: string;
      };
      return `# ${pkg}\n${pj.description ?? '(no description)'}\nversion: ${pj.version ?? '?'}\nhomepage: ${pj.homepage ?? 'n/a'}`;
    } catch {
      /* fall through */
    }
    return `(no docs found for ${pkg} in node_modules — is it installed?)`;
  },
};
