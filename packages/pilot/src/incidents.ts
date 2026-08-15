import type { PilotClassification, PilotDrillKind, PilotIncidentKind } from '@eim/db';
import { sql } from 'drizzle-orm';

import type { PilotExecutor } from './executor';

/**
 * Incidents and drills: the pilot evidence a query cannot produce (section 1).
 *
 * An incident is filed by whatever noticed — usually the alerting tier — and
 * closed by a person. Section 1's first criterion turns on whether an oversale
 * was "attributable to a synchronization defect", and that is a judgement about
 * cause. Filing it automatically and closing it manually is the only division of
 * labour that respects both halves of that sentence.
 */

/**
 * Files an incident, at most once per alert.
 *
 * The unique index on `alert_id` is what makes this safe to call from an alert
 * path that reminds every few hours. Without it a single unacknowledged oversale
 * would file a fresh incident on every reminder, and the criterion would degrade
 * into a measure of how quickly somebody clicked acknowledge.
 */
export async function fileIncident(
  db: PilotExecutor,
  input: {
    readonly businessId: string;
    readonly kind: PilotIncidentKind;
    readonly summary: string;
    readonly alertId?: string;
    readonly detectedAt?: Date;
  },
): Promise<void> {
  await db.execute(sql`
    insert into pilot_incidents (business_id, kind, summary, alert_id, detected_at)
    values (${input.businessId}::uuid, ${input.kind}, ${input.summary},
            ${input.alertId ?? null}::uuid,
            coalesce(${input.detectedAt?.toISOString() ?? null}::timestamptz, now()))
    on conflict (alert_id) where alert_id is not null do nothing
  `);
}

export type ClassificationResult =
  { readonly classified: true } | { readonly classified: false; readonly reason: string };

/**
 * Closes an incident with a finding.
 *
 * A finding is required and deliberately not defaulted. The database enforces
 * the same rule, so a classification cannot be written from anywhere without
 * saying who decided and why — an unattributed verdict on whether the product
 * oversold someone is worse than no verdict.
 */
export async function classifyIncident(
  db: PilotExecutor,
  input: {
    readonly businessId: string;
    readonly incidentId: string;
    readonly classification: Exclude<PilotClassification, 'unreviewed'>;
    readonly finding: string;
    readonly resolution?: string;
    readonly actorUserId: string;
  },
): Promise<ClassificationResult> {
  if (input.finding.trim().length === 0) {
    return {
      classified: false,
      reason: 'say what you found; a classification alone is an opinion',
    };
  }

  const rows = await db.execute<{ id: string }>(sql`
    update pilot_incidents
       set classification = ${input.classification},
           finding = ${input.finding},
           resolution = ${input.resolution ?? null},
           classified_by_user_id = ${input.actorUserId}::uuid,
           classified_at = now()
     where id = ${input.incidentId}::uuid
       and business_id = ${input.businessId}::uuid
    returning id
  `);

  return rows.rows.length > 0
    ? { classified: true }
    : { classified: false, reason: 'no such incident in this business' };
}

export interface IncidentView {
  readonly id: string;
  readonly kind: PilotIncidentKind;
  readonly detectedAt: Date;
  readonly summary: string;
  readonly classification: PilotClassification;
  readonly finding: string | null;
  readonly resolution: string | null;
}

interface IncidentRow extends Record<string, unknown> {
  id: string;
  kind: PilotIncidentKind;
  detected_at: string | Date;
  summary: string;
  classification: PilotClassification;
  finding: string | null;
  resolution: string | null;
}

/** Unreviewed first: they are the ones holding a criterion open. */
export async function listIncidents(
  db: PilotExecutor,
  input: { readonly businessId: string; readonly limit?: number },
): Promise<readonly IncidentView[]> {
  const rows = await db.execute<IncidentRow>(sql`
    select id, kind, detected_at, summary, classification, finding, resolution
      from pilot_incidents
     where business_id = ${input.businessId}::uuid
     order by (classification = 'unreviewed') desc, detected_at desc
     limit ${input.limit ?? 50}
  `);

  return rows.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    detectedAt: row.detected_at instanceof Date ? row.detected_at : new Date(row.detected_at),
    summary: row.summary,
    classification: row.classification,
    finding: row.finding,
    resolution: row.resolution,
  }));
}

/**
 * Records that a drill was performed.
 *
 * Including a failed one. A drill that did not work is the most useful row in
 * this table — it is the failure that happened while somebody was watching, and
 * suppressing it would leave the pilot looking better than the installation is.
 */
export async function recordDrill(
  db: PilotExecutor,
  input: {
    readonly kind: PilotDrillKind;
    readonly succeeded: boolean;
    readonly summary: string;
    readonly evidenceRef?: string;
    readonly actorUserId: string;
  },
): Promise<void> {
  await db.execute(sql`
    insert into pilot_drills (kind, succeeded, summary, evidence_ref, performed_by_user_id)
    values (${input.kind}, ${input.succeeded}, ${input.summary},
            ${input.evidenceRef ?? null}, ${input.actorUserId}::uuid)
  `);
}

export interface DrillView {
  readonly id: string;
  readonly kind: PilotDrillKind;
  readonly performedAt: Date;
  readonly succeeded: boolean;
  readonly summary: string;
  readonly evidenceRef: string | null;
}

export async function listDrills(
  db: PilotExecutor,
  options: { readonly limit?: number } = {},
): Promise<readonly DrillView[]> {
  const rows = await db.execute<{
    id: string;
    kind: PilotDrillKind;
    performed_at: string | Date;
    succeeded: boolean;
    summary: string;
    evidence_ref: string | null;
  }>(sql`
    select id, kind, performed_at, succeeded, summary, evidence_ref
      from pilot_drills
     order by performed_at desc
     limit ${options.limit ?? 25}
  `);

  return rows.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    performedAt: row.performed_at instanceof Date ? row.performed_at : new Date(row.performed_at),
    succeeded: row.succeeded,
    summary: row.summary,
    evidenceRef: row.evidence_ref,
  }));
}
