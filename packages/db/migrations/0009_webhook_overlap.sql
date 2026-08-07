-- 0009_webhook_overlap
--
-- Making a rotated webhook's overlap harmless (section 14).
--
-- Section 14 rotates a WooCommerce webhook secret by creating a replacement
-- registration alongside the old one, proving the replacement works, and only
-- then removing what it replaced. For the length of that overlap the store has
-- two live registrations for the same topic, and every event is therefore
-- delivered twice.
--
-- Section 14's answer is one sentence long — "deduplication handles overlap" —
-- and the deduplication it already had cannot do it. `external_delivery_id` is
-- assigned per registration, so the two copies of one event carry two different
-- delivery identifiers and the existing unique index sees two distinct
-- deliveries. For an order, acting on both is a second stock movement for a sale
-- that happened once.
--
-- So a second key is added: a fingerprint of what the delivery is *about*
-- rather than of which registration carried it. Two registrations delivering
-- one event produce one fingerprint, and the database refuses the second copy
-- for the same reason it refuses the first duplicate delivery identifier.
--
-- A genuine repeat that is byte-identical is suppressed too, and that is
-- correct rather than merely tolerable: section 14 requires product webhook
-- processing to refetch the current resource through REST before acting, so
-- processing an identical body twice reaches the same state as processing it
-- once, at the cost of an extra round trip to the store.

alter table webhook_deliveries
  -- Null for providers and deliveries where nothing distinctive can be
  -- computed; the partial index below means those fall back to the delivery
  -- identifier, exactly as they did before.
  add column dedupe_key text,

  add constraint webhook_deliveries_dedupe_key_shape check (
    dedupe_key is null or length(dedupe_key) between 16 and 128
  );

create unique index webhook_deliveries_content_unique
  on webhook_deliveries (connection_id, dedupe_key)
  where dedupe_key is not null;

-- ---------------------------------------------------------------------------
-- Rotation state on the registration itself
-- ---------------------------------------------------------------------------

alter table provider_webhooks
  -- Which registration this one was created to replace. Set while a rotation is
  -- in flight and kept afterwards, because "this secret replaced that one on
  -- this date" is the question asked after an incident.
  add column replaces_id uuid references provider_webhooks (id) on delete set null,

  -- When a delivery last arrived and *verified* against this registration's
  -- secret. Distinct from `last_delivery_at`, which records that something
  -- arrived: a registration receiving a steady stream of deliveries that fail
  -- verification is not healthy, it is misconfigured or under attack, and a
  -- single column cannot say which.
  --
  -- This is also what makes rotation and the manual-setup fallback provable.
  -- Section 14 requires a replacement to be tested before the old registration
  -- is removed, and a manually created webhook to be health-verified; in both
  -- cases the evidence is the same — a delivery this application could verify.
  add column last_verified_at timestamptz,

  -- A registration cannot replace itself.
  add constraint provider_webhooks_replaces_not_self check (replaces_id is null or replaces_id <> id);

create index provider_webhooks_replacing
  on provider_webhooks (connection_id, replaces_id)
  where replaces_id is not null;

-- The set a delivery is verified against: every registration whose secret is
-- still live. `replacing` is in it because a replacement must be able to prove
-- itself, and `active` because it is what is proving itself against.
create index provider_webhooks_verifiable
  on provider_webhooks (connection_id, status)
  where app_managed and status in ('active', 'replacing', 'pending');

-- ---------------------------------------------------------------------------
-- More than one live secret of a kind
--
-- `connection_secrets_live` permitted exactly one unretired secret of each kind
-- per connection. That is right for an OAuth refresh token, where a second live
-- one is a bug. It is wrong for WooCommerce webhooks: section 14 requires a
-- distinct random secret *per managed webhook*, so a connection with the six
-- core product and order topics has six live webhook secrets, and seven for as
-- long as a rotation is in flight.
--
-- So the uniqueness gains a discriminator. It is null for every existing kind,
-- which leaves their guarantee exactly as it was, and for a webhook secret it is
-- the registration the secret belongs to — not the topic, because during a
-- rotation two registrations share a topic and that is the entire point of the
-- overlap.
-- ---------------------------------------------------------------------------

alter table connection_secrets
  add column secret_scope text,

  -- Spelled as an equivalence rather than two implications so neither half can
  -- be relaxed without the other being reconsidered: a webhook secret is
  -- meaningless without knowing which registration it signs for, and every other
  -- kind is already unique per connection and has nothing to scope by.
  add constraint connection_secrets_scope_when_webhook check (
    (secret_type = 'webhook_secret') = (secret_scope is not null)
  ),
  add constraint connection_secrets_scope_shape check (
    secret_scope is null or length(secret_scope) between 1 and 128
  );

drop index connection_secrets_live;

create unique index connection_secrets_live
  on connection_secrets (connection_id, secret_type, coalesce(secret_scope, ''))
  where retired_at is null;
