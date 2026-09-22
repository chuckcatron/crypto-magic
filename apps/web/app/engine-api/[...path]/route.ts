import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Same-origin proxy to the trading engine.
 *
 * A route handler rather than a `next.config` rewrite or a NEXT_PUBLIC_ variable,
 * because both of those are resolved when `next build` runs — the rewrite is
 * baked into the routes manifest and the variable is inlined into the client
 * bundle — so changing the engine's port afterwards silently kept hitting the
 * old one. This reads the address on every request, so `ENGINE_URL=... pnpm
 * dashboard` does what it looks like it does.
 *
 * It also means the browser only ever talks to its own origin, so the engine
 * needs no CORS exception for the dashboard.
 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function hostnameOf(host: string | null): string {
  if (!host) return '';
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1);
  return host.split(':')[0]!.toLowerCase();
}

/**
 * Refuse anything that is not this dashboard, in this browser, on this machine.
 *
 * This proxy can sell every position, so it needs the same protection as the
 * engine behind it. Without these checks it would launder a cross-site request
 * into a trusted server-side call: evil.example posts to localhost:3000, the
 * proxy forwards it with the engine's own header attached, and the engine's
 * guard would have nothing left to object to.
 *
 *   - Host must be loopback, which defeats DNS rebinding and also refuses a
 *     request arriving over the LAN if the server is ever bound wider.
 *   - A POST must come from this page's own origin. Browsers always send Origin
 *     on a cross-origin POST, including no-cors ones, so a foreign page cannot
 *     pass this.
 */
function rejectForeign(request: Request): NextResponse | null {
  const host = request.headers.get('host');
  if (!LOOPBACK.has(hostnameOf(host))) {
    return NextResponse.json({ error: 'host is not loopback' }, { status: 403 });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const origin = request.headers.get('origin');
    let sameOrigin = false;
    try {
      sameOrigin = origin !== null && new URL(origin).host === host;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) {
      return NextResponse.json({ error: 'cross-origin request refused' }, { status: 403 });
    }
  }
  return null;
}

function engineUrl(): string {
  return (process.env.ENGINE_URL ?? 'http://127.0.0.1:4000').replace(/\/$/, '');
}

async function forward(request: Request, path: string[], method: 'GET' | 'POST'): Promise<Response> {
  const refused = rejectForeign(request);
  if (refused) return refused;

  const search = new URL(request.url).search;
  const target = `${engineUrl()}/api/${path.join('/')}${search}`;

  try {
    const response = await fetch(target, {
      method,
      headers: {
        'content-type': 'application/json',
        // The engine refuses mutations without this. Only reached after the
        // same-origin check above has passed.
        'x-crypto-magic-request': '1',
      },
      ...(method === 'POST' ? { body: await request.text() } : {}),
      cache: 'no-store',
    });
    const body = await response.text();
    return new NextResponse(body, {
      status: response.status,
      headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' },
    });
  } catch (error) {
    // The engine being down is the normal case while you are not running it,
    // not an exception worth a stack trace in the browser console.
    return NextResponse.json(
      {
        error: 'engine unreachable',
        engineUrl: engineUrl(),
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 503 },
    );
  }
}

export async function GET(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(request, (await ctx.params).path, 'GET');
}

export async function POST(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(request, (await ctx.params).path, 'POST');
}
