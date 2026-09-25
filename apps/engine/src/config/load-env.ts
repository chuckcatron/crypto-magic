import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from './paths';

/**
 * Load `.env` before anything reads `process.env`.
 *
 * Uses Node's built-in loader rather than a dependency. Import this module for
 * its side effect as the FIRST import of any entrypoint — config validation
 * runs at module scope, so a later import would be too late.
 */
// Always the repo-root .env, however the engine was started (see paths.ts).
const envPath = resolve(REPO_ROOT, '.env');
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

// A PEM in a .env file is almost always written with literal backslash-n,
// because a real newline would end the value. The crypto library needs actual
// newlines, and the failure mode without this is an opaque "invalid key" from
// deep inside the JWT signer.
const pem = process.env.COINBASE_API_PRIVATE_KEY;
if (pem?.includes('\\n')) {
  process.env.COINBASE_API_PRIVATE_KEY = pem.replace(/\\n/g, '\n');
}
