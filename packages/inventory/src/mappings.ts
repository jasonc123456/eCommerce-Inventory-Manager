import {
  channelMappingLocations,
  channelMappingVersions,
  channelMappings,
  locations,
  providerItems,
  type Database,
  type MappingStatus,
} from '@eim/db';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';

import { isUniqueViolation } from './errors';
import { transactionally } from './ledger';

/**
 * Mapping a canonical item to what a channel sells (sections 6, 7, 9).
 *
 * Section 7's rule that every mapping requires approval is not a workflow
 * nicety. A mapping is the thing that lets this application write a quantity to
 * a live storefront, so an unapproved one is an unreviewed instruction to change
 * what a customer sees. Hence the states: a mapping is proposed, approved by a
 * person, and only then eligible to be activated — and each transition writes a
 * version row, so "who decided this should sell as that" survives the decision.
 *
 * Matching is deliberately weak. Section 7 allows an exact SKU match to be a
 * high-confidence *suggestion* and nothing more, suppresses even that when SKUs
 * are duplicated or missing, and never lets similarity or AI do better than a
 * low-confidence candidate. Nothing in this module creates a mapping without
 * being told to.
 */

export type MappingReader = Pick<Database, 'select'>;
export type MappingDatabase = Pick<Database, 'select' | 'transaction'>;

export interface MappingSummary {
  readonly id: string;
  readonly connectionId: string;
  readonly providerItemId: string;
  readonly canonicalItemId: string;
  readonly status: MappingStatus;
  readonly pauseReason: string | null;
  readonly channelBuffer: number;
  readonly channelCap: number | null;
  readonly version: number;
  readonly locationIds: readonly string[];
  /** From the import, not from this mapping: whether the entity can be synced. */
  readonly externalId: string;
  readonly inventoryEligible: boolean;
  readonly ineligibleReason: string | null;
}

export interface ProposeMappingInput {
  readonly businessId: string;
  readonly connectionId: string;
  readonly providerItemId: string;
  readonly canonicalItemId: string;
  readonly locationIds: readonly string[];
  readonly channelBuffer?: number;
  readonly channelCap?: number | null;
  readonly createdByUserId?: string | null;
  readonly reason?: string | null;
}

export type ProposeMappingResult =
  | { readonly outcome: 'proposed'; readonly mappingId: string }
  /** Section 7: one channel entity belongs to one canonical item at a time. */
  | { readonly outcome: 'entity_already_mapped'; readonly mappingId: string }
  | { readonly outcome: 'invalid'; readonly reason: string };

/**
 * Records a proposed mapping, inactive and unapproved.
 *
 * Creating one writes nothing to any provider and changes no quantity anywhere.
 * That is the point of the draft state: an operator can lay out what should sell
 * as what, see the consequences, and still have decided nothing.
 */
