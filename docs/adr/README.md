# Architecture decision records

Each record captures one decision, the alternatives that were rejected, and the
circumstances under which it should be reconsidered.

The last section is the one that matters most. A decision without a stated
replacement boundary becomes permanent by default: nobody knows what would have
to be true to revisit it, so nobody does, and it survives long after the reason
for it has gone.

These were all made during milestone M0 and are open to revision at the M0
review, which is the cheapest moment any of them will ever have.

| #                                                          | Decision                                                       | Status   |
| ---------------------------------------------------------- | -------------------------------------------------------------- | -------- |
| [0001](0001-typescript-6-not-7.md)                         | TypeScript 6, not 7                                            | Accepted |
| [0002](0002-drizzle-with-hand-written-sql-migrations.md)   | Drizzle as a query builder, hand-written SQL migrations        | Accepted |
| [0003](0003-graphile-worker-for-the-queue.md)              | graphile-worker for the job queue                              | Accepted |
| [0004](0004-internal-packages-export-source.md)            | Internal packages export TypeScript source                     | Accepted |
| [0005](0005-log-field-allowlist.md)                        | Log fields pass an allowlist, not a denylist                   | Accepted |
| [0006](0006-scheduler-lease-in-a-table.md)                 | The scheduler lease is a table row, not an advisory lock       | Accepted |
| [0007](0007-integration-tests-use-the-compose-database.md) | Integration tests use the Compose database, not Testcontainers | Accepted |
| [0008](0008-nextjs-and-tailwind-for-the-web-tier.md)       | Next.js App Router and Tailwind for the web tier               | Accepted |
| [0009](0009-hand-rolled-authentication.md)                 | Authentication is built on primitives, not a framework         | Accepted |
