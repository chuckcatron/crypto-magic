import { describe, expect, it } from 'vitest';
import { checkLocalRequest, hostnameOf, LOCAL_REQUEST_HEADER } from './local-request.guard';

const req = (method: string, headers: Record<string, string>) => ({ method, headers });

describe('hostnameOf', () => {
  it('strips the port', () => expect(hostnameOf('127.0.0.1:4000')).toBe('127.0.0.1'));
  it('keeps an IPv6 literal intact', () => expect(hostnameOf('[::1]:4000')).toBe('[::1]'));
  it('lowercases', () => expect(hostnameOf('LOCALHOST:4000')).toBe('localhost'));
  it('handles a missing header', () => expect(hostnameOf(undefined)).toBe(''));
});

describe('checkLocalRequest — reads', () => {
  it('allows a plain local GET, e.g. curl or the dashboard proxy', () => {
    expect(checkLocalRequest(req('GET', { host: '127.0.0.1:4000' }))).toEqual({ ok: true });
  });

  it('allows localhost and IPv6 loopback', () => {
    expect(checkLocalRequest(req('GET', { host: 'localhost:4000' })).ok).toBe(true);
    expect(checkLocalRequest(req('GET', { host: '[::1]:4000' })).ok).toBe(true);
  });

  it('refuses DNS rebinding: a loopback connection carrying a foreign Host', () => {
    const verdict = checkLocalRequest(req('GET', { host: 'rebind.evil.example' }));
    expect(verdict).toMatchObject({ ok: false, status: 403 });
  });

  it('refuses a request with no Host at all', () => {
    expect(checkLocalRequest(req('GET', {})).ok).toBe(false);
  });

  it('refuses a GET from a foreign page, so it cannot read balances either', () => {
    const verdict = checkLocalRequest(
      req('GET', { host: '127.0.0.1:4000', origin: 'https://evil.example' }),
    );
    expect(verdict.ok).toBe(false);
  });
});

describe('checkLocalRequest — mutations', () => {
  const local = { host: '127.0.0.1:4000', [LOCAL_REQUEST_HEADER]: '1' };

  it('allows a mutation carrying the local header', () => {
    expect(checkLocalRequest(req('POST', local))).toEqual({ ok: true });
  });

  it('refuses the exact CSRF the review demonstrated: foreign Origin, no-cors, no header', () => {
    const verdict = checkLocalRequest(
      req('POST', {
        host: '127.0.0.1:4000',
        origin: 'https://evil.example',
        'content-type': 'text/plain',
      }),
    );
    expect(verdict).toMatchObject({ ok: false, status: 403 });
  });

  it('refuses a foreign Origin even if it somehow sent the header', () => {
    expect(
      checkLocalRequest(req('POST', { ...local, origin: 'https://evil.example' })).ok,
    ).toBe(false);
  });

  it('refuses the opaque "null" origin used by sandboxed iframes and file:// pages', () => {
    expect(checkLocalRequest(req('POST', { ...local, origin: 'null' })).ok).toBe(false);
  });

  it('refuses a mutation without the header even from a local caller', () => {
    const verdict = checkLocalRequest(req('POST', { host: '127.0.0.1:4000' }));
    expect(verdict).toMatchObject({ ok: false, reason: expect.stringContaining(LOCAL_REQUEST_HEADER) });
  });

  it('requires the header value to be exactly "1"', () => {
    expect(
      checkLocalRequest(req('POST', { host: '127.0.0.1:4000', [LOCAL_REQUEST_HEADER]: 'yes' })).ok,
    ).toBe(false);
  });

  it('treats DELETE and PUT as mutations too', () => {
    expect(checkLocalRequest(req('DELETE', { host: '127.0.0.1:4000' })).ok).toBe(false);
    expect(checkLocalRequest(req('PUT', { host: '127.0.0.1:4000' })).ok).toBe(false);
  });
});
