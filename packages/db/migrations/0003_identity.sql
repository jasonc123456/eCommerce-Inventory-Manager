-- 0003_identity
--
-- Identity, sessions, authorization grants, and the audit trail (sections 5, 19,
-- 20). This is milestone M1's schema slice.
--
-- Two rules shape almost every table below, and both come from section 20.
--
-- The first is that no authentication secret is ever stored in a form that can
-- be used. Magic-link tokens, eight-digit codes, session tokens, trusted-device
-- tokens, recovery codes, and WebAuthn challenges are all held as keyed hashes,
-- keyed with a secret that lives in the deployment host's .env and never in the
-- database. A stolen dump therefore yields no usable credential, which matters
-- most for the eight-digit code: its hundred million values are trivially
-- exhaustible against a plain digest and useless against a keyed one.
--
-- The second is that a denial must not be informative. Registration is
-- invitation-only and responses never reveal whether an account exists, so a
-- challenge row is written for an address nobody has heard of exactly as it is
-- for a real user, and `user_id` is nullable for that reason alone. Without it,
-- an unknown address would take a visibly different path and the enumeration
-- defence would be decorative.

-- ---------------------------------------------------------------------------
-- Tenancy additions
-- ---------------------------------------------------------------------------

alter table users
  -- Section 19 stores a normalized address for identity and the smallest
  -- display form messages need. The unique index in 0001 already compares
  -- case-insensitively; this holds what the user actually typed so mail is
  -- addressed the way they wrote it rather than folded to lower case.
  add column email_display text,
  -- Installation-level suspension. Distinct from a membership suspension, which
  -- removes one business; this revokes every session everywhere (section 20).
  add column suspended_at timestamptz,
  add column suspended_reason text;

alter table businesses
  -- Section 20: businesses may optionally restrict invitations and login to
  -- approved email domains. Empty means no restriction, which is the default and
  -- must stay distinguishable from "restricted to nothing".
  add column allowed_email_domains text[] not null default '{}',
  -- Section 20: owners may require 2FA for selected roles. A list of role names
  -- rather than a boolean, because "required for owners and managers but not for
  -- viewers" is the case that actually gets configured.
  add column require_two_factor_roles text[] not null default '{}';

alter table businesses
  add constraint businesses_two_factor_roles_valid check (
    require_two_factor_roles <@ array['owner', 'manager', 'operator', 'viewer']::text[]
  );

alter table memberships
  -- Section 20: membership suspension removes that business's access
  -- immediately, without touching the user's other businesses or their account.
  add column status text not null default 'active',
  add column suspended_at timestamptz,
  add column invited_by_user_id uuid references users (id) on delete set null;

alter table memberships
  add constraint memberships_status_valid check (status in ('active', 'suspended')),
  -- The composite unique that lets permission grants carry business_id through a
  -- foreign key, exactly as locations and canonical items do in 0001.
  add constraint memberships_business_scoped unique (business_id, id);

-- ---------------------------------------------------------------------------
-- Installation administration
--
-- A separate authority from business ownership (section 5). Holding one of these
-- never confers business membership, and a business owner can never grant one.
-- ---------------------------------------------------------------------------

create table installation_administrators (
  user_id     uuid        primary key references users (id) on delete restrict,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- Null for the first administrator, who is created by the bootstrap flow and
  -- has nobody to have been granted access by.
  granted_by_user_id uuid references users (id) on delete set null,
  status      text        not null default 'active',

  constraint installation_administrators_status_valid check (status in ('active', 'suspended'))
);

create table installation_administrator_permissions (
  user_id     uuid        not null references installation_administrators (user_id) on delete cascade,
  permission  text        not null,
  granted_at  timestamptz not null default now(),

  constraint installation_administrator_permissions_pkey primary key (user_id, permission),
  -- Enumerated here as well as in packages/authz, because a permission string
  -- that no code recognises should not be storable. Restoring a backup written
  -- by a newer version is the case this catches.
  constraint installation_administrator_permissions_valid check (
    permission in (
      'view_system_health',
      'manage_installation_settings',
      'view_backup_status',
      'run_backup',
      'view_update_status',
      'download_diagnostics',
      'view_installation_audit',
      'manage_installation_administrators'
    )
  )
);

