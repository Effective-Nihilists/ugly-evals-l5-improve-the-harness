// ugly-code CLI entry. First-class eval runner so `pnpm dlx ugly-code --eval <task>`
// runs an eval against the deployed origin as a logged-in user.
//   ugly-code --eval <task> [--model m] [--origin o] [--token t] [--test-user]
//   ugly-code --login
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolveAuth } from './auth';
import { runEval } from './evalRun';
import { runComparison, renderScoreboard, type CompareSpec } from './compare';
import { historyPath, type RunHistoryEntry } from '../studio/evals/history';
import type { SessionSnapshot } from '../studio/shared/api';

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v && !v.startsWith('--') ? v : undefined;
}

/**
 * Parse the `--model-mode` / `--group-models` flags into a `modelMode` union.
 *   --model-mode auto|max|group|single:<id>   --group-models a,b,c (→ group)
 * `--group-models` wins (implies group with an explicit pool); `group` with no
 * pool → empty models[] (the host falls back to its default peer pool).
 */
export function parseModelMode(modelModeStr: string | undefined, groupModels: string | undefined): SessionSnapshot['modelMode'] | undefined {
  if (groupModels) {
    return { kind: 'group', models: groupModels.split(',').map((s) => s.trim()).filter(Boolean) };
  }
  if (!modelModeStr) return undefined;
  if (modelModeStr === 'auto') return { kind: 'auto' };
  if (modelModeStr === 'max') return { kind: 'max' };
  if (modelModeStr === 'group') return { kind: 'group', models: [] };
  if (modelModeStr.startsWith('single:')) return { kind: 'single', model: modelModeStr.slice('single:'.length) };
  return undefined;
}

export async function main(argv: string[]): Promise<number> {
  try {
    if (argv.includes('--login')) {
      // Delegate to the ugly-app browser login flow (writes ~/.ugly-bot/auth.json).
      const { spawnCollect } = await import('../agent/tools/spawn');
      const r = await spawnCollect('ugly-app', ['login'], {});
      process.stdout.write(r.stdout);
      return r.code ?? 0;
    }

    const analyzeId = flag(argv, '--analyze');
    if (analyzeId) {
      const { analyzeRun, renderAnalysis } = await import('./analyzeRun');
      process.stdout.write(renderAnalysis(analyzeId, await analyzeRun(analyzeId)) + '\n');
      return 0;
    }

    if (argv.includes('--history')) {
      let raw = '';
      try { raw = await readFile(historyPath(), 'utf8'); } catch { /* none yet */ }
      const runs = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as RunHistoryEntry).reverse();
      if (runs.length === 0) { process.stdout.write('no eval runs recorded yet.\n'); return 0; }
      for (const r of runs.slice(0, 50)) {
        process.stdout.write(`${r.gradedAt ?? r.createdAt}  ${r.taskName}  [${r.config ?? 'default'}]  ${r.score ?? 0}/${r.scoreMax ?? 0}  $${(r.costUsd ?? 0).toFixed(4)}  ${r.turns ?? 0}t\n`);
      }
      return 0;
    }

    // A/B comparison: `--compare <spec.json>` (custom matrix) or
    // `--eval <task> --compare` (default flat-vs-SBV matrix for that task).
    if (argv.includes('--compare')) {
      const origin = flag(argv, '--origin') ?? process.env.UGLY_CODE_ORIGIN ?? '';
      if (!origin) { process.stderr.write('No origin. Pass --origin or set UGLY_CODE_ORIGIN.\n'); return 2; }
      const token = flag(argv, '--token');
      const auth = await resolveAuth({ origin, ...(token ? { token } : {}), testUser: argv.includes('--test-user') });
      const specFile = flag(argv, '--compare');
      const evalTask = flag(argv, '--eval');
      let spec: CompareSpec;
      if (specFile) {
        spec = JSON.parse(await readFile(specFile, 'utf8')) as CompareSpec;
      } else if (evalTask) {
        spec = { tasks: [evalTask], configs: [{ label: 'flat', pattern: 'none' }, { label: 'sbv', pattern: 'spec-build-verify' }] };
      } else {
        process.stderr.write('usage: ugly-code --compare <spec.json>  |  --eval <task> --compare\n');
        return 2;
      }
      const ranAt = Date.now();
      const result = await runComparison(spec, { origin: auth.origin, token: auth.token, ranAt });
      const dir = `${process.env.HOME ?? '.'}/.ugly-code/comparisons`;
      await mkdir(dir, { recursive: true });
      await writeFile(`${dir}/comparison-${ranAt}.json`, JSON.stringify(result, null, 2));
      process.stdout.write(`${renderScoreboard(result)}\n\nsaved: ${dir}/comparison-${ranAt}.json\n`);
      return 0;
    }

    const taskName = flag(argv, '--eval');
    if (taskName) {
      const origin = flag(argv, '--origin') ?? process.env.UGLY_CODE_ORIGIN ?? '';
      if (!origin) {
        process.stderr.write('No origin. Pass --origin <deployed-ugly-code-url> or set UGLY_CODE_ORIGIN.\n');
        return 2;
      }
      const token = flag(argv, '--token');
      const auth = await resolveAuth({
        origin,
        ...(token ? { token } : {}),
        testUser: argv.includes('--test-user'),
      });
      const model = flag(argv, '--model');
      const pattern = flag(argv, '--pattern');
      const toolset = flag(argv, '--toolset');
      const modelMode = parseModelMode(flag(argv, '--model-mode'), flag(argv, '--group-models'));
      const res = await runEval({
        taskName,
        origin: auth.origin,
        token: auth.token,
        ...(model ? { model } : {}),
        ...(pattern ? { pattern } : {}),
        ...(toolset ? { toolset } : {}),
        ...(modelMode ? { modelMode } : {}),
      });
      if (argv.includes('--json')) {
        // Structured output for e2e assertions: score, cost/turns, the pattern the
        // engine resolved to (routing accuracy), and the requested config.
        process.stdout.write(JSON.stringify({
          task: taskName,
          score: res.score,
          scoreMax: res.scoreMax,
          solved: res.score >= res.scoreMax,
          costUsd: res.costUsd,
          turns: res.turns,
          resolvedPattern: res.resolvedPattern,
          config: { model: model ?? null, pattern: pattern ?? null, modelMode: modelMode ?? null, toolset: toolset ?? null },
        }) + '\n');
      } else {
        process.stdout.write(`${taskName}: ${res.score}/${res.scoreMax}\n`);
      }
      return res.score >= res.scoreMax ? 0 : 1;
    }

    process.stderr.write(
      'usage: ugly-code --eval <task> [--model <id>] [--pattern <id>]\n' +
      '                 [--model-mode auto|max|group|single:<id>] [--group-models a,b,c]\n' +
      '                 [--toolset <name>] [--json] [--origin <url>] [--token <t>] [--test-user]\n' +
      '       ugly-code --compare <spec.json> | --eval <task> --compare\n' +
      '       ugly-code --analyze <id> | --history | --login\n',
    );
    return 2;
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
