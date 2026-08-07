/**
 * Who may spend what is left of a provider's allowance (sections 12, 13).
 *
 * Section 13 asks for two things that turn out to be the same thing: warn at
 * 70%, 85%, and 95% of a known limit, and reserve capacity for orders,
 * inventory, token refresh, and notification verification while throttling
 * noncritical work first. The warning levels and the throttling levels are the
 * same numbers because they answer the same question from two directions — the
 * point at which an operator should be told is the point at which the cheapest
 * work should stop.
 *
 * So there are three priorities and three ceilings. Background work — imports,
 * reconciliation, reporting — stops at 70%. Ordinary work stops at 85%.
 * Critical work goes on to 95% and then stops too, because a provider that
 * hard-refuses at the limit will refuse an order write exactly as readily as a
 * report, and the last 5% is what a token refresh needs to exist at all.
 *
 * Separate from the ledger that stores the observations, because these are the
 * decisions: every branch below is a priority that does or does not get
 * throttled, and an unmeasured one is a rule that is never applied.
 *
 * Nothing here has a default limit. Section 13 says published limits are
 * informational, and it is right: eBay's documented numbers differ from what a
 * given application is granted, so a hardcoded one would throttle a seller given
 * more and overrun one given less. An unknown limit permits everything and
 * reports that it is unknown, leaving the provider's own refusal as the backstop.
 */

export type QuotaPriority =
  /** Orders, inventory writes, token refresh, notification verification. */
  | 'critical'
  /** Webhook management, readiness checks, anything an operator is waiting for. */
  | 'normal'
  /** Imports, reconciliation, reporting. The first thing to stop. */
  | 'background';

/** The share of a known limit each priority may consume. Section 13's numbers. */
export const CEILINGS: Readonly<Record<QuotaPriority, number>> = {
  background: 0.7,
  normal: 0.85,
  critical: 0.95,
};

export type QuotaPressure = 'unknown' | 'normal' | 'warning' | 'high' | 'critical';

export interface QuotaState {
  readonly provider: 'ebay' | 'woocommerce';
  readonly apiFamily: string;
  readonly connectionId: string | null;
  readonly limit: number | null;
  readonly used: number;
  /** Used over limit, or null when the limit is unknown. */
  readonly fraction: number | null;
  readonly pressure: QuotaPressure;
  readonly windowEndsAt: Date;
}

export interface ObserveQuota {
  readonly provider: 'ebay' | 'woocommerce';
  readonly apiFamily: string;
  readonly businessId?: string | undefined;
  readonly connectionId?: string | undefined;
  /** What the provider said its ceiling is. Null when it does not say. */
  readonly limit: number | null;
  readonly used: number;
  readonly windowStartsAt: Date;
  readonly windowEndsAt: Date;
  readonly now?: Date;
}

export interface QuotaVerdict {
  readonly allowed: boolean;
  readonly pressure: QuotaPressure;
  /** One sentence, for the log line and the interface. */
  readonly summary: string;
  readonly state: QuotaState | null;
}

export function pressureFor(fraction: number | null, limit: number | null): QuotaPressure {
  if (limit !== null && limit <= 0) {
    // Explicitly none left, which is the most pressure there is.
    return 'critical';
  }

  if (fraction === null) {
    return 'unknown';
  }

  if (fraction >= CEILINGS.critical) {
    return 'critical';
  }

  if (fraction >= CEILINGS.normal) {
    return 'high';
  }

  if (fraction >= CEILINGS.background) {
    return 'warning';
  }

  return 'normal';
}

export function verdictFor(state: QuotaState, priority: QuotaPriority): QuotaVerdict {
  if (state.limit !== null && state.limit <= 0) {
    return {
      allowed: false,
      pressure: 'critical',
      summary: `${state.provider} reports no ${state.apiFamily} allowance in this window`,
      state,
    };
  }

  if (state.fraction === null) {
    // An unknown limit permits everything and says so. Guessing a number would
    // throttle an account that was granted more and overrun one granted less;
    // the provider's own refusal is the backstop.
    return {
      allowed: true,
      pressure: 'unknown',
      summary: `${state.provider} does not report a ${state.apiFamily} limit`,
      state,
    };
  }

  const ceiling = CEILINGS[priority];
  const percent = Math.round(state.fraction * 100);

  if (state.fraction >= ceiling) {
    return {
      allowed: false,
      pressure: state.pressure,
      summary:
        priority === 'critical'
          ? `${state.apiFamily} is at ${String(percent)}% of its allowance; even critical work is held back to leave room for token refresh and notification verification`
          : `${state.apiFamily} is at ${String(percent)}% of its allowance, above the ${String(Math.round(ceiling * 100))}% ceiling for ${priority} work`,
      state,
    };
  }

  return {
    allowed: true,
    pressure: state.pressure,
    summary: `${state.apiFamily} is at ${String(percent)}% of its allowance`,
    state,
  };
}

/**
 * Reads eBay's rate-limit response into observations.
 *
 * The shape is `{ rateLimits: [{ apiContext, apiName, apiVersion, resources:
 * [{ name, rates: [{ limit, remaining, reset, timeWindow }] }] }] }`. Every
 * field is checked for the type it must have: a limit read as `undefined` and
 * carried forward becomes an allowance that permits everything.
 */
export function readEbayRateLimits(
  body: string,
  now: Date = new Date(),
): Omit<ObserveQuota, 'businessId' | 'connectionId'>[] {
  let payload: unknown;

  try {
    payload = JSON.parse(body);
  } catch {
    return [];
  }

  const limits = asRecord(payload)?.['rateLimits'];
  const observations: Omit<ObserveQuota, 'businessId' | 'connectionId'>[] = [];

  for (const context of asArray(limits)) {
    const record = asRecord(context);
    const apiName = asString(record?.['apiName']) ?? asString(record?.['apiContext']);

    for (const resource of asArray(record?.['resources'])) {
      const resourceRecord = asRecord(resource);
      const name = asString(resourceRecord?.['name']);

      for (const rate of asArray(resourceRecord?.['rates'])) {
        const rateRecord = asRecord(rate);
        const limit = asNumber(rateRecord?.['limit']);
        const remaining = asNumber(rateRecord?.['remaining']);
        const reset = asDate(rateRecord?.['reset']);
        const seconds = asNumber(rateRecord?.['timeWindow']);

        if (limit === null || remaining === null || reset === null) {
          continue;
        }

        const family = [apiName, name].filter((part) => part !== null).join('.');

        observations.push({
          provider: 'ebay',
          apiFamily: family.length > 0 ? family : 'unknown',
          limit,
          // eBay reports what is left, not what was spent. Clamped, because a
          // remaining count above the limit is nonsense that would otherwise
          // become a negative used count and read as no pressure at all.
          used: Math.max(0, limit - Math.min(remaining, limit)),
          windowStartsAt:
            seconds === null ? now : new Date(reset.getTime() - Math.max(seconds, 1) * 1000),
          windowEndsAt: reset,
          now,
        });
      }
    }
  }

  return observations;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asDate(value: unknown): Date | null {
  if (typeof value !== 'string') {
    return null;
  }

  const parsed = Date.parse(value);

  return Number.isNaN(parsed) ? null : new Date(parsed);
}