-- Bootstrap state. Section 20 requires the setup endpoints to disable
-- permanently after the first administrator is created, and "permanently" has to
-- survive a restart, a redeploy, and an operator who left EIM_SETUP_SECRET in
-- .env by mistake. A row in the database is the only thing that does.
create table installation_bootstrap (
  -- Single row, enforced by the check rather than by convention.
  id            boolean     primary key default true,
  completed_at  timestamptz,
  completed_by_user_id uuid references users (id) on delete set null,
  -- How many times a setup attempt was made and refused. Read by the health
  -- surface: repeated failures against a live setup secret is an attack in
  -- progress, not a confused operator.
  failed_attempts integer   not null default 0,
  last_attempt_at timestamptz,

  constraint installation_bootstrap_single_row check (id),
  constraint installation_bootstrap_failed_attempts_nonnegative check (failed_attempts >= 0)
);

insert into installation_bootstrap (id) values (true);

-- ---------------------------------------------------------------------------
-- Business permission grants
--
-- Section 5: role templates are presets over the permission catalogue, not a
-- parallel mechanism. The membership carries the template name; every effective
-- permission is a row here, so an authorization check reads one table and never
-- has to re-derive a template.
-- ---------------------------------------------------------------------------

create table permission_grants (
  id             uuid        primary key default gen_random_uuid(),
  business_id    uuid        not null,
  membership_id  uuid        not null,
  permission     text        not null,
  -- 'business' is the unscoped grant. The others narrow it at assignment time
  -- (section 5, scoped grants).
  scope_kind     text        not null default 'business',
  granted_at     timestamptz not null default now(),
  granted_by_user_id uuid references users (id) on delete set null,

  -- Carries business_id along with the membership reference, so a grant cannot
  -- name a membership in another business even if application code is wrong.
  constraint permission_grants_membership_fkey
    foreign key (business_id, membership_id)
    references memberships (business_id, id) on delete cascade,

  constraint permission_grants_scope_kind_valid check (
    scope_kind in ('business', 'connections', 'locations', 'own')
  ),

  -- One row per membership and permission and scope kind. Two location-scoped
  -- grants of the same permission would be two half-answers to one question;
  -- widening a scope adds locations to the existing grant instead.
  constraint permission_grants_unique unique (membership_id, permission, scope_kind),

  constraint permission_grants_business_scoped unique (business_id, id)
);

-- The locations a location-scoped grant covers.
--
-- A join table rather than a uuid[] column, because the composite foreign key is
-- the whole point: a grant in one business cannot name a location in another,
-- and that has to hold whatever the application believes.
create table permission_grant_locations (
  business_id  uuid not null,
  grant_id     uuid not null,
  location_id  uuid not null,

  constraint permission_grant_locations_pkey primary key (grant_id, location_id),

  constraint permission_grant_locations_grant_fkey
    foreign key (business_id, grant_id)
    references permission_grants (business_id, id) on delete cascade,
  constraint permission_grant_locations_location_fkey
    foreign key (business_id, location_id)
    references locations (business_id, id) on delete cascade
);

