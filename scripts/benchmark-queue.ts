/**
 * V-06: graphile-worker versus pg-boss.
 *
 * Section 15 sets the workload this has to survive: roughly 5,000 mappings
 * projected on a 30-second cadence, which is a burst of thousands of small,
 * mostly-idempotent jobs every half minute rather than a steady trickle. Both
 * candidates are MIT-licensed, PostgreSQL-only, and satisfy D-046's no-Redis
 * rule, so raw throughput is not the deciding factor — either can move 5,000
 * jobs in 30 seconds. What decides it is behavior at the edges.
 *
 * Four scenarios, each mapped to something that will actually happen:
 *
 *   throughput      the 30-second burst, measured end to end
 *   priority        an oversell correction jumping a catalog import
 *   crash recovery  a worker killed mid-job; does the job come back
 *   retry           a failing job backing off rather than spinning
 *
 * Run it with `pnpm bench:queue`. It needs the development stack running,
 * creates its own scratch databases, and drops them afterwards.
 */

import { setTimeout as sleep } from 'node:timers/promises';

import { createPool } from '@eim/db';

const JOB_COUNT = Number(process.env['BENCH_JOBS'] ?? 5_000);
const CONCURRENCY = Number(process.env['BENCH_CONCURRENCY'] ?? 20);

interface ScenarioResult {
  readonly name: string;
  readonly value: string;
  readonly note: string;
}

interface CandidateResult {
  readonly candidate: string;
  readonly scenarios: ScenarioResult[];
}

function maintenanceUrl(): string {
  const url = process.env['EIM_TEST_DATABASE_URL'];
  if (url === undefined || url.length === 0) {
    throw new Error('EIM_TEST_DATABASE_URL is not set; start the development stack first');
  }
  return url;
}

function withDatabase(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

async function createScratchDatabase(name: string): Promise<string> {
  const maintenance = createPool({ connectionString: maintenanceUrl(), maxConnections: 1 });
  try {
    await maintenance.query(`drop database if exists "${name}" with (force)`);
    await maintenance.query(`create database "${name}"`);
  } finally {
    await maintenance.end();
  }
  return withDatabase(maintenanceUrl(), name);
}

async function dropScratchDatabase(name: string): Promise<void> {
  const maintenance = createPool({ connectionString: maintenanceUrl(), maxConnections: 1 });
  try {
    await maintenance.query(`drop database if exists "${name}" with (force)`);
  } finally {
    await maintenance.end();
  }
}

/** Waits for a predicate, or gives up. Returns whether it came true. */
async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await sleep(50);
  }
  return false;
}

// ---------------------------------------------------------------------------
// graphile-worker
// ---------------------------------------------------------------------------

