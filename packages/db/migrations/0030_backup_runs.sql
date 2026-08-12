-- 0030_backup_runs
--
-- Whether the backups are actually happening (section 23).
--
-- Section 23 asks for nightly encrypted logical backups, a verified one before
-- every upgrade, and a full restore tested quarterly with "non-secret results
-- recorded in health/audit history". This table is that history, and it exists
-- because of the single most common way self-hosted backups fail: they stop,
-- and nobody finds out until the day they are needed.
--
-- So the health surface reads this table, and a backup that has not succeeded
-- in thirty-six hours is a degraded installation.
--
-- What is deliberately not here.
--
-- No path. An artifact name, yes — but not where it lives. The location is the
-- operator's, may be a different machine by the time anybody reads this row,
-- and a stored path is a stale instruction that reads like a current one.
--
-- No key material, and no passphrase. Backups are encrypted to a public key
-- whose private half lives off this host (D-143); if this table could help
-- decrypt them, the control it exists to record would be defeated by the record
-- of it.
--
-- No contents. A manifest of what was in a backup would be a description of the
-- database, kept next to the database, outliving every retention window that
-- applies to the data it describes.

create table backup_runs (
  id                uuid        primary key default gen_random_uuid(),

  -- daily | weekly | monthly | pre_upgrade | manual
  --
  -- The first three are section 23's rotation (seven, four, twelve). The fourth
  -- is the one taken before an upgrade or a risky migration, which is never
  -- pruned by the rotation because it is the thing a rollback needs.
  kind              text        not null,

  -- running | succeeded | failed
  --
  -- Written as `running` before the dump starts, so a backup that died halfway
  -- leaves a row saying so rather than no row at all. A missing row and a failed
  -- one look identical from the outside; only one of them is honest.
  outcome           text        not null default 'running',

  started_at        timestamptz not null default now(),
  completed_at      timestamptz,

  -- What was produced, and proof of what it was. The checksum is over the
  -- encrypted artifact, so it verifies the file an operator actually has.
  artifact_name     text,
  size_bytes        bigint,
  sha256            text,

  -- Bounded and non-sensitive. Never a command line: a pg_dump invocation
  -- carries the connection string.
  failure_reason    text,

  -- Section 23's quarterly restore drill. Recorded on the backup that was
  -- restored, because "we tested a restore" is a claim about a specific
  -- artifact rather than about the schedule in general.
  restore_verified_at timestamptz,
  restore_notes     text,

  constraint backup_runs_kind_known
    check (kind in ('daily', 'weekly', 'monthly', 'pre_upgrade', 'manual')),
  constraint backup_runs_outcome_known
    check (outcome in ('running', 'succeeded', 'failed')),

  -- A finished run has a moment it finished. A running one does not.
  constraint backup_runs_completion_matches_outcome
    check ((outcome = 'running') = (completed_at is null)),

  -- A success produced something, and says what. A run that claims to have
  -- succeeded with no artifact is the shape of a backup nobody can restore.
  constraint backup_runs_success_has_an_artifact
    check (outcome <> 'succeeded' or (artifact_name is not null and sha256 is not null)),

  constraint backup_runs_failure_has_a_reason
    check (outcome <> 'failed' or failure_reason is not null)
);

-- The health check's query: the most recent success.
create index backup_runs_recent_success on backup_runs (completed_at desc)
  where outcome = 'succeeded';

create index backup_runs_recent on backup_runs (started_at desc);
