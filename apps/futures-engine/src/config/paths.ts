import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * The repository root: the nearest ancestor holding pnpm-workspace.yaml.
 * Found from this file, not the working directory, so launchd and `pnpm`
 * started from different places read the same .env and write the same files.
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

/** Relative paths mean "relative to the repo root". */
export function resolveFromRoot(path: string, root = REPO_ROOT): string {
  if (path === ':memory:' || isAbsolute(path)) return path;
  return resolve(root, path);
}
