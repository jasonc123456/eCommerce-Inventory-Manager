import { createSign, generateKeyPairSync } from 'node:crypto';

import type { HttpClient, HttpOutcome } from '@eim/providers';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  createPublicKeyReader,
  createSignatureVerifier,
  parseSignatureHeader,
  type PublicKeyReader,
} from './signature';

/**
 * Proving a notification came from eBay.
 *
 * The signing key here is a real one, generated for the test, and the
 * signatures are real ECDSA signatures over real bytes. A fake verifier would
 * prove that this file agrees with itself.
 */

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

function sign(body: string, key = privateKey, digest = 'sha1'): string {
  return createSign(digest).update(Buffer.from(body, 'utf8')).sign(key).toString('base64');
}

function header(fields: Readonly<Record<string, string>>): string {
  return Buffer.from(JSON.stringify(fields), 'utf8').toString('base64');
}

class FakeEbay {
  public requests: string[] = [];
  public answer: HttpOutcome = keyResponse(publicPem);

  reset(): void {
    this.requests = [];
    this.answer = keyResponse(publicPem);
  }

  readonly client: HttpClient = {
    send: (request) => {
      this.requests.push(request.url);

      return Promise.resolve(this.answer);
    },
  };
}

function keyResponse(key: string, algorithm = 'ECDSA', digest = 'SHA1', status = 200): HttpOutcome {
  return {
    ok: true,
    response: {
      status,
      headers: {},
      body: JSON.stringify({ key, algorithm, digest }),
      url: 'https://api.ebay.com/',
    },
  };
}

const ebay = new FakeEbay();

function reader(overrides: { cacheTtlMs?: number; maxCached?: number } = {}): PublicKeyReader {
  return createPublicKeyReader({
    http: ebay.client,
    environment: 'production',
    applicationToken: () => Promise.resolve('app-token'),
    ...overrides,
  });
}

beforeEach(() => {
  ebay.reset();
});

describe('parseSignatureHeader', () => {
  it('reads the base64 JSON eBay sends', () => {
    const parsed = parseSignatureHeader(
      header({ alg: 'ecdsa', kid: 'key-1', signature: 'c2ln', digest: 'SHA1' }),
    );

    expect(parsed).toMatchObject({ keyId: 'key-1', signature: 'c2ln', claimedAlgorithm: 'ecdsa' });
  });

  it('refuses anything that is not that shape', () => {
    for (const value of [
      'not base64 JSON at all',
      Buffer.from('[]', 'utf8').toString('base64'),
      Buffer.from('42', 'utf8').toString('base64'),
      Buffer.from('"a string"', 'utf8').toString('base64'),
      header({ kid: 'key-1' }),
      header({ signature: 'c2ln' }),
      header({ kid: '', signature: 'c2ln' }),
      header({ kid: 'key-1', signature: '' }),
    ]) {
      expect(parseSignatureHeader(value)).toBeNull();
    }
  });
});

