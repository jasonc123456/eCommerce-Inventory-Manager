import { statfs } from 'node:fs/promises';

import {
  appliedSchemaVersion,
  expectedSchemaVersion,
  schedulerLeases,
  workerHeartbeats,
  type Database,
  type DatabasePool,
} from '@eim/db';
import { desc, eq, sql } from 'drizzle-orm';

import {
  backupVerdict,
  clockVerdict,
  diskVerdict,
  heartbeatVerdict,
  queueVerdict,
  worst,
  type DiskReading,
  type HealthCheck,
  type HealthStatus,
} from './policy';

/**
 * The detailed health surface (section 22).
 *
 * Section 22 asks for "an authenticated detailed health UI/API with provider
 * connections, webhooks, quotas, circuits, SMTP, storage, backups, clock,
 * proxy/TLS, migrations, web/worker versions, and remediation".
 *
 * Two rules shape what is below.
 *
 * Every check answers, even when it cannot. A check that throws takes the
 * screen with it, and the screen is the thing an operator opens *because*
 * something is wrong — so a check that fails reports `failing` with a short
 * sentence rather than propagating. The sentence is deliberately bounded and
 * non-sensitive: a connection error carries the host, the port, and sometimes
 * the user.
 *
 * Remediation is part of the check rather than a lookup table on the screen.
 * The person who knows what a stalled queue means is the person writing the
 * check, and a table somewhere else is a table that stops matching.
 */

export interface HealthReport {
  readonly status: HealthStatus;
  readonly checks: readonly HealthCheck[];
  readonly observedAt: Date;
}

export interface HealthPorts {
  readonly db: Database;
  readonly pool: DatabasePool;
  /** Where durable data lives, for the storage check. */
  readonly dataRoot?: string;
  /** The build this process is running, for the version check. */
  readonly appVersion?: string;
  /**
   * Proves the mail transport is usable, without sending anything.
   *
   * A port rather than a mailer, because building one needs credentials this
   * package has no business holding, and because an installation with no relay
   * configured has nothing to verify rather than a broken one.
   */
  readonly verifyMail?: () => Promise<{ readonly ok: boolean; readonly detail?: string }>;
  /** Growth per day, when something has been measuring it. */
  readonly dailyGrowthBytes?: number;
  /** Whether growth-heavy work is currently paused, for the hysteresis. */
  readonly growthPaused?: boolean;
  readonly now?: () => Date;
}

export async function assessHealth(ports: HealthPorts): Promise<HealthReport> {
  const now = ports.now?.() ?? new Date();

  const checks = [
    await databaseCheck(ports),
    await schemaCheck(ports),
    await clockCheck(ports, now),
    await schedulerCheck(ports, now),
    await workerCheck(ports, now),
    await queueCheck(ports),
    await storageCheck(ports),
    await backupCheck(ports, now),
    await mailCheck(ports),
    await versionCheck(ports),
  ];

  return {
    status: worst(checks.map((check) => check.status)),
    checks,
    observedAt: now,
  };
}

async function databaseCheck(ports: HealthPorts): Promise<HealthCheck> {
  try {
    await ports.pool.query('select 1');
    return { name: 'database', status: 'ok' };
  } catch {
    return {
      name: 'database',
      status: 'failing',
      detail: 'unreachable',
      remediation: 'Check that the postgres service is running and the data volume is mounted.',
    };
  }
}

async function schemaCheck(ports: HealthPorts): Promise<HealthCheck> {
  try {
    const expected = expectedSchemaVersion();
    const applied = await appliedSchemaVersion(ports.pool);

    if (applied === expected) {
      return { name: 'schema', status: 'ok', detail: `version ${String(applied)}` };
    }

    return {
      name: 'schema',
      status: 'failing',
      // Version numbers are safe to report and are the single most useful fact
      // when a deployment half-succeeded.
      detail: `expected ${String(expected)}, found ${String(applied)}`,
      remediation:
        applied < expected
          ? 'Run the migration step for this release, then restart the application.'
          : 'This build is older than the schema. Deploy the matching release or restore from backup.',
    };
  } catch {
    return { name: 'schema', status: 'failing', detail: 'could not be determined' };
  }
}

/**
 * Drift between this process and the database.
 *
 * Measured as a round trip and then halved, because the difference observed
 * includes the time the query took. Halving assumes a symmetric round trip,
 * which is wrong in detail and close enough for a check whose thresholds are
 * seconds apart.
 */
