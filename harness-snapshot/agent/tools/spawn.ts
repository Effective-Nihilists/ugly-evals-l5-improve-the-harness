// Spawn a process via the native facade and collect its full output + exit code.
// Unlike tools.ts's `runCommand` (which annotates output with [exit N] for the
// model), this returns the raw streams so callers can branch on the code —
// e.g. ripgrep's exit 1 ("no matches") vs 2 (error).

import { native } from 'ugly-app/native';

export interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export function spawnCollect(
  cmd: string,
  args: string[],
  opts: Parameters<typeof native.process.spawn>[2] = {},
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    try {
      const proc = native.process.spawn(cmd, args, opts);
      proc.onStdout((c) => (stdout += c));
      proc.onStderr((c) => (stderr += c));
      proc.onError((e) => { resolve({ stdout, stderr: stderr + e, code: null }); });
      proc.onExit((code) => { resolve({ stdout, stderr, code }); });
    } catch (e) {
      console.error('[spawnTool:spawn]', JSON.stringify({ cmd, args, error: e instanceof Error ? e.message : String(e) }), e instanceof Error ? e.stack : undefined);
      resolve({ stdout, stderr: (e as Error).message, code: null });
    }
  });
}
