import { describe, expect, it } from 'vitest';

import { categorize, classifyAddress, isMetadataAddress, matches, normalize } from './addresses';

/**
 * The address boundary.
 *
 * Each case below is a way somebody has actually reached an internal service
 * through a URL field. The IPv4-mapped and shortened forms matter most: they
 * are the same destination written so that a naive check does not recognise it.
 */

const CLOSED = { allowPrivate: false, allowlist: [] };
const OPEN = { allowPrivate: true, allowlist: [] };

describe('categorize', () => {
  it('recognises the public internet', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:2800:220:1::1']) {
      expect(categorize(address)).toBe('public');
    }
  });

  it('recognises every private and local form', () => {
    expect(categorize('127.0.0.1')).toBe('loopback');
    expect(categorize('::1')).toBe('loopback');
    expect(categorize('10.1.2.3')).toBe('private');
    expect(categorize('172.16.0.1')).toBe('private');
    expect(categorize('172.31.255.255')).toBe('private');
    expect(categorize('192.168.0.8')).toBe('private');
    expect(categorize('100.64.0.1')).toBe('private');
    expect(categorize('fd00::1')).toBe('private');
    expect(categorize('169.254.1.1')).toBe('link-local');
    expect(categorize('fe80::1')).toBe('link-local');
    expect(categorize('224.0.0.1')).toBe('multicast');
    expect(categorize('ff02::1')).toBe('multicast');
    expect(categorize('0.0.0.0')).toBe('unspecified');
    expect(categorize('::')).toBe('unspecified');
  });

  it('sees through IPv4-mapped notation', () => {
    // `::ffff:127.0.0.1` reaches the loopback. A check that only understands
    // IPv6 group notation reads it as an ordinary public address.
    expect(categorize('::ffff:127.0.0.1')).toBe('loopback');
    expect(categorize('::ffff:10.0.0.1')).toBe('private');
    expect(categorize('::ffff:169.254.169.254')).toBe('link-local');
    expect(categorize('::ffff:8.8.8.8')).toBe('public');
  });

  it('treats 172.32 as public, because the private range stops at 31', () => {
    expect(categorize('172.32.0.1')).toBe('public');
    expect(categorize('172.15.0.1')).toBe('public');
  });
});

describe('classifyAddress', () => {
  it('refuses private destinations by default', () => {
    for (const address of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '::1', 'fd00::1']) {
      expect(classifyAddress(address, CLOSED).allowed).toBe(false);
    }
  });

  it('allows them once the installation opts in', () => {
    for (const address of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '::1']) {
      expect(classifyAddress(address, OPEN).allowed).toBe(true);
    }
  });

  it('never allows cloud metadata, whatever the installation asked for', () => {
    // The operator who allowed 169.254.0.0/16 for a local store did not agree
    // to hand out their cloud credentials, and could not tell the difference at
    // the point they typed it.
    for (const address of ['169.254.169.254', '::ffff:169.254.169.254', '100.100.100.200']) {
      expect(classifyAddress(address, OPEN).allowed).toBe(false);
      expect(
        classifyAddress(address, { allowPrivate: true, allowlist: ['0.0.0.0/0', '::/0'] }).allowed,
      ).toBe(false);
      expect(isMetadataAddress(address)).toBe(true);
    }
  });

  it('honours an allowlist when one is given', () => {
    const policy = { allowPrivate: true, allowlist: ['192.168.1.0/24', '10.0.0.7'] };

    expect(classifyAddress('192.168.1.50', policy).allowed).toBe(true);
    expect(classifyAddress('10.0.0.7', policy).allowed).toBe(true);
    expect(classifyAddress('10.0.0.8', policy).allowed).toBe(false);
    expect(classifyAddress('172.16.0.1', policy).allowed).toBe(false);
  });

  it('leaves public addresses alone regardless of the allowlist', () => {
    // The allowlist widens the private exception; it is not a general filter,
    // and reading it as one would break every provider call.
    const policy = { allowPrivate: true, allowlist: ['192.168.1.0/24'] };

    expect(classifyAddress('8.8.8.8', policy).allowed).toBe(true);
  });

  it('refuses something that is not an address at all', () => {
    for (const value of ['', 'localhost', 'not-an-address', '999.1.1.1', '10.0.0']) {
      expect(classifyAddress(value, OPEN).allowed).toBe(false);
    }
  });

  it('refuses an octal-looking octet rather than guessing which base it is', () => {
    // `010.0.0.1` is 8.0.0.1 to a resolver that reads octal and 10.0.0.1 to one
    // that does not. An address that means two things gets past a check that
    // only sees one of them.
    expect(classifyAddress('010.0.0.1', CLOSED).allowed).toBe(false);
    expect(normalize('010.0.0.1')).toBeNull();
  });
});