-- The connections a connection-scoped grant covers.
--
-- Deliberately without a foreign key to the connections table: that table
-- arrives with the integrations in M2, and a grant of a permission over a
-- connection is an M1 concept that must not wait for it. M2's migration adds the
-- composite foreign key, which is a validated ALTER rather than a rewrite.
create table permission_grant_connections (
  business_id   uuid not null,
  grant_id      uuid not null,
  connection_id uuid not null,

  constraint permission_grant_connections_pkey primary key (grant_id, connection_id),

  constraint permission_grant_connections_grant_fkey
    foreign key (business_id, grant_id)
    references permission_grants (business_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Invitations
--
-- Section 20: additional access is business-scoped and invitation-only.
-- ---------------------------------------------------------------------------

create table invitations (
  id           uuid        primary key default gen_random_uuid(),
  business_id  uuid        not null references businesses (id) on delete cascade,
  -- The normalized address the invitation is for, needed to verify it on
  -- acceptance. Kept in full rather than fingerprinted because an owner has to
  -- be able to see who they invited and cancel it.
  email        text        not null,
  -- Keyed hash of the single-use token. The raw token exists only in the
  -- message that was sent.
  token_hash   text        not null,
  role         text        not null,
  invited_by_user_id uuid references users (id) on delete set null,
  created_at   timestamptz not null default now(),
  -- Section 20: seventy-two hours.
  expires_at   timestamptz not null,
  accepted_at  timestamptz,
  accepted_by_user_id uuid references users (id) on delete set null,
  cancelled_at timestamptz,
  cancelled_by_user_id uuid references users (id) on delete set null,

  constraint invitations_role_valid check (role in ('owner', 'manager', 'operator', 'viewer')),
  constraint invitations_email_shaped check (email like '%@%' and length(email) between 3 and 320),
  constraint invitations_expiry_after_creation check (expires_at > created_at),
  -- An invitation cannot both be accepted and cancelled.
  constraint invitations_single_outcome check (not (accepted_at is not null and cancelled_at is not null)),
  constraint invitations_business_scoped unique (business_id, id)
);

create unique index invitations_token_hash_unique on invitations (token_hash);

-- At most one live invitation per address per business. A second invitation
-- while the first is outstanding would give the recipient two valid links and
-- the owner two rows to cancel.
create unique index invitations_one_outstanding
  on invitations (business_id, lower(email))
  where accepted_at is null and cancelled_at is null;

-- The proposed permissions an invitation carries, so acceptance grants exactly
-- what the owner chose rather than re-deriving a template that may have changed.
create table invitation_permissions (
  invitation_id uuid not null references invitations (id) on delete cascade,
  permission    text not null,
  scope_kind    text not null default 'business',

  constraint invitation_permissions_pkey primary key (invitation_id, permission, scope_kind),
  constraint invitation_permissions_scope_kind_valid check (
    scope_kind in ('business', 'connections', 'locations', 'own')
  )
);

-- ---------------------------------------------------------------------------
-- Email authentication challenges
-- ---------------------------------------------------------------------------

create table login_challenges (
  id                 uuid        primary key default gen_random_uuid(),
  -- Null when the address does not belong to an account. The row still exists,
  -- still consumes the rate-limit budget, and still produces an audit outcome,
  -- because an unknown address must take the same path as a known one.
  user_id            uuid        references users (id) on delete cascade,
  -- Keyed fingerprint of the normalized address (section 19). Rate limiting and
  -- pressure tracking key off this, so neither has to hold the address.
  email_fingerprint  text        not null,
  method             text        not null,
  purpose            text        not null default 'login',
  -- Keyed hash of the token or the eight digits. Never the value itself.
  secret_hash        text        not null,
  -- Section 20 binds a code to the requesting browser. Null for a magic link,
  -- which is explicitly allowed to be opened on another device after
  -- confirmation.
  browser_binding_hash text,
  created_at         timestamptz not null default now(),
  -- Fifteen minutes for a link, ten for a code (section 20).
  expires_at         timestamptz not null,
  consumed_at        timestamptz,
  -- Set when a newer challenge for the same login context replaces this one.
  superseded_at      timestamptz,
  attempts           integer     not null default 0,
  max_attempts       integer     not null default 5,
  resend_count       integer     not null default 0,
  last_sent_at       timestamptz not null default now(),
  -- Where to go after signing in. Validated against a local allowlist before it
  -- is stored, and again before it is used.
  redirect_path      text,
  -- Section 19: precise authentication network evidence is retained for thirty
  -- days, not indefinitely. The cleanup job reads created_at.
  request_ip         inet,
  request_user_agent text,

  constraint login_challenges_method_valid check (method in ('magic_link', 'email_code')),
  constraint login_challenges_purpose_valid check (purpose in ('login', 'step_up', 'recovery')),
  constraint login_challenges_expiry_after_creation check (expires_at > created_at),
  constraint login_challenges_attempts_bounded check (attempts >= 0 and attempts <= max_attempts),
  constraint login_challenges_resend_count_nonnegative check (resend_count >= 0),
  -- A code is bound to the browser that asked for it; a link is not.
  constraint login_challenges_code_is_browser_bound check (
    method <> 'email_code' or browser_binding_hash is not null
  ),
  -- A redirect is a local path, never an absolute URL. Enforced here as well as
  -- in the application because an open redirect on an authentication callback is
  -- the difference between a phishing attempt that fails and one that succeeds.
  constraint login_challenges_redirect_is_local check (
    redirect_path is null or (redirect_path like '/%' and redirect_path not like '//%')
  )
);

-- Section 20: permit one active challenge per login context.
--
-- Expired rows still occupy the slot, and deliberately so: issuing a challenge
-- supersedes any predecessor as its first act, so reaching this constraint means
-- something tried to create a second live challenge without doing that.
create unique index login_challenges_one_active
  on login_challenges (email_fingerprint, purpose)
  where consumed_at is null and superseded_at is null;

create index login_challenges_created_at_idx on login_challenges (created_at);

-- Durable attempt pressure, kept per address rather than per challenge.
--
-- Section 20 requires failed-attempt pressure to survive a resend. A counter on
-- the challenge alone would not: requesting a new code would reset it, and five
-- attempts per code with unlimited codes is not a limit.
create table authentication_pressure (
  subject_fingerprint     text        primary key,
  failed_attempts         integer     not null default 0,
  first_failure_at        timestamptz not null default now(),
  last_failure_at         timestamptz not null default now(),
  -- Section 20 chooses progressive delay over lockout, because an attacker who
  -- can lock an account out by failing on purpose has a denial of service.
  next_attempt_allowed_at timestamptz,
  expires_at              timestamptz not null,

  constraint authentication_pressure_failed_attempts_nonnegative check (failed_attempts >= 0)
);

create index authentication_pressure_expiry_idx on authentication_pressure (expires_at);

-- ---------------------------------------------------------------------------
-- Rate limiting
--
-- Section 19: fixed windows in PostgreSQL, because limits must hold across web
-- replicas and Redis is excluded (D-046). Each replica keeps an in-memory
-- pre-filter that can reject an already-exhausted window without a query, but
-- only these rows decide whether a window is exhausted, so a replica restart or
-- an uneven load balancer cannot multiply an attacker's budget.
-- ---------------------------------------------------------------------------

create table rate_limit_windows (
  -- What is being limited, such as 'email_code:request'.
  bucket        text        not null,
  -- Who is being limited: a keyed email fingerprint, an IP, or a business id.
  -- Keyed rather than raw so the limiter does not become a second place
  -- addresses are stored.
  subject       text        not null,
  window_start  timestamptz not null,
  window_seconds integer    not null,
  count         integer     not null default 0,
  expires_at    timestamptz not null,

  constraint rate_limit_windows_pkey primary key (bucket, subject, window_start),
  constraint rate_limit_windows_count_nonnegative check (count >= 0),
  constraint rate_limit_windows_window_positive check (window_seconds > 0)
);

create index rate_limit_windows_expiry_idx on rate_limit_windows (expires_at);

-- ---------------------------------------------------------------------------
-- Sessions and devices
-- ---------------------------------------------------------------------------

create table sessions (
  id                uuid        primary key default gen_random_uuid(),
  user_id           uuid        not null references users (id) on delete cascade,
  -- Keyed hash of the opaque cookie value (section 20).
  token_hash        text        not null,
  created_at        timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  -- Section 20: twelve idle hours or seven absolute days by default; seven idle
  -- days or thirty absolute for an explicit remember-device session. Both are
  -- stored rather than computed, so changing the policy never retroactively
  -- extends a session that is already live.
  idle_expires_at   timestamptz not null,
  absolute_expires_at timestamptz not null,
  remember_device   boolean     not null default false,
  -- When the user last proved who they are. Section 20 requires authentication
  -- within the previous ten minutes before sensitive actions, and that clock is
  -- not the same as the session's age: a session can be hours old and still have
  -- authenticated a minute ago after a step-up.
  authenticated_at  timestamptz not null default now(),
  -- Which business the switcher is currently on. Advisory only: membership is
  -- re-checked on every request, so a session pointing at a business the user
  -- has been removed from is harmless.
  active_business_id uuid       references businesses (id) on delete set null,
  revoked_at        timestamptz,
  revoked_reason    text,
  -- Minimal device metadata (section 20). Enough for a user to recognise their
  -- own sessions on the devices screen, and no more.
  device_label      text,
  request_ip        inet,
  request_user_agent text,

  constraint sessions_absolute_after_creation check (absolute_expires_at > created_at),
  constraint sessions_revoked_reason_valid check (
    revoked_reason is null or revoked_reason in (
      'user_signed_out',
      'global_sign_out',
      'session_rotated',
      'account_suspended',
      'security_change',
      'membership_removed',
      'administrator_action'
    )
  )
);

create unique index sessions_token_hash_unique on sessions (token_hash);

-- "Every live session for this user", behind the devices screen, the global
-- sign-out, and the suspension path. Partial, because revoked rows are read only
-- by the audit surface.
create index sessions_user_live_idx on sessions (user_id) where revoked_at is null;

create index sessions_absolute_expiry_idx on sessions (absolute_expires_at);

create table trusted_devices (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null references users (id) on delete cascade,
  -- Section 20: stored as a hashed revocable token.
  token_hash    text        not null,
  label         text,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  -- Thirty days (section 20).
  expires_at    timestamptz not null,
  revoked_at    timestamptz,

  constraint trusted_devices_expiry_after_creation check (expires_at > created_at)
);

create unique index trusted_devices_token_hash_unique on trusted_devices (token_hash);
create index trusted_devices_user_live_idx on trusted_devices (user_id) where revoked_at is null;

-- ---------------------------------------------------------------------------
-- Passkeys
-- ---------------------------------------------------------------------------

create table webauthn_credentials (
  id                uuid        primary key default gen_random_uuid(),
  user_id           uuid        not null references users (id) on delete cascade,
  -- The authenticator's credential id, base64url. Unique across the
  -- installation: two users cannot register the same authenticator credential.
  credential_id     text        not null,
  -- Public key only. Section 20 is explicit that no private key is ever stored,
  -- and there is nothing here that could hold one.
  public_key        bytea       not null,
  -- Section 20 treats a non-increasing counter as a signal rather than proof,
  -- because synced credentials legitimately report zero forever.
  sign_count        bigint      not null default 0,
  transports        text[]      not null default '{}',
  backup_eligible   boolean     not null default false,
  backup_state      boolean     not null default false,
  aaguid            uuid,
  -- User-chosen name. Section 20 allows multiple named credentials per user.
  name              text        not null,
  created_at        timestamptz not null default now(),
  last_used_at      timestamptz,

  constraint webauthn_credentials_sign_count_nonnegative check (sign_count >= 0),
  constraint webauthn_credentials_name_present check (length(btrim(name)) > 0)
);

create unique index webauthn_credentials_credential_id_unique
  on webauthn_credentials (credential_id);

create index webauthn_credentials_user_idx on webauthn_credentials (user_id);

create table webauthn_challenges (
  id            uuid        primary key default gen_random_uuid(),
  -- Null for a discoverable-credential login, where the user is not known until
  -- the authenticator answers.
  user_id       uuid        references users (id) on delete cascade,
  -- Keyed hash. Section 19 forbids logging a WebAuthn challenge, and storing it
  -- in a readable column would leave it in every dump and backup instead.
  challenge_hash text       not null,
  kind          text        not null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  consumed_at   timestamptz,

  constraint webauthn_challenges_kind_valid check (kind in ('registration', 'authentication')),
  constraint webauthn_challenges_expiry_after_creation check (expires_at > created_at)
);

create index webauthn_challenges_expiry_idx on webauthn_challenges (expires_at);

-- ---------------------------------------------------------------------------
-- Second factors and recovery
-- ---------------------------------------------------------------------------

create table totp_credentials (
  user_id       uuid        primary key references users (id) on delete cascade,
  -- The seed, encrypted with the versioned keyring (section 19). Text, because
  -- the envelope is text; the column can hold nothing readable.
  encrypted_seed text       not null,
  status        text        not null default 'pending',
  created_at    timestamptz not null default now(),
  activated_at  timestamptz,
  -- The last time step accepted, so a code cannot be replayed inside its own
  -- validity window. Section 20 allows a plus or minus one-step window, which
  -- means a code stays valid for ninety seconds and would otherwise be reusable
  -- for most of that.
  last_used_step bigint,

  constraint totp_credentials_status_valid check (status in ('pending', 'active')),
  constraint totp_credentials_activation_consistent check (
    (status = 'active') = (activated_at is not null)
  )
);

create table recovery_codes (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null references users (id) on delete cascade,
  code_hash    text        not null,
  -- Identifies the set the code was issued in. Regenerating invalidates the
  -- previous set (section 20), and a batch id makes that one update rather than
  -- a delete that loses the evidence a set ever existed.
  batch_id     uuid        not null,
  created_at   timestamptz not null default now(),
  consumed_at  timestamptz,
  invalidated_at timestamptz
);

create unique index recovery_codes_hash_unique on recovery_codes (user_id, code_hash);

-- "How many unused codes are left", shown to the user and checked before a
-- factor is removed.
create index recovery_codes_user_live_idx
  on recovery_codes (user_id)
  where consumed_at is null and invalidated_at is null;

-- ---------------------------------------------------------------------------
-- Audit trail
--
-- Section 19: append-only, permission-filtered, covering authentication,
-- authorization, credential, inventory, publication, pricing, shipping-label,
-- retention, and administrative mutations.
-- ---------------------------------------------------------------------------

-- Neither business_id nor actor_user_id carries a foreign key, and that is a
-- decision rather than an omission.
--
-- An append-only table cannot have a mutating referential action. `on delete set
-- null` is an UPDATE and `on delete cascade` is a DELETE, and the trigger below
-- refuses both, so a foreign key here would mean that deleting a user or a
-- business became impossible the moment they appeared in the trail — which is
-- immediately. Removing the trigger instead would trade an unenforceable audit
-- record for a deletable one, which is the wrong way round.
--
-- Keeping the identifiers unreferenced is also what section 19 asks for. The
-- trail must survive the deletion of what it describes: "who did this" is a fact
-- about the past that does not stop being true when the account is closed. The
-- identifier is pseudonymous on its own, and section 13's retention erasure is a
-- separate bounded privileged path, not a side effect of a cascade.
create table audit_events (
  id             uuid        primary key default gen_random_uuid(),
  -- Null for installation-level events, which belong to the deployment rather
  -- than to a tenant. Business-scoped events carry it so the audit screen can
  -- filter without a join.
  business_id    uuid,
  occurred_at    timestamptz not null default now(),
  -- Who acted. Null actor with actor_kind 'system' is the scheduler or a
  -- cleanup job; that is a real category and must not masquerade as a user.
  actor_user_id  uuid,
  actor_kind     text        not null default 'user',
  -- A dotted identifier such as 'auth.login.succeeded' or 'member.role.changed'.
  action         text        not null,
  result         text        not null,
  severity       text        not null default 'info',
  target_type    text,
  target_id      text,
  -- Safe before and after summaries (section 19). A jsonb document rather than
  -- columns, because every action shapes it differently, and never containing a
  -- secret value is a property of what the writer puts in, enforced by the
  -- redaction allowlist in @eim/observability.
  detail         jsonb       not null default '{}'::jsonb,
  correlation_id uuid,
  request_ip     inet,
  request_user_agent text,

  constraint audit_events_actor_kind_valid check (actor_kind in ('user', 'system', 'service')),
  constraint audit_events_result_valid check (result in ('success', 'failure', 'denied')),
  constraint audit_events_severity_valid check (severity in ('info', 'notice', 'warning', 'critical')),
  constraint audit_events_action_shaped check (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  -- A user action with no actor is a gap in the trail, not an event.
  constraint audit_events_user_actions_have_an_actor check (
    actor_kind <> 'user' or actor_user_id is not null
  )
);

-- "Show this business's audit history", newest first.
create index audit_events_business_timeline_idx
  on audit_events (business_id, occurred_at desc)
  where business_id is not null;

-- "Show installation-level events", the separate administrator surface.
create index audit_events_installation_timeline_idx
  on audit_events (occurred_at desc)
  where business_id is null;

-- "What has this user done", used by security review and by the account screen.
create index audit_events_actor_idx on audit_events (actor_user_id, occurred_at desc)
  where actor_user_id is not null;

-- Correlating an event with the request and the jobs it produced.
create index audit_events_correlation_idx on audit_events (correlation_id)
  where correlation_id is not null;

-- The same reasoning as the inventory ledger in 0001: append-only, physically
-- ordered by time, unbounded growth. BRIN costs a few pages where a B-tree over
-- the same column would cost gigabytes.
create index audit_events_occurred_at_brin
  on audit_events using brin (occurred_at) with (pages_per_range = 32);

-- ---------------------------------------------------------------------------
-- Integrity triggers
-- ---------------------------------------------------------------------------

create trigger installation_administrators_touch_updated_at
  before update on installation_administrators
  for each row execute function eim_touch_updated_at();

-- The audit trail is evidence, and evidence that can be edited is not evidence.
-- Retention deletion is a separate, bounded, privileged path (section 13) and
-- deliberately does not exist yet: nothing in M1 may remove an audit row.
create or replace function eim_audit_events_is_append_only() returns trigger
language plpgsql
as $$
begin
  raise exception
    'audit_events is append-only; %ing a recorded event is not permitted',
    lower(tg_op)
    using errcode = 'restrict_violation';
end;
$$;

create trigger audit_events_append_only
  before update or delete on audit_events
  for each row execute function eim_audit_events_is_append_only();

-- Final-administrator protection (section 20).
--
-- The same shape as the final-owner trigger in 0001, and for the same reason:
-- an installation with no administrator has no in-application way back in, and
-- recovery then needs the break-glass CLI and direct deployment access. Deferred
-- to commit so that handing the role over inside one transaction is possible
-- while either half alone fails.
create or replace function eim_installation_retains_an_administrator() returns trigger
language plpgsql
as $$
declare
  active_count integer;
begin
  select count(*) into active_count
  from installation_administrators
  where status = 'active';

  if active_count = 0 then
    raise exception 'the installation must retain at least one active administrator'
      using errcode = 'restrict_violation';
  end if;

  return null;
end;
$$;

create constraint trigger installation_administrators_retain_one
  after update or delete on installation_administrators
  deferrable initially deferred
  for each row execute function eim_installation_retains_an_administrator();
