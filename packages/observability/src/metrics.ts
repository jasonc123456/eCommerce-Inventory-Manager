import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus metrics (section 22).
 *
 * Section 22 bans business, user, customer, product, order, listing, and email
 * values as labels. That is not only a privacy rule: Prometheus creates one
 * time series per distinct label combination, so a `businessId` label on a
 * busy installation is how a metrics endpoint turns into an outage. Every label
 * defined below is a bounded enumeration, and the type of `MetricLabels` is
 * what stops a new one being added casually.
 *
 * The registry is constructed rather than global so tests can build an isolated
 * one, and so a process cannot accidentally publish another process's metrics.
 */

/** Outcome of a unit of work. Deliberately three values, not free text. */
export type Outcome = 'success' | 'failure' | 'skipped';

export interface EimMetrics {
  readonly registry: Registry;

  /** Jobs finished, by type and outcome. Queue health at a glance. */
  readonly jobsCompleted: Counter<'jobType' | 'outcome'>;
  /** End-to-end job duration, for the synchronization-lag SLO. */
  readonly jobDuration: Histogram<'jobType'>;
  /** Jobs waiting, by queue. Set by the scheduler on each tick. */
  readonly queueDepth: Gauge<'queue'>;
  /** Age of the oldest waiting job, in seconds. Lag, not throughput. */
  readonly queueOldestAgeSeconds: Gauge<'queue'>;
  /** Jobs that exhausted retries and were dead-lettered. */
  readonly deadLetteredJobs: Counter<'jobType'>;
  /** Provider HTTP calls, by provider and outcome. */
  readonly providerCalls: Counter<'provider' | 'outcome'>;
  /** Provider call latency. Feeds the circuit-breaker rationale. */
  readonly providerLatency: Histogram<'provider'>;
  /** Seconds since each background role last reported alive. */
  readonly heartbeatAgeSeconds: Gauge<'role'>;
  /** Applied schema version, exposed so a version mismatch is alertable. */
  readonly schemaVersion: Gauge;
}

export interface MetricsOptions {
  /**
   * Whether to collect Node's own process metrics: event-loop lag, heap, file
   * descriptors, GC. Cheap, low cardinality, and the first thing worth having
   * when a worker goes quiet.
   */
  readonly collectDefaults?: boolean;
  /** Prefix applied to every metric name. */
  readonly prefix?: string;
}

/**
 * Builds the metric set for a process.
 *
 * Bucket boundaries are chosen against section 15's cadence rather than
 * defaults: the projection loop aims to settle in seconds, so the interesting
 * resolution is below ten seconds, with a long tail to catch a provider that
 * has begun timing out.
 */
export function createMetrics(options: MetricsOptions = {}): EimMetrics {
  const prefix = options.prefix ?? 'eim_';
  const registry = new Registry();

  if (options.collectDefaults ?? true) {
    collectDefaultMetrics({ register: registry, prefix });
  }

  const register = [registry];

  return {
    registry,

    jobsCompleted: new Counter({
      name: `${prefix}jobs_completed_total`,
      help: 'Jobs that reached a terminal state, by type and outcome.',
      labelNames: ['jobType', 'outcome'],
      registers: register,
    }),

    jobDuration: new Histogram({
      name: `${prefix}job_duration_seconds`,
      help: 'Wall-clock duration of a job from lease to terminal state.',
      labelNames: ['jobType'],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300],
      registers: register,
    }),

    queueDepth: new Gauge({
      name: `${prefix}queue_depth`,
      help: 'Jobs waiting to be leased.',
      labelNames: ['queue'],
      registers: register,
    }),

    queueOldestAgeSeconds: new Gauge({
      name: `${prefix}queue_oldest_age_seconds`,
      help: 'Age of the oldest job waiting to be leased.',
      labelNames: ['queue'],
      registers: register,
    }),

    deadLetteredJobs: new Counter({
      name: `${prefix}dead_lettered_jobs_total`,
      help: 'Jobs that exhausted their retry budget and were dead-lettered.',
      labelNames: ['jobType'],
      registers: register,
    }),

    providerCalls: new Counter({
      name: `${prefix}provider_calls_total`,
      help: 'Outbound provider calls, by provider and outcome.',
      labelNames: ['provider', 'outcome'],
      registers: register,
    }),

    providerLatency: new Histogram({
      name: `${prefix}provider_call_duration_seconds`,
      help: 'Latency of outbound provider calls.',
      labelNames: ['provider'],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
      registers: register,
    }),

    heartbeatAgeSeconds: new Gauge({
      name: `${prefix}heartbeat_age_seconds`,
      help: 'Seconds since a background role last recorded a heartbeat.',
      labelNames: ['role'],
      registers: register,
    }),

    schemaVersion: new Gauge({
      name: `${prefix}schema_version`,
      help: 'Database schema version this process expects and observed.',
      registers: register,
    }),
  };
}

/**
 * Times an operation and records it on a histogram.
 *
 * Records on both success and failure, because a metric that only reports happy
 * paths hides precisely the latency that matters: the slow call just before the
 * timeout.
 */
export async function observeDuration<T>(
  histogram: Histogram,
  labels: Readonly<Record<string, string>>,
  operation: () => Promise<T>,
): Promise<T> {
  const stop = histogram.startTimer(labels);
  try {
    return await operation();
  } finally {
    stop();
  }
}
