import type { NextFunction, Request, Response } from 'express';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** Hostname from a Host header, without the port. */
export function hostnameOf(hostHeader: string | undefined): string {
  if (!hostHeader) return '';
  if (hostHeader.startsWith('[')) return hostHeader.slice(0, hostHeader.indexOf(']') + 1);
  return hostHeader.split(':')[0]!.toLowerCase();
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export type Verdict = { ok: true } | { ok: false; status: number; reason: string };

/**
 * The paper engine's API is read-only and local-only.
 *
 * It binds 127.0.0.1, which keeps the network out. The Host check stops DNS
 * rebinding, where a hostile page re-resolves its own name to 127.0.0.1. The
 * Origin check refuses other sites outright. With no endpoint that changes
 * anything, a cross-site request has nothing to trigger: the kill switch is a
 * file, as it is for the regime engine.
 */
export function checkLocalRead(req: {
  method: string;
  headers: Record<string, string | string[] | undefined>;
}): Verdict {
  const header = (name: string) => {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return { ok: false, status: 405, reason: 'this API is read-only' };
  }
  if (!LOOPBACK_HOSTS.has(hostnameOf(header('host')))) {
    return { ok: false, status: 403, reason: 'host is not loopback' };
  }
  const origin = header('origin');
  if (origin !== undefined && !isLoopbackOrigin(origin)) {
    return { ok: false, status: 403, reason: 'foreign origin' };
  }
  return { ok: true };
}

export function localOnly(req: Request, res: Response, next: NextFunction): void {
  const verdict = checkLocalRead(req);
  if (!verdict.ok) {
    res.status(verdict.status).json({ error: verdict.reason });
    return;
  }
  next();
}
