/**
 * How a provider call reports what happened.
 *
 * Adapters return outcomes rather than throwing for anything the caller is
 * expected to handle. The retry policy in section 12 turns on precise
 * distinctions — a rate limit waits, a conflict re-reads, an authorization
 * failure stops and alerts rather than retrying into a lockout — and exceptions
 * flatten all of those into "something went wrong", which is exactly the
 * information the scheduler needs and would have lost.
 *
 * A thrown error from an adapter therefore means something genuinely
 * unexpected: a bug, not a provider saying no.
 */

export type ProviderName = 'ebay' | 'woocommerce';

/** The call did what was asked. */
export interface ProviderSuccess<T> {
  readonly status: 'success';
  readonly value: T;
  /** Provider request identifier, when one is returned. Diagnostics only. */
  readonly providerRequestId?: string;
}

/**
 * The provider refused for now and said, or implied, when to come back.
 *
 * `retryAfterMs` is the provider's instruction. Section 12 as amended by D-139
 * governs what happens when it exceeds the dead-letter window: the job is
 * dead-lettered immediately rather than scheduled beyond it, because a retry
 * the system has already promised to abandon is worse than an honest failure.
 */
export interface ProviderRateLimited {
  readonly status: 'rate_limited';
  readonly retryAfterMs: number;
  /** Calls left in the current window, when the provider reports it. */
  readonly remaining?: number;
}

/**
 * Credentials were rejected. Never retried: repeating a rejected credential is
 * how an account gets locked, and the fix is always reauthorization by a human.
 */
export interface ProviderUnauthorized {
  readonly status: 'unauthorized';
  /** Whether the grant is revoked rather than merely expired. */
  readonly requiresReauthorization: boolean;
  readonly message: string;
}

/** The entity does not exist, or no longer does. */
export interface ProviderNotFound {
  readonly status: 'not_found';
  readonly message: string;
}

/**
 * The write raced another change and was rejected on a version check.
 *
 * The correct response is to re-read and recompute, never to retry the same
 * body: the whole point of an optimistic concurrency failure is that the value
 * being written was computed from state that has since moved.
 */
export interface ProviderConflict {
  readonly status: 'conflict';
  readonly message: string;
  /** The version the provider currently holds, when it reports one. */
  readonly currentVersion?: string;
}

/**
 * The provider rejected the request as invalid and will reject it again.
 *
 * Retrying is pointless; the payload or the mapping needs fixing, which is a
 * human decision surfaced as an alert.
 */
export interface ProviderRejected {
  readonly status: 'rejected';
  readonly message: string;
  /** Provider error code, for the operator-facing explanation. */
  readonly code?: string;
}

/**
 * Transport failed, or the provider returned a server error. Retryable under
 * the backoff schedule in section 12.
 */
export interface ProviderUnavailable {
  readonly status: 'unavailable';
  readonly message: string;
  readonly statusCode?: number;
}

export type ProviderFailure =
  | ProviderRateLimited
  | ProviderUnauthorized
  | ProviderNotFound
  | ProviderConflict
  | ProviderRejected
  | ProviderUnavailable;

export type ProviderResult<T> = ProviderSuccess<T> | ProviderFailure;

export function isSuccess<T>(result: ProviderResult<T>): result is ProviderSuccess<T> {
  return result.status === 'success';
}

/**
 * Whether the same call is worth making again unchanged.
 *
 * Deliberately exhaustive rather than defaulting: a new outcome added to the
 * union without a decision here is a compile error, which is the only reliable
 * way to stop a novel failure silently inheriting "retry forever".
 */
export function isRetryable(result: ProviderResult<unknown>): boolean {
  switch (result.status) {
    case 'rate_limited':
    case 'unavailable':
      return true;
    case 'success':
    case 'unauthorized':
    case 'not_found':
    case 'rejected':
      return false;
    case 'conflict':
      // Retryable only after recomputing, which is a different call. Answering
      // false here keeps this function honest about the literal question it is
      // asked: whether to repeat this call unchanged.
      return false;
  }
}

/** A short, non-sensitive description for an alert or an audit entry. */
export function describeFailure(failure: ProviderFailure): string {
  switch (failure.status) {
    case 'rate_limited':
      return `rate limited, retry after ${String(failure.retryAfterMs)}ms`;
    case 'unauthorized':
      return failure.requiresReauthorization
        ? 'authorization revoked; the connection must be reauthorized'
        : 'credentials rejected';
    case 'not_found':
      return 'the provider no longer has this entity';
    case 'conflict':
      return 'the provider state changed during the write';
    case 'rejected':
      return `the provider rejected the request${failure.code === undefined ? '' : ` (${failure.code})`}`;
    case 'unavailable':
      return 'the provider is unavailable';
  }
}
