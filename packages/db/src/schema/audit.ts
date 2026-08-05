import { index, inet, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Typed access to the audit trail (section 19).
 *
 * The table is append-only, enforced by a trigger rather than by convention, so
 * this surface deliberately exposes no update or delete path. Drizzle would
 * happily generate one; the database refuses it, and the integration suite
 * proves the refusal.
 *
 * `businessId` and `actorUserId` carry no foreign key on purpose. An append-only
 * table cannot have a mutating referential action, and the trail has to outlive
 * what it describes: see the comment above `create table audit_events` in
 * `migrations/0003_identity.sql`.
 */

export const auditActorKinds = ['user', 'system', 'service'] as const;
export type AuditActorKind = (typeof auditActorKinds)[number];

export const auditResults = ['success', 'failure', 'denied'] as const;
export type AuditResult = (typeof auditResults)[number];

export const auditSeverities = ['info', 'notice', 'warning', 'critical'] as const;
export type AuditSeverity = (typeof auditSeverities)[number];

export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Null for installation-level events, which belong to the deployment. */
    businessId: uuid('business_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    actorUserId: uuid('actor_user_id'),
    actorKind: text('actor_kind', { enum: auditActorKinds }).notNull().default('user'),
    /** A dotted identifier such as `auth.login.succeeded`. */
    action: text('action').notNull(),
    result: text('result', { enum: auditResults }).notNull(),
    severity: text('severity', { enum: auditSeverities }).notNull().default('info'),
    targetType: text('target_type'),
    targetId: text('target_id'),
    /**
     * Safe before and after summaries. Never a secret value: what goes in here
     * passes the redaction allowlist in `@eim/observability` first.
     */
    detail: jsonb('detail').notNull().default({}),
    correlationId: uuid('correlation_id'),
    requestIp: inet('request_ip'),
    requestUserAgent: text('request_user_agent'),
  },
  (table) => [index('audit_events_correlation_idx').on(table.correlationId)],
);

export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
