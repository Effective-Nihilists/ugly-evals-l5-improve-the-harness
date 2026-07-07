// `memory_save` / `memory_read` / `memory_list` / `memory_delete` — persistent,
// project-scoped agent memory as JSON files under <project>/.ugly-studio/memory/.
// Ported from ugly-studio f5a74c2^:.../memory-*.ts.

import { native } from 'ugly-app/native';
import type { TextGenTool } from 'ugly-app/shared';
import type { ToolModule } from './registry';
import { projectRoot } from './lspForProject';

function memDir(root: string): string {
  return `${root.replace(/\/+$/, '')}/.ugly-studio/memory`;
}
function slug(name: string): string {
  return name.trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'note';
}

// eslint-disable-next-line @typescript-eslint/require-await
async function requireRoot(ctx: Parameters<ToolModule['run']>[1]): Promise<string | null> {
  return projectRoot(ctx);
}

export const memorySaveTool: ToolModule = {
  name: 'memory_save',
  spec: {
    name: 'memory_save',
    description: 'Save a durable memory (a fact worth remembering across sessions) under a name.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short name/key for the memory.' },
        content: { type: 'string', description: 'The fact to remember.' },
      },
      required: ['name', 'content'],
      additionalProperties: false,
    },
  } satisfies TextGenTool,
  async run(input, ctx) {
    const root = await requireRoot(ctx);
    if (!root) return '(no project open)';
    const name = (typeof input.name === 'string' ? input.name : '').trim();
    if (!name) return 'memory_save: `name` is required';
    await native.fs.mkdir(memDir(root), true);
    await native.fs.writeFile(
      `${memDir(root)}/${slug(name)}.json`,
      JSON.stringify({ name, content: (typeof input.content === 'string' ? input.content : '') }, null, 2),
    );
    return `saved memory ${JSON.stringify(name)}`;
  },
};

export const memoryReadTool: ToolModule = {
  name: 'memory_read',
  spec: {
    name: 'memory_read',
    description: 'Read a saved memory by name.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The memory name.' } },
      required: ['name'],
      additionalProperties: false,
    },
  } satisfies TextGenTool,
  async run(input, ctx) {
    const root = await requireRoot(ctx);
    if (!root) return '(no project open)';
    const name = (typeof input.name === 'string' ? input.name : '').trim();
    try {
      const raw = await native.fs.readFile(`${memDir(root)}/${slug(name)}.json`);
      const m = JSON.parse(raw) as { name: string; content: string };
      return `# ${m.name}\n${m.content}`;
    } catch {
      return `(no memory named ${JSON.stringify(name)})`;
    }
  },
};

export const memoryListTool: ToolModule = {
  name: 'memory_list',
  spec: {
    name: 'memory_list',
    description: 'List all saved memory names.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  } satisfies TextGenTool,
  async run(_input, ctx) {
    const root = await requireRoot(ctx);
    if (!root) return '(no project open)';
    try {
      const entries = await native.fs.readdir(memDir(root));
      const names: string[] = [];
      for (const e of entries) {
        if (!e.isFile || !e.name.endsWith('.json')) continue;
        try {
          const m = JSON.parse(await native.fs.readFile(`${memDir(root)}/${e.name}`)) as { name?: string };
          names.push(m.name ?? e.name.replace(/\.json$/, ''));
        } catch {
          names.push(e.name.replace(/\.json$/, ''));
        }
      }
      return names.length ? names.map((n) => `- ${n}`).join('\n') : '(no saved memories)';
    } catch {
      return '(no saved memories)';
    }
  },
};

export const memoryDeleteTool: ToolModule = {
  name: 'memory_delete',
  spec: {
    name: 'memory_delete',
    description: 'Delete a saved memory by name.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The memory name.' } },
      required: ['name'],
      additionalProperties: false,
    },
  } satisfies TextGenTool,
  async run(input, ctx) {
    const root = await requireRoot(ctx);
    if (!root) return '(no project open)';
    const name = (typeof input.name === 'string' ? input.name : '').trim();
    try {
      await native.fs.rm(`${memDir(root)}/${slug(name)}.json`, { force: true });
      return `deleted memory ${JSON.stringify(name)}`;
    } catch (e) {
      console.error('[memoryDeleteTool:rm]', JSON.stringify({ name, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined);
      return `(could not delete ${JSON.stringify(name)})`;
    }
  },
};
