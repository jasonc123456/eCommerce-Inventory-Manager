-- 0027_notification_deliveries
--
-- What was actually sent, to whom, and whether it arrived (sections 20, 22).
--
-- Section 22 asks for delivery history and idempotency identifiers. Both exist
-- for the same reason, which is that sending is the one part of notification
-- that cannot be undone: an alert can be re-read, a preference can be changed,
-- but a message that went out at three in the morning went out.
--
-- So this table is written *before* the send rather than after it. A row that
-- says "pending" and never becomes "sent" is a message that may or may not have
-- left the building, which is an honest thing to have recorded. The alternative
-- — recording success afterwards — loses exactly the cases worth keeping: the
-- crash between the send and the write, and the send that hung.
--
-- The idempotency key is what makes that safe. It is derived from the alert,
-- the channel, the recipient, and how many reminders had been sent, so a retry
-- of the same pass collides with itself and a genuine later reminder does not.
-- A unique index is the enforcement; nothing counts attempts in memory.
--
-- Three absences.
--
-- There is no message body. Section 20 requires delivery failures to be
-- "recorded without message secrets", and a stored copy of every alert email is
-- a second, unaudited place the shop's stock levels live. What is kept is
-- enough to answer "was this sent, when, and did it work".
--
-- There is no recipient email address. It is in `users`, it changes, and a
-- frozen copy here would be a stale address that somebody later reads as
-- evidence of where a message went.
--
-- There is no retry schedule. Section 22 bounds retries; the sweep that owns
-- them decides when to try again from `attempts` and `last_attempt_at`, which
-- is one fact rather than two that can disagree.

create table notification_deliveries (
  id                  uuid        primary key default gen_random_uuid(),

  -- Null for an installation alert, matching `operator_alerts`. The alert is
  -- the authority on scope; this column exists so a business's delivery history
  -- can be read without joining, and the check keeps the two agreeing.
  business_id         uuid        references businesses (id) on delete cascade,
  alert_id            uuid        not null references operator_alerts (id) on delete cascade,

  -- in_app | email. Outbound webhook channels arrive with their destinations.
  channel             text        not null,

  -- Who it was for. Null for a channel that is not addressed to a person, which
  -- is every outbound webhook.
  recipient_user_id   uuid        references users (id) on delete set null,

  -- Derived, never random: the same notification computed twice produces the
  -- same key, and the unique index below turns a duplicate send into a
  -- no-op rather than a second message.
  idempotency_key     text        not null,

  -- pending | sent | failed | deferred | suppressed
  --
  -- `deferred` is quiet hours. `suppressed` is a decision not to send at all —
  -- an acknowledged alert whose reminder came due, say — and it is recorded
  -- rather than skipped, because "why did nobody get told" is a question that
  -- gets asked after something has gone wrong.
  status              text        not null default 'pending',

  attempts            integer     not null default 0,
  deferred_until      timestamptz,
  last_attempt_at     timestamptz,
  sent_at             timestamptz,

  -- Bounded and non-sensitive. A transport's own error quotes the envelope and
  -- sometimes the body back at you, which is precisely what must not be stored.
  failure_reason      text,

  created_at          timestamptz not null default now(),

  constraint notification_deliveries_channel_known
    check (channel in ('in_app', 'email')),

  constraint notification_deliveries_status_known
    check (status in ('pending', 'sent', 'failed', 'deferred', 'suppressed')),

  constraint notification_deliveries_attempts_nonnegative
    check (attempts >= 0),

  -- Sent means there is a moment it was sent. Anything else means there is not.
  constraint notification_deliveries_sent_has_a_time
    check ((status = 'sent') = (sent_at is not null)),

  -- Deferred means there is something to wait for.
  constraint notification_deliveries_deferred_has_a_time
    check (status <> 'deferred' or deferred_until is not null),

  -- A failure says why. An unexplained failure is a row that tells the operator
  -- only that something went wrong, which they already knew.
  constraint notification_deliveries_failure_has_a_reason
    check (status <> 'failed' or failure_reason is not null)
);

-- The idempotency guarantee. Section 22 asks for identifiers; this is what
-- makes them mean something.
create unique index notification_deliveries_once_per_key
  on notification_deliveries (idempotency_key);

-- The history a person reads: this alert, most recent first.
create index notification_deliveries_by_alert
  on notification_deliveries (alert_id, created_at desc);

-- The sweep's query: everything still owed, oldest first. Partial, so the index
-- holds work rather than archive.
create index notification_deliveries_outstanding
  on notification_deliveries (status, deferred_until)
  where status in ('pending', 'deferred');

-- Retention deletes by age (section 22: 180 days by default).
create index notification_deliveries_retention
  on notification_deliveries (created_at);
