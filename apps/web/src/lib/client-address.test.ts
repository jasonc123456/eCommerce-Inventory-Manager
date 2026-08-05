import { describe, expect, it } from 'vitest';

import { isWithin, normalizeAddress, resolveClientAddress } from './client-address';

/**
 * Deciding who is asking.
 *
 * Both failure directions are real. Trust nothing and every rate limit applies
 * to the reverse proxy rather than the caller, so one attacker exhausts
 * everybody's budget. Trust everything and a caller sets `X-Forwarded-For` to
 * whatever they like and gets a fresh budget per request.
 */

const PROXIES = ['192.168.0.8/32', '10.0.0.0/8'];

const headers = (forwardedFor?: string): Headers =>
  new Headers(forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor });

describe('resolveClientAddress', () => {
  it('ignores the header entirely when nothing is configured as a proxy', () => {
    // Correct for a deployment that nothing proxies: the header is then
    // attacker-supplied with no infrastructure vouching for any of it.
    expect(resolveClientAddress(headers('203.0.113.4'), [])).toEqual({
      address: null,
      forwarded: false,
    });
  });

  it('takes the caller address that a trusted proxy appended', () => {
    expect(resolveClientAddress(headers('203.0.113.4, 192.168.0.8'), PROXIES)).toEqual({
      address: '203.0.113.4',
      forwarded: true,
    });
  });

  it('walks back through several trusted hops', () => {
    expect(
      resolveClientAddress(headers('203.0.113.4, 10.1.2.3, 192.168.0.8'), PROXIES).address,
    ).toBe('203.0.113.4');
  });

  it('stops at the first untrusted hop, whatever is to the left of it', () => {
    // The attacker prepends their own chain. Everything left of the first
    // address our own infrastructure did not add is unverifiable, and the
    // rightmost untrusted entry is the furthest we can actually vouch for.
    const spoofed = headers('1.1.1.1, 2.2.2.2, 203.0.113.4, 192.168.0.8');

    expect(resolveClientAddress(spoofed, PROXIES).address).toBe('203.0.113.4');
  });

  it('reports nothing when every hop is our own infrastructure', () => {
    expect(resolveClientAddress(headers('10.1.2.3, 192.168.0.8'), PROXIES)).toEqual({
      address: null,
      forwarded: false,
    });
  });

  it('reports nothing when the header is absent or empty', () => {
    expect(resolveClientAddress(headers(), PROXIES).address).toBeNull();
    expect(resolveClientAddress(headers(''), PROXIES).address).toBeNull();
  });

  it('gives up rather than guessing past an unparseable hop', () => {
    expect(
      resolveClientAddress(headers('203.0.113.4, not-an-address'), PROXIES).address,
    ).toBeNull();
  });

  it('handles a port and IPv6 brackets, as real proxies emit them', () => {
    expect(resolveClientAddress(headers('203.0.113.4:51234, 192.168.0.8'), PROXIES).address).toBe(
      '203.0.113.4',
    );
    expect(resolveClientAddress(headers('[2001:db8::1]:443, 192.168.0.8'), PROXIES).address).toBe(
      '2001:db8::1',
    );
  });

  it('treats an IPv4-mapped IPv6 address as the same host', () => {
    // Otherwise the CIDR check silently stops matching the moment a proxy is
    // reconfigured to listen on IPv6.
    expect(resolveClientAddress(headers('203.0.113.4, ::ffff:192.168.0.8'), PROXIES).address).toBe(
      '203.0.113.4',
    );
  });
});

describe('normalizeAddress', () => {
  it('accepts the forms that appear in real headers', () => {
    expect(normalizeAddress('203.0.113.4')).toBe('203.0.113.4');
    expect(normalizeAddress(' 203.0.113.4 ')).toBe('203.0.113.4');
    expect(normalizeAddress('203.0.113.4:8080')).toBe('203.0.113.4');
    expect(normalizeAddress('[2001:DB8::1]')).toBe('2001:db8::1');
    expect(normalizeAddress('::ffff:203.0.113.4')).toBe('203.0.113.4');
    expect(normalizeAddress('::1')).toBe('::1');
  });

  it('rejects anything that is not an address', () => {
    for (const value of ['', 'localhost', '999.1.1.1', '1.2.3', 'evil.example', '::gggg']) {
      expect(normalizeAddress(value)).toBeNull();
    }
  });
});

describe('isWithin', () => {
  it('matches an IPv4 network', () => {
    expect(isWithin('10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(isWithin('11.1.2.3', '10.0.0.0/8')).toBe(false);
    expect(isWithin('192.168.0.8', '192.168.0.0/24')).toBe(true);
    expect(isWithin('192.168.1.8', '192.168.0.0/24')).toBe(false);
  });

  it('treats a bare address as a single host, because operators write both', () => {
    expect(isWithin('192.168.0.8', '192.168.0.8')).toBe(true);
    expect(isWithin('192.168.0.9', '192.168.0.8')).toBe(false);
    expect(isWithin('192.168.0.8', '192.168.0.8/32')).toBe(true);
  });

  it('matches an IPv6 network', () => {
    expect(isWithin('2001:db8::1', '2001:db8::/32')).toBe(true);
    expect(isWithin('2001:db9::1', '2001:db8::/32')).toBe(false);
    expect(isWithin('::1', '::1/128')).toBe(true);
  });

  it('does not match across address families', () => {
    // Not an error either: a deployment may legitimately list both.
    expect(isWithin('10.1.2.3', '2001:db8::/32')).toBe(false);
    expect(isWithin('2001:db8::1', '10.0.0.0/8')).toBe(false);
  });

  it('refuses a malformed network rather than matching it', () => {
    for (const cidr of ['', 'not-a-network', '10.0.0.0/99', '10.0.0.0/-1', '10.0.0.0/abc']) {
      expect(isWithin('10.1.2.3', cidr)).toBe(false);
    }
  });

  it('matches everything under a zero-length prefix, and nothing outside the family', () => {
    expect(isWithin('203.0.113.4', '0.0.0.0/0')).toBe(true);
    expect(isWithin('2001:db8::1', '0.0.0.0/0')).toBe(false);
  });
});
