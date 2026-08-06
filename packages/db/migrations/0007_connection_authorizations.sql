-- 0007_connection_authorizations
--
-- The in-flight half of connecting a provider (sections 13, 14).
--
-- Both providers hand the browser to a page they control and then hand it back
-- with a code. Between those two moments the application has to remember what
-- it was doing, and it has to remember it in a way that cannot be forged,
-- reused, or pointed at a different business on the way back.
--
-- Section 13 requires eBay's state to be "signed single-use" and to bind user,
-- business, environment, and connection. Section 14 requires WooCommerce's
-- callback to carry "a signed single-use challenge bound to user, business,
-- normalized store URL, and expiry". Those are the same requirement with
-- different words, so they are one table.
--
-- Single-use is why this is a table rather than a signed cookie or a
-- self-describing token. A signature proves a value was issued by us; only
-- storage proves it has not already been spent. Without that, a callback URL
-- sitting in a browser history — or in a referrer log at the provider — stays
-- valid for as long as its expiry, and replaying it re-links the connection.
--
-- The state itself is never stored. What is stored is a keyed hash of it, as
-- with every other bearer value in this application: a database reader learns
-- that an authorization is pending, not how to complete it.

create table connection_authorizations (
  id                   uuid        primary key default gen_random_uuid(),
  business_id          uuid        not null references businesses (id) on delete cascade,

  provider             text        not null,
  environment          text        not null,

  -- The connection this is expected to update, for a reauthorization. Null when
  -- connecting an account for the first time.
  --
  -- Section 13: reauthorization may update a connection only when the immutable
  -- seller identity and environment match, and authorizing a different seller
  -- creates a new connection instead. Recording the expectation here is what
  -- lets the callback detect the mismatch rather than discovering it later.
  connection_id        uuid,

  initiated_by_user_id uuid        not null references users (id) on delete cascade,

  -- Keyed hash of the state value. The raw value exists only in the URL that
  -- went to the provider.
  state_hash           text        not null,

  -- The store this authorization is for, normalized. WooCommerce only: the
  -- callback has to prove it came back from the same store the operator typed,
  -- and a store URL is that store's identity (section 14).
  store_origin         text,

  -- Where to send the operator afterwards. Validated as a local path by the
  -- application before it is stored; kept here so a slow authorization does not
  -- lose the page somebody started from.
  redirect_path        text        not null default '/connections',

  created_at           timestamptz not null default now(),
  expires_at           timestamptz not null,
  consumed_at          timestamptz,

  constraint connection_authorizations_provider_valid check (
    provider in ('ebay', 'woocommerce')
  ),
  constraint connection_authorizations_environment_valid check (
    environment in ('sandbox', 'production')
  ),
  constraint connection_authorizations_woocommerce_production_only check (
    provider <> 'woocommerce' or environment = 'production'
  ),
  -- A WooCommerce authorization without a store is one whose callback cannot be
  -- bound to anything; an eBay one with a store is describing a field that has
  -- no meaning there.
  constraint connection_authorizations_store_when_woocommerce check (
    (provider = 'woocommerce') = (store_origin is not null)
  ),
  constraint connection_authorizations_expiry_after_creation check (
    expires_at > created_at
  ),
  constraint connection_authorizations_redirect_local check (
    redirect_path ~ '^/[^/\\]'
  ),

  constraint connection_authorizations_connection_fkey
    foreign key (business_id, connection_id)
    references connections (business_id, id) on delete cascade
);

-- The lookup the callback performs, and the uniqueness that makes a collision
-- impossible rather than merely unlikely.
create unique index connection_authorizations_state_unique
  on connection_authorizations (state_hash);

-- One authorization in flight per business, provider, and environment.
--
-- Not a correctness requirement so much as a legibility one: two tabs part-way
-- through connecting the same account produce two codes, one of which will fail
-- with an error nobody can explain. Superseding the older one makes the second
-- tab the live attempt, which is what the person doing it expects.
create unique index connection_authorizations_one_pending
  on connection_authorizations (business_id, provider, environment)
  where consumed_at is null;

create index connection_authorizations_expiry
  on connection_authorizations (expires_at)
  where consumed_at is null;
