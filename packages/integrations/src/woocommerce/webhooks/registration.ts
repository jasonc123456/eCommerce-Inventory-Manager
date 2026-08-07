import { generateToken } from '@eim/crypto';
import { connections, providerWebhooks, type Database } from '@eim/db';
import type { HttpClient, UrlPolicy } from '@eim/providers';
import { and, eq, inArray } from 'drizzle-orm';

import type { SecretStore } from '../../secrets';
import { clientForConnection, parseJsonArray, type WooClient } from '../client';
import { describeStore } from '../store';

/**
 * Keeping a store's webhook registrations correct (section 14).
 *
 * Six core topics, each its own registration with its own random secret, and a
 * lifecycle that has to survive three things the store does without asking:
 *
 *   WooCommerce disables a webhook after repeated delivery failures. That is
 *   sensible behaviour and it is also permanent silence — nothing later
 *   re-enables it, and the integration keeps working because polling continues,
 *   which means nobody notices for weeks. Section 14 requires re-enabling only
 *   app-managed registrations after local health recovers, recording the repair,
 *   and reconciling the gap. `reconcile` does the first two; the gap is closed
 *   by the ordinary import, which is why nothing here tries to replay.
 *
 *   A store administrator deletes the webhook. Recreated, with a new secret,
 *   because the old one is now a secret for a registration that does not exist.
 *
 *   A store administrator points it somewhere else. Repaired, because a
 *   registration this application created and is being billed for in quota is
 *   one it is answerable for.
 *
 * Rotation is overlapping (section 14) and the overlap is the whole design. A
 * replacement is created alongside the live registration, both deliver, and the
 * replacement is promoted only once a delivery has actually verified against its
 * secret — which is `observe`, called from the intake. A rotation that swapped
 * the secret in place would have a window in which deliveries signed with the
 * old secret are unverifiable and deliveries signed with the new one have not
 * started, and every event in that window is lost with no record that it
 * existed.
 */

/**
 * The topics this application manages.
 *
 * Deliberately not `coupon.*` or `customer.*`: section 14 supports WooCommerce
 * core behaviour for inventory, and a webhook this application does not act on
 * is a delivery cost the store pays for nothing.
 *
 * `restored` is included because WooCommerce sends it when a product or order
 * comes back out of the trash, and treating that as a deletion that never
 * un-happened is how a live listing stays marked gone.
 */
export const MANAGED_TOPICS = [
  'product.created',
  'product.updated',
  'product.deleted',
  'product.restored',
  'order.created',
  'order.updated',
  'order.deleted',
  'order.restored',
] as const;

export type ManagedTopic = (typeof MANAGED_TOPICS)[number];

export interface WebhookOutcome {
  readonly topic: string;
  readonly action:
    | 'created'
    | 'unchanged'
    | 're_enabled'
    | 'redirected'
    | 'recreated'
    | 'rotating'
    | 'promoted'
    | 'removed'
    | 'failed';
  readonly summary: string;
  readonly webhookId?: string;
}

export interface WebhookReport {
  readonly connectionId: string;
  readonly outcomes: readonly WebhookOutcome[];
  /**
   * Topics with no live registration after this pass. Section 14 keeps polling
   * running regardless, and this is what tells the health assessment to say so.
   */
  readonly pollingRequired: readonly string[];
  /**
   * Registrations at the store pointing at this application's endpoint that it
   * did not create. Listed for the operator; never deleted (section 14).
   */
  readonly foreign: readonly { readonly externalId: string; readonly topic: string }[];
  readonly checkedAt: Date;
}

export interface WooWebhookOptions {
  readonly db: Database;
  readonly http: HttpClient;
  readonly secrets: SecretStore;
  readonly policy: UrlPolicy;
  /** This application's public base. Delivery URLs are derived from it. */
  readonly publicUrl: string;
}

