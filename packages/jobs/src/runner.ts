import type { Database } from '@eim/db';
import { withContext, type Logger } from '@eim/observability';

import { claim, fail, heartbeat, release, succeed, supersede, type ClaimedJob } from './queue';

/**
 * The worker loop (sections 12, 16).
 *
 * A handler returns what happened instead of throwing it. That is the same
 * decision the provider adapters make and for the same reason: the queue has to
 * distinguish "the provider is rate limiting us" from "this payload will never
 * be valid", and an exception flattens both into "something went wrong" —
 * exactly the information the retry policy needs and would have lost.
 *
 * A handler that throws anyway is treated as retryable, because an unexpected
 * exception is more often a transient environment problem than a permanent one,
 * and the ten-attempt ceiling bounds the cost of being wrong about that.
 */

export type JobResult =
  | { readonly status: 'done' }
  /** The work is no longer wanted: a newer target, a deactivated mapping. */
  | { readonly status: 'superseded'; readonly detail: string }
  | {
      readonly status: 'failed';
      readonly failureKind: string;
      readonly detail: string;
      readonly retryable: boolean;
      readonly retryAfterMs?: number;
    };

export interface JobContext {
  readonly logger: Logger;
  /** Extends the claim. Call from anything that may outlive one lease. */
  readonly heartbeat: () => Promise<boolean>;
  /** True once shutdown has begun, so long handlers can stop at a safe point. */
  readonly shuttingDown: () => boolean;
}

export type JobHandler = (job: ClaimedJob, context: JobContext) => Promise<JobResult>;

export interface RunnerOptions {
  readonly db: Database;
  readonly logger: Logger;
  readonly workerId: string;
  readonly handlers: Readonly<Record<string, JobHandler>>;
  /** How many jobs this replica runs at once. */
  readonly concurrency?: number;
  readonly leaseMs?: number;
  /** How long to wait after finding nothing to do. */
  readonly idleDelayMs?: number;
  readonly kinds?: readonly string[];
}

export interface Runner {
  readonly start: () => void;
  readonly stop: () => Promise<void>;
  readonly activeJobs: () => number;
  /** Runs one job if one is available. Exposed for tests and startup recovery. */
  readonly runOnce: () => Promise<boolean>;
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_IDLE_MS = 1_000;

export function createRunner(options: RunnerOptions): Runner {
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const idleDelayMs = options.idleDelayMs ?? DEFAULT_IDLE_MS;
  const kinds = options.kinds ?? Object.keys(options.handlers);

  let running = false;
  let active = 0;
  const lanes = new Set<Promise<void>>();

  async function runOnce(): Promise<boolean> {
    const job = await claim(options.db, {
      workerId: options.workerId,
      leaseMs,
      kinds,
    });

    if (job === null) {
      return false;
    }

    active += 1;

    try {
      await execute(job);
    } finally {
      active -= 1;
    }

    return true;
  }

  async function execute(job: ClaimedJob): Promise<void> {
    const handler = options.handlers[job.kind];
    const logger = options.logger.child({ jobId: job.id, jobKind: job.kind });

    if (handler === undefined) {
      // A kind with no handler on this replica is not a failure of the job. It
      // usually means a rolling deployment where an older replica claimed work
      // only the newer one understands, so hand it straight back.
      await release(options.db, {
        id: job.id,
        attemptId: job.attemptId,
        workerId: options.workerId,
      });
      logger.warn({ event: 'job_kind_unhandled' }, 'no handler for this job kind');
      return;
    }

    // Renewing on a timer rather than between steps: a handler that is inside
    // one long provider call cannot heartbeat itself, and that is precisely
    // when losing the lease would duplicate a write.
    const timer = setInterval(
      () => {
        void heartbeat(options.db, { id: job.id, workerId: options.workerId }, leaseMs).catch(
          (error: unknown) => {
            logger.warn({ err: error, event: 'job_heartbeat_failed' }, 'heartbeat failed');
          },
        );
      },
      Math.max(1_000, Math.floor(leaseMs / 3)),
    );
    timer.unref();

    try {
      const result = await withContext({ correlationId: job.id }, async () =>
        handler(job, {
          logger,
          heartbeat: () =>
            heartbeat(options.db, { id: job.id, workerId: options.workerId }, leaseMs),
          shuttingDown: () => !running,
        }),
      );

      await settle(job, result, logger);
    } catch (error) {
      await fail(options.db, {
        job,
        failureKind: 'handler_threw',
        detail: describe(error),
        retryable: true,
      });
      logger.error({ err: error, event: 'job_handler_threw' }, 'job handler threw');
    } finally {
      clearInterval(timer);
    }
  }

  async function settle(job: ClaimedJob, result: JobResult, logger: Logger): Promise<void> {
    switch (result.status) {
      case 'done':
        await succeed(options.db, { id: job.id, attemptId: job.attemptId });
        logger.debug({ event: 'job_succeeded' }, 'job succeeded');
        return;

      case 'superseded':
        await supersede(options.db, { id: job.id, attemptId: job.attemptId }, result.detail);
        logger.debug({ event: 'job_superseded' }, 'job superseded');
        return;

      case 'failed': {
        const outcome = await fail(options.db, {
          job,
          failureKind: result.failureKind,
          detail: result.detail,
          retryable: result.retryable,
          ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
        });

        if (outcome.outcome === 'dead_letter') {
          logger.error(
            { event: 'job_dead_lettered', reason: outcome.reason, failureKind: result.failureKind },
            'job dead-lettered',
          );
        } else {
          logger.warn(
            { event: 'job_retry_scheduled', runAt: outcome.runAt.toISOString() },
            'job will be retried',
          );
        }
      }
    }
  }

  async function lane(): Promise<void> {
    while (running) {
      let worked = false;

      try {
        worked = await runOnce();
      } catch (error) {
        // The database being briefly unreachable is when the queue most needs
        // to still be trying. Never let one failed claim end the lane.
        options.logger.error({ err: error, event: 'job_claim_failed' }, 'claim failed');
      }

      if (!worked) {
        await delay(idleDelayMs);
      }
    }
  }

  return {
    start: () => {
      if (running) {
        return;
      }
      running = true;

      for (let index = 0; index < concurrency; index += 1) {
        const promise = lane().finally(() => lanes.delete(promise));
        lanes.add(promise);
      }
    },

    stop: async () => {
      // Section 12: "graceful shutdown stops new claims and finishes or
      // releases active jobs." Clearing the flag stops the claims; awaiting the
      // lanes is what finishes the work already in hand.
      running = false;
      await Promise.all([...lanes]);
    },

    activeJobs: () => active,
    runOnce,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
