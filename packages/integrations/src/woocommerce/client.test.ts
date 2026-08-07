import type { HttpClient, HttpOutcome, HttpRequest } from '@eim/providers';
import { describe, expect, it } from 'vitest';

import {
  classifyStatus,
  createWooClient,
  headerValue,
  nextPageLink,
  parseJsonArray,
  parseJsonObject,
  totalPages,
} from './client';

/**
 * Talking to a store.
 *
 * Two things are worth asserting here and the rest is plumbing: that a
 * credential never reaches a URL, and that pagination stops when the store says
 * it has stopped. The first is section 14's prohibition; the second is the
 * difference between an import that finishes and one that loops.
 */

class Recorder {
  public requests: HttpRequest[] = [];
  public answer: HttpOutcome = ok(200, '[]');

  readonly client: HttpClient = {
    send: (request) => {
      this.requests.push(request);

      return Promise.resolve(this.answer);
    },
  };
}

function ok(status: number, body: string, headers: Record<string, string> = {}): HttpOutcome {
  return { ok: true, response: { status, headers, body, url: 'https://shop.example/' } };
}

function clientOn(recorder: Recorder) {
  return createWooClient({
    http: recorder.client,
    restBase: 'https://shop.example/wp-json/wc/v3',
    credentials: { consumerKey: 'ck_key', consumerSecret: 'cs_secret' },
  });
}

describe('createWooClient', () => {
  it('sends the credential in the Authorization header and never in the URL', async () => {
    const recorder = new Recorder();

    await clientOn(recorder).get('/products?per_page=1');

    const request = recorder.requests[0];

    expect(request?.url).toBe('https://shop.example/wp-json/wc/v3/products?per_page=1');
    expect(request?.url).not.toContain('ck_key');
    expect(request?.url).not.toContain('cs_secret');
    expect(request?.headers?.['authorization']).toBe(
      `Basic ${Buffer.from('ck_key:cs_secret', 'utf8').toString('base64')}`,
    );
  });

  it('joins a path that was written without its leading slash', async () => {
    const recorder = new Recorder();

    await clientOn(recorder).get('products');

    expect(recorder.requests[0]?.url).toBe('https://shop.example/wp-json/wc/v3/products');
  });

  it('sends a body only when there is one', async () => {
    const recorder = new Recorder();
    const client = clientOn(recorder);

    await client.send('DELETE', '/webhooks/1');
    await client.send('POST', '/webhooks', { topic: 'product.updated' });

    expect(recorder.requests[0]?.body).toBeUndefined();
    expect(recorder.requests[0]?.headers?.['content-type']).toBeUndefined();
    expect(recorder.requests[1]?.body).toBe('{"topic":"product.updated"}');
    expect(recorder.requests[1]?.headers?.['content-type']).toBe('application/json');
  });

  it('reports a refused destination as one that must not be retried', async () => {
    const recorder = new Recorder();

    recorder.answer = { ok: false, kind: 'blocked', reason: 'private address' };

    await expect(clientOn(recorder).get('/products')).resolves.toEqual({
      ok: false,
      reason: 'blocked',
      retryable: false,
    });
  });

  it('reports a transport failure as retryable', async () => {
    const recorder = new Recorder();

    recorder.answer = { ok: false, kind: 'timeout', reason: 'timed out' };

    await expect(clientOn(recorder).get('/products')).resolves.toMatchObject({
      ok: false,
      retryable: true,
    });
  });
});

describe('classifyStatus', () => {
  it('never retries a rejected key', () => {
    // Repeating a rejected key on a schedule is how a store's security plugin
    // decides this application is an attacker.
    expect(classifyStatus(401)).toMatchObject({ ok: false, retryable: false });
    expect(classifyStatus(403)).toMatchObject({ ok: false, retryable: false });
  });

  it('retries throttling and server faults, and nothing else', () => {
    expect(classifyStatus(429)).toMatchObject({ retryable: true });
    expect(classifyStatus(503)).toMatchObject({ retryable: true });
    expect(classifyStatus(400)).toMatchObject({ retryable: false });
    expect(classifyStatus(404)).toMatchObject({ retryable: false });
  });

  it('accepts the whole success range', () => {
    expect(classifyStatus(200).ok).toBe(true);
    expect(classifyStatus(201).ok).toBe(true);
    expect(classifyStatus(299).ok).toBe(true);
    expect(classifyStatus(300).ok).toBe(false);
  });
});

describe('nextPageLink', () => {
  it('reads the next link the store offered', () => {
    expect(
      nextPageLink({
        link: '<https://shop.example/wp-json/wc/v3/products?page=2>; rel="next"',
      }),
    ).toBe('https://shop.example/wp-json/wc/v3/products?page=2');
  });

  it('picks next out of several relations, in any casing', () => {
    expect(
      nextPageLink({
        Link: '<https://a.example/?page=1>; rel="prev", <https://a.example/?page=3>; rel="next"',
      }),
    ).toBe('https://a.example/?page=3');
  });

  it('is not fooled by a comma inside the URI', () => {
    // `?include=1,2,3` is an ordinary WooCommerce collection URL. Splitting on
    // every comma tears one link into fragments with no `rel` on any of them,
    // which reads exactly like a store that offered no next page.
    expect(
      nextPageLink({
        link: '<https://a.example/?include=1,2,3&page=2>; rel="next"',
      }),
    ).toBe('https://a.example/?include=1,2,3&page=2');
  });

  it('returns nothing when the store said this was the last page', () => {
    expect(nextPageLink({})).toBeNull();
    expect(nextPageLink({ link: '' })).toBeNull();
    expect(nextPageLink({ link: '<https://a.example/?page=1>; rel="prev"' })).toBeNull();
    expect(nextPageLink({ link: 'garbage' })).toBeNull();
    expect(nextPageLink({ link: '<>; rel="next"' })).toBeNull();
  });
});

describe('totalPages', () => {
  it('reads the counter when there is one', () => {
    expect(totalPages({ 'x-wp-totalpages': '7' })).toBe(7);
    expect(totalPages({ 'X-WP-TotalPages': '0' })).toBe(0);
  });

  it('reports nothing rather than a guess', () => {
    expect(totalPages({})).toBeNull();
    expect(totalPages({ 'x-wp-totalpages': '' })).toBeNull();
    expect(totalPages({ 'x-wp-totalpages': 'many' })).toBeNull();
    expect(totalPages({ 'x-wp-totalpages': '-2' })).toBeNull();
  });
});

describe('reading a store answer', () => {
  it('refuses a body that parses as JSON and is not an object', () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });

    for (const body of ['', 'not json', '<html>', '[]', 'null', '42', '"text"']) {
      expect(parseJsonObject(body)).toBeNull();
    }
  });

  it('reads a collection and drops entries that are not records', () => {
    expect(parseJsonArray('[{"id":1},"text",null,7,[]]')).toEqual([{ id: 1 }]);
    expect(parseJsonArray('{"id":1}')).toEqual([]);
    expect(parseJsonArray('nonsense')).toEqual([]);
  });

  it('finds a header whatever case it arrived in', () => {
    expect(headerValue({ 'X-WP-Total': '12' }, 'x-wp-total')).toBe('12');
    expect(headerValue({ 'x-wp-total': '' }, 'x-wp-total')).toBeNull();
    expect(headerValue({}, 'x-wp-total')).toBeNull();
  });
});
