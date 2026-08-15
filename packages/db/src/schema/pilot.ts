import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { businesses, users } from './tenancy';

/**
 * Typed access to the pilot tables (sections 1, 36).
 *
 * `migrations/0031_convergence_samples.sql` and `0032_pilot_stages.sql` are the
 * source of truth. The guarantees that matter — that a converged sample has a
 * time, that a cohort has a ceiling, that latency and SLO scope are computed
 * rather than stored by a caller — live only in the SQL, because a rule enforced
 * in TypeScript is a rule that holds until somebody writes the row from psql.
 */

export const convergenceOriginKinds = [
  'order',
  'restock',
  'adjustment',
  'mapping_change',
  'manual',
  'reconciliation',
  'import',
  'activation',
] as const;
export type ConvergenceOriginKind = (typeof convergenceOriginKinds)[number];

/**
 * The origins section 1's two-minute objective applies to.
 *
 * Individual inventory events, as opposed to imports and full reconciliations.
 * Kept beside the enum so the two cannot drift, and mirrored by a generated
 * column in the database so the classification cannot be edited per row.
 */
export const SLO_SCOPED_ORIGINS: readonly ConvergenceOriginKind[] = [
  'order',
  'restock',
  'adjustment',
  'mapping_change',
  'manual',
];

export const convergenceOutcomes = ['pending', 'converged', 'superseded', 'abandoned'] as const;
export type ConvergenceOutcome = (typeof convergenceOutcomes)[number];

export const convergenceSamples = pgTable(
  'convergence_samples',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    mappingId: uuid('mapping_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    targetVersion: bigint('target_version', { mode: 'number' }).notNull(),
    quantity: integer('quantity').notNull(),
    originKind: text('origin_kind', { enum: convergenceOriginKinds }).notNull(),
    noticedAt: timestamp('noticed_at', { withTimezone: true }).notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
    outcome: text('outcome', { enum: convergenceOutcomes }).notNull().default('pending'),
    convergedAt: timestamp('converged_at', { withTimezone: true }),
    excludedReason: text('excluded_reason'),
    latencyMs: bigint('latency_ms', { mode: 'number' }),
    inSloScope: boolean('in_slo_scope'),
  },
  (table) => [index('convergence_samples_retention').on(table.noticedAt)],
);

export const pilotStages = ['observe', 'single', 'cohort', 'full'] as const;
export type PilotStage = (typeof pilotStages)[number];

/** The stages in which a write may be withheld. `full` withholds nothing. */
export const WITHHOLDING_STAGES: readonly PilotStage[] = ['observe', 'single', 'cohort'];

export const businessPilotStages = pgTable('business_pilot_stages', {
  businessId: uuid('business_id')
    .primaryKey()
    .references(() => businesses.id, { onDelete: 'cascade' }),
  stage: text('stage', { enum: pilotStages }).notNull().default('full'),
  cohortLimit: integer('cohort_limit'),
  pilotStartedAt: timestamp('pilot_started_at', { withTimezone: true }),
  enteredAt: timestamp('entered_at', { withTimezone: true }).notNull().defaultNow(),
  enteredByUserId: uuid('entered_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  note: text('note'),
});

export const pilotEnrollments = pgTable(
  'pilot_enrollments',
  {
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    mappingId: uuid('mapping_id').notNull(),
    enrolledAt: timestamp('enrolled_at', { withTimezone: true }).notNull().defaultNow(),
    enrolledByUserId: uuid('enrolled_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [index('pilot_enrollments_by_business').on(table.businessId, table.enrolledAt)],
);

export const pilotWithheldWrites = pgTable(
  'pilot_withheld_writes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    mappingId: uuid('mapping_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    intendedQuantity: integer('intended_quantity').notNull(),
    observedQuantity: integer('observed_quantity'),
    stage: text('stage', { enum: pilotStages }).notNull(),
    reason: text('reason').notNull(),
    withheldAt: timestamp('withheld_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('pilot_withheld_writes_retention').on(table.withheldAt)],
);

export const pilotIncidentKinds = [
  'oversale',
  'drift',
  'data_loss',
  'missed_objective',
  'other',
] as const;
export type PilotIncidentKind = (typeof pilotIncidentKinds)[number];

export const pilotClassifications = ['unreviewed', 'defect', 'not_a_defect', 'external'] as const;
export type PilotClassification = (typeof pilotClassifications)[number];

export const pilotIncidents = pgTable(
  'pilot_incidents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: pilotIncidentKinds }).notNull(),
    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
    summary: text('summary').notNull(),
    alertId: uuid('alert_id'),
    classification: text('classification', { enum: pilotClassifications })
      .notNull()
      .default('unreviewed'),
    classifiedByUserId: uuid('classified_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    classifiedAt: timestamp('classified_at', { withTimezone: true }),
    finding: text('finding'),
    resolution: text('resolution'),
  },
  (table) => [index('pilot_incidents_by_business').on(table.businessId, table.detectedAt)],
);

export const pilotDrillKinds = ['outage_recovery', 'clean_install', 'server_migration'] as const;
export type PilotDrillKind = (typeof pilotDrillKinds)[number];

export const pilotDrills = pgTable(
  'pilot_drills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind', { enum: pilotDrillKinds }).notNull(),
    performedAt: timestamp('performed_at', { withTimezone: true }).notNull().defaultNow(),
    performedByUserId: uuid('performed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    succeeded: boolean('succeeded').notNull(),
    summary: text('summary').notNull(),
    evidenceRef: text('evidence_ref'),
  },
  (table) => [index('pilot_drills_recent').on(table.kind, table.performedAt)],
);

export type ConvergenceSample = typeof convergenceSamples.$inferSelect;
export type PilotIncident = typeof pilotIncidents.$inferSelect;
export type PilotDrill = typeof pilotDrills.$inferSelect;
export type BusinessPilotStage = typeof businessPilotStages.$inferSelect;
export type PilotEnrollment = typeof pilotEnrollments.$inferSelect;
export type PilotWithheldWrite = typeof pilotWithheldWrites.$inferSelect;
