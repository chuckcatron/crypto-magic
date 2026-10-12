import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from './paths';

/**
 * Load the repo-root .env, the same file the regime engine reads, before
 * anything reads process.env. Import first in the entrypoint. This app reads
 * only FUTURES_* settings and the shared alert channels; it never reads or
 * needs a Coinbase key.
 */
const envPath = resolve(REPO_ROOT, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);
