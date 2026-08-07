import {
  connectionCursors,
  connectionSecrets,
  connections,
  providerItems,
  providerOrders,
  providerWebhooks,
  type Database,
} from '@eim/db';
import { and, count, eq, isNull } from 'drizzle-orm';

import type { SecretStore } from './secrets';

/**
 * Taking a connection out of service (sections 13, 14).
 *
 * Section 14 spells out what disconnection does, and the order of the clauses is
 * the order of the operations: preview impact, pause mappings and jobs, delete
 * only app-created webhooks, discard credentials, retain non-sensitive history.
 *
 * Two of those are easy to get backwards.
 *
 *   Only app-created webhooks. A registration somebody made by hand at the store
 *   is theirs; deleting it on the way out would remove something this
 *   application never owned, and section 14 says to list those for cleanup
 *   instead. What decides is whether there is a provider identifier to delete
 *   *by* — a registration this application created has one and a hand-made one
 *   does not, which is the same fact from the other direction.
 *
 *   Retain non-sensitive history. The imported catalog and orders stay: they are
 *   what an operator looks at afterwards to understand what a mapping used to
 *   point at, and they contain nothing that is a credential. What goes is
 *   everything that could still be used to reach the provider.
 *
 * The preview is a separate call rather than a dry-run flag, because it is shown
 * to a person who then decides. A flag would mean the counting and the acting
 * share a code path whose behaviour depends on a boolean, and the failure that
 * produces — a preview that quietly disconnects — is the one worth designing out.
 */

export interface DisconnectPreview {
  readonly connectionId: string;
  readonly provider: 'ebay' | 'woocommerce';
  readonly displayName: string;
  /** Imported records that stay. Section 14 retains non-sensitive history. */
  readonly retained: { readonly items: number; readonly orders: number };
  /** Registrations this application created and will delete at the provider. */
  readonly webhooksToDelete: number;
  /**
   * Registrations at the provider it did not create. Listed for the operator to
   * remove by hand; never deleted here.
   */
  readonly webhooksToLeave: readonly { readonly topic: string }[];
  /** Credentials that will be discarded. Counted, never read. */
  readonly credentials: number;
  /** Import positions that will be forgotten, so a reconnect starts fresh. */
  readonly cursors: number;
}

export interface DisconnectOutcome {
  readonly connectionId: string;
  readonly webhooksDeleted: number;
  readonly webhooksFailed: number;
  readonly credentialsDiscarded: number;
}

export interface DisconnectOptions {
  readonly db: Database;
  readonly secrets: SecretStore;
  /**
   * Removes a registration at the provider. Injected rather than imported, so
   * this module stays provider-agnostic and a provider that is unreachable
   * during disconnection does not stop the local half from completing.
   */
  readonly deleteWebhook?: (input: {
    businessId: string;
    connectionId: string;
    externalId: string;
  }) => Promise<boolean>;
}

export async function previewDisconnect(
  db: Database,
  input: { businessId: string; connectionId: string },
): Promise<DisconnectPreview | null> {
  const [connection] = await db
    .select()
    .from(connections)
    .where(
      and(eq(connections.id, input.connectionId), eq(connections.businessId, input.businessId)),
    )
    .limit(1);

  if (connection === undefined) {
    return null;
  }

  const [items] = await db
    .select({ total: count() })
    .from(providerItems)
    .where(eq(providerItems.connectionId, input.connectionId));

  const [orders] = await db
    .select({ total: count() })
    .from(providerOrders)
    .where(eq(providerOrders.connectionId, input.connectionId));

  const webhooks = await db
    .select({
      topic: providerWebhooks.topic,
      externalId: providerWebhooks.externalId,
      appManaged: providerWebhooks.appManaged,
      status: providerWebhooks.status,
    })
    .from(providerWebhooks)
    .where(eq(providerWebhooks.connectionId, input.connectionId));

  const live = webhooks.filter((row) => row.status !== 'deleted');

  const [credentials] = await db
    .select({ total: count() })
    .from(connectionSecrets)
    .where(
      and(
        eq(connectionSecrets.connectionId, input.connectionId),
        isNull(connectionSecrets.retiredAt),
      ),
    );

  const [cursors] = await db
    .select({ total: count() })
    .from(connectionCursors)
    .where(eq(connectionCursors.connectionId, input.connectionId));

  return {
    connectionId: connection.id,
    provider: connection.provider,
    displayName: connection.displayName,
    retained: { items: items?.total ?? 0, orders: orders?.total ?? 0 },
    webhooksToDelete: live.filter((row) => row.appManaged && row.externalId !== null).length,
    webhooksToLeave: live
      .filter((row) => row.externalId === null || !row.appManaged)
      .map((row) => ({ topic: row.topic })),
    credentials: credentials?.total ?? 0,
    cursors: cursors?.total ?? 0,
  };
}

export async function disconnect(
  options: DisconnectOptions,
  input: { businessId: string; connectionId: string; now?: Date },
): Promise<DisconnectOutcome> {
  const { db, secrets } = options;
  const now = input.now ?? new Date();

  const registrations = await db
    .select()
    .from(providerWebhooks)
    .where(eq(providerWebhooks.connectionId, input.connectionId));

  let deleted = 0;
  let failed = 0;

  for (const row of registrations) {
    if (row.status === 'deleted') {
      continue;
    }

    if (row.appManaged && row.externalId !== null && options.deleteWebhook !== undefined) {
      const removed = await options.deleteWebhook({
        businessId: input.businessId,
        connectionId: input.connectionId,
        externalId: row.externalId,
      });

      if (removed) {
        deleted += 1;
      } else {
        // Recorded and not retried here. A provider that is unreachable during
        // disconnection must not keep the credentials alive, so the local half
        // completes and the operator is told what is left at the store.
        failed += 1;
      }
    }

    await db
      .update(providerWebhooks)
      .set({ status: 'deleted', secretId: null, updatedAt: now })
      .where(eq(providerWebhooks.id, row.id));
  }

  // Retired rather than deleted, so the row's existence and key version remain
  // auditable. What goes is the ability to use it: nothing reads a retired
  // secret, and the retention sweep removes the ciphertext later.
  const live = await db
    .select({ secretType: connectionSecrets.secretType, scope: connectionSecrets.secretScope })
    .from(connectionSecrets)
    .where(
      and(
        eq(connectionSecrets.connectionId, input.connectionId),
        isNull(connectionSecrets.retiredAt),
      ),
    );

  for (const secret of live) {
    await secrets.retire(
      { businessId: input.businessId, connectionId: input.connectionId },
      secret.secretType,
      secret.scope ?? undefined,
    );
  }

  await db.transaction(async (tx) => {
    // The cursors go, so a reconnection re-imports from the beginning rather
    // than resuming from a position in a traversal that may no longer describe
    // anything. The imported records stay: they are the history section 14
    // retains, and they hold no credential.
    await tx
      .delete(connectionCursors)
      .where(eq(connectionCursors.connectionId, input.connectionId));

    await tx
      .update(connections)
      .set({
        status: 'disconnected',
        // Required by the database whenever the status is disconnected, which is
        // the constraint making "disconnected but with no record of when"
        // unstorable.
        disconnectedAt: now,
        pauseReason: null,
        updatedAt: now,
      })
      .where(
        and(eq(connections.id, input.connectionId), eq(connections.businessId, input.businessId)),
      );
  });

  return {
    connectionId: input.connectionId,
    webhooksDeleted: deleted,
    webhooksFailed: failed,
    credentialsDiscarded: live.length,
  };
}
