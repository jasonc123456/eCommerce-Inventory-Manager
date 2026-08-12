import { alertKinds, businessAlertKinds, installationAlertKinds } from '@eim/db';
import { describe, expect, it } from 'vitest';

import {
  bypassesQuietHours,
  permissionFor,
  routeAlert,
  BUSINESS_ALERT_PERMISSION,
  INSTALLATION_ALERT_PERMISSION,
  type Recipient,
} from './routing';

/**
 * Who hears about an alert (sections 5, 11, 22).
 *
 * The failure modes worth testing here are asymmetric. Telling somebody too
 * little means an oversell sits unread; telling somebody too much means the
 * permission catalogue was decoration. So both directions are asserted, and
 * the one that matters most — a preference cannot widen an audience — is
 * asserted from the denied side.
 */

const NIGHT = { start: '21:00', end: '07:00', timeZone: 'UTC' };
const IN_THE_NIGHT = new Date('2026-01-15T23:00:00.000Z');
const IN_THE_DAY = new Date('2026-01-15T12:00:00.000Z');

function recipient(overrides: Partial<Recipient> & Pick<Recipient, 'permissions'>): Recipient {
  return {
    userId: 'user-1',
    email: 'owner@example.invalid',
    ...overrides,
  };
}

describe('the permission tables', () => {
  it('address every kind to exactly one permission', () => {
    // A kind missing from both tables would be routed by the fallback, which
    // denies. Better to fail here than to lose an alert quietly in production.
    for (const kind of alertKinds) {
      expect(permissionFor(kind)).toBeTruthy();
    }

    expect(Object.keys(BUSINESS_ALERT_PERMISSION).sort()).toEqual([...businessAlertKinds].sort());
    expect(Object.keys(INSTALLATION_ALERT_PERMISSION).sort()).toEqual(
      [...installationAlertKinds].sort(),
    );
  });
});

describe('permission', () => {
  it('does not tell somebody who was refused the information', () => {
    const deliveries = routeAlert({
      alert: { kind: 'oversold', severity: 'critical' },
      recipients: [recipient({ permissions: new Set(['view_inventory']) })],
      now: IN_THE_DAY,
    });

    expect(deliveries).toHaveLength(0);
  });

  it('cannot be widened by a preference', () => {
    // The order of the rules is the whole point: preference narrows, never
    // widens. Somebody who has asked for everything still only gets what the
    // permission catalogue allows them.
    const deliveries = routeAlert({
      alert: { kind: 'oversold', severity: 'critical' },
      recipients: [
        recipient({
          permissions: new Set(['view_catalog']),
          preference: {
            emailMinSeverity: 'info',
            emailOptedInKinds: [...alertKinds],
            emailMutedKinds: [],
          },
        }),
      ],
      now: IN_THE_DAY,
    });

    expect(deliveries).toHaveLength(0);
  });
});

