-- 0019_reconciliation
--
-- Comparing what this ledger says with what a channel says, and what to do when
-- they disagree (sections 12, 15).
--
-- The distinction the whole design turns on is in section 15: a channel value
-- that disagrees with ours is *evidence*, never a correction. Reconciliation
-- may push a canonical figure out to a channel; it may never pull a channel
-- figure into physical inventory. Adopting an unexplained external number is a
-- decision only an authorized human can take, with a reason recorded, which is
-- why `inventory_conflicts` exists rather than a background job that quietly
-- makes the numbers agree.
--
-- A run records what it examined even when it found nothing. Section 15 wants
-- reports carrying "scope, trigger, checkpoints, duration, examined entities,
-- matches, discrepancies, automatic repairs, conflicts, unsupported skips,
-- failed API operations, quota impact, and final convergence state" — and a
-- clean run is the evidence that a mapping was checked, which is worth as much
-- as a dirty one when somebody asks what happened last Tuesday.

create table reconciliation_runs (
  id                  uuid        primary key default gen_random_uuid(),
  business_id         uuid        not null,
  connection_id       uuid,

  -- item | mapping | connection | business | installation
  scope               text        not null,
  scope_id            uuid,

  -- scheduled | manual | post_write | post_event | startup
  trigger             text        not null,

  -- A dry run proposes; an applied run carries out what a person approved.
  dry_run             boolean     not null default true,

  -- running | completed | failed | cancelled
  status              text        not null default 'running',

  started_at          timestamptz not null default now(),
  finished_at         timestamptz,

  examined            integer     not null default 0,
  matched             integer     not null default 0,
  discrepancies       integer     not null default 0,
  repaired            integer     not null default 0,
  conflicts_opened    integer     not null default 0,
  skipped             integer     not null default 0,
  failed_calls        integer     not null default 0,

  -- Resumable checkpoints. Section 15 reconciles entities independently with
  -- checkpoints rather than locking a whole business, so a run interrupted
  -- halfway is resumed rather than restarted.
  checkpoint          jsonb       not null default '{}',
  failure_summary     text,
  requested_by_user_id uuid       references users (id) on delete set null,

  constraint reconciliation_runs_scope_known
    check (scope in ('item', 'mapping', 'connection', 'business', 'installation')),
  constraint reconciliation_runs_trigger_known
    check (trigger in ('scheduled', 'manual', 'post_write', 'post_event', 'startup')),
  constraint reconciliation_runs_status_known
    check (status in ('running', 'completed', 'failed', 'cancelled')),
  constraint reconciliation_runs_business_fkey
    foreign key (business_id) references businesses (id) on delete cascade
);

create index reconciliation_runs_recent
  on reconciliation_runs (business_id, started_at desc);

-- One row per mapping examined. This is the repair plan when the run is a dry
-- run, and the record of what was done when it is not.
create table reconciliation_findings (
  id                  uuid        primary key default gen_random_uuid(),
  run_id              uuid        not null references reconciliation_runs (id) on delete cascade,
  business_id         uuid        not null,
  mapping_id          uuid        not null,

  -- The versions this comparison was made against. Section 15: "compare against
  -- the current canonical version at the point each entity is evaluated [and]
  -- if that version changes before a conclusion or repair commits, discard the
  -- stale result." The plan is only valid for the versions it names.
  canonical_version   bigint      not null,
  observed_version    text,

  canonical_quantity  integer     not null,
  observed_quantity   integer,

  -- match         the channel already says what it should
  -- stale_write   explainable: our own write has not landed yet
  -- drift         unexplained: the channel says something nobody wrote
  -- unsupported   the entity cannot carry inventory in this version
  -- unreachable   the provider could not be asked
  finding             text        not null,

  -- What the run proposes, or did: none | write | conflict
  proposed_action     text        not null default 'none',
  applied             boolean     not null default false,
  applied_at          timestamptz,
  detail              text,
  created_at          timestamptz not null default now(),

  constraint reconciliation_findings_known
    check (finding in ('match', 'stale_write', 'drift', 'unsupported', 'unreachable')),
  constraint reconciliation_findings_action_known
    check (proposed_action in ('none', 'write', 'conflict')),
  constraint reconciliation_findings_unique unique (run_id, mapping_id),
  constraint reconciliation_findings_mapping_fkey
    foreign key (business_id, mapping_id)
    references channel_mappings (business_id, id) on delete cascade
);

create index reconciliation_findings_by_run on reconciliation_findings (run_id);

-- An unexplained disagreement, waiting for somebody to decide.
--
-- Section 12: "an unresolved mismatch cannot be dismissed." So there is no
-- "ignore" resolution — every path out of a conflict states what was believed
-- and why, and the ones that change stock do it through the ledger like
-- everything else.
create table inventory_conflicts (
  id                  uuid        primary key default gen_random_uuid(),
  business_id         uuid        not null,
  mapping_id          uuid,
  canonical_item_id   uuid,
  connection_id       uuid,

  -- quantity_drift | oversold | allocation_blocked | entity_missing
  kind                text        not null,
  severity            text        not null default 'high',

  -- open | resolved
  status              text        not null default 'open',

  expected_quantity   integer,
  observed_quantity   integer,
  summary             text        not null,
  -- Links to the run and finding that produced it, rather than a copy of the
  -- payload. Section 15: "conflict records link to the relevant reconciliation
  -- evidence without duplicating sensitive payloads unnecessarily."
  run_id              uuid        references reconciliation_runs (id) on delete set null,
  finding_id          uuid        references reconciliation_findings (id) on delete set null,

  -- adopt_external | overwrite_channel | audited_quantity | remap |
  -- shortage_disposition | repaired
  resolution          text,
  resolution_reason   text,
  resolved_by_user_id uuid        references users (id) on delete set null,
  resolved_at         timestamptz,
  ledger_entry_id     uuid        references inventory_ledger (id) on delete restrict,

  opened_at           timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint inventory_conflicts_kind_known
    check (kind in ('quantity_drift', 'oversold', 'allocation_blocked', 'entity_missing')),
  constraint inventory_conflicts_severity_known
    check (severity in ('low', 'medium', 'high', 'critical')),
  constraint inventory_conflicts_status_known
    check (status in ('open', 'resolved')),
  constraint inventory_conflicts_resolution_known
    check (resolution is null or resolution in (
      'adopt_external', 'overwrite_channel', 'audited_quantity',
      'remap', 'shortage_disposition', 'repaired'
    )),
  -- Section 12: "a reason, impact preview, and confirmation are mandatory", and
  -- "an unresolved mismatch cannot be dismissed." A resolved conflict with no
  -- resolution and no reason is exactly the dismissal that rule forbids.
  constraint inventory_conflicts_resolution_complete
    check (
      status <> 'resolved'
      or (resolution is not null and resolution_reason is not null and resolved_at is not null)
    ),

  constraint inventory_conflicts_business_fkey
    foreign key (business_id) references businesses (id) on delete cascade,
  constraint inventory_conflicts_mapping_fkey
    foreign key (business_id, mapping_id)
    references channel_mappings (business_id, id) on delete set null
);

-- One open conflict per mapping per kind. A drift that is re-detected every
-- thirty minutes must not produce a queue of identical decisions.
create unique index inventory_conflicts_one_open_per_mapping
  on inventory_conflicts (mapping_id, kind)
  where status = 'open' and mapping_id is not null;

create index inventory_conflicts_open
  on inventory_conflicts (business_id, severity, opened_at)
  where status = 'open';

create trigger inventory_conflicts_touch_updated_at
  before update on inventory_conflicts
  for each row execute function eim_touch_updated_at();
