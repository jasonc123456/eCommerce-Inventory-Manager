-- 0015_channel_targets
--
-- What each channel should be advertising, and what it last actually said
-- (sections 8, 12, 15).
--
-- Section 12 requires that "desired targets carry monotonically increasing
-- internal versions", that "superseded jobs are skipped", and that "older
-- targets can never overwrite newer committed targets". One row per mapping
-- holds the newest desired quantity and its version; a write job carries the
-- version it was enqueued for and stands down when it is no longer the newest.
--
-- Desired and observed are kept apart on purpose. They answer different
-- questions — what this ledger says, versus what the provider says — and a
-- single column would make the most important state in the system, "these two
-- disagree", impossible to express.
--
-- The version is a bigint and never resets. It is not a timestamp: two writes
-- inside the same millisecond are ordinary under load, and a clock that goes
-- backwards during an NTP correction would silently reorder them.

create table channel_targets (
  business_id           uuid        not null,
  mapping_id            uuid        not null,

  -- Monotonic per mapping. Bumped by the writer, never by a trigger, so the
  -- caller receives the version it just created and can carry it on the job.
  target_version        bigint      not null default 1,

  -- The absolute quantity to advertise, from `channelTarget` in @eim/domain.
  -- Absolute, never a delta: section 8's rule, and what makes a retry after an
  -- ambiguous timeout harmless.
  desired_quantity      integer     not null,

  -- Why this target exists, for the timeline. Free text from a fixed set at the
  -- call site rather than a check constraint, because the reasons will grow.
  reason                text,
  computed_at           timestamptz not null default now(),

  -- What was last successfully written, and at which version. A target whose
  -- written version equals its target version has converged.
  written_version       bigint,
  written_quantity      integer,
  written_at            timestamptz,

  -- What the provider last said, whoever asked. Section 15 treats this as
  -- evidence rather than truth: an observation that disagrees with the written
  -- quantity is the input to reconciliation, not a correction to apply.
  observed_quantity     integer,
  observed_at           timestamptz,
  -- The provider's own opaque version token, for a conditional write.
  observed_version      text,
  observed_backorders   boolean,

  -- pending    the desired version has not been written
  -- converged  written and, where checked, verified to match
  -- degraded   the last write or verification failed; retrying
  -- blocked    writing is refused until something is resolved
  state                 text        not null default 'pending',
  state_reason          text,

  consecutive_failures  integer     not null default 0,
  updated_at            timestamptz not null default now(),

  constraint channel_targets_pkey primary key (mapping_id),
  constraint channel_targets_state_known
    check (state in ('pending', 'converged', 'degraded', 'blocked')),
  constraint channel_targets_quantity_not_negative
    check (desired_quantity >= 0),
  -- Section 12: an older target can never overwrite a newer committed one, so a
  -- written version ahead of the desired version is not a state to recover
  -- from, it is a state that must never be storable.
  constraint channel_targets_written_not_ahead
    check (written_version is null or written_version <= target_version),

  constraint channel_targets_mapping_fkey
    foreign key (business_id, mapping_id)
    references channel_mappings (business_id, id) on delete cascade
);

create index channel_targets_unconverged
  on channel_targets (business_id, state, updated_at)
  where state <> 'converged';

create trigger channel_targets_touch_updated_at
  before update on channel_targets
  for each row execute function eim_touch_updated_at();

-- Every write actually attempted, and what came back.
--
-- Section 15 requires a verification read after an outbound write and section
-- 12 requires an outcome lookup before retrying anything financially
-- consequential. Both need a record of what was sent, not merely of what was
-- wanted, and the target row above is overwritten by design.
create table channel_write_attempts (
  id                uuid        primary key default gen_random_uuid(),
  business_id       uuid        not null,
  mapping_id        uuid        not null,
  job_id            uuid        references background_jobs (id) on delete set null,

  target_version    bigint      not null,
  quantity          integer     not null,

  -- The key sent to the provider. Section 12: a retry after an ambiguous
  -- timeout must not apply the same change twice, and the provider can only
  -- honour that if we send the same key.
  idempotency_key   text        not null,

  -- sent | acknowledged | unchanged | failed | superseded
  outcome           text,
  failure_kind      text,
  detail            text,

  -- What a verification read found afterwards, when one ran.
  verified_quantity integer,
  verified_at       timestamptz,

  started_at        timestamptz not null default now(),
  finished_at       timestamptz,

  constraint channel_write_attempts_outcome_known
    check (outcome is null
           or outcome in ('sent', 'acknowledged', 'unchanged', 'failed', 'superseded')),
  constraint channel_write_attempts_key_unique unique (mapping_id, idempotency_key),
  constraint channel_write_attempts_mapping_fkey
    foreign key (business_id, mapping_id)
    references channel_mappings (business_id, id) on delete cascade
);

create index channel_write_attempts_recent
  on channel_write_attempts (mapping_id, started_at desc);

-- Correcting the dedupe index introduced in 0014.
--
-- It covered both 'ready' and 'running', which reads as "one job per entity" but
-- means something else: a wake-up arriving while a job for that entity is
-- already running would be swallowed, and the running job may already have read
-- the state the new event is about. Dedupe should mean "an identical *pending*
-- intent already exists"; a running job is no longer pending. This is the first
-- migration with real users of dedupe keys, which is why it is corrected here
-- rather than left for the first missed event to find.
drop index background_jobs_pending_dedupe;

create unique index background_jobs_pending_dedupe
  on background_jobs (dedupe_key)
  where status = 'ready' and dedupe_key is not null;
