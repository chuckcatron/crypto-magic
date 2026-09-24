import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { scrub } from '@crypto-magic/notify';
import { APP_CONFIG } from '../config/tokens';
import type { AppConfig } from '../config/config.schema';
import { TradingEngineService } from '../trading/engine.service';
import { childLogger } from '../common/logger';

const DEADMAN_INTERVAL = 'deadman-ping';
const PING_TIMEOUT_MS = 10_000;

export type PingResult = 'sent' | 'skipped' | 'failed';

/**
 * Dead-man's switch.
 *
 * Every other alert is sent BY the engine, so none of them can fire when the
 * engine is dead, the Mac is off, or the house has lost internet. This one works
 * the other way round: the engine pings an outside monitor while it is healthy,
 * and the monitor alerts you when the pings stop.
 *
 * "Healthy" means the trading loop has completed a pass recently, not merely
 * that the process is up. A wedged loop in a live process is exactly the
 * failure a plain uptime check misses.
 *
 * A failed ping is logged and otherwise ignored: it can never affect trading.
 */
@Injectable()
export class DeadmanService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = childLogger('deadman');
  private started = false;
  private inFlight = false;
  private unhealthy = false;
  private lastPingAt: number | null = null;
  private lastResult: PingResult | null = null;
  private lastError: string | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly engine: TradingEngineService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.DEADMAN_PING_URL) {
      this.log.info('dead-man switch disabled — set DEADMAN_PING_URL to be told when the bot goes silent');
      return;
    }
    const interval = setInterval(
      () => void this.pingOnce(),
      this.config.DEADMAN_INTERVAL_SECONDS * 1000,
    );
    this.scheduler.addInterval(DEADMAN_INTERVAL, interval);
    this.started = true;
    this.log.info({ everySeconds: this.config.DEADMAN_INTERVAL_SECONDS }, 'dead-man switch enabled');
  }

  onModuleDestroy(): void {
    if (this.started && this.scheduler.doesExist('interval', DEADMAN_INTERVAL)) {
      this.scheduler.deleteInterval(DEADMAN_INTERVAL);
    }
  }

  get status() {
    return {
      enabled: Boolean(this.config.DEADMAN_PING_URL),
      lastPingAt: this.lastPingAt,
      lastResult: this.lastResult,
      lastError: this.lastError,
    };
  }

  /**
   * Oldest a completed pass may be and still count as healthy. Three missed
   * passes, floored at two minutes so one slow exchange call is not an outage.
   */
  get maxTickAgeMs(): number {
    return Math.max(this.config.STOP_MONITOR_INTERVAL_SECONDS * 3, 120) * 1000;
  }

  async pingOnce(now = Date.now()): Promise<PingResult> {
    const url = this.config.DEADMAN_PING_URL;
    if (!url || this.inFlight) return 'skipped';

    const lastTick = this.engine.lastSuccessfulTickAt;
    if (lastTick === null || now - lastTick > this.maxTickAgeMs) {
      // Staying silent IS the alarm. Log the transition once, not every minute.
      if (!this.unhealthy) {
        this.log.warn(
          { lastTickCompletedAt: lastTick, maxAgeSeconds: this.maxTickAgeMs / 1000 },
          'trading loop is not completing passes; withholding dead-man ping',
        );
      }
      this.unhealthy = true;
      this.lastResult = 'skipped';
      return 'skipped';
    }
    if (this.unhealthy) {
      this.log.info('trading loop healthy again; resuming dead-man pings');
      this.unhealthy = false;
    }

    this.inFlight = true;
    try {
      const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.lastPingAt = now;
      this.lastResult = 'sent';
      this.lastError = null;
      return 'sent';
    } catch (error) {
      // The URL is the credential: never let it reach a log line or the API.
      const secrets = [url, safePath(url)];
      this.lastError = scrub(describe(error), secrets);
      this.lastResult = 'failed';
      this.log.warn({ err: this.lastError }, 'dead-man ping failed');
      return 'failed';
    } finally {
      this.inFlight = false;
    }
  }
}

function safePath(url: string): string {
  try {
    const { pathname } = new URL(url);
    return pathname.length > 1 ? pathname : '';
  } catch {
    return '';
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    return cause instanceof Error ? `${error.message}: ${cause.message}` : error.message;
  }
  return String(error);
}
