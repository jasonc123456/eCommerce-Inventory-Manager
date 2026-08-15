-- 0032_pilot_stages
--
-- Staged connections (section 36, M9).
--
-- The M9 deliverable is "owner deployment, staged connections, 30-day measured
-- pilot". This is the staging, and it exists because of what the first live
-- connection otherwise is: an installation that has never written to a real
-- provider being pointed at a real seller account with five thousand mappings
-- and a scheduler that runs every thirty seconds.
--
-- The four stages.
--
--   observe   Everything is computed. Nothing is written. Every write the
--             system wanted to make is recorded instead, so an operator can
--             read a week of "here is what I would have done" against a live
--             catalogue before anything is at risk.
--   single    Exactly one enrolled mapping may be written.
--   cohort    Up to `cohort_limit` enrolled mappings may be written.
--   full      Every mapping may be written. This is ordinary operation; a
--             business that has never run a pilot is created here.
--
-- The gate has no override, and that is the point.
--
-- The obvious objection is protective reductions. If stock is gone and a channel
-- is still advertising it, staying silent is how an oversell happens — so should
-- a protective write be allowed to cross the gate?
--
-- No. A mapping that is not enrolled is a mapping this installation has not been
-- given authority over: the operator is still managing it by whatever means they
-- used before, and our idea of its quantity may be an import from days ago.
-- Writing a "protective" zero over a live listing on that basis is a destructive
-- write nobody authorized, and a boundary that a flag can cross is not a
-- boundary. An unenrolled mapping is not silently skipped either — every
-- withheld write is recorded below, with the quantity it would have sent.
--
-- Which makes the record the useful part. The withheld-write log is the evidence
-- an operator uses to decide whether to widen the stage: it is the system's own
-- proposed actions, against live data, with no consequences.

create table business_pilot_stages (
  business_id       uuid        primary key references businesses (id) on delete cascade,

  stage             text        not null default 'full',

  -- Only meaningful in `cohort`, and required there. A cohort with no ceiling
  -- is `full` under a name that suggests otherwise.
  cohort_limit      integer,

  -- The first moment this business left `observe`, which is the first moment a
  -- real provider could be written to. Section 1's thirty days are counted from
  -- here rather than from a date somebody types, because a measured pilot whose
  -- start can be backdated measures nothing.
  --
  -- Set once by the transition, never by hand.
  pilot_started_at  timestamptz,

  entered_at        timestamptz not null default now(),
  entered_by_user_id uuid       references users (id) on delete set null,
  note              text,

  constraint business_pilot_stages_stage_known
    check (stage in ('observe', 'single', 'cohort', 'full')),

  constraint business_pilot_stages_cohort_has_a_limit
    check ((stage = 'cohort') = (cohort_limit is not null)),

  constraint business_pilot_stages_cohort_limit_positive
    check (cohort_limit is null or cohort_limit > 0),

  -- A business past `observe` has started its pilot clock. One that is still in
  -- `observe` has not written anything and so has not started anything.
  constraint business_pilot_stages_started_when_writing
    check (stage = 'observe' or pilot_started_at is not null)
);

-- Which mappings the operator has handed over, and when.
--
-- Enrollment is per mapping rather than per connection because the unit of risk
-- is a write to one listing. A connection is how we reach it; a mapping is what
-- we would change.
create table pilot_enrollments (
  business_id        uuid        not null references businesses (id) on delete cascade,
  mapping_id         uuid        not null references channel_mappings (id) on delete cascade,
  enrolled_at        timestamptz not null default now(),
  enrolled_by_user_id uuid       references users (id) on delete set null,

  primary key (business_id, mapping_id)
);

create index pilot_enrollments_by_business on pilot_enrollments (business_id, enrolled_at);

-- Every write the stage gate stopped, with what it would have sent.
--
-- This is the observation record, and it is deliberately not an alert: during
-- `observe` a healthy installation produces one of these for every change, and a
-- notification per change would be noise that trains an operator to ignore the
-- channel it arrives on.
create table pilot_withheld_writes (
  id             uuid        primary key default gen_random_uuid(),
  business_id    uuid        not null references businesses (id) on delete cascade,
  mapping_id     uuid        not null,
  connection_id  uuid        not null,

  -- What would have gone to the provider, and what the provider last said it
  -- held. Side by side, because the interesting rows are the ones where they
  -- differ — those are the changes the pilot would have made.
  intended_quantity integer  not null,
  observed_quantity integer,

  stage          text        not null,
  reason         text        not null,
  withheld_at    timestamptz not null default now(),

  constraint pilot_withheld_writes_stage_known
    check (stage in ('observe', 'single', 'cohort'))
);

create index pilot_withheld_writes_recent
  on pilot_withheld_writes (business_id, withheld_at desc);

create index pilot_withheld_writes_retention on pilot_withheld_writes (withheld_at);

-- Existing businesses are ordinary installations, not pilots. Anything already
-- running is already writing, and moving it into `observe` on upgrade would
-- silently stop the synchronization it was installed to do.
insert into business_pilot_stages (business_id, stage, pilot_started_at)
select id, 'full', now() from businesses;
