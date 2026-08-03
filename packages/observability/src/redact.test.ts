import { describe, expect, it } from 'vitest';

import { applyFieldAllowlist, serializeError } from './redact';

describe('serializeError', () => {
  it('keeps the three properties worth diagnosing with', () => {
    const error = new TypeError('mapping 41 has no location');
    const serialized = serializeError(error);

    expect(serialized.name).toBe('TypeError');
    expect(serialized.message).toBe('mapping 41 has no location');
    expect(serialized.stack).toContain('TypeError');
  });

  it('drops everything a provider SDK hangs off a thrown error', () => {
    // This is the shape that motivates the whole function: a real eBay or
    // WooCommerce client attaches the HTTP exchange, authorization header
    // included, to the error it throws.
    const error = Object.assign(new Error('request failed'), {
      response: {
        status: 401,
        request: { headers: { authorization: 'Bearer v^1.1#i^1#p^3#TOKEN' } },
      },
      config: { auth: { username: 'ck_live', password: 'cs_live_secret' } },
    });

    const serialized = serializeError(error);

    expect(Object.keys(serialized).sort()).toEqual(['message', 'name', 'stack']);
    expect(JSON.stringify(serialized)).not.toContain('Bearer');
    expect(JSON.stringify(serialized)).not.toContain('cs_live_secret');
  });

  it('keeps a scalar error code, because retry decisions turn on it', () => {
    const error = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });

    expect(serializeError(error).code).toBe('ECONNREFUSED');
  });

  it('ignores a code that is not a scalar', () => {
    const error = Object.assign(new Error('failed'), { code: { nested: 'secret' } });

    expect(serializeError(error).code).toBeUndefined();
  });

  it('is idempotent, because pino serializes before the formatter runs', () => {
    const once = serializeError(new TypeError('mapping 41 has no location'));
    const twice = serializeError(once);

    expect(twice).toEqual(once);
  });

  it('re-filters an error already serialized by pino stdSerializers', () => {
    // pino's own serializer spells the name `type` and copies every extra
    // property across, so its output still needs filtering.
    const serialized = serializeError({
      type: 'Error',
      message: 'request failed',
      stack: 'Error: request failed\n    at x',
      response: { headers: { authorization: 'Bearer SECRET' } },
    });

    expect(serialized.name).toBe('Error');
    expect(serialized.message).toBe('request failed');
    expect(JSON.stringify(serialized)).not.toContain('SECRET');
  });

  it('describes a thrown non-error without echoing it', () => {
    const serialized = serializeError({ token: 'super-secret' });

    expect(serialized.name).toBe('NonError');
    expect(JSON.stringify(serialized)).not.toContain('super-secret');
  });
});

describe('applyFieldAllowlist', () => {
  it('keeps allowlisted scalars', () => {
    const result = applyFieldAllowlist({
      msg: 'projection applied',
      businessId: 'b_7',
      mappingId: 'm_19',
      quantity: 4,
      outcome: 'success',
    });

    expect(result).toEqual({
      msg: 'projection applied',
      businessId: 'b_7',
      mappingId: 'm_19',
      quantity: 4,
      outcome: 'success',
    });
  });

  it('drops a field nobody added to the allowlist', () => {
    const result = applyFieldAllowlist({
      msg: 'token refreshed',
      accessToken: 'v^1.1#i^1#p^3#TOKEN',
    });

    expect(result['accessToken']).toBeUndefined();
    expect(result['unloggedFields']).toEqual(['accessToken']);
  });

  it('drops an object even under an allowlisted key', () => {
    // The allowlist vouches for the key, never for what a caller nests below
    // it. `provider` is allowlisted as an enumeration, not as a container.
    const result = applyFieldAllowlist({
      provider: { name: 'ebay', credentials: { clientSecret: 'shh' } },
    });

    expect(result['provider']).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('shh');
  });

  it('reports dropped names in sorted order so output is stable', () => {
    const result = applyFieldAllowlist({ zebra: 1, apple: 2, mango: 3 });

    expect(result['unloggedFields']).toEqual(['apple', 'mango', 'zebra']);
  });

  it('omits unloggedFields entirely when nothing was dropped', () => {
    const result = applyFieldAllowlist({ msg: 'ok' });

    expect('unloggedFields' in result).toBe(false);
  });

  it('keeps null and undefined, which carry nothing to leak', () => {
    const result = applyFieldAllowlist({ businessId: null, orderId: undefined });

    expect(result['businessId']).toBeNull();
    expect('orderId' in result).toBe(true);
  });

  it('routes the error field through the serializer', () => {
    const error = Object.assign(new Error('boom'), { secret: 'do-not-log' });
    const result = applyFieldAllowlist({ err: error });

    expect(JSON.stringify(result)).not.toContain('do-not-log');
    expect(JSON.stringify(result)).toContain('boom');
  });

  it('drops a customer name even though the value is a plain string', () => {
    // The point of an allowlist rather than a denylist: nobody had to predict
    // this field name for it to be excluded.
    const result = applyFieldAllowlist({ buyerName: 'Alex Morgan', orderId: 'o_3' });

    expect(result['buyerName']).toBeUndefined();
    expect(result['orderId']).toBe('o_3');
  });
});
