/**
 * AC-01 through AC-20, bound to what proves them (sections 30, 36).
 *
 * Section 36's M9 exit gate is "every section 1 pilot criterion and AC-01
 * through AC-20 pass with retained evidence". The pilot criteria are measured
 * from live data; these twenty are properties of the build, and what they need
 * is not a measurement but a citation — for each one, the artifact a reader can
 * open to check the claim.
 *
 * This is that list, as data rather than prose, because prose rots silently. The
 * M9 exit gate walks it and fails when a cited artifact has moved, so a rename
 * that orphans a proof breaks the build instead of leaving a document quietly
 * describing a file nobody has.
 *
 * Two entries carry an outstanding verification, and they say so rather than
 * claiming more than is true.
 *
 * AC-10 covers both the one-time price copy and the optional eBay order copy.
 * The price copy is proven. The order copy is implemented and deliberately
 * unavailable on every WooCommerce version until V-03 proves a technique for
 * suppressing Woo's own stock reduction, because without one a copied order
 * decrements the same units twice.
 *
 * AC-11 is shipping, and it is proven against a programmable fake that the
 * build asserts is the only option — there is no HTTP anywhere in the shipping
 * path while V-04 is outstanding. That is a real proof of the contract and not a
 * proof against a live carrier, and the difference is stated rather than
 * smoothed over.
 *
 * Both ship present-and-unavailable in version 1. Neither blocks the release,
 * and neither is described as verified against a provider it has never called.
 */

export type ConformanceStatus =
  /** Proven by the cited artifacts, with nothing outstanding. */
  | 'proven'
  /**
   * Proven as far as it can be without an outstanding verification, with the
   * capability shipped unavailable. Never a synonym for proven.
   */
  | 'proven_against_contract';

export interface ConformanceEntry {
  readonly id: string;
  readonly capability: string;
  /** Section 30's own wording, so the matrix quotes the criterion. */
  readonly criterion: string;
  readonly status: ConformanceStatus;
  /** Repository-relative paths a reader can open. Checked to exist. */
  readonly evidence: readonly string[];
  /** Present only where something is outstanding, and then required. */
  readonly caveat?: string;
}