describe('createSignatureVerifier', () => {
  const body = '{"notificationId":"n-1","topic":"MARKETPLACE_ACCOUNT_DELETION"}';

  it('verifies a genuine signature over the exact bytes', async () => {
    const verifier = createSignatureVerifier({ keys: reader() });

    await expect(
      verifier.verify({
        body,
        signatureHeader: header({ alg: 'ecdsa', kid: 'key-1', signature: sign(body) }),
      }),
    ).resolves.toEqual({ verified: true, keyId: 'key-1' });
  });

  it('refuses a body that was re-serialized rather than passed through', async () => {
    // The mistake this guards is parsing the request as JSON and stringifying it
    // again before verifying. It round-trips to something equivalent and not
    // identical, and every notification then fails for a reason nothing reports.
    const verifier = createSignatureVerifier({ keys: reader() });
    const reserialized = JSON.stringify(JSON.parse(body), null, 2);

    const outcome = await verifier.verify({
      body: reserialized,
      signatureHeader: header({ kid: 'key-1', signature: sign(body) }),
    });

    expect(outcome).toMatchObject({ verified: false, reason: 'mismatch' });
  });

  it('refuses a tampered body', async () => {
    const verifier = createSignatureVerifier({ keys: reader() });

    const outcome = await verifier.verify({
      body: body.replace('n-1', 'n-2'),
      signatureHeader: header({ kid: 'key-1', signature: sign(body) }),
    });

    expect(outcome).toMatchObject({ verified: false, reason: 'mismatch' });
  });

  it('refuses a signature made with a different key', async () => {
    const verifier = createSignatureVerifier({ keys: reader() });

    const outcome = await verifier.verify({
      body,
      signatureHeader: header({ kid: 'key-1', signature: sign(body, other.privateKey) }),
    });

    expect(outcome).toMatchObject({ verified: false, reason: 'mismatch' });
  });

  it('ignores the algorithm the sender claims and uses the one eBay published', async () => {
    // The header is written by whoever sent the request. A verifier that reads
    // its `alg` lets an attacker choose the algorithm, which is the whole of
    // signature confusion.
    const verifier = createSignatureVerifier({ keys: reader() });

    await expect(
      verifier.verify({
        body,
        signatureHeader: header({
          alg: 'none',
          digest: 'SHA512',
          kid: 'key-1',
          signature: sign(body),
        }),
      }),
    ).resolves.toEqual({ verified: true, keyId: 'key-1' });
  });

  it('refuses when eBay publishes an algorithm this application cannot verify', async () => {
    ebay.answer = keyResponse(publicPem, 'RSA', 'SHA1');
    const verifier = createSignatureVerifier({ keys: reader() });

    const outcome = await verifier.verify({
      body,
      signatureHeader: header({ kid: 'key-1', signature: sign(body) }),
    });

    expect(outcome).toMatchObject({ verified: false, reason: 'unsupported_algorithm' });
  });

  it('refuses when eBay publishes a digest this application cannot verify', async () => {
    ebay.answer = keyResponse(publicPem, 'ECDSA', 'MD5');
    const verifier = createSignatureVerifier({ keys: reader() });

    const outcome = await verifier.verify({
      body,
      signatureHeader: header({ kid: 'key-1', signature: sign(body) }),
    });

    expect(outcome).toMatchObject({ verified: false, reason: 'unsupported_algorithm' });
  });

  it('reports a missing header as missing rather than as a mismatch', async () => {
    const verifier = createSignatureVerifier({ keys: reader() });

    for (const value of [null, undefined, '']) {
      await expect(verifier.verify({ body, signatureHeader: value })).resolves.toEqual({
        verified: false,
        reason: 'missing_signature',
      });
    }
  });

  it('reports a malformed header without calling eBay', async () => {
    const verifier = createSignatureVerifier({ keys: reader() });

    const outcome = await verifier.verify({ body, signatureHeader: 'garbage' });

    expect(outcome).toEqual({ verified: false, reason: 'malformed_signature' });
    expect(ebay.requests).toHaveLength(0);
  });

  it('refuses a signature that is not valid DER instead of throwing', async () => {
    const verifier = createSignatureVerifier({ keys: reader() });

    const outcome = await verifier.verify({
      body,
      signatureHeader: header({
        kid: 'key-1',
        signature: Buffer.from('nonsense').toString('base64'),
      }),
    });

    expect(outcome).toMatchObject({ verified: false, reason: 'mismatch' });
  });

  it('refuses an empty signature as malformed', async () => {
    const verifier = createSignatureVerifier({ keys: reader() });

    const outcome = await verifier.verify({
      body,
      signatureHeader: header({ kid: 'key-1', signature: '!!!' }),
    });

    expect(outcome).toMatchObject({ verified: false, reason: 'malformed_signature' });
  });

  it('reports an unfetchable key as unavailable rather than as a forgery', async () => {
    ebay.answer = { ok: false, kind: 'timeout', reason: 'timed out' };
    const verifier = createSignatureVerifier({ keys: reader() });

    const outcome = await verifier.verify({
      body,
      signatureHeader: header({ kid: 'key-1', signature: sign(body) }),
    });

    // The distinction matters operationally: one is an outage to fix, the other
    // is an attack to investigate. Both refuse.
    expect(outcome).toMatchObject({ verified: false, reason: 'key_unavailable' });
  });
});

