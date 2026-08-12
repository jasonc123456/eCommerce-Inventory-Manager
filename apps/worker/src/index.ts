import { randomUUID } from 'node:crypto';

import { loadConfig } from '@eim/config';
import {
  appliedSchemaVersion,
  connect,
  expectedSchemaVersion,
  businesses,
  pruneHeartbeats,
  recordHeartbeat,
} from '@eim/db';
import { assessHealth, watchInstallation } from '@eim/health';
import { createMailer } from '@eim/mail';
import {
  announceNewAlerts,
  sendDueReminders,
  sendPendingEmail,
  type SweepPorts,
} from '@eim/notifications';
import { createLogger, createMetrics, newCorrelationId, withContext } from '@eim/observability';
import { sweepBusiness } from '@eim/retention';
import { makeWorkerUtils, run, type Runner, type WorkerUtils } from 'graphile-worker';

import { createScheduler } from './scheduler';
import { createTaskList } from './tasks/index';

/**
 * The worker entrypoint (sections 15, 16, 23).
 *
 * One process per replica. Each runs two things: a graphile-worker runner that
 * executes jobs, and a scheduler loop that contends for the lease and drives
 * the cadence if it wins. Section 16 allows several replicas, and nothing here
 * assumes it is the only one.
 *
 * The worker never calls the web tier over loopback HTTP (D-049). Everything it
 * needs is in the database, and a worker that depended on the web tier being up
 * would fail exactly when the web tier is struggling and the queue matters most.
 */

