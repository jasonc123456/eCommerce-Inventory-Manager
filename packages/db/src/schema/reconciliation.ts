import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { inventoryLedger } from './inventory';
import { businesses, users } from './tenancy';

/**
 * Typed access to reconciliation and conflicts (sections 12, 15).
 *
 * `migrations/0019_reconciliation.sql` is the source of truth. Two guarantees
 * live only there: one open conflict per mapping per kind, and the check that
 * a resolved conflict names both a resolution and a reason — which is how
 * section 12's "an unresolved mismatch cannot be dismissed" is enforced rather
 * than merely intended.
 */

export const reconciliationScopes = [
  'item',
  'mapping',
  'connection',
  'business',
  'installation',
] as const;
export type ReconciliationScope = (typeof reconciliationScopes)[number];

export const reconciliationTriggers = [
  'scheduled',
  'manual',
  'post_write',
  'post_event',
  'startup',
] as const;
export type ReconciliationTrigger = (typeof reconciliationTriggers)[number];

export const reconciliationRunStatuses = ['running', 'completed', 'failed', 'cancelled'] as const;

export const reconciliationRuns = pgTable(
  'reconciliation_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    connectionId: uuid('connection_id'),
    scope: text('scope', { enum: reconciliationScopes }).notNull(),
    scopeId: uuid('scope_id'),
    trigger: text('trigger', { enum: reconciliationTriggers }).notNull(),
    dryRun: boolean('dry_run').notNull().default(true),
    status: text('status', { enum: reconciliationRunStatuses }).notNull().default('running'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    examined: integer('examined').notNull().default(0),
    matched: integer('matched').notNull().default(0),
    discrepancies: integer('discrepancies').notNull().default(0),
    repaired: integer('repaired').notNull().default(0),
    conflictsOpened: integer('conflicts_opened').notNull().default(0),
    skipped: integer('skipped').notNull().default(0),
    failedCalls: integer('failed_calls').notNull().default(0),
    checkpoint: jsonb('checkpoint').notNull().default({}),
    failureSummary: text('failure_summary'),
    requestedByUserId: uuid('requested_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [index('reconciliation_runs_recent').on(table.businessId, table.startedAt)],
);

export const reconciliationFindingKinds = [
  'match',
  'stale_write',
  'drift',
  'unsupported',
  'unreachable',
] as const;
export type ReconciliationFinding = (typeof reconciliationFindingKinds)[number];

export const reconciliationActions = ['none', 'write', 'conflict'] as const;
export type ReconciliationAction = (typeof reconciliationActions)[number];

export const reconciliationFindings = pgTable(
  'reconciliation_findings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => reconciliationRuns.id, { onDelete: 'cascade' }),
    businessId: uuid('business_id').notNull(),
    mappingId: uuid('mapping_id').notNull(),
    canonicalVersion: bigint('canonical_version', { mode: 'number' }).notNull(),
    observedVersion: text('observed_version'),
    canonicalQuantity: integer('canonical_quantity').notNull(),
    observedQuantity: integer('observed_quantity'),
    finding: text('finding', { enum: reconciliationFindingKinds }).notNull(),
    proposedAction: text('proposed_action', { enum: reconciliationActions })
      .notNull()
      .default('none'),
    applied: boolean('applied').notNull().default(false),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    detail: text('detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('reconciliation_findings_unique').on(table.runId, table.mappingId),
    index('reconciliation_findings_by_run').on(table.runId),
  ],
);

export const conflictKinds = [
  'quantity_drift',
  'oversold',
  'allocation_blocked',
  'entity_missing',
] as const;
export type ConflictKind = (typeof conflictKinds)[number];

export const conflictSeverities = ['low', 'medium', 'high', 'critical'] as const;
export type ConflictSeverity = (typeof conflictSeverities)[number];

export const conflictResolutions = [
  'adopt_external',
  'overwrite_channel',
  'audited_quantity',
  'remap',
  'shortage_disposition',
  'repaired',
] as const;
export type ConflictResolution = (typeof conflictResolutions)[number];

export const inventoryConflicts = pgTable(
  'inventory_conflicts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull(),
    mappingId: uuid('mapping_id'),
    canonicalItemId: uuid('canonical_item_id'),
    connectionId: uuid('connection_id'),
    kind: text('kind', { enum: conflictKinds }).notNull(),
    severity: text('severity', { enum: conflictSeverities }).notNull().default('high'),
    status: text('status', { enum: ['open', 'resolved'] })
      .notNull()
      .default('open'),
    expectedQuantity: integer('expected_quantity'),
    observedQuantity: integer('observed_quantity'),
    summary: text('summary').notNull(),
    runId: uuid('run_id').references(() => reconciliationRuns.id, { onDelete: 'set null' }),
    findingId: uuid('finding_id').references(() => reconciliationFindings.id, {
      onDelete: 'set null',
    }),
    resolution: text('resolution', { enum: conflictResolutions }),
    resolutionReason: text('resolution_reason'),
    resolvedByUserId: uuid('resolved_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    ledgerEntryId: uuid('ledger_entry_id').references(() => inventoryLedger.id, {
      onDelete: 'restrict',
    }),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('inventory_conflicts_open').on(table.businessId, table.severity, table.openedAt),
  ],
);

export type ReconciliationRun = typeof reconciliationRuns.$inferSelect;
export type ReconciliationFindingRow = typeof reconciliationFindings.$inferSelect;
export type InventoryConflict = typeof inventoryConflicts.$inferSelect;
