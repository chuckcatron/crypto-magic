import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiscordChannel } from './discord';
import { NtfyChannel } from './ntfy';
import { TelegramChannel } from './telegram';
import { FanoutNotifier } from '../fanout';
import type { Alert, NotificationChannel } from '../types';

interface Captured {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

/**
 * A real HTTP server rather than a mocked fetch: this asserts the bytes each
 * provider would actually receive, which is where these integrations go wrong.
 */
let server: Server;
let captured: Captured[] = [];
let status = 200;
let delayMs = 0;
let base = '';

beforeEach(async () => {
  captured = [];
  status = 200;
  delayMs = 0;
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      captured.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      setTimeout(() => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end('{}');
      }, delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const alert = (overrides: Partial<Alert> = {}): Alert => ({
  severity: 'critical',
  title: 'Kill switch engaged',
  body: 'reconciliation failed at startup',
  timestamp: Date.parse('2026-09-22T12:00:00Z'),
  fingerprint: 'kill_switch:engaged',
  ...overrides,
});

describe('DiscordChannel', () => {
  it('posts an embed with a DECIMAL colour, which is the only form Discord accepts', async () => {
    await new DiscordChannel(`${base}/webhook`).send(alert());

    const payload = JSON.parse(captured[0]!.body) as { embeds: { color: number; title: string }[] };
    expect(captured[0]!.method).toBe('POST');
    expect(typeof payload.embeds[0]!.color).toBe('number');
    expect(payload.embeds[0]!.color).toBe(0xd03b3b);
    expect(payload.embeds[0]!.title).toContain('Kill switch engaged');
  });

  it('notes how many were suppressed', async () => {
    await new DiscordChannel(`${base}/webhook`).send(alert({ suppressedSince: 7 }));
    expect(captured[0]!.body).toContain('7 identical alerts suppressed');
  });

  it('throws on a non-2xx so the failure can be recorded', async () => {
    status = 404;
    await expect(new DiscordChannel(`${base}/gone`).send(alert())).rejects.toThrow(/discord.*404/i);
  });
});

describe('TelegramChannel', () => {
  it('posts sendMessage on the bot path with the chat id', async () => {
    await new TelegramChannel('TOKEN123', 'CHAT456', 10_000, base).send(alert());

    const request = captured[0]!;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/botTOKEN123/sendMessage');
    const payload = JSON.parse(request.body) as { chat_id: string; text: string; parse_mode: string };
    expect(payload.chat_id).toBe('CHAT456');
    expect(payload.parse_mode).toBe('HTML');
    expect(payload.text).toContain('Kill switch engaged');
  });

  it('escapes HTML, because one stray angle bracket makes Telegram reject the whole message', async () => {
    await new TelegramChannel('t', 'c', 10_000, base).send(
      alert({ body: '<b>not markup</b> & an ampersand' }),
    );
    const payload = JSON.parse(captured[0]!.body) as { text: string };
    expect(payload.text).toContain('&lt;b&gt;not markup&lt;/b&gt; &amp; an ampersand');
    expect(payload.text).not.toContain('<b>not markup');
  });

  it('silences the notification for info but not for critical', async () => {
    const channel = new TelegramChannel('t', 'c', 10_000, base);
    await channel.send(alert({ severity: 'info' }));
    await channel.send(alert({ severity: 'critical' }));

    expect((JSON.parse(captured[0]!.body) as { disable_notification: boolean }).disable_notification).toBe(true);
    expect((JSON.parse(captured[1]!.body) as { disable_notification: boolean }).disable_notification).toBe(false);
  });
});

describe('NtfyChannel', () => {
  it('sets Title, Priority and Tags headers and puts the message in the body', async () => {
    await new NtfyChannel('my-topic', base).send(alert());

    const request = captured[0]!;
    expect(request.url).toBe('/my-topic');
    expect(request.headers.title).toBe('Kill switch engaged');
    expect(request.headers.priority).toBe('5'); // max — bypasses quiet hours
    expect(request.headers.tags).toBe('rotating_light');
    expect(request.body).toContain('reconciliation failed');
  });

  it('uses a lower priority for info', async () => {
    await new NtfyChannel('t', base).send(alert({ severity: 'info' }));
    expect(captured[0]!.headers.priority).toBe('3');
  });

  it('tolerates a trailing slash on the server URL', async () => {
    await new NtfyChannel('t', `${base}/`).send(alert());
    expect(captured[0]!.url).toBe('/t');
  });

  it('times out rather than hanging the caller forever', async () => {
    delayMs = 500;
    await expect(new NtfyChannel('t', base, 50).send(alert())).rejects.toThrow(/timed out/);
  });
});

describe('FanoutNotifier', () => {
  const ok = (name: string): NotificationChannel => ({ name, send: async () => {} });
  const bad = (name: string): NotificationChannel => ({
    name,
    send: async () => {
      throw new Error('boom');
    },
  });

  it('reports success per channel', async () => {
    const results = await new FanoutNotifier([ok('a'), ok('b')]).send(alert());
    expect(results).toEqual([
      { channel: 'a', ok: true },
      { channel: 'b', ok: true },
    ]);
  });

  it('one channel failing never stops another delivering', async () => {
    // The entire reason to configure two channels is that one may be down.
    const results = await new FanoutNotifier([bad('down'), ok('up')]).send(alert());
    expect(results[0]).toMatchObject({ channel: 'down', ok: false, error: 'boom' });
    expect(results[1]).toMatchObject({ channel: 'up', ok: true });
  });

  it('never throws, whatever the channels do', async () => {
    await expect(new FanoutNotifier([bad('a'), bad('b')]).send(alert())).resolves.toHaveLength(2);
  });

  it('knows when nothing is configured', () => {
    expect(new FanoutNotifier([]).isConfigured).toBe(false);
    expect(new FanoutNotifier([ok('a')]).channelNames).toEqual(['a']);
  });
});
