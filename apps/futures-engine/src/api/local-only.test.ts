import { describe, expect, it } from 'vitest';
import { checkLocalRead } from './local-only';

const request = (method: string, headers: Record<string, string>) => ({ method, headers });

describe('checkLocalRead', () => {
  it('allows a local read', () => {
    expect(checkLocalRead(request('GET', { host: '127.0.0.1:4100' }))).toEqual({ ok: true });
    expect(
      checkLocalRead(request('GET', { host: 'localhost:4100', origin: 'http://localhost:3000' })),
    ).toEqual({
      ok: true,
    });
  });

  it('refuses anything that is not a read', () => {
    expect(checkLocalRead(request('POST', { host: '127.0.0.1:4100' }))).toMatchObject({
      ok: false,
      status: 405,
    });
  });

  it('refuses a rebinding host and a foreign origin', () => {
    expect(checkLocalRead(request('GET', { host: 'evil.example:4100' }))).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(
      checkLocalRead(request('GET', { host: '127.0.0.1:4100', origin: 'https://evil.example' })),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      checkLocalRead(request('GET', { host: '127.0.0.1:4100', origin: 'null' })),
    ).toMatchObject({
      ok: false,
      status: 403,
    });
  });
});
