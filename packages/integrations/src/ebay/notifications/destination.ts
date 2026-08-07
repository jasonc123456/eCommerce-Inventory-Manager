import type { KeyedHasher } from '@eim/crypto';
import { notificationDestinations, type Database } from '@eim/db';
import type { HttpClient } from '@eim/providers';
import { and, eq } from 'drizzle-orm';

import { hostsFor, type CredentialLookup, type EbayEnvironment } from '../environment';
import { isUsableVerificationToken } from './challenge';
import { identifierFrom, parseJsonObject, stringField } from './rest';

/**
 * Where eBay delivers seller notifications (section 13).
 *
 * Section 13 requires the application notification destination to be created
 * and maintained automatically, and both halves have teeth.
 *
 * Created automatically, because the alternative is a manual step in eBay's
 * portal that an operator performs once, gets subtly wrong, and cannot check.
 *
 * *Maintained*, because eBay disables a destination that fails to accept
 * deliveries — which is the correct behaviour on their side and a silent outage
 * on ours. Nothing arrives, no error is raised, and the first evidence is stock
 * that stopped moving. So every pass reads eBay's own view of the destination
 * rather than trusting the last thing this application wrote, and re-enables a
 * destination eBay turned off.
 *
 * One destination per keyset, not per business: eBay registers it against the
 * application, so a single URL receives the events of every seller who has
 * authorized this installation. Which business an event belongs to is decided
 * on the way in, from the connection it names, not by having separate URLs.
 *
 * The marketplace account-deletion endpoint is deliberately not managed here.
 * eBay has no API for it — the operator registers it in the developer portal
 * (the checklist in section 13, step 9) — and pretending otherwise would put a
 * compliance obligation behind a call that does not exist.
 */

export type DestinationFailure =
  /** No eBay application credentials for this environment. */
  | 'not_configured'
  /** The endpoint URL is not one eBay could deliver to. */
  | 'endpoint_unusable'
  /** The verification token is not the shape eBay accepts. */
  | 'token_unusable'
  /** eBay could not be reached, or did not answer. */
  | 'provider_unavailable'
  /** eBay answered, and said no. */
  | 'provider_refused';

export type EnsureDestinationResult =
  | {
      readonly ok: true;
      readonly destinationId: string;
      readonly status: 'enabled' | 'disabled';
      /** True when this pass registered the destination for the first time. */
      readonly created: boolean;
      /** True when this pass changed something at eBay. */
      readonly updated: boolean;
    }
  | { readonly ok: false; readonly reason: DestinationFailure; readonly detail?: string };

export interface EnsureDestinationInput {
  readonly environment: EbayEnvironment;
  /** The public URL eBay will POST notifications to. */
  readonly endpointUrl: string;
  /** The token the endpoint answers eBay's challenge with. */
  readonly verificationToken: string;
  readonly now?: Date;
}

export interface StoredDestination {
  readonly environment: EbayEnvironment;
  readonly endpointUrl: string;
  readonly externalId: string | null;
  readonly status: 'pending' | 'enabled' | 'disabled' | 'failed';
  readonly summary: string | null;
  readonly lastCheckedAt: Date | null;
}

export interface DestinationOptions {
  readonly db: Database;
  readonly http: HttpClient;
  readonly credentials: CredentialLookup;
  /** An application token, not a seller's. Destinations belong to the keyset. */
  readonly applicationToken: (environment: EbayEnvironment, now?: Date) => Promise<string | null>;
  readonly hasher: KeyedHasher;
  /** What the destination is called in eBay's portal. */
  readonly name?: string;
}

export interface Destinations {
  ensure(input: EnsureDestinationInput): Promise<EnsureDestinationResult>;
  /** The recorded state, without calling eBay. */
  read(environment: EbayEnvironment): Promise<StoredDestination | null>;
}

const DEFAULT_NAME = 'eCommerce Inventory Manager';

