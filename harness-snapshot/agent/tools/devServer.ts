// `dev_server_start` / `dev_server_stop` / `dev_server_errors` — control + inspect
// the project's dev server. The server is owned by PreviewPanel (renderer);
// start/stop write a command via the control-file bridge (devServerControl.ts)
// that PreviewPanel polls; errors reads the persisted dev log (devServerLog.ts)
// and surfaces just the error-ish lines. (The monolith's `dev_server_screenshot`
// is intentionally NOT ported — ugly-code has no Preview-iframe capture surface.)

import type { TextGenTool } from 'ugly-app/shared';
import type { ToolModule } from './registry';
import { projectRoot } from './lspForProject';
import { readDevLog } from '../../studio/panels/devServerLog';
import { writeDevControl } from '../../studio/panels/devServerControl';

/** A monotonic-ish nonce without Date/Math.random (kept deterministic-friendly):
 *  a module counter is enough — each tool call is a fresh request, and only the
 *  VALUE CHANGING matters to PreviewPanel's act-once check. */
let nonceCounter = 0;
function nextNonce(): string {
  nonceCounter += 1;
  return `n${nonceCounter}`;
}

const START_SPEC: TextGenTool = {
  name: 'dev_server_start',
  description:
    'Start (or restart) the project dev server (`pnpm dev`) via the Preview ' +
    'panel. Returns immediately; use dev_server_logs / dev_server_errors to check ' +
    'boot progress. Requires an open project with the Preview panel mounted.',
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
};

const STOP_SPEC: TextGenTool = {
  name: 'dev_server_stop',
  description: 'Stop the project dev server (`pnpm dev`) via the Preview panel.',
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
};

const ERRORS_SPEC: TextGenTool = {
  name: 'dev_server_errors',
  description:
    'Return just the error-ish lines from the dev server log (compile errors, ' +
    'stack traces, non-zero exits). Use after a change to check the app still ' +
    'builds/runs. Empty when the log is clean.',
  parameters: {
    type: 'object',
    properties: {
      lines: { type: 'number', description: 'Max trailing error lines to return (default 100).' },
    },
    required: [],
    additionalProperties: false,
  },
};

const ERROR_RE = /error|err!|failed|✗|exception|cannot find|is not defined|unexpected|\[error:|exited [1-9]/i;

export const devServerStartTool: ToolModule = {
  name: 'dev_server_start',
  spec: START_SPEC,
  async run(_input, ctx) {
    const root = projectRoot(ctx);
    if (!root) return '(no project open)';
    try {
      await writeDevControl(root, 'start', nextNonce());
      return 'Requested dev server start (Preview panel is booting `pnpm dev`). Check dev_server_logs for progress.';
    } catch (e) {
      console.error('[devServerStartTool:writeDevControl]', JSON.stringify({ root, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined);
      return `dev_server_start failed: ${(e as Error).message}`;
    }
  },
};

export const devServerStopTool: ToolModule = {
  name: 'dev_server_stop',
  spec: STOP_SPEC,
  async run(_input, ctx) {
    const root = projectRoot(ctx);
    if (!root) return '(no project open)';
    try {
      await writeDevControl(root, 'stop', nextNonce());
      return 'Requested dev server stop.';
    } catch (e) {
      console.error('[devServerStopTool:writeDevControl]', JSON.stringify({ root, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined);
      return `dev_server_stop failed: ${(e as Error).message}`;
    }
  },
};

export const devServerErrorsTool: ToolModule = {
  name: 'dev_server_errors',
  spec: ERRORS_SPEC,
  async run(input, ctx) {
    const root = projectRoot(ctx);
    if (!root) return '(no project open)';
    const raw = await readDevLog(root);
    if (!raw.trim()) {
      return '(no dev-server log — the dev server may not be running; start it with dev_server_start)';
    }
    const n = typeof input.lines === 'number' && input.lines > 0 ? Math.floor(input.lines) : 100;
    const errs = raw.replace(/\n+$/, '').split('\n').filter((l) => ERROR_RE.test(l));
    if (!errs.length) return '(no errors in the dev server log)';
    return errs.slice(-n).join('\n');
  },
};