export async function proposeMapping(
  db: MappingDatabase,
  input: ProposeMappingInput,
): Promise<ProposeMappingResult> {
  const invalid = validateRules(input.channelBuffer, input.channelCap);
  if (invalid !== null) {
    return { outcome: 'invalid', reason: invalid };
  }
  if (input.locationIds.length === 0) {
    return { outcome: 'invalid', reason: 'a mapping draws stock from at least one location' };
  }

  const locationIds = [...new Set(input.locationIds)];

  try {
    return await db.transaction(async (tx) => {
      const eligible = await tx
        .select({ id: locations.id })
        .from(locations)
        .where(
          and(
            eq(locations.businessId, input.businessId),
            inArray(locations.id, locationIds),
            eq(locations.isActive, true),
          ),
        );

      if (eligible.length !== locationIds.length) {
        return {
          outcome: 'invalid' as const,
          reason: 'every selected location must be an active location of this business',
        };
      }

      const [mapping] = await tx
        .insert(channelMappings)
        .values({
          businessId: input.businessId,
          connectionId: input.connectionId,
          providerItemId: input.providerItemId,
          canonicalItemId: input.canonicalItemId,
          status: 'draft',
          channelBuffer: input.channelBuffer ?? 0,
          channelCap: input.channelCap ?? null,
          createdByUserId: input.createdByUserId ?? null,
        })
        .returning({ id: channelMappings.id });

      if (mapping === undefined) {
        throw new Error('the mapping could not be created');
      }

      await tx.insert(channelMappingLocations).values(
        locationIds.map((locationId) => ({
          businessId: input.businessId,
          mappingId: mapping.id,
          locationId,
        })),
      );

      await recordVersion(tx, {
        businessId: input.businessId,
        mappingId: mapping.id,
        version: 1,
        canonicalItemId: input.canonicalItemId,
        channelBuffer: input.channelBuffer ?? 0,
        channelCap: input.channelCap ?? null,
        locationIds,
        status: 'draft',
        changeReason: input.reason ?? null,
        createdByUserId: input.createdByUserId ?? null,
      });

      return { outcome: 'proposed' as const, mappingId: mapping.id };
    });
  } catch (error) {
    if (isUniqueViolation(error, 'channel_mappings_one_live_per_entity')) {
      const existing = await readLiveMappingForEntity(db, input);

      return { outcome: 'entity_already_mapped', mappingId: existing ?? '' };
    }

    throw error;
  }
}

export type ApproveMappingResult =
  | { readonly outcome: 'approved'; readonly version: number }
  | { readonly outcome: 'not_found' }
  /** Already approved, or archived. Approving twice is not an error worth
   * inventing a new state for, but it is worth reporting honestly. */
  | { readonly outcome: 'not_approvable'; readonly status: MappingStatus };

/**
 * Approves a proposed mapping.
 *
 * Approval is a decision about intent, not a claim that the mapping works:
 * activation is the separate step that proves the channel entity is eligible and
 * that its siblings are all accounted for. Splitting the two means a mapping can
 * be approved by whoever is authorized to decide, and fail activation for a
 * reason nobody could have known when they decided.
 */
export async function approveMapping(
  db: MappingDatabase,
  input: {
    readonly businessId: string;
    readonly mappingId: string;
    readonly approvedByUserId?: string | null;
    readonly reason?: string | null;
    readonly now?: Date;
  },
): Promise<ApproveMappingResult> {
  return transactionally<ApproveMappingResult>(db, async (tx) => {
    const current = await readForUpdate(tx, input.businessId, input.mappingId);

    if (current === null) {
      return { keep: false, value: { outcome: 'not_found' } };
    }
    if (current.status !== 'draft') {
      return { keep: false, value: { outcome: 'not_approvable', status: current.status } };
    }

    const version = current.version + 1;

    await tx
      .update(channelMappings)
      .set({
        status: 'approved',
        approvedAt: input.now ?? new Date(),
        approvedByUserId: input.approvedByUserId ?? null,
        version,
      })
      .where(eq(channelMappings.id, input.mappingId));

    await recordVersion(tx, {
      businessId: input.businessId,
      mappingId: input.mappingId,
      version,
      canonicalItemId: current.canonicalItemId,
      channelBuffer: current.channelBuffer,
      channelCap: current.channelCap,
      locationIds: current.locationIds,
      status: 'approved',
      changeReason: input.reason ?? null,
      createdByUserId: input.approvedByUserId ?? null,
    });

    return { keep: true, value: { outcome: 'approved', version } };
  });
}

export interface ReviseMappingInput {
  readonly businessId: string;
  readonly mappingId: string;
  readonly channelBuffer?: number;
  readonly channelCap?: number | null;
  readonly locationIds?: readonly string[];
  readonly canonicalItemId?: string;
  readonly reason: string;
  readonly actorUserId?: string | null;
}

export type ReviseMappingResult =
  | { readonly outcome: 'revised'; readonly version: number; readonly status: MappingStatus }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'invalid'; readonly reason: string };

/**
 * Changes a mapping's rules, or what it points at.
 *
 * Section 7 pauses affected synchronization during reassignment, so repointing
 * an active mapping at a different canonical item leaves it paused rather than
 * live: the next write would otherwise advertise a different item's stock
 * against the same listing, with nobody having seen what changed. Changing only
 * a buffer or a cap is not a reassignment and does not pause anything.
 */
