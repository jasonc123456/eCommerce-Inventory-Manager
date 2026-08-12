-- 0026_notification_routing
--
-- Who hears about an alert, and when (sections 5, 9, 22).
--
-- Section 22 routes "by installation/business scope, granular permission, user
-- preference, and quiet hours". Scope and permission are already in the schema:
-- scope is generated on the alert, and the permission catalogue is section 5's.
-- The two things missing are the ones here — what each person has asked for,
-- and when the shop would rather not be woken up.
--
-- Both are stored as preferences rather than as an addressed recipient list.
-- A list of who to email is a copy of the membership table that goes stale the
-- moment somebody leaves, and the stale copy keeps sending a former employee
-- the shop's stock levels. Deciding at send time from membership, permission,
-- and preference means removing somebody removes them.
--
-- Two absences.
--
-- There is no per-user quiet-hours column. Quiet hours are the shop's, in the
-- shop's timezone, because they describe when the shop is closed rather than
-- when a person is asleep, and a per-user version would make "was this sent
-- during quiet hours" unanswerable without knowing whose evening it was.
--
-- There is no "email everybody" switch. Section 22 routes by permission, and a
-- switch that overrode it would be a way to send stock levels and buyer-adjacent
-- context to somebody the permission catalogue had already refused.

-- ---------------------------------------------------------------------------
-- The shop's quiet hours
-- ---------------------------------------------------------------------------

create table business_notification_settings (
  business_id           uuid        primary key references businesses (id) on delete cascade,

  -- Local wall-clock times in the business's own timezone (`businesses.timezone`,
  -- added for exactly this and for the nightly window). Stored as `time` rather
  -- than as an offset because "we are shut after nine" survives a daylight-saving
  -- change and a stored offset does not.
  --
  -- Both null means no quiet hours, which is the default: a shop that has not
  -- said when it is closed has not asked to be kept in the dark.
  quiet_hours_start     time,
  quiet_hours_end       time,

  -- Where an alert that nobody in the business can act on goes. Section 22
  -- requires that at least one critical-alert recipient remains configured;
  -- this is the address of last resort when a business has lost every
  -- permitted member but has not been deleted.
  fallback_email        text,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- A start without an end is a quiet period that never ends, which reads on
  -- screen as a preference and behaves as a mute.
  constraint business_notification_settings_quiet_hours_complete
    check ((quiet_hours_start is null) = (quiet_hours_end is null)),

  -- Equal start and end would be either zero hours or twenty-four, and the
  -- schema should not be the place that guess is made.
  constraint business_notification_settings_quiet_hours_nonempty
    check (quiet_hours_start is null or quiet_hours_start <> quiet_hours_end)
);

-- ---------------------------------------------------------------------------
-- What each person has asked for
-- ---------------------------------------------------------------------------
--
-- One row per person per business. A person in two businesses has two rows,
-- because "email me about everything" for the shop they run is a different
-- sentence from the same words about the shop they help out at on Saturdays.
--
-- The absence of a row is a preference too: it means the defaults below, and
-- section 22's defaults are deliberately not silent — a new owner who has never
-- opened the settings screen still hears about an oversell.

create table user_notification_preferences (
  id                    uuid        primary key default gen_random_uuid(),
  business_id           uuid        not null references businesses (id) on delete cascade,
  user_id               uuid        not null references users (id) on delete cascade,

  -- The floor at which email is sent. Section 22: email for "user-selected
  -- Warning events and configured Error/Critical events". 'none' switches email
  -- off entirely, which the in-app list does not honour — an alert never stops
  -- being visible, only stops arriving.
  email_min_severity    text        not null default 'error',

  -- Kinds this person wants an email about regardless of the floor. Section 22's
  -- opt-in: "Email the business owner and opted-in permitted users when an item
  -- becomes out of stock on eBay or another connected platform."
  email_opted_in_kinds  text[]      not null default '{}',

  -- Kinds this person does not want an email about. Never applied to Critical:
  -- a mute that could hide an oversell is a mute that eventually hides one.
  email_muted_kinds     text[]      not null default '{}',

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint user_notification_preferences_one_per_membership
    unique (business_id, user_id),

  constraint user_notification_preferences_floor_known
    check (email_min_severity in ('info', 'warning', 'error', 'critical', 'none')),

  -- A kind cannot be both asked for and refused. Left to the database because
  -- the two arrays are edited on one screen and a form that submitted both
  -- would otherwise store a preference whose meaning depends on read order.
  constraint user_notification_preferences_no_contradiction
    check (not (email_opted_in_kinds && email_muted_kinds))
);

create index user_notification_preferences_by_business
  on user_notification_preferences (business_id);