async function clockCheck(ports: HealthPorts, now: Date): Promise<HealthCheck> {
  try {
    const started = Date.now();
    const rows = await ports.pool.query<{ now: Date }>('select now() as now');
    const roundTrip = Date.now() - started;

    const databaseNow = rows.rows[0]?.now;

    if (databaseNow === undefined) {
      return { name: 'clock', status: 'degraded', detail: 'the database did not answer' };
    }

    const drift = now.getTime() + roundTrip / 2 - new Date(databaseNow).getTime();
    const verdict = clockVerdict(drift);

    return {
      name: 'clock',
      status: verdict.status,
      detail: verdict.detail,
      ...(verdict.status === 'ok'
        ? {}
        : { remediation: 'Check that NTP is running on this host and on the database host.' }),
    };
  } catch {
    return { name: 'clock', status: 'degraded', detail: 'could not be measured' };
  }
}

async function schedulerCheck(ports: HealthPorts, now: Date): Promise<HealthCheck> {
  try {
    const rows = await ports.db
      .select({ lastHeartbeat: schedulerLeases.lastHeartbeat })
      .from(schedulerLeases)
      .where(eq(schedulerLeases.role, 'scheduler'))
      .limit(1);

    const verdict = heartbeatVerdict(rows[0]?.lastHeartbeat ?? null, now);

    return {
      name: 'scheduler',
      status: verdict.status,
      detail: verdict.detail,
      ...(verdict.status === 'ok'
        ? {}
        : {
            remediation:
              'Nothing is scheduling work. Check that the worker service is running; it elects the scheduler.',
          }),
    };
  } catch {
    return { name: 'scheduler', status: 'degraded', detail: 'could not be read' };
  }
}

async function workerCheck(ports: HealthPorts, now: Date): Promise<HealthCheck> {
  try {
    const rows = await ports.db
      .select({ lastSeenAt: workerHeartbeats.lastSeenAt })
      .from(workerHeartbeats)
      .where(eq(workerHeartbeats.role, 'worker'))
      .orderBy(desc(workerHeartbeats.lastSeenAt))
      .limit(1);

    // The freshest worker, not every worker. One that was replaced during a
    // deployment leaves a stale row behind, and reporting that as a failure
    // would make every restart look like an outage.
    const verdict = heartbeatVerdict(rows[0]?.lastSeenAt ?? null, now);

    return {
      name: 'workers',
      status: verdict.status,
      detail: verdict.detail,
      ...(verdict.status === 'ok'
        ? {}
        : {
            remediation:
              'Synchronization is impaired but the application is still readable. Check the worker container.',
          }),
    };
  } catch {
    return { name: 'workers', status: 'degraded', detail: 'could not be read' };
  }
}

async function queueCheck(ports: HealthPorts): Promise<HealthCheck> {
  try {
    // Against graphile-worker's own table, and tolerant of its absence: an
    // installation that has never started a worker has no queue rather than a
    // broken one.
    const rows = await ports.db.execute<{ depth: number; oldest: number | null }>(sql`
      select count(*)::int as depth,
             extract(epoch from (now() - min(run_at)))::int as oldest
        from graphile_worker.jobs
       where locked_at is null
    `);

    const row = rows.rows[0];
    const verdict = queueVerdict(row?.oldest ?? null, row?.depth ?? 0);

    return {
      name: 'queue',
      status: verdict.status,
      detail: verdict.detail,
      ...(verdict.status === 'ok'
        ? {}
        : {
            remediation: 'Work is not being picked up. Check the worker and the dead-letter list.',
          }),
    };
  } catch {
    return { name: 'queue', status: 'ok', detail: 'no queue has been created yet' };
  }
}

/** Free space on the volume durable data lives on (sections 22, 23). */
export async function readDisk(path: string): Promise<DiskReading | null> {
  try {
    const stats = await statfs(path);

    // `bavail` rather than `bfree`: the reserve blocks only root may use are
    // not space this application can have, and counting them is how a volume
    // reports five percent free right up until a write fails.
    return {
      freeBytes: stats.bavail * stats.bsize,
      totalBytes: stats.blocks * stats.bsize,
    };
  } catch {
    return null;
  }
}