export async function reviseMapping(
  db: MappingDatabase,
  input: ReviseMappingInput,
): Promise<ReviseMappingResult> {
  const invalid = validateRules(input.channelBuffer, input.channelCap);
  if (invalid !== null) {
    return { outcome: 'invalid', reason: invalid };
  }
  if (input.reason.trim().length === 0) {
    return { outcome: 'invalid', reason: 'a mapping change needs a stated reason' };
  }
  if (input.locationIds?.length === 0) {
    return { outcome: 'invalid', reason: 'a mapping draws stock from at least one location' };
  }

  return transactionally<ReviseMappingResult>(db, async (tx) => {
    const current = await readForUpdate(tx, input.businessId, input.mappingId);

    if (current === null || current.status === 'archived') {
      return { keep: false, value: { outcome: 'not_found' } };
    }

    const canonicalItemId = input.canonicalItemId ?? current.canonicalItemId;
    const reassigned = canonicalItemId !== current.canonicalItemId;
    const locationIds =
      input.locationIds === undefined ? current.locationIds : [...new Set(input.locationIds)];

    if (input.locationIds !== undefined) {
      const eligible = await tx
        .select({ id: locations.id })
        .from(locations)
        .where(
          and(
            eq(locations.businessId, input.businessId),
            inArray(locations.id, locationIds),
            eq(locations.isActive, true),
          ),
        );

      if (eligible.length !== locationIds.length) {
        return {
          keep: false,
          value: {
            outcome: 'invalid',
            reason: 'every selected location must be an active location of this business',
          },
        };
      }

      await tx
        .delete(channelMappingLocations)
        .where(eq(channelMappingLocations.mappingId, input.mappingId));
      await tx.insert(channelMappingLocations).values(
        locationIds.map((locationId) => ({
          businessId: input.businessId,
          mappingId: input.mappingId,
          locationId,
        })),
      );
    }

    // Section 7: affected synchronization pauses during reassignment. A mapping
    // that has not started synchronizing has nothing to pause.
    const status: MappingStatus =
      reassigned && (current.status === 'active' || current.status === 'paused')
        ? 'paused'
        : current.status;
    const pauseReason =
      status === 'paused'
        ? reassigned
          ? 'the mapping was repointed at a different canonical item and needs reactivating'
          : current.pauseReason
        : null;
    const version = current.version + 1;

    await tx
      .update(channelMappings)
      .set({
        canonicalItemId,
        channelBuffer: input.channelBuffer ?? current.channelBuffer,
        channelCap: input.channelCap === undefined ? current.channelCap : input.channelCap,
        status,
        pauseReason,
        version,
      })
      .where(eq(channelMappings.id, input.mappingId));

    await recordVersion(tx, {
      businessId: input.businessId,
      mappingId: input.mappingId,
      version,
      canonicalItemId,
      channelBuffer: input.channelBuffer ?? current.channelBuffer,
      channelCap: input.channelCap === undefined ? current.channelCap : input.channelCap,
      locationIds,
      status,
      changeReason: input.reason.trim(),
      createdByUserId: input.actorUserId ?? null,
    });

    return { keep: true, value: { outcome: 'revised', version, status } };
  });
}

export type ArchiveMappingResult =
  { readonly outcome: 'archived'; readonly version: number } | { readonly outcome: 'not_found' };

/**
 * Retires a mapping without erasing it (section 7).
 *
 * Archiving frees the channel entity to be mapped again, which is why the
 * uniqueness index is partial. The row and its versions stay, because an order
 * that arrived through this mapping still needs it to be explicable.
 */
