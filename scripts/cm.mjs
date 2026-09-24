#!/usr/bin/env node
//
// cm — operate crypto-magic from a terminal, sized for a phone over SSH.
//
//   cm                 status at a glance (same as `cm status`)
//   cm kill [reason]   engage the kill switch: no new entries, exits still run
//   cm release         release the kill switch
//   cm flatten         engage the kill switch, then sell every position at market
//   cm events [n]      last n engine events (default 15)
//   cm logs [n]        last n log lines, condensed (default 30)
//   cm restart         restart the launchd service (macOS)
//
// Talks only to the engine on 127.0.0.1, exactly like the dashboard does, so it
// needs no extra port, no extra credential, and it opens nothing to the network.
// Reaching it remotely is SSH's job (see docs/REMOTE-ACCESS.md).
//
// No dependencies on purpose: this must still run when the build is broken.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = resolve(ROOT, '.env');
// The engine runs from the repo root under launchd and reads the same file.
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const PORT = Number(process.env.PORT ?? 4000);
const API = `http://127.0.0.1:${PORT}/api`;
const KILL_SWITCH_FILE = resolve(ROOT, process.env.KILL_SWITCH_FILE ?? './data/KILL_SWITCH');
const LOG_FILE = resolve(ROOT, 'logs/engine.log');
const LAUNCHD_LABEL = 'com.cryptomagic.engine';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : String(text));
const red = paint('31');
const green = paint('32');
const yellow = paint('33');
const dim = paint('2');
const bold = paint('1');

class EngineUnreachable extends Error {}

async function api(method, path, { body, timeoutMs = 15_000 } = {}) {
  const mutating = method !== 'GET';
  let response;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      headers: mutating
        ? { 'content-type': 'application/json', 'x-crypto-magic-request': '1' }
        : {},
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new EngineUnreachable(error?.cause?.code ?? error?.name ?? String(error));
  }
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!response.ok) {
    throw new Error(`engine answered HTTP ${response.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  }
  return data;
}

// --- formatting ---------------------------------------------------------------

const usd = (value) =>
  Number(value).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

function ago(ms) {
  if (ms === null || ms === undefined) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 36 * 3600) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

function clock(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const width = () => Math.max(40, process.stdout.columns ?? 80);
const fit = (text) => (text.length > width() ? `${text.slice(0, width() - 1)}…` : text);
const row = (label, value) => console.log(`${dim(label.padEnd(12))} ${value}`);

// --- commands -----------------------------------------------------------------

async function status() {
  const [s, p] = await Promise.all([api('GET', '/status'), api('GET', '/portfolio')]);

  const mode = s.live ? red(bold('LIVE')) : green('PAPER');
  console.log(`${bold('crypto-magic')} · ${mode} · ${s.products.join(', ')} · ${s.granularity} · ${s.strategy}`);

  row('Kill switch', s.killSwitchEngaged ? red(bold('ENGAGED — no new entries')) : green('off'));
  row('Halted', s.haltReasons?.length ? yellow(s.haltReasons.join('; ')) : green('no'));

  const loopAge = s.lastTickCompletedAt ? Date.now() - s.lastTickCompletedAt : null;
  const loopText = `last pass ${ago(s.lastTickCompletedAt)}`;
  row('Loop', loopAge !== null && loopAge < 180_000 ? green(loopText) : red(loopText));
  row('Market data', s.marketDataAgeSeconds === null ? yellow('none yet') : `newest bar ${ago(Date.now() - s.marketDataAgeSeconds * 1000)}`);

  const d = s.deadman;
  if (!d?.enabled) row('Dead-man', yellow('off (set DEADMAN_PING_URL)'));
  else if (d.lastResult === 'failed') row('Dead-man', red(`ping failing: ${d.lastError}`));
  else if (d.lastResult === 'skipped') row('Dead-man', red('withholding pings — loop unhealthy'));
  else if (d.lastResult === null) row('Dead-man', yellow('waiting for first ping'));
  else row('Dead-man', green(`pinged ${ago(d.lastPingAt)}`));

  row('Equity', `${bold(usd(p.equity))} ${dim(`cash ${usd(p.cash)}`)}`);

  if (!p.positions.length) {
    row('Positions', 'none');
    return;
  }
  const cost = p.positions.reduce((sum, x) => sum + Number(x.baseSize) * Number(x.averageEntryPrice), 0);
  const unrealized = Number(p.positionValue) - cost;
  row('Positions', `${p.positions.length} · unrealized ${unrealized >= 0 ? green(`+${usd(unrealized)}`) : red(usd(unrealized))}`);
  for (const x of p.positions) {
    console.log(
      fit(`  ${x.productId} ${Number(x.baseSize)} @ ${usd(x.averageEntryPrice)} · stop ${usd(x.stopPrice)} · ${ago(x.openedAt)}`),
    );
  }
}

async function kill(reasonWords) {
  const reason = reasonWords.join(' ').trim() || 'engaged remotely with cm';
  try {
    await api('POST', '/kill-switch/engage', { body: { reason } });
    console.log(red(bold('Kill switch ENGAGED.')) + ' No new entries. Stops and exits still run.');
  } catch (error) {
    if (!(error instanceof EngineUnreachable)) throw error;
    // The switch is a file precisely so it works when the API does not. The
    // engine checks for it on every decision, and again at startup.
    mkdirSync(dirname(KILL_SWITCH_FILE), { recursive: true });
    writeFileSync(KILL_SWITCH_FILE, `${new Date().toISOString()}\n${reason}\n`, 'utf8');
    console.log(red(bold('Kill switch ENGAGED (engine not responding — wrote the file directly).')));
    console.log(dim(KILL_SWITCH_FILE));
  }
}

async function release(flags) {
  try {
    await api('POST', '/kill-switch/release');
    console.log(green('Kill switch released.') + ' New entries are allowed again.');
  } catch (error) {
    if (!(error instanceof EngineUnreachable)) throw error;
    if (!flags.includes('--offline')) {
      console.log(red('Engine not responding; nothing released.'));
      console.log('Start it first (cm restart), or run `cm release --offline` to delete the file anyway.');
      process.exitCode = 1;
      return;
    }
    if (!flags.includes('--yes') && !(await confirm('Delete the kill switch file while the engine is down? Type RELEASE', 'RELEASE'))) return;
    rmSync(KILL_SWITCH_FILE, { force: true });
    console.log(green('Kill switch file removed.') + ' Entries are allowed when the engine starts.');
  }
}

async function flatten(flags) {
  const s = await api('GET', '/status');
  const p = await api('GET', '/portfolio');
  if (!p.positions.length) {
    console.log('No open positions. Nothing to sell.');
    return;
  }
  const what = `${p.positions.length} position(s) worth ~${usd(p.positionValue)} in ${s.live ? 'LIVE' : 'paper'} mode`;
  if (!flags.includes('--yes') && !(await confirm(`Sell ${what} at market? Type FLATTEN`, 'FLATTEN'))) return;

  // Engage first, or the next bar could buy straight back in.
  await api('POST', '/kill-switch/engage', { body: { reason: 'flatten requested remotely with cm' } });
  const result = await api('POST', '/flatten', { timeoutMs: 120_000 });
  console.log(`${red(bold('Kill switch ENGAGED'))} and ${result.closed} position(s) closed.`);
  console.log(dim('Run `cm` to confirm, and `cm release` when you want it trading again.'));
}

async function events([n]) {
  const limit = clampCount(n, 15);
  const list = await api('GET', `/events?limit=${limit}`);
  const colorFor = { error: red, warn: yellow };
  for (const e of [...list].reverse()) {
    const line = fit(`${clock(e.ts)} ${e.level.padEnd(5)} ${e.kind}: ${e.message}`);
    console.log((colorFor[e.level] ?? String)(line));
  }
}

function logs([n]) {
  const limit = clampCount(n, 30);
  if (!existsSync(LOG_FILE)) {
    console.log(`No log file at ${LOG_FILE}. Is the engine installed with scripts/install-launchd.sh?`);
    return;
  }
  // Read only the tail: the file grows forever.
  const text = readTail(LOG_FILE, 256 * 1024);
  const levels = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };
  for (const raw of text.split('\n').filter(Boolean).slice(-limit)) {
    try {
      const entry = JSON.parse(raw);
      const level = levels[entry.level] ?? entry.level;
      const line = fit(`${clock(Date.parse(entry.time))} ${String(level).padEnd(5)} ${entry.context ?? ''} ${entry.msg ?? ''}`);
      console.log(entry.level >= 50 ? red(line) : entry.level >= 40 ? yellow(line) : line);
    } catch {
      console.log(fit(raw));
    }
  }
}

async function restart() {
  if (process.platform !== 'darwin') {
    console.log('restart uses launchd and only works on the Mac itself.');
    process.exitCode = 1;
    return;
  }
  const target = `gui/${process.getuid()}/${LAUNCHD_LABEL}`;
  execFileSync('launchctl', ['kickstart', '-k', target], { stdio: 'inherit' });
  process.stdout.write('Restarting');
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      await api('GET', '/status', { timeoutMs: 2000 });
      console.log(` ${green('up')}.`);
      return;
    } catch {
      process.stdout.write('.');
    }
  }
  console.log(` ${red('not answering after 30s')}. Check \`cm logs\`.`);
  process.exitCode = 1;
}

