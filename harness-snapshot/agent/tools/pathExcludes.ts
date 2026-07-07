// Directory names never useful to a coding agent. Excluded unconditionally by
// glob/grep — even under include_ignored (`--no-ignore`), which would otherwise
// resurface .git/objects, node_modules, and build output. A `glob("*")` dumping
// the entire .git tree into the model context (a ~2M-token request) is exactly
// what this prevents.
export const HARD_EXCLUDES: string[] = ['.git', 'node_modules', 'dist', 'build', '.venv'];
