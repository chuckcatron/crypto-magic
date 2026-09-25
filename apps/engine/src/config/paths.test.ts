import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.schema';
import { REPO_ROOT, findRepoRoot, resolveFromRoot } from './paths';

describe('repo-root path resolution', () => {
  it('finds the workspace root from a nested directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'cm-root-'));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages: ['apps/*']\n");
    const nested = join(root, 'apps', 'engine', 'dist', 'config');
    mkdirSync(nested, { recursive: true });

    expect(findRepoRoot(nested)).toBe(root);
  });

  it('resolves this checkout to the directory holding pnpm-workspace.yaml', () => {
    expect(findRepoRoot(__dirname)).toBe(REPO_ROOT);
    expect(REPO_ROOT.endsWith(join('apps', 'engine'))).toBe(false);
  });

  it('anchors relative paths at the root and leaves absolute and in-memory paths alone', () => {
    expect(resolveFromRoot('./data/x.db', '/repo')).toBe('/repo/data/x.db');
    expect(resolveFromRoot('data/KILL_SWITCH', '/repo')).toBe('/repo/data/KILL_SWITCH');
    expect(resolveFromRoot('/var/db/x.db', '/repo')).toBe('/var/db/x.db');
    expect(resolveFromRoot(':memory:', '/repo')).toBe(':memory:');
  });

  it('gives the same database and kill switch whatever directory the engine starts in', () => {
    // The bug: `pnpm engine` runs in apps/engine, launchd in the repo root, and
    // the two used to open different databases.
    const config = loadConfig({ LOG_LEVEL: 'fatal' } as NodeJS.ProcessEnv);
    expect(config.DATABASE_PATH).toBe(join(REPO_ROOT, 'data', 'crypto-magic.db'));
    expect(config.KILL_SWITCH_FILE).toBe(join(REPO_ROOT, 'data', 'KILL_SWITCH'));
  });
});
