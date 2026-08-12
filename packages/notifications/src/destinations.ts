import { randomBytes } from 'node:crypto';

import { decryptSecret, encryptSecret, type Keyring } from '@eim/crypto';
import {
  alertDestinationSecrets,
  alertDestinations,
  ALERT_SEVERITY_RANK,
  type AlertDestination,
  type AlertSeverity,
  type Database,
  type AlertDestinationKind,
  type AlertDestinationSecretType,
} from '@eim/db';
import { validateIntegrationUrl, type UrlPolicy } from '@eim/providers';
import { and, eq, isNull } from 'drizzle-orm';

/**
 * Where a business has asked for its alerts to be sent (sections 19, 22).
 *
 * The URL is treated as a credential throughout, because it is one: a Slack or
 * Discord incoming-webhook URL is a bearer token with a hostname in front of
 * it, and anybody holding the string can post into that channel until somebody
 * notices and replaces it. So it is encrypted under the same custody as an API
 * key, and what the row carries in the open is the host — enough for a screen
 * to say where alerts go, and not enough to send anything.
 *
 * Three switches, the same three the AI provider has and for the same reasons.
 * *Configured* is a record. *Ready* is an observation, written only by
 * `testDestination` after something answered. *Enabled* is a decision, and the
 * database refuses it until the observation exists — because the first time
 * anybody finds out a destination does not work should not be the first time it
 * was needed.
 */

export interface DestinationSecretStore {
  put(input: {
    readonly businessId: string;
    readonly destinationId: string;
    readonly secretType: AlertDestinationSecretType;
    readonly value: string;
  }): Promise<void>;
  read(input: {
    readonly businessId: string;
    readonly destinationId: string;
    readonly secretType: AlertDestinationSecretType;
  }): Promise<string | null>;
}

export function createDestinationSecretStore(options: {
  readonly db: Database;
  readonly keyring: Keyring;
}): DestinationSecretStore {
  const { db, keyring } = options;

  const contextFor = (destinationId: string, businessId: string, secretType: string) => ({
    businessId,
    resource: `alert_destination:${destinationId}`,
    secretType,
  });

  return {
    async put(input) {
      const ciphertext = encryptSecret(
        keyring,
        contextFor(input.destinationId, input.businessId, input.secretType),
        input.value,
      );

      // Retire and replace in one transaction. The partial unique index allows
      // one live secret per type, so doing this in two statements would leave a
      // window where either two are live or none is.
      await db.transaction(async (tx) => {
        await tx
          .update(alertDestinationSecrets)
          .set({ retiredAt: new Date() })
          .where(
            and(
              eq(alertDestinationSecrets.destinationId, input.destinationId),
              eq(alertDestinationSecrets.secretType, input.secretType),
              isNull(alertDestinationSecrets.retiredAt),
            ),
          );

        await tx.insert(alertDestinationSecrets).values({
          businessId: input.businessId,
          destinationId: input.destinationId,
          secretType: input.secretType,
          ciphertext,
          keyVersion: keyring.active().version,
        });
      });
    },

    async read(input) {
      const rows = await db
        .select()
        .from(alertDestinationSecrets)
        .where(
          and(
            eq(alertDestinationSecrets.destinationId, input.destinationId),
            eq(alertDestinationSecrets.businessId, input.businessId),
            eq(alertDestinationSecrets.secretType, input.secretType),
            isNull(alertDestinationSecrets.retiredAt),
          ),
        )
        .limit(1);

      const row = rows[0];

      return row === undefined
        ? null
        : decryptSecret(
            keyring,
            contextFor(input.destinationId, input.businessId, row.secretType),
            row.ciphertext,
          );
    },
  };
}

export interface ConfigureDestinationInput {
  readonly businessId: string;
  readonly destinationId?: string;
  readonly kind: AlertDestinationKind;
  readonly label: string;
  /** The full credential-bearing URL. Validated, then stored encrypted. */
  readonly url: string;
  readonly minSeverity?: AlertSeverity;
  readonly eventAllowlist?: readonly string[];
}

export type ConfigureOutcome =
  | { readonly ok: true; readonly destinationId: string; readonly signingKey: string | null }
  | { readonly ok: false; readonly reason: string };

/**
 * Saves a destination, and resets what is known about it.
 *
 * Every edit sets the status back to `unchecked`, which also switches the
 * destination off, because an edit is exactly the moment an address can stop
 * working. Carrying a `ready` from before the change forward would mean an
 * operator who mistyped a URL keeps a screen that says everything is fine.
 *
 * A generic webhook gets a signing key on creation, generated here and returned
 * once. It is never returned again: the caller shows it to the operator, who
 * configures their receiver with it, and after that the only way to obtain one
 * is to generate a new one.
 */
