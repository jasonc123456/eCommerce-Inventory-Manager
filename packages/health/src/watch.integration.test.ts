import { alertStateAt, operatorAlerts } from '@eim/db';
import { openInstallationAlerts } from '@eim/notifications';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { HealthReport } from './report';
import { watchInstallation } from './watch';

/**
 * Being told rather than having to look (section 22).
 *
 * The two properties worth proving are that a persistent problem is one alert
 * rather than one per pass, and that recovery withdraws it — with the evidence
 * that proved it, because section 22 auto-resolves only on a fresh check.
 */

let harness: TestDatabase;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 180_000);

beforeEach(async () => {
  await harness.db.delete(operatorAlerts);
});

afterAll(async () => {
  await harness.drop();
});

function report(
  checks: readonly { name: string; status: 'ok' | 'degraded' | 'failing'; detail?: string }[],
): HealthReport {
  return {
    status: 'failing',
    checks,
    observedAt: new Date('2026-03-01T12:00:00.000Z'),
  };
}

describe('watchInstallation', () => {
  it('files one alert for a problem that keeps happening', async () => {
    const stalled = report([{ name: 'queue', status: 'failing', detail: '40 waiting, oldest 2h' }]);

    for (let pass = 0; pass < 5; pass += 1) {
      await watchInstallation(harness.db, stalled);
    }

    const alerts = await openInstallationAlerts(harness.db);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.kind).toBe('queue_stalled');
    expect(alerts[0]?.occurrences).toBe(5);
    expect(alerts[0]?.severity).toBe('error');
  });

  it('opens a second alert when a warning becomes a failure', async () => {
    // A warning that became a failure is a different sentence, and the history
    // should show the moment it changed.
    await watchInstallation(harness.db, report([{ name: 'storage', status: 'degraded' }]));
    await watchInstallation(harness.db, report([{ name: 'storage', status: 'failing' }]));

    const alerts = await openInstallationAlerts(harness.db);
    expect(alerts).toHaveLength(2);
    expect(alerts.map((alert) => alert.severity).sort()).toEqual(['critical', 'warning']);
  });

  it('withdraws an alert once a later check finds the problem gone', async () => {
    await watchInstallation(harness.db, report([{ name: 'scheduler', status: 'failing' }]));
    expect(await openInstallationAlerts(harness.db)).toHaveLength(1);

    const recovered = await watchInstallation(
      harness.db,
      report([{ name: 'scheduler', status: 'ok', detail: 'last seen 3s ago' }]),
    );

    expect(recovered.resolved).toBe(1);
    expect(await openInstallationAlerts(harness.db)).toHaveLength(0);
  });

  it('keeps the reading that proved recovery', async () => {
    await watchInstallation(harness.db, report([{ name: 'smtp', status: 'failing' }]));
    await watchInstallation(
      harness.db,
      report([{ name: 'smtp', status: 'ok', detail: 'the relay accepted a connection' }]),
    );

    const [row] = await harness.db
      .select()
      .from(operatorAlerts)
      .where(eq(operatorAlerts.kind, 'smtp_failing'));

    expect(alertStateAt(row!, new Date())).toBe('resolved');
    expect(row?.resolvedEvidence).toEqual({
      check: 'smtp',
      observedAt: '2026-03-01T12:00:00.000Z',
      detail: 'the relay accepted a connection',
    });
  });

  it('carries the remediation across, so the alert says what to do', async () => {
    await watchInstallation(
      harness.db,
      report([
        {
          name: 'schema',
          status: 'failing',
          detail: 'expected 28, found 27',
        },
      ]),
    );

    const [alert] = await openInstallationAlerts(harness.db);
    expect(alert?.kind).toBe('migration_mismatch');
    expect(alert?.summary).toBe('expected 28, found 27');
  });

  it('does not wake anybody about a mixed rollout', async () => {
    // It resolves itself when the deployment finishes; it belongs on the screen.
    const result = await watchInstallation(
      harness.db,
      report([{ name: 'versions', status: 'degraded', detail: 'web 1.3.0, worker 1.2.0' }]),
    );

    expect(result.raised).toBe(0);
    expect(await openInstallationAlerts(harness.db)).toHaveLength(0);
  });

  it('files nothing at all when everything is well', async () => {
    const result = await watchInstallation(
      harness.db,
      report([
        { name: 'database', status: 'ok' },
        { name: 'queue', status: 'ok' },
      ]),
    );

    expect(result).toEqual({ raised: 0, resolved: 0 });
  });
});