export interface WooWebhooks {
  /** Brings every managed registration into the state it should be in. */
  reconcile(input: {
    businessId: string;
    connectionId: string;
    now?: Date;
  }): Promise<WebhookReport>;
  /** Starts an overlapping secret rotation for one topic or for all of them. */
  rotate(input: {
    businessId: string;
    connectionId: string;
    topic?: string;
    now?: Date;
  }): Promise<WebhookReport>;
  /**
   * Records that a delivery verified against a registration's secret, promoting
   * a replacement that has now proved itself and retiring what it replaced.
   */
  observe(input: {
    businessId: string;
    connectionId: string;
    webhookId: string;
    now?: Date;
  }): Promise<WebhookOutcome | null>;
  /** Section 14's fallback: values an operator enters in the store by hand. */
  prepareManual(input: {
    businessId: string;
    connectionId: string;
    topic: string;
    now?: Date;
  }): Promise<ManualSetup | null>;
  /** Deletes only what this application created (section 14). */
  remove(input: { businessId: string; connectionId: string; now?: Date }): Promise<WebhookReport>;
}

export interface ManualSetup {
  readonly topic: string;
  readonly deliveryUrl: string;
  /**
   * Shown once, at the moment it is generated, and never again — it is stored
   * encrypted and the store is the only other place it exists.
   */
  readonly secret: string;
  readonly webhookId: string;
}

export function deliveryUrlFor(publicUrl: string, connectionId: string): string {
  return `${publicUrl.trim().replace(/\/+$/, '')}/api/webhooks/woocommerce/${connectionId}`;
}

