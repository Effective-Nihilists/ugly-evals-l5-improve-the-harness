// `python_exec` — run a Python snippet via the hardened one-shot runner.
import type { TextGenTool } from 'ugly-app/shared';
import type { ToolModule } from './registry';
import { projectRoot } from './lspForProject';
import { runPythonOneShot } from './pythonOneShot';

const SPEC: TextGenTool = {
  name: 'python_exec',
  description:
    'Run a Python snippet via `uv run` in the project environment and return its ' +
    'stdout/stderr. Use for quick computation, data inspection, or scripting — not ' +
    'for long-running processes. Times out after 60s by default (override timeout_ms).',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'Python source to execute.' },
      timeout_ms: { type: 'number', description: 'Max run time in ms (default 60000).' },
    },
    required: ['code'],
    additionalProperties: false,
  },
};

export const pythonExecTool: ToolModule = {
  name: 'python_exec',
  spec: SPEC,
  async run(input, ctx) {
    const code = typeof input.code === 'string' ? input.code : '';
    if (!code) return 'python_exec: `code` is required';
    const root = projectRoot(ctx) ?? undefined;
    const timeoutMs = typeof input.timeout_ms === 'number' ? input.timeout_ms : undefined;
    const r = await runPythonOneShot({ code, ...(root ? { cwd: root } : {}), ...(timeoutMs ? { timeoutMs } : {}) });
    return r.output || '(no output)';
  },
};