export async function configureDestination(
  db: Database,
  secrets: DestinationSecretStore,
  policy: UrlPolicy,
  input: ConfigureDestinationInput,
): Promise<ConfigureOutcome> {
  const verdict = validateIntegrationUrl(input.url, policy);

  if (!verdict.ok) {
    return { ok: false, reason: verdict.reason };
  }

  const host = verdict.url.hostname;
  const values = {
    kind: input.kind,
    label: input.label.trim(),
    endpointHost: host,
    // An edit is an unproven destination again, whatever it was before.
    enabled: false,
    status: 'unchecked' as const,
    statusReason: null,
    ...(input.minSeverity === undefined ? {} : { minSeverity: input.minSeverity }),
    ...(input.eventAllowlist === undefined ? {} : { eventAllowlist: [...input.eventAllowlist] }),
  };

  const destinationId =
    input.destinationId ??
    (
      await db
        .insert(alertDestinations)
        .values({ businessId: input.businessId, ...values })
        .returning({ id: alertDestinations.id })
    )[0]?.id;

  if (destinationId === undefined) {
    return { ok: false, reason: 'the destination could not be stored' };
  }

  if (input.destinationId !== undefined) {
    const updated = await db
      .update(alertDestinations)
      .set({ ...values, updatedAt: new Date() })
      .where(
        and(
          eq(alertDestinations.id, destinationId),
          eq(alertDestinations.businessId, input.businessId),
        ),
      )
      .returning({ id: alertDestinations.id });

    if (updated.length === 0) {
      return { ok: false, reason: 'no such destination in this business' };
    }
  }

  await secrets.put({
    businessId: input.businessId,
    destinationId,
    secretType: 'endpoint_url',
    // Canonical, so two spellings of one endpoint cannot become two
    // destinations that both post into the same channel.
    value: verdict.url.toString(),
  });

  if (input.kind !== 'webhook') {
    return { ok: true, destinationId, signingKey: null };
  }

  const existing = await secrets.read({
    businessId: input.businessId,
    destinationId,
    secretType: 'signing_key',
  });

  if (existing !== null) {
    // Editing a destination does not invalidate a receiver's configuration.
    return { ok: true, destinationId, signingKey: null };
  }

  const signingKey = randomBytes(32).toString('base64url');
  await secrets.put({
    businessId: input.businessId,
    destinationId,
    secretType: 'signing_key',
    value: signingKey,
  });

  return { ok: true, destinationId, signingKey };
}

/** Records that a destination answered. Only this may write `ready`. */
export async function markDestinationReady(
  db: Database,
  businessId: string,
  destinationId: string,
): Promise<void> {
  await db
    .update(alertDestinations)
    .set({
      status: 'ready',
      statusReason: null,
      lastSuccessAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(eq(alertDestinations.id, destinationId), eq(alertDestinations.businessId, businessId)),
    );
}

/**
 * Records that a destination has stopped working, and switches it off.
 *
 * Off, rather than merely marked, because the alternative is a destination that
 * keeps being handed messages it cannot deliver — which turns one broken
 * integration into a queue of retries in front of every alert behind it.
 */
export async function markDestinationFailing(
  db: Database,
  businessId: string,
  destinationId: string,
  reason: string,
): Promise<void> {
  await db
    .update(alertDestinations)
    .set({
      status: 'failing',
      statusReason: reason.slice(0, 500),
      enabled: false,
      lastFailureAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(eq(alertDestinations.id, destinationId), eq(alertDestinations.businessId, businessId)),
    );
}

/** Switches a destination on or off. On is refused until it has answered. */
export async function setDestinationEnabled(
  db: Database,
  businessId: string,
  destinationId: string,
  enabled: boolean,
): Promise<{ readonly ok: boolean; readonly reason?: string }> {
  const rows = await db
    .select()
    .from(alertDestinations)
    .where(
      and(eq(alertDestinations.id, destinationId), eq(alertDestinations.businessId, businessId)),
    )
    .limit(1);

  const destination = rows[0];

  if (destination === undefined) {
    return { ok: false, reason: 'no such destination in this business' };
  }

  if (enabled && destination.status !== 'ready') {
    return { ok: false, reason: 'send a test to this destination before switching it on' };
  }

  await db
    .update(alertDestinations)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(alertDestinations.id, destinationId));

  return { ok: true };
}

export async function removeDestination(
  db: Database,
  businessId: string,
  destinationId: string,
): Promise<boolean> {
  const rows = await db
    .delete(alertDestinations)
    .where(
      and(eq(alertDestinations.id, destinationId), eq(alertDestinations.businessId, businessId)),
    )
    .returning({ id: alertDestinations.id });

  return rows.length === 1;
}

export async function listDestinations(
  db: Database,
  businessId: string,
): Promise<AlertDestination[]> {
  return db.select().from(alertDestinations).where(eq(alertDestinations.businessId, businessId));
}

/**
 * Whether this destination has asked for this alert.
 *
 * An empty allowlist means everything, which is the useful default for a
 * channel somebody created specifically for this. Kept as a separate pure
 * function because it is the decision that determines what leaves the building,
 * and a decision buried inside a query is one nobody reads.
 */
export function destinationWants(
  destination: Pick<AlertDestination, 'enabled' | 'status' | 'minSeverity' | 'eventAllowlist'>,
  alert: { readonly kind: string; readonly severity: AlertSeverity },
): boolean {
  if (!destination.enabled || destination.status !== 'ready') {
    return false;
  }

  if (ALERT_SEVERITY_RANK[alert.severity] < ALERT_SEVERITY_RANK[destination.minSeverity]) {
    return false;
  }

  return destination.eventAllowlist.length === 0
    ? true
    : destination.eventAllowlist.includes(alert.kind);
}