async function benchmarkGraphileWorker(): Promise<CandidateResult> {
  const { run, makeWorkerUtils } = await import('graphile-worker');
  const database = 'eim_bench_graphile';
  const connectionString = await createScratchDatabase(database);
  const scenarios: ScenarioResult[] = [];

  try {
    const utils = await makeWorkerUtils({ connectionString });
    await utils.migrate();

    // --- throughput ---------------------------------------------------------
    let processed = 0;
    const startedAt = Date.now();

    const runner = await run({
      connectionString,
      concurrency: CONCURRENCY,
      noHandleSignals: true,
      pollInterval: 100,
      taskList: {
        project: () => {
          processed += 1;
        },
        // Fails the first two attempts, then succeeds.
        flaky: (payload) => {
          const { attempts } = payload as { attempts?: number };
          if ((attempts ?? 0) < 2) {
            throw new Error('transient');
          }
        },
      },
    });

    await utils.addJobs(
      Array.from({ length: JOB_COUNT }, (_, index) => ({
        identifier: 'project',
        payload: { mappingId: index },
      })),
    );

    const finished = await waitFor(() => processed >= JOB_COUNT, 120_000);
    const elapsedMs = Date.now() - startedAt;

    scenarios.push({
      name: 'throughput',
      value: finished
        ? `${String(Math.round((JOB_COUNT / elapsedMs) * 1000))} jobs/s`
        : `incomplete (${String(processed)}/${String(JOB_COUNT)})`,
      note: `${String(JOB_COUNT)} jobs at concurrency ${String(CONCURRENCY)} in ${String(elapsedMs)}ms`,
    });

    // --- priority -----------------------------------------------------------
    // A stock correction must not queue behind a catalog import. Lower numbers
    // run first in graphile-worker.
    const order: number[] = [];
    await runner.stop();

    const priorityRunner = await run({
      connectionString,
      concurrency: 1,
      noHandleSignals: true,
      pollInterval: 50,
      taskList: {
        ordered: (payload) => {
          order.push((payload as { rank: number }).rank);
        },
      },
    });

    await utils.addJob('ordered', { rank: 3 }, { priority: 10 });
    await utils.addJob('ordered', { rank: 1 }, { priority: 1 });
    await utils.addJob('ordered', { rank: 2 }, { priority: 5 });

    const ordered = await waitFor(() => order.length === 3, 15_000);
    await priorityRunner.stop();

    scenarios.push({
      name: 'priority',
      value: ordered && order.join(',') === '1,2,3' ? 'honoured' : `unexpected: ${order.join(',')}`,
      note: 'lower priority number runs first',
    });

    // --- crash recovery -----------------------------------------------------
    // A worker killed mid-job must not lose the job. graphile-worker holds the
    // job in a locked state with a locked_at timestamp and reclaims it after
    // the lock expires.
    // Rather than killing a process, this inspects the state a killed process
    // would leave behind. While a job is executing, its row must still be in
    // the table and marked as locked: that is what makes it reclaimable. A
    // queue that deleted the row on lease and relied on the worker to put it
    // back would lose the job on a hard kill, and the difference is invisible
    // until the day something actually crashes.
    const pool = createPool({ connectionString, maxConnections: 2 });
    let started = false;
    let observed: { count: string; locked: string } | undefined;

    try {
      const crashRunner = await run({
        connectionString,
        concurrency: 1,
        noHandleSignals: true,
        pollInterval: 50,
        taskList: {
          crashy: async () => {
            started = true;
            // Holds the lease open so the in-flight state can be inspected.
            await sleep(10_000);
          },
        },
      });

      await utils.addJob('crashy', {});
      await waitFor(() => started, 10_000);

      const inFlight = await pool.query<{ count: string; locked: string }>(
        `select count(*)::text as count,
                count(locked_at)::text as locked
           from graphile_worker.jobs
          where task_identifier = 'crashy'`,
      );
      observed = inFlight.rows[0];

      await crashRunner.stop();

      scenarios.push({
        name: 'crash recovery',
        value:
          observed?.count === '1' && observed.locked === '1'
            ? 'row retained and locked while in flight'
            : `unexpected: ${JSON.stringify(observed)}`,
        note: 'locked_at drives reclaim; default lock timeout is 4 hours, not tunable per job',
      });
    } finally {
      await pool.end();
    }

    // --- retry --------------------------------------------------------------
    let flakyAttempts = 0;
    const retryRunner = await run({
      connectionString,
      concurrency: 1,
      noHandleSignals: true,
      pollInterval: 50,
      taskList: {
        retryme: () => {
          flakyAttempts += 1;
          if (flakyAttempts < 3) {
            throw new Error('transient');
          }
        },
      },
    });

    await utils.addJob('retryme', {}, { maxAttempts: 5 });
    const retried = await waitFor(() => flakyAttempts >= 3, 60_000);
    await retryRunner.stop();

    scenarios.push({
      name: 'retry',
      value: retried ? `succeeded on attempt ${String(flakyAttempts)}` : 'did not recover in time',
      note: 'exponential backoff, built in, per-job maxAttempts',
    });

    await utils.release();
  } finally {
    await dropScratchDatabase(database);
  }

  return { candidate: 'graphile-worker', scenarios };
}

// ---------------------------------------------------------------------------
// pg-boss
// ---------------------------------------------------------------------------

