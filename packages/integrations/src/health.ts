import { connectionHealth, connections, providerWebhooks, type Database } from '@eim/db';
import { and, eq, inArray, sql } from 'drizzle-orm';

import type { QuotaLedger } from './quota';
import type { QuotaPressure, QuotaState } from './quota-policy';
import {
  CIRCUIT_COOLDOWN_MS,
  circuitStateOf,
  decide,
  worstPressure,
  type CircuitState,
} from './health-policy';

/**
 * Reading and recording whether a connection is working (sections 12, 14, 22).
 *
 * The verdict itself lives in `health-policy.ts`. What is here is the row: the
 * failure tally a circuit is derived from, and the assessment that combines it
 * with quota pressure and webhook coverage.
 */

export interface ConnectionHealthReport {
  readonly connectionId: string;
  readonly status: 'healthy' | 'degraded' | 'failing' | 'unknown';
  readonly summary: string;
  readonly circuit: CircuitState;
  readonly consecutiveFailures: number;
  readonly lastSuccessAt: Date | null;
  readonly lastFailureAt: Date | null;
  /** Highest pressure across every live window for this connection. */
  readonly quotaPressure: QuotaPressure;
  readonly quotas: readonly QuotaState[];
  /**
   * Topics with no live webhook registration, so changes are found by polling.
   * Section 14: this is what makes the degradation visible.
   */
  readonly pollingRequired: readonly string[];
  readonly checkedAt: Date;
}

export interface ConnectionHealthOptions {
  readonly db: Database;
  readonly quotas: QuotaLedger;
}

export interface ConnectionHealthService {
  /** Records the outcome of a provider call. */
  record(input: {
    businessId: string;
    connectionId: string;
    outcome: 'success' | 'failure';
    summary?: string | undefined;
    now?: Date;
  }): Promise<void>;
  /** Whether the next call to this connection should be attempted. */
  circuit(input: {
    businessId: string;
    connectionId: string;
    now?: Date;
  }): Promise<{ state: CircuitState; allowed: boolean; retryAt: Date | null }>;
  /** The whole picture, for the interface and the health endpoint. */
  assess(input: {
    businessId: string;
    connectionId: string;
    /** Topics this application knows are unregistered, from a webhook pass. */
    pollingRequired?: readonly string[];
    now?: Date;
  }): Promise<ConnectionHealthReport>;
}