async function storageCheck(ports: HealthPorts): Promise<HealthCheck> {
  const path = ports.dataRoot;

  if (path === undefined) {
    return { name: 'storage', status: 'ok', detail: 'no data root is configured to watch' };
  }

  const reading = await readDisk(path);

  if (reading === null) {
    return {
      name: 'storage',
      status: 'degraded',
      detail: 'the data volume could not be measured',
      remediation: 'Check that the data root exists and is readable by the application user.',
    };
  }

  const verdict = diskVerdict(
    {
      ...reading,
      ...(ports.dailyGrowthBytes === undefined ? {} : { dailyGrowthBytes: ports.dailyGrowthBytes }),
    },
    ports.growthPaused ?? false,
  );

  return {
    name: 'storage',
    status: verdict.status,
    detail: verdict.pauseGrowth ? `${verdict.detail}; growth-heavy work is paused` : verdict.detail,
    ...(verdict.status === 'ok'
      ? {}
      : {
          remediation: 'Free space on the data volume, or move backups and exports off this host.',
        }),
  };
}

async function backupCheck(ports: HealthPorts, now: Date): Promise<HealthCheck> {
  try {
    const rows = await ports.db.execute<{ last_success: Date | string | null }>(sql`
      select max(completed_at) as last_success
        from backup_runs
       where outcome = 'succeeded'
    `);

    const raw = rows.rows[0]?.last_success ?? null;
    const verdict = backupVerdict(raw === null ? null : new Date(raw), now);

    return {
      name: 'backups',
      status: verdict.status,
      detail: verdict.detail,
      ...(verdict.status === 'ok'
        ? {}
        : { remediation: 'Run the backup script by hand and read its output.' }),
    };
  } catch {
    // The table arrives with the backup tooling. Until then this is not a
    // failure, it is a feature that has not been installed.
    return { name: 'backups', status: 'degraded', detail: 'backup history is not recorded yet' };
  }
}

/**
 * Whether mail can leave the building (sections 20, 22).
 *
 * Verified rather than sent. Section 22 lists SMTP on the health surface, and
 * the useful question is whether the relay would accept a message — asking it
 * by sending one would put a test message in somebody's inbox every time an
 * administrator opened this screen.
 */
async function mailCheck(ports: HealthPorts): Promise<HealthCheck> {
  const verify = ports.verifyMail;

  if (verify === undefined) {
    return { name: 'smtp', status: 'ok', detail: 'no relay is configured to check' };
  }

  try {
    const outcome = await verify();

    return outcome.ok
      ? { name: 'smtp', status: 'ok', detail: 'the relay accepted a connection' }
      : {
          name: 'smtp',
          status: 'failing',
          // The port's own short summary, never the driver's error, which
          // quotes the envelope and sometimes the credentials.
          detail: outcome.detail ?? 'the relay refused',
          remediation:
            'Sign-in links and alerts cannot be delivered. Check the SMTP settings in .env.',
        };
  } catch {
    return { name: 'smtp', status: 'failing', detail: 'the relay could not be reached' };
  }
}

/**
 * Whether the web tier and the background tier are the same build.
 *
 * Section 22 asks for web and worker versions on the health surface, and the
 * reason is a mixed rollout: a worker running last week's code against this
 * week's schema is the failure mode that produces symptoms nobody can
 * reproduce.
 */
async function versionCheck(ports: HealthPorts): Promise<HealthCheck> {
  const mine = ports.appVersion;

  if (mine === undefined) {
    return { name: 'versions', status: 'ok', detail: 'this build is not stamped' };
  }

  try {
    const rows = await ports.db
      .select({ appVersion: workerHeartbeats.appVersion })
      .from(workerHeartbeats)
      .orderBy(desc(workerHeartbeats.lastSeenAt))
      .limit(1);

    const theirs = rows[0]?.appVersion ?? null;

    if (theirs === null) {
      return { name: 'versions', status: 'ok', detail: `web ${mine}` };
    }

    return theirs === mine
      ? { name: 'versions', status: 'ok', detail: `web and worker both ${mine}` }
      : {
          name: 'versions',
          status: 'degraded',
          detail: `web ${mine}, worker ${theirs}`,
          remediation: 'Finish the deployment so both tiers run the same release.',
        };
  } catch {
    return { name: 'versions', status: 'ok', detail: `web ${mine}` };
  }
}
