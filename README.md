# eCommerce Inventory Manager

Self-hosted inventory synchronization between eBay and WooCommerce, built around
a single canonical stock ledger that both channels project from.

> **Status: milestones M0–M6 delivered.** Foundations, identity and tenancy,
> read-only eBay and WooCommerce integration, the inventory model, the
> synchronization core, reviewed listing operations, and shipping are built and
> tested. Two capabilities are deliberately switched off pending external
> verification — see [Not yet usable](#not-yet-usable) — and the pilot has not
> run, so this is not yet a finished version 1.

## Why it exists

Selling the same stock on two channels means each one advertises a number, and
neither knows about the other. The usual outcomes are an oversell you find out
about from a buyer, or holding back stock on both channels so nothing oversells
and nothing sells.

This keeps one authoritative count per item and projects it outward. eBay and
WooCommerce are told what to display; they are never asked what the truth is.
Every change to stock is an append-only ledger entry with an actor and a reason,
so "why does this say four?" always has an answer.

## Design commitments

These are the decisions everything else follows from.

**One source of truth.** The canonical item holds the stock. Channels project
from it. A surprising reading from a channel is evidence of drift to be
reconciled, never an instruction to change the canonical count.

**Absolute quantity writes, never deltas.** A delta applied twice is an
oversell. An absolute quantity applied twice is the same quantity. Every channel
write is idempotent by construction.

**Availability is never negative.** A shortage is recorded as its own quantity
with its own evidence, not as negative stock.

**The database enforces correctness.** Composite foreign keys make a
cross-business row unrepresentable rather than merely forbidden. CHECK
constraints reject a reservation larger than the stock backing it. The ledger is
append-only by trigger. Application validation improves the error message; it is
never the thing standing between you and a corrupt row.

**Never edit history to fix a number.** A wrong ledger entry is corrected by a
linked reversal, so the mistake and its correction are both visible afterwards.

**One data store.** PostgreSQL holds the data, the job queue, the rate limits,
and the event fan-out. No Redis, no second thing to back up.

**Anything that spends money or changes what the public sees is confirmed by a
person.** Publishing a listing, changing a price, returning a listing to sale,
copying an order, buying a shipping label: each is proposed from a fresh read,
shown in full, and authorized once against a fingerprint of the exact values on
screen. There is no schedule anywhere that could do any of it unattended, and
the automatic tier is forbidden by the linter from importing the code that can.

**Buyer detail is not copied out of the provider.** Orders carry a pseudonymous
buyer reference rather than a name and address, and shipping labels — which have
both printed on them — are fetched from the carrier for one authorized access
and never stored. Erasure obligations are much simpler when there is nothing to
erase.

## Requirements

- Docker and Docker Compose
- Git

That is all. Node and pnpm run inside the development container, so nothing gets
installed on your machine and no version of anything you already have can affect
the result.

## Getting started

```bash
git clone https://github.com/jasonc123456/eCommerce-Inventory-Manager.git
cd eCommerce-Inventory-Manager

./scripts/dev.sh pnpm install          # starts the stack on first use
./scripts/dev.sh pnpm --filter @eim/db migrate
./scripts/dev.sh pnpm test
```

`scripts/dev.sh` runs a command inside the development container. Drop the
prefix if you have Node 24 and pnpm 11 natively.

The interface lives at `/inventory`, `/mappings`, `/operations` (drafts, prices,
and everything else awaiting a decision), `/shipping`, `/connections`, and
`/members`.

To run the web tier:

```bash
./scripts/dev.sh bash -c 'cd /workspace/apps/web && pnpm dev'
```

Then <http://localhost:3000>, with `/api/health` for liveness and `/api/ready`
for readiness.

To run the worker:

```bash
./scripts/dev.sh bash -c 'cd /workspace/apps/worker && pnpm dev'
```

It contends for the scheduler lease, wins if no other replica holds it, and
drives the projection cadence.

Mailpit captures every outbound message at <http://localhost:8025>, so
development can never send real authentication mail by accident. The guarantee
is `docker-compose.dev.yml` pointing `EIM_SMTP_HOST` at the capture container,
not anything in the code: no module decides whether mail is real, so a
deployment configured with a live relay sends live mail whatever `NODE_ENV`
says.

## Commands

| Command                  | What it does                                   |
| ------------------------ | ---------------------------------------------- |
| `pnpm test`              | Unit tests with coverage thresholds            |
| `pnpm test:integration`  | Integration tests against a real PostgreSQL 18 |
| `pnpm lint`              | ESLint, warnings treated as errors             |
| `pnpm typecheck`         | TypeScript across every package                |
| `pnpm format`            | Prettier, writing changes                      |
| `pnpm env:check --write` | Regenerate `.env.example` from the schema      |
| `pnpm licenses:check`    | Verify every dependency is AGPL-compatible     |
| `pnpm bench:queue`       | Re-run the V-06 queue benchmark                |

## Layout

```
apps/
  web/          Next.js App Router. Operator interface, OAuth callbacks, webhooks.
  worker/       Background jobs and the leased scheduler.
packages/
  domain/       Canonical inventory rules. Pure; no framework, database, or I/O.
  authz/        Permission catalogue and authorization checks. Also pure.
  db/           Schema, forward migrations, typed queries, leader election.
  config/       The only place permitted to read process.env.
  crypto/       Envelope encryption and the keyring. node:crypto and nothing else.
  identity/     Sessions, sign-in challenges, passkeys, memberships, bootstrap.
  audit/        The closed audit-action catalogue and the append-only recorder.
  mail/         SMTP transport and the transactional messages.
  ratelimit/    PostgreSQL fixed-window counters and in-memory pre-filtering.
  observability/ Structured logging with a field allowlist, and metrics.
  providers/    Channel and shipping adapter contracts, and programmable fakes.
  integrations/ eBay and WooCommerce clients, imports, webhooks, health, quotas.
  inventory/    Database-backed inventory services over the pure domain.
  jobs/         A generic durable queue. No domain knowledge.
  sync/         Targets, order pipeline, cadence, reconciliation, alerts.
  review/       The confirmation gate: propose, confirm, execute exactly once.
  listings/     Drafts, publication, one-time prices, restock, order copy.
  shipping/     Packages, rates, confirmed label purchase, voids, tracking.
  ui/           Shared interface primitives.
  testing/      Test harnesses. Never a runtime dependency.
docs/
  adr/          Architecture decision records.
  benchmarks/   Committed measurements the decisions cite.
```

The boundaries are enforced by the linter, not by convention.
`packages/domain` cannot import a framework, a database driver, or a provider —
which is what makes the inventory rules readable and property-testable without
any of it. `packages/sync`, `packages/jobs`, and `apps/worker` cannot import
`@eim/listings` or `@eim/shipping` at all, which is what makes "nothing
publishes or buys postage on its own" a build failure rather than a review
somebody has to catch.

## What is built

| Milestone             | Delivers                                                                                                               | Proven by                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| M0 Foundations        | Workspace, schema, migration runner, leased worker, quality rails, ADRs                                                | Constraint suite against real PostgreSQL 18                     |
| M1 Identity           | Sign-in links and codes, passkeys, TOTP, sessions, businesses, the permission catalogue, audit trail                   | `packages/identity` suites                                      |
| M2 Integrations       | eBay and WooCommerce connections, catalog import, webhooks, health, quotas — all read-only                             | `packages/integrations/src/acceptance.integration.test.ts`      |
| M3 Inventory          | Canonical ledger, locations, reservations, safety stock, channel caps, kits, mappings                                  | `packages/inventory` plus the `packages/domain` property suites |
| M4 Synchronization    | Order pipeline, projection to channels, cadence, reconciliation, conflicts, alerts                                     | `packages/sync/src/acceptance.integration.test.ts`              |
| M5 Listing operations | Drafts and two-stage publication with fees, one-time price copies, restock-to-live, the optional order copy            | `packages/listings/src/acceptance.integration.test.ts`          |
| M6 Shipping           | Packages from unshipped lines, rate comparison, confirmed label purchase, voids, label documents, tracking propagation | `packages/shipping/src/acceptance.integration.test.ts`          |

Each milestone's exit gate is a test rather than a claim, and each asserts the
absences as well as the behaviour: no automatic publication path exists, no
schedule can buy postage, and there is nowhere in the schema to store a label
document.

## Not yet usable

Two capabilities are implemented, tested, and deliberately switched off, because
each depends on a verification against a live third party that has not been
performed. Neither is a placeholder: the mechanism is complete and the refusal is
the specified behaviour until the evidence exists.

**Copying an eBay order into WooCommerce** refuses on every WooCommerce version.
Creating an order in a qualifying status makes WooCommerce run its own stock
reduction on top of the projection the original sale already wrote, so the copy
must suppress it. Every technique in the catalogue is recorded unverified until
verification V-03 proves one against a real store, and the specification would
rather the action be unavailable than ship a known double decrement.

**Buying a shipping label** has no live provider behind it. There is no HTTP
anywhere in the shipping path — the M6 exit gate asserts that structurally —
because verification V-04 has not established EasyPost's and Easyship's current
authentication, rate, label, refund, tracking, quota, and commercial contracts.
Everything runs against a programmable fake until it does.

Beyond those, the acceptance pilot has not run, and the AI assistance and
release-hardening milestones have not started.

## Security

Report vulnerabilities privately. See [SECURITY.md](SECURITY.md).

Two things an operator can most easily get wrong:

- `.env` holds the encryption keyring in plaintext. It must be readable only by
  its owner, and the backup encryption key belongs somewhere other than the
  machine being backed up.
- The database and mail services belong on an internal network. Do not publish
  them.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Commits need a DCO sign-off
(`git commit -s`); there is no contributor licence agreement and no copyright
assignment.

## Licence

[AGPL-3.0-only](LICENSE).

If you run a modified version as a network service, the AGPL requires you to
offer its source to the people using it. Running it unmodified for your own
business imposes no obligation.
