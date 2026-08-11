import type { AiProvider, AiRefusalReason } from '@eim/db';

/**
 * What a month of asking is allowed to cost (sections 18, 34).
 *
 * Section 18 requires spend limits and section 34 "token/spend caps". This
 * module is the arithmetic behind both, and it is pure: it reads no clock, no
 * database, and no configuration of its own, so every rule in it can be tested
 * without a provider, a month, or a bill.
 *
 * Three ceilings, and each exists because the other two do not cover it.
 *
 * *Requests* is the ceiling that always applies. A local Ollama costs nothing in
 * money and reports no tokens, and without a request ceiling it would have no
 * ceiling at all — which matters, because the thing it is spending is a shared
 * machine's attention while orders are waiting to be processed (section 12 puts
 * AI work below inventory work for exactly that reason).
 *
 * *Tokens* is the ceiling that catches a runaway. One catalogue description
 * pasted in forty times is forty requests and a hundred thousand tokens, and the
 * request ceiling would not have noticed.
 *
 * *Money* is the ceiling somebody actually cares about, and it is the one this
 * application cannot compute on its own: nobody here knows what a business is
 * paying per million tokens. So the rates are entered by the operator, and the
 * money ceiling exists only when they are. A money cap with no rates behind it
 * would display as a limit and enforce nothing, which is worse than no limit at
 * all — the database refuses that combination outright.
 *
 * Estimates round up. An estimate that understated the spend would let the
 * budget overshoot silently, and the point of a ceiling is that crossing it is
 * refused rather than discovered.
 */

/** The scale every money figure here is computed and stored at. */
const SCALE = 6n;
const SCALE_FACTOR = 10n ** SCALE;
const PER_MILLION = 1_000_000n;

export interface BudgetWindow {
  readonly start: Date;
  readonly end: Date;
}

/**
 * The calendar month containing an instant, in UTC.
 *
 * UTC rather than the business's timezone, deliberately. A budget is a bill, and
 * a bill from a model provider is drawn in the provider's month; anchoring it to
 * a shop's local midnight would make the window disagree with the invoice by a
 * few hours twice a year, which is exactly the kind of difference nobody can
 * reconcile afterwards. The business timezone governs quiet hours and reports,
 * where local midnight is what a person means.
 */
export function monthWindow(now: Date): BudgetWindow {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  return { start, end };
}

/** What has been spent inside a window. Read from the suggestions themselves. */
export interface BudgetUsage {
  readonly requests: number;
  readonly tokens: number;
  /** A decimal string, or null when this configuration prices nothing. */
  readonly costAmount: string | null;
}

export type BudgetVerdict =
  | { readonly allowed: true; readonly remaining: BudgetRemaining }
  | { readonly allowed: false; readonly reason: AiRefusalReason; readonly detail: string };

export interface BudgetRemaining {
  readonly requests: number;
  readonly tokens: number;
  readonly costAmount: string | null;
  readonly costCurrency: string | null;
}

/**
 * Whether one more question is inside every ceiling that applies.
 *
 * Checked before the call, never after. A budget enforced afterwards is a
 * report, and the specification asks for a cap.
 */
export function assessBudget(provider: AiProvider, usage: BudgetUsage): BudgetVerdict {
  if (usage.requests >= provider.monthlyRequestCap) {
    return {
      allowed: false,
      reason: 'request_budget_spent',
      detail: `this month's ${String(provider.monthlyRequestCap)} suggestions have been used`,
    };
  }

  if (usage.tokens >= provider.monthlyTokenCap) {
    return {
      allowed: false,
      reason: 'token_budget_spent',
      detail: `this month's ${String(provider.monthlyTokenCap)} tokens have been used`,
    };
  }

  const cap = provider.monthlyCostCapAmount;

  if (cap !== null && usage.costAmount !== null && compareDecimal(usage.costAmount, cap) >= 0) {
    return {
      allowed: false,
      reason: 'cost_budget_spent',
      detail: `this month's ${cap} ${provider.costCurrency ?? ''} budget has been used`.trimEnd(),
    };
  }

  return {
    allowed: true,
    remaining: {
      requests: provider.monthlyRequestCap - usage.requests,
      tokens: provider.monthlyTokenCap - usage.tokens,
      costAmount: cap === null ? null : subtractDecimal(cap, usage.costAmount ?? '0'),
      costCurrency: provider.costCurrency,
    },
  };
}

/**
 * What one answer cost, or null when this configuration prices nothing.
 *
 * Exact integer arithmetic on scaled values throughout. A price that has been
 * through a double is not a price, and this application says so everywhere else;
 * a budget computed from one would be off by a fraction of a penny per request
 * and by a real number after a thousand of them.
 */
export function estimateCost(
  provider: Pick<AiProvider, 'costPerMillionInputTokens' | 'costPerMillionOutputTokens'>,
  promptTokens: number | null,
  completionTokens: number | null,
): string | null {
  const inputRate = provider.costPerMillionInputTokens;
  const outputRate = provider.costPerMillionOutputTokens;

  if (inputRate === null || outputRate === null) {
    return null;
  }

  const scaled =
    BigInt(promptTokens ?? 0) * toScaled(inputRate) +
    BigInt(completionTokens ?? 0) * toScaled(outputRate);

  // Rounded up, per the note above: the estimate must never be lower than what
  // the provider will actually charge.
  return fromScaled(divideRoundingUp(scaled, PER_MILLION));
}

/** -1, 0, or 1, without either value ever becoming a number. */
export function compareDecimal(left: string, right: string): number {
  const a = toScaled(left);
  const b = toScaled(right);

  return a < b ? -1 : a > b ? 1 : 0;
}

/** `left - right`, floored at zero, because a remaining budget is never owed. */
export function subtractDecimal(left: string, right: string): string {
  const difference = toScaled(left) - toScaled(right);

  return fromScaled(difference < 0n ? 0n : difference);
}

/**
 * A decimal string as an integer scaled by 10^6.
 *
 * Rejects nothing: an unparseable value reads as zero, because every caller here
 * is either a database `numeric` column or a validated form field, and throwing
 * on a budget check would turn a display problem into a refusal to work at all.
 */
function toScaled(value: string): bigint {
  const trimmed = value.trim();
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole = '0', fraction = ''] = unsigned.split('.');

  if (!/^\d*$/.test(whole) || !/^\d*$/.test(fraction)) {
    return 0n;
  }

  // `.5` and `5.` are both things a form or a migration can produce, and both
  // mean what they look like.
  const padded = (fraction + '0'.repeat(Number(SCALE))).slice(0, Number(SCALE));
  const scaled = BigInt(whole === '' ? '0' : whole) * SCALE_FACTOR + BigInt(padded);

  return negative ? -scaled : scaled;
}

/**
 * The inverse, for a value that is never negative.
 *
 * Every caller either estimates a cost, which cannot be below zero, or
 * subtracts through `subtractDecimal`, which floors at zero. A sign branch here
 * would be a branch nothing can reach.
 */
function fromScaled(value: bigint): string {
  const whole = value / SCALE_FACTOR;
  const fraction = (value % SCALE_FACTOR).toString().padStart(Number(SCALE), '0');

  return `${whole.toString()}.${fraction}`;
}

function divideRoundingUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}
