import { auditEvents, type AuditEvent, type Database } from '@eim/db';
import { and, desc, eq, inArray, isNull, lt, type SQL } from 'drizzle-orm';

import type { AuditAction } from './actions';

/**
 * Reading the audit trail.
 *
 * Business and installation history are separate functions rather than one
 * function with an optional business, because they answer to different
 * permissions — `view_audit_logs` and `view_installation_audit` — and a single
 * entry point with a nullable scope is exactly the shape that lets a missing
 * argument return the wrong tenant's history.
 *
 * Neither function checks a permission. Authorization is the caller's decision
 * point (`@eim/authz`), and burying it here would put the check somewhere a
 * reviewer of a route does not look.
 */

export interface AuditQuery {
  /** Newest first, so the cursor is "older than this instant". */
  readonly before?: Date;
  readonly limit?: number;
  readonly actions?: readonly AuditAction[];
  readonly actorUserId?: string;
  readonly correlationId?: string;
}

/** Bounded so a UI cannot ask for the whole table by passing a large number. */
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

export async function readBusinessAuditEvents(
  db: Database,
  businessId: string,
  query: AuditQuery = {},
): Promise<AuditEvent[]> {
  return await run(db, eq(auditEvents.businessId, businessId), query);
}

export async function readInstallationAuditEvents(
  db: Database,
  query: AuditQuery = {},
): Promise<AuditEvent[]> {
  // Installation events are the ones with no business, not "all events". An
  // administrator reading the installation log must not be handed every
  // tenant's history as a side effect of holding a different permission.
  return await run(db, isNull(auditEvents.businessId), query);
}

async function run(db: Database, scope: SQL, query: AuditQuery): Promise<AuditEvent[]> {
  const conditions: SQL[] = [scope];

  if (query.before !== undefined) {
    conditions.push(lt(auditEvents.occurredAt, query.before));
  }

  if (query.actions !== undefined && query.actions.length > 0) {
    conditions.push(inArray(auditEvents.action, [...query.actions]));
  }

  if (query.actorUserId !== undefined) {
    conditions.push(eq(auditEvents.actorUserId, query.actorUserId));
  }

  if (query.correlationId !== undefined) {
    conditions.push(eq(auditEvents.correlationId, query.correlationId));
  }

  return await db
    .select()
    .from(auditEvents)
    .where(and(...conditions))
    .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
    .limit(Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
}
