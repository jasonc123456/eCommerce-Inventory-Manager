# eCommerce Inventory Manager

Self-hosted inventory synchronization between eBay and WooCommerce, built around
a single canonical stock ledger that both channels project from.

> **Status: milestone M0 — foundations.** The workspace, database schema,
> background worker, and quality rails are in place and tested. There is no
> user interface, no sign-in, and no marketplace connection yet. Those arrive in
> M1 and M2. It is not usable as an application today.

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
development can never send real authentication mail by accident.

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
  observability/ Structured logging with a field allowlist, and metrics.
  providers/    Channel adapter contracts and programmable fakes.
  testing/      Test harnesses. Never a runtime dependency.
docs/
  adr/          Architecture decision records.
  benchmarks/   Committed measurements the decisions cite.
```

The boundaries are enforced by the linter, not by convention.
`packages/domain` cannot import a framework, a database driver, or a provider —
which is what makes the inventory rules readable and property-testable without
any of it.

## What M0 delivers

- pnpm workspace with a version catalog, a frozen lockfile, and a two-day
  minimum release age on every dependency
- PostgreSQL schema for tenancy and inventory, with every constraint technique
  the specification requires, and 40 integration tests proving each one bites
- Forward-only migration runner: advisory-locked, checksum-verified, safe to run
  from several containers at once
- Background worker with lease-based leader election, verified against ten-way
  concurrent contention
- Web tier with liveness and readiness endpoints
- Logging that filters every field through an allowlist at every level
- Provider adapter contracts and a programmable fake, with no live HTTP anywhere
- Tiered CI: fast checks, integration, CodeQL, and a Compose smoke test, with
  every third-party action pinned to a commit SHA
- Nine architecture decision records, each with the conditions for revisiting it

## What M0 does not deliver

No sign-in. No eBay or WooCommerce connection. No catalog, mappings, orders, or
synchronization. No user interface beyond a placeholder page.

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
