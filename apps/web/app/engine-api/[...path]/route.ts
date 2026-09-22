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
function engineUrl(): string {
  return (process.env.ENGINE_URL ?? 'http://127.0.0.1:4000').replace(/\/$/, '');
}

async function forward(request: Request, path: string[], method: 'GET' | 'POST'): Promise<Response> {
  const search = new URL(request.url).search;
  const target = `${engineUrl()}/api/${path.join('/')}${search}`;

  try {
    const response = await fetch(target, {
      method,
      headers: { 'content-type': 'application/json' },
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
