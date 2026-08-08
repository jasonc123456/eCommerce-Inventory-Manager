import { authorize, type BusinessPermission } from '@eim/authz';
import { connections, type Database } from '@eim/db';
import {
  listCanonicalItems,
  listLocations,
  projectItem,
  readItemBalances,
  readLiveMappings,
  readSettings,
  readTimeline,
  type CanonicalItemSummary,
  type InventorySettings,
  type ItemProjection,
  type LocationSummary,
  type MappingSummary,
  type ResolvedItemLocation,
} from '@eim/inventory';
import { eq, ne, and } from 'drizzle-orm';

import { identity } from './identity';
import { runtime } from './runtime';

/**
 * Everything the inventory screens need, in one place (sections 8, 9, 21).
 *
 * Reading only. Nothing here contacts a provider or moves a unit: every figure
 * shown is derived from the canonical ledger and from what the last import
 * recorded, which is what makes these pages render during exactly the outage
 * somebody would open them to understand.
 */

export interface InventoryPermissions {
  readonly viewInventory: boolean;
  readonly adjustInventory: boolean;
  readonly transferInventory: boolean;
  readonly manageLocations: boolean;
  readonly manageRules: boolean;
  readonly viewMappings: boolean;
  readonly proposeMappings: boolean;
  readonly approveMappings: boolean;
  readonly proposeKits: boolean;
  readonly approveKits: boolean;
}

export async function inventoryPermissions(
  db: Database,
  businessId: string,
  userId: string,
): Promise<InventoryPermissions> {
  const subject = await identity().memberships.loadSubject(db, businessId, userId);
  const may = (permission: BusinessPermission): boolean =>
    subject !== null && authorize(subject, permission).allowed;

  return {
    viewInventory: may('view_inventory'),
    adjustInventory: may('adjust_inventory'),
    transferInventory: may('transfer_inventory'),
    manageLocations: may('manage_locations'),
    manageRules: may('manage_inventory_rules'),
    viewMappings: may('view_mappings'),
    proposeMappings: may('propose_mappings'),
    approveMappings: may('approve_mappings'),
    proposeKits: may('propose_kit_recipes'),
    approveKits: may('approve_kit_recipes'),
  };
}

export interface InventoryOverview {
  readonly settings: InventorySettings;
  readonly locations: readonly LocationSummary[];
  readonly items: readonly CanonicalItemSummary[];
}

export async function loadOverview(businessId: string): Promise<InventoryOverview> {
  const { db } = runtime();

  return {
    settings: await readSettings(db, businessId),
    locations: await listLocations(db, businessId),
    items: await listCanonicalItems(db, businessId),
  };
}

export interface ItemDetail {
  readonly projection: ItemProjection;
  readonly balances: readonly ResolvedItemLocation[];
  readonly timeline: readonly {
    readonly id: string;
    readonly occurredAt: Date;
    readonly kind: string;
    readonly quantityDelta: number;
    readonly reason: string | null;
  }[];
}

export async function loadItem(
  businessId: string,
  canonicalItemId: string,
): Promise<ItemDetail | null> {
  const { db } = runtime();
  const projection = await projectItem(db, { businessId, canonicalItemId });

  if (projection === null) {
    return null;
  }

  return {
    projection,
    balances: await readItemBalances(db, { businessId, canonicalItemId }),
    timeline: await readTimeline(db, { businessId, canonicalItemId, limit: 20 }),
  };
}

export interface ConnectionMappings {
  readonly connectionId: string;
  readonly displayName: string;
  readonly provider: string;
  readonly mappings: readonly MappingSummary[];
}

/** Every live mapping, grouped by the connection it writes to. */
export async function loadMappings(businessId: string): Promise<ConnectionMappings[]> {
  const { db } = runtime();

  const live = await db
    .select({
      id: connections.id,
      displayName: connections.displayName,
      provider: connections.provider,
    })
    .from(connections)
    .where(and(eq(connections.businessId, businessId), ne(connections.status, 'disconnected')));

  const grouped: ConnectionMappings[] = [];

  for (const connection of live) {
    grouped.push({
      connectionId: connection.id,
      displayName: connection.displayName,
      provider: connection.provider,
      mappings: await readLiveMappings(db, { businessId, connectionId: connection.id }),
    });
  }

  return grouped;
}
