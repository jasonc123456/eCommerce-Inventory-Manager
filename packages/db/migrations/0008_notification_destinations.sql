-- 0008_notification_destinations
--
-- Where eBay sends notifications to (section 13).
--
-- Every other provider table in this schema is scoped to a business, because
-- every other provider fact belongs to one. This one does not, and that is the
-- whole reason it exists separately. eBay registers a destination against the
-- *application* keyset, not against a seller: one URL receives the events of
-- every seller who has authorized this installation, and the deletion endpoint
-- is registered once for the application in eBay's developer portal.
--
-- So the row is keyed by provider and environment. Sandbox and production are
-- separate keysets with separate destinations, and an installation that has
-- both is normal — one is where the operator rehearses.
--
-- The verification token is not stored here. It lives in the installation
-- secrets (`EIM_EBAY_DELETION_VERIFICATION_TOKEN`), and what is kept is a keyed
-- hash of it, so that a token the operator changed in eBay's portal is
-- detectable — the destination has to be re-registered when it changes, and
-- silently continuing with the old one means every subsequent notification
-- fails verification for a reason nothing reports.

create table notification_destinations (
  id                       uuid        primary key default gen_random_uuid(),

  provider                 text        not null default 'ebay',
  environment              text        not null,

  -- Where the provider delivers. HTTPS only, and not because of a preference:
  -- eBay refuses to register anything else, and a plaintext endpoint would put
  -- buyer identifiers on the wire.
  endpoint_url             text        not null,
  -- The provider's identifier for the registration, absent only between
  -- deciding to create one and being told what it is called.
  external_id              text,

  status                   text        not null default 'pending',
  -- Why it is not enabled, when it is not. Section 22 shows this on the health
  -- surface: a destination eBay disabled after repeated delivery failures is
  -- indistinguishable from a quiet marketplace unless somebody says so.
  summary                  text,

  -- A keyed hash of the verification token this destination was registered
  -- with. Never the token.
  verification_fingerprint text,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  last_checked_at          timestamptz,

  constraint notification_destinations_environment_valid check (
    environment in ('sandbox', 'production')
  ),
  constraint notification_destinations_status_valid check (
    status in ('pending', 'enabled', 'disabled', 'failed')
  ),
  constraint notification_destinations_endpoint_https check (
    endpoint_url ~ '^https://'
  ),
  -- A destination the provider has acknowledged has an identifier there. One
  -- that is still pending, or that failed to register, does not.
  constraint notification_destinations_registered check (
    (status in ('enabled', 'disabled')) = (external_id is not null)
  )
);

-- One destination per keyset. Two would mean half a seller's events arriving
-- somewhere this installation is not reading.
create unique index notification_destinations_keyset_unique
  on notification_destinations (provider, environment);

create unique index notification_destinations_external_unique
  on notification_destinations (provider, external_id)
  where external_id is not null;

create trigger notification_destinations_touch
  before update on notification_destinations
  for each row execute function eim_touch_updated_at();
