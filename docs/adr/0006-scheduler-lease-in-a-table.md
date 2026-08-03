# 6. The scheduler lease is a table row, not an advisory lock

**Status:** Accepted (M0)

## Context

Section 16 allows more than one worker replica, and section 15 runs the
projection loop on a fixed cadence. Exactly one replica must own that clock: two
schedulers enqueuing the same sweep would double every job on every tick.

The obvious mechanism is a PostgreSQL session advisory lock. It is free, it is
atomic, and it releases automatically when the holding session ends.

## Decision

Use a **time-limited lease held as a row** in `scheduler_leases`, acquired and
renewed by single atomic statements whose `WHERE` clauses evaluate against the
database's clock.

## Why not an advisory lock

An advisory lock is invisible outside the session holding it. An operator asking
"which process is the scheduler, and is it alive?" has no way to find out, and
section 22 requires exactly that to be reportable on the health endpoint.

A row can be read by anybody, survives the process that wrote it, and carries
the evidence an incident needs: who holds it, since when, when it was last
renewed, and which build they are running. The last of those makes a
half-completed rolling deployment visible, which an advisory lock never could.

Automatic release on disconnect also sounds like an advantage and is a mixed
one. A network partition that drops the connection without killing the process
releases the lock while the process still believes it is the leader, which is
the split brain the mechanism exists to prevent. A lease that only the clock can
expire does not have that failure mode, because the deposed leader's next
renewal fails and tells it so.

## How correctness is obtained

Acquisition is one statement — an upsert whose `WHERE` clause admits the caller
only if the lease has expired or the caller already holds it. A read-then-write
would leave a window in which two candidates both see an expired lease and both
claim it, which is precisely the outcome being prevented. Ten replicas
contending simultaneously produce exactly one winner, and there is an
integration test that asserts it against a real database.

Renewal is likewise one statement, and returns whether it succeeded. A scheduler
that fails to renew must stop scheduling immediately: continuing would mean two
processes driving one clock.

Lease duration is three times the renewal interval. Too short and a
garbage-collection pause hands the clock to somebody else; too long and a dead
scheduler stalls the cadence until it expires.

## Consequences

An extra table and a small amount of write traffic — one statement per renewal
per replica, which at a 30-second interval is negligible.

A hard-killed leader stalls the cadence for up to one lease duration. Graceful
shutdown releases the lease deliberately, so a rolling deployment hands over in
milliseconds.

The pattern generalizes. The table is keyed by role, so a second leased
responsibility does not need a second mechanism.

## When to revisit

If leases are ever needed at a rate where the write traffic matters, or if a
future requirement needs fencing tokens to stop a delayed write from a deposed
leader landing after its successor's. The row already carries what a fencing
token would need.
