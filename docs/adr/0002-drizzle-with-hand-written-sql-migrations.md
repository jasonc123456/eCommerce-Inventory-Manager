# 2. Drizzle as a query builder, hand-written SQL migrations

**Status:** Accepted (M0)

## Context

Section 17 asks the database to enforce correctness rather than merely store it.
Concretely it requires composite foreign keys carrying `business_id` into every
reference, scoped partial unique indexes, CHECK constraints on quantities,
constraint triggers deferred to commit, `FOR UPDATE SKIP LOCKED`, advisory
locks, BRIN indexes, and expand/backfill/switch/contract migrations.

That list rules out most of the field. An ORM that generates DDL can only
generate the DDL it knows how to model, and the moment the schema needs
something outside that vocabulary, the tool stops being a convenience and starts
deciding what the schema is allowed to contain.

## Decision

Use **Drizzle ORM** as a typed query builder, and write the DDL by hand as
numbered forward-only SQL files applied by a small runner in `packages/db`.

The SQL is the source of truth for the schema. The Drizzle table definitions are
the query surface over it. They are kept in agreement by integration tests that
write through the Drizzle definitions against a database built by the
migrations: a column declared in one and missing from the other fails there.

## Alternatives rejected

**Prisma.** The best developer experience of the candidates and the wrong shape
for this schema. Composite foreign keys, partial indexes, and constraint
triggers all land in `Unsupported` or raw SQL escape hatches, at which point the
schema is half-declared in two places.

**Drizzle Kit's generated migrations.** Convenient, and the generator diffs the
declared schema against the database — so anything it cannot express, it cannot
generate, and it will happily propose dropping a constraint it does not
understand. The schema here contains several of those.

**Kysely.** A fine query builder with a similar philosophy. Drizzle was chosen
for the better relational query API and the larger ecosystem; the decision is
close and would not be painful to reverse.

**Raw `pg` throughout.** No abstraction to fight, and no type safety on a query
either. On a schema with this many business-scoped compound keys, the types are
what stop a query from silently reading the wrong tenant's rows.

## Consequences

Every schema change is written by hand, which is slower and is the point: the
person writing the migration has to think about locking, about the expand and
contract steps, and about what happens to a running replica of the previous
version.

Applied migrations are immutable. The runner records a checksum and refuses to
proceed if a file changes after it was applied, because a schema that no longer
matches the file describing it is a fault worth stopping for.

There are no down-migrations. Section 17 rules out depending on destructive
automatic rollback, so recovery from a bad migration is a new forward migration
or a restore.

## When to revisit

If a future Drizzle Kit can express the full constraint vocabulary in section 17
and can be trusted not to propose dropping what it cannot model, generation
becomes worth reconsidering for the routine cases. The runner and the file
format would not need to change.