export function createDestinations(options: DestinationOptions): Destinations {
  const { db, http, hasher } = options;
  const name = options.name ?? DEFAULT_NAME;

  const store = async (
    environment: EbayEnvironment,
    values: {
      endpointUrl: string;
      externalId: string | null;
      status: StoredDestination['status'];
      summary: string | null;
      fingerprint: string | null;
      now: Date;
    },
  ): Promise<void> => {
    await db
      .insert(notificationDestinations)
      .values({
        provider: 'ebay',
        environment,
        endpointUrl: values.endpointUrl,
        externalId: values.externalId,
        status: values.status,
        summary: values.summary,
        verificationFingerprint: values.fingerprint,
        lastCheckedAt: values.now,
      })
      .onConflictDoUpdate({
        target: [notificationDestinations.provider, notificationDestinations.environment],
        set: {
          endpointUrl: values.endpointUrl,
          externalId: values.externalId,
          status: values.status,
          summary: values.summary,
          verificationFingerprint: values.fingerprint,
          lastCheckedAt: values.now,
        },
      });
  };

  const readRow = async (environment: EbayEnvironment) => {
    const [row] = await db
      .select()
      .from(notificationDestinations)
      .where(
        and(
          eq(notificationDestinations.provider, 'ebay'),
          eq(notificationDestinations.environment, environment),
        ),
      )
      .limit(1);

    return row;
  };

  return {
    async read(environment) {
      const row = await readRow(environment);

      return row === undefined
        ? null
        : {
            environment: row.environment,
            endpointUrl: row.endpointUrl,
            externalId: row.externalId,
            status: row.status,
            summary: row.summary,
            lastCheckedAt: row.lastCheckedAt,
          };
    },

    async ensure(input) {
      const now = input.now ?? new Date();

      if (!isDeliverable(input.endpointUrl)) {
        return {
          ok: false,
          reason: 'endpoint_unusable',
          detail: 'the endpoint must be an https URL on a publicly resolvable host',
        };
      }

      if (!isUsableVerificationToken(input.verificationToken)) {
        return {
          ok: false,
          reason: 'token_unusable',
          detail: 'the verification token must be 32 to 80 characters of A-Z, a-z, 0-9, _ or -',
        };
      }

      if (options.credentials(input.environment) === null) {
        return { ok: false, reason: 'not_configured' };
      }

      const credential = await options.applicationToken(input.environment, now);

      if (credential === null) {
        return { ok: false, reason: 'provider_unavailable', detail: 'no application token' };
      }

      // Bound to the environment so the same token registered against sandbox
      // and production produces different fingerprints, and a row copied
      // between installations does not read as already-configured.
      const fingerprint = hasher.hash(
        'notification_verification',
        input.verificationToken,
        `ebay:${input.environment}`,
      );

      const existing = await readRow(input.environment);
      const context = { http, credential, hosts: hostsFor(input.environment), name };
      const registeredId = existing?.externalId ?? null;

      if (existing !== undefined && registeredId !== null) {
        const current = await readDestination(context, registeredId);

        if (current === 'unavailable') {
          await store(input.environment, {
            endpointUrl: existing.endpointUrl,
            externalId: registeredId,
            // The recorded status is left alone. eBay not answering says
            // nothing about whether the destination is enabled, and writing a
            // guess here is how a working destination comes to look broken.
            status: existing.status,
            summary: 'eBay did not answer when the destination was last checked',
            fingerprint: existing.verificationFingerprint,
            now,
          });

          return { ok: false, reason: 'provider_unavailable', detail: 'destination not readable' };
        }

        if (current !== 'missing') {
          const needsUpdate =
            current.endpoint !== input.endpointUrl ||
            !current.enabled ||
            existing.endpointUrl !== input.endpointUrl ||
            // A token the operator rotated has to be sent to eBay, or every
            // challenge from that point is answered with the old one.
            existing.verificationFingerprint !== fingerprint;

          if (!needsUpdate) {
            await store(input.environment, {
              endpointUrl: input.endpointUrl,
              externalId: registeredId,
              status: 'enabled',
              summary: null,
              fingerprint,
              now,
            });

            return {
              ok: true,
              destinationId: registeredId,
              status: 'enabled',
              created: false,
              updated: false,
            };
          }

          const updated = await writeDestination(context, {
            method: 'PUT',
            destinationId: registeredId,
            endpoint: input.endpointUrl,
            verificationToken: input.verificationToken,
          });

          if (updated.outcome !== 'ok') {
            await store(input.environment, {
              endpointUrl: existing.endpointUrl,
              externalId: registeredId,
              status: 'disabled',
              summary: summaryFor(updated.outcome, 'update'),
              fingerprint: null,
              now,
            });

            return {
              ok: false,
              reason:
                updated.outcome === 'unavailable' ? 'provider_unavailable' : 'provider_refused',
            };
          }

          await store(input.environment, {
            endpointUrl: input.endpointUrl,
            externalId: registeredId,
            status: 'enabled',
            summary: null,
            fingerprint,
            now,
          });

          return {
            ok: true,
            destinationId: registeredId,
            status: 'enabled',
            created: false,
            updated: true,
          };
        }

        // eBay has never heard of the destination this installation recorded —
        // deleted in the portal, or a database restored across keysets. Falling
        // through to create is right; keeping the dead identifier is not.
      }

      const created = await writeDestination(context, {
        method: 'POST',
        endpoint: input.endpointUrl,
        verificationToken: input.verificationToken,
      });

      if (created.outcome !== 'ok') {
        await store(input.environment, {
          endpointUrl: input.endpointUrl,
          externalId: null,
          status: created.outcome === 'unavailable' ? 'pending' : 'failed',
          summary: summaryFor(created.outcome, 'registration'),
          fingerprint: null,
          now,
        });

        return {
          ok: false,
          reason: created.outcome === 'unavailable' ? 'provider_unavailable' : 'provider_refused',
        };
      }

      if (created.destinationId === undefined) {
        // eBay accepted the registration and did not say what it is called, so
        // there is nothing to manage later. Recorded as failed rather than
        // enabled: a destination this application cannot address again is one
        // it cannot re-enable when eBay turns it off.
        await store(input.environment, {
          endpointUrl: input.endpointUrl,
          externalId: null,
          status: 'failed',
          summary: 'eBay accepted the destination without returning an identifier for it',
          fingerprint: null,
          now,
        });

        return { ok: false, reason: 'provider_refused', detail: 'no destination identifier' };
      }

      await store(input.environment, {
        endpointUrl: input.endpointUrl,
        externalId: created.destinationId,
        status: 'enabled',
        summary: null,
        fingerprint,
        now,
      });

      return {
        ok: true,
        destinationId: created.destinationId,
        status: 'enabled',
        created: true,
        updated: true,
      };
    },
  };
}

