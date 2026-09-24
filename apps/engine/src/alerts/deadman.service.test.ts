import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SchedulerRegistry } from '@nestjs/schedule';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config/config.schema';
import type { TradingEngineService } from '../trading/engine.service';
import { DeadmanService } from './deadman.service';

/** The secret-looking part of a real ping URL. It must never leak. */
const TOKEN = 'b1946ac9-2bd8-4a8f-9d6e-5f0c1a7e3d42';

describe('DeadmanService', () => {
  let server: Server;
  let baseUrl: string;
  let hits: string[];
  let statusCode: number;
  const engine = { lastSuccessfulTickAt: null as number | null };

  beforeEach(async () => {
    hits = [];
    statusCode = 200;
    engine.lastSuccessfulTickAt = null;
    server = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      res.statusCode = statusCode;
      res.end('OK');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function make(url: string | undefined, scheduler = new SchedulerRegistry()) {
    const config = loadConfig({
      LOG_LEVEL: 'fatal',
      STOP_MONITOR_INTERVAL_SECONDS: '30',
      ...(url ? { DEADMAN_PING_URL: url } : {}),
    } as NodeJS.ProcessEnv);
    return new DeadmanService(config, engine as unknown as TradingEngineService, scheduler);
  }

  it('pings when the trading loop completed a pass recently', async () => {
    const now = Date.now();
    engine.lastSuccessfulTickAt = now - 10_000;
    const deadman = make(`${baseUrl}/ping/${TOKEN}`);

    expect(await deadman.pingOnce(now)).toBe('sent');
    expect(hits).toEqual([`GET /ping/${TOKEN}`]);
    expect(deadman.status).toMatchObject({ enabled: true, lastPingAt: now, lastResult: 'sent' });
  });

  it('stays silent before the first pass completes', async () => {
    const deadman = make(`${baseUrl}/ping/${TOKEN}`);

    expect(await deadman.pingOnce()).toBe('skipped');
    expect(hits).toHaveLength(0);
  });

  it('stays silent when the loop is wedged, and resumes when it recovers', async () => {
    const now = Date.now();
    const deadman = make(`${baseUrl}/ping/${TOKEN}`);
    // Three missed 30s passes: 90s, floored at 120s.
    expect(deadman.maxTickAgeMs).toBe(120_000);

    engine.lastSuccessfulTickAt = now - 121_000;
    expect(await deadman.pingOnce(now)).toBe('skipped');
    expect(hits).toHaveLength(0);

    engine.lastSuccessfulTickAt = now - 1_000;
    expect(await deadman.pingOnce(now)).toBe('sent');
    expect(hits).toHaveLength(1);
  });

  it('reports an HTTP error without leaking the URL', async () => {
    statusCode = 500;
    engine.lastSuccessfulTickAt = Date.now();
    const deadman = make(`${baseUrl}/ping/${TOKEN}`);

    expect(await deadman.pingOnce()).toBe('failed');
    expect(deadman.status.lastError).toBe('HTTP 500');
    expect(deadman.status.lastPingAt).toBeNull();
  });

  it('survives an unreachable monitor and never leaks the URL', async () => {
    engine.lastSuccessfulTickAt = Date.now();
    // Nothing listens on this port once the server is closed.
    const url = `${baseUrl}/ping/${TOKEN}`;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer();
    const deadman = make(url);

    expect(await deadman.pingOnce()).toBe('failed');
    const serialized = JSON.stringify(deadman.status);
    expect(serialized).not.toContain(TOKEN);
    expect(deadman.status.lastError).toBeTruthy();
  });

  it('does nothing when no URL is configured', async () => {
    engine.lastSuccessfulTickAt = Date.now();
    const scheduler = new SchedulerRegistry();
    const deadman = make(undefined, scheduler);
    deadman.onApplicationBootstrap();

    expect(await deadman.pingOnce()).toBe('skipped');
    expect(deadman.status.enabled).toBe(false);
    expect(scheduler.getIntervals()).toHaveLength(0);
  });

  it('registers its interval on start and removes it on shutdown', () => {
    const scheduler = new SchedulerRegistry();
    const deadman = make(`${baseUrl}/ping/${TOKEN}`, scheduler);

    deadman.onApplicationBootstrap();
    expect(scheduler.getIntervals()).toEqual(['deadman-ping']);

    deadman.onModuleDestroy();
    expect(scheduler.getIntervals()).toHaveLength(0);
  });
});
