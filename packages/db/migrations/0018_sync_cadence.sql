-- 0018_sync_cadence
--
-- How often each connection is swept, and how often it actually gets swept
-- (section 15).
--
-- Two intervals, deliberately. Section 15 requires showing "both the configured
-- target and current effective interval" and lengthening the effective one
-- "when provider quotas, connection health, store performance, or backlog make
-- the selected interval unsafe". Storing only one would leave an operator
-- unable to tell a setting they chose from a throttle the system applied, which
-- is precisely the moment they most need to know the difference.
--
-- The reason is stored beside the effective interval for the same reason. "Ten
-- seconds, currently sixty" invites a support ticket; "ten seconds, currently
-- sixty because the store is answering slowly" answers it.

create table connection_sync_settings (
  connection_id             uuid        primary key,
  business_id               uuid        not null,

  -- What the operator asked for. Section 15: ten seconds through thirty
  -- minutes, defaulting to thirty seconds.
  target_interval_seconds   integer     not null default 30,

  -- What the scheduler is actually using. Never shorter than the target.
  effective_interval_seconds integer    not null default 30,
  effective_reason          text,

  -- When each recurring sweep last ran, so the scheduler can tell what is due
  -- without keeping the answer in a process that may be restarted at any time.
  last_order_poll_at        timestamptz,
  last_dirty_sweep_at       timestamptz,
  last_full_sweep_at        timestamptz,
  last_order_rescan_at      timestamptz,
  last_health_check_at      timestamptz,
  last_catalog_sweep_at     timestamptz,

  -- Section 15's nightly full-catalog scan runs in the business's quiet window,
  -- which is a business setting; this records only when it last completed for
  -- this connection.
  paused                    boolean     not null default false,
  paused_reason             text,

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  constraint connection_sync_settings_target_bounded
    check (target_interval_seconds between 10 and 1800),
  -- The effective interval may be longer than the target but never shorter.
  -- Section 15 permits adaptive throttling in one direction only: going faster
  -- than an operator asked for is not a safety measure, it is a surprise.
  constraint connection_sync_settings_effective_not_faster
    check (effective_interval_seconds >= target_interval_seconds),

  constraint connection_sync_settings_connection_fkey
    foreign key (business_id, connection_id)
    references connections (business_id, id) on delete cascade
);

create index connection_sync_settings_by_business
  on connection_sync_settings (business_id);

create trigger connection_sync_settings_touch_updated_at
  before update on connection_sync_settings
  for each row execute function eim_touch_updated_at();
