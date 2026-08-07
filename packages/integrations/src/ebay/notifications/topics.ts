import { connectionScopes, connections, providerNotificationTopics, type Database } from '@eim/db';
import type { HttpClient } from '@eim/providers';
import { and, eq, sql } from 'drizzle-orm';

import { hostsFor, type EbayEnvironment } from '../environment';
import { identifierFrom, objectArray, parseJsonObject, stringField } from './rest';

/**
 * Subscribing a seller to the events this application acts on (section 13).
 *
 * Section 13 is unusually specific here, and each clause is a constraint rather
 * than a preference:
 *
 *   Topics are discovered dynamically. Not hardcoded, because which topics an
 *   application may subscribe to depends on its keyset, its granted scopes, and
 *   what eBay has enabled that quarter. A hardcoded list is one that silently
 *   stops matching, and the symptom is a subscription that was never created.
 *
 *   Only *permitted* topics are attempted. Each topic names the OAuth scope it
 *   requires, and a subscription attempted without it fails in a way that looks
 *   like an outage. Comparing against the scopes this connection was actually
 *   granted turns that into a sentence about permission.
 *
 *   Polling is a mandatory fallback, not a degraded mode to be avoided. Topic
 *   access varies between sellers and between keysets, so a family of events
 *   with no live subscription must be polled — and this module's real output is
 *   which families those are. It reports rather than decides: what to do about
 *   it belongs to the health and scheduling layers, and a module that both
 *   discovers and reschedules is one that cannot be tested for either.
 *
 * Account deletion is never subscribed here. eBay registers that endpoint once
 * per application in the developer portal, and a per-seller subscription to it
 * does not exist.
 */

/**
 * What this application does with an event, which is the only reason to want
 * one.
 *
 * Matched against whatever eBay returns rather than enumerated, because the
 * topic identifiers change and the families do not. A topic that matches no
 * family is ignored entirely: subscribing to events nothing handles spends
 * quota and fills a table with rows that mean nothing.
 */
export const TOPIC_FAMILIES = ['revocation', 'catalog', 'orders'] as const;

export type TopicFamily = (typeof TOPIC_FAMILIES)[number];

/**
 * Sorts a topic identifier into the family whose absence would have to be
 * covered by polling.
 *
 * Revocation is its own family and not merely part of catalog: section 13
 * requires an authorization revocation to invalidate credentials and pause work
 * immediately, and there is no poll that discovers it promptly — the first
 * evidence otherwise is a refresh that fails hours later.
 */
export function classifyTopic(topicId: string): TopicFamily | 'account_deletion' | null {
  const name = topicId.toUpperCase();

  if (name.includes('ACCOUNT_DELETION') || name.includes('ACCOUNT_CLOSURE')) {
    return 'account_deletion';
  }

  if (name.includes('REVOCATION') || name.includes('REVOKE')) {
    return 'revocation';
  }

  if (name.includes('ORDER') || name.includes('FULFILLMENT') || name.includes('SALE')) {
    return 'orders';
  }

  if (name.includes('ITEM') || name.includes('INVENTORY') || name.includes('OFFER')) {
    return 'catalog';
  }

  return null;
}

export interface TopicOutcome {
  readonly topic: string;
  readonly family: TopicFamily;
  readonly status: 'subscribed' | 'unavailable' | 'failed';
  readonly summary: string | null;
  readonly subscriptionId: string | null;
}

export interface ReconcileReport {
  readonly connectionId: string;
  readonly destinationId: string | null;
  readonly topics: readonly TopicOutcome[];
  /**
   * Families with no live subscription, which therefore have to be polled.
   * Section 13's mandatory fallback, stated as a fact for someone else to act
   * on.
   */
  readonly pollingRequired: readonly TopicFamily[];
  readonly checkedAt: Date;
}

export type ReconcileFailure =
  'connection_missing' | 'no_destination' | 'no_credentials' | 'provider_unavailable';

export type ReconcileResult =
  | { readonly ok: true; readonly report: ReconcileReport }
  | { readonly ok: false; readonly reason: ReconcileFailure };

