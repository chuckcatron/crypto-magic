/**
 * Engine API client.
 *
 * Every monetary value crosses the wire as a STRING, because the engine holds
 * them as arbitrary-precision decimals. Parse to a number only at the point of
 * display, never to compute a size or a P&L.
 */
// Same-origin. Next rewrites /engine-api/* to the engine (see next.config.ts).
const BASE = '/engine-api';

export interface EngineStatus {
  mode: 'paper' | 'live';
  live: boolean;
  exchange: string;
  strategy: string;
  products: string[];
  granularity: string;
  killSwitchEngaged: boolean;
  marketDataAgeSeconds: number | null;
  warmupBars: number;
  haltReasons: string[];
  limits: {
    maxTotalNotional: number;
    maxPositionNotional: number;
    maxOpenPositions: number;
    riskPerTradePct: number;
    maxDailyLoss: number;
  };
  serverTime: number;
}

export interface Portfolio {
  cash: string;
  positionValue: string;
  equity: string;
  mode: 'paper' | 'live';
}

export interface PositionRow {
  productId: string;
  baseSize: string;
  averageEntryPrice: string;
  stopPrice: string;
  takeProfitPrice: string | null;
  highWaterPrice: string;
  openedAt: number;
  barsHeld: number;
  confidence: number;
  entryReasons: string[];
}

export interface TradeRow {
  id: number;
  productId: string;
  entryTime: number;
  exitTime: number;
  entryPrice: string;
  exitPrice: string;
  baseSize: string;
  fees: string;
  pnl: string;
  pnlPct: number;
  exitReason: string;
  confidence: number;
  stopPrice: string | null;
  takeProfitPrice: string | null;
  /** Written by the local model after the fact; null until it has run. */
  analysis: TradeAnalysis | null;
}

export type Verdict =
  | 'sound_process_won'
  | 'sound_process_lost'
  | 'flawed_process_won'
  | 'flawed_process_lost';

export interface TradeAnalysis {
  tradeId: number;
  createdAt: number;
  model: string;
  verdict: Verdict;
  summary: string;
  whatWorked: string[];
  whatDidnt: string[];
  lesson: string | null;
  usedNews: boolean;
  newsCount: number;
  durationMs: number;
}

export interface InsightStatus {
  enabled: boolean;
  model: string | null;
  newsProvider: string | null;
  pending: number;
  analysed: number;
  lastError: string | null;
}

export interface EventRow {
  id: number;
  ts: number;
  level: 'info' | 'warn' | 'error';
  kind: string;
  message: string;
}

export interface EquityPoint {
  ts: number;
  equity: string;
  cash: string;
  positionValue: string;
}

export interface Metrics {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  realizedPnl: string;
  totalFees: string;
  profitFactor: number | null;
  averageWin: string;
  averageLoss: string;
  byExitReason: Record<string, number>;
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${BASE}${path}`, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return (await response.json()) as T;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return (await response.json()) as T;
}

export interface DashboardData {
  status: EngineStatus;
  portfolio: Portfolio;
  positions: PositionRow[];
  trades: TradeRow[];
  events: EventRow[];
  equity: EquityPoint[];
  metrics: Metrics;
  insight: InsightStatus;
}

export async function fetchDashboard(signal?: AbortSignal): Promise<DashboardData> {
  const [status, portfolio, positions, trades, events, equity, metrics, insight] = await Promise.all([
    get<EngineStatus>('/status', signal),
    get<Portfolio>('/portfolio', signal),
    get<PositionRow[]>('/positions', signal),
    get<TradeRow[]>('/trades?limit=25', signal),
    get<EventRow[]>('/events?limit=80', signal),
    get<EquityPoint[]>('/equity?limit=500', signal),
    get<Metrics>('/metrics', signal),
    get<InsightStatus>('/insight', signal),
  ]);
  return { status, portfolio, positions, trades, events, equity, metrics, insight };
}

export const engageKillSwitch = (reason: string) =>
  post<{ engaged: boolean }>('/kill-switch/engage', { reason });
export const releaseKillSwitch = () => post<{ engaged: boolean }>('/kill-switch/release');
export const flattenAll = () => post<{ closed: number }>('/flatten');

/** Format for display only. Never feed the result back into a calculation. */
export function money(value: string | number, currency = '$'): string {
  const n = typeof value === 'string' ? Number.parseFloat(value) : value;
  if (!Number.isFinite(n)) return '—';
  return `${currency}${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function signedMoney(value: string | number, currency = '$'): string {
  const n = typeof value === 'string' ? Number.parseFloat(value) : value;
  if (!Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}${currency}${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function compactSize(value: string): string {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, { maximumSignificantDigits: 6 });
}

export function timeAgo(ms: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

/**
 * How a verdict reads in the UI.
 *
 * Colour follows PROCESS, not outcome, because process is the part you can act
 * on — a sound trade that lost money needs no change, and a flawed trade that
 * won is the one to worry about. Both halves are always spelled out in words,
 * so the distinction never rests on colour alone.
 */
export const VERDICT_DISPLAY: Record<Verdict, { process: string; outcome: string; tone: 'ok' | 'warn' }> = {
  sound_process_won: { process: 'Sound process', outcome: 'won', tone: 'ok' },
  sound_process_lost: { process: 'Sound process', outcome: 'lost', tone: 'ok' },
  flawed_process_won: { process: 'Flawed process', outcome: 'won', tone: 'warn' },
  flawed_process_lost: { process: 'Flawed process', outcome: 'lost', tone: 'warn' },
};