export function createWooWebhooks(options: WooWebhookOptions): WooWebhooks {
  const { db, secrets } = options;

  return {
    async reconcile(input) {
      const now = input.now ?? new Date();
      const context = await open(options, input.businessId, input.connectionId);

      if (context === null) {
        return unavailable(input.connectionId, now, 'the store has no usable credentials');
      }

      const listed = await listWebhooks(context.client);

      if (listed === null) {
        // The store did not answer. Nothing is changed and nothing is
        // concluded: a registration that could not be read is not a
        // registration that is gone, and recreating on that basis would leave
        // two live registrations and a secret for neither.
        return unavailable(input.connectionId, now, 'the store did not list its webhooks');
      }

      const recorded = await recordedFor(db, input.connectionId);
      const outcomes: WebhookOutcome[] = [];

      for (const topic of MANAGED_TOPICS) {
        const mine = recorded.find(
          (row) => row.topic === topic && row.appManaged && row.status !== 'deleted',
        );
        const atStore =
          mine?.externalId === null || mine?.externalId === undefined
            ? undefined
            : listed.find((entry) => entry.id === mine.externalId);

        if (mine === undefined) {
          outcomes.push(await create(options, context, input, topic, now));
          continue;
        }

        if (atStore === undefined) {
          // Recorded here and absent there: somebody removed it. The old secret
          // is now a secret for nothing, so the replacement gets a fresh one —
          // and the old row is marked gone first, because one registration per
          // topic may be active and the database is what enforces it.
          await db
            .update(providerWebhooks)
            .set({ status: 'deleted', updatedAt: now })
            .where(eq(providerWebhooks.id, mine.id));

          await retire(db, secrets, input, mine.id, now);
          outcomes.push({
            ...(await create(options, context, input, topic, now)),
            action: 'recreated',
            summary: 'the registration had been removed at the store and was created again',
          });
          continue;
        }

        outcomes.push(await repair(options, context, input, mine, atStore, now));
      }

      const live = new Set(
        outcomes.filter((outcome) => outcome.action !== 'failed').map((outcome) => outcome.topic),
      );

      return {
        connectionId: input.connectionId,
        outcomes,
        pollingRequired: MANAGED_TOPICS.filter((topic) => !live.has(topic)),
        foreign: foreignRegistrations(listed, recorded, context.deliveryUrl),
        checkedAt: now,
      };
    },

    async rotate(input) {
      const now = input.now ?? new Date();
      const context = await open(options, input.businessId, input.connectionId);

      if (context === null) {
        return unavailable(input.connectionId, now, 'the store has no usable credentials');
      }

      const recorded = await recordedFor(db, input.connectionId);
      const targets = recorded.filter(
        (row) =>
          row.appManaged &&
          row.status === 'active' &&
          row.externalId !== null &&
          (input.topic === undefined || row.topic === input.topic),
      );

      const outcomes: WebhookOutcome[] = [];

      for (const target of targets) {
        // A rotation already in flight is left alone. Starting a second one
        // would put three registrations on a topic, and the promotion rule —
        // retire what this replaced — cannot say which of two it meant.
        if (recorded.some((row) => row.replacesId === target.id && row.status === 'replacing')) {
          outcomes.push({
            topic: target.topic,
            action: 'unchanged',
            summary: 'a rotation is already in flight for this topic',
            webhookId: target.id,
          });
          continue;
        }

        outcomes.push(await create(options, context, input, target.topic, now, target.id));
      }

      return {
        connectionId: input.connectionId,
        outcomes,
        pollingRequired: [],
        foreign: [],
        checkedAt: now,
      };
    },

    async observe(input) {
      const now = input.now ?? new Date();

      const [row] = await db
        .select()
        .from(providerWebhooks)
        .where(
          and(
            eq(providerWebhooks.id, input.webhookId),
            eq(providerWebhooks.businessId, input.businessId),
            eq(providerWebhooks.connectionId, input.connectionId),
          ),
        )
        .limit(1);

      if (row === undefined) {
        return null;
      }

      await db
        .update(providerWebhooks)
        .set({ lastDeliveryAt: now, lastVerifiedAt: now, failureCount: 0, updatedAt: now })
        .where(eq(providerWebhooks.id, row.id));

      if (row.status !== 'replacing') {
        return {
          topic: row.topic,
          action: 'unchanged',
          summary: 'a delivery verified against this registration',
          webhookId: row.id,
        };
      }

      // Section 14: test delivery, then transition, then remove the old owned
      // hook. This is the transition, and it happens only because a delivery
      // actually verified — which is the test, performed with a real event
      // rather than with a ping the store does not offer.
      const context = await open(options, input.businessId, input.connectionId);
      const replaced =
        row.replacesId === null
          ? undefined
          : recordedById(await recordedFor(db, input.connectionId), row.replacesId);

      if (replaced !== undefined && context !== null && replaced.externalId !== null) {
        await deleteAtStore(context.client, replaced.externalId);
      }

      await db.transaction(async (tx) => {
        if (replaced !== undefined) {
          await tx
            .update(providerWebhooks)
            .set({ status: 'deleted', updatedAt: now })
            .where(eq(providerWebhooks.id, replaced.id));
        }

        await tx
          .update(providerWebhooks)
          .set({ status: 'active', updatedAt: now })
          .where(eq(providerWebhooks.id, row.id));
      });

      if (replaced !== undefined) {
        await retire(db, secrets, input, replaced.id, now);
      }

      return {
        topic: row.topic,
        action: 'promoted',
        summary: 'the replacement registration proved itself and took over',
        webhookId: row.id,
      };
    },

    async prepareManual(input) {
      const now = input.now ?? new Date();
      const deliveryUrl = deliveryUrlFor(options.publicUrl, input.connectionId);
      const secret = generateToken();

      // Recorded as app-managed with no external identifier. The two say
      // different things and section 14 needs both: this application owns the
      // secret, so it can verify deliveries and rotate them, and it does not
      // know the store's identifier for the registration, so it can never
      // delete it — which is exactly the rule for a webhook a person created.
      const [row] = await options.db
        .insert(providerWebhooks)
        .values({
          businessId: input.businessId,
          connectionId: input.connectionId,
          topic: input.topic,
          externalId: null,
          deliveryUrl,
          appManaged: true,
          status: 'pending',
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: providerWebhooks.id });

      if (row === undefined) {
        return null;
      }

      const secretId = await secrets.put({
        businessId: input.businessId,
        connectionId: input.connectionId,
        secretType: 'webhook_secret',
        scope: row.id,
        value: secret,
        now,
      });

      await options.db
        .update(providerWebhooks)
        .set({ secretId, updatedAt: now })
        .where(eq(providerWebhooks.id, row.id));

      // The only time the value is returned. It stays `pending` until a
      // delivery verifies against it, which is section 14's health verification
      // for the manual path.
      return { topic: input.topic, deliveryUrl, secret, webhookId: row.id };
    },

    async remove(input) {
      const now = input.now ?? new Date();
      const context = await open(options, input.businessId, input.connectionId);
      const recorded = await recordedFor(db, input.connectionId);
      const outcomes: WebhookOutcome[] = [];

      for (const row of recorded) {
        if (row.status === 'deleted') {
          continue;
        }

        // Only what this application created at the store. A registration with
        // no external identifier was made by a person, and section 14 lists
        // those for cleanup rather than deleting them.
        const externalId = row.appManaged ? row.externalId : null;
        const deletable = externalId !== null;
        const deleted =
          externalId !== null && context !== null
            ? await deleteAtStore(context.client, externalId)
            : false;

        await db
          .update(providerWebhooks)
          .set({ status: 'deleted', updatedAt: now })
          .where(eq(providerWebhooks.id, row.id));

        await retire(db, secrets, input, row.id, now);

        outcomes.push({
          topic: row.topic,
          action: deleted || !deletable ? 'removed' : 'failed',
          summary: deletable
            ? deleted
              ? 'removed from the store'
              : 'could not be removed from the store and must be deleted by hand'
            : 'created by hand at the store; left in place for the operator to remove',
          webhookId: row.id,
        });
      }

      return {
        connectionId: input.connectionId,
        outcomes,
        pollingRequired: [...MANAGED_TOPICS],
        foreign: [],
        checkedAt: now,
      };
    },
  };
}

