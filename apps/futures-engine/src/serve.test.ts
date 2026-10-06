import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from './app.module';
import { FUTURES_CONFIG, loadConfig } from './config/config';
import { CANDLE_SOURCE, type CandleSource } from './market/candle-source';
import { ALERTER, type Alerter } from './paper/alerts';
import { PaperStore } from './paper/store';
import { serveThenTrade } from './serve';

/** A port nothing listens on: bind port 0, read what the OS gave, release it. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('serveThenTrade', () => {
  let dir: string;
  let apps: INestApplication[];
  let alerts: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'futures-serve-'));
    apps = [];
    alerts = [];
  });

  afterEach(async () => {
    for (const app of apps) await app.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  /** The real app module on one shared database, with no network and a recording alerter. */
  async function engine(port: number): Promise<INestApplication> {
    const candles: CandleSource = { fetch: () => Promise.resolve([]) };
    const alerter: Alerter = { alert: (_severity, kind) => alerts.push(kind) };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(FUTURES_CONFIG)
      .useValue(
        loadConfig({
          FUTURES_PORT: String(port),
          FUTURES_DB_PATH: join(dir, 'futures-paper.db'),
          FUTURES_KILL_SWITCH_PATH: join(dir, 'FUTURES_KILL_SWITCH'),
        }),
      )
      .overrideProvider(CANDLE_SOURCE)
      .useValue(candles)
      .overrideProvider(ALERTER)
      .useValue(alerter)
      .compile();
    const app = moduleRef.createNestApplication({ logger: false });
    apps.push(app);
    return app;
  }

  async function status(port: number): Promise<{ mode: string }> {
    const response = await fetch(`http://127.0.0.1:${port}/api/status`);
    return (await response.json()) as { mode: string };
  }

  it('serves the API and trades', async () => {
    const port = await freePort();
    const app = await engine(port);
    await serveThenTrade(app);

    expect(await status(port)).toMatchObject({ mode: 'paper' });
    expect(
      app
        .get(PaperStore)
        .recentEvents(10)
        .map((e) => e.kind),
    ).toContain('engine_started');
    const equity = (await (await fetch(`http://127.0.0.1:${port}/api/equity`)).json()) as {
      paperEquity: number;
      strategies: { strategy: string; accounts: number }[];
    };
    expect(equity.paperEquity).toBe(10_000);
    expect(equity.strategies.map((s) => [s.strategy, s.accounts])).toEqual([
      ['F1', 3],
      ['F2', 3],
      ['F3', 3],
      ['F4', 1],
    ]);
  });

  it('serves the dashboard under a strict content policy, and nothing else', async () => {
    const port = await freePort();
    await serveThenTrade(await engine(port));
    const base = `http://127.0.0.1:${port}`;

    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    const policy = page.headers.get('content-security-policy') ?? '';
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).not.toContain('unsafe-inline');
    const html = await page.text();
    expect(html).toContain('<script src="dashboard.js" defer></script>');
    // Nothing inline for the policy to block.
    expect(html).not.toMatch(/<script>|<style|\sstyle=|\son[a-z]+=/i);

    for (const [file, type] of [
      ['dashboard.js', 'text/javascript'],
      ['dashboard.css', 'text/css'],
    ] as const) {
      const response = await fetch(`${base}/${file}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain(type);
    }
    expect((await fetch(`${base}/package.json`)).status).toBe(404);
    expect((await fetch(`${base}/../package.json`)).status).toBe(404);
    // The same guard as the API: reads only.
    expect((await fetch(`${base}/`, { method: 'POST' })).status).toBe(405);
  });

  it('stops a second engine on the same port before it touches the database or alerts', async () => {
    const port = await freePort();
    const first = await engine(port);
    await serveThenTrade(first);

    const second = await engine(port);
    await expect(serveThenTrade(second)).rejects.toMatchObject({ code: 'EADDRINUSE' });

    const starts = first
      .get(PaperStore)
      .recentEvents(50)
      .filter((e) => e.kind === 'engine_started');
    expect(starts).toHaveLength(1);
    expect(alerts.filter((kind) => kind === 'engine_started')).toHaveLength(1);
    // The first engine still holds the port and answers.
    expect(await status(port)).toMatchObject({ mode: 'paper' });
  });
});
