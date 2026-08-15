-- 0033_pilot_evidence
--
-- The pilot criteria a query cannot answer (sections 1, 36).
--
-- Six of section 1's eight criteria can be computed from data this installation
-- already retains. Two cannot, and pretending otherwise is how a pilot bar
-- becomes a formality.
--
-- "No oversale attributable to a synchronization defect."
--
-- The word doing the work is "attributable". Two buyers taking the last unit on
-- two channels in the same second is an oversale and is not a defect — no
-- interval short of instantaneous prevents it, which is why safety stock exists.
-- A stale target that sat unwritten for an hour is the same outcome and is
-- entirely our fault.
--
-- Nothing in the data distinguishes those. Computing this criterion would mean
-- either counting every oversale as a defect — a bar no correct implementation
-- can clear — or counting none of them, which is a criterion that always passes.
-- So each oversale is recorded and a person classifies it, and the criterion is
-- met only when every one has been looked at and none was a defect. An
-- unreviewed incident leaves the criterion undemonstrated rather than met, which
-- is the honest verdict for evidence nobody has examined.
--
-- This is also section 36's "issue closure": the M9 deliverable list asks for
-- issues found during the pilot to be closed, and a closed issue is one with a
-- finding attached.
--
-- "Recovery from a 24-hour outage" and "a clean deployment from the published
-- documentation."
--
-- Both are drills. Neither leaves a trace in the database that distinguishes it
-- from ordinary operation — a quiet day looks exactly like a recovered outage
-- afterwards, and a clean install is by definition something that happened
-- somewhere this database did not exist yet. So they are recorded when they are
-- performed, by the person who performed them.
--
-- The restore drill is deliberately not here. `backup_runs.restore_verified_at`
-- already records it against the specific artifact restored, which is a stronger
-- claim than a note that a restore happened, and a second place to record the
-- same thing is a second place for it to disagree.

create table pilot_incidents (
  id            uuid        primary key default gen_random_uuid(),
  business_id   uuid        not null references businesses (id) on delete cascade,

  -- oversale | drift | data_loss | missed_objective | other
  kind          text        not null,

  detected_at   timestamptz not null default now(),

  -- What happened, in a sentence, written by whoever or whatever noticed. Never
  -- buyer detail: this row outlives the raw event that caused it (section 13).
  summary       text        not null,

  -- The alert this came from, where one exists. Nulled rather than cascaded if
  -- the alert is ever removed: the incident is the durable record and must
  -- survive the notification that raised it.
  alert_id      uuid        references operator_alerts (id) on delete set null,

  -- unreviewed | defect | not_a_defect | external
  --
  -- `external` is a provider's fault — a marketplace that accepted an order
  -- against a quantity it had already been told was zero. Distinguished from
  -- `not_a_defect` because the two lead to different conversations.
  classification text       not null default 'unreviewed',

  classified_by_user_id uuid references users (id) on delete set null,
  classified_at timestamptz,

  -- Why the classifier decided what they decided, and what was done about it.
  -- A classification with no finding is an opinion; section 36 asks for closure.
  finding       text,
  resolution    text,

  constraint pilot_incidents_kind_known
    check (kind in ('oversale', 'drift', 'data_loss', 'missed_objective', 'other')),

  constraint pilot_incidents_classification_known
    check (classification in ('unreviewed', 'defect', 'not_a_defect', 'external')),

  -- A reviewed incident says who reviewed it, when, and what they found. All
  -- three or none: a classification with no author is exactly the artifact this
  -- table exists to prevent.
  constraint pilot_incidents_review_is_attributed
    check (
      (classification = 'unreviewed')
        = (classified_by_user_id is null and classified_at is null and finding is null)
    )
);

create index pilot_incidents_open
  on pilot_incidents (business_id, detected_at desc)
  where classification = 'unreviewed';

create index pilot_incidents_by_business on pilot_incidents (business_id, detected_at desc);

-- One incident per alert. An alert that reminds every four hours must not file a
-- fresh incident on every reminder, or the criterion becomes a measure of how
-- long somebody took to acknowledge it.
create unique index pilot_incidents_one_per_alert
  on pilot_incidents (alert_id)
  where alert_id is not null;

create table pilot_drills (
  id            uuid        primary key default gen_random_uuid(),

  -- outage_recovery | clean_install | server_migration
  kind          text        not null,

  performed_at  timestamptz not null default now(),
  performed_by_user_id uuid references users (id) on delete set null,

  -- Whether it worked. A failed drill is evidence too, and the most valuable
  -- kind: it is the one that happened before it mattered.
  succeeded     boolean     not null,

  -- What was done and what was observed. For an outage drill that means which
  -- provider was cut off and for how long; for a clean install, which
  -- documentation was followed and on what.
  summary       text        not null,

  -- Whatever the operator kept — a run log, an issue, a commit. A pointer, not
  -- the artifact: this database is not an evidence store.
  evidence_ref  text,

  constraint pilot_drills_kind_known
    check (kind in ('outage_recovery', 'clean_install', 'server_migration'))
);

create index pilot_drills_recent on pilot_drills (kind, performed_at desc);
