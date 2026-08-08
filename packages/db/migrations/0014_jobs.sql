-- 0014_jobs
--
-- The durable job queue (sections 12, 15, 16).
--
-- Section 12 requires that "one PostgreSQL transaction records event outcome,
-- ledger events, resulting balances, conflicts, and transactional-outbox
-- intents" and that "outbound workers act only after commit". With the
-- PostgreSQL-only topology of D-046 those two sentences describe one table:
-- enqueuing is an insert in the caller's transaction, so a job that exists is a
-- job whose cause committed, and a job whose cause rolled back was never
-- written. There is no separate outbox to drain and no window in which the two
-- disagree. That is the whole reason the no-Redis decision is worth its cost.
--
-- Three properties the columns exist to enforce:
--
--   A job is claimed by exactly one worker. `claim_lease_expires_at` is granted
--   by the database's clock, never a worker's, because the failure being
--   guarded against is a worker whose sense of time has become unreliable.
--
--   Work that must not run concurrently does not. `serialization_key` names a
--   scope — section 12's "writes serialize per channel mapping" — and the
--   partial unique index below makes two running jobs in one scope unstorable
--   rather than merely unlikely.
--
--   A job stops. Section 12 as amended by D-138 allows ten attempts and a
--   24-hour window, whichever comes first, and D-139 requires dead-lettering
--   immediately rather than sleeping past the deadline. `expires_at` is written
--   once at enqueue so the deadline cannot drift with each retry.

create table background_jobs (
  id                  uuid        primary key default gen_random_uuid(),

  -- Null for installation-wide work: marketplace account deletion (section 13)
  -- fans out across every business and belongs to none of them.
  business_id         uuid        references businesses (id) on delete cascade,
  connection_id       uuid,

  kind                text        not null,

  -- Section 12: "order ingestion and inventory writes take priority over
  -- imports, reconciliation, prices, drafts, AI, and reporting." Lower sorts
  -- first, so the number reads as a rank rather than a score.
  priority            integer     not null default 50,

  -- The scope within which this job must run alone. Null means "runs alongside
  -- anything", which is the honest default: most work is not order-sensitive
  -- and serializing it would cost throughput for no correctness gain.
  serialization_key   text,

  -- Collapses repeated wake-ups for the same entity (section 15) without losing
  -- the audit evidence, which lives on the event rather than the job. Null
  -- means every enqueue is its own job.
  dedupe_key          text,

  payload             jsonb       not null default '{}',

  -- ready      waiting for its run_at
  -- running    claimed by a live worker
  -- succeeded  finished
  -- dead       out of attempts, out of window, or refused outright
  -- cancelled  superseded or withdrawn before it ran
  status              text        not null default 'ready',

  attempts            integer     not null default 0,
  max_attempts        integer     not null default 10,

  run_at              timestamptz not null default now(),

  -- Written once at enqueue. Section 12 measures the 24-hour window from the
  -- job's origin, so a job that has already burned twenty-three hours cannot
  -- buy itself another day by failing again.
  expires_at          timestamptz not null,

  claimed_by          uuid,
  claimed_at          timestamptz,
  claim_lease_expires_at timestamptz,

  -- The typed reason the last attempt failed, from the provider outcome union.
  last_failure_kind   text,
  last_error          text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  finished_at         timestamptz,

  constraint background_jobs_status_known
    check (status in ('ready', 'running', 'succeeded', 'dead', 'cancelled')),
  constraint background_jobs_attempts_bounded
    check (attempts >= 0 and attempts <= max_attempts),
  constraint background_jobs_max_attempts_positive
    check (max_attempts >= 1),

  -- A running job has a holder and a lease; a job that is not running has
  -- neither. Without this a crashed reclaim could leave a row that looks
  -- claimed forever, and nothing would notice.
  constraint background_jobs_running_is_held
    check (
      (status = 'running') = (claimed_by is not null and claim_lease_expires_at is not null)
    ),

  constraint background_jobs_business_scoped_connection
    foreign key (business_id, connection_id)
    references connections (business_id, id) on delete cascade
);

-- The claim path: ready jobs in priority order. Partial, because the runnable
-- set stays small while the finished set grows without bound, and an index over
-- both would spend most of its size on rows no worker will ever look at.
create index background_jobs_claimable
  on background_jobs (priority, run_at, created_at)
  where status = 'ready';

-- Section 12's per-mapping serialization, as a constraint rather than a
-- convention. Two workers that race past the claim query's exclusion check
-- collide here instead of both writing to one channel mapping; the loser sees a
-- unique violation and takes the next job.
create unique index background_jobs_one_running_per_key
  on background_jobs (serialization_key)
  where status = 'running' and serialization_key is not null;

-- Section 15: "coalesce repeated wake-ups for the same entity". A second
-- enqueue for an entity already waiting is the same job, not another one.
create unique index background_jobs_pending_dedupe
  on background_jobs (dedupe_key)
  where status in ('ready', 'running') and dedupe_key is not null;

-- Reclaiming jobs whose worker died, and the startup recovery sweep.
create index background_jobs_expired_leases
  on background_jobs (claim_lease_expires_at)
  where status = 'running';

create index background_jobs_by_business
  on background_jobs (business_id, kind, status, created_at);

create trigger background_jobs_touch_updated_at
  before update on background_jobs
  for each row execute function eim_touch_updated_at();

-- Attempt history, kept separately from the job.
--
-- The job row holds the current state and is updated in place; this table is
-- append-only and holds what happened. Folding the two together would mean
-- either losing every attempt but the last, or never being able to answer "did
-- this job fail the same way nine times, or nine different ways" — which is the
-- question an operator actually asks when a job reaches the dead-letter queue.
create table background_job_attempts (
  id                uuid        primary key default gen_random_uuid(),
  job_id            uuid        not null references background_jobs (id) on delete cascade,

  -- Counts claims, not retries. A claim released on shutdown or reclaimed after
  -- a crash refunds the job's retry budget but still happened, and an operator
  -- replay resets that budget without erasing what came before. This column
  -- answers "what has this job been through", which has to keep counting when
  -- the retry budget does not.
  attempt           integer     not null,
  worker_id         uuid,
  started_at        timestamptz not null default now(),
  finished_at       timestamptz,
  -- succeeded | failed | superseded | reclaimed
  outcome           text,
  failure_kind      text,
  -- Redacted at the call site; section 19 keeps provider payloads out of
  -- anything an operator reads casually.
  detail            text,
  -- What the provider asked for, when it asked. Recorded even when the schedule
  -- overrode it, so D-139's dead-letter decision can be explained afterwards.
  retry_after_ms    integer,
  next_run_at       timestamptz,

  constraint background_job_attempts_unique unique (job_id, attempt),
  constraint background_job_attempts_outcome_known
    check (outcome is null or outcome in ('succeeded', 'failed', 'superseded', 'reclaimed'))
);

create index background_job_attempts_by_job on background_job_attempts (job_id, attempt);

create or replace function eim_background_job_attempts_append_only()
returns trigger language plpgsql as $$
begin
  -- Completing an attempt is an update to the row that opened it, so this
  -- guards deletion and the rewriting of history, not the closing write.
  if tg_op = 'DELETE' then
    raise exception 'background_job_attempts is append-only';
  end if;

  if new.job_id <> old.job_id or new.attempt <> old.attempt or new.started_at <> old.started_at then
    raise exception 'background_job_attempts identity is immutable';
  end if;

  return new;
end;
$$;

create trigger background_job_attempts_immutable
  before update or delete on background_job_attempts
  for each row execute function eim_background_job_attempts_append_only();
