import { describe, expect, it } from 'vitest';

import {
  CEILINGS,
  pressureFor,
  readEbayRateLimits,
  verdictFor,
  type QuotaState,
} from './quota-policy';

/**
 * Deciding who may spend what is left.
 *
 * The property under test is that the cheapest work stops first and the most
 * important work stops last — and that both stop, because a provider that
 * hard-refuses at its limit refuses an order write as readily as a report.
 */

function state(overrides: Partial<QuotaState> = {}): QuotaState {
  const limit = overrides.limit === undefined ? 1000 : overrides.limit;
  const used = overrides.used ?? 0;
  const fraction = limit === null || limit <= 0 ? null : used / limit;

  return {
    provider: 'ebay',
    apiFamily: 'sell.inventory',
    connectionId: null,
    limit,
    used,
    fraction,
    pressure: pressureFor(fraction, limit),
    windowEndsAt: new Date('2026-03-01T00:00:00Z'),
    ...overrides,
  };
}

describe('pressureFor', () => {
  it('reports section 13’s three warning levels', () => {
    expect(pressureFor(0.69, 1000)).toBe('normal');
    expect(pressureFor(0.7, 1000)).toBe('warning');
    expect(pressureFor(0.85, 1000)).toBe('high');
    expect(pressureFor(0.95, 1000)).toBe('critical');
    expect(pressureFor(1.5, 1000)).toBe('critical');
  });

  it('says unknown rather than guessing when there is no limit', () => {
    // Section 13: published defaults are informational, not hardcoded
    // guarantees. A guess throttles an account granted more and overruns one
    // granted less.
    expect(pressureFor(null, null)).toBe('unknown');
  });

  it('treats an allowance of zero as spent, not as unknown', () => {
    expect(pressureFor(null, 0)).toBe('critical');
  });
});

describe('verdictFor', () => {
  it('stops background work first', () => {
    const busy = state({ used: 750 });

    expect(verdictFor(busy, 'background').allowed).toBe(false);
    expect(verdictFor(busy, 'normal').allowed).toBe(true);
    expect(verdictFor(busy, 'critical').allowed).toBe(true);
  });

  it('stops ordinary work next', () => {
    const busier = state({ used: 900 });

    expect(verdictFor(busier, 'background').allowed).toBe(false);
    expect(verdictFor(busier, 'normal').allowed).toBe(false);
    expect(verdictFor(busier, 'critical').allowed).toBe(true);
  });

  it('stops critical work too, to leave room for token refresh', () => {
    // Section 13 reserves capacity for orders, inventory, token refresh, and
    // notification verification. The last few percent is what a refresh needs to
    // exist at all, and a connection that cannot refresh cannot do anything.
    const spent = state({ used: 960 });

    expect(verdictFor(spent, 'critical')).toMatchObject({
      allowed: false,
      pressure: 'critical',
    });
    expect(verdictFor(spent, 'critical').summary).toEqual(expect.stringContaining('token refresh'));
  });

  it('permits everything when the limit is unknown, and says so', () => {
    const unknown = state({ limit: null });

    for (const priority of ['background', 'normal', 'critical'] as const) {
      expect(verdictFor(unknown, priority)).toMatchObject({ allowed: true, pressure: 'unknown' });
    }
  });

  it('refuses everything when the provider says there is none', () => {
    const none = state({ limit: 0 });

    for (const priority of ['background', 'normal', 'critical'] as const) {
      expect(verdictFor(none, priority).allowed).toBe(false);
    }
  });

  it('lets everything through on an untouched allowance', () => {
    const fresh = state({ used: 0 });

    for (const priority of ['background', 'normal', 'critical'] as const) {
      expect(verdictFor(fresh, priority)).toMatchObject({ allowed: true, pressure: 'normal' });
    }
  });

  it('uses the same numbers to warn and to throttle', () => {
    // Not a coincidence worth losing: the point at which an operator should be
    // told is the point at which the cheapest work should stop.
    expect(CEILINGS.background).toBe(0.7);
    expect(CEILINGS.normal).toBe(0.85);
    expect(CEILINGS.critical).toBe(0.95);
  });
});

describe('readEbayRateLimits', () => {
  const body = JSON.stringify({
    rateLimits: [
      {
        apiContext: 'sell',
        apiName: 'inventory',
        resources: [
          {
            name: 'offer',
            rates: [
              {
                limit: 5000,
                remaining: 4000,
                reset: '2026-03-02T00:00:00.000Z',
                timeWindow: 86_400,
              },
            ],
          },
        ],
      },
    ],
  });

  it('reads a limit into what was spent', () => {
    // eBay reports what is left. Storing that as "used" would read a nearly
    // exhausted allowance as an untouched one.
    expect(readEbayRateLimits(body)).toEqual([
      {
        provider: 'ebay',
        apiFamily: 'inventory.offer',
        limit: 5000,
        used: 1000,
        windowStartsAt: new Date('2026-03-01T00:00:00.000Z'),
        windowEndsAt: new Date('2026-03-02T00:00:00.000Z'),
        now: expect.any(Date),
      },
    ]);
  });

  it('clamps a remaining count above the limit', () => {
    // Otherwise it becomes a negative used count, which reads as no pressure at
    // all — the one direction it is dangerous to be wrong in.
    const odd = body.replace('"remaining":4000', '"remaining":9000');

    expect(readEbayRateLimits(odd)[0]?.used).toBe(0);
  });

  it('drops a rate missing anything it needs', () => {
    for (const mutation of [
      body.replace('"limit":5000,', ''),
      body.replace('"remaining":4000,', ''),
      body.replace('"reset":"2026-03-02T00:00:00.000Z",', ''),
      body.replace('"limit":5000', '"limit":"lots"'),
    ]) {
      expect(readEbayRateLimits(mutation)).toEqual([]);
    }
  });

  it('reads nothing from a body that is not eBay’s answer', () => {
    for (const value of ['', 'not json', '<html>', '[]', 'null', '{}', '{"rateLimits":"none"}']) {
      expect(readEbayRateLimits(value)).toEqual([]);
    }
  });
});
