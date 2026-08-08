import type { JobResult } from '@eim/jobs';
import { describeFailure, type ProviderFailure } from '@eim/providers';

/**
 * What the queue should do about a provider saying no (section 12).
 *
 * One translation, used by every handler. Section 12 draws precise
 * distinctions — a rate limit waits for the stated interval, a conflict
 * recomputes, an authorization failure stops rather than retrying into a
 * lockout — and a second copy of this mapping would drift from the first the
 * moment either changed.
 *
 * Exhaustive on purpose. A new provider outcome added without a decision here
 * becomes a compile error rather than silently inheriting "retry forever",
 * which for a financially consequential write is the worst default available.
 */
export function toJobFailure(failure: ProviderFailure): JobResult {
  switch (failure.status) {
    case 'rate_limited':
      return {
        status: 'failed',
        failureKind: 'rate_limited',
        detail: describeFailure(failure),
        retryable: true,
        retryAfterMs: failure.retryAfterMs,
      };

    case 'unavailable':
      return {
        status: 'failed',
        failureKind: 'unavailable',
        detail: describeFailure(failure),
        retryable: true,
      };

    case 'conflict':
      // Retryable, but only because the next attempt recomputes from a fresh
      // target. Repeating this exact body would race the same way again.
      return {
        status: 'failed',
        failureKind: 'conflict',
        detail: describeFailure(failure),
        retryable: true,
      };

    case 'unauthorized':
    case 'not_found':
    case 'rejected':
      return {
        status: 'failed',
        failureKind: failure.status,
        detail: describeFailure(failure),
        retryable: false,
      };
  }
}
