import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Ambient correlation context (section 22).
 *
 * A correlation identifier only earns its keep if it reaches every log line
 * without being threaded through every function signature, because the moment
 * it has to be passed by hand somebody stops passing it and the trail breaks at
 * exactly the layer that failed. `AsyncLocalStorage` propagates it across awaits
 * and timers for free.
 *
 * Only identifiers live here. Anything richer would end up on log lines by way
 * of the ambient merge, which is the one place the field allowlist should never
 * have to argue with a convenience.
 */

export interface CorrelationContext {
  readonly correlationId: string;
  readonly requestId?: string;
  readonly businessId?: string;
  readonly userId?: string;
  readonly jobId?: string;
  readonly connectionId?: string;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

/** A fresh correlation identifier for an inbound request, job, or webhook. */
export function newCorrelationId(): string {
  return randomUUID();
}

/** The context of the current async operation, if one was established. */
export function currentContext(): CorrelationContext | undefined {
  return storage.getStore();
}

/**
 * Runs `operation` inside a correlation context.
 *
 * Nested calls merge onto the enclosing context rather than replacing it, so a
 * job started inside a request keeps the request's correlation identifier
 * unless it deliberately supplies its own.
 */
export function withContext<T>(context: Partial<CorrelationContext>, operation: () => T): T {
  const enclosing = storage.getStore();
  const merged: CorrelationContext = {
    ...enclosing,
    ...context,
    correlationId: context.correlationId ?? enclosing?.correlationId ?? newCorrelationId(),
  };

  return storage.run(merged, operation);
}
