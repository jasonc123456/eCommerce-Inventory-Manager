import { describe, expect, it } from 'vitest';

import { REDACTED, isSecretFieldName, sanitizeDetail } from './detail';

describe('isSecretFieldName', () => {
  it('recognises a secret however the name is spelled', () => {
    for (const key of [
      'token',
      'sessionToken',
      'session_token',
      'SESSION_TOKEN',
      'refresh-token',
      'clientSecret',
      'password',
      'totpSeed',
      'recoveryCode',
      'recovery_code',
      'emailCode',
      'webauthnChallenge',
      'cookie',
      'authorization',
      'apiKey',
      'privateKey',
      'tokenHash',
      'signature',
    ]) {
      expect(isSecretFieldName(key)).toBe(true);
    }
  });

  it('leaves the context an audit entry is written for', () => {
    // A bare `code` would take these with it, which is why the list holds
    // phrases rather than words.
    for (const key of [
      'locationCode',
      'currencyCode',
      'sku',
      'role',
      'email',
      'businessId',
      'reason',
      'previousRole',
      'statusCode',
    ]) {
      expect(isSecretFieldName(key)).toBe(false);
    }
  });
});

describe('sanitizeDetail', () => {
  it('keeps ordinary fields unchanged', () => {
    expect(sanitizeDetail({ role: 'manager', count: 3, active: true, absent: null })).toEqual({
      role: 'manager',
      count: 3,
      active: true,
      absent: null,
    });
  });

  it('replaces a secret rather than dropping it', () => {
    // Dropping would read as though the action never involved one.
    expect(sanitizeDetail({ email: 'a@example.invalid', token: 'abc123' })).toEqual({
      email: 'a@example.invalid',
      token: REDACTED,
    });
  });

  it('redacts a secret nested inside a summary', () => {
    const result = sanitizeDetail({ before: { role: 'viewer', apiKey: 'live_123' } });

    expect(result).toEqual({ before: { role: 'viewer', apiKey: REDACTED } });
  });

  it('never lets the value through in place of the name', () => {
    const detail = sanitizeDetail({ sessionToken: 'super-secret-value' });

    expect(JSON.stringify(detail)).not.toContain('super-secret-value');
  });

  it('truncates a long string and says how much was cut', () => {
    const result = sanitizeDetail({ note: 'x'.repeat(600) }) as { note: string };

    expect(result.note).toHaveLength(512 + '… [88 more characters]'.length);
    expect(result.note).toContain('88 more characters');
  });

  it('bounds depth rather than recursing into whatever it was handed', () => {
    const deep = { a: { b: { c: { d: { e: { f: 'bottom' } } } } } };

    expect(JSON.stringify(sanitizeDetail(deep))).toContain('[too deep]');
  });

  it('bounds array length', () => {
    const result = sanitizeDetail({ items: Array.from({ length: 60 }, (_, i) => i) }) as {
      items: unknown[];
    };

    expect(result.items).toHaveLength(51);
    expect(result.items.at(-1)).toBe('[10 more]');
  });

  it('bounds object entries', () => {
    const wide = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`field${String(i)}`, i]));

    const result = sanitizeDetail(wide);

    expect(Object.keys(result)).toHaveLength(51);
    expect(result['truncated']).toBe(true);
  });

  it('describes values that are not JSON instead of serializing them', () => {
    const result = sanitizeDetail({
      fn: () => 'x',
      sym: Symbol('x'),
      big: 10n,
      missing: undefined,
      nan: Number.NaN,
      infinite: Number.POSITIVE_INFINITY,
    });

    expect(result).toEqual({
      fn: '[function]',
      sym: '[symbol]',
      big: '10',
      missing: null,
      nan: '[NaN]',
      infinite: '[Infinity]',
    });
  });

  it('renders a date as an instant, not as an object', () => {
    const when = new Date('2026-08-05T12:00:00.000Z');

    expect(sanitizeDetail({ when })).toEqual({ when: '2026-08-05T12:00:00.000Z' });
  });

  it('does not carry an error object whole', () => {
    // Provider SDKs hang the entire HTTP exchange off a thrown error, so
    // `error.response.request.headers.authorization` is a real path to a real
    // bearer token.
    const error = Object.assign(new Error('failed'), {
      response: { request: { headers: { authorization: 'Bearer live_secret' } } },
    });

    expect(JSON.stringify(sanitizeDetail({ error }))).not.toContain('live_secret');
  });

  it('produces something PostgreSQL will accept as jsonb', () => {
    const result = sanitizeDetail({ nan: Number.NaN, when: new Date(), big: 1n });

    expect(() => JSON.stringify(result)).not.toThrow();
  });
});