// ---------------------------------------------------------------------------

interface CallContext {
  readonly http: HttpClient;
  readonly credential: string;
  readonly hosts: ReturnType<typeof hostsFor>;
  readonly name: string;
}

type ReadOutcome = 'unavailable' | 'missing' | { endpoint: string; enabled: boolean };

async function readDestination(context: CallContext, destinationId: string): Promise<ReadOutcome> {
  const outcome = await context.http.send({
    method: 'GET',
    url: `${context.hosts.apiBase}/commerce/notification/v1/destination/${encodeURIComponent(destinationId)}`,
    headers: { authorization: `Bearer ${context.credential}`, accept: 'application/json' },
    timeoutMs: 15_000,
    maxBytes: 64 * 1024,
  });

  if (!outcome.ok) {
    return 'unavailable';
  }

  if (outcome.response.status === 404) {
    return 'missing';
  }

  if (outcome.response.status !== 200) {
    return 'unavailable';
  }

  const record = parseJsonObject(outcome.response.body);

  if (record === null) {
    return 'unavailable';
  }

  const delivery = record['deliveryConfig'];
  const endpoint =
    typeof delivery === 'object' && delivery !== null
      ? stringField(delivery as Record<string, unknown>, 'endpoint')
      : undefined;

  return {
    endpoint: endpoint ?? '',
    // Anything other than ENABLED is treated as off. eBay has used more than
    // one word for a destination it has stopped delivering to, and the
    // consequence of each is the same.
    enabled: record['status'] === 'ENABLED',
  };
}

type WriteOutcome =
  { outcome: 'ok'; destinationId?: string } | { outcome: 'unavailable' } | { outcome: 'refused' };

async function writeDestination(
  context: CallContext,
  input: {
    method: 'POST' | 'PUT';
    destinationId?: string;
    endpoint: string;
    verificationToken: string;
  },
): Promise<WriteOutcome> {
  const base = `${context.hosts.apiBase}/commerce/notification/v1/destination`;
  const url =
    input.destinationId === undefined ? base : `${base}/${encodeURIComponent(input.destinationId)}`;

  const outcome = await context.http.send({
    method: input.method,
    url,
    headers: {
      authorization: `Bearer ${context.credential}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      name: context.name,
      status: 'ENABLED',
      deliveryConfig: {
        endpoint: input.endpoint,
        verificationToken: input.verificationToken,
      },
    }),
    timeoutMs: 20_000,
    maxBytes: 64 * 1024,
  });

  if (!outcome.ok) {
    return { outcome: 'unavailable' };
  }

  const { status } = outcome.response;

  if (status >= 500) {
    // eBay's problem, not the request's. Distinguished so a transient outage
    // does not mark the destination failed and stop later passes retrying.
    return { outcome: 'unavailable' };
  }

  if (status !== 200 && status !== 201 && status !== 204) {
    return { outcome: 'refused' };
  }

  const identifier =
    input.destinationId ??
    identifierFrom(outcome.response.body, outcome.response.headers, 'destinationId');

  return identifier === undefined
    ? { outcome: 'ok' }
    : { outcome: 'ok', destinationId: identifier };
}

function summaryFor(outcome: 'unavailable' | 'refused', what: string): string {
  return outcome === 'unavailable'
    ? `eBay could not be reached during destination ${what}`
    : `eBay refused the destination ${what}`;
}

/**
 * Whether eBay could plausibly deliver to this URL.
 *
 * Checked locally so a misconfigured public URL fails with a sentence an
 * operator can act on, rather than as an opaque rejection from eBay after
 * everything else looked correct. Deliberately permissive about what a real
 * host is: the authority on that is DNS, and this only rejects what is
 * certainly wrong.
 */
function isDeliverable(value: string): boolean {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol !== 'https:') {
    return false;
  }

  const host = url.hostname.toLowerCase();

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return false;
  }

  // An address literal has no certificate eBay will accept and no name to
  // resolve; a name with no dot is not reachable from outside a private network.
  return host.includes('.') && !/^[0-9.]+$/.test(host) && !host.includes(':');
}
