# 7. Integration tests use the Compose database, not Testcontainers

**Status:** Accepted (M0)

## Context

Section 25 requires integration tests to run against a real PostgreSQL 18, with
no in-memory fallback. D-116 names Testcontainers as the expected mechanism.

Testcontainers starts a container per test run from inside the test process,
which needs access to a Docker socket. Development here happens inside a
container, so honouring D-116 literally would mean mounting the host's Docker
socket into the development container — handing any code running there the
ability to start privileged containers on the host.

## Decision

Connect to the PostgreSQL already running in the Compose stack, and give each
test file its own database created from a migrated template.

The template name is derived from a hash of the migration file checksums. That
is what makes the cache correct rather than merely fast: a fixed name would
survive a migration edit, and every later run would copy a schema that no longer
matches the repository — passing tests against code that would fail on a fresh
database, which is the worst outcome a test harness can produce. Changing any
migration changes the hash, the next run finds no template, and it builds one.

In CI the same harness points at a `services: postgres` container, which is the
same real engine reached the same way.

## Alternatives rejected

**Testcontainers with the Docker socket mounted.** Full fidelity to D-116, at
the cost of giving the development container root-equivalent access to the host.
Not a reasonable trade for a benefit already obtained another way.

**Testcontainers on the host, outside the container.** Would split the toolchain
across the container boundary, which is the thing the containerized setup exists
to avoid.

**One shared database with transactional rollback per test.** Faster, and it
cannot test what needs testing here. Several of these tests deliberately violate
constraints, some exercise deferred constraint triggers that only fire at
commit, and the leader-election tests need genuine concurrent transactions.
Wrapping everything in one transaction would make all three impossible.

## Consequences

Integration tests need the development stack running. The harness fails with an
explicit message rather than degrading to a fake, which is what section 25
requires.

Databases are created and dropped per test file. A crashed run can leave one
behind; they are named `eim_test_*` and are harmless.

Superseded templates are dropped automatically when a new one is built, so the
schema history does not accumulate one database per migration.

## When to revisit

If development stops happening inside a container, Testcontainers becomes
straightforward and brings genuine benefits — notably testing against several
PostgreSQL versions in one run. The harness interface would not change; only its
implementation.