function help() {
  console.log(`cm — operate crypto-magic

  cm                 status at a glance
  cm kill [reason]   engage the kill switch (blocks entries, never exits)
  cm release         release the kill switch
  cm flatten         kill switch + sell everything at market (asks first)
  cm events [n]      recent engine events
  cm logs [n]        recent log lines
  cm restart         restart the engine service`);
}

// --- helpers ------------------------------------------------------------------

function clampCount(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 200) : fallback;
}

function readTail(path, bytes) {
  const buffer = readFileSync(path);
  const start = Math.max(0, buffer.length - bytes);
  const text = buffer.subarray(start).toString('utf8');
  // Drop the partial first line when we started mid-file.
  return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
}

async function confirm(question, expected) {
  if (!process.stdin.isTTY) {
    console.log(`Refusing without a terminal to confirm in. Pass --yes to skip.`);
    process.exitCode = 1;
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question}: `)).trim();
  rl.close();
  if (answer !== expected) {
    console.log('Cancelled.');
    return false;
  }
  return true;
}

// --- main ---------------------------------------------------------------------

const [command = 'status', ...rest] = process.argv.slice(2);
const flags = rest.filter((a) => a.startsWith('--'));
const args = rest.filter((a) => !a.startsWith('--'));

const commands = {
  status: () => status(),
  kill: () => kill(args),
  release: () => release(flags),
  flatten: () => flatten(flags),
  events: () => events(args),
  logs: () => logs(args),
  restart: () => restart(),
  help: () => help(),
  '--help': () => help(),
  '-h': () => help(),
};

const run = commands[command];
if (!run) {
  console.log(`Unknown command: ${command}\n`);
  help();
  process.exit(1);
}

try {
  await run();
} catch (error) {
  if (error instanceof EngineUnreachable) {
    console.log(red(`Engine not responding on 127.0.0.1:${PORT} (${error.message}).`));
    console.log('Try `cm restart`, or `cm kill` which works even when the engine is down.');
  } else {
    console.log(red(error.message ?? String(error)));
  }
  process.exitCode = 1;
}
