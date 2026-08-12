-- 0028_alert_destinations
--
-- Somewhere other than an inbox to send an alert (sections 19, 22).
--
-- Section 22 supports "optional Slack and Discord incoming-webhook adapters and
-- an optional generic signed outbound webhook", with an event allowlist,
-- minimal payloads without PII by default, HMAC signatures, idempotency
-- identifiers, bounded retries, and delivery history.
--
-- The load-bearing decision here is that the endpoint URL is a credential.
--
-- A Slack incoming-webhook URL is a bearer token with a hostname in front of
-- it: anybody holding the string can post into that channel forever, and it
-- cannot be scoped, rotated in place, or revoked without replacing it. Discord
-- is the same. So the URL is not a column — it lives encrypted in
-- `alert_destination_secrets` under the same custody as every other business
-- credential, and what is stored in the open is the host, which is what a
-- screen needs in order to say where this goes.
--
-- Storing the host separately is also what makes the section 19 SSRF check
-- reviewable: a destination is validated when it is saved and again before
-- every send, and the host on the row is the thing an operator can be shown
-- and asked about.
--
-- Three absences.
--
-- There is no per-destination retry schedule. Bounded retries live on the
-- delivery, where the attempt count already is, and a second schedule here
-- would be a second answer to when to try again.
--
-- There is no payload template. Section 22 says minimal payloads without PII by
-- default; a template is how a well-meaning operator puts a buyer's name in a
-- message to a third-party chat service. The payload is built in code from a
-- fixed set of fields.
--
-- There is no `verified` flag separate from `status`. A destination that
-- answered when it was tested is `ready`; one that has started refusing is
-- `failing`. Two columns would let a destination be verified and broken at the
-- same time, which is a sentence with no useful meaning.

create table alert_destinations (
  id                  uuid        primary key default gen_random_uuid(),
  business_id         uuid        not null references businesses (id) on delete cascade,

  -- slack | discord | webhook
  --
  -- The first two shape the payload for a chat service that expects its own
  -- envelope. The third is section 22's generic signed webhook, which is the
  -- only one that is signed: a Slack URL authenticates by being secret, and
  -- adding a signature to it would be ceremony rather than security.
  kind                text        not null,

  -- What a person calls it. Not the URL, and not derived from it: "the
  -- warehouse channel" is what somebody recognizes on a settings screen.
  label               text        not null,

  -- The host of the endpoint, in the open, so a screen can say where this goes
  -- without decrypting a credential. The full URL is in the secrets table.
  endpoint_host       text        not null,

  -- Off until somebody says otherwise, and refused until it has answered once.
  enabled             boolean     not null default false,

  -- unchecked | ready | failing
  status              text        not null default 'unchecked',
  status_reason       text,
  last_success_at     timestamptz,
  last_failure_at     timestamptz,

  -- Section 22's event allowlist. Empty means every kind, which is the useful
  -- default for a chat channel somebody created specifically for this; a
  -- non-empty list narrows it.
  event_allowlist     text[]      not null default '{}',

  -- The floor, as for email. A chat channel that received every Info alert
  -- would be muted by its members within a week.
  min_severity        text        not null default 'error',

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint alert_destinations_kind_known
    check (kind in ('slack', 'discord', 'webhook')),

  constraint alert_destinations_status_known
    check (status in ('unchecked', 'ready', 'failing')),

  constraint alert_destinations_severity_known
    check (min_severity in ('info', 'warning', 'error', 'critical')),

  -- A destination that has never answered cannot be switched on. The same rule
  -- the AI provider follows, for the same reason: enabling something unproven
  -- means the first time anybody discovers it does not work is the first time
  -- it was needed.
  constraint alert_destinations_enabled_means_checked
    check (not enabled or status = 'ready'),

  -- A failure says why. Silence about a broken destination is how an operator
  -- ends up believing their alerts are going somewhere.
  constraint alert_destinations_failure_has_a_reason
    check (status <> 'failing' or status_reason is not null),

  constraint alert_destinations_label_present
    check (length(btrim(label)) > 0)
);

create index alert_destinations_by_business on alert_destinations (business_id);

-- A composite foreign key needs a matching unique constraint to point at, and
-- this one states something true on its own: an identifier belongs to one
-- business. The secrets table below refers to the pair, so a ciphertext moved
-- between businesses fails the key rather than quietly decrypting for somebody
-- else.
alter table alert_destinations
  add constraint alert_destinations_business_scoped unique (business_id, id);

-- Same custody as every other business credential (section 19). Mirrors
-- `ai_provider_secrets` deliberately: one live secret per type per destination,
-- rotation by writing the replacement and retiring the old one in the same
-- transaction, and a key version so a keyring rotation can find what it must
-- re-encrypt.
create table alert_destination_secrets (
  id                  uuid        primary key default gen_random_uuid(),
  business_id         uuid        not null,
  destination_id      uuid        not null,

  -- endpoint_url  the credential-bearing URL itself
  -- signing_key   the HMAC key for a generic webhook, generated by this
  --               application and shown to the operator once
  secret_type         text        not null,
  ciphertext          text        not null,
  key_version         integer     not null,

  created_at          timestamptz not null default now(),
  retired_at          timestamptz,

  constraint alert_destination_secrets_type_known
    check (secret_type in ('endpoint_url', 'signing_key')),
  constraint alert_destination_secrets_destination_fkey
    foreign key (business_id, destination_id)
    references alert_destinations (business_id, id) on delete cascade
);

create unique index alert_destination_secrets_one_live
  on alert_destination_secrets (destination_id, secret_type)
  where retired_at is null;

create index alert_destination_secrets_key_version
  on alert_destination_secrets (key_version);

-- ---------------------------------------------------------------------------
-- The delivery record learns about the new channels
-- ---------------------------------------------------------------------------

alter table notification_deliveries
  add column destination_id uuid references alert_destinations (id) on delete set null;

alter table notification_deliveries drop constraint notification_deliveries_channel_known;

alter table notification_deliveries
  add constraint notification_deliveries_channel_known
  check (channel in ('in_app', 'email', 'slack', 'discord', 'webhook'));

-- A message to a person is addressed to a person; a message to a chat service
-- is addressed to a destination. Neither is ever both, and a row that was
-- neither would be a delivery with nowhere to go.
alter table notification_deliveries
  add constraint notification_deliveries_addressed_once
  check (
    case
      when channel in ('in_app', 'email')
        then recipient_user_id is not null and destination_id is null
      else destination_id is not null and recipient_user_id is null
    end
  );

create index notification_deliveries_by_destination
  on notification_deliveries (destination_id, created_at desc)
  where destination_id is not null;
