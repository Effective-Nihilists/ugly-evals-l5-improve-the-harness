// Shared on-demand binary provisioning under ~/.ugly-bot/binaries/<platform>-<arch>/.
// Designed to be hoisted into ugly-app so ugly-studio + `ugly-app dev` can share it.
import { native } from 'ugly-app/native';
import { spawnCollect } from '../tools/spawn';

export interface BinariesIo {
  exists(p: string): Promise<boolean>;
  mkdirp(p: string): Promise<void>;
  readFile(p: string): Promise<string>;
  writeFile(p: string, s: string): Promise<void>;
  now(): number;
}

function home(): string {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  return env.HOME ?? env.USERPROFILE ?? '.';
}
function platformTag(): string {
  const p = (globalThis as { process?: { platform?: string; arch?: string } }).process ?? {};
  return `${p.platform ?? 'unknown'}-${p.arch ?? 'unknown'}`;
}

export function binariesRoot(): string {
  return `${home()}/.ugly-bot/binaries/${platformTag()}`;
}

// Default IO backed by native.fs (no host round-trip in a Node context).
const nativeIo: BinariesIo = {
  exists: (p) => native.fs.exists(p),
  mkdirp: (p) => native.fs.mkdir(p, true),
  readFile: (p) => native.fs.readFile(p),
  writeFile: (p, s) => native.fs.writeFile(p, s),
  now: () => Date.now(),
};

const inflight = new Map<string, Promise<string>>();

/**
 * Resolve a binary's install directory under the shared root, running `installer`
 * exactly once (serialized across concurrent callers) and recording the manifest
 * only when the binary is absent. Returns the install dir.
 */
export async function ensureBinary(
  name: string,
  installer: (destDir: string) => Promise<void>,
  io: BinariesIo = nativeIo,
): Promise<string> {
  const destDir = `${binariesRoot()}/${name}`;
  const existing = inflight.get(destDir);
  if (existing) return existing;
  const task = (async () => {
    if (await io.exists(destDir)) return destDir;
    await io.mkdirp(destDir);
    await installer(destDir);
    const manifestPath = `${binariesRoot()}/manifest.json`;
    let manifest: Record<string, { installedAt: number }> = {};
    try { manifest = JSON.parse(await io.readFile(manifestPath)) as Record<string, { installedAt: number }>; } catch { /* first write */ }
    manifest[name] = { installedAt: io.now() };
    await io.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    return destDir;
  })();
  inflight.set(destDir, task);
  try { return await task; } finally { inflight.delete(destDir); }
}

let uvIo: BinariesIo | undefined;
/** Test seam: override the IO used by ensureUv. */
export function __setUvIo(io: BinariesIo): void { uvIo = io; }

/** Resolve a `uv` executable — PATH first, else install into the shared binaries root. */
export async function ensureUv(io: BinariesIo = uvIo ?? nativeIo): Promise<string> {
  const probe = await spawnCollect('uv', ['--version'], {});
  if (probe.code === 0) return 'uv';
  const dir = await ensureBinary('uv', async (destDir) => {
    // Astral installer honors UV_INSTALL_DIR; INSTALLER_NO_MODIFY_PATH keeps it self-contained.
    const script = `curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR="${destDir}" INSTALLER_NO_MODIFY_PATH=1 sh`;
    const res = await spawnCollect('sh', ['-c', script], {});
    if (res.code !== 0 && res.code !== null) throw new Error(`uv install failed (exit ${res.code}): ${res.stderr.slice(0, 400)}`);
  }, io);
  return `${dir}/uv`;
}

let pythonIo: BinariesIo | undefined;
/** Test seam: override the IO used by ensurePython. */
export function __setPythonIo(io: BinariesIo): void { pythonIo = io; }

/** Resolve a python3 executable, installing a uv-managed runtime on first use. */
export async function ensurePython(io: BinariesIo = pythonIo ?? nativeIo): Promise<string> {
  const dir = await ensureBinary('python', async (destDir) => {
    const res = await spawnCollect('uv', ['python', 'install', '--install-dir', destDir], {});
    if (res.code !== 0 && res.code !== null) {
      throw new Error(`uv python install failed (exit ${res.code}): ${res.stderr.slice(0, 400)}`);
    }
  }, io);
  return `${dir}/bin/python3`;
}
