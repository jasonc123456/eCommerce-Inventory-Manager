import { describe, expect, it } from 'vitest';

import {
  CIRCUIT_COOLDOWN_MS,
  CIRCUIT_THRESHOLD,
  circuitStateOf,
  decide,
  worstPressure,
} from './health-policy';
import type { QuotaState } from './quota-policy';

/**
 * Calling a connection what it actually is.
 *
 * The distinction this file exists to keep is between failing and degraded. A
 * store whose webhooks cannot be registered still synchronizes, more slowly;
 * calling that failing buries it among the genuinely broken, and calling it
 * healthy hides a store that is minutes behind rather than seconds.
 */

const NOW = new Date('2026-03-01T12:00:00Z');

function pressure(value: QuotaState['pressure']): QuotaState {
  return {
    provider: 'ebay',
    apiFamily: 'sell.inventory',
    connectionId: null,
    limit: 100,
    used: 50,
    fraction: 0.5,
    pressure: value,
    windowEndsAt: NOW,
  };
}

function healthy(overrides: Partial<Parameters<typeof decide>[0]> = {}) {
  return decide({
    connectionStatus: 'active',
    pauseReason: null,
    circuit: 'closed',
    failures: 0,
    pressure: 'normal',
    polling: [],
    ...overrides,
  });
}

describe('circuitStateOf', () => {
  it('stays closed below the threshold', () => {
    // One timeout is weather. Taking a connection out of service for it would
    // make the application less reliable than the provider.
    expect(circuitStateOf(CIRCUIT_THRESHOLD - 1, NOW, NOW)).toBe('closed');
  });

  it('opens at the threshold and holds for the cooldown', () => {
    expect(circuitStateOf(CIRCUIT_THRESHOLD, NOW, NOW)).toBe('open');
    expect(
      circuitStateOf(CIRCUIT_THRESHOLD, NOW, new Date(NOW.getTime() + CIRCUIT_COOLDOWN_MS - 1)),
    ).toBe('open');
  });

  it('half-opens once the cooldown has passed', () => {
    expect(
      circuitStateOf(CIRCUIT_THRESHOLD, NOW, new Date(NOW.getTime() + CIRCUIT_COOLDOWN_MS)),
    ).toBe('half_open');
  });

  it('is closed when there is no failure to date it from', () => {
    // Derived rather than stored, so a tally with no timestamp cannot leave a
    // connection permanently open after a crash.
    expect(circuitStateOf(CIRCUIT_THRESHOLD, null, NOW)).toBe('closed');
  });
});

describe('worstPressure', () => {
  it('reports the tightest window', () => {
    // A family can be under both a daily and an hourly allowance, and being
    // comfortable on one says nothing.
    expect(worstPressure([pressure('normal'), pressure('critical'), pressure('warning')])).toBe(
      'critical',
    );
  });

  it('reports unknown when nothing is known', () => {
    expect(worstPressure([])).toBe('unknown');
    expect(worstPressure([pressure('unknown')])).toBe('unknown');
  });
});

describe('decide', () => {
  it('calls a working connection healthy', () => {
    expect(healthy()).toMatchObject({ status: 'healthy' });
  });

  it('reports a paused connection with the reason it was paused', () => {
    // Reauthorizing is what fixes it, and the quota will look after itself.
    expect(
      healthy({ connectionStatus: 'paused', pauseReason: 'eBay granted fewer permissions' }),
    ).toEqual({ status: 'failing', summary: 'eBay granted fewer permissions' });
  });

  it('reports an open circuit as failing, ahead of anything else', () => {
    expect(healthy({ circuit: 'open', failures: 7, pressure: 'critical' })).toMatchObject({
      status: 'failing',
    });
  });

  it('reports unregistered webhook topics as degraded, not failing', () => {
    // Section 14: missing webhook capability produces a visible degraded status.
    // Polling continues, so the integration works — more slowly.
    const verdict = healthy({ polling: ['product.updated', 'order.created'] });

    expect(verdict.status).toBe('degraded');
    expect(verdict.summary).toEqual(expect.stringContaining('polling'));
    expect(verdict.summary).toEqual(expect.stringContaining('product.updated'));
  });

  it('reports a nearly spent allowance as degraded rather than broken', () => {
    // A connection at 96% is working perfectly. Reporting a fault would have an
    // operator reauthorizing credentials that are fine.
    expect(healthy({ pressure: 'critical' })).toMatchObject({ status: 'degraded' });
    expect(healthy({ pressure: 'high' })).toMatchObject({ status: 'degraded' });
  });

  it('mentions a 70% allowance without calling the connection degraded', () => {
    const verdict = healthy({ pressure: 'warning' });

    expect(verdict.status).toBe('healthy');
    expect(verdict.summary).toEqual(expect.stringContaining('70%'));
  });

  it('reports recent failures below the circuit threshold as degraded', () => {
    expect(healthy({ failures: 2 })).toMatchObject({ status: 'degraded' });
    expect(healthy({ failures: 1 }).summary).toEqual(expect.stringContaining('1 recent call'));
  });

  it('reports a half-open circuit as degraded, and says what happens next', () => {
    const verdict = healthy({ circuit: 'half_open', failures: CIRCUIT_THRESHOLD });

    expect(verdict.status).toBe('degraded');
    expect(verdict.summary).toEqual(expect.stringContaining('next one'));
  });

  it('reports a connection that was never finished as unknown', () => {
    expect(healthy({ connectionStatus: 'pending' })).toMatchObject({ status: 'unknown' });
  });

  it('reports a disconnected connection as failing', () => {
    expect(healthy({ connectionStatus: 'disconnected' })).toMatchObject({ status: 'failing' });
    expect(healthy({ connectionStatus: 'revoked' })).toMatchObject({ status: 'failing' });
  });
});
