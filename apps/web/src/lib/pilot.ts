import { authorize } from '@eim/authz';
import { channelMappings, providerItems } from '@eim/db';
import {
  assessPilot,
  listDrills,
  listIncidents,
  type DrillView,
  type IncidentView,
  type PilotReport,
} from '@eim/pilot';
import { and, desc, eq, sql } from 'drizzle-orm';

import { identity } from './identity';
import { runtime } from './runtime';

/**
 * The pilot screen, wired for the web tier (sections 1, 36).
 *
 * Reading is `view_sync_activity`: the whole screen is a report about how
 * synchronization is going. Changing the stage is `manage_integrations`, because
 * widening a stage is the decision to start writing to a live provider about
 * more things, and that is the permission that governs whether this installation
 * talks to providers at all.
 *
 * Classifying an incident is `resolve_inventory_conflicts`. An oversale is an
 * inventory conflict and this is already the permission for deciding one; a new
 * permission would have been a second answer to a question section 5 has
 * answered.
 *
 * M9 adds no permissions. That is worth stating because a milestone that needed
 * one would be a milestone that had invented a new kind of authority late.
 */

export interface WithheldRow {
  readonly mappingId: string;
  readonly title: string | null;
  readonly intendedQuantity: number;
  readonly observedQuantity: number | null;
  readonly withheldAt: Date;
  readonly reason: string;
}

export interface EnrollableRow {
  readonly mappingId: string;
  readonly title: string | null;
  readonly enrolled: boolean;
}

export interface PilotView {
  readonly report: PilotReport;
  readonly incidents: readonly IncidentView[];
  readonly drills: readonly DrillView[];
  readonly withheld: readonly WithheldRow[];
  readonly enrollable: readonly EnrollableRow[];
  readonly mayStage: boolean;
  readonly mayClassify: boolean;
}

/**
 * Everything the pilot screen shows, or null when this person may not see it.
 *
 * Null rather than an empty report, so the page renders the same "not for you"
 * message it would for somebody who is not a member at all. An empty pilot
 * report and a forbidden one look very different, and only one of them should be
 * distinguishable from outside.
 */
export async function loadPilot(businessId: string, userId: string): Promise<PilotView | null> {
  const { db } = runtime();
  const subject = await identity().memberships.loadSubject(db, businessId, userId);

  if (subject === null || !authorize(subject, 'view_sync_activity').allowed) {
    return null;
  }

  const report = await assessPilot(db, { businessId });

  return {
    report,
    incidents: await listIncidents(db, { businessId, limit: 25 }),
    drills: await listDrills(db, { limit: 10 }),
    withheld: await loadWithheld(db, businessId),
    // Only worth loading where a stage could actually be changed. A full
    // business has nothing to enrol into.
    enrollable: report.stage.stage === 'full' ? [] : await loadEnrollable(db, businessId),
    mayStage: authorize(subject, 'manage_integrations').allowed,
    mayClassify: authorize(subject, 'resolve_inventory_conflicts').allowed,
  };
}

type Db = ReturnType<typeof runtime>['db'];

/**
 * The most recent withheld writes, newest first.
 *
 * Capped at fifty. During `observe` this table gets a row per change, and a
 * screen that rendered a week of them would be a screen nobody opens twice; the
 * point of the list is to show what the system wants to do, and fifty of those
 * says it as well as five thousand.
 */
async function loadWithheld(db: Db, businessId: string): Promise<readonly WithheldRow[]> {
  const rows = await db.execute<{
    mapping_id: string;
    title: string | null;
    intended_quantity: number;
    observed_quantity: number | null;
    withheld_at: string | Date;
    reason: string;
  }>(sql`
    select w.mapping_id, p.title, w.intended_quantity, w.observed_quantity,
           w.withheld_at, w.reason
      from pilot_withheld_writes w
      left join channel_mappings m on m.id = w.mapping_id
      left join provider_items p on p.id = m.provider_item_id
     where w.business_id = ${businessId}::uuid
     order by w.withheld_at desc
     limit 50
  `);

  return rows.rows.map((row) => ({
    mappingId: row.mapping_id,
    title: row.title,
    intendedQuantity: row.intended_quantity,
    observedQuantity: row.observed_quantity,
    withheldAt: row.withheld_at instanceof Date ? row.withheld_at : new Date(row.withheld_at),
    reason: row.reason,
  }));
}

/** Active mappings, with whether each is already in the pilot. */
async function loadEnrollable(db: Db, businessId: string): Promise<readonly EnrollableRow[]> {
  const rows = await db
    .select({
      mappingId: channelMappings.id,
      title: providerItems.title,
      enrolled: sql<boolean>`exists (
        select 1 from pilot_enrollments e
         where e.business_id = ${businessId}
           and e.mapping_id = ${channelMappings.id}
      )`,
    })
    .from(channelMappings)
    .leftJoin(providerItems, eq(providerItems.id, channelMappings.providerItemId))
    .where(and(eq(channelMappings.businessId, businessId), eq(channelMappings.status, 'active')))
    .orderBy(desc(sql`enrolled`), providerItems.title)
    .limit(100);

  return rows.map((row) => ({
    mappingId: row.mappingId,
    title: row.title,
    enrolled: row.enrolled,
  }));
}
