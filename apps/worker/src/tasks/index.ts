import type { Logger } from '@eim/observability';
import type { TaskList } from 'graphile-worker';

/**
 * The task registry.
 *
 * M0 registers one task, deliberately trivial, whose only job is to prove the
 * path end to end: the scheduler enqueues, the queue persists, a worker leases
 * it, and the outcome is recorded. Section 36's M0 exit gate asks for exactly
 * that and nothing more. The real projection, reconciliation, and provider push
 * tasks arrive with the sync core in M3.
 *
 * Every task added here must satisfy two properties, because the retry policy
 * in section 12 assumes both:
 *
 *   Idempotent. A job may run twice — after an ambiguous timeout, or after a
 *   worker was killed between doing the work and recording that it had. Running
 *   twice must be indistinguishable from running once.
 *
 *   Bounded. A task with no timeout holds a lease and a connection until the
 *   process dies, and section 22's queue-depth alert will show a backlog
 *   growing behind it with no indication of why.
 */

export interface TaskContext {
  readonly logger: Logger;
}

export function createTaskList(context: TaskContext): TaskList {
  return {
    /**
     * Records that the pipeline works. Payload carries the correlation
     * identifier of the tick that enqueued it, so the log line joins up with
     * the scheduler's.
     */
    heartbeat: (payload) => {
      const { correlationId } = (payload ?? {}) as { correlationId?: string };

      context.logger.debug(
        {
          event: 'heartbeat_job',
          ...(correlationId === undefined ? {} : { correlationId }),
        },
        'heartbeat job executed',
      );
    },
  };
}
