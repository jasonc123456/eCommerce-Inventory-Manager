-- 0006_provider_mirror
--
-- What the providers told us, kept as they told it (sections 6, 13, 14, 15).
--
-- Everything here is a mirror. Nothing in this file is canonical, nothing in it
-- drives inventory, and nothing in it may be edited by a person. It is the
-- record of what eBay and WooCommerce said their catalogs and orders looked
-- like, which is a different thing from what this application believes — and
-- keeping them in separate tables is what makes a disagreement detectable
-- instead of resolved by whichever write happened last.
--
-- M2 is read-only by definition (section 36), so this is where imports land and
-- stop. The canonical items and the mappings that connect the two arrive in M3.
--
-- Three rules run through the file.
--
-- Disappearance is concluded, never assumed. Section 6 permits declaring an
-- entity gone only after a complete successful scan, so every mirrored row
-- carries `last_seen_at` and `missing_since` rather than being deleted when a
-- page fails to mention it. A partial import leaves stale rows, which is the
-- correct outcome: a listing nobody managed to fetch has not been withdrawn.
--
-- Provider identity is the key. Rows are addressed by the provider's own
-- identifier within a connection, so importing the same catalog twice updates
-- rather than duplicates, and an import that runs concurrently with itself
-- cannot produce two versions of one listing.
--
-- Buyer data is kept to the minimum that deduplication needs. Section 13 makes
-- marketplace account-deletion compliance mandatory *because* order and buyer
-- data is stored, and the cheapest way to comply is to store almost none of it.
-- Orders here carry the provider's buyer identifier and nothing else — no name,
-- no address, no contact details. Fulfilment needs those and collects them in
-- M4 and M6, under the retention rules that come with them.

-- ---------------------------------------------------------------------------
-- Catalog entities
--
-- One table for what eBay calls a listing, an offer, or an inventory item, and
-- what WooCommerce calls a product or a variation. They are the same thing for
-- this purpose: something on a channel that can carry a quantity, or a parent
-- that holds the ones that can.
--
-- Unified rather than split per provider because everything downstream — the
-- mapping UI, eligibility, the staleness sweep — asks the same questions of
-- both, and two tables would mean two of every query with one of them
-- eventually forgotten.
-- ---------------------------------------------------------------------------

create table provider_items (
  id                   uuid        primary key default gen_random_uuid(),
  business_id          uuid        not null,
  connection_id        uuid        not null,

  -- The provider's identifier. An eBay listing id, offer id, or SKU; a
  -- WooCommerce product or variation id.
  external_id          text        not null,
  -- The parent for a variation. Null for anything standalone.
  parent_external_id   text,

  kind                 text        not null,

  sku                  text,
  title                text,
  -- What the provider currently says the quantity is. An observation, not an
  -- instruction: section 8 makes this application's ledger the authority, and a
  -- surprising number here is evidence for reconciliation rather than a
  -- correction to apply.
  quantity             integer,
  -- Section 8 as amended by D-130: WooCommerce uses negative stock to record
  -- backorder demand, and flattening it to zero destroys the signal.
  backorders_enabled   boolean     not null default false,

  price_amount         numeric(18, 4),
  price_currency       text,

  -- The provider's own state: 'active', 'draft', 'ended', 'private', and so on.
  -- Not normalized, because normalizing it would mean deciding what an unknown
  -- state means, and section 14 requires unknown states to be surfaced rather
  -- than guessed.
  provider_status      text,

  -- Section 13: each listing's management origin decides which API may write to
  -- it, and a listing whose origin is ambiguous is read-only. Recorded at import
  -- so the decision is made once, from what the provider said, rather than
  -- re-derived at each write from whatever is known then.
  management_origin    text        not null default 'unknown',

  -- Section 6: whether this entity can carry canonical inventory at all. A
  -- WooCommerce variable product managing stock at the parent level cannot
  -- (D-131), nor can a plugin-controlled entity we do not understand.
  inventory_eligible   boolean     not null default false,
  -- Why not, in words meant for the person who has to fix it.
  ineligible_reason    text,

  -- The provider's payload, for fields nothing here models yet. Section 14
  -- requires extension metadata to be preserved without being interpreted, and
  -- this is where it survives.
  raw                  jsonb       not null default '{}'::jsonb,

  first_seen_at        timestamptz not null default now(),
  last_seen_at         timestamptz not null default now(),
  -- Set when a *complete* scan did not find it. Cleared if it reappears.
  missing_since        timestamptz,
  -- The run that last observed it, so a stale row can be traced to the import
  -- that should have refreshed it.
  last_import_run_id   uuid        references import_runs (id) on delete set null,

  constraint provider_items_kind_valid check (
    kind in ('listing', 'offer', 'inventory_item', 'product', 'variation')
  ),
  constraint provider_items_origin_valid check (
    management_origin in ('unknown', 'inventory_api', 'trading_api', 'ambiguous', 'woocommerce')
  ),
  -- An eligible entity with a reason it is not eligible is a contradiction, and
  -- an ineligible one without a reason is a support ticket.
  constraint provider_items_ineligible_explained check (
    inventory_eligible = (ineligible_reason is null)
  ),
  constraint provider_items_currency_shaped check (
    price_currency is null or price_currency ~ '^[A-Z]{3}$'
  ),
  -- A price needs a currency to mean anything.
  constraint provider_items_price_complete check (
    (price_amount is null) = (price_currency is null)
  ),
  constraint provider_items_external_id_present check (length(btrim(external_id)) > 0),

  constraint provider_items_connection_fkey
    foreign key (business_id, connection_id)
    references connections (business_id, id) on delete cascade,

  constraint provider_items_business_scoped unique (business_id, id)
);