export async function archiveMapping(
  db: MappingDatabase,
  input: {
    readonly businessId: string;
    readonly mappingId: string;
    readonly reason?: string | null;
    readonly actorUserId?: string | null;
    readonly now?: Date;
  },
): Promise<ArchiveMappingResult> {
  return transactionally<ArchiveMappingResult>(db, async (tx) => {
    const current = await readForUpdate(tx, input.businessId, input.mappingId);

    if (current === null || current.status === 'archived') {
      return { keep: false, value: { outcome: 'not_found' } };
    }

    const version = current.version + 1;

    await tx
      .update(channelMappings)
      .set({
        status: 'archived',
        pauseReason: null,
        archivedAt: input.now ?? new Date(),
        version,
      })
      .where(eq(channelMappings.id, input.mappingId));

    await recordVersion(tx, {
      businessId: input.businessId,
      mappingId: input.mappingId,
      version,
      canonicalItemId: current.canonicalItemId,
      channelBuffer: current.channelBuffer,
      channelCap: current.channelCap,
      locationIds: current.locationIds,
      status: 'archived',
      changeReason: input.reason ?? null,
      createdByUserId: input.actorUserId ?? null,
    });

    return { keep: true, value: { outcome: 'archived', version } };
  });
}

/** Every mapping of one canonical item, whatever its state. */
export async function readMappingsForItem(
  db: MappingReader,
  input: { readonly businessId: string; readonly canonicalItemId: string },
): Promise<MappingSummary[]> {
  return readMappings(db, [
    eq(channelMappings.businessId, input.businessId),
    eq(channelMappings.canonicalItemId, input.canonicalItemId),
  ]);
}

/** Every mapping of one connection that has not been archived. */
export async function readLiveMappings(
  db: MappingReader,
  input: { readonly businessId: string; readonly connectionId: string },
): Promise<MappingSummary[]> {
  return readMappings(db, [
    eq(channelMappings.businessId, input.businessId),
    eq(channelMappings.connectionId, input.connectionId),
    ne(channelMappings.status, 'archived'),
  ]);
}

export async function readMapping(
  db: MappingReader,
  input: { readonly businessId: string; readonly mappingId: string },
): Promise<MappingSummary | null> {
  const [row] = await readMappings(db, [
    eq(channelMappings.businessId, input.businessId),
    eq(channelMappings.id, input.mappingId),
  ]);

  return row ?? null;
}

async function readMappings(
  db: MappingReader,
  conditions: readonly ReturnType<typeof eq>[],
): Promise<MappingSummary[]> {
  const rows = await db
    .select({
      id: channelMappings.id,
      connectionId: channelMappings.connectionId,
      providerItemId: channelMappings.providerItemId,
      canonicalItemId: channelMappings.canonicalItemId,
      status: channelMappings.status,
      pauseReason: channelMappings.pauseReason,
      channelBuffer: channelMappings.channelBuffer,
      channelCap: channelMappings.channelCap,
      version: channelMappings.version,
      externalId: providerItems.externalId,
      inventoryEligible: providerItems.inventoryEligible,
      ineligibleReason: providerItems.ineligibleReason,
      // Aggregated rather than a second query, because a mapping without its
      // locations is not a mapping anyone can act on.
      locationIds: sql<
        string[]
      >`coalesce(array_agg(${channelMappingLocations.locationId}) filter (where ${channelMappingLocations.locationId} is not null), '{}')`,
    })
    .from(channelMappings)
    .innerJoin(providerItems, eq(providerItems.id, channelMappings.providerItemId))
    .leftJoin(channelMappingLocations, eq(channelMappingLocations.mappingId, channelMappings.id))
    .where(and(...conditions))
    .groupBy(
      channelMappings.id,
      providerItems.externalId,
      providerItems.inventoryEligible,
      providerItems.ineligibleReason,
    )
    .orderBy(asc(channelMappings.createdAt));

  return rows;
}

/** Every version of one mapping, newest first (section 7). */
export async function readMappingHistory(
  db: MappingReader,
  input: { readonly businessId: string; readonly mappingId: string },
): Promise<
  {
    readonly version: number;
    readonly status: MappingStatus;
    readonly canonicalItemId: string;
    readonly channelBuffer: number;
    readonly channelCap: number | null;
    readonly locationIds: readonly string[];
    readonly changeReason: string | null;
    readonly createdAt: Date;
  }[]
