import { describe, expect, it } from 'vitest';

import { describeStore, sameOrigin } from './store';

/**
 * Deciding what store an address names.
 *
 * The property under test is that everything a person might reasonably type for
 * one store produces one answer. Anything less and a business ends up with two
 * connections to the same shop, both importing the same orders, and later both
 * writing the same stock — which is not a display problem.
 */

const OPEN = { allowPrivate: false, allowInsecure: false, allowlist: [] };
const DEVELOPMENT = { allowPrivate: true, allowInsecure: true, allowlist: [] };

function store(input: string, policy = OPEN) {
  const verdict = describeStore(input, policy);

  if (!verdict.ok) {
    throw new Error(`expected a store, got: ${verdict.reason}`);
  }

  return verdict.store;
}

describe('describeStore', () => {
  it('derives the REST and authorization routes', () => {
    expect(store('https://shop.example')).toEqual({
      base: 'https://shop.example',
      origin: 'https://shop.example',
      restBase: 'https://shop.example/wp-json/wc/v3',
      authorizeUrl: 'https://shop.example/wc-auth/v1/authorize',
      environment: 'production',
    });
  });

  it('keeps a subdirectory install under its own path', () => {
    // `https://example.com/shop` is an ordinary WordPress install in a
    // subdirectory. Discarding the path would aim every request at the parent
    // site, which is a different site.
    expect(store('https://example.com/shop/').restBase).toBe(
      'https://example.com/shop/wp-json/wc/v3',
    );
  });

  it('gives one answer for every spelling of the same store', () => {
    const spellings = [
      'https://shop.example',
      'https://shop.example/',
      'HTTPS://Shop.Example/',
      'https://shop.example.',
      'https://shop.example:443',
      'https://shop.example/?utm_source=newsletter',
      'https://shop.example/#top',
      '  https://shop.example//  ',
      // What somebody who has read the API documentation pastes.
      'https://shop.example/wp-json',
      'https://shop.example/wp-json/wc/v3',
      'https://shop.example/wp-json/wc/v2/',
      'https://shop.example/wc-auth/v1/authorize',
    ];

    const bases = new Set(spellings.map((spelling) => store(spelling).base));

    expect([...bases]).toEqual(['https://shop.example']);
  });

  it('strips the API suffix from a subdirectory install too', () => {
    expect(store('https://example.com/shop/wp-json/wc/v3').base).toBe('https://example.com/shop');
  });

  it('does not mistake a path that merely contains the suffix for the suffix', () => {
    expect(store('https://example.com/wp-json/wc/v3/archive').base).toBe(
      'https://example.com/wp-json/wc/v3/archive',
    );
  });

  it('records a plain-HTTP store as a development store', () => {
    // The environment is derived rather than chosen, so a developer's fixture
    // catalog cannot end up in the same bucket as a live shop's.
    expect(store('http://shop.localhost.test', DEVELOPMENT).environment).toBe('sandbox');
    expect(store('https://shop.example').environment).toBe('production');
  });

  it('refuses what the installation may not reach', () => {
    for (const input of [
      '',
      'not a url',
      'ftp://shop.example',
      'http://shop.example',
      'https://user:secret@shop.example',
      'https://169.254.169.254',
      'https://metadata.google.internal',
      'https://localhost',
    ]) {
      expect(describeStore(input, OPEN).ok).toBe(false);
    }
  });

  it('refuses credentials in the address even where private hosts are allowed', () => {
    // They would be stored on the connection, logged, and quoted back in any
    // error naming the destination. Section 14 authenticates with a header.
    expect(describeStore('https://ck_x:cs_y@shop.example', DEVELOPMENT).ok).toBe(false);
  });
});

describe('sameOrigin', () => {
  it('compares origins, not spellings', () => {
    expect(sameOrigin('https://shop.example', 'https://Shop.Example/')).toBe(true);
    expect(sameOrigin('https://shop.example', 'https://shop.example:443/wp-admin')).toBe(true);
  });

  it('refuses a different host, scheme, port, or nothing at all', () => {
    expect(sameOrigin('https://shop.example', 'https://other.example')).toBe(false);
    expect(sameOrigin('https://shop.example', 'http://shop.example')).toBe(false);
    expect(sameOrigin('https://shop.example', 'https://shop.example:8443')).toBe(false);
    expect(sameOrigin('https://shop.example', 'shop.example')).toBe(false);
    expect(sameOrigin('https://shop.example', '')).toBe(false);
    expect(sameOrigin('https://shop.example', null)).toBe(false);
    expect(sameOrigin('https://shop.example', undefined)).toBe(false);
  });
});
