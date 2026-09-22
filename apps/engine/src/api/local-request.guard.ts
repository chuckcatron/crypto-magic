import type { NextFunction, Request, Response } from 'express';

/**
 * Header a caller must send on any state-changing request.
 *
 * A browser cannot attach a custom header to a cross-origin request without a
 * CORS preflight, and the engine answers no preflights (it enables no CORS), so
 * requiring this header means a web page cannot trigger an action here — only
 * the dashboard's server-side proxy and a deliberate `curl -H` can.
 */
export const LOCAL_REQUEST_HEADER = 'x-crypto-magic-request';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** Hostname from a Host header, without the port. */
export function hostnameOf(hostHeader: string | undefined): string {
  if (!hostHeader) return '';
  if (hostHeader.startsWith('[')) return hostHeader.slice(0, hostHeader.indexOf(']') + 1);
  return hostHeader.split(':')[0]!.toLowerCase();
}

export function isLoopbackOrigin(origin: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export type GuardVerdict = { ok: true } | { ok: false; status: number; reason: string };

/**
 * Decide whether a request may reach the API.
 *
 * The engine binds 127.0.0.1, which stops the network from reaching it. It does
 * NOT stop your own browser, and your browser runs other people's code:
 *
 *   - CSRF. Any web page can fire `fetch('http://127.0.0.1:4000/api/flatten',
 *     { method: 'POST', mode: 'no-cors' })`. CORS only hides the RESPONSE; the
 *     request still arrives and the side effect still happens. Verified in the
 *     security review: a foreign-origin request released the kill switch.
 *   - DNS rebinding. A page on evil.example re-resolves its own name to
 *     127.0.0.1 and then reads this API as "same origin". The only tell is the
 *     Host header, which still says evil.example.
 *
 * So: Host must be loopback (defeats rebinding), a foreign Origin is refused
 * outright, and any mutation must carry a header a browser cannot send
 * cross-origin without a preflight this server never approves.
 */
export function checkLocalRequest(req: {
  method: string;
  headers: Record<string, string | string[] | undefined>;
}): GuardVerdict {
  const header = (name: string) => {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };

  if (!LOOPBACK_HOSTS.has(hostnameOf(header('host')))) {
    return { ok: false, status: 403, reason: 'host is not loopback' };
  }

  const origin = header('origin');
  if (origin !== undefined && origin !== 'null' && !isLoopbackOrigin(origin)) {
    return { ok: false, status: 403, reason: 'cross-origin request refused' };
  }
  // An opaque "null" origin comes from sandboxed iframes and file:// pages —
  // never from the dashboard. Treat it as foreign.
  if (origin === 'null') {
    return { ok: false, status: 403, reason: 'opaque origin refused' };
  }

  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase());
  if (mutating && header(LOCAL_REQUEST_HEADER) !== '1') {
    return { ok: false, status: 403, reason: `missing ${LOCAL_REQUEST_HEADER} header` };
  }

  return { ok: true };
}

export function localRequestMiddleware(req: Request, res: Response, next: NextFunction): void {
  const verdict = checkLocalRequest(req);
  if (verdict.ok) return next();
  res.status(verdict.status).json({ error: verdict.reason });
}
