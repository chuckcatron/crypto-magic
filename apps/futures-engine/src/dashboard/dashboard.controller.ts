import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Controller, Get, Header, NotFoundException } from '@nestjs/common';

/** The page's own files, next to src/ and dist/ alike. */
const PUBLIC_DIR = join(__dirname, '..', '..', 'public');

/**
 * Same origin only, and no inline script or style, so nothing injected into
 * the page (a coin name, an error message) can run. The page only reads this
 * engine's own API.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Read on every request, so an edited page shows on reload. It is a few KB, read rarely. */
function publicFile(name: string): string {
  try {
    return readFileSync(join(PUBLIC_DIR, name), 'utf8');
  } catch {
    throw new NotFoundException(`dashboard file ${name} is missing`);
  }
}

/**
 * The dashboard: a read-only page over the API, at http://127.0.0.1:4100/.
 * The same loopback-only, read-only guard as the API applies to it.
 */
@Controller()
export class DashboardController {
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Content-Security-Policy', CONTENT_SECURITY_POLICY)
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('Cache-Control', 'no-cache')
  page(): string {
    return publicFile('index.html');
  }

  @Get('dashboard.css')
  @Header('Content-Type', 'text/css; charset=utf-8')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Cache-Control', 'no-cache')
  styles(): string {
    return publicFile('dashboard.css');
  }

  @Get('dashboard.js')
  @Header('Content-Type', 'text/javascript; charset=utf-8')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Cache-Control', 'no-cache')
  script(): string {
    return publicFile('dashboard.js');
  }
}
