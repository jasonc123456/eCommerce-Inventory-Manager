import type { AiProvider } from '@eim/db';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { assessBudget, compareDecimal, estimateCost, monthWindow, subtractDecimal } from './budget';

/**
 * Section 36's exit gate names a budget test. What is worth proving is that each
 * ceiling refuses on its own, that money never passes through a float, and that
 * an estimate is never lower than what will be charged.
 */

const provider = (overrides: Partial<AiProvider> = {}): AiProvider =>
  ({
    monthlyRequestCap: 100,
    monthlyTokenCap: 50_000,
    monthlyCostCapAmount: null,
    costCurrency: null,
    costPerMillionInputTokens: null,
    costPerMillionOutputTokens: null,
    ...overrides,
  }) as AiProvider;

describe('the window', () => {
  it('is the calendar month in UTC', () => {
    const { start, end } = monthWindow(new Date('2026-08-11T09:30:00Z'));

    expect(start.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('rolls over at the end of a year', () => {
    const { end } = monthWindow(new Date('2026-12-24T23:59:59Z'));

    expect(end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('ceilings', () => {
  it('allows a request inside every one of them', () => {
    const verdict = assessBudget(provider(), { requests: 10, tokens: 900, costAmount: null });

    expect(verdict.allowed).toBe(true);
    expect(verdict.allowed && verdict.remaining.requests).toBe(90);
    expect(verdict.allowed && verdict.remaining.tokens).toBe(49_100);
  });

  it('refuses when the request ceiling is reached', () => {
    const verdict = assessBudget(provider(), { requests: 100, tokens: 0, costAmount: null });

    expect(verdict.allowed).toBe(false);
    expect(!verdict.allowed && verdict.reason).toBe('request_budget_spent');
  });

  it('refuses when the token ceiling is reached, whatever the request count', () => {
    const verdict = assessBudget(provider(), { requests: 1, tokens: 50_000, costAmount: null });

    expect(!verdict.allowed && verdict.reason).toBe('token_budget_spent');
  });

  it('refuses when the money ceiling is reached', () => {
    const priced = provider({
      monthlyCostCapAmount: '20.0000',
      costCurrency: 'GBP',
      costPerMillionInputTokens: '0.150000',
      costPerMillionOutputTokens: '0.600000',
    });

    const verdict = assessBudget(priced, { requests: 1, tokens: 10, costAmount: '20.000000' });

    expect(!verdict.allowed && verdict.reason).toBe('cost_budget_spent');
  });

  it('ignores money entirely when nothing is priced', () => {
    const verdict = assessBudget(provider(), {
      requests: 1,
      tokens: 10,
      costAmount: '999.000000',
    });

    expect(verdict.allowed).toBe(true);
    expect(verdict.allowed && verdict.remaining.costAmount).toBeNull();
  });

  it('reports what is left of the money ceiling', () => {
    const priced = provider({
      monthlyCostCapAmount: '20.0000',
      costCurrency: 'GBP',
      costPerMillionInputTokens: '0.150000',
      costPerMillionOutputTokens: '0.600000',
    });

    const verdict = assessBudget(priced, { requests: 1, tokens: 10, costAmount: '4.500000' });

    expect(verdict.allowed && verdict.remaining.costAmount).toBe('15.500000');
    expect(verdict.allowed && verdict.remaining.costCurrency).toBe('GBP');
  });
});

describe('estimating', () => {
  it('is nothing when the configuration prices nothing', () => {
    expect(estimateCost(provider(), 1_000, 500)).toBeNull();
  });

  it('charges the two rates against the two token counts', () => {
    const priced = provider({
      costPerMillionInputTokens: '2.000000',
      costPerMillionOutputTokens: '10.000000',
    });

    // 1,000,000 in at £2 and 500,000 out at £10 is £2 + £5.
    expect(estimateCost(priced, 1_000_000, 500_000)).toBe('7.000000');
  });

  it('rounds up, so an estimate never understates a bill', () => {
    const priced = provider({
      costPerMillionInputTokens: '1.000000',
      costPerMillionOutputTokens: '0.000000',
    });

    // One token at £1 per million is a millionth of a pound: below the scale
    // being kept, and rounded up rather than away.
    expect(estimateCost(priced, 1, 0)).toBe('0.000001');
  });

  it('treats absent token counts as none', () => {
    const priced = provider({
      costPerMillionInputTokens: '2.000000',
      costPerMillionOutputTokens: '10.000000',
    });

    expect(estimateCost(priced, null, null)).toBe('0.000000');
  });

  it('never produces a negative cost, whatever the token counts', () => {
    fc.assert(
      fc.property(fc.nat({ max: 5_000_000 }), fc.nat({ max: 5_000_000 }), (input, output) => {
        const priced = provider({
          costPerMillionInputTokens: '0.150000',
          costPerMillionOutputTokens: '0.600000',
        });

        expect(
          compareDecimal(estimateCost(priced, input, output) ?? '0', '0'),
        ).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 200 },
    );
  });
});

describe('decimal arithmetic', () => {
  it('compares without going through a float', () => {
    // 0.1 + 0.2 is not 0.3 in a double, and a budget that used one would let
    // this through.
    expect(compareDecimal('0.30', '0.300000')).toBe(0);
    expect(compareDecimal('9.999999', '10')).toBe(-1);
    expect(compareDecimal('10.000001', '10')).toBe(1);
  });

  it('compares large amounts exactly', () => {
    expect(compareDecimal('900719925474.099100', '900719925474.099099')).toBe(1);
  });

  it('never reports a remaining budget that is owed', () => {
    expect(subtractDecimal('5.00', '9.00')).toBe('0.000000');
  });

  it('reads an unparseable amount as nothing rather than throwing', () => {
    expect(() => compareDecimal('not a number', '1')).not.toThrow();
    expect(compareDecimal('not a number', '0')).toBe(0);
    expect(compareDecimal('12.3x', '0')).toBe(0);
  });

  it('reads the abbreviations a form produces', () => {
    expect(compareDecimal('.5', '0.5')).toBe(0);
    expect(compareDecimal('5.', '5')).toBe(0);
    expect(compareDecimal(' 5.00 ', '5')).toBe(0);
  });

  it('keeps a sign, so a negative stored value is not read as a positive one', () => {
    expect(compareDecimal('-1.50', '1.50')).toBe(-1);
    expect(compareDecimal('-1.50', '-1.50')).toBe(0);
  });

  it('discards precision beyond what is kept rather than rounding into it', () => {
    expect(compareDecimal('1.0000004', '1.0000009')).toBe(0);
  });
});
