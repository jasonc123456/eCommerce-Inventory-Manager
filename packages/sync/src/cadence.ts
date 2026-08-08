/**
 * How often to sweep a connection, and why it is not what was asked for
 * (section 15).
 *
 * Pure, so the adaptation rules can be tested for the properties they have to
 * hold rather than by waiting half an hour to watch one. Everything it needs —
 * the quota pressure, the connection's health, how much work is queued — comes
 * in as a parameter.
 *
 * The direction is one-way on purpose. Section 15 permits the scheduler to
 * lengthen the effective interval to protect provider quotas, store capacity,
 * and a growing backlog; it never permits shortening it below what an operator
 * chose. Going slower than asked is a safety measure that can be explained.
 * Going faster is a surprise, and the person who set ten seconds because their
 * store can take it did not ask to be second-guessed upwards.
 */

/** Section 15's bounds on the configurable interval. */
export const MIN_INTERVAL_SECONDS = 10;
export const MAX_INTERVAL_SECONDS = 1800;
export const DEFAULT_INTERVAL_SECONDS = 30;

/** The fixed cadences section 15 sets, which the configurable one does not replace. */
export const FIXED_CADENCES = {
  /** Dirty, failed, or degraded mappings. */
  dirtySweepMs: 5 * 60_000,
  /** Every active mapped inventory unit. */
  fullSweepMs: 30 * 60_000,
  /** The most recent twenty-four hours of orders. */
  orderRescanMs: 60 * 60_000,
  /** Credential, subscription, and webhook health. */
  healthCheckMs: 15 * 60_000,
} as const;

export type QuotaPressure = 'unknown' | 'normal' | 'warning' | 'high' | 'critical';
export type ConnectionHealth = 'healthy' | 'degraded' | 'failing' | 'unknown';

export interface CadenceInput {
  /** What the operator asked for, in seconds. */
  readonly targetIntervalSeconds: number;
  readonly quotaPressure: QuotaPressure;
  readonly health: ConnectionHealth;
  /** Jobs waiting for this connection right now. */
  readonly backlog: number;
  /** How many jobs a sweep of this connection typically produces. */
  readonly backlogTolerance?: number;
}

export interface Cadence {
  readonly targetIntervalSeconds: number;
  readonly effectiveIntervalSeconds: number;
  /** Null when the effective interval is the target. Otherwise, plain words. */
  readonly reason: string | null;
}

const DEFAULT_BACKLOG_TOLERANCE = 100;

/**
 * The interval to actually use, and what stretched it.
 *
 * Each condition contributes a multiplier and the largest wins, rather than the
 * multipliers compounding. A connection that is both rate-limited and unhealthy
 * is one connection in trouble, not two: multiplying would take a thirty-second
 * sweep to twelve minutes and leave it there long after the first cause
 * cleared, which is how adaptive throttling turns into a stall nobody notices.
 */
export function effectiveCadence(input: CadenceInput): Cadence {
  const target = clampInterval(input.targetIntervalSeconds);
  const tolerance = input.backlogTolerance ?? DEFAULT_BACKLOG_TOLERANCE;

  const pressures: { readonly multiplier: number; readonly reason: string }[] = [];

  switch (input.quotaPressure) {
    case 'critical':
      pressures.push({ multiplier: 8, reason: 'the provider quota is nearly spent' });
      break;
    case 'high':
      pressures.push({ multiplier: 4, reason: 'the provider quota is running low' });
      break;
    case 'warning':
      pressures.push({ multiplier: 2, reason: 'the provider quota is under pressure' });
      break;
    case 'normal':
    case 'unknown':
      break;
  }

  switch (input.health) {
    case 'failing':
      pressures.push({ multiplier: 8, reason: 'the connection is failing' });
      break;
    case 'degraded':
      pressures.push({ multiplier: 3, reason: 'the connection is answering unreliably' });
      break;
    case 'healthy':
    case 'unknown':
      break;
  }

  if (input.backlog > tolerance) {
    // Sweeping more often when the previous sweeps have not been worked through
    // adds queue depth without adding throughput. Backing off is what lets the
    // workers catch up.
    const overload = Math.min(8, Math.ceil(input.backlog / Math.max(1, tolerance)));
    pressures.push({
      multiplier: overload,
      reason: `${String(input.backlog)} jobs are still waiting for this connection`,
    });
  }

  const worst = pressures.reduce<{ multiplier: number; reason: string } | null>(
    (chosen, candidate) =>
      chosen === null || candidate.multiplier > chosen.multiplier ? candidate : chosen,
    null,
  );

  if (worst === null || worst.multiplier <= 1) {
    return { targetIntervalSeconds: target, effectiveIntervalSeconds: target, reason: null };
  }

  const stretched = Math.min(MAX_INTERVAL_SECONDS, target * worst.multiplier);

  return {
    targetIntervalSeconds: target,
    effectiveIntervalSeconds: stretched,
    reason: worst.reason,
  };
}

/**
 * Brings a requested interval inside section 15's bounds.
 *
 * Clamps rather than rejects. This is reached from a settings form and from
 * stored rows written by earlier versions, and a scheduler that threw on a
 * value it did not like would stop sweeping a connection because somebody typed
 * five instead of ten.
 */
export function clampInterval(seconds: number): number {
  if (!Number.isFinite(seconds)) {
    return DEFAULT_INTERVAL_SECONDS;
  }

  return Math.min(MAX_INTERVAL_SECONDS, Math.max(MIN_INTERVAL_SECONDS, Math.round(seconds)));
}

/**
 * Whether a recurring sweep is due, with jitter.
 *
 * Section 15 asks for schedule jitter, and the reason is the same one behind
 * full jitter in the retry schedule: a fleet of connections that all became due
 * at the same instant — after a restart, say — would stay synchronized forever,
 * and every sweep would arrive as one spike rather than a stream.
 */
export function isDue(input: {
  readonly lastRunAt: Date | null;
  readonly intervalMs: number;
  readonly now: Date;
  /** Uniform in [0, 1). Injected so the decision is testable. */
  readonly random?: () => number;
}): boolean {
  if (input.lastRunAt === null) {
    return true;
  }

  const elapsed = input.now.getTime() - input.lastRunAt.getTime();
  // Up to a tenth of the interval, added rather than subtracted: a sweep that
  // could fire early would drift the whole schedule forwards over a day.
  const jitter = (input.random ?? Math.random)() * input.intervalMs * 0.1;

  return elapsed >= input.intervalMs + jitter;
}
