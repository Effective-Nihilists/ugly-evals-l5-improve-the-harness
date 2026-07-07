// `multiedit` — apply a sequence of edits to a single file, atomically. Ported
// from ugly-studio f5a74c2^:server/coding-agent/tools/multiedit.ts. Each edit
// is any edit_file mode (string-match or hashline anchor/insert_after/range) via
// the shared applyEdit. Edits apply in order, each seeing the previous result;
// if any edit fails the whole set is rejected and the file is left untouched.

import { native } from 'ugly-app/native';
import type { TextGenTool } from 'ugly-app/shared';
import type { ToolModule } from './registry';
import { resolvePath } from '../tools';
import { markDirty } from './codebaseDirty';
import { applyEdit, type EditOp } from './applyEdit';

interface MultieditArgs {
  path?: string;
  file_path?: string;
  edits: EditOp[];
}

const SPEC: TextGenTool = {
  name: 'multiedit',
  description:
    'Apply several edits to ONE file in a single call. Each edit is any edit_file ' +
    'mode — `old_string`/`new_string` (+`replace_all`), or a hashline `anchor` / ' +
    '`insert_after` / `range` with `new_content`. Edits apply in order (each sees ' +
    'the previous result); if any fails the whole set is rejected and the file is ' +
    'left unchanged.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the workspace root.' },
      edits: {
        type: 'array',
        description: 'Edits applied in order.',
        items: {
          type: 'object',
          properties: {
            old_string: { type: 'string', description: 'Exact text to replace (string-match mode).' },
            new_string: { type: 'string', description: 'Replacement text (string-match mode).' },
            replace_all: { type: 'boolean', description: 'Replace every occurrence.' },
            anchor: { type: 'string', description: 'A `<n>:<hash>`/line anchor to replace.' },
            insert_after: { type: 'string', description: 'An anchor to insert after.' },
            range: { type: 'string', description: 'An inclusive anchor range "42..47".' },
            new_content: { type: 'string', description: 'Content for anchor/insert_after/range modes.' },
          },
          additionalProperties: false,
        },
      },
    },
    required: ['path', 'edits'],
    additionalProperties: false,
  },
};

export const multieditTool: ToolModule = {
  name: 'multiedit',
  spec: SPEC,
  async run(input, ctx) {
    const args = input as unknown as MultieditArgs;
    const rawPath = args.path ?? args.file_path ?? '';
    if (!rawPath) return 'multiedit: `path` is required';
    if (!Array.isArray(args.edits) || args.edits.length === 0) {
      return 'multiedit: `edits` must be a non-empty array';
    }
    const abs = resolvePath(ctx, rawPath);
    let content: string;
    try {
      content = await native.fs.readFile(abs);
    } catch (e) {
      console.error('[multieditTool:readFile]', JSON.stringify({ path: rawPath, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined);
      return `multiedit: could not read ${rawPath}: ${(e as Error).message}`;
    }
    // Apply in memory; reject the whole set on the first failure (atomic).
    for (let i = 0; i < args.edits.length; i++) {
      const r = applyEdit(content, args.edits[i]);
      if (!r.ok) {
        return `multiedit: edit ${i + 1} (index ${i}) failed in ${rawPath}: ${r.error}; file left unchanged`;
      }
      content = r.body!;
    }
    await native.fs.writeFile(abs, content);
    if (ctx?.sessionId) markDirty(ctx.sessionId, abs);
    return `Applied ${args.edits.length} edit(s) to ${rawPath}`;
  },
};
