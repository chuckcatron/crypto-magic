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
