import { describe, expect, it } from 'vitest';

import { canonicalize, originOf, validateIntegrationUrl } from './url-policy';

/**
 * The URL a person typed.
 *
 * Section 19 validates it before storage and again before every connection, and
 * the cases below are the ones where those two checks catch different things.
 */

const PRODUCTION = { allowPrivate: false, allowlist: [], allowInsecure: false };
const DEVELOPMENT = { allowPrivate: true, allowlist: [], allowInsecure: true };

describe('validateIntegrationUrl', () => {
  it('accepts an ordinary store URL', () => {
    const verdict = validateIntegrationUrl('https://store.example.com/wp-json/', PRODUCTION);

    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.url.toString()).toBe('https://store.example.com/wp-json');
  });

  it('requires HTTPS in a normal installation', () => {
    const verdict = validateIntegrationUrl('http://store.example.com', PRODUCTION);

    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toContain('HTTPS');
  });

  it('allows plain HTTP once the installation opts in', () => {
    expect(validateIntegrationUrl('http://store.example.com', DEVELOPMENT).ok).toBe(true);
  });

  it('refuses schemes that are not HTTP at all', () => {
    for (const value of [
      'file:///etc/passwd',
      'gopher://store.example.com',
      'ftp://store.example.com',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
    ]) {
      expect(validateIntegrationUrl(value, DEVELOPMENT).ok).toBe(false);
    }
  });

  it('judges the parsed host, not the text that was typed', () => {
    // `https:/\store.example.com` normalizes to `https://store.example.com/`,
    // and the parsed host is what a socket would be opened to. Refusing it for
    // looking odd would refuse a request that is genuinely to the right place;
    // the check that matters is on the result of parsing, which is what runs.
    const verdict = validateIntegrationUrl('https:/\\store.example.com', PRODUCTION);

    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.url.hostname).toBe('store.example.com');

    // And the same normalization cannot smuggle a private host past the check.
    expect(validateIntegrationUrl('https:/\\127.0.0.1', PRODUCTION).ok).toBe(false);
  });

  it('refuses credentials embedded in the URL', () => {
    // They would be stored on the connection, logged, and quoted in errors.
    const verdict = validateIntegrationUrl('https://key:secret@store.example.com', PRODUCTION);

    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toContain('credentials');
  });

  it('refuses a literal private address before any DNS is involved', () => {
    for (const value of [
      'https://127.0.0.1/wp-json',
      'https://10.0.0.5/wp-json',
      'https://[::1]/wp-json',
      'https://[::ffff:127.0.0.1]/wp-json',
    ]) {
      expect(validateIntegrationUrl(value, PRODUCTION).ok).toBe(false);
    }
  });

  it('refuses the metadata service by address and by name', () => {
    for (const value of [
      'https://169.254.169.254/latest/meta-data/',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://metadata/computeMetadata/v1/',
    ]) {
      // Even in the most permissive installation there is.
      expect(validateIntegrationUrl(value, DEVELOPMENT).ok).toBe(false);
    }
  });

  it('refuses a single-label host, which only resolves internally', () => {
    for (const value of ['https://postgres/wp-json', 'https://localhost/wp-json']) {
      expect(validateIntegrationUrl(value, PRODUCTION).ok).toBe(false);
    }
  });

  it('restricts ports, and widens the set for a private installation', () => {
    expect(validateIntegrationUrl('https://store.example.com:8443/', PRODUCTION).ok).toBe(false);
    expect(validateIntegrationUrl('https://store.example.com:22/', PRODUCTION).ok).toBe(false);
    expect(validateIntegrationUrl('https://store.example.com:443/', PRODUCTION).ok).toBe(true);

    expect(validateIntegrationUrl('http://store.example.com:8080/', DEVELOPMENT).ok).toBe(true);
    // Still not the database, even in development.
    expect(validateIntegrationUrl('http://store.example.com:5432/', DEVELOPMENT).ok).toBe(false);
  });

  it('refuses an empty or unparseable address', () => {
    for (const value of ['', '   ', 'store.example.com', 'https://']) {
      expect(validateIntegrationUrl(value, PRODUCTION).ok).toBe(false);
    }
  });
});

describe('canonicalize', () => {
  it('reduces the spellings of one store to one URL', () => {
    // Two connections to one shop would each import the same orders.
    const spellings = [
      'https://Store.Example.com/wp-json/',
      'https://store.example.com./wp-json',
      'https://store.example.com:443/wp-json/?utm=1#top',
    ];

    const canonical = spellings.map((value) => canonicalize(new URL(value)).toString());

    expect(new Set(canonical).size).toBe(1);
    expect(canonical[0]).toBe('https://store.example.com/wp-json');
  });

  it('keeps a non-default port, because that is a different destination', () => {
    expect(canonicalize(new URL('https://store.example.com:8443/x')).toString()).toBe(
      'https://store.example.com:8443/x',
    );
  });
});

describe('originOf', () => {
  it('reduces a store URL to the identity a connection is keyed by', () => {
    expect(originOf(new URL('https://Store.Example.com/wp-json/wc/v3/products?page=2'))).toBe(
      'https://store.example.com',
    );
  });
});
