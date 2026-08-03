import { describe, expect, it } from 'vitest';

import { describeFailure, isRetryable, isSuccess, type ProviderFailure } from './outcomes';

describe('isSuccess', () => {
  it('narrows to the value', () => {
    const result = { status: 'success', value: 42 } as const;

    expect(isSuccess(result) ? result.value : null).toBe(42);
  });

  it('is false for every failure', () => {
    expect(isSuccess({ status: 'not_found', message: 'gone' })).toBe(false);
  });
});

describe('isRetryable', () => {
  it('retries a rate limit and an outage', () => {
    expect(isRetryable({ status: 'rate_limited', retryAfterMs: 100 })).toBe(true);
    expect(isRetryable({ status: 'unavailable', message: 'gateway' })).toBe(true);
  });

  it('never retries rejected credentials', () => {
    // Repeating a rejected credential is how an account gets locked out. The
    // only fix is reauthorization by a human, so section 12 stops and alerts.
    expect(
      isRetryable({ status: 'unauthorized', requiresReauthorization: true, message: 'revoked' }),
    ).toBe(false);
  });

  it('never retries a rejection the provider will repeat', () => {
    expect(isRetryable({ status: 'rejected', message: 'invalid sku' })).toBe(false);
  });

  it('does not retry a conflict unchanged', () => {
    // A conflict means the value was computed against state that has since
    // moved, so the same body is guaranteed to be wrong. The work is retried
    // only after a re-read, which is a different call.
    expect(isRetryable({ status: 'conflict', message: 'version moved' })).toBe(false);
  });
});

describe('describeFailure', () => {
  const failures: ProviderFailure[] = [
    { status: 'rate_limited', retryAfterMs: 2_000 },
    { status: 'unauthorized', requiresReauthorization: true, message: 'revoked' },
    { status: 'unauthorized', requiresReauthorization: false, message: 'bad token' },
    { status: 'not_found', message: 'gone' },
    { status: 'conflict', message: 'moved' },
    { status: 'rejected', message: 'invalid', code: 'E42' },
    { status: 'rejected', message: 'invalid' },
    { status: 'unavailable', message: 'gateway' },
  ];

  it('describes every failure shape', () => {
    for (const failure of failures) {
      expect(describeFailure(failure).length).toBeGreaterThan(0);
    }
  });

  it('distinguishes a revoked grant from a rejected token', () => {
    // The operator-facing difference matters: one needs a click through an
    // authorization flow, the other may resolve on its own.
    expect(
      describeFailure({ status: 'unauthorized', requiresReauthorization: true, message: '' }),
    ).toMatch(/reauthorized/);
    expect(
      describeFailure({ status: 'unauthorized', requiresReauthorization: false, message: '' }),
    ).not.toMatch(/reauthorized/);
  });

  it('includes a provider error code when there is one', () => {
    expect(describeFailure({ status: 'rejected', message: 'x', code: 'E42' })).toContain('E42');
  });
});