create unique index provider_items_external_unique
  on provider_items (connection_id, external_id);

create index provider_items_sku on provider_items (connection_id, sku) where sku is not null;

create index provider_items_parent
  on provider_items (connection_id, parent_external_id)
  where parent_external_id is not null;

-- The sweep's working set: what a complete scan did not see this time.
create index provider_items_stale on provider_items (connection_id, last_seen_at);

-- ---------------------------------------------------------------------------
-- Locations
--
-- Section 13 imports existing eBay locations and requires them to be explicitly
-- mapped to internal ones; it never creates or modifies them automatically. The
-- mapping column is nullable and stays that way until somebody chooses, because
-- guessing which warehouse an eBay location means is exactly the guess that
-- sends stock to the wrong place.
-- ---------------------------------------------------------------------------

create table provider_locations (
  id                 uuid        primary key default gen_random_uuid(),
  business_id        uuid        not null,
  connection_id      uuid        not null,

  external_id        text        not null,
  name               text,
  -- eBay's merchant location key, which is what its APIs actually address.
  merchant_key       text,
  enabled            boolean     not null default true,

  -- Chosen by a person, never inferred. Composite so a location from another
  -- business cannot be named here.
  mapped_location_id uuid,

  raw                jsonb       not null default '{}'::jsonb,
  first_seen_at      timestamptz not null default now(),
  last_seen_at       timestamptz not null default now(),
  missing_since      timestamptz,

  constraint provider_locations_connection_fkey
    foreign key (business_id, connection_id)
    references connections (business_id, id) on delete cascade,

  constraint provider_locations_mapped_fkey
    foreign key (business_id, mapped_location_id)
    references locations (business_id, id) on delete set null
);

create unique index provider_locations_external_unique
  on provider_locations (connection_id, external_id);

-- ---------------------------------------------------------------------------
-- Business policies
--
-- Section 13: existing eBay payment, return, and fulfillment policies are
-- imported and selected. Version 1 does not create or edit them, so this table
-- is read-only in the strongest sense — there is no code path that writes to
-- eBay from it.
-- ---------------------------------------------------------------------------

create table provider_policies (
  id            uuid        primary key default gen_random_uuid(),
  business_id   uuid        not null,
  connection_id uuid        not null,

  external_id   text        not null,
  policy_type   text        not null,
  name          text,
  marketplace   text,

  raw           jsonb       not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  missing_since timestamptz,

  constraint provider_policies_type_valid check (
    policy_type in ('payment', 'return', 'fulfillment')
  ),

  constraint provider_policies_connection_fkey
    foreign key (business_id, connection_id)
    references connections (business_id, id) on delete cascade
);

create unique index provider_policies_external_unique
  on provider_policies (connection_id, policy_type, external_id);

-- ---------------------------------------------------------------------------
-- Orders
--
-- Imported for visibility and deduplication (sections 13, 14). In M2 they
-- mutate nothing: the consumption rules, reservations, and ledger entries are
-- M4's, and an order row here is a record that the provider has one.
--
-- `pre_activation` is the flag that keeps a first import from looking like a
-- year of sudden demand. It is computed once, at import, against the
-- connection's activation moment, rather than re-derived later from a
-- timestamp comparison that a change to `activated_at` would silently rewrite.
-- ---------------------------------------------------------------------------