export interface TopicOptions {
  readonly db: Database;
  readonly http: HttpClient;
  /** An application token: the topic catalogue belongs to the keyset. */
  readonly applicationToken: (environment: EbayEnvironment, now?: Date) => Promise<string | null>;
  /** A seller token: subscriptions belong to the connection. */
  readonly accessToken: (input: {
    businessId: string;
    connectionId: string;
    environment: EbayEnvironment;
  }) => Promise<string | null>;
  /** The destination eBay delivers to, from `createDestinations`. */
  readonly destinationId: (environment: EbayEnvironment) => Promise<string | null>;
}

export interface NotificationTopics {
  reconcile(input: {
    businessId: string;
    connectionId: string;
    now?: Date;
  }): Promise<ReconcileResult>;
  /** What was last recorded, without calling eBay. */
  read(input: { businessId: string; connectionId: string }): Promise<readonly TopicOutcome[]>;
}

export function createNotificationTopics(options: TopicOptions): NotificationTopics {
  const { db, http } = options;

  return {
    async read(input) {
      const rows = await db
        .select()
        .from(providerNotificationTopics)
        .where(
          and(
            eq(providerNotificationTopics.connectionId, input.connectionId),
            eq(providerNotificationTopics.businessId, input.businessId),
          ),
        );

      return rows.flatMap((row) => {
        const family = classifyTopic(row.topic);

        if (family === null || family === 'account_deletion') {
          return [];
        }

        return [
          {
            topic: row.topic,
            family,
            status:
              row.status === 'subscribed' || row.status === 'failed'
                ? row.status
                : ('unavailable' as const),
            summary: row.summary,
            subscriptionId: row.subscriptionId,
          },
        ];
      });
    },

    async reconcile(input) {
      const now = input.now ?? new Date();

      const [connection] = await db
        .select()
        .from(connections)
        .where(
          and(eq(connections.id, input.connectionId), eq(connections.businessId, input.businessId)),
        )
        .limit(1);

      if (connection === undefined) {
        return { ok: false, reason: 'connection_missing' };
      }

      const destinationId = await options.destinationId(connection.environment);

      if (destinationId === null) {
        // Subscribing without somewhere to deliver would create subscriptions
        // that succeed and produce nothing.
        return { ok: false, reason: 'no_destination' };
      }

      const applicationCredential = await options.applicationToken(connection.environment, now);
      const sellerCredential = await options.accessToken({
        businessId: input.businessId,
        connectionId: input.connectionId,
        environment: connection.environment,
      });

      if (applicationCredential === null || sellerCredential === null) {
        return { ok: false, reason: 'no_credentials' };
      }

      const hosts = hostsFor(connection.environment);
      const catalogue = await discoverTopics(http, hosts, applicationCredential);

      if (catalogue === null) {
        return { ok: false, reason: 'provider_unavailable' };
      }

      const existing = await readSubscriptions(http, hosts, sellerCredential, destinationId);

      if (existing === null) {
        // Without knowing what is already subscribed, creating would duplicate
        // subscriptions eBay would then reject, and the report would claim
        // failures that are nothing of the kind.
        return { ok: false, reason: 'provider_unavailable' };
      }

      const granted = new Set(
        (
          await db
            .select({ scope: connectionScopes.scope })
            .from(connectionScopes)
            .where(eq(connectionScopes.connectionId, input.connectionId))
        ).map((row) => row.scope),
      );

      const outcomes: TopicOutcome[] = [];

      for (const topic of catalogue) {
        const family = classifyTopic(topic.topicId);

        // Nothing here handles it, or eBay registers it against the
        // application rather than the seller. Either way, not ours to create.
        if (family === null || family === 'account_deletion') {
          continue;
        }

        outcomes.push(
          await settleTopic({
            http,
            hosts,
            credential: sellerCredential,
            destinationId,
            topic,
            family,
            granted,
            existing,
          }),
        );
      }

      await record(db, input.businessId, input.connectionId, outcomes, now);

      const covered = new Set(
        outcomes.filter((outcome) => outcome.status === 'subscribed').map((o) => o.family),
      );

      return {
        ok: true,
        report: {
          connectionId: input.connectionId,
          destinationId,
          topics: outcomes,
          // Every family this application acts on that has no live
          // subscription, including families eBay never offered a topic for.
          // The absence of a topic is exactly the case section 13's mandatory
          // fallback exists for, and deriving this from the outcomes alone
          // would silently omit it.
          pollingRequired: TOPIC_FAMILIES.filter((family) => !covered.has(family)),
          checkedAt: now,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------

interface DiscoveredTopic {
  readonly topicId: string;
  /** The OAuth scope eBay says a subscription needs. Empty when unstated. */
  readonly scope: string;
  readonly enabled: boolean;
  readonly payload: { format: string; schemaVersion: string } | null;
}

async function discoverTopics(
  http: HttpClient,
  hosts: ReturnType<typeof hostsFor>,
  credential: string,
): Promise<readonly DiscoveredTopic[] | null> {
  const outcome = await http.send({
    method: 'GET',
    url: `${hosts.apiBase}/commerce/notification/v1/topic?limit=100`,
    headers: { authorization: `Bearer ${credential}`, accept: 'application/json' },
    timeoutMs: 20_000,
    maxBytes: 512 * 1024,
  });

  if (!outcome.ok || outcome.response.status !== 200) {
    return null;
  }

  const payload = parseJsonObject(outcome.response.body);

  if (payload === null) {
    return null;
  }

  return objectArray(payload, 'topics').flatMap((entry) => {
    const topicId = stringField(entry, 'topicId');

    if (topicId === undefined) {
      return [];
    }

    const payloads = objectArray(entry, 'supportedPayloads');
    // JSON only. eBay has offered others, and nothing here parses them.
    const json = payloads.find((candidate) => stringField(candidate, 'format') === 'JSON');

    return [
      {
        topicId,
        scope: stringField(entry, 'scope') ?? '',
        enabled: (stringField(entry, 'status') ?? 'ENABLED') === 'ENABLED',
        payload:
          json === undefined
            ? null
            : {
                format: 'JSON',
                schemaVersion: stringField(json, 'schemaVersion') ?? '1.0',
              },
      },
    ];
  });
}

interface ExistingSubscription {
  readonly subscriptionId: string;
  readonly topicId: string;
  readonly destinationId: string;
  readonly enabled: boolean;
}

async function readSubscriptions(
  http: HttpClient,
  hosts: ReturnType<typeof hostsFor>,
  credential: string,
  destinationId: string,
): Promise<Map<string, ExistingSubscription> | null> {
  const outcome = await http.send({
    method: 'GET',
    url: `${hosts.apiBase}/commerce/notification/v1/subscription?limit=100`,
    headers: { authorization: `Bearer ${credential}`, accept: 'application/json' },
    timeoutMs: 20_000,
    maxBytes: 512 * 1024,
  });

  if (!outcome.ok || outcome.response.status !== 200) {
    return null;
  }

  const payload = parseJsonObject(outcome.response.body);

  if (payload === null) {
    return null;
  }

  const found = new Map<string, ExistingSubscription>();

  for (const entry of objectArray(payload, 'subscriptions')) {
    const subscriptionId = stringField(entry, 'subscriptionId');
    const topicId = stringField(entry, 'topicId');
    const destination = stringField(entry, 'destinationId') ?? '';

    if (subscriptionId === undefined || topicId === undefined) {
      continue;
    }

    // A subscription pointed at somebody else's destination is not ours to
    // manage and does not deliver here. Ignoring it means one is created
    // alongside, which is the intended behaviour: another integration on the
    // same seller account keeps working.
    if (destination !== destinationId) {
      continue;
    }

    found.set(topicId, {
      subscriptionId,
      topicId,
      destinationId: destination,
      enabled: (stringField(entry, 'status') ?? '') === 'ENABLED',
    });
  }

  return found;
}

async function settleTopic(context: {
  http: HttpClient;
  hosts: ReturnType<typeof hostsFor>;
  credential: string;
  destinationId: string;
  topic: DiscoveredTopic;
  family: TopicFamily;
  granted: ReadonlySet<string>;
  existing: Map<string, ExistingSubscription>;
}): Promise<TopicOutcome> {
  const { topic, family } = context;
  const base = {
    topic: topic.topicId,
    family,
  };

  if (!topic.enabled) {
    return {
      ...base,
      status: 'unavailable',
      summary: 'eBay reports this topic as unavailable; these events must be polled for',
      subscriptionId: null,
    };
  }

  if (topic.scope !== '' && !context.granted.has(topic.scope)) {
    // Permission, not an outage. Attempting anyway produces a refusal that
    // reads like one.
    return {
      ...base,
      status: 'unavailable',
      summary: `this connection was not granted ${topic.scope}, so these events must be polled for`,
      subscriptionId: null,
    };
  }

  if (topic.payload === null) {
    return {
      ...base,
      status: 'unavailable',
      summary: 'eBay offers no JSON payload for this topic; these events must be polled for',
      subscriptionId: null,
    };
  }

  const existing = context.existing.get(topic.topicId);

  if (existing?.enabled === true) {
    return {
      ...base,
      status: 'subscribed',
      summary: null,
      subscriptionId: existing.subscriptionId,
    };
  }

  if (existing !== undefined) {
    // Present but disabled — eBay disables a subscription whose deliveries keep
    // failing, exactly as it does a destination.
    const enabled = await enableSubscription(context, existing.subscriptionId);

    return enabled
      ? { ...base, status: 'subscribed', summary: null, subscriptionId: existing.subscriptionId }
      : {
          ...base,
          status: 'failed',
          summary: 'eBay would not re-enable this subscription; these events must be polled for',
          subscriptionId: existing.subscriptionId,
        };
  }

  const created = await createSubscription(context);

  if (created === null) {
    return {
      ...base,
      status: 'failed',
      summary: 'eBay refused the subscription; these events must be polled for',
      subscriptionId: null,
    };
  }

  const enabled = await enableSubscription(context, created);

  return enabled
    ? { ...base, status: 'subscribed', summary: null, subscriptionId: created }
    : {
        ...base,
        status: 'failed',
        summary: 'the subscription was created and eBay would not enable it',
        subscriptionId: created,
      };
}

async function createSubscription(context: {
  http: HttpClient;
  hosts: ReturnType<typeof hostsFor>;
  credential: string;
  destinationId: string;
  topic: DiscoveredTopic;
}): Promise<string | null> {
  const outcome = await context.http.send({
    method: 'POST',
    url: `${context.hosts.apiBase}/commerce/notification/v1/subscription`,
    headers: {
      authorization: `Bearer ${context.credential}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      topicId: context.topic.topicId,
      destinationId: context.destinationId,
      status: 'ENABLED',
      payload: context.topic.payload,
    }),
    timeoutMs: 20_000,
    maxBytes: 64 * 1024,
  });

  if (!outcome.ok) {
    return null;
  }

  const { status } = outcome.response;

  if (status !== 200 && status !== 201 && status !== 204) {
    return null;
  }

  return identifierFrom(outcome.response.body, outcome.response.headers, 'subscriptionId') ?? null;
}

async function enableSubscription(
  context: { http: HttpClient; hosts: ReturnType<typeof hostsFor>; credential: string },
  subscriptionId: string,
): Promise<boolean> {
  const outcome = await context.http.send({
    method: 'POST',
    url: `${context.hosts.apiBase}/commerce/notification/v1/subscription/${encodeURIComponent(subscriptionId)}/enable`,
    headers: { authorization: `Bearer ${context.credential}`, accept: 'application/json' },
    timeoutMs: 20_000,
    maxBytes: 64 * 1024,
  });

  if (!outcome.ok) {
    return false;
  }

  // eBay answers an enable with 204, and with 409 when it was already enabled.
  // The second is success wearing a conflict's clothes.
  return outcome.response.status < 300 || outcome.response.status === 409;
}

async function record(
  db: Database,
  businessId: string,
  connectionId: string,
  outcomes: readonly TopicOutcome[],
  now: Date,
): Promise<void> {
  if (outcomes.length === 0) {
    return;
  }

  await db
    .insert(providerNotificationTopics)
    .values(
      outcomes.map((outcome) => ({
        businessId,
        connectionId,
        topic: outcome.topic,
        status: outcome.status,
        subscriptionId: outcome.subscriptionId,
        summary: outcome.summary,
        discoveredAt: now,
        // The column is what the schema check keys on: a row claiming to be
        // subscribed without a moment it happened is one nothing can age out.
        subscribedAt: outcome.status === 'subscribed' ? now : null,
      })),
    )
    .onConflictDoUpdate({
      target: [providerNotificationTopics.connectionId, providerNotificationTopics.topic],
      set: {
        status: sql`excluded.status`,
        subscriptionId: sql`excluded.subscription_id`,
        summary: sql`excluded.summary`,
        subscribedAt: sql`excluded.subscribed_at`,
      },
    });
}
