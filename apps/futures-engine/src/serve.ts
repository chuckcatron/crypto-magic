import type { INestApplication } from '@nestjs/common';
import { localOnly } from './api/local-only';
import { childLogger } from './common/logger';
import { FUTURES_CONFIG, type FuturesConfig } from './config/config';
import { PaperTraderService } from './paper/paper-trader.service';

/**
 * Serve the API, then start trading.
 *
 * Listening first makes the port the single-instance lock. Two engines on one
 * database would both trade every bar, so a second copy (a launchd restart
 * while one started by hand still runs, say) fails at listen(), before it
 * writes anything or sends an alert.
 *
 * On any failure the app is closed. That stops the loop and frees the port and
 * the database, so the process exits instead of lingering, and a supervisor
 * can start a clean copy.
 */
export async function serveThenTrade(app: INestApplication): Promise<void> {
  const config = app.get<FuturesConfig>(FUTURES_CONFIG);
  // No CORS and loopback only, like the regime engine; see api/local-only.ts.
  app.use(localOnly);
  try {
    await app.listen(config.FUTURES_PORT, '127.0.0.1');
    childLogger('bootstrap').info(
      { port: config.FUTURES_PORT, db: config.FUTURES_DB_PATH },
      `futures PAPER engine on http://127.0.0.1:${config.FUTURES_PORT}/api/status`,
    );
    await app.get(PaperTraderService).run();
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
}