create table provider_orders (
  id                uuid        primary key default gen_random_uuid(),
  business_id       uuid        not null,
  connection_id     uuid        not null,

  external_id       text        not null,
  -- The provider's own order number, when it differs from the identifier its
  -- API addresses the order by. eBay has both and shows the other one to the
  -- seller, so an operator searching for what they can see needs it stored.
  external_reference text,

  placed_at         timestamptz,
  updated_at_provider timestamptz,

  -- The provider's status string, unnormalized for the same reason as items:
  -- section 14 requires unknown and custom statuses to be classified by an
  -- owner before they affect anything, which is impossible once the original
  -- has been mapped away.
  provider_status   text,

  total_amount      numeric(18, 4),
  total_currency    text,

  -- The provider's identifier for the buyer, and nothing else about them. This
  -- is what a marketplace deletion request arrives naming, so it is what has to
  -- be findable; a name or an address here would be data to erase rather than
  -- data to search.
  buyer_external_id text,

  pre_activation    boolean     not null default false,

  raw               jsonb       not null default '{}'::jsonb,
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  last_import_run_id uuid       references import_runs (id) on delete set null,

  constraint provider_orders_currency_shaped check (
    total_currency is null or total_currency ~ '^[A-Z]{3}$'
  ),
  constraint provider_orders_total_complete check (
    (total_amount is null) = (total_currency is null)
  ),

  constraint provider_orders_connection_fkey
    foreign key (business_id, connection_id)
    references connections (business_id, id) on delete cascade,

  constraint provider_orders_business_scoped unique (business_id, id)
);

create unique index provider_orders_external_unique
  on provider_orders (connection_id, external_id);

create index provider_orders_placed on provider_orders (connection_id, placed_at desc);

-- Marketplace deletion arrives naming a buyer, and has to find every order in
-- the installation that mentions them (section 13, D-137).
create index provider_orders_buyer
  on provider_orders (buyer_external_id)
  where buyer_external_id is not null;

create table provider_order_lines (
  id                 uuid        primary key default gen_random_uuid(),
  business_id        uuid        not null,
  order_id           uuid        not null,

  external_id        text        not null,
  -- What was bought, as the provider identifies it. Not a foreign key to
  -- `provider_items`: an order can name a listing that has since been ended and
  -- swept away, and losing the order line with it would be the wrong trade.
  item_external_id   text,
  variation_external_id text,
  sku                text,

  quantity           integer     not null,
  -- What the provider says has shipped. Section 13 supports partial quantities
  -- and multiple packages, so this is a count rather than a boolean.
  quantity_fulfilled integer     not null default 0,

  unit_amount        numeric(18, 4),
  currency           text,

  raw                jsonb       not null default '{}'::jsonb,

  constraint provider_order_lines_quantity_positive check (quantity > 0),
  constraint provider_order_lines_fulfilled_bounded check (
    quantity_fulfilled >= 0 and quantity_fulfilled <= quantity
  ),
  constraint provider_order_lines_currency_shaped check (
    currency is null or currency ~ '^[A-Z]{3}$'
  ),

  constraint provider_order_lines_order_fkey
    foreign key (business_id, order_id)
    references provider_orders (business_id, id) on delete cascade
);

create unique index provider_order_lines_external_unique
  on provider_order_lines (order_id, external_id);

create index provider_order_lines_item
  on provider_order_lines (item_external_id)
  where item_external_id is not null;

-- ---------------------------------------------------------------------------
-- Refunds
--
-- Section 14: a WooCommerce refund is imported as a financial event and never
-- restores canonical inventory on its own, because the `api_restock` input that
-- decided whether stock came back is not readable afterwards. What the refund
-- record can do is become evidence for a restock candidate that a person
-- confirms, which is why it is stored rather than ignored.
-- ---------------------------------------------------------------------------

create table provider_refunds (
  id                uuid        primary key default gen_random_uuid(),
  business_id       uuid        not null,
  connection_id     uuid        not null,
  order_id          uuid,

  external_id       text        not null,
  order_external_id text        not null,

  amount            numeric(18, 4),
  currency          text,
  reason            text,
  refunded_at       timestamptz,

  raw               jsonb       not null default '{}'::jsonb,
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),

  constraint provider_refunds_currency_shaped check (
    currency is null or currency ~ '^[A-Z]{3}$'
  ),

  constraint provider_refunds_connection_fkey
    foreign key (business_id, connection_id)
    references connections (business_id, id) on delete cascade,

  -- Nullable: a refund can be imported before the order it belongs to, and
  -- refusing it until the order arrives would drop it permanently.
  constraint provider_refunds_order_fkey
    foreign key (business_id, order_id)
    references provider_orders (business_id, id) on delete set null
);

