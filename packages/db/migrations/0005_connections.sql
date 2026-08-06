-- 0005_connections
--
-- Provider connections and everything that describes their state (sections 13,
-- 14, 19, and 36's M2).
--
-- A connection is one seller account or one store, held by one business. It is
-- the unit almost everything in the integrations hangs from: credentials,
-- granted scopes, readiness, import position, webhook registrations, quota
-- observations. Making it a first-class row rather than a column on the
-- business is what allows the same business to hold an eBay sandbox account, an
-- eBay production account, and two WooCommerce stores at once, each with its own
-- health and its own history.
--
-- Two rules run through the whole file.
--
-- Tenancy is carried, not inferred. Every table that hangs off a connection
-- carries `business_id` and references the connection through a composite
-- foreign key, so a row can only ever belong to the business that owns the
-- connection it names. The application cannot mix two businesses' data by
-- writing the wrong identifier, because the database will not store it.
--
-- Provider identity is immutable. `external_account_id` is the provider's own
-- permanent identifier — the eBay seller identity, the normalized WooCommerce
-- store origin — and reauthorization may only ever refresh a connection whose
-- identity and environment already match. Authorizing a different seller
-- creates a different connection. This is what stops a reauthorization from
-- silently repointing years of mappings and ledger history at somebody else's
-- account.

-- ---------------------------------------------------------------------------
-- Connections
-- ---------------------------------------------------------------------------

create table connections (
  id                  uuid        primary key default gen_random_uuid(),
  business_id         uuid        not null references businesses (id) on delete cascade,

  provider            text        not null,
  -- Sandbox and production are strictly isolated (section 13): separate
  -- keysets, tokens, callbacks, data, and UI state. Recording the environment
  -- on the connection is what makes that isolation a property of the data
  -- rather than a convention the code has to remember.
  environment         text        not null,

  -- The provider's permanent identifier for the account. eBay's immutable
  -- seller identity from the Identity API; for WooCommerce, the normalized
  -- HTTPS origin of the store, which is the closest thing a store has to one.
  external_account_id text        not null,
  -- What to call it in the interface. Editable, unlike the identity above.
  display_name        text        not null,

  status              text        not null default 'pending',
  -- Why work is paused, when it is. Section 13 pauses on scope reduction and on
  -- revocation, and an operator looking at a stalled connection needs to be
  -- told which without reading logs.
  pause_reason        text,

  -- Section 13 and 14: orders placed before the connection was activated are
  -- historical. They are imported for visibility and deduplication, and they do
  -- not mutate canonical inventory unless somebody explicitly approves a replay.
  -- Null until activation, which is what distinguishes "not yet activated" from
  -- "activated at the epoch".
  activated_at        timestamptz,

  connected_at        timestamptz,
  disconnected_at     timestamptz,
  created_by_user_id  uuid        references users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint connections_provider_valid check (provider in ('ebay', 'woocommerce')),
  constraint connections_environment_valid check (environment in ('sandbox', 'production')),
  -- WooCommerce has no sandbox: a test store is simply another store, and
  -- pretending otherwise would produce a second environment with no keyset
  -- behind it. Development stores are permitted through an installation-level
  -- flag instead (section 14), not through a fictional environment.
  constraint connections_woocommerce_production_only check (
    provider <> 'woocommerce' or environment = 'production'
  ),
  constraint connections_status_valid check (
    status in ('pending', 'active', 'paused', 'disconnected', 'revoked')
  ),
  -- A paused connection without a reason is a support ticket waiting to happen.
  constraint connections_pause_reason_present check (
    (status = 'paused') = (pause_reason is not null)
  ),
  -- Activation is what makes imported orders count. A connection that has never
  -- been active cannot have an activation moment.
  constraint connections_activated_after_connected check (
    activated_at is null or connected_at is not null
  ),
  constraint connections_disconnected_recorded check (
    (status in ('disconnected', 'revoked')) = (disconnected_at is not null)
  ),
  constraint connections_display_name_present check (length(btrim(display_name)) > 0),
  constraint connections_external_account_present check (
    length(btrim(external_account_id)) > 0
  ),

  -- The composite-foreign-key target, as elsewhere: redundant against the
  -- primary key alone, and the reason every child table can carry business_id
  -- without being able to disagree with this row.
  constraint connections_business_scoped unique (business_id, id)
);

-- One live connection per account per environment per business.
--
-- Partial, because a disconnected connection is kept: section 13 retains
-- mapping, ledger, order, and audit history after a disconnect, and
-- reconnecting the same seller must be possible. Without the partial predicate
-- the second connection attempt would collide with the corpse of the first.
create unique index connections_account_live
  on connections (business_id, provider, environment, external_account_id)
  where status <> 'disconnected';

create index connections_business on connections (business_id, provider, status);

-- ---------------------------------------------------------------------------
-- Credentials
--
-- Section 19: credentials unique to a business or account are entered in the
-- interface and encrypted in the database, never in the installation .env.
-- Ciphertext is the envelope format from `@eim/crypto`, whose additional
-- authenticated data binds business, resource, secret type, and key version —
-- so a ciphertext lifted from one connection cannot be decrypted as another's.
-- ---------------------------------------------------------------------------

create table connection_secrets (
  id            uuid        primary key default gen_random_uuid(),
  business_id   uuid        not null,
  connection_id uuid        not null,

  secret_type   text        not null,
  -- The whole envelope, including its key version. Nothing here is a plain
  -- value, and nothing here is ever returned to a browser (section 19).
  ciphertext    text        not null,
  -- Denormalized from the envelope so a rotation sweep can find everything
  -- still encrypted under an old key without decrypting anything.
  key_version   integer     not null,

  -- What the provider told us about the credential, kept in the clear because
  -- it is not secret and every scheduling decision needs it. Section 13 requires
  -- expiry and granted scopes to be stored separately from the token itself.
  expires_at    timestamptz,

  created_at    timestamptz not null default now(),
  -- Rotation is overlapping, not atomic-with-a-gap (section 14): the
  -- replacement is created and proven before the old one is retired. Both rows
  -- exist at once, and only the unretired one is the live credential.
  retired_at    timestamptz,

  constraint connection_secrets_type_valid check (
    secret_type in (
      'ebay_refresh_token',
      'ebay_access_token',
      'woocommerce_consumer_key',
      'woocommerce_consumer_secret',
      'webhook_secret'
    )
  ),
  constraint connection_secrets_ciphertext_present check (length(ciphertext) > 0),
  constraint connection_secrets_key_version_positive check (key_version > 0),

  constraint connection_secrets_connection_fkey
    foreign key (business_id, connection_id)
    references connections (business_id, id) on delete cascade
);

-- One live credential of each kind per connection. Retired ones accumulate
-- until a retention sweep removes them, and are never selected as current.
create unique index connection_secrets_live
  on connection_secrets (connection_id, secret_type)
  where retired_at is null;

create index connection_secrets_key_version
  on connection_secrets (key_version)
  where retired_at is null;

-- ---------------------------------------------------------------------------
-- Granted scopes
--
-- Section 13: expiry and granted scopes are stored separately from the token.
-- A reauthorization that returns fewer scopes than before pauses the affected
-- capabilities after an impact preview, which requires knowing what was granted
-- before as well as now.
-- ---------------------------------------------------------------------------

create table connection_scopes (
  business_id   uuid        not null,
  connection_id uuid        not null,
  scope         text        not null,
  granted_at    timestamptz not null default now(),

  constraint connection_scopes_pkey primary key (connection_id, scope),

  constraint connection_scopes_connection_fkey
    foreign key (business_id, connection_id)
    references connections (business_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Readiness
--
-- Section 13's readiness assessment is read-only and per-check: a connection is
-- not simply ready or not, it is ready for some capabilities and not others.
-- Catalog import may proceed while a live write capability stays blocked because
-- its own prerequisite failed, and that is only expressible if each check keeps
-- its own outcome.
-- ---------------------------------------------------------------------------

create table connection_readiness_checks (
  business_id   uuid        not null,
  connection_id uuid        not null,
  check_name    text        not null,

  status        text        not null,
  -- Human-readable, for the interface. Never a raw provider error: section 19
  -- keeps provider bodies out of anything an operator reads casually.
  summary       text        not null,
  -- Structured evidence for the interface to render — counts, identifiers,
  -- which policies were found. Never credentials.
  detail        jsonb       not null default '{}'::jsonb,
  checked_at    timestamptz not null default now(),

  constraint connection_readiness_checks_pkey primary key (connection_id, check_name),
  constraint connection_readiness_checks_status_valid check (
    status in ('pass', 'warn', 'fail', 'unknown')
  ),

  constraint connection_readiness_checks_connection_fkey
    foreign key (business_id, connection_id)
    references connections (business_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Health
--
-- One row per connection, updated in place: the current answer to "is this
-- working". Distinct from readiness, which is about capability prerequisites.
-- A connection can be fully ready and currently failing, or degraded but usable.
-- ---------------------------------------------------------------------------

create table connection_health (
  business_id           uuid        not null,
  connection_id         uuid        not null,

  status                text        not null default 'unknown',
  -- Why it is not healthy, when it is not. Section 14 requires missing webhook
  -- capability to produce a visible degraded status rather than silent polling.
  summary               text,

  -- Consecutive failures rather than a rate, because the decision this feeds is
  -- "has it stopped working", and a connection that fails once an hour forever
  -- is a different problem from one that has been down since Tuesday.
  consecutive_failures  integer     not null default 0,
  last_success_at       timestamptz,
  last_failure_at       timestamptz,
  checked_at            timestamptz,
  updated_at            timestamptz not null default now(),

  constraint connection_health_pkey primary key (connection_id),
  constraint connection_health_status_valid check (
    status in ('healthy', 'degraded', 'failing', 'unknown')
  ),
  constraint connection_health_failures_nonnegative check (consecutive_failures >= 0),

  constraint connection_health_connection_fkey
    foreign key (business_id, connection_id)
    references connections (business_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Import cursors
--
-- Sections 13 and 14: imports are resumable and idempotent with cursor and
-- offset checkpoints, and a partial or failed scan never declares unseen
-- records deleted.
--
-- The cursor is per stream rather than per connection because the streams move
-- independently — orders arrive constantly while business policies change
-- monthly — and a single position would drag one back every time the other
-- advanced.
-- ---------------------------------------------------------------------------

create table connection_cursors (
  business_id        uuid        not null,
  connection_id      uuid        not null,
  stream             text        not null,

  -- Opaque to us: a page token, a timestamp, an offset, whatever that provider
  -- and stream use. Interpreting it belongs to the adapter that issued it.
  cursor_value       text,
  -- Partial progress within a run, so an interrupted import resumes rather than
  -- restarting. Structured because what needs remembering differs per stream.
  checkpoint         jsonb       not null default '{}'::jsonb,

  -- When a scan last completed end to end. This is the only timestamp that
  -- licenses a deletion sweep: something absent from a complete scan is gone,
  -- while something absent from an interrupted one merely was not reached.
  last_complete_at   timestamptz,
  updated_at         timestamptz not null default now(),

  constraint connection_cursors_pkey primary key (connection_id, stream),

  constraint connection_cursors_connection_fkey
    foreign key (business_id, connection_id)
    references connections (business_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Import runs
--
-- The record of an attempt, kept whether or not it succeeded. An import that
-- failed halfway is the evidence for why some records are stale, and deleting
-- the row on failure would destroy exactly the history an operator needs.
-- ---------------------------------------------------------------------------

create table import_runs (
  id                uuid        primary key default gen_random_uuid(),
  business_id       uuid        not null,
  connection_id     uuid        not null,
  stream            text        not null,

  status            text        not null default 'running',
  -- Whether this run observed the entire stream. Only a complete run may be
  -- used to conclude that anything it did not see no longer exists.
  swept_completely  boolean     not null default false,

  started_at        timestamptz not null default now(),
  finished_at       timestamptz,

  pages_fetched     integer     not null default 0,
  records_seen      integer     not null default 0,
  records_written   integer     not null default 0,

  -- Bounded description, never the provider's response body (section 19).
  failure_summary   text,
  -- Where to resume, copied to the cursor only when the run reaches a
  -- consistent point. Keeping it on the run as well means a failed attempt can
  -- be inspected without having already moved the connection's position.
  checkpoint        jsonb       not null default '{}'::jsonb,

  constraint import_runs_status_valid check (
    status in ('running', 'completed', 'failed', 'cancelled')
  ),
  constraint import_runs_finished_recorded check (
    (status = 'running') = (finished_at is null)
  ),
  -- A run that did not finish cannot have swept the stream.
  constraint import_runs_sweep_requires_completion check (
    not swept_completely or status = 'completed'
  ),
  constraint import_runs_counts_nonnegative check (
    pages_fetched >= 0 and records_seen >= 0 and records_written >= 0
  ),

  constraint import_runs_connection_fkey
    foreign key (business_id, connection_id)
    references connections (business_id, id) on delete cascade
);

create index import_runs_recent
  on import_runs (connection_id, stream, started_at desc);

-- At most one run in flight per stream. Two concurrent imports of the same
-- stream would interleave their cursors and each would conclude the other's
-- unfetched pages were missing.
create unique index import_runs_one_active
  on import_runs (connection_id, stream)
  where status = 'running';

-- ---------------------------------------------------------------------------
-- Webhook registrations
--
-- Section 14 distinguishes sharply between webhooks this application created
-- and webhooks it merely found. App-created ones are managed: re-enabled after
-- recovery, rotated, and deleted on disconnect. Manually created ones are
-- listed for the operator and never touched, because deleting somebody else's
-- integration is not ours to do.
-- ---------------------------------------------------------------------------

create table provider_webhooks (
  id             uuid        primary key default gen_random_uuid(),
  business_id    uuid        not null,
  connection_id  uuid        not null,

  topic          text        not null,
  -- The provider's identifier for the registration, absent only while we are
  -- creating one and have not yet been told what it is called.
  external_id    text,
  delivery_url   text        not null,

  -- Whether this application created it and may therefore manage it.
  app_managed    boolean     not null default true,
  status         text        not null default 'pending',

  -- The signing secret for verifying deliveries, as a connection secret so it
  -- is encrypted with everything else rather than being the one credential in
  -- the clear.
  secret_id      uuid        references connection_secrets (id) on delete set null,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  last_delivery_at timestamptz,
  failure_count  integer     not null default 0,

  constraint provider_webhooks_status_valid check (
    status in ('pending', 'active', 'paused', 'replacing', 'deleted', 'failed')
  ),
  constraint provider_webhooks_failures_nonnegative check (failure_count >= 0),
  -- A webhook we did not create is one we cannot manage, so it has no secret of
  -- ours and no lifecycle of ours to run.
  constraint provider_webhooks_unmanaged_has_no_secret check (
    app_managed or secret_id is null
  ),

  constraint provider_webhooks_connection_fkey
    foreign key (business_id, connection_id)
    references connections (business_id, id) on delete cascade
);

create unique index provider_webhooks_external_unique
  on provider_webhooks (connection_id, external_id)
  where external_id is not null;

-- One live app-managed registration per topic. Rotation deliberately violates
-- nothing here: the replacement is created with status 'replacing', which is
-- outside the predicate, and becomes 'active' only as the old one leaves it.
create unique index provider_webhooks_one_active_topic
  on provider_webhooks (connection_id, topic)
  where app_managed and status = 'active';

-- ---------------------------------------------------------------------------
-- Webhook deliveries
--
-- Section 14: persist before acknowledgment, deduplicate on delivery identity
-- plus resource identity, and treat headers other than the signature as
-- metadata rather than authentication.
--
-- This table is the durable record that acknowledgment is allowed to rely on.
-- Processing happens afterwards, from the row, which is what makes a crash
-- between "200 OK" and "handled" recoverable instead of a silent lost event.
-- ---------------------------------------------------------------------------

create table webhook_deliveries (
  id                   uuid        primary key default gen_random_uuid(),
  business_id          uuid        not null,
  connection_id        uuid        not null,

  topic                text        not null,
  -- The provider's delivery identifier. Absent for providers that do not send
  -- one, which is why the deduplication index below falls back to the resource.
  external_delivery_id text,
  resource_type        text,
  resource_id          text,

  -- Whether the signature verified. Stored rather than assumed: an unverified
  -- delivery is retained as evidence of an attempt and never processed.
  signature_verified   boolean     not null default false,

  received_at          timestamptz not null default now(),
  processed_at         timestamptz,
  status               text        not null default 'received',
  failure_summary      text,

  -- The raw body, retained under section 35's shorter raw-event window (30 days
  -- by default) rather than the 180-day normalized history, because it can
  -- contain buyer data that nothing downstream needs to keep.
  raw_body             text,
  -- Non-authenticating headers, kept for diagnosis. The signature header itself
  -- is not stored: it is a credential for a body we already verified, and
  -- keeping it would only extend its life.
  headers              jsonb       not null default '{}'::jsonb,

  constraint webhook_deliveries_status_valid check (
    status in ('received', 'processed', 'ignored', 'rejected', 'failed')
  ),
  -- An unverified delivery may be recorded and rejected, never processed.
  constraint webhook_deliveries_unverified_not_processed check (
    signature_verified or status <> 'processed'
  ),
  constraint webhook_deliveries_processed_recorded check (
    (status in ('processed', 'ignored')) = (processed_at is not null)
  ),

  constraint webhook_deliveries_connection_fkey
    foreign key (business_id, connection_id)
    references connections (business_id, id) on delete cascade
);

-- Deduplication on delivery identity where the provider gives one.
create unique index webhook_deliveries_delivery_unique
  on webhook_deliveries (connection_id, external_delivery_id)
  where external_delivery_id is not null;

create index webhook_deliveries_pending
  on webhook_deliveries (connection_id, received_at)
  where status = 'received';

create index webhook_deliveries_retention on webhook_deliveries (received_at);

-- ---------------------------------------------------------------------------
-- Quota observations
--
-- Section 13: monitor quotas per application, API family, and seller where
-- available; warn at 70%, 85%, and 95%; reserve capacity for orders, inventory,
-- token refresh, and notification verification.
--
-- Published limits are informational rather than guaranteed, so what is stored
-- is what the provider actually said, with the moment it said it. A limit we
-- inferred and a limit we were told apart is the difference between throttling
-- correctly and throttling superstitiously.
-- ---------------------------------------------------------------------------

create table provider_quota_windows (
  id             uuid        primary key default gen_random_uuid(),
  -- Null for an application-level quota, which is shared across every business
  -- in the installation and belongs to none of them.
  business_id    uuid,
  connection_id  uuid,

  provider       text        not null,
  api_family     text        not null,

  window_starts_at timestamptz not null,
  window_ends_at   timestamptz not null,

  limit_count    bigint,
  used_count     bigint      not null default 0,
  observed_at    timestamptz not null default now(),

  constraint provider_quota_windows_provider_valid check (
    provider in ('ebay', 'woocommerce')
  ),
  constraint provider_quota_windows_window_ordered check (
    window_ends_at > window_starts_at
  ),
  constraint provider_quota_windows_counts_nonnegative check (
    used_count >= 0 and (limit_count is null or limit_count >= 0)
  ),
  -- An application-level quota has no connection; a seller-level one has both.
  constraint provider_quota_windows_scope_consistent check (
    (business_id is null) = (connection_id is null)
  ),

  constraint provider_quota_windows_connection_fkey
    foreign key (business_id, connection_id)
    references connections (business_id, id) on delete cascade
);

create unique index provider_quota_windows_unique
  on provider_quota_windows (
    provider,
    api_family,
    coalesce(connection_id, '00000000-0000-0000-0000-000000000000'::uuid),
    window_starts_at
  );

-- ---------------------------------------------------------------------------
-- The deferred grant foreign key
--
-- `permission_grant_connections` was created in 0003 without a foreign key,
-- because a connection-scoped grant is an identity concept that could not wait
-- for the integrations. The target exists now, so the constraint is added.
--
-- Existing rows are validated rather than trusted: there are none in any
-- installation, since no connection has ever existed to scope a grant to, and
-- an unvalidated constraint would leave that assumption unchecked forever.
-- ---------------------------------------------------------------------------

alter table permission_grant_connections
  add constraint permission_grant_connections_connection_fkey
  foreign key (business_id, connection_id)
  references connections (business_id, id) on delete cascade;

-- ---------------------------------------------------------------------------
-- Timestamp maintenance
-- ---------------------------------------------------------------------------

create trigger connections_touch
  before update on connections
  for each row execute function eim_touch_updated_at();

create trigger connection_health_touch
  before update on connection_health
  for each row execute function eim_touch_updated_at();

create trigger connection_cursors_touch
  before update on connection_cursors
  for each row execute function eim_touch_updated_at();

create trigger provider_webhooks_touch
  before update on provider_webhooks
  for each row execute function eim_touch_updated_at();
