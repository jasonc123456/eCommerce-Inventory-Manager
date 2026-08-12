-- 0025_alert_lifecycle
--
-- The rest of an alert's life (section 22).
--
-- Migration 0020 gave alerts a birth and a death: raised, then acknowledged.
-- Section 22 asks for four states rather than two — Open, Acknowledged,
-- Snoozed, Resolved — and it separates two things 0020 had merged. An
-- acknowledgement is a person saying "I have seen this"; a resolution is the
-- world saying "this has stopped being true". Treating the first as the second
-- is how a monitoring system tells you a problem went away when what actually
-- happened is that somebody clicked a button.
--
-- So the acknowledgement no longer closes anything. Section 22: acknowledgement
-- "suppresses ordinary repeats without hiding ongoing state or escalation to a
-- more severe condition". The alert stays open, keeps counting occurrences, and
-- stops sending reminders — until a fresh check proves recovery, which is the
-- only thing here that may write `resolved_at`.
--
-- That is a stricter rule than 0020's, not a looser one. 0020 worried that an
-- acknowledgement could permanently silence a problem that came back, and
-- answered it by closing the alert so the next occurrence opened a new row.
-- This answers the same worry by never closing on an opinion at all.
--
-- Existing acknowledged rows are resolved as part of this migration, because
-- under the old rules an acknowledgement *was* a closure and rewriting history
-- to mean something else would be a lie about what those operators did.
--
-- Four columns are absent on purpose.
--
-- There is no `state` column. State is a function of four timestamps and the
-- current time — a snooze expires without anybody writing a row — so a stored
-- copy would be a second source of truth that is wrong between the moment a
-- snooze lapses and the moment some sweep notices. The same reasoning as the
-- ledger and its balance: keep what happened, derive what it means.
--
-- There is no delivery record here. Whether an email left the building belongs
-- with the notification that carried it, not with the problem it described; an
-- alert that exists only in a sent message is the thing 0020 was avoiding.
--
-- There is no free-text resolution note. `resolved_evidence` is required to be
-- present exactly when `resolved_at` is, so "proved recovery" has something
-- behind it rather than being a word somebody typed.
--
-- There is no severity ordering by name. `severity_rank` is generated, because
-- text ordering puts 'critical' before 'error' before 'info' before 'warning',
-- which would have sorted the worst alerts into the middle of the list.

-- ---------------------------------------------------------------------------
-- Installation scope
-- ---------------------------------------------------------------------------
--
-- Section 22 alerts installation administrators about queue, scheduler, worker,
-- SMTP, database, backup, migration, disk, and configuration problems. None of
-- those belongs to a business: the queue is not any one shop's queue, and
-- attaching a stalled worker to whichever business happened to be first in the
-- table would make it disappear when that business was deleted.
--
-- So `business_id` becomes nullable, and null is not "unknown" — it is the
-- installation. A check ties that to the kind, so an installation problem
-- cannot be filed under a shop and a shop's problem cannot escape into the
-- installation's list.

alter table operator_alerts alter column business_id drop not null;

-- Derived rather than stored, so it cannot disagree with the column it
-- describes. Section 22 lists scope as part of an alert; this is that field,
-- and it is one fact rather than two.
alter table operator_alerts
  add column scope text
  generated always as (case when business_id is null then 'installation' else 'business' end)
  stored;

alter table operator_alerts drop constraint operator_alerts_kind_known;

alter table operator_alerts
  add constraint operator_alerts_kind_known
  check (kind in (
    -- Business scope: section 22's "immediately alert business owners" list,
    -- plus the four kinds milestone 4 already raised.
    'oversold', 'mapping_blocked', 'job_dead_lettered',
    'connection_unhealthy', 'restock_pending', 'reconciliation_conflict',
    'channel_stockout', 'unsafe_drift', 'credential_revoked',
    'sync_failing', 'quota_exhausted',
    -- Installation scope: section 22's "immediately alert installation
    -- administrators" list.
    'worker_unavailable', 'scheduler_unavailable', 'queue_stalled',
    'smtp_failing', 'database_unready', 'backup_failed',
    'migration_mismatch', 'disk_pressure', 'configuration_invalid'
  ));

alter table operator_alerts
  add constraint operator_alerts_scope_matches_kind
  check ((business_id is null) = (kind in (
    'worker_unavailable', 'scheduler_unavailable', 'queue_stalled',
    'smtp_failing', 'database_unready', 'backup_failed',
    'migration_mismatch', 'disk_pressure', 'configuration_invalid'
  )));

