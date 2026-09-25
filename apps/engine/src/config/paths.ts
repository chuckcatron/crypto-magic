import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * The repository root: the nearest ancestor holding pnpm-workspace.yaml.
 *
 * Found from this file's location, not from the current directory, because the
 * engine is started from different places: launchd starts it in the repo root,
 * `pnpm engine` starts it in apps/engine. Resolving against the working
 * directory made those two read different .env files and write different
 * databases — the second silently ignoring every setting you had made.
 */
export function findRepoRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

export const REPO_ROOT = findRepoRoot(__dirname);

/** Relative paths in .env mean "relative to the repo root", wherever the engine was started. */
export function resolveFromRoot(path: string, root = REPO_ROOT): string {
  if (path === ':memory:' || isAbsolute(path)) return path;
  return resolve(root, path);
}
