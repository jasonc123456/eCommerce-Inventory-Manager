import { describe, expect, it } from 'vitest';

import { callbackUrl, capabilitiesFor, readPermissions, storeFromCallback } from './connection';

/**
 * The pure parts of connecting a store.
 *
 * All three decide something a caller then acts on: which store a callback was
 * issued for, and what a key is allowed to do. Getting either wrong is silent —
 * the connection works, and does the wrong thing.
 */

describe('callbackUrl and storeFromCallback', () => {
  it('round-trips the store the callback was issued for', () => {
    const url = callbackUrl('https://inventory.example.invalid', 'https://shop.example');

    expect(
      url.startsWith('https://inventory.example.invalid/api/connections/woocommerce/callback/'),
    ).toBe(true);
    expect(storeFromCallback(url.split('/').at(-1) ?? '')).toBe('https://shop.example');
  });

  it('produces a path segment a proxy will not rewrite', () => {
    // A percent-encoded `://` inside a path segment is the kind of thing a
    // reverse proxy normalizes on the way past, which would corrupt the value
    // before it was compared against anything.
    const segment = callbackUrl('https://x.invalid', 'https://shop.example:8443').split('/').at(-1);

    expect(segment).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(storeFromCallback(segment ?? '')).toBe('https://shop.example:8443');
  });

  it('refuses a segment that does not decode to an origin', () => {
    for (const segment of [
      '',
      'not base64!',
      '../../etc',
      Buffer.from('https://shop.example/wp-admin', 'utf8').toString('base64url'),
      Buffer.from('shop.example', 'utf8').toString('base64url'),
      Buffer.from('', 'utf8').toString('base64url'),
      'a'.repeat(513),
    ]) {
      expect(storeFromCallback(segment)).toBeNull();
    }
  });
});

describe('capabilitiesFor', () => {
  it('gives a read key the imports and nothing else', () => {
    const { available, impaired } = capabilitiesFor('read');

    expect(available).toEqual(['import_catalog', 'import_orders', 'import_refunds']);
    expect(impaired).toContain('write_quantities');
    expect(impaired).toContain('manage_webhooks');
  });

  it('gives a read_write key everything', () => {
    expect(capabilitiesFor('read_write').impaired).toEqual([]);
  });

  it('gives a write-only key nothing', () => {
    // WooCommerce really does issue these, and nothing this application does is
    // useful without reading first.
    expect(capabilitiesFor('write').available).toEqual([]);
  });
});

describe('readPermissions', () => {
  it('reads the values WooCommerce sends', () => {
    expect(readPermissions('read_write')).toBe('read_write');
    expect(readPermissions('write')).toBe('write');
    expect(readPermissions('read')).toBe('read');
  });

  it('treats anything else as read-only', () => {
    // Treating an unfamiliar value as full access offers write capabilities on
    // the strength of a string nobody has seen before.
    for (const value of ['', 'READ_WRITE', 'admin', 'superuser', null, undefined]) {
      expect(readPermissions(value)).toBe('read');
    }
  });
});
