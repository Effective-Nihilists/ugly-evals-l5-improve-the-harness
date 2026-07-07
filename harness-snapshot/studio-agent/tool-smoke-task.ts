// E2E fixture task bundle: runs EVERY coding-agent tool via the real `dispatchTool`
// inside a background-task Node child, to confirm the Studio task environment + bundled
// binaries work. Built by `ugly-app build:tasks` (declared in .uglyapp) and driven by the
// ugly-studio task-tools e2e (which spawns it through the real forkTaskChild + bundled env).
import { defineTask, taskContext, createNodeUglyNative } from 'ugly-app/native';
import { dispatchTool, type ToolContext } from '../../agent/tools';

// Node-backed window.UglyNative so the agent's tools resolve native.fs/process to node:fs /
// child_process. ugly-app's permissions read platform lazily, so this body-level install
// (after the imports) is respected.
(globalThis as { UglyNative?: unknown }).UglyNative = createNodeUglyNative();

const t = taskContext<{ dir?: string }>();

interface ToolResult { ok: boolean; out: string }

defineTask({
  onCall: {
    // Run each tool against `dir` and report { ok, out } per tool so the e2e can assert
    // fs ops + that run_command/db resolve the bundled node/git/bash via the task PATH.
    runAllTools: async ({ dir }: { dir: string }): Promise<Record<string, ToolResult>> => {
      const ctx: ToolContext = { projectDir: dir, workspaceDir: dir, mode: 'edit' };
      const results: Record<string, ToolResult> = {};
      const run = async (label: string, fn: () => Promise<string>): Promise<void> => {
        try {
          // Per-tool timeout so a db tool waiting on an absent dev postgres can't hang the
          // whole run (a timeout still implies node spawned — the env/binary point).
          const out = await Promise.race<string>([
            fn(),
            new Promise<string>((_, rej) => setTimeout(() => { rej(new Error('TIMEOUT')); }, 8000)),
          ]);
          results[label] = { ok: true, out: out.slice(0, 300) };
        } catch (e) {
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a thrown value can be null/undefined despite the `as Error` cast
          results[label] = { ok: false, out: (e as Error)?.message ?? String(e) };
        }
      };

      // A .uglyapp so the db/bash project-id resolution has something to read.
      await run('write:.uglyapp', () =>
        dispatchTool('write', { path: '.uglyapp', content: JSON.stringify({ projectId: 'tool-smoke' }) }, ctx));
      // fs tools
      await run('write', () => dispatchTool('write', { path: 'hello.txt', content: 'hi from task' }, ctx));
      await run('read', () => dispatchTool('read', { path: 'hello.txt' }, ctx));
      await run('edit', () => dispatchTool('edit', { path: 'hello.txt', old: 'hi from', new: 'edited by' }, ctx));
      await run('read_after_edit', () => dispatchTool('read', { path: 'hello.txt' }, ctx));
      await run('bash:ls', () => dispatchTool('bash', { command: 'ls', description: 'list dir' }, ctx));
      // bash — confirms the bundled binaries are on the task child's PATH
      await run('bash:node', () => dispatchTool('bash', { command: 'node --version', description: 'node version' }, ctx));
      await run('bash:node-path', () => dispatchTool('bash', { command: 'node -p process.execPath', description: 'node path' }, ctx));
      await run('bash:git', () => dispatchTool('bash', { command: 'git --version', description: 'git version' }, ctx));
      await run('bash:echo', () => dispatchTool('bash', { command: 'echo task-bash-ok', description: 'echo ok' }, ctx));
      // db tools — spawn `node` with the DB script (confirms node resolves + the script runs;
      // a real query also needs the dev postgres, which the env confirmation doesn't require).
      await run('database_sql_query', () => dispatchTool('database_sql_query', { sql: 'select 1 as n' }, ctx));
      await run('database', () => dispatchTool('database', { collection: 'smoke', limit: 1 }, ctx));
      return results;
    },
  },
});

t.setSnapshot({ ready: true });
