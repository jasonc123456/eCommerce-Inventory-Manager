import { auditEvents, type Database } from '@eim/db';
import type { AuditResult, AuditSeverity } from '@eim/db';

import type { AuditAction } from './actions';
import { sanitizeDetail } from './detail';

/**
 * Writing to the audit trail (section 19).
 *
 * The writer is a parameter rather than a captured connection, and that is the
 * whole design. An audit record belongs in the same transaction as the change it
 * describes: written outside it, a rolled-back action leaves evidence of
 * something that never happened, and a failed audit write leaves an action with
 * no evidence at all. Both are worse than the failure that caused them.
 *
 *     await db.transaction(async (tx) => {
 *       await tx.update(memberships).set({ role }).where(...);
 *       await recordAuditEvent(tx, { action: 'member.role_changed', ... });
 *     });
 *
 * A denial or a failed sign-in has no transaction of its own, and passing the
 * pool directly is correct there.
 */

/**
 * Anything that can insert.
 *
 * Structural rather than a union of Drizzle's database and transaction types,
 * which differ in their type parameters and would drag every caller into
 * naming them.
 */
export type AuditWriter = Pick<Database, 'insert'>;

export interface AuditActor {
  /** Null for a system or service actor. Required for `user`. */
  readonly userId: string | null;
  readonly kind: 'user' | 'system' | 'service';
}

export interface AuditEventInput {
  readonly action: AuditAction;
  readonly result: AuditResult;
  readonly actor: AuditActor;
  /** Null for installation-level events. */
  readonly businessId?: string | null;
  readonly severity?: AuditSeverity;
  /** What was acted on, such as `membership` and its id. */
  readonly targetType?: string | null;
  readonly targetId?: string | null;
  /** Safe before and after summaries. Passed through `sanitizeDetail` first. */
  readonly detail?: Record<string, unknown>;
  readonly correlationId?: string | null;
  readonly requestIp?: string | null;
  readonly requestUserAgent?: string | null;
}

export class AuditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditError';
  }
}

export async function recordAuditEvent(writer: AuditWriter, input: AuditEventInput): Promise<void> {
  // The database enforces this too. Checking here as well turns a constraint
  // violation thrown from inside somebody else's transaction — which would roll
  // back their work — into a clear error at the call site that caused it.
  if (input.actor.kind === 'user' && input.actor.userId === null) {
    throw new AuditError(
      `${input.action} names a user actor with no user id, which would be a gap in the trail.`,
    );
  }

  await writer.insert(auditEvents).values({
    action: input.action,
    result: input.result,
    severity: input.severity ?? defaultSeverity(input.result),
    actorKind: input.actor.kind,
    actorUserId: input.actor.userId,
    businessId: input.businessId ?? null,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    detail: sanitizeDetail(input.detail ?? {}),
    correlationId: input.correlationId ?? null,
    requestIp: input.requestIp ?? null,
    requestUserAgent: input.requestUserAgent ?? null,
  });
}

/**
 * A recorder with the request's context already applied.
 *
 * Correlation id, client address, and user agent are properties of the request,
 * not of the event, and threading them through every call site is how three of
 * five audit rows end up without them. Anything passed per event still wins, so
 * an action that genuinely belongs to a different actor can say so.
 */
export interface AuditContext {
  readonly actor: AuditActor;
  readonly correlationId?: string | null;
  readonly requestIp?: string | null;
  readonly requestUserAgent?: string | null;
  readonly businessId?: string | null;
}

export interface AuditRecorder {
  record(
    writer: AuditWriter,
    input: Omit<AuditEventInput, 'actor'> & { readonly actor?: AuditActor },
  ): Promise<void>;
}

export function createAuditRecorder(context: AuditContext): AuditRecorder {
  return {
    async record(writer, input) {
      await recordAuditEvent(writer, {
        ...input,
        actor: input.actor ?? context.actor,
        businessId: input.businessId ?? context.businessId ?? null,
        correlationId: input.correlationId ?? context.correlationId ?? null,
        requestIp: input.requestIp ?? context.requestIp ?? null,
        requestUserAgent: input.requestUserAgent ?? context.requestUserAgent ?? null,
      });
    },
  };
}

/**
 * The severity an outcome implies when the caller does not state one.
 *
 * A denial is a `notice` rather than a `warning`: most denials are somebody
 * clicking something they do not have, and treating every one as a warning
 * trains the reader to ignore the level. A failure is a warning because the
 * action was meant to work and did not.
 */
function defaultSeverity(result: AuditResult): AuditSeverity {
  switch (result) {
    case 'success':
      return 'info';
    case 'denied':
      return 'notice';
    case 'failure':
      return 'warning';
  }
}