// ---------------------------------------------------------------------------

interface Context {
  readonly client: WooClient;
  readonly deliveryUrl: string;
}

async function open(
  options: WooWebhookOptions,
  businessId: string,
  connectionId: string,
): Promise<Context | null> {
  const [connection] = await options.db
    .select({ store: connections.externalAccountId })
    .from(connections)
    .where(and(eq(connections.id, connectionId), eq(connections.businessId, businessId)))
    .limit(1);

  if (connection === undefined) {
    return null;
  }

  const described = describeStore(connection.store, options.policy);

  if (!described.ok) {
    return null;
  }

  const client = await clientForConnection({
    http: options.http,
    secrets: options.secrets,
    businessId,
    connectionId,
    restBase: described.store.restBase,
  });

  return client === null
    ? null
    : { client, deliveryUrl: deliveryUrlFor(options.publicUrl, connectionId) };
}

interface StoreWebhook {
  readonly id: string;
  readonly topic: string;
  readonly status: string;
  readonly deliveryUrl: string;
}

/**
 * Every webhook the store has, following its own pagination.
 *
 * Bounded at ten pages. A store with a thousand webhooks is one where something
 * has gone very wrong, and reading all of them to find our eight would turn a
 * reconciliation into an outage.
 */
async function listWebhooks(client: WooClient): Promise<StoreWebhook[] | null> {
  const all: StoreWebhook[] = [];

  for (let page = 1; page <= 10; page += 1) {
    const outcome = await client.get(`/webhooks?per_page=100&page=${String(page)}&status=all`);

    if (!outcome.ok || outcome.response.status !== 200) {
      // A 401 or 404 here is a store whose key may not manage webhooks, which
      // readiness already reports. Either way nothing is known, and null says so.
      return page === 1 ? null : all;
    }

    const rows = parseJsonArray(outcome.response.body);

    for (const row of rows) {
      const id = identifier(row['id']);
      const topic = row['topic'];
      const status = row['status'];
      const deliveryUrl = row['delivery_url'];

      if (id !== null && typeof topic === 'string') {
        all.push({
          id,
          topic,
          status: typeof status === 'string' ? status : 'unknown',
          deliveryUrl: typeof deliveryUrl === 'string' ? deliveryUrl : '',
        });
      }
    }

    if (rows.length < 100) {
      return all;
    }
  }

  return all;
}

/** WooCommerce sends webhook ids as numbers; everything here treats them as text. */
function identifier(value: unknown): string | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return String(value);
  }

  return typeof value === 'string' && value.length > 0 ? value : null;
}

type Recorded = typeof providerWebhooks.$inferSelect;

async function recordedFor(db: Database, connectionId: string): Promise<Recorded[]> {
  return db.select().from(providerWebhooks).where(eq(providerWebhooks.connectionId, connectionId));
}