describe('matches', () => {
  it('matches inside a CIDR and outside it', () => {
    expect(matches('10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(matches('11.1.2.3', '10.0.0.0/8')).toBe(false);
    expect(matches('2001:db8::1', '2001:db8::/32')).toBe(true);
    expect(matches('2001:db9::1', '2001:db8::/32')).toBe(false);
  });

  it('matches a bare address as a single host', () => {
    expect(matches('10.0.0.7', '10.0.0.7')).toBe(true);
    expect(matches('10.0.0.8', '10.0.0.7')).toBe(false);
  });

  it('does not match across families', () => {
    expect(matches('10.0.0.1', '::/0')).toBe(false);
    expect(matches('::1', '0.0.0.0/0')).toBe(false);
  });

  it('refuses a malformed network rather than matching it', () => {
    for (const entry of ['', '10.0.0.0/', '10.0.0.0/abc', '10.0.0.0/-1', '10.0.0.0/33']) {
      expect(matches('10.0.0.1', entry)).toBe(false);
    }
  });
});

describe('normalize', () => {
  it('reduces the spellings of one address to one string', () => {
    expect(normalize(' 10.0.0.1 ')).toBe('10.0.0.1');
    expect(normalize('[2001:db8::1]')).toBe('2001:db8:0:0:0:0:0:1');
    expect(normalize('::ffff:10.0.0.1')).toBe('10.0.0.1');
    expect(normalize('fe80::1%eth0')).toBe('fe80:0:0:0:0:0:0:1');
  });
});

describe('the forms that only appear when somebody is trying', () => {
  it('treats reserved and documentation ranges as not the public internet', () => {
    // None of these host a store. Several are the ranges a scanner uses to
    // check whether an address field will connect to arbitrary destinations.
    expect(categorize('240.0.0.1')).toBe('reserved');
    expect(categorize('255.255.255.255')).toBe('reserved');
    expect(categorize('192.0.0.1')).toBe('reserved');
    expect(categorize('192.0.2.1')).toBe('reserved');
    expect(categorize('198.51.100.1')).toBe('reserved');
    expect(categorize('203.0.113.1')).toBe('reserved');
    expect(categorize('198.18.0.1')).toBe('reserved');
    expect(categorize('2001:db8::1')).toBe('reserved');
    // NAT64: an IPv6 address that translates to an IPv4 destination, which is
    // how a private target is smuggled past an IPv6-shaped check.
    expect(categorize('64:ff9b::a00:1')).toBe('reserved');
  });

  it('refuses malformed IPv6 rather than reading it charitably', () => {
    for (const value of [
      '1::2::3',
      '2001:db8:::1',
      '2001:gggg::1',
      '2001:db8::1::',
      '1:2:3:4:5:6:7',
      '1:2:3:4:5:6:7:8:9',
      '::ffff:999.1.1.1',
    ]) {
      expect(normalize(value)).toBeNull();
      expect(classifyAddress(value, OPEN).allowed).toBe(false);
    }
  });

  it('understands the shortened forms that are genuinely valid', () => {
    expect(normalize('::')).toBe('0:0:0:0:0:0:0:0');
    expect(normalize('1::')).toBe('1:0:0:0:0:0:0:0');
    expect(normalize('::2')).toBe('0:0:0:0:0:0:0:2');
    expect(normalize('1:2:3:4:5:6:7:8')).toBe('1:2:3:4:5:6:7:8');
  });

  it('does not read ::1 as an IPv4-compatible address', () => {
    // Reading it as 0.0.0.1 would reclassify the one address most worth
    // refusing as an ordinary public destination.
    expect(categorize('::1')).toBe('loopback');
    expect(categorize('::')).toBe('unspecified');
  });

  it('refuses a prefix longer than the family it is applied to', () => {
    expect(matches('10.0.0.1', '10.0.0.0/33')).toBe(false);
    expect(matches('2001:db8::1', '2001:db8::/129')).toBe(false);
  });

  it('matches a zero-length prefix within one family only', () => {
    expect(matches('8.8.8.8', '0.0.0.0/0')).toBe(true);
    expect(matches('2001:db8::1', '::/0')).toBe(true);
  });
});