create unique index provider_refunds_external_unique
  on provider_refunds (connection_id, external_id);

-- ---------------------------------------------------------------------------
-- Notification topics
--
-- Section 13: subscribe each seller to every relevant permitted topic,
-- discovered dynamically, because topic access varies by seller and cannot be
-- hardcoded. Polling stays on regardless, so a topic that cannot be subscribed
-- to is a degradation rather than an outage — which is only true if we record
-- which ones failed and why.
-- ---------------------------------------------------------------------------

create table provider_notification_topics (
  business_id     uuid        not null,
  connection_id   uuid        not null,
  topic           text        not null,

  status          text        not null default 'discovered',
  -- eBay's identifier for our subscription, once it has one.
  subscription_id text,
  -- Why we are not subscribed, when we are not. Section 22 shows this on the
  -- health surface rather than leaving an operator to infer it from silence.
  summary         text,

  discovered_at   timestamptz not null default now(),
  subscribed_at   timestamptz,
  updated_at      timestamptz not null default now(),

  constraint provider_notification_topics_pkey primary key (connection_id, topic),
  constraint provider_notification_topics_status_valid check (
    status in ('discovered', 'subscribed', 'unavailable', 'failed', 'unsubscribed')
  ),
  constraint provider_notification_topics_subscription_recorded check (
    (status = 'subscribed') = (subscribed_at is not null)
  ),

  constraint provider_notification_topics_connection_fkey
    foreign key (business_id, connection_id)
    references connections (business_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Marketplace account deletion
--
-- Section 13 as amended by D-137. eBay registers the deletion endpoint once per
-- application, not per business, while one installation may hold that buyer's
-- data under several businesses. So a verified request fans out, and it is
-- complete only when every affected business has been processed.
--
-- The two tables exist to make a partial failure visible. A single row with a
-- status would report "done" the moment the first business succeeded, and the
-- request would be answered honestly while one business kept the data.
-- ---------------------------------------------------------------------------

create table marketplace_deletion_requests (
  id                 uuid        primary key default gen_random_uuid(),

  provider           text        not null default 'ebay',
  -- The buyer as the marketplace identifies them. Not a foreign key to
  -- anything: the request may name somebody this installation has never heard
  -- of, and that is a valid request with nothing to do.
  buyer_external_id  text        not null,
  -- eBay's own identifier for the notification, for deduplication and for the
  -- acknowledgement it expects.
  notification_id    text        not null,

  received_at        timestamptz not null default now(),
  -- Whether the notification's signature verified. An unverified one is
  -- recorded and never acted on: erasure is irreversible, and acting on an
  -- unauthenticated instruction to erase is a denial-of-service primitive.
  verified           boolean     not null default false,

  status             text        not null default 'received',
  completed_at       timestamptz,

  constraint marketplace_deletion_requests_status_valid check (
    status in ('received', 'processing', 'completed', 'partially_failed', 'rejected')
  ),
  constraint marketplace_deletion_requests_completion_recorded check (
    (status in ('completed', 'partially_failed', 'rejected')) = (completed_at is not null)
  ),
  constraint marketplace_deletion_requests_unverified_not_processed check (
    verified or status in ('received', 'rejected')
  )
);

create unique index marketplace_deletion_requests_notification_unique
  on marketplace_deletion_requests (provider, notification_id);

create index marketplace_deletion_requests_buyer
  on marketplace_deletion_requests (buyer_external_id);

create table marketplace_deletion_outcomes (
  request_id    uuid        not null
    references marketplace_deletion_requests (id) on delete cascade,
  business_id   uuid        not null references businesses (id) on delete cascade,

  status        text        not null default 'pending',
  -- What was actually done, in non-identifying terms: how many orders were
  -- anonymized, not which buyer they belonged to. Section 13 requires a
  -- non-PII compliance receipt to remain after erasure, and a receipt that
  -- names the person is not one.
  summary       text,
  records_affected integer  not null default 0,

  attempted_at  timestamptz,
  completed_at  timestamptz,

  constraint marketplace_deletion_outcomes_pkey primary key (request_id, business_id),
  constraint marketplace_deletion_outcomes_status_valid check (
    status in ('pending', 'completed', 'failed', 'nothing_to_erase')
  ),
  constraint marketplace_deletion_outcomes_records_nonnegative check (records_affected >= 0)
);

-- ---------------------------------------------------------------------------
-- Timestamp maintenance
-- ---------------------------------------------------------------------------

create trigger provider_notification_topics_touch
  before update on provider_notification_topics
  for each row execute function eim_touch_updated_at();
