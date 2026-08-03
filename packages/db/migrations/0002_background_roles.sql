-- 0002_background_roles
--
-- Leader election and liveness for background processes (sections 15, 16, 22).
--
-- Section 15 runs the projection loop on a fixed cadence, and section 16 allows
-- more than one worker replica. Exactly one of them must own the clock: two
-- schedulers enqueuing the same sweep would double every job on every tick.
--
-- The lease is a table row rather than a PostgreSQL advisory lock, and the
-- difference matters. An advisory lock is invisible outside the session holding
-- it, so an operator asking "which process is the scheduler, and is it alive?"
-- has no way to find out, and section 22 requires exactly that to be reportable
-- on the health endpoint. A row can be read by anybody, survives the process
-- that wrote it, and carries the evidence — who, since when, last heartbeat —
-- that an incident needs.

create table scheduler_leases (
  -- One row per leased responsibility. A single scheduler today; the column
  -- exists so a second background role does not need a second table.
  role            text        primary key,
  -- Identifies the process holding the lease. Not a hostname: containers are
  -- replaced and reuse names, and a stale row attributed to a name that now
  -- belongs to a different process is worse than an anonymous one.
  holder_id       uuid        not null,
  acquired_at     timestamptz not null default now(),
  -- The lease is valid until this instant and no longer. A holder that stops
  -- renewing loses it by the passage of time rather than by any action, which
  -- is what makes a hard kill recoverable without human involvement.
  expires_at      timestamptz not null,
  last_heartbeat  timestamptz not null default now(),
  -- Which build is holding it, so a mixed-version rollout is visible.
  app_version     text,

  constraint scheduler_leases_role_valid check (role in ('scheduler')),
  constraint scheduler_leases_expiry_after_acquisition check (expires_at > acquired_at)
);

-- Liveness for every background process, whether or not it holds a lease.
-- Section 22 alerts on worker and scheduler heartbeat freshness, which needs a
-- record of the workers that are running normally and not just the leader.
create table worker_heartbeats (
  worker_id     uuid        primary key,
  role          text        not null,
  started_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  app_version   text,
  -- Jobs in flight at the last heartbeat. Section 22 reports queue depth
  -- separately; this is the other half, how much is being worked on right now.
  active_jobs   integer     not null default 0,

  constraint worker_heartbeats_role_valid check (role in ('worker', 'scheduler')),
  constraint worker_heartbeats_active_jobs_nonnegative check (active_jobs >= 0)
);

-- "Which workers have gone quiet", the query behind the staleness alert.
create index worker_heartbeats_last_seen_idx on worker_heartbeats (last_seen_at);