-- ---------------------------------------------------------------------------
-- Severity
-- ---------------------------------------------------------------------------
--
-- Section 22 uses four severities; 0020 had three. Error sits between Warning
-- and Critical and is the one section 22 routes to email by configuration
-- rather than by opt-in, so it needs to exist as its own level rather than
-- being rounded up into Critical, which bypasses quiet hours.

alter table operator_alerts drop constraint operator_alerts_severity_known;

alter table operator_alerts
  add constraint operator_alerts_severity_known
  check (severity in ('info', 'warning', 'error', 'critical'));

alter table operator_alerts
  add column severity_rank smallint
  generated always as (case severity
    when 'critical' then 4
    when 'error'    then 3
    when 'warning'  then 2
    else 1
  end) stored;

-- ---------------------------------------------------------------------------
-- Lifecycle columns
-- ---------------------------------------------------------------------------

alter table operator_alerts
  -- Section 22 deduplicates "by business, resource, problem type, and relevant
  -- state version". The first three were already the key. This is the fourth:
  -- an opaque string the caller sets when the same subject can be wrong in a
  -- way that is genuinely a different problem — drift measured against a newer
  -- desired version is not the drift somebody already looked at. Empty and not
  -- null, so two alerts without one collide instead of both being allowed.
  add column state_version text not null default '',

  -- What to do about it. Section 22 asks every alert to carry one; it is
  -- nullable because a kind that has nothing useful to say should say nothing
  -- rather than something generic.
  add column recommended_action text,

  -- Recovery. Written only by a check that ran after the fact and found the
  -- problem gone; the constraint below is what makes that more than a comment.
  add column resolved_at timestamptz,
  add column resolved_evidence jsonb,

  -- Snoozing. "Not now" rather than "seen": it suppresses reminders until the
  -- time passes and then the alert speaks up again by itself.
  add column snoozed_until timestamptz,
  add column snoozed_by_user_id uuid references users (id) on delete set null,

  -- Escalation state. Section 22 sends unresolved Error and Critical reminders
  -- after fifteen minutes, one hour, and four hours, then at most daily.
  add column notified_at timestamptz,
  -- The severity that was last notified about, so that a warning becoming
  -- critical notifies immediately instead of waiting for the next reminder.
  -- Section 22: "material severity changes notify immediately."
  add column notified_severity_rank smallint,
  add column reminders_sent integer not null default 0,
  add column next_reminder_at timestamptz;

alter table operator_alerts
  add constraint operator_alerts_resolution_has_evidence
  check ((resolved_at is null) = (resolved_evidence is null));

alter table operator_alerts
  add constraint operator_alerts_reminders_not_negative
  check (reminders_sent >= 0);

-- A resolved alert is finished. Nothing may still be waiting to remind somebody
-- about a problem that has been proven gone.
alter table operator_alerts
  add constraint operator_alerts_resolved_alerts_are_quiet
  check (resolved_at is null or next_reminder_at is null);

-- ---------------------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------------------
--
-- Under 0020, acknowledging closed the alert. Those rows are resolved with the
-- acknowledgement as their evidence and their own timestamp, which is what they
-- meant when they were written. The alternative — carrying them forward as
-- acknowledged-but-open — would reopen every alert anybody ever dealt with.

update operator_alerts
   set resolved_at = acknowledged_at,
       resolved_evidence = jsonb_build_object(
         'source', 'migration_0025',
         'reason', 'acknowledgement closed an alert under the previous rules'
       )
 where acknowledged_at is not null;

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
--
-- One unresolved alert per subject, replacing 0020's one-unacknowledged.
-- `nulls not distinct` is what makes installation alerts deduplicate at all:
-- their `business_id` is null, and under the default two nulls are different
-- values, so every stalled-queue check would have inserted another row.

drop index operator_alerts_one_open_per_subject;

create unique index operator_alerts_one_unresolved_per_subject
  on operator_alerts (business_id, kind, subject_key, state_version)
  nulls not distinct
  where resolved_at is null;

drop index operator_alerts_unacknowledged;

-- Worst first, most recent first, for the list a person actually reads.
create index operator_alerts_unresolved
  on operator_alerts (business_id, severity_rank desc, last_seen_at desc)
  where resolved_at is null;

-- The escalation sweep's query: everything due to be reminded about, across all
-- businesses, ordered by when it came due. Partial so the index holds only rows
-- that are actually waiting rather than every alert ever raised.
create index operator_alerts_due_for_reminder
  on operator_alerts (next_reminder_at)
  where resolved_at is null and next_reminder_at is not null;

-- Retention sweeps delete by age of resolution (section 22: resolved history is
-- preserved under retention, not forever).
create index operator_alerts_resolved_history on operator_alerts (resolved_at)
  where resolved_at is not null;
