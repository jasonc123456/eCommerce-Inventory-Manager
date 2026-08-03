import {
  acquireSchedulerLease,
  recordHeartbeat,
  releaseSchedulerLease,
  renewSchedulerLease,
  type Database,
  type LeaseHolder,
} from '@eim/db';
import { withContext, type Logger } from '@eim/observability';

/**
 * The scheduler loop (sections 15, 16).
 *
 * Every worker replica runs this. All of them contend for one lease; the one
 * that holds it drives the cadence and the rest wait, ready to take over. There
 * is no separate scheduler deployment to configure, and no single point of
 * failure that needs a human to notice.
 *
 * Three intervals, and the relationships between them are the design:
 *
 *   tick          how often the leader does its work
 *   renewal       how often the leader extends its lease
 *   lease         how long a lease lasts without renewal
 *
 * Lease duration is several times the renewal interval, so a slow tick or a
 * garbage-collection pause does not hand the clock to another replica. It also
 * bounds the outage after a hard kill: the cadence stalls for at most one lease
 * duration before somebody else takes over. Setting the lease too close to the
 * renewal interval trades an outage nobody would notice for a split brain that
 * doubles every job.
 */

export interface SchedulerOptions {
  readonly db: Database;
  readonly logger: Logger;
  readonly holder: LeaseHolder;
  /** How often the leader runs the tick. Section 15's cadence. */
  readonly tickIntervalMs?: number;
  /** How long a lease survives without renewal. */
  readonly leaseDurationMs?: number;
  /** How often a follower checks whether the lease has fallen free. */
  readonly contendIntervalMs?: number;
  /** The work done on each tick. Errors are logged, never fatal. */
  readonly onTick: (context: { readonly correlationId: string }) => Promise<void>;
}

export interface Scheduler {
  /** Whether this process currently holds the lease. */
  readonly isLeader: () => boolean;
  readonly start: () => void;
  readonly stop: () => Promise<void>;
}

const DEFAULT_TICK_MS = 30_000;
const DEFAULT_LEASE_MS = 90_000;
const DEFAULT_CONTEND_MS = 10_000;

export function createScheduler(options: SchedulerOptions): Scheduler {
  const tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_MS;
  const leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_MS;
  const contendIntervalMs = options.contendIntervalMs ?? DEFAULT_CONTEND_MS;
  const renewIntervalMs = Math.floor(leaseDurationMs / 3);

  let leader = false;
  let running = false;
  let timer: NodeJS.Timeout | undefined;
  /** Resolves when the current loop iteration has finished, for clean shutdown. */
  let inFlight: Promise<void> = Promise.resolve();
  let lastTickAt = 0;
  let lastRenewAt = 0;

  const logger = options.logger;

  function schedule(delayMs: number): void {
    if (!running) {
      return;
    }
    timer = setTimeout(() => {
      inFlight = iterate();
      void inFlight;
    }, delayMs);
    // Do not hold the event loop open on this timer alone. A worker whose only
    // remaining reason to live is its own scheduler timer should exit.
    timer.unref();
  }

  async function iterate(): Promise<void> {
    if (!running) {
      return;
    }

    try {
      await step();
    } catch (error) {
      // A failed step must never stop the loop. The database being briefly
      // unreachable is exactly when the scheduler most needs to still be
      // trying, and an unhandled rejection here would silently end the cadence
      // for the lifetime of the process.
      leader = false;
      logger.error({ err: error, event: 'scheduler_step_failed' }, 'scheduler step failed');
    }

    schedule(leader ? Math.min(renewIntervalMs, tickIntervalMs) : contendIntervalMs);
  }

  async function step(): Promise<void> {
    const now = Date.now();

    if (leader) {
      if (now - lastRenewAt >= renewIntervalMs) {
        const stillLeader = await renewSchedulerLease(options.db, options.holder, leaseDurationMs);
        lastRenewAt = now;

        if (!stillLeader) {
          // Renewal was late enough that somebody else took the lease. Stopping
          // immediately is the whole contract: continuing to schedule would put
          // two processes on one clock.
          leader = false;
          logger.warn({ event: 'scheduler_lease_lost' }, 'lost the scheduler lease');
          return;
        }
      }
    } else {
      const lease = await acquireSchedulerLease(options.db, options.holder, leaseDurationMs);

      if (lease?.holderId !== options.holder.holderId) {
        // Another replica holds it. This is the ordinary state for all but one
        // process and is not worth logging above trace.
        logger.trace({ event: 'scheduler_lease_held_elsewhere' }, 'not the leader');
        return;
      }

      leader = true;
      lastRenewAt = now;
      // Tick immediately on becoming leader rather than waiting a full
      // interval, so a failover does not add a silent gap to the cadence.
      lastTickAt = 0;
      logger.info({ event: 'scheduler_lease_acquired' }, 'acquired the scheduler lease');
    }

    // Only the leader reaches here: every path above that does not hold the
    // lease has already returned. Followers record their own liveness on the
    // heartbeat interval in the entrypoint, so nothing goes unreported.
    await recordHeartbeat(
      options.db,
      { workerId: options.holder.holderId, role: 'scheduler' },
      0,
      options.holder.appVersion,
    );

    if (Date.now() - lastTickAt >= tickIntervalMs) {
      lastTickAt = Date.now();
      const correlationId = crypto.randomUUID();

      await withContext({ correlationId }, async () => {
        try {
          await options.onTick({ correlationId });
        } catch (error) {
          // A failing tick must not cost the lease. Dropping leadership here
          // would hand the clock to a replica likely to fail the same way,
          // turning one broken tick into a leadership flap.
          logger.error({ err: error, event: 'scheduler_tick_failed' }, 'scheduler tick failed');
        }
      });
    }
  }

  return {
    isLeader: () => leader,

    start: () => {
      if (running) {
        return;
      }
      running = true;
      schedule(0);
    },

    stop: async () => {
      running = false;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      await inFlight;

      if (leader) {
        // Releasing deliberately hands over in milliseconds instead of leaving
        // the next replica to wait out the lease, which is what makes a rolling
        // deployment invisible rather than a minute-long stall.
        try {
          await releaseSchedulerLease(options.db, options.holder);
          logger.info({ event: 'scheduler_lease_released' }, 'released the scheduler lease');
        } catch (error) {
          // Safe to fail: the lease expires on its own. Worth reporting,
          // because it means the handover will be slow.
          logger.warn({ err: error, event: 'scheduler_lease_release_failed' }, 'release failed');
        }
        leader = false;
      }
    },
  };
}