describe('createPublicKeyReader', () => {
  it('refuses a key identifier that could escape the URL path, without asking eBay', async () => {
    const keys = reader();

    for (const keyId of ['../../secrets', 'key/1', 'key 1', 'key?x=1', '', 'k'.repeat(129)]) {
      await expect(keys.read(keyId)).resolves.toBeNull();
    }

    expect(ebay.requests).toHaveLength(0);
  });

  it('fetches a key once and serves the rest from cache', async () => {
    const keys = reader();

    await keys.read('key-1');
    await keys.read('key-1');
    await keys.read('key-1');

    expect(ebay.requests).toHaveLength(1);
  });

  it('fetches again once the cached key is older than the window', async () => {
    const keys = reader({ cacheTtlMs: 60_000 });
    const start = new Date('2026-03-01T00:00:00Z');

    await keys.read('key-1', start);
    await keys.read('key-1', new Date(start.getTime() + 59_000));
    expect(ebay.requests).toHaveLength(1);

    await keys.read('key-1', new Date(start.getTime() + 61_000));
    expect(ebay.requests).toHaveLength(2);
  });

  it('does not cache a failure', async () => {
    // A cached failure is a working key that stays unusable for hours after the
    // outage that caused it has passed.
    const keys = reader();

    ebay.answer = { ok: false, kind: 'transport', reason: 'ECONNREFUSED' };
    await expect(keys.read('key-1')).resolves.toBeNull();

    ebay.answer = keyResponse(publicPem);
    await expect(keys.read('key-1')).resolves.not.toBeNull();
    expect(ebay.requests).toHaveLength(2);
  });

  it('bounds the cache, because the identifier comes from the request', async () => {
    const keys = reader({ maxCached: 2 });

    await keys.read('key-1');
    await keys.read('key-2');
    await keys.read('key-3');
    // key-1 was evicted, so asking again costs another fetch.
    await keys.read('key-1');

    expect(ebay.requests).toHaveLength(4);
  });

  it('accepts key material with or without PEM armour', async () => {
    const bare = publicPem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');

    ebay.answer = keyResponse(bare);

    await expect(reader().read('key-1')).resolves.not.toBeNull();
  });

  it('refuses an answer that is not a key', async () => {
    for (const answer of [
      keyResponse(publicPem, 'ECDSA', 'SHA1', 404),
      keyResponse('not a key at all'),
      { ok: true, response: { status: 200, headers: {}, body: 'html', url: 'x' } } as HttpOutcome,
      {
        ok: true,
        response: { status: 200, headers: {}, body: JSON.stringify([]), url: 'x' },
      } as HttpOutcome,
      {
        ok: true,
        response: { status: 200, headers: {}, body: JSON.stringify({ key: '' }), url: 'x' },
      } as HttpOutcome,
    ]) {
      ebay.answer = answer;
      await expect(reader().read('key-1')).resolves.toBeNull();
    }
  });

  it('does not call eBay without an application token', async () => {
    const keys = createPublicKeyReader({
      http: ebay.client,
      environment: 'production',
      applicationToken: () => Promise.resolve(null),
    });

    await expect(keys.read('key-1')).resolves.toBeNull();
    expect(ebay.requests).toHaveLength(0);
  });

  it('asks the environment it was built for', async () => {
    const keys = createPublicKeyReader({
      http: ebay.client,
      environment: 'sandbox',
      applicationToken: () => Promise.resolve('app-token'),
    });

    await keys.read('key-1');

    expect(ebay.requests[0]).toBe(
      'https://api.sandbox.ebay.com/commerce/notification/v1/public_key/key-1',
    );
  });
});