const HEARTBEAT_INTERVAL_MS = 15_000;
/** Section 22's retention is a daily concern, not a per-tick one. */
const RETENTION_INTERVAL_MS = 24 * 60 * 60_000;
const HEARTBEAT_RETENTION_MS = 10 * 60_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const workerId = randomUUID();
  const appVersion = config.EIM_APP_VERSION;

  const logger = createLogger({
    level: config.EIM_LOG_LEVEL,
    component: 'worker',
    pretty: config.NODE_ENV === 'development',
    ...(appVersion === undefined ? {} : { appVersion }),
  });

  const metrics = createMetrics();
  const { pool, db } = connect({
    connectionString: config.EIM_DATABASE_URL,
    applicationName: 'eim-worker',
    onError: (error) => {
      logger.warn({ err: error, event: 'pool_connection_error' }, 'an idle connection failed');
    },
  });

  // Refuse to start against a schema this build was not written for. Section 23
  // runs migrations as a one-shot task before this process, so a mismatch means
  // that task did not run, or ran a different build. Serving anyway would give
  // errors far from the cause.
  const expected = expectedSchemaVersion();
  const applied = await appliedSchemaVersion(pool);

  if (applied !== expected) {
    logger.error(
      { event: 'schema_version_mismatch', schemaVersion: applied },
      `this build expects schema version ${String(expected)} but the database is at ${String(applied)}`,
    );
    await pool.end();
    process.exitCode = 1;
    return;
  }

  metrics.schemaVersion.set(applied);

  // Epoch, so the first tick after a restart sweeps. An installation restarted
  // daily would otherwise never reach the interval.
  let lastRetentionSweepAt = 0;

  const utils: WorkerUtils = await makeWorkerUtils({ pgPool: pool });
  await utils.migrate();

  const runner: Runner = await run({
    pgPool: pool,
    concurrency: 10,
    // Signals are handled below so the scheduler lease is released in the same
    // shutdown sequence rather than racing the runner's own handler.
    noHandleSignals: true,
    taskList: createTaskList({ logger }),
  });

  // Built once. Section 20 requires a generic SMTP relay, and an installation
  // that has one has it for the lifetime of the process; reconnecting per
  // message would put a TLS handshake in front of every alert.
  const mailer = createMailer({
    host: config.EIM_SMTP_HOST,
    port: config.EIM_SMTP_PORT,
    user: config.EIM_SMTP_USER,
    password: config.EIM_SMTP_PASSWORD,
    fromAddress: config.EIM_MAIL_FROM_ADDRESS,
    fromName: config.EIM_MAIL_FROM_NAME,
  });

  const sweepPorts: SweepPorts = {
    db,
    mailer,
    productName: config.EIM_MAIL_FROM_NAME,
    publicUrl: config.EIM_PUBLIC_URL,
  };

  const scheduler = createScheduler({
    db,
    logger,
    holder: { holderId: workerId, ...(appVersion === undefined ? {} : { appVersion }) },
    onTick: async ({ correlationId }) => {
      // M0's tick. The projection sweep that belongs here arrives in M3; what
      // this proves today is that the leader can enqueue work and a worker
      // picks it up.
      await utils.addJob('heartbeat', { correlationId }, { maxAttempts: 3 });

      const oldest = await utils.withPgClient(async (client) => {
        const result = await client.query<{ depth: string; oldest: number | null }>(
          `select count(*)::text as depth,
                  extract(epoch from now() - min(run_at))::float as oldest
             from graphile_worker.jobs
            where locked_at is null`,
        );
        return result.rows[0];
      });

      metrics.queueDepth.set({ queue: 'default' }, Number(oldest?.depth ?? 0));
      metrics.queueOldestAgeSeconds.set({ queue: 'default' }, Math.max(0, oldest?.oldest ?? 0));

      await pruneHeartbeats(db, HEARTBEAT_RETENTION_MS);

      // Section 22's installation watch. Read the machine, then file or
      // withdraw what the reading says — the withdrawal is why this runs every
      // tick rather than only when something breaks: an alert may be resolved
      // "only when a fresh check proves recovery", and this is that check.
      const health = await assessHealth({
        db,
        pool,
        ...(appVersion === undefined ? {} : { appVersion }),
        ...(config.EIM_DATA_ROOT === undefined ? {} : { dataRoot: config.EIM_DATA_ROOT }),
        verifyMail: async () => {
          const outcome = await mailer.verify();
          return outcome.delivered ? { ok: true } : { ok: false, detail: outcome.failure.summary };
        },
      });

      await watchInstallation(db, health);

      // Then tell somebody. Announce and remind decide; send transmits. Keeping
      // them apart is what makes a stuck relay a queue of pending rows rather
      // than a reason alerts stop being raised at all.
      await announceNewAlerts(sweepPorts);
      await sendDueReminders(sweepPorts);
      await sendPendingEmail(sweepPorts);

      // Retention, once a day rather than every tick. Deleting is expensive and
      // nothing here is urgent: a row that is one day past its window is not a
      // problem, and a sweep that ran every thirty seconds would spend the
      // installation's I/O budget proving there was nothing to do.
      if (Date.now() - lastRetentionSweepAt >= RETENTION_INTERVAL_MS) {
        lastRetentionSweepAt = Date.now();

        const shops = await db.select({ id: businesses.id }).from(businesses);

        for (const shop of shops) {
          const outcomes = await sweepBusiness(db, shop.id);
          const removed = outcomes.reduce((total, outcome) => total + outcome.rowsDeleted, 0);

          if (removed > 0) {
            logger.info(
              { event: 'retention_swept', businessId: shop.id, count: removed },
              'retention removed rows past their window',
            );
          }
        }
      }
    },
  });

  const heartbeat = setInterval(() => {
    void withContext({ correlationId: newCorrelationId() }, async () => {
      try {
        await recordHeartbeat(
          db,
          { workerId, role: scheduler.isLeader() ? 'scheduler' : 'worker' },
          0,
          appVersion,
        );
      } catch (error) {
        // Liveness reporting is not worth taking the process down for. Section
        // 22 will alert on the resulting staleness, which is the right way for
        // this to surface.
        logger.warn({ err: error, event: 'heartbeat_failed' }, 'could not record heartbeat');
      }
    });
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  scheduler.start();
  logger.info({ event: 'worker_started', schemaVersion: applied }, 'worker started');

  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      // A second signal during shutdown means somebody is impatient. Honour it:
      // waiting again is how a container ends up SIGKILLed mid-write instead.
      logger.warn({ event: 'worker_shutdown_forced' }, 'second signal; exiting immediately');
      process.exit(1);
    }
    shuttingDown = true;

    logger.info({ event: 'worker_stopping' }, `received ${signal}, stopping`);

    void (async () => {
      clearInterval(heartbeat);
      // Order matters. The lease goes first so another replica can take over
      // the cadence while this one is still draining its in-flight jobs.
      await scheduler.stop();
      await runner.stop();
      await utils.release();
      await pool.end();
      logger.info({ event: 'worker_stopped' }, 'worker stopped');
    })().catch((error: unknown) => {
      logger.error({ err: error, event: 'worker_shutdown_failed' }, 'shutdown failed');
      process.exitCode = 1;
    });
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });

  await runner.promise;
}

await main();
