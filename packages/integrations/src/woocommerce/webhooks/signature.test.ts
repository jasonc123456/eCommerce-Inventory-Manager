import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { decodeSignature, signWebhookBody, verifyWebhookSignature } from './signature';

/**
 * Proving a delivery came from the store.
 *
 * The signatures here are real HMAC-SHA256 over real bytes. A fake verifier
 * would prove that this file agrees with itself.
 */

const BODY = '{"id":42,"name":"Blue widget","stock_quantity":7}';
const SECRET = 'a-webhook-secret';

function secretsFor(...entries: [string, string][]) {
  return entries.map(([webhookId, secret]) => ({ webhookId, secret }));
}

describe('verifyWebhookSignature', () => {
  it('verifies a genuine signature over the exact bytes', () => {
    expect(
      verifyWebhookSignature({
        body: BODY,
        signatureHeader: signWebhookBody(BODY, SECRET),
        secrets: secretsFor(['hook-1', SECRET]),
      }),
    ).toEqual({ verified: true, webhookId: 'hook-1' });
  });

  it('identifies which registration signed it, out of several live secrets', () => {
    // This is the property that makes rotation safe. The registration is
    // discovered by verification rather than claimed by a header, so a sender
    // cannot choose which key they are checked against.
    expect(
      verifyWebhookSignature({
        body: BODY,
        signatureHeader: signWebhookBody(BODY, 'second-secret'),
        secrets: secretsFor(['hook-old', SECRET], ['hook-new', 'second-secret']),
      }),
    ).toEqual({ verified: true, webhookId: 'hook-new' });
  });

  it('refuses a body that was re-serialized rather than passed through', () => {
    // The mistake this guards is reading the request as JSON and stringifying it
    // again before verifying. It round-trips to something equivalent and not
    // identical, and every delivery then fails for a reason nothing reports.
    const reserialized = JSON.stringify(JSON.parse(BODY), null, 2);

    expect(
      verifyWebhookSignature({
        body: reserialized,
        signatureHeader: signWebhookBody(BODY, SECRET),
        secrets: secretsFor(['hook-1', SECRET]),
      }),
    ).toMatchObject({ verified: false, reason: 'mismatch' });
  });

  it('refuses a tampered body', () => {
    expect(
      verifyWebhookSignature({
        body: BODY.replace('"stock_quantity":7', '"stock_quantity":700'),
        signatureHeader: signWebhookBody(BODY, SECRET),
        secrets: secretsFor(['hook-1', SECRET]),
      }),
    ).toMatchObject({ verified: false, reason: 'mismatch' });
  });

  it('refuses a signature made with a secret that is no longer live', () => {
    expect(
      verifyWebhookSignature({
        body: BODY,
        signatureHeader: signWebhookBody(BODY, 'retired-secret'),
        secrets: secretsFor(['hook-1', SECRET]),
      }),
    ).toMatchObject({ verified: false, reason: 'mismatch' });
  });

  it('reports a missing header as missing rather than as a mismatch', () => {
    for (const header of [null, undefined, '']) {
      expect(
        verifyWebhookSignature({
          body: BODY,
          signatureHeader: header,
          secrets: secretsFor(['h', 's']),
        }),
      ).toEqual({ verified: false, reason: 'missing_signature' });
    }
  });

  it('refuses a header that is not a 32-byte base64 digest', () => {
    // Node's base64 decoder skips characters it does not recognize rather than
    // failing, so `"not a signature!!"` decodes to something. The length check
    // is what turns that into a refusal — and what makes the constant-time
    // comparison safe to call, since it throws on a length mismatch.
    for (const header of [
      'not a signature!!',
      'garbage',
      Buffer.from('too short', 'utf8').toString('base64'),
      Buffer.alloc(31).toString('base64'),
      Buffer.alloc(33).toString('base64'),
      '===',
    ]) {
      expect(
        verifyWebhookSignature({
          body: BODY,
          signatureHeader: header,
          secrets: secretsFor(['h', SECRET]),
        }),
      ).toMatchObject({ verified: false, reason: 'malformed_signature' });
    }
  });

  it('distinguishes having no secret from having the wrong one', () => {
    // One is a registration this application has lost track of; the other is a
    // body that is not what it claims to be. They need different responses.
    expect(
      verifyWebhookSignature({
        body: BODY,
        signatureHeader: signWebhookBody(BODY, SECRET),
        secrets: [],
      }),
    ).toEqual({ verified: false, reason: 'no_secrets' });
  });

  it('tolerates surrounding whitespace, which proxies add', () => {
    expect(
      verifyWebhookSignature({
        body: BODY,
        signatureHeader: `  ${signWebhookBody(BODY, SECRET)}  `,
        secrets: secretsFor(['hook-1', SECRET]),
      }),
    ).toMatchObject({ verified: true });
  });

  it('signs the way WooCommerce does', () => {
    // Pinned against the algorithm rather than against a recorded string, so the
    // assertion says what the format is instead of what it happened to be.
    expect(signWebhookBody(BODY, SECRET)).toBe(
      createHmac('sha256', SECRET).update(Buffer.from(BODY, 'utf8')).digest('base64'),
    );
  });
});

describe('decodeSignature', () => {
  it('accepts exactly a 32-byte digest', () => {
    expect(decodeSignature(Buffer.alloc(32, 1).toString('base64'))?.length).toBe(32);
  });

  it('refuses anything else', () => {
    expect(decodeSignature('')).toBeNull();
    expect(decodeSignature('AAAA')).toBeNull();
    expect(decodeSignature('a-b_c')).toBeNull();
  });
});