function recordedById(rows: readonly Recorded[], id: string): Recorded | undefined {
  return rows.find((row) => row.id === id);
}

/**
 * Creates a registration at the store, with its own secret.
 *
 * The row is written before the store is called, so the secret has something to
 * be scoped to — and so a store that accepts the creation and then fails to
 * report an identifier leaves a row saying so rather than an orphan at the store
 * that nothing here knows about.
 */
async function create(
  options: WooWebhookOptions,
  context: Context,
  ref: { businessId: string; connectionId: string },
  topic: string,
  now: Date,
  replacesId?: string,
): Promise<WebhookOutcome> {
  const secret = generateToken();

  const [row] = await options.db
    .insert(providerWebhooks)
    .values({
      businessId: ref.businessId,
      connectionId: ref.connectionId,
      topic,
      deliveryUrl: context.deliveryUrl,
      appManaged: true,
      // A replacement is `replacing` from the start, which keeps it outside the
      // one-active-registration-per-topic index while the old one is still live.
      status: replacesId === undefined ? 'pending' : 'replacing',
      ...(replacesId === undefined ? {} : { replacesId }),
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: providerWebhooks.id });

  if (row === undefined) {
    return { topic, action: 'failed', summary: 'the registration could not be recorded' };
  }

  const secretId = await options.secrets.put({
    businessId: ref.businessId,
    connectionId: ref.connectionId,
    secretType: 'webhook_secret',
    scope: row.id,
    value: secret,
    now,
  });

  const created = await context.client.send('POST', '/webhooks', {
    name: `Inventory Manager ${topic}`,
    topic,
    delivery_url: context.deliveryUrl,
    secret,
    status: 'active',
  });

  if (!created.ok || created.response.status < 200 || created.response.status >= 300) {
    await options.db
      .update(providerWebhooks)
      .set({
        status: 'failed',
        secretId,
        updatedAt: now,
      })
      .where(eq(providerWebhooks.id, row.id));

    return {
      topic,
      action: 'failed',
      summary: created.ok
        ? `the store refused the registration (${String(created.response.status)})`
        : `the store did not answer (${created.reason})`,
      webhookId: row.id,
    };
  }

  const externalId = identifier(
    (JSON.parse(created.response.body) as Record<string, unknown> | null)?.['id'] ?? null,
  );

  await options.db
    .update(providerWebhooks)
    .set({
      externalId,
      secretId,
      // A creation the store accepted without naming is unmanageable afterwards
      // — it cannot be updated, re-enabled, or removed — so it is recorded as a
      // failure rather than as a registration.
      status: externalId === null ? 'failed' : replacesId === undefined ? 'active' : 'replacing',
      updatedAt: now,
    })
    .where(eq(providerWebhooks.id, row.id));

  if (externalId === null) {
    return {
      topic,
      action: 'failed',
      summary: 'the store accepted the registration without naming it',
      webhookId: row.id,
    };
  }

  return replacesId === undefined
    ? { topic, action: 'created', summary: 'registered at the store', webhookId: row.id }
    : {
        topic,
        action: 'rotating',
        summary:
          'a replacement is live alongside the old registration and will take over once a delivery verifies',
        webhookId: row.id,
      };
}

