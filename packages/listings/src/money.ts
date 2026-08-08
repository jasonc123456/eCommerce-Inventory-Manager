/**
 * Decimal arithmetic on prices (sections 4, 14, 30).
 *
 * Prices are carried as decimal strings everywhere in this application, for the
 * reason the provider mirror already states: a price that has been through a
 * float is a price that may no longer be the one the provider quoted. That rule
 * is worth nothing if the comparison screen parses those strings into numbers to
 * work out the difference — 12.50 minus 10.30 is 2.1999999999999993 in binary
 * floating point, and a confirmation screen that shows that number has lost the
 * argument for storing strings in the first place.
 *
 * So the arithmetic here is integer arithmetic on scaled `bigint` values, and
 * every result comes back out as a string. Nothing in this module produces a
 * `number`.
 */

export class AmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmountError';
  }
}

interface ScaledAmount {
  /** The amount as an integer, scaled by 10^scale. */
  readonly value: bigint;
  readonly scale: number;
}

/**
 * Deliberately strict: no exponents, no thousands separators, no currency.
 *
 * Written as two whole alternatives rather than one pattern with an optional
 * fractional group. They match the same strings, but nesting a `+` inside a `?`
 * gives the expression a star height of two, which is the shape catastrophic
 * backtracking hides in — and a linter that has to be silenced with a comment
 * every time it is right about the shape is a linter nobody reads.
 */
const AMOUNT = /^-?\d+$|^-?\d+\.\d+$/;

function parse(text: string): ScaledAmount {
  const trimmed = text.trim();
  if (!AMOUNT.test(trimmed)) {
    throw new AmountError(`${text} is not a decimal amount`);
  }

  const point = trimmed.indexOf('.');
  if (point === -1) {
    return { value: BigInt(trimmed), scale: 0 };
  }

  // The digits without the point are the scaled integer: "12.50" is 1250 at
  // scale 2. BigInt keeps the leading minus sign of its own accord.
  return {
    value: BigInt(`${trimmed.slice(0, point)}${trimmed.slice(point + 1)}`),
    scale: trimmed.length - point - 1,
  };
}

/** Both amounts at the same scale, so they can be compared or subtracted. */
function align(left: ScaledAmount, right: ScaledAmount): [bigint, bigint, number] {
  const scale = Math.max(left.scale, right.scale);
  const lift = (amount: ScaledAmount): bigint => amount.value * 10n ** BigInt(scale - amount.scale);

  return [lift(left), lift(right), scale];
}

function format(value: bigint, scale: number): string {
  if (scale === 0) {
    return value.toString();
  }

  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);

  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/** Whether the text is something this module can work with at all. */
export function isAmount(text: string): boolean {
  return AMOUNT.test(text.trim());
}

/**
 * Compares two amounts by value rather than by text.
 *
 * `10.5` and `10.50` are the same price written twice. A comparison that said
 * otherwise would report a change nobody made, and the confirmation screen would
 * offer to copy a price onto itself.
 */
export function compareAmounts(left: string, right: string): -1 | 0 | 1 {
  const [a, b] = align(parse(left), parse(right));
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isSameAmount(left: string, right: string): boolean {
  return compareAmounts(left, right) === 0;
}

/** `left - right`, at whichever scale carries both without rounding. */
export function subtractAmounts(left: string, right: string): string {
  const [a, b, scale] = align(parse(left), parse(right));
  return format(a - b, scale);
}

/**
 * How far `to` is from `from`, as a percentage to two decimal places.
 *
 * Null when `from` is zero, because the change from nothing to something has no
 * percentage — and the alternatives are all worse than saying so. Reporting
 * infinity is not a thing to put on a confirmation screen, and reporting 100%
 * would be a number somebody might act on.
 */
export function percentageDifference(from: string, to: string): string | null {
  const [a, b] = align(parse(from), parse(to));
  if (a === 0n) {
    return null;
  }

  // Scaled up before the division so the two decimal places survive it, then
  // rounded half-away-from-zero rather than truncated: a 4.995% rise reported
  // as 4.99% is a number that does not match the one beside it.
  const scaled = ((b - a) * 1_000_000n) / a;
  const rounded = scaled >= 0n ? (scaled + 50n) / 100n : (scaled - 50n) / 100n;

  return format(rounded, 2);
}
