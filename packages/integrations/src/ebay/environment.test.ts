import { describe, expect, it } from 'vitest';

import { basicAuthorization, credentialsFrom, hostsFor } from './environment';
import { parseIdentity } from './identity';
import { parseTokenResponse } from './oauth';

/**
 * Environment isolation and response parsing (section 13).
 *
 * Sandbox and production are strictly isolated, and the isolation is only real
 * if nothing derives one environment's host or credential from the other's.
 */

describe('hostsFor', () => {
  it('keeps the two environments entirely apart', () => {
    const sandbox = hostsFor('sandbox');
    const production = hostsFor('production');

    for (const key of Object.keys(sandbox) as (keyof typeof sandbox)[]) {
      expect(sandbox[key]).not.toBe(production[key]);
      expect(sandbox[key].startsWith('https://')).toBe(true);
      expect(production[key].startsWith('https://')).toBe(true);
    }

    expect(sandbox.tokenUrl).toContain('sandbox');
    expect(production.tokenUrl).not.toContain('sandbox');
  });

  it('serves identity from a different host than the rest, as eBay does', () => {
    expect(hostsFor('production').apizBase).not.toBe(hostsFor('production').apiBase);
  });
});

describe('credentialsFrom', () => {
  const full = {
    EIM_EBAY_SANDBOX_CLIENT_ID: 'sandbox-id',
    EIM_EBAY_SANDBOX_CLIENT_SECRET: 'sandbox-secret',
    EIM_EBAY_SANDBOX_RUNAME: 'sandbox-runame',
    EIM_EBAY_PRODUCTION_CLIENT_ID: 'production-id',
    EIM_EBAY_PRODUCTION_CLIENT_SECRET: 'production-secret',
    EIM_EBAY_PRODUCTION_RUNAME: 'production-runame',
  };

  it('reads each environment from its own settings', () => {
    const lookup = credentialsFrom(full);

    expect(lookup('sandbox')?.clientId).toBe('sandbox-id');
    expect(lookup('production')?.clientId).toBe('production-id');
  });

  it('reports an unconfigured environment as absent rather than failing', () => {
    // A deployment that only uses production is the ordinary case. The sandbox
    // screen should say "not configured", not error.
    const lookup = credentialsFrom({
      EIM_EBAY_PRODUCTION_CLIENT_ID: 'id',
      EIM_EBAY_PRODUCTION_CLIENT_SECRET: 'secret',
      EIM_EBAY_PRODUCTION_RUNAME: 'runame',
    });

    expect(lookup('sandbox')).toBeNull();
    expect(lookup('production')).not.toBeNull();
  });

  it('treats a partly configured environment as unconfigured', () => {
    // Two of three settings produces an authorization URL that fails at eBay
    // with a message about the third, which is a worse experience than being
    // told the environment is not set up.
    const lookup = credentialsFrom({
      EIM_EBAY_SANDBOX_CLIENT_ID: 'id',
      EIM_EBAY_SANDBOX_CLIENT_SECRET: 'secret',
    });

    expect(lookup('sandbox')).toBeNull();
  });

  it('treats an empty string as unset', () => {
    const lookup = credentialsFrom({ ...full, EIM_EBAY_SANDBOX_RUNAME: '' });

    expect(lookup('sandbox')).toBeNull();
  });
});

describe('basicAuthorization', () => {
  it('encodes the pair the way the token endpoint expects', () => {
    const header = basicAuthorization({
      clientId: 'client',
      clientSecret: 'secret',
      ruName: 'runame',
    });

    expect(header).toBe(`Basic ${Buffer.from('client:secret').toString('base64')}`);
  });
});

describe('parseTokenResponse', () => {
  const now = new Date('2026-01-01T00:00:00Z');

  it('reads a complete response', () => {
    const tokens = parseTokenResponse(
      JSON.stringify({
        access_token: 'access',
        expires_in: 7200,
        refresh_token: 'refresh',
        refresh_token_expires_in: 47_304_000,
        scope: 'https://api.ebay.com/oauth/api_scope',
      }),
      now,
    );

    expect(tokens?.accessToken).toBe('access');
    expect(tokens?.accessTokenExpiresAt).toEqual(new Date('2026-01-01T02:00:00Z'));
    expect(tokens?.refreshToken).toBe('refresh');
  });

  it('reads a refresh response that returns no new refresh token', () => {
    // eBay does not always issue one. Absence means keep what you have, and
    // must not read as "the refresh token is now empty".
    const tokens = parseTokenResponse(
      JSON.stringify({ access_token: 'access', expires_in: 7200 }),
      now,
    );

    expect(tokens?.accessToken).toBe('access');
    expect(tokens?.refreshToken).toBeUndefined();
  });

  it('refuses a body that parses but contains no token', () => {
    // A proxy error page, a login redirect, an HTML body with a 200. Each of
    // these is a plausible thing to receive and none of them is a token.
    for (const body of [
      '',
      'not json',
      '{}',
      'null',
      '[]',
      JSON.stringify({ access_token: '', expires_in: 7200 }),
      JSON.stringify({ access_token: 'access' }),
      JSON.stringify({ access_token: 'access', expires_in: 0 }),
      JSON.stringify({ access_token: 'access', expires_in: '7200' }),
      JSON.stringify({ access_token: 42, expires_in: 7200 }),
    ]) {
      expect(parseTokenResponse(body, now), body).toBeNull();
    }
  });
});

describe('parseIdentity', () => {
  it('binds to the identifier that survives a rename', () => {
    // The username is a label. Binding to it would mean a seller who renamed
    // themselves came back as a different account.
    const identity = parseIdentity(JSON.stringify({ userId: 'u-123', username: 'thrifty-shop' }));

    expect(identity).toEqual({ sellerId: 'u-123', username: 'thrifty-shop' });
  });

  it('accepts an identity with no username', () => {
    expect(parseIdentity(JSON.stringify({ userId: 'u-123' }))).toEqual({ sellerId: 'u-123' });
  });

  it('refuses a partial identity rather than binding to nothing', () => {
    // A connection bound to an empty seller id matches every future
    // authorization, which is exactly the check the binding exists to perform.
    for (const body of [
      '{}',
      'garbage',
      JSON.stringify({ userId: '' }),
      JSON.stringify({ userId: '   ' }),
      JSON.stringify({ userId: 123 }),
      JSON.stringify({ username: 'thrifty-shop' }),
    ]) {
      expect(parseIdentity(body), body).toBeNull();
    }
  });
});