export function createConnectionHealth(options: ConnectionHealthOptions): ConnectionHealthService {
  const { db, quotas } = options;

  return {
    async record(input) {
      const now = input.now ?? new Date();
      const failed = input.outcome === 'failure';

      await db
        .insert(connectionHealth)
        .values({
          businessId: input.businessId,
          connectionId: input.connectionId,
          status: failed ? 'failing' : 'healthy',
          summary: input.summary ?? null,
          consecutiveFailures: failed ? 1 : 0,
          ...(failed ? { lastFailureAt: now } : { lastSuccessAt: now }),
          checkedAt: now,
        })
        .onConflictDoUpdate({
          target: [connectionHealth.connectionId],
          set: failed
            ? {
                // Incremented in the statement rather than read-then-written, so
                // two workers failing at the same moment count as two failures.
                consecutiveFailures: sql`${connectionHealth.consecutiveFailures} + 1`,
                lastFailureAt: now,
                summary: input.summary ?? null,
                checkedAt: now,
                // The stored status stays coarse; `assess` is what decides
                // between degraded and failing, because that needs the webhook
                // and quota picture this call does not have.
                status: 'failing',
              }
            : {
                // A success clears the tally completely. A circuit that only
                // decayed would stay open through a recovery, and the thing it
                // is protecting against is a provider that is down — which,
                // when it answers, is not down.
                consecutiveFailures: 0,
                lastSuccessAt: now,
                summary: null,
                checkedAt: now,
                status: 'healthy',
              },
        });
    },

    async circuit(input) {
      const now = input.now ?? new Date();
      const [row] = await db
        .select()
        .from(connectionHealth)
        .where(
          and(
            eq(connectionHealth.connectionId, input.connectionId),
            eq(connectionHealth.businessId, input.businessId),
          ),
        )
        .limit(1);

      const state = circuitStateOf(row?.consecutiveFailures ?? 0, row?.lastFailureAt ?? null, now);

      return {
        state,
        // Half-open lets exactly one call through in the sense that matters:
        // the next call is attempted, and its outcome either resets the tally
        // or restarts the cooldown.
        allowed: state !== 'open',
        retryAt:
          state === 'open' && row?.lastFailureAt != null
            ? new Date(row.lastFailureAt.getTime() + CIRCUIT_COOLDOWN_MS)
            : null,
      };
    },

    async assess(input) {
      const now = input.now ?? new Date();

      const [connection] = await db
        .select()
        .from(connections)
        .where(
          and(eq(connections.id, input.connectionId), eq(connections.businessId, input.businessId)),
        )
        .limit(1);

      if (connection === undefined) {
        return {
          connectionId: input.connectionId,
          status: 'unknown',
          summary: 'this connection no longer exists',
          circuit: 'closed',
          consecutiveFailures: 0,
          lastSuccessAt: null,
          lastFailureAt: null,
          quotaPressure: 'unknown',
          quotas: [],
          pollingRequired: [],
          checkedAt: now,
        };
      }

      const [health] = await db
        .select()
        .from(connectionHealth)
        .where(eq(connectionHealth.connectionId, input.connectionId))
        .limit(1);

      const failures = health?.consecutiveFailures ?? 0;
      const circuit = circuitStateOf(failures, health?.lastFailureAt ?? null, now);
      const live = await quotas.read({ connectionId: input.connectionId, now });
      const pressure = worstPressure(live);

      const polling = input.pollingRequired ?? (await unregisteredTopics(db, input.connectionId));

      const verdict = decide({
        connectionStatus: connection.status,
        pauseReason: connection.pauseReason,
        circuit,
        failures,
        pressure,
        polling,
      });

      await db
        .insert(connectionHealth)
        .values({
          businessId: input.businessId,
          connectionId: input.connectionId,
          status: verdict.status,
          summary: verdict.summary,
          consecutiveFailures: failures,
          ...(health?.lastSuccessAt == null ? {} : { lastSuccessAt: health.lastSuccessAt }),
          ...(health?.lastFailureAt == null ? {} : { lastFailureAt: health.lastFailureAt }),
          checkedAt: now,
        })
        .onConflictDoUpdate({
          target: [connectionHealth.connectionId],
          set: { status: verdict.status, summary: verdict.summary, checkedAt: now },
        });

      return {
        connectionId: input.connectionId,
        status: verdict.status,
        summary: verdict.summary,
        circuit,
        consecutiveFailures: failures,
        lastSuccessAt: health?.lastSuccessAt ?? null,
        lastFailureAt: health?.lastFailureAt ?? null,
        quotaPressure: pressure,
        quotas: live,
        pollingRequired: polling,
        checkedAt: now,
      };
    },
  };
}

// ---------------------------------------------------------------------------

/**
 * Which managed topics have no live registration.
 *
 * Asked of the database rather than of the store, because this runs on every
 * health read and a call to the provider per read is how a status page becomes
 * the thing exhausting the allowance it is reporting on.
 */
async function unregisteredTopics(db: Database, connectionId: string): Promise<string[]> {
  const rows = await db
    .select({ topic: providerWebhooks.topic })
    .from(providerWebhooks)
    .where(
      and(
        eq(providerWebhooks.connectionId, connectionId),
        inArray(providerWebhooks.status, ['pending', 'paused', 'failed']),
      ),
    );

  const live = await db
    .select({ topic: providerWebhooks.topic })
    .from(providerWebhooks)
    .where(
      and(
        eq(providerWebhooks.connectionId, connectionId),
        inArray(providerWebhooks.status, ['active', 'replacing']),
      ),
    );

  const covered = new Set(live.map((row) => row.topic));

  return [...new Set(rows.map((row) => row.topic))].filter((topic) => !covered.has(topic)).sort();
}
