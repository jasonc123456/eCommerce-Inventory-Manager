import type { AlertSeverity, Database, InstallationAlertKind } from '@eim/db';
import { raiseAlert, resolveAlertsAbout } from '@eim/notifications';

import type { HealthCheck, HealthStatus } from './policy';
import type { HealthReport } from './report';

/**
 * Turning a health reading into something somebody is told about (section 22).
 *
 * The health screen is a thing an operator has to open. Section 22 also
 * requires that installation administrators are *alerted* about "queue,
 * scheduler, or worker failure, SMTP outage/flood protection, database
 * readiness, backup failure, migration mismatch, critical disk space, or global
 * encryption/configuration problems" — which is the same information arriving
 * without anybody having gone looking for it.
 *
 * This is the join, and it is deliberately the only one. Two separate sets of
 * thresholds — one for the screen, one for the alerts — would eventually
 * disagree, and the disagreement would take the form of a screen saying
 * everything is fine while somebody's phone said otherwise.
 *
 * Resolution is the reason this runs on a schedule rather than on failure.
 * Section 22 auto-resolves "only when a fresh check proves recovery", so the
 * evidence a resolution needs is exactly a health reading taken afterwards —
 * which means the healthy passes matter as much as the failing ones.
 */

/**
 * Which alert each check raises.
 *
 * A check with no kind here appears on the screen and does not wake anybody.
 * That is a real decision per check rather than an oversight: a mixed rollout
 * during a deployment is worth seeing and is not worth a message at midnight,
 * because it resolves itself when the deployment finishes.
 */
const ALERT_FOR: Readonly<Partial<Record<string, InstallationAlertKind>>> = {
  database: 'database_unready',
  schema: 'migration_mismatch',
  scheduler: 'scheduler_unavailable',
  workers: 'worker_unavailable',
  queue: 'queue_stalled',
  storage: 'disk_pressure',
  backups: 'backup_failed',
  smtp: 'smtp_failing',
  clock: 'configuration_invalid',
};

/**
 * Kinds where a failure means the installation has stopped working, rather than
 * that part of it has.
 *
 * Critical is the level that bypasses nothing here — installation alerts have
 * no quiet hours to bypass — but it is what a person scanning a list reads
 * first, so it is spent on the two failures that stop everything else.
 */
const CRITICAL_KINDS: ReadonlySet<InstallationAlertKind> = new Set<InstallationAlertKind>([
  'database_unready',
  'disk_pressure',
]);

function severityFor(kind: InstallationAlertKind, status: HealthStatus): AlertSeverity {
  if (status === 'degraded') {
    return 'warning';
  }

  return CRITICAL_KINDS.has(kind) ? 'critical' : 'error';
}

export interface WatchResult {
  readonly raised: number;
  readonly resolved: number;
}

/**
 * Files an alert for every unhealthy check, and withdraws the ones that recovered.
 *
 * The subject key is the check's own name, so a queue that has been stalling
 * for six hours is one alert with a rising occurrence count rather than one per
 * pass. The state version is the status, so a check that goes from degraded to
 * failing opens a new alert rather than quietly updating the old one's
 * severity — a warning that became a failure is a different sentence, and the
 * history should show both.
 */
export async function watchInstallation(db: Database, report: HealthReport): Promise<WatchResult> {
  let raised = 0;
  let resolved = 0;

  for (const check of report.checks) {
    const kind = ALERT_FOR[check.name];

    if (kind === undefined) {
      continue;
    }

    if (check.status === 'ok') {
      // The fresh check that proves recovery. Both severities are withdrawn,
      // because a check that is now well is well regardless of how badly it was
      // going before.
      for (const state of ['degraded', 'failing']) {
        resolved += await resolveAlertsAbout(db, {
          kind,
          subjectKey: subjectFor(check, state),
          evidence: {
            check: check.name,
            observedAt: report.observedAt.toISOString(),
            detail: check.detail ?? 'the check passed',
          },
        });
      }

      continue;
    }

    await raiseAlert(db, {
      kind,
      severity: severityFor(kind, check.status),
      subjectKey: subjectFor(check, check.status),
      summary: check.detail ?? `${check.name} is ${check.status}`,
      ...(check.remediation === undefined ? {} : { recommendedAction: check.remediation }),
      detail: { check: check.name, status: check.status },
    });

    raised += 1;
  }

  return { raised, resolved };
}

/**
 * What the alert is about.
 *
 * The status is part of the key rather than only part of the payload, so that
 * a check worsening from degraded to failing opens a second alert instead of
 * editing the first. The alternative reads better in a list and loses the
 * moment things got worse, which is the moment somebody will want to find.
 */
function subjectFor(check: HealthCheck, status: string): string {
  return `check:${check.name}:${status}`;
}