describe('channels', () => {
  it('always shows an alert in the application, even with email switched off', () => {
    const deliveries = routeAlert({
      alert: { kind: 'restock_pending', severity: 'warning' },
      recipients: [
        recipient({
          permissions: new Set(['confirm_restock']),
          preference: { emailMinSeverity: 'none', emailOptedInKinds: [], emailMutedKinds: [] },
        }),
      ],
      now: IN_THE_DAY,
    });

    expect(deliveries[0]?.channels).toEqual(['in_app']);
  });

  it('emails Error and above when nobody has expressed a preference', () => {
    const permissions = new Set(['view_sync_activity']);

    const warning = routeAlert({
      alert: { kind: 'sync_failing', severity: 'warning' },
      recipients: [recipient({ permissions })],
      now: IN_THE_DAY,
    });
    const error = routeAlert({
      alert: { kind: 'sync_failing', severity: 'error' },
      recipients: [recipient({ permissions })],
      now: IN_THE_DAY,
    });

    expect(warning[0]?.channels).toEqual(['in_app']);
    expect(error[0]?.channels).toEqual(['in_app', 'email']);
  });

  it('honours an opt-in below the floor', () => {
    // Section 22's out-of-stock opt-in: a Warning somebody specifically asked
    // to hear about.
    const deliveries = routeAlert({
      alert: { kind: 'channel_stockout', severity: 'warning' },
      recipients: [
        recipient({
          permissions: new Set(['receive_critical_inventory_alerts']),
          preference: {
            emailMinSeverity: 'critical',
            emailOptedInKinds: ['channel_stockout'],
            emailMutedKinds: [],
          },
        }),
      ],
      now: IN_THE_DAY,
    });

    expect(deliveries[0]?.channels).toContain('email');
  });

  it('honours a mute above the floor', () => {
    const deliveries = routeAlert({
      alert: { kind: 'job_dead_lettered', severity: 'error' },
      recipients: [
        recipient({
          permissions: new Set(['view_sync_activity']),
          preference: {
            emailMinSeverity: 'info',
            emailOptedInKinds: [],
            emailMutedKinds: ['job_dead_lettered'],
          },
        }),
      ],
      now: IN_THE_DAY,
    });

    expect(deliveries[0]?.channels).toEqual(['in_app']);
  });

  it('will not let a mute hide something critical', () => {
    // A preference set months ago for an unrelated reason must not be the thing
    // that swallows an oversell on the day it happens.
    const deliveries = routeAlert({
      alert: { kind: 'oversold', severity: 'critical' },
      recipients: [
        recipient({
          permissions: new Set(['receive_critical_inventory_alerts']),
          preference: {
            emailMinSeverity: 'info',
            emailOptedInKinds: [],
            emailMutedKinds: ['oversold'],
          },
        }),
      ],
      now: IN_THE_DAY,
    });

    expect(deliveries[0]?.channels).toContain('email');
  });

  it('respects somebody who has switched email off entirely, even for critical', () => {
    // 'none' is a decision about the inbox, not about the alert: the in-app
    // entry is still there.
    const deliveries = routeAlert({
      alert: { kind: 'oversold', severity: 'critical' },
      recipients: [
        recipient({
          permissions: new Set(['receive_critical_inventory_alerts']),
          preference: { emailMinSeverity: 'none', emailOptedInKinds: [], emailMutedKinds: [] },
        }),
      ],
      now: IN_THE_DAY,
    });

    expect(deliveries[0]?.channels).toEqual(['in_app']);
  });

  it('does not email an opted-in kind to somebody who has switched email off', () => {
    const deliveries = routeAlert({
      alert: { kind: 'channel_stockout', severity: 'warning' },
      recipients: [
        recipient({
          permissions: new Set(['receive_critical_inventory_alerts']),
          preference: {
            emailMinSeverity: 'none',
            emailOptedInKinds: ['channel_stockout'],
            emailMutedKinds: [],
          },
        }),
      ],
      now: IN_THE_DAY,
    });

    expect(deliveries[0]?.channels).toEqual(['in_app']);
  });
});

describe('quiet hours', () => {
  it('holds an ordinary alert until the shop opens', () => {
    const deliveries = routeAlert({
      alert: { kind: 'job_dead_lettered', severity: 'error' },
      recipients: [recipient({ permissions: new Set(['view_sync_activity']) })],
      quietHours: NIGHT,
      now: IN_THE_NIGHT,
    });

    expect(deliveries[0]?.deferUntil?.toISOString()).toBe('2026-01-16T07:00:00.000Z');
  });

  it('wakes somebody for stock that is being sold twice', () => {
    for (const kind of ['oversold', 'unsafe_drift'] as const) {
      const deliveries = routeAlert({
        alert: { kind, severity: 'critical' },
        recipients: [recipient({ permissions: new Set(['receive_critical_inventory_alerts']) })],
        quietHours: NIGHT,
        now: IN_THE_NIGHT,
      });

      expect(deliveries[0]?.deferUntil).toBeNull();
      expect(bypassesQuietHours(kind, 'critical')).toBe(true);
    }
  });

  it('does not wake somebody for a lost sale', () => {
    // A stockout costs a sale, which is bad and can wait until morning. Putting
    // it on the bypass list is how everything ends up on the bypass list.
    expect(bypassesQuietHours('channel_stockout', 'critical')).toBe(false);
  });

  it('does not wake somebody for a merely serious version of a safety alert', () => {
    expect(bypassesQuietHours('oversold', 'error')).toBe(false);
  });

  it('never defers the in-app entry, which somebody may already be reading', () => {
    const deliveries = routeAlert({
      alert: { kind: 'restock_pending', severity: 'warning' },
      recipients: [recipient({ permissions: new Set(['confirm_restock']) })],
      quietHours: NIGHT,
      now: IN_THE_NIGHT,
    });

    expect(deliveries[0]?.channels).toEqual(['in_app']);
    expect(deliveries[0]?.deferUntil).toBeNull();
  });

  it('sends immediately when the shop has no quiet hours', () => {
    const deliveries = routeAlert({
      alert: { kind: 'job_dead_lettered', severity: 'error' },
      recipients: [recipient({ permissions: new Set(['view_sync_activity']) })],
      now: IN_THE_NIGHT,
    });

    expect(deliveries[0]?.deferUntil).toBeNull();
  });
});