/** Brings an existing registration back to what it should be. */
async function repair(
  options: WooWebhookOptions,
  context: Context,
  ref: { businessId: string; connectionId: string },
  mine: Recorded,
  atStore: StoreWebhook,
  now: Date,
): Promise<WebhookOutcome> {
  const wrongUrl = atStore.deliveryUrl !== context.deliveryUrl;
  // WooCommerce disables a webhook itself after repeated delivery failures, and
  // nothing else ever turns it back on.
  const disabled = atStore.status !== 'active';

  if (!wrongUrl && !disabled) {
    return {
      topic: mine.topic,
      action: 'unchanged',
      summary: 'the registration is active and pointing here',
      webhookId: mine.id,
    };
  }

  const updated = await context.client.send('PUT', `/webhooks/${atStore.id}`, {
    ...(disabled ? { status: 'active' } : {}),
    ...(wrongUrl ? { delivery_url: context.deliveryUrl } : {}),
  });

  if (!updated.ok || updated.response.status !== 200) {
    await options.db
      .update(providerWebhooks)
      .set({ status: 'paused', updatedAt: now })
      .where(eq(providerWebhooks.id, mine.id));

    return {
      topic: mine.topic,
      action: 'failed',
      summary: updated.ok
        ? `the store refused the repair (${String(updated.response.status)})`
        : `the store did not answer (${updated.reason})`,
      webhookId: mine.id,
    };
  }

  await options.db
    .update(providerWebhooks)
    .set({ status: 'active', deliveryUrl: context.deliveryUrl, updatedAt: now })
    .where(eq(providerWebhooks.id, mine.id));

  return {
    topic: mine.topic,
    action: wrongUrl ? 'redirected' : 're_enabled',
    summary: wrongUrl
      ? 'the registration had been pointed elsewhere and was aimed back here'
      : 'the store had disabled the registration after delivery failures; it was switched back on',
    webhookId: mine.id,
  };
}

async function deleteAtStore(client: WooClient, externalId: string): Promise<boolean> {
  // `force=true`, because WooCommerce otherwise moves the webhook to the trash,
  // where it keeps its identifier and can be restored — which would put a
  // registration with a retired secret back into service.
  const outcome = await client.send('DELETE', `/webhooks/${externalId}?force=true`);

  return outcome.ok && outcome.response.status >= 200 && outcome.response.status < 300;
}

async function retire(
  db: Database,
  secrets: SecretStore,
  ref: { businessId: string; connectionId: string },
  webhookId: string,
  now: Date,
): Promise<void> {
  await secrets.retire(ref, 'webhook_secret', webhookId);

  await db
    .update(providerWebhooks)
    .set({ secretId: null, updatedAt: now })
    .where(eq(providerWebhooks.id, webhookId));
}

/**
 * Registrations at the store aimed at this application that it did not create.
 *
 * Worth surfacing because they will deliver here, and a delivery this
 * application cannot verify is one it must refuse — so an operator who set one
 * up by hand outside the supported path needs to see it named rather than
 * discover it as a stream of rejections.
 */
function foreignRegistrations(
  listed: readonly StoreWebhook[],
  recorded: readonly Recorded[],
  deliveryUrl: string,
): { externalId: string; topic: string }[] {
  const ours = new Set(
    recorded.map((row) => row.externalId).filter((id): id is string => id !== null),
  );

  return listed
    .filter((entry) => entry.deliveryUrl === deliveryUrl && !ours.has(entry.id))
    .map((entry) => ({ externalId: entry.id, topic: entry.topic }));
}

function unavailable(connectionId: string, now: Date, summary: string): WebhookReport {
  return {
    connectionId,
    outcomes: [{ topic: 'all', action: 'failed', summary }],
    pollingRequired: [...MANAGED_TOPICS],
    foreign: [],
    checkedAt: now,
  };
}

/** The live secrets a delivery to this connection may be verified against. */
export async function verifiableSecrets(
  db: Database,
  secrets: SecretStore,
  ref: { businessId: string; connectionId: string },
): Promise<{ webhookId: string; secret: string }[]> {
  const rows = await db
    .select({ id: providerWebhooks.id })
    .from(providerWebhooks)
    .where(
      and(
        eq(providerWebhooks.connectionId, ref.connectionId),
        eq(providerWebhooks.businessId, ref.businessId),
        eq(providerWebhooks.appManaged, true),
        inArray(providerWebhooks.status, ['active', 'replacing', 'pending']),
      ),
    );

  const found: { webhookId: string; secret: string }[] = [];

  for (const row of rows) {
    const secret = await secrets.read(ref, 'webhook_secret', row.id);

    // The rule fires on any comparison against a name containing "secret". This
    // is a presence check on a lookup that has already happened, not a
    // comparison of secret values — those live in `verifyWebhookSignature`, and
    // are constant-time.
    // eslint-disable-next-line security/detect-possible-timing-attacks
    if (secret !== null) {
      found.push({ webhookId: row.id, secret });
    }
  }

  return found;
}
