-- 0031_convergence_samples
--
-- How long a change took to reach a channel (sections 1, 36).
--
-- Section 1's pilot bar is a measurement: "at least 95% of healthy-path
-- inventory updates meeting the two-minute target". Nothing in this
-- installation could produce that number before this table, and the reason is
-- worth stating because it is not obvious.
--
-- `channel_targets` holds one row per mapping and overwrites it. The moment a
-- mapping converges and then changes again, the timing of the previous
-- convergence is gone. `channel_write_attempts` retains its own start and
-- finish, but that measures how long our provider call took — not how long the
-- change waited before we made it, which is most of the latency and all of the
-- part an operator would care about.
--
-- So this is an append-only sample per (mapping, target version): one change,
-- one channel, one row, kept.
--
-- Where the clock starts.
--
-- At `noticed_at`: the moment the causing event became known to this
-- installation. Not the moment we got round to computing a target. Measuring
-- from our own computation would make a scheduler that ran once an hour look
-- instantaneous, which is precisely the failure the pilot bar exists to catch.
--
-- For an order that is the receipt of the webhook, or the poll that found it —
-- whichever came first, because two triggers about one order collapse into one
-- job and the surviving job carries the earlier time. For an operator action it
-- is the moment they acted. Both are "the earliest instant we could have
-- started", which is the only start time that cannot be gamed.
--
-- What is excluded, and why exclusions are counted rather than dropped.
--
-- Section 1 scopes the objective to "individual inventory events, not full
-- imports, full reconciliations, draft creation, price edits, AI work, or label
-- purchases", and excludes "external provider outages or throttling".
--
-- Both of those are real, and both are also the shape of an escape hatch: a
-- percentage computed after discarding whatever missed it will always be 100%.
-- So an excluded sample is still written, still counted, and still displayed
-- beside the figure it was excluded from. The report says "95.4% of 1,208
-- in-scope changes, with 96 excluded" and names the reasons. A reader can
-- disagree with an exclusion; they cannot fail to see one.
--
-- No buyer data. A mapping, a version, a quantity, and four timestamps. The
-- order that caused the change is identified only by the reason text already
-- carried on `channel_targets`, and nothing here reaches a buyer.

create table convergence_samples (
  id              uuid        primary key default gen_random_uuid(),
  business_id     uuid        not null references businesses (id) on delete cascade,
  mapping_id      uuid        not null,
  connection_id   uuid        not null,

  -- The version this sample is about. Together with the mapping it is the
  -- identity of one change to one channel.
  target_version  bigint      not null,
  quantity        integer     not null,

  -- order | restock | adjustment | mapping_change | manual
  --   Individual inventory events. Section 1 measures these.
  -- reconciliation | import | activation
  --   Bulk or catch-up work. Section 1 explicitly does not measure these.
  origin_kind     text        not null,

  noticed_at      timestamptz not null,
  computed_at     timestamptz not null default now(),

  -- pending | converged | superseded | abandoned
  --
  -- `superseded` is not a failure: the stock moved again before this version
  -- landed, so this version stopped being worth sending. The change it carried
  -- is measured by the version that replaced it, and counting both would punish
  -- a fast-moving item twice for one delay.
  outcome         text        not null default 'pending',
  converged_at    timestamptz,

  -- Set when the write path saw a provider outage, throttle, or circuit break
  -- while this sample was outstanding. Section 1 excludes provider unavailability
  -- from the objective; naming it here is what makes the exclusion auditable
  -- rather than an assertion in a report.
  excluded_reason text,

  -- Section 1's clock, in milliseconds, computed once and stored so that a
  -- percentile query does not recompute it across a month of rows.
  latency_ms      bigint generated always as (
    case when converged_at is null then null
         else (extract(epoch from (converged_at - noticed_at)) * 1000)::bigint
    end
  ) stored,

  -- Whether section 1's objective applies at all. A pure function of the origin,
  -- so it cannot drift from the rule it encodes and cannot be edited per row.
  in_slo_scope    boolean generated always as (
    origin_kind in ('order', 'restock', 'adjustment', 'mapping_change', 'manual')
  ) stored,

  constraint convergence_samples_origin_known
    check (origin_kind in ('order', 'restock', 'adjustment', 'mapping_change',
                           'manual', 'reconciliation', 'import', 'activation')),

  constraint convergence_samples_outcome_known
    check (outcome in ('pending', 'converged', 'superseded', 'abandoned')),

  -- Converged means there is a moment it converged, and nothing else has one.
  -- Without this a sample could claim success with no time attached and quietly
  -- vanish from both the numerator and the denominator.
  constraint convergence_samples_converged_has_a_time
    check ((outcome = 'converged') = (converged_at is not null)),

  -- Time does not run backwards between noticing a change and finishing it.
  constraint convergence_samples_time_moves_forward
    check (converged_at is null or converged_at >= noticed_at),

  -- One sample per change per channel. A retry of the same version is the same
  -- change still outstanding, not a second one.
  constraint convergence_samples_one_per_version
    unique (mapping_id, target_version)
);

-- The SLO query: in-scope samples for one business over a window.
create index convergence_samples_slo
  on convergence_samples (business_id, noticed_at desc)
  where in_slo_scope;

-- The "what is still outstanding" query, and the sweep that abandons samples
-- whose target was overtaken while nobody was looking.
create index convergence_samples_outstanding
  on convergence_samples (business_id, computed_at)
  where outcome = 'pending';

-- Retention reads this by age, like every other operational history table.
create index convergence_samples_retention on convergence_samples (noticed_at);