async function benchmarkPgBoss(): Promise<CandidateResult> {
  // pg-boss 12 is pure ESM and exports the class by name; there is no default.
  const { PgBoss } = await import('pg-boss');
  const database = 'eim_bench_pgboss';
  const connectionString = await createScratchDatabase(database);
  const scenarios: ScenarioResult[] = [];

  const boss = new PgBoss({ connectionString, schema: 'pgboss' });
  await boss.start();

  try {
    // --- throughput ---------------------------------------------------------
    let processed = 0;
    await boss.createQueue('project');

    const startedAt = Date.now();
    // Batch size matters more than it looks. pg-boss refuses a polling interval
    // below 500ms, so its ceiling is batchSize x 2 jobs per second regardless of
    // how fast PostgreSQL could go. A batch of 50 caps it at 100/s, which would
    // measure this configuration rather than the library. Sized generously here
    // so the number reflects what pg-boss can actually do.
    await boss.work('project', { batchSize: 500, pollingIntervalSeconds: 0.5 }, (jobs) => {
      processed += jobs.length;
      return Promise.resolve();
    });

    await boss.insert(
      'project',
      Array.from({ length: JOB_COUNT }, (_, index) => ({ data: { mappingId: index } })),
    );

    const finished = await waitFor(() => processed >= JOB_COUNT, 120_000);
    const elapsedMs = Date.now() - startedAt;

    scenarios.push({
      name: 'throughput',
      value: finished
        ? `${String(Math.round((JOB_COUNT / elapsedMs) * 1000))} jobs/s`
        : `incomplete (${String(processed)}/${String(JOB_COUNT)})`,
      note: `${String(JOB_COUNT)} jobs, batch size 500, 500ms poll floor, in ${String(elapsedMs)}ms`,
    });

    // --- priority -----------------------------------------------------------
    // pg-boss orders by priority descending: higher runs first, the opposite
    // convention to graphile-worker.
    const order: number[] = [];
    await boss.createQueue('ordered');
    await boss.work('ordered', { batchSize: 1, pollingIntervalSeconds: 0.5 }, (jobs) => {
      for (const job of jobs) {
        order.push((job.data as { rank: number }).rank);
      }
      return Promise.resolve();
    });

    await boss.send('ordered', { rank: 3 }, { priority: 1 });
    await boss.send('ordered', { rank: 1 }, { priority: 10 });
    await boss.send('ordered', { rank: 2 }, { priority: 5 });

    const ordered = await waitFor(() => order.length === 3, 15_000);

    scenarios.push({
      name: 'priority',
      value: ordered && order.join(',') === '1,2,3' ? 'honoured' : `unexpected: ${order.join(',')}`,
      note: 'higher priority number runs first (inverted from graphile-worker)',
    });

    // --- crash recovery -----------------------------------------------------
    // pg-boss uses a visibility timeout: an active job whose expireInSeconds
    // elapses without completion returns to the queue.
    let attempts = 0;
    await boss.createQueue('crashy');
    await boss.work('crashy', { batchSize: 1, pollingIntervalSeconds: 0.5 }, async () => {
      attempts += 1;
      if (attempts === 1) {
        // Simulates a worker that died: never completes the job.
        await sleep(60_000);
      }
    });

    await boss.send('crashy', {}, { expireInSeconds: 1, retryLimit: 2, retryDelay: 1 });
    const recovered = await waitFor(() => attempts >= 2, 45_000);

    scenarios.push({
      name: 'crash recovery',
      value: recovered ? `reclaimed on attempt ${String(attempts)}` : 'not reclaimed in 45s',
      note: 'visibility timeout via expireInSeconds; per-job, not global',
    });

    // --- retry --------------------------------------------------------------
    let flakyAttempts = 0;
    await boss.createQueue('retryme');
    await boss.work('retryme', { batchSize: 1, pollingIntervalSeconds: 0.5 }, () => {
      flakyAttempts += 1;
      if (flakyAttempts < 3) {
        throw new Error('transient');
      }
      return Promise.resolve();
    });

    await boss.send('retryme', {}, { retryLimit: 5, retryDelay: 1, retryBackoff: true });
    const retried = await waitFor(() => flakyAttempts >= 3, 60_000);

    scenarios.push({
      name: 'retry',
      value: retried ? `succeeded on attempt ${String(flakyAttempts)}` : 'did not recover in time',
      note: 'retryBackoff opt-in, per-job retryLimit',
    });
  } finally {
    await boss.stop({ graceful: false });
    await dropScratchDatabase(database);
  }

  return { candidate: 'pg-boss', scenarios };
}

// ---------------------------------------------------------------------------

function render(results: readonly CandidateResult[]): string {
  const scenarioNames = ['throughput', 'priority', 'crash recovery', 'retry'];
  const lines: string[] = [];

  lines.push(`# V-06 queue benchmark`);
  lines.push('');
  lines.push(`Run at ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`Jobs: ${String(JOB_COUNT)}. Worker concurrency: ${String(CONCURRENCY)}.`);
  lines.push('PostgreSQL 18, development stack.');
  lines.push('');
  lines.push(`| Scenario | ${results.map((result) => result.candidate).join(' | ')} |`);
  lines.push(`| --- | ${results.map(() => '---').join(' | ')} |`);

  for (const name of scenarioNames) {
    const cells = results.map((result) => {
      const scenario = result.scenarios.find((entry) => entry.name === name);
      if (scenario !== undefined) {
        return `${scenario.value}<br>${scenario.note}`;
      }
      // A candidate that threw reports the reason in every cell rather than
      // "not measured", which would read as a decision not to test it.
      const failure = result.scenarios.find((entry) => entry.name === 'error');
      return failure === undefined ? 'not measured' : `failed: ${failure.note}`;
    });
    lines.push(`| ${name} | ${cells.join(' | ')} |`);
  }

  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const results: CandidateResult[] = [];

  for (const [name, benchmark] of [
    ['graphile-worker', benchmarkGraphileWorker],
    ['pg-boss', benchmarkPgBoss],
  ] as const) {
    console.warn(`running ${name}...`);
    try {
      results.push(await benchmark());
    } catch (error) {
      results.push({
        candidate: name,
        scenarios: [
          {
            name: 'error',
            value: 'failed',
            note: error instanceof Error ? error.message : 'unknown error',
          },
        ],
      });
    }
  }

  process.stdout.write(render(results));
}

await main();