export const CONFORMANCE: readonly ConformanceEntry[] = [
  {
    id: 'AC-01',
    capability: 'Tenant isolation',
    criterion:
      'Automated cross-business object, job, export, notification, and permission tests show no leakage.',
    status: 'proven',
    evidence: [
      'packages/identity/src/acceptance.integration.test.ts',
      'packages/identity/src/memberships.integration.test.ts',
      'packages/authz/src/authorize.test.ts',
    ],
  },
  {
    id: 'AC-02',
    capability: 'Connection lifecycle',
    criterion:
      'Connect, refresh, reauthorize, rotate, revoke, delete, and provider-outage paths pass for each supported connector.',
    status: 'proven',
    evidence: [
      'packages/integrations/src/acceptance.integration.test.ts',
      'packages/db/src/connections.integration.test.ts',
    ],
  },
  {
    id: 'AC-03',
    capability: 'Mapping safety',
    criterion:
      'Unapproved, ambiguous, duplicate, stale, or incomplete-variation mappings cannot cause an inventory write.',
    status: 'proven',
    evidence: [
      'packages/inventory/src/acceptance.integration.test.ts',
      'packages/inventory/src/activation.integration.test.ts',
    ],
  },
  {
    id: 'AC-04',
    capability: 'Ledger correctness',
    criterion:
      'Property and integration tests preserve invariants for sales, refunds, adjustments, reservations, kits, and location allocation.',
    status: 'proven',
    evidence: [
      'packages/inventory/src/acceptance.integration.test.ts',
      'packages/inventory/src/ledger.integration.test.ts',
      'packages/domain/src/availability.test.ts',
    ],
  },
  {
    id: 'AC-05',
    capability: 'Concurrency',
    criterion:
      'Last-unit simultaneous sales, reordered events, duplicate delivery, process crash, and lease expiry converge without double decrement.',
    status: 'proven',
    evidence: [
      'packages/sync/src/acceptance.integration.test.ts',
      'packages/jobs/src/queue.integration.test.ts',
    ],
  },
  {
    id: 'AC-06',
    capability: 'Projection safety',
    criterion:
      'Safety stock, caps, provider maximums, no-op suppression, and protective reductions produce the documented target quantity.',
    status: 'proven',
    evidence: [
      'packages/domain/src/allocation.property.test.ts',
      'packages/sync/src/targets.integration.test.ts',
    ],
  },
  {
    id: 'AC-07',
    capability: 'Cadence and quotas',
    criterion:
      'Ten-second through thirty-minute settings remain responsive under the tested baseline and adapt before provider-limit failure.',
    status: 'proven',
    evidence: [
      'packages/sync/src/cadence.test.ts',
      'packages/sync/src/schedule.integration.test.ts',
    ],
  },
  {
    id: 'AC-08',
    capability: 'Reconciliation',
    criterion:
      'Explainable drift repairs automatically; unexplained drift pauses, protects, explains, and requires a fresh authorized decision.',
    status: 'proven',
    evidence: ['packages/sync/src/reconcile.integration.test.ts'],
  },
  {
    id: 'AC-09',
    capability: 'Drafts and publication',
    criterion:
      'Drafts can be reviewed and edited, but no automated route or AI tool can publish them.',
    status: 'proven',
    evidence: [
      'packages/listings/src/acceptance.integration.test.ts',
      'packages/ai/src/acceptance.integration.test.ts',
    ],
  },
  {
    id: 'AC-10',
    capability: 'Price action',
    criterion:
      'A one-time copy requires permission, fee/currency impact, fresh source value, exact confirmation, idempotency, and audit.',
    status: 'proven_against_contract',
    evidence: ['packages/listings/src/acceptance.integration.test.ts'],
    caveat:
      'The price copy is proven end to end. The optional eBay order copy shares this criterion and ' +
      'is deliberately unavailable on every WooCommerce version until V-03 proves a technique for ' +
      'suppressing Woo’s own stock reduction; without one, a copied order decrements twice.',
  },
  {
    id: 'AC-11',
    capability: 'Shipping',
    criterion:
      'Rate quote, label purchase, refund where supported, document access, and tracking propagation obey provider and permission contracts.',
    status: 'proven_against_contract',
    evidence: ['packages/shipping/src/acceptance.integration.test.ts'],
    caveat:
      'Proven against a programmable fake that the build asserts is the only option: no HTTP exists ' +
      'anywhere in the shipping path while V-04 is outstanding. The contract is proven; a live ' +
      'carrier call is not, and version 1 ships shipping unavailable.',
  },
  {
    id: 'AC-12',
    capability: 'Authentication',
    criterion:
      'Every flow and abuse case listed in the authentication acceptance gate passes before release.',
    status: 'proven',
    evidence: [
      'packages/identity/src/acceptance.integration.test.ts',
      'packages/identity/src/policy.test.ts',
    ],
  },
  {
    id: 'AC-13',
    capability: 'Authorization and audit',
    criterion:
      'Every mutation has a server-side permission, business scope, actor, reason/input, before/after or linked outcome, and retention class.',
    status: 'proven',
    evidence: [
      'packages/audit/src/recorder.integration.test.ts',
      'packages/authz/src/authorize.test.ts',
    ],
  },
  {
    id: 'AC-14',
    capability: 'Secrets and privacy',
    criterion:
      'Secret scanning, redaction, encryption/rotation, deletion, export, retention, and marketplace account-deletion tests pass.',
    status: 'proven',
    evidence: [
      'packages/crypto/src/keyring.test.ts',
      'packages/retention/src/sweep.integration.test.ts',
      '.github/workflows/security.yml',
      'docs/security/threat-model.md',
    ],
  },
  {
    id: 'AC-15',
    capability: 'Availability and recovery',
    criterion:
      'Provider outage, database restart, worker crash, SMTP failure, clock skew, disk pressure, and 24-hour disconnection recover without direct DB repair.',
    status: 'proven',
    evidence: [
      'packages/sync/src/acceptance.integration.test.ts',
      'packages/health/src/acceptance.integration.test.ts',
      'packages/health/src/policy.test.ts',
    ],
  },
  {
    id: 'AC-16',
    capability: 'Backup and upgrade',
    criterion:
      'Encrypted backup/restore, supported-version migrations, rollback boundaries, and server migration are demonstrated from documentation.',
    status: 'proven',
    evidence: [
      'scripts/backup.sh',
      'scripts/restore.sh',
      'scripts/upgrade.sh',
      'docs/operations/backup-and-restore.md',
      'docs/operations/upgrade.md',
      'docs/operations/server-migration.md',
    ],
  },
  {
    id: 'AC-17',
    capability: 'Accessibility and UI',
    criterion:
      'Keyboard, focus, screen-reader semantics, responsive parity, stale/error states, confirmation tiers, and theme contrast meet WCAG 2.2 AA.',
    status: 'proven',
    evidence: ['apps/web/src/accessibility.test.ts', 'apps/web/src/components/form.tsx'],
  },
  {
    id: 'AC-18',
    capability: 'Observability',
    criterion:
      'Alerts, metrics, health, logs, audits, DLQ, trace correlation, redaction, and auto-resolution behave as section 22 specifies.',
    status: 'proven',
    evidence: [
      'packages/health/src/acceptance.integration.test.ts',
      'packages/notifications/src/sweep.integration.test.ts',
      'apps/web/src/lib/metrics-auth.test.ts',
    ],
  },
  {
    id: 'AC-19',
    capability: 'Performance',
    criterion:
      'The 5,000-mapping/500-order daily baseline meets latency, convergence, resource, burst, and recovery thresholds on recommended hardware.',
    status: 'proven',
    evidence: [
      'packages/sync/src/acceptance.integration.test.ts',
      'packages/pilot/src/slo.ts',
      'packages/pilot/src/pilot.integration.test.ts',
    ],
  },
  {
    id: 'AC-20',
    capability: 'Release readiness',
    criterion:
      'Required tests, coverage, selective mutation score, vulnerability/license gates, documentation, SBOM/provenance, and pilot bar all pass.',
    status: 'proven',
    evidence: [
      '.github/workflows/fast.yml',
      '.github/workflows/integration.yml',
      '.github/workflows/security.yml',
      '.github/workflows/release.yml',
      'docs/operations/pilot.md',
      'packages/pilot/src/acceptance.integration.test.ts',
    ],
  },
];

/** Every criterion section 30 lists, so a missing one is a failure rather than a shorter list. */
export const EXPECTED_CONFORMANCE_IDS: readonly string[] = Array.from(
  { length: 20 },
  (_unused, index) => `AC-${String(index + 1).padStart(2, '0')}`,
);
