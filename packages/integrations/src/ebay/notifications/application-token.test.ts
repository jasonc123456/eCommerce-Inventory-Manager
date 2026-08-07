import type { HttpClient, HttpOutcome, HttpRequest } from '@eim/providers';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApplicationTokenReader } from './application-token';
import type { CredentialLookup } from '../environment';

/**
 * The application's own token.
 *
 * What is worth testing is the caching, because the failure it prevents is
 * invisible: without it every notification that arrives triggers a token
 * request, and the endpoint that rate-limits first is the one every other call
 * depends on.
 */

const credentials: CredentialLookup = (environment) =>
  environment === 'production'
    ? { clientId: 'id', clientSecret: 'secret', ruName: 'RuName' }
    : null;

class FakeEbay {
  public requests: HttpRequest[] = [];
  public answer: HttpOutcome = tokenResponse('app-token-1', 7200);
  private gate: Promise<void> | null = null;

  reset(): void {
    this.requests = [];
    this.answer = tokenResponse('app-token-1', 7200);
    this.gate = null;
  }

  /** Holds every answer until the returned function is called, so a race can be arranged. */
  hold(): () => void {
    let release = (): void => undefined;

    this.gate = new Promise<void>((resolve) => {
      release = (): void => {
        resolve();
      };
    });

    return () => {
      release();
    };
  }

  readonly client: HttpClient = {
    send: async (request) => {
      this.requests.push(request);

      if (this.gate !== null) {
        await this.gate;
      }

      return this.answer;
    },
  };
}

function tokenResponse(token: string, expiresIn?: number, status = 200): HttpOutcome {
  return {
    ok: true,
    response: {
      status,
      headers: {},
      body: JSON.stringify({
        access_token: token,
        ...(expiresIn === undefined ? {} : { expires_in: expiresIn }),
        token_type: 'Application Access Token',
      }),
      url: 'https://api.ebay.com/identity/v1/oauth2/token',
    },
  };
}

const ebay = new FakeEbay();

beforeEach(() => {
  ebay.reset();
});

function build() {
  return createApplicationTokenReader({ http: ebay.client, credentials });
}

describe('createApplicationTokenReader', () => {
  it('asks for a client-credentials grant with no seller scope', async () => {
    await build().read('production');

    const request = ebay.requests[0];

    expect(request?.url).toBe('https://api.ebay.com/identity/v1/oauth2/token');
    expect(request?.body).toContain('grant_type=client_credentials');
    expect(request?.body).toContain('api_scope');
    expect(request?.body).not.toContain('sell.inventory');
  });

  it('reuses a token that has time left', async () => {
    const reader = build();
    const start = new Date('2026-03-01T00:00:00Z');

    await reader.read('production', start);
    await reader.read('production', new Date(start.getTime() + 3_600_000));

    expect(ebay.requests).toHaveLength(1);
  });

  it('reissues before expiry rather than at it', async () => {
    // A token used at the moment it expires fails during the request that
    // mattered, and a notification acknowledgement cannot be retried later.
    const reader = build();
    const start = new Date('2026-03-01T00:00:00Z');

    await reader.read('production', start);
    await reader.read('production', new Date(start.getTime() + 7_100_000));

    expect(ebay.requests).toHaveLength(2);
  });

  it('issues one request when several callers ask at once', async () => {
    const reader = build();
    const letGo = ebay.hold();

    const answers = Promise.all([
      reader.read('production'),
      reader.read('production'),
      reader.read('production'),
    ]);

    letGo();

    expect(await answers).toEqual(['app-token-1', 'app-token-1', 'app-token-1']);
    expect(ebay.requests).toHaveLength(1);
  });

  it('returns null for an environment the operator has not configured', async () => {
    await expect(build().read('sandbox')).resolves.toBeNull();
    expect(ebay.requests).toHaveLength(0);
  });

  it('returns null when eBay refuses, and does not cache the refusal', async () => {
    const reader = build();

    ebay.answer = tokenResponse('', 0, 401);
    await expect(reader.read('production')).resolves.toBeNull();

    ebay.answer = tokenResponse('app-token-2', 7200);
    await expect(reader.read('production')).resolves.toBe('app-token-2');
  });

  it('returns null for an answer that is not a token', async () => {
    for (const answer of [
      { ok: false, kind: 'timeout', reason: 'timed out' } as HttpOutcome,
      {
        ok: true,
        response: { status: 200, headers: {}, body: 'not json', url: 'x' },
      } as HttpOutcome,
      {
        ok: true,
        response: { status: 200, headers: {}, body: JSON.stringify([]), url: 'x' },
      } as HttpOutcome,
      {
        ok: true,
        response: { status: 200, headers: {}, body: JSON.stringify({ token: 'x' }), url: 'x' },
      } as HttpOutcome,
    ]) {
      ebay.answer = answer;
      await expect(build().read('production')).resolves.toBeNull();
    }
  });

  it('does not rely on a lifetime eBay did not state', async () => {
    const reader = build();
    const start = new Date('2026-03-01T00:00:00Z');

    ebay.answer = tokenResponse('app-token-1');
    await expect(reader.read('production', start)).resolves.toBe('app-token-1');
    await reader.read('production', start);

    expect(ebay.requests).toHaveLength(2);
  });

  it('forgets a token on request, for when eBay rejects one it issued', async () => {
    const reader = build();

    await reader.read('production');
    reader.forget('production');
    await reader.read('production');

    expect(ebay.requests).toHaveLength(2);
  });
});
