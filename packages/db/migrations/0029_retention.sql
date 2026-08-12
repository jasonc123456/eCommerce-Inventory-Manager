-- 0029_retention
--
-- How long things are kept, and the record of what was deleted (sections 13, 22, 37).
--
-- Section 37 settled a tension that this table encodes directly: "different
-- data classes carry different risk. Normalized history/audit defaults to 180;
-- raw sensitive bodies default to 30; zero means unlimited only where law,
-- erasure, security, and disk policy permit."
--
-- So there are two numbers rather than one, and they are not interchangeable.
--
-- `history_days` covers what this application wrote about itself: notification
-- deliveries, resolved alerts, AI suggestions. Zero means keep it, because
-- there is nothing in it that anybody has a right to have erased and an
-- installation with room may reasonably want its whole history.
--
-- `raw_event_days` covers what arrived from somewhere else and has not been
-- normalized: webhook bodies, provider payloads. These hold buyer names and
-- addresses, section 13 obliges this application to be able to erase them on a
-- marketplace's instruction, and an erasure that cannot reach every copy is not
-- an erasure. So zero is refused here and there is a ceiling: a business may
-- keep raw bodies for a shorter time than the default, never a longer one than
-- the schema permits.
--
-- The ceiling is in a check constraint rather than in a form, because a setting
-- screen is a thing somebody can be talked into changing and a constraint is
-- not.

create table business_retention_settings (
  business_id       uuid        primary key references businesses (id) on delete cascade,

  -- Section 22's default. Zero means keep.
  history_days      integer     not null default 180,

  -- Section 37's default, and its ceiling. Never zero.
  raw_event_days    integer     not null default 30,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint business_retention_settings_history_sane
    check (history_days >= 0 and history_days <= 3650),

  -- Ninety days is generous for debugging a webhook and short enough that a
  -- deletion request from a marketplace does not arrive after the data has
  -- been sitting for a year.
  constraint business_retention_settings_raw_bounded
    check (raw_event_days >= 1 and raw_event_days <= 90)
);

-- What a sweep did, so that "where did that go" has an answer.
--
-- Counts rather than identifiers. A list of what was deleted is a copy of what
-- was deleted, which would make the retention sweep the longest-lived store of
-- the data it exists to remove.
create table retention_runs (
  id                uuid        primary key default gen_random_uuid(),

  -- Null for a sweep over installation-wide classes.
  business_id       uuid        references businesses (id) on delete cascade,

  data_class        text        not null,
  rows_deleted      integer     not null,
  older_than        timestamptz not null,
  ran_at            timestamptz not null default now(),

  constraint retention_runs_class_known
    check (data_class in (
      'notification_deliveries', 'resolved_alerts', 'ai_suggestions',
      'webhook_deliveries', 'processed_events'
    )),
  constraint retention_runs_count_nonnegative check (rows_deleted >= 0)
);

create index retention_runs_recent on retention_runs (ran_at desc);
