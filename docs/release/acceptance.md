# AC-01 through AC-20, and what proves each one

Section 36's M9 exit gate is "every section 1 pilot criterion and AC-01 through
AC-20 pass with retained evidence".

Section 1's eight pilot criteria are measured from live data and read on
`/pilot`. The twenty below are properties of the build, and what they need is a
citation rather than a measurement: for each one, the artifact you can open.

**This page is generated from `packages/pilot/src/conformance.ts` and checked by
`packages/pilot/src/acceptance.integration.test.ts`.** Every path cited here is
asserted to exist, so a rename that orphans a proof fails the build rather than
leaving this document quietly describing a file nobody has. Edit the data, not
the prose.

## Two criteria are qualified, and say so

**AC-10 (price action)** covers both the one-time price copy and the optional
eBay order copy. The price copy is proven end to end. The order copy is
implemented and deliberately unavailable on every WooCommerce version until
verification V-03 proves a technique for suppressing WooCommerce's own stock
reduction — without one, a copied order decrements the same units twice.

**AC-11 (shipping)** is proven against a programmable fake which the build
asserts is the only option: no HTTP exists anywhere in the shipping path while
verification V-04 is outstanding. The contract is proven. A live carrier call is
not, and version 1 ships shipping unavailable.

Both are marked `proven against contract` rather than `proven`, which is not a
synonym. Neither blocks the version 1 release; neither is described as verified
against a provider it has never called.

## The matrix

| ID    | Capability                | Status                  | Evidence                                                                                                                                                                                                              |
| ----- | ------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-01 | Tenant isolation          | proven                  | `packages/identity/src/acceptance.integration.test.ts`, `packages/identity/src/memberships.integration.test.ts`, `packages/authz/src/authorize.test.ts`                                                               |
| AC-02 | Connection lifecycle      | proven                  | `packages/integrations/src/acceptance.integration.test.ts`, `packages/db/src/connections.integration.test.ts`                                                                                                         |
| AC-03 | Mapping safety            | proven                  | `packages/inventory/src/acceptance.integration.test.ts`, `packages/inventory/src/activation.integration.test.ts`                                                                                                      |
| AC-04 | Ledger correctness        | proven                  | `packages/inventory/src/acceptance.integration.test.ts`, `packages/inventory/src/ledger.integration.test.ts`, `packages/domain/src/availability.test.ts`                                                              |
| AC-05 | Concurrency               | proven                  | `packages/sync/src/acceptance.integration.test.ts`, `packages/jobs/src/queue.integration.test.ts`                                                                                                                     |
| AC-06 | Projection safety         | proven                  | `packages/domain/src/allocation.property.test.ts`, `packages/sync/src/targets.integration.test.ts`                                                                                                                    |
| AC-07 | Cadence and quotas        | proven                  | `packages/sync/src/cadence.test.ts`, `packages/sync/src/schedule.integration.test.ts`                                                                                                                                 |
| AC-08 | Reconciliation            | proven                  | `packages/sync/src/reconcile.integration.test.ts`                                                                                                                                                                     |
| AC-09 | Drafts and publication    | proven                  | `packages/listings/src/acceptance.integration.test.ts`, `packages/ai/src/acceptance.integration.test.ts`                                                                                                              |
| AC-10 | Price action              | proven against contract | `packages/listings/src/acceptance.integration.test.ts`                                                                                                                                                                |
| AC-11 | Shipping                  | proven against contract | `packages/shipping/src/acceptance.integration.test.ts`                                                                                                                                                                |
| AC-12 | Authentication            | proven                  | `packages/identity/src/acceptance.integration.test.ts`, `packages/identity/src/policy.test.ts`                                                                                                                        |
| AC-13 | Authorization and audit   | proven                  | `packages/audit/src/recorder.integration.test.ts`, `packages/authz/src/authorize.test.ts`                                                                                                                             |
| AC-14 | Secrets and privacy       | proven                  | `packages/crypto/src/keyring.test.ts`, `packages/retention/src/sweep.integration.test.ts`, `.github/workflows/security.yml`, `docs/security/threat-model.md`                                                          |
| AC-15 | Availability and recovery | proven                  | `packages/sync/src/acceptance.integration.test.ts`, `packages/health/src/acceptance.integration.test.ts`, `packages/health/src/policy.test.ts`                                                                        |
| AC-16 | Backup and upgrade        | proven                  | `scripts/backup.sh`, `scripts/restore.sh`, `scripts/upgrade.sh`, `docs/operations/backup-and-restore.md`, `docs/operations/upgrade.md`, `docs/operations/server-migration.md`                                         |
| AC-17 | Accessibility and UI      | proven                  | `apps/web/src/accessibility.test.ts`, `apps/web/src/components/form.tsx`                                                                                                                                              |
| AC-18 | Observability             | proven                  | `packages/health/src/acceptance.integration.test.ts`, `packages/notifications/src/sweep.integration.test.ts`, `apps/web/src/lib/metrics-auth.test.ts`                                                                 |
| AC-19 | Performance               | proven                  | `packages/sync/src/acceptance.integration.test.ts`, `packages/pilot/src/slo.ts`, `packages/pilot/src/pilot.integration.test.ts`                                                                                       |
| AC-20 | Release readiness         | proven                  | `.github/workflows/fast.yml`, `.github/workflows/integration.yml`, `.github/workflows/security.yml`, `.github/workflows/release.yml`, `docs/operations/pilot.md`, `packages/pilot/src/acceptance.integration.test.ts` |

## What "proven" does not mean

It means the cited artifact asserts the property against a real PostgreSQL
database, a real build, or the file it describes.

It does not mean a browser-driven accessibility pass has been run against a
running installation — section 25's "browser" tier does not exist in this
repository yet, and AC-17's static audit says so in its own header. It does not
mean any provider has been called in anger: every provider test in this
repository runs against a programmable fake, by design and by lint boundary.

What closes that last gap is the pilot itself, which is why section 36 requires
both.
