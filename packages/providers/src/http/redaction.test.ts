import { describe, expect, it } from 'vitest';

import { redactHeaders, redactUrl, summarizeBody } from './redaction';

/**
 * What may be written down (section 19).
 *
 * The failing cases here are the ones that only happen when something breaks,
 * which is when logging is turned up and the output is read by whoever is
 * awake.
 */

describe('redactHeaders', () => {
  it('removes the obvious credentials', () => {
    const redacted = redactHeaders({
      Authorization: 'Bearer v^1.1#i^1#abcdef',
      Cookie: 'session=abc',
      'X-Api-Key': 'k',
      'X-Webhook-Signature': 'sig',
    });

    expect(Object.values(redacted).every((value) => value === '[redacted]')).toBe(true);
  });

  it('keeps what an operator needs to diagnose the failure', () => {
    const redacted = redactHeaders({
      'Retry-After': '120',
      'X-EBAY-C-Request-Id': 'req-1',
      'Content-Type': 'application/json',
    });

    expect(redacted['retry-after']).toBe('120');
    expect(redacted['x-ebay-c-request-id']).toBe('req-1');
    expect(redacted['content-type']).toBe('application/json');
  });

  it('redacts an unfamiliar credential-shaped header rather than keeping it', () => {
    // Fails closed: a header nobody has thought about yet is redacted on the
    // strength of its name, not kept for not being on a list.
    expect(redactHeaders({ 'X-Store-Secret-Token': 'value' })['x-store-secret-token']).toBe(
      '[redacted]',
    );
  });
});

describe('redactUrl', () => {
  it('keeps the endpoint and removes the credentials', () => {
    const redacted = redactUrl(
      'https://store.example.com/wc-auth/v1/authorize?code=abc123&page=2&consumer_key=ck_live',
    );

    expect(redacted).toContain('/wc-auth/v1/authorize');
    expect(redacted).toContain('page=2');
    expect(redacted).not.toContain('abc123');
    expect(redacted).not.toContain('ck_live');
  });

  it('shows that a parameter was present rather than dropping it', () => {
    // "There was a code and it was wrong" and "there was no code" are different
    // bugs, and a redaction that deletes the parameter makes them look alike.
    expect(redactUrl('https://x.example.com/cb?code=abc')).toContain('code=%5Bredacted%5D');
  });

  it('strips embedded credentials', () => {
    expect(redactUrl('https://key:secret@store.example.com/x')).not.toContain('secret');
  });

  it('says so plainly when it cannot parse the URL', () => {
    expect(redactUrl('not a url')).toBe('[unparseable url]');
  });
});

describe('summarizeBody', () => {
  it('keeps a short error message intact', () => {
    expect(summarizeBody('{"errors":[{"message":"Category not found"}]}')).toContain(
      'Category not found',
    );
  });

  it('removes a token the provider echoed back at us', () => {
    const body = '{"error":"invalid_grant","access_token":"v^1.1#i^1#f^0#r^1#I^3#p^3#t^Ul41Xzk6"}';

    expect(summarizeBody(body)).not.toContain('Ul41Xzk6');
  });

  it('removes a long opaque credential wherever it appears', () => {
    const token = 'A'.repeat(64);

    expect(summarizeBody(`failed for ${token}`)).not.toContain(token);
  });

  it('bounds the length, because a provider will happily return a megabyte', () => {
    expect(summarizeBody('x '.repeat(5000)).length).toBeLessThanOrEqual(241);
  });

  it('collapses whitespace so one line of log stays one line', () => {
    expect(summarizeBody('a\n\n  b\t c')).toBe('a b c');
  });
});
