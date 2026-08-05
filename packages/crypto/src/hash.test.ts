import { describe, expect, it } from 'vitest';

import { constantTimeEqual, createHasher, type HashDomain } from './hash';

const SECRET = 'a'.repeat(48);
const OTHER_SECRET = 'b'.repeat(48);

describe('createHasher', () => {
  it('rejects a secret too short to be worth keying with', () => {
    expect(() => createHasher('short')).toThrow(/at least 32 characters/);
  });

  it('is deterministic for the same secret, domain, value, and binding', () => {
    const first = createHasher(SECRET).hash('session', 'token', 'session-1');
    const second = createHasher(SECRET).hash('session', 'token', 'session-1');

    expect(first).toBe(second);
  });

  it('produces a hex digest that does not contain the value', () => {
    const digest = createHasher(SECRET).hash('magic_link', 'the-raw-token');

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain('the-raw-token');
  });

  it('separates domains, so a value valid for one purpose is not valid for another', () => {
    const hasher = createHasher(SECRET);
    const domains: readonly HashDomain[] = [
      'session',
      'browser_binding',
      'pending_authentication',
      'magic_link',
      'email_code',
      'recovery_code',
      'trusted_device',
      'passkey_challenge',
      'setup_secret',
      'invitation',
      'email_fingerprint',
    ];

    const digests = domains.map((domain) => hasher.hash(domain, 'same-value'));

    expect(new Set(digests).size).toBe(domains.length);
  });

  it('separates bindings, so the same code under two challenges hashes differently', () => {
    // Two live challenges that happen to generate the same eight digits must
    // not store the same hash: a database reader would otherwise learn that
    // they matched, and a code seen once could be replayed elsewhere.
    const hasher = createHasher(SECRET);

    expect(hasher.hash('email_code', '00481502', 'challenge-a')).not.toBe(
      hasher.hash('email_code', '00481502', 'challenge-b'),
    );
  });

  it('distinguishes a binding and value that would concatenate identically', () => {
    const hasher = createHasher(SECRET);

    expect(hasher.hash('session', 'bc', 'a')).not.toBe(hasher.hash('session', 'c', 'ab'));
  });

  it('depends on the installation secret, so a stolen database alone cannot test guesses', () => {
    expect(createHasher(SECRET).hash('email_code', '00000001')).not.toBe(
      createHasher(OTHER_SECRET).hash('email_code', '00000001'),
    );
  });
});

describe('verify', () => {
  const hasher = createHasher(SECRET);

  it('accepts the value that produced the stored hash', () => {
    const stored = hasher.hash('recovery_code', 'CODE', 'user-1');

    expect(hasher.verify('recovery_code', 'CODE', stored, 'user-1')).toBe(true);
  });

  it('rejects a different value, domain, or binding', () => {
    const stored = hasher.hash('recovery_code', 'CODE', 'user-1');

    expect(hasher.verify('recovery_code', 'OTHER', stored, 'user-1')).toBe(false);
    expect(hasher.verify('trusted_device', 'CODE', stored, 'user-1')).toBe(false);
    expect(hasher.verify('recovery_code', 'CODE', stored, 'user-2')).toBe(false);
  });

  it('rejects an empty or malformed stored hash rather than accepting it', () => {
    expect(hasher.verify('session', 'token', '')).toBe(false);
    expect(hasher.verify('session', 'token', 'not-a-hash')).toBe(false);
  });
});

describe('constantTimeEqual', () => {
  it('is true for identical strings and false otherwise', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
  });

  it('handles different lengths without throwing, unlike timingSafeEqual', () => {
    expect(constantTimeEqual('', 'a')).toBe(false);
    expect(constantTimeEqual('a'.repeat(1000), 'a')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });
});
