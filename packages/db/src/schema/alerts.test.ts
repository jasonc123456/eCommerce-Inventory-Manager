import { describe, expect, it } from 'vitest';

import {
  alertKinds,
  alertStateAt,
  ALERT_SEVERITY_RANK,
  businessAlertKinds,
  installationAlertKinds,
  isInstallationAlertKind,
  type AlertSeverity,
} from './alerts';

/**
 * The parts of an alert that are decided in TypeScript (section 22).
 *
 * Two of them mirror something the database also knows, and a mirror that has
 * drifted is worse than no mirror: it puts the worst alerts in the middle of a
 * list, or files an installation problem under a shop.
 */

describe('severity ranking', () => {
  it('orders the four severities the way section 22 means them', () => {
    const ordered = (Object.keys(ALERT_SEVERITY_RANK) as AlertSeverity[]).sort(
      (left, right) => ALERT_SEVERITY_RANK[left] - ALERT_SEVERITY_RANK[right],
    );

    expect(ordered).toEqual(['info', 'warning', 'error', 'critical']);
  });

  it('does not agree with sorting the names, which is why it exists', () => {
    // 'critical' < 'error' < 'info' < 'warning'. A list ordered by name puts
    // the thing on fire second from last.
    const alphabetical = [...(Object.keys(ALERT_SEVERITY_RANK) as AlertSeverity[])].sort();

    expect(alphabetical).not.toEqual(['info', 'warning', 'error', 'critical']);
  });
});

describe('scope', () => {
  it('gives every kind exactly one scope', () => {
    expect(new Set(alertKinds).size).toBe(alertKinds.length);
    expect(businessAlertKinds.some((kind) => isInstallationAlertKind(kind))).toBe(false);
    expect(installationAlertKinds.every((kind) => isInstallationAlertKind(kind))).toBe(true);
  });
});

describe('alertStateAt', () => {
  const now = new Date('2026-03-01T12:00:00.000Z');
  const earlier = new Date('2026-03-01T11:00:00.000Z');
  const later = new Date('2026-03-01T13:00:00.000Z');

  it('is open when nobody has done anything about it', () => {
    expect(alertStateAt({ resolvedAt: null, snoozedUntil: null, acknowledgedAt: null }, now)).toBe(
      'open',
    );
  });

  it('is acknowledged once somebody has said they have seen it', () => {
    expect(
      alertStateAt({ resolvedAt: null, snoozedUntil: null, acknowledgedAt: earlier }, now),
    ).toBe('acknowledged');
  });

  it('is snoozed only while the snooze has not lapsed', () => {
    expect(alertStateAt({ resolvedAt: null, snoozedUntil: later, acknowledgedAt: null }, now)).toBe(
      'snoozed',
    );

    // The transition nothing writes a row for, and the reason this is computed
    // rather than stored.
    expect(
      alertStateAt({ resolvedAt: null, snoozedUntil: earlier, acknowledgedAt: null }, now),
    ).toBe('open');
  });

  it('prefers a live snooze to an older acknowledgement', () => {
    expect(
      alertStateAt({ resolvedAt: null, snoozedUntil: later, acknowledgedAt: earlier }, now),
    ).toBe('snoozed');
  });

  it('is resolved whatever else was true, because a proven end outranks an opinion', () => {
    expect(
      alertStateAt({ resolvedAt: earlier, snoozedUntil: later, acknowledgedAt: earlier }, now),
    ).toBe('resolved');
  });
});
