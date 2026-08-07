import type { QuotaPressure, QuotaState } from './quota-policy';

/**
 * Calling a connection what it actually is (sections 12, 14, 22).
 *
 * Three things kept apart here, because collapsing any two of them sends an
 * operator to fix the wrong thing.
 *
 *   Failing is not the same as degraded. Section 14 requires missing webhook
 *   capability to produce a *visible degraded* status rather than silent
 *   polling, and the distinction is real work: a store whose webhooks cannot be
 *   registered is one this application still synchronizes, more slowly. Marking
 *   it failing would bury it among the ones that are genuinely broken; marking
 *   it healthy would hide a store that is minutes behind rather than seconds.
 *
 *   A circuit is a decision, not a status. What it answers is "should the next
 *   call be attempted", which depends on how long ago the last failure was as
 *   well as on how many there have been. It is derived from the failure tally
 *   rather than stored, so it cannot disagree with the tally it is computed
 *   from — a stored circuit that a crash left open is a connection that never
 *   recovers.
 *
 *   Quota pressure is not failure at all. A connection at 90% of its allowance
 *   is working perfectly; it is the background work that must stop. Reporting
 *   that as a fault would have an operator reauthorizing credentials that are
 *   fine.
 *
 * Separate from the service that reads and writes the health row, because every
 * branch below is a fault that does or does not get named.
 */

export type CircuitState =
  /** Calls proceed. */
  | 'closed'
  /** Too many consecutive failures, too recently. Calls are held back. */
  | 'open'
  /** The cooldown has passed; one call may try, and its outcome decides. */
  | 'half_open';

/**
 * Consecutive failures before calls stop.
 *
 * Five rather than one, because a single timeout is ordinary and a provider that
 * is briefly slow should not take a connection out of service. Five in a row is
 * not weather.
 */
export const CIRCUIT_THRESHOLD = 5;

/** How long an open circuit waits before letting one call test the water. */
export const CIRCUIT_COOLDOWN_MS = 5 * 60_000;

export function circuitStateOf(
  failures: number,
  lastFailureAt: Date | null,
  now: Date,
): CircuitState {
  if (failures < CIRCUIT_THRESHOLD || lastFailureAt === null) {
    return 'closed';
  }

  return now.getTime() - lastFailureAt.getTime() < CIRCUIT_COOLDOWN_MS ? 'open' : 'half_open';
}

/**
 * The tightest of several windows.
 *
 * `unknown` is not a rung on the ladder — it is the absence of one. A window
 * whose limit the provider did not report says nothing about pressure, so it
 * cannot raise the answer to `normal` (which would claim knowledge) or lower it
 * from `high` (which would hide it). It is set aside, and only if every window
 * is unknown is that the answer.
 */
export function worstPressure(states: readonly QuotaState[]): QuotaPressure {
  const ladder: QuotaPressure[] = ['normal', 'warning', 'high', 'critical'];
  const known = states.filter((state) => state.pressure !== 'unknown');

  if (known.length === 0) {
    return 'unknown';
  }

  return known.reduce<QuotaPressure>(
    (worst, state) =>
      ladder.indexOf(state.pressure) > ladder.indexOf(worst) ? state.pressure : worst,
    'normal',
  );
}

interface Decision {
  readonly status: 'healthy' | 'degraded' | 'failing' | 'unknown';
  readonly summary: string;
}

/**
 * What to call a connection, given everything known about it.
 *
 * Ordered worst-first, and the order is the judgement. A paused connection is
 * reported as paused even if its quota is also high, because reauthorizing is
 * what fixes it and the quota will look after itself.
 */
export function decide(input: {
  connectionStatus: string;
  pauseReason: string | null;
  circuit: CircuitState;
  failures: number;
  pressure: QuotaPressure;
  polling: readonly string[];
}): Decision {
  if (input.connectionStatus === 'disconnected' || input.connectionStatus === 'revoked') {
    return { status: 'failing', summary: 'this connection has been disconnected' };
  }

  if (input.connectionStatus === 'paused') {
    return {
      status: 'failing',
      summary: input.pauseReason ?? 'this connection is paused and needs attention',
    };
  }

  if (input.circuit === 'open') {
    return {
      status: 'failing',
      summary: `${String(input.failures)} calls in a row failed; further calls are held back until the provider has had time to recover`,
    };
  }

  if (input.connectionStatus === 'pending') {
    return { status: 'unknown', summary: 'this connection has not been completed yet' };
  }

  if (input.circuit === 'half_open') {
    return {
      status: 'degraded',
      summary: 'recent calls failed; the next one will decide whether the provider has recovered',
    };
  }

  if (input.pressure === 'critical') {
    return {
      status: 'degraded',
      summary: 'the provider allowance is nearly spent; only the most important work is running',
    };
  }

  if (input.polling.length > 0) {
    // Section 14: missing webhook capability produces a visible degraded status.
    // Not `failing` — polling continues and the integration works, more slowly.
    return {
      status: 'degraded',
      summary: `changes to ${input.polling.join(', ')} are found by polling rather than delivered, so they arrive more slowly`,
    };
  }

  if (input.pressure === 'high') {
    return {
      status: 'degraded',
      summary: 'the provider allowance is running low; imports and reconciliation are held back',
    };
  }

  if (input.failures > 0) {
    return {
      status: 'degraded',
      summary: `${String(input.failures)} recent call${input.failures === 1 ? '' : 's'} failed`,
    };
  }

  if (input.pressure === 'warning') {
    return {
      status: 'healthy',
      summary: 'working; the provider allowance is above 70% for this window',
    };
  }

  return { status: 'healthy', summary: 'working' };
}
