# 3. graphile-worker for the job queue

**Status:** Accepted (M0). Satisfies verification item V-06.

## Context

D-046 rules out Redis: a self-hosted installation should need one data store,
not two. That leaves PostgreSQL-backed queues, and two credible candidates,
both MIT licensed and both actively maintained.

Section 15 sets the workload: roughly 5,000 mappings projected on a 30-second
cadence. That is a burst of thousands of small, idempotent jobs every half
minute rather than a steady trickle, and an oversell correction inside that
burst needs to reach the channel promptly.

## Decision

Use **graphile-worker**.

## Evidence

Measured on PostgreSQL 18, 5,000 jobs, worker concurrency 20. Full output in
[`docs/benchmarks/v-06-queue.md`](../benchmarks/v-06-queue.md); the script is
`scripts/benchmark-queue.ts` and can be re-run with `pnpm bench:queue`.

| Scenario       | graphile-worker                         | pg-boss                                  |
| -------------- | --------------------------------------- | ---------------------------------------- |
| Throughput     | **3,720 jobs/s** (1.34s)                | 993 jobs/s (5.03s)                       |
| Priority       | Honoured (lower number first)           | Honoured (higher number first)           |
| Crash recovery | Row retained and locked while in flight | Reclaimed via per-job visibility timeout |
| Retry          | Exponential backoff built in            | Backoff opt-in per job                   |

The throughput gap is not really about speed. pg-boss refuses a polling interval
below 500ms, so its ceiling is `batchSize × 2` jobs per second no matter what
the database could do, and latency for a single urgent job is bounded below by
that interval. The figure above is with a generous batch size of 500;
a more natural batch of 50 measured 100 jobs/s. graphile-worker uses PostgreSQL
`LISTEN`/`NOTIFY` to wake on enqueue, so a stock correction goes out when it is
created rather than at the next poll.

## Where pg-boss is better

Its visibility timeout is **per job**. graphile-worker reclaims a job stranded by
a crashed worker using a global lock timeout that defaults to four hours and is
not tunable per task. A job that should be retried within a minute of a crash
and one that legitimately runs for an hour cannot be given different reclaim
windows.

This was the only finding that argued the other way, and it is a real cost: it
means a hard-killed worker leaves its in-flight jobs stalled for the lock
timeout. The mitigation is to keep individual jobs short — which section 12
already requires for other reasons — and to lower the global timeout to
something matched to the longest job rather than to the default.

## Consequences

The queue lives in the `graphile_worker` schema of the application database, so
it is inside the same backup and the same transaction boundary as the data. A
job can be enqueued in the transaction that produced the reason for it, which is
what makes the transactional outbox in section 16 work without a second store.

pg-boss is removed from the catalog. Nothing in the application depends on
queue-specific semantics beyond enqueue, retry, and priority, so a future
reversal is contained.

## When to revisit

If the four-hour global lock timeout becomes the thing that hurts — long
catalog imports coexisting with sub-minute projection jobs is the shape that
would cause it — and graphile-worker has not gained per-task timeouts by then.
Re-run `pnpm bench:queue` before deciding; both projects move.
