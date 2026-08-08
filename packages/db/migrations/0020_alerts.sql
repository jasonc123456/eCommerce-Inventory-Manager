-- 0020_alerts
--
-- Things somebody needs to be told (sections 11, 12, 22).
--
-- Section 11 is explicit that an oversold order must "notify all owners and
-- users with `receive_critical_inventory_alerts`", and that "at least one
-- active critical-alert recipient must remain configured per business". This
-- table is the durable half of that: the record that an alert was raised, who
-- it was for, and whether anybody has acknowledged it. Delivery — email, and
-- whatever else section 22 adds — reads from here rather than being the only
-- place an alert exists, because an alert that lives only in a sent message is
-- an alert nobody can find the morning after.
--
-- Alerts deduplicate on their subject rather than accumulating. A mapping that
-- has been blocked for six hours is one thing to deal with, not seven hundred;
-- the count and the last-seen time carry how persistent it is without turning
-- an inbox into a denial of service against the person who has to fix it.

create table operator_alerts (
  id                  uuid        primary key default gen_random_uuid(),
  business_id         uuid        not null references businesses (id) on delete cascade,

  -- oversold | mapping_blocked | job_dead_lettered | connection_unhealthy |
  -- restock_pending | reconciliation_conflict
  kind                text        not null,
  severity            text        not null default 'warning',

  -- What this alert is about, so a repeat about the same thing finds it. Free
  -- text built at the call site from whatever identifies the subject.
  subject_key         text        not null,

  summary             text        not null,
  detail              jsonb       not null default '{}',

  -- Links, so the alert can be opened rather than merely read.
  mapping_id          uuid,
  canonical_item_id   uuid,
  connection_id       uuid,
  conflict_id         uuid        references inventory_conflicts (id) on delete set null,
  job_id              uuid        references background_jobs (id) on delete set null,

  occurrences         integer     not null default 1,
  first_seen_at       timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),

  acknowledged_at     timestamptz,
  acknowledged_by_user_id uuid    references users (id) on delete set null,
  acknowledgement_note text,

  constraint operator_alerts_kind_known
    check (kind in (
      'oversold', 'mapping_blocked', 'job_dead_lettered',
      'connection_unhealthy', 'restock_pending', 'reconciliation_conflict'
    )),
  constraint operator_alerts_severity_known
    check (severity in ('info', 'warning', 'critical')),
  constraint operator_alerts_occurrences_positive check (occurrences >= 1)
);

-- One open alert per subject. Acknowledging closes it; the next occurrence
-- opens a new one, which is what stops an acknowledgement from silencing a
-- problem that came back.
create unique index operator_alerts_one_open_per_subject
  on operator_alerts (business_id, kind, subject_key)
  where acknowledged_at is null;

create index operator_alerts_unacknowledged
  on operator_alerts (business_id, severity, last_seen_at)
  where acknowledged_at is null;
