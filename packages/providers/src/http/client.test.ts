import { describe, expect, it, vi } from 'vitest';

import { createHttpClient, type Transport, type TransportResponse } from './client';

/**
 * The guarded client.
 *
 * The behaviour worth testing is which requests never leave, and what happens
 * to the ones that do. The socket layer is injected rather than exercised: a
 * real network cannot be made to produce a name that resolves publicly for the
 * check and privately for the connection, and that is the case this exists for.
 */

const PRODUCTION = { allowPrivate: false, allowlist: [], allowInsecure: false };

const ok = (overrides: Partial<TransportResponse> = {}): TransportResponse => ({
  status: 200,
  headers: {},
  body: '{}',
  ...overrides,
});

function client(options: {
  transport?: Transport;
  resolve?: (hostname: string) => Promise<readonly string[]>;
  policy?: typeof PRODUCTION;
}) {
  return createHttpClient({
    policy: options.policy ?? PRODUCTION,
    resolve: options.resolve ?? (() => Promise.resolve(['93.184.216.34'])),
    transport: options.transport ?? (() => Promise.resolve(ok())),
  });
}

describe('destination checks', () => {
  it('sends a request to a public host', async () => {
    const transport = vi.fn<Transport>(() => Promise.resolve(ok({ body: 'hello' })));

    const outcome = await client({ transport }).send({
      method: 'GET',
      url: 'https://store.example.com/wp-json',
    });

    expect(outcome.ok && outcome.response.body).toBe('hello');
    expect(transport).toHaveBeenCalledOnce();
  });

  it('refuses a host that resolves to a private address', async () => {
    // The URL looks perfectly ordinary. Only the resolution gives it away.
    const transport = vi.fn<Transport>(() => Promise.resolve(ok()));

    const outcome = await client({
      transport,
      resolve: () => Promise.resolve(['10.0.0.5']),
    }).send({ method: 'GET', url: 'https://store.example.com/wp-json' });

    expect(outcome).toMatchObject({ ok: false, kind: 'blocked' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('refuses when any resolved address is private, not merely the first', async () => {
    // A name answering with both a public and a private address is being used
    // to slip the private one past a check that stops at the first acceptable
    // result. No real store is configured that way.
    const transport = vi.fn<Transport>(() => Promise.resolve(ok()));

    const outcome = await client({
      transport,
      resolve: () => Promise.resolve(['93.184.216.34', '169.254.169.254']),
    }).send({ method: 'GET', url: 'https://store.example.com/' });

    expect(outcome).toMatchObject({ ok: false, kind: 'blocked' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('connects to the address it validated, not to the name', async () => {
    // This is what closes the rebinding window: the socket goes to the address
    // that was checked, so a second resolution cannot change the destination.
    const transport = vi.fn<Transport>(() => Promise.resolve(ok()));

    await client({ transport, resolve: () => Promise.resolve(['93.184.216.34']) }).send({
      method: 'GET',
      url: 'https://store.example.com/',
    });

    expect(transport.mock.calls[0]?.[0].address).toBe('93.184.216.34');
    expect(transport.mock.calls[0]?.[0].headers['host']).toBe('store.example.com');
  });

  it('reports a host that does not resolve as blocked rather than crashing', async () => {
    const outcome = await client({ resolve: () => Promise.resolve([]) }).send({
      method: 'GET',
      url: 'https://store.example.com/',
    });

    expect(outcome).toMatchObject({ ok: false, kind: 'blocked' });
  });
});

describe('redirects', () => {
  it('follows a redirect within the allowed destinations', async () => {
    const transport = vi.fn<Transport>((request) =>
      Promise.resolve(
        request.url.pathname === '/old'
          ? ok({ status: 301, headers: { location: 'https://store.example.com/new' } })
          : ok({ body: 'arrived' }),
      ),
    );

    const outcome = await client({ transport }).send({
      method: 'GET',
      url: 'https://store.example.com/old',
    });

    expect(outcome.ok && outcome.response.body).toBe('arrived');
    expect(outcome.ok && outcome.response.url).toBe('https://store.example.com/new');
  });

  it('validates every hop, so a redirect cannot reach the metadata service', async () => {
    // The first request is to a real store. The redirect is where the attack
    // lives, and a client that follows redirects for you would take it.
    const transport = vi.fn<Transport>(() =>
      Promise.resolve(
        ok({ status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }),
      ),
    );

    const outcome = await client({ transport }).send({
      method: 'GET',
      url: 'https://store.example.com/',
    });

    expect(outcome).toMatchObject({ ok: false, kind: 'blocked' });
    expect(transport).toHaveBeenCalledOnce();
  });

  it('re-resolves each hop rather than trusting the first answer', async () => {
    const resolve = vi
      .fn<(hostname: string) => Promise<readonly string[]>>()
      .mockResolvedValueOnce(['93.184.216.34'])
      .mockResolvedValueOnce(['127.0.0.1']);

    const transport = vi.fn<Transport>(() =>
      Promise.resolve(ok({ status: 302, headers: { location: 'https://other.example.com/' } })),
    );

    const outcome = await client({ transport, resolve }).send({
      method: 'GET',
      url: 'https://store.example.com/',
    });

    expect(outcome).toMatchObject({ ok: false, kind: 'blocked' });
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('stops after the redirect limit instead of looping', async () => {
    const transport = vi.fn<Transport>((request) =>
      Promise.resolve(
        ok({
          status: 302,
          headers: { location: `https://store.example.com${request.url.pathname}x` },
        }),
      ),
    );

    const outcome = await client({ transport }).send({
      method: 'GET',
      url: 'https://store.example.com/a',
      maxRedirects: 2,
    });

    expect(outcome).toMatchObject({ ok: false, kind: 'too_many_redirects' });
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it('drops the body when a POST is redirected to a GET', async () => {
    // Carrying it would resend whatever it contained to a destination that
    // asked for something else.
    const transport = vi.fn<Transport>((request) =>
      Promise.resolve(
        request.url.pathname === '/submit'
          ? ok({ status: 303, headers: { location: 'https://store.example.com/done' } })
          : ok(),
      ),
    );

    await client({ transport }).send({
      method: 'POST',
      url: 'https://store.example.com/submit',
      body: '{"secret":"value"}',
    });

    expect(transport.mock.calls[1]?.[0].method).toBe('GET');
    expect(transport.mock.calls[1]?.[0].body).toBeUndefined();
  });
});

describe('bounds', () => {
  it('reports a truncated response as too large rather than returning half of it', async () => {
    // Half a JSON document parses as nothing, or worse, as something.
    const transport = vi.fn<Transport>(() => Promise.resolve(ok({ truncated: true, body: '' })));

    const outcome = await client({ transport }).send({
      method: 'GET',
      url: 'https://store.example.com/',
      maxBytes: 1024,
    });

    expect(outcome).toMatchObject({ ok: false, kind: 'too_large' });
  });

  it('gives up when the whole-request budget is spent across hops', async () => {
    const transport = vi.fn<Transport>(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve(ok({ status: 302, headers: { location: 'https://store.example.com/next' } }));
          }, 20);
        }),
    );

    const outcome = await client({ transport }).send({
      method: 'GET',
      url: 'https://store.example.com/',
      timeoutMs: 30,
      maxRedirects: 5,
    });

    expect(outcome).toMatchObject({ ok: false, kind: 'timeout' });
  });

  it('reports a transport failure without quoting the provider', async () => {
    const transport = vi.fn<Transport>(() =>
      Promise.reject(
        Object.assign(new Error('connect ECONNREFUSED 93.184.216.34:443'), {
          code: 'ECONNREFUSED',
        }),
      ),
    );

    const outcome = await client({ transport }).send({
      method: 'GET',
      url: 'https://store.example.com/',
    });

    expect(outcome).toMatchObject({ ok: false, kind: 'transport', reason: 'ECONNREFUSED' });
  });
});

describe('the responses that do not fit the happy path', () => {
  it('returns a 3xx with no Location rather than following it', async () => {
    const transport = vi.fn<Transport>(() => Promise.resolve(ok({ status: 304, headers: {} })));

    const outcome = await client({ transport }).send({
      method: 'GET',
      url: 'https://store.example.com/',
    });

    expect(outcome.ok && outcome.response.status).toBe(304);
    expect(transport).toHaveBeenCalledOnce();
  });

  it('returns a 3xx with an empty Location rather than following it', async () => {
    const transport = vi.fn<Transport>(() =>
      Promise.resolve(ok({ status: 302, headers: { location: '   ' } })),
    );

    const outcome = await client({ transport }).send({
      method: 'GET',
      url: 'https://store.example.com/',
    });

    expect(outcome.ok && outcome.response.status).toBe(302);
  });

  it('follows a relative Location against the URL that answered', async () => {
    const transport = vi.fn<Transport>((request) =>
      Promise.resolve(
        request.url.pathname === '/a/b'
          ? ok({ status: 302, headers: { location: '../c' } })
          : ok({ body: 'relative' }),
      ),
    );

    const outcome = await client({ transport }).send({
      method: 'GET',
      url: 'https://store.example.com/a/b',
    });

    expect(outcome.ok && outcome.response.url).toBe('https://store.example.com/c');
  });

  it('keeps the method on a 307, which is what 307 means', async () => {
    const transport = vi.fn<Transport>((request) =>
      Promise.resolve(
        request.url.pathname === '/submit'
          ? ok({ status: 307, headers: { location: 'https://store.example.com/done' } })
          : ok(),
      ),
    );

    await client({ transport }).send({
      method: 'POST',
      url: 'https://store.example.com/submit',
      body: '{"a":1}',
    });

    expect(transport.mock.calls[1]?.[0].method).toBe('POST');
    expect(transport.mock.calls[1]?.[0].body).toBe('{"a":1}');
  });

  it('does not rewrite a HEAD to a GET on a 301', async () => {
    const transport = vi.fn<Transport>((request) =>
      Promise.resolve(
        request.url.pathname === '/x'
          ? ok({ status: 301, headers: { location: 'https://store.example.com/y' } })
          : ok(),
      ),
    );

    await client({ transport }).send({ method: 'HEAD', url: 'https://store.example.com/x' });

    expect(transport.mock.calls[1]?.[0].method).toBe('HEAD');
  });

  it('reports a resolver that throws as blocked', async () => {
    const outcome = await client({
      resolve: () => Promise.reject(Object.assign(new Error('nope'), { code: 'ENOTFOUND' })),
    }).send({ method: 'GET', url: 'https://store.example.com/' });

    expect(outcome).toMatchObject({ ok: false, kind: 'blocked' });
    expect(!outcome.ok && outcome.reason).toContain('ENOTFOUND');
  });

  it('describes an error with no code without inventing detail', async () => {
    const transport = vi.fn<Transport>(() => Promise.reject(new Error('socket exploded')));

    const outcome = await client({ transport }).send({
      method: 'GET',
      url: 'https://store.example.com/',
    });

    // Not the message: a driver's message routinely quotes the request.
    expect(outcome).toMatchObject({ ok: false, kind: 'transport', reason: 'the request failed' });
  });

  it('classifies a timeout as a timeout rather than a transport failure', async () => {
    const transport = vi.fn<Transport>(() =>
      Promise.reject(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })),
    );

    const outcome = await client({ transport }).send({
      method: 'GET',
      url: 'https://store.example.com/',
    });

    expect(outcome).toMatchObject({ ok: false, kind: 'timeout' });
  });

  it('refuses a redirect to something that is not a URL at all', async () => {
    // `https://` has a scheme and no host, which is one of the few strings that
    // fails even when resolved against a valid base. Most garbage does not:
    // it resolves as a relative path and stays on the host we already checked.
    const transport = vi.fn<Transport>(() =>
      Promise.resolve(ok({ status: 302, headers: { location: 'https://' } })),
    );

    const outcome = await client({ transport }).send({
      method: 'GET',
      url: 'https://store.example.com/',
    });

    expect(outcome).toMatchObject({ ok: false, kind: 'blocked' });
  });

  it('lets the caller override the user agent and add headers', async () => {
    const transport = vi.fn<Transport>(() => Promise.resolve(ok()));

    const custom = createHttpClient({
      policy: PRODUCTION,
      resolve: () => Promise.resolve(['93.184.216.34']),
      transport,
      userAgent: 'eim/2',
    });

    await custom.send({
      method: 'GET',
      url: 'https://store.example.com/',
      headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' },
    });

    const sent = transport.mock.calls[0]?.[0].headers ?? {};

    expect(sent['user-agent']).toBe('eim/2');
    expect(sent['authorization']).toBe('Bearer x');
    expect(sent['content-type']).toBe('application/json');
  });
});