> {
  return db
    .select({
      version: channelMappingVersions.version,
      status: channelMappingVersions.status,
      canonicalItemId: channelMappingVersions.canonicalItemId,
      channelBuffer: channelMappingVersions.channelBuffer,
      channelCap: channelMappingVersions.channelCap,
      locationIds: channelMappingVersions.locationIds,
      changeReason: channelMappingVersions.changeReason,
      createdAt: channelMappingVersions.createdAt,
    })
    .from(channelMappingVersions)
    .where(
      and(
        eq(channelMappingVersions.businessId, input.businessId),
        eq(channelMappingVersions.mappingId, input.mappingId),
      ),
    )
    .orderBy(sql`${channelMappingVersions.version} desc`);
}

interface CurrentMapping {
  readonly canonicalItemId: string;
  readonly status: MappingStatus;
  readonly pauseReason: string | null;
  readonly channelBuffer: number;
  readonly channelCap: number | null;
  readonly version: number;
  readonly locationIds: readonly string[];
}

/**
 * Reads a mapping under a row lock.
 *
 * Two operators approving and revising the same mapping at once would otherwise
 * both compute the same next version number, and the unique index on
 * `(mapping_id, version)` would refuse the second — correct, but a worse error
 * message than simply making the second wait.
 */
async function readForUpdate(
  tx: Pick<Database, 'select' | 'execute'>,
  businessId: string,
  mappingId: string,
): Promise<CurrentMapping | null> {
  const locked = await tx.execute<{
    canonical_item_id: string;
    status: MappingStatus;
    pause_reason: string | null;
    channel_buffer: number;
    channel_cap: number | null;
    version: number;
  }>(sql`
    select canonical_item_id, status, pause_reason, channel_buffer, channel_cap, version
    from channel_mappings
    where business_id = ${businessId} and id = ${mappingId}
    for update
  `);

  const row = locked.rows[0];
  if (row === undefined) {
    return null;
  }

  const selected = await tx
    .select({ locationId: channelMappingLocations.locationId })
    .from(channelMappingLocations)
    .where(eq(channelMappingLocations.mappingId, mappingId));

  return {
    canonicalItemId: row.canonical_item_id,
    status: row.status,
    pauseReason: row.pause_reason,
    channelBuffer: row.channel_buffer,
    channelCap: row.channel_cap,
    version: row.version,
    locationIds: selected.map((location) => location.locationId),
  };
}

async function recordVersion(
  tx: Pick<Database, 'insert'>,
  version: {
    readonly businessId: string;
    readonly mappingId: string;
    readonly version: number;
    readonly canonicalItemId: string;
    readonly channelBuffer: number;
    readonly channelCap: number | null;
    readonly locationIds: readonly string[];
    readonly status: MappingStatus;
    readonly changeReason: string | null;
    readonly createdByUserId: string | null;
  },
): Promise<void> {
  await tx.insert(channelMappingVersions).values({
    ...version,
    locationIds: [...version.locationIds],
  });
}

async function readLiveMappingForEntity(
  db: MappingReader,
  input: { readonly businessId: string; readonly providerItemId: string },
): Promise<string | null> {
  const [row] = await db
    .select({ id: channelMappings.id })
    .from(channelMappings)
    .where(
      and(
        eq(channelMappings.businessId, input.businessId),
        eq(channelMappings.providerItemId, input.providerItemId),
        ne(channelMappings.status, 'archived'),
      ),
    )
    .limit(1);

  return row?.id ?? null;
}

function validateRules(buffer: number | undefined, cap: number | null | undefined): string | null {
  if (buffer !== undefined && (!Number.isSafeInteger(buffer) || buffer < 0)) {
    return 'a channel buffer is a whole number of units, and never negative';
  }
  if (cap != null && (!Number.isSafeInteger(cap) || cap < 0)) {
    return 'a channel cap is a whole number of units, and never negative';
  }

  return null;
}
