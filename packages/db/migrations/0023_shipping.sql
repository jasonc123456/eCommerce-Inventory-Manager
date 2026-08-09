-- 0023_shipping
--
-- Packages, rates, labels, and tracking (sections 2, 9, 13, 14, 21, 33, 34).
--
-- Milestone 6 adds the one thing in this application that spends a business's
-- money at a third party. Everything below is shaped by that sentence.
--
-- The order of the tables is the order of the workflow, and each step is a
-- separate row because each step is separately reversible or separately
-- refusable. A package is built from order lines that have not shipped yet. It
-- is priced, which costs nothing and can be done as often as anybody likes. One
-- of those prices is confirmed by a person, and that confirmation buys exactly
-- one label. The label may later be voided, and the parcel may later be marked
-- shipped — which section 14 is explicit is not the same event: "label purchase
-- does not mean shipped".
--
-- Two things are deliberately absent.
--
-- There is no table of label documents. A shipping label carries the buyer's
-- name and postal address printed onto it, and section 13's erasure obligations
-- are tractable only because section 11 avoided copying buyer detail out of the
-- provider in the first place — `channel_orders.buyer_reference` is a
-- pseudonymous handle for exactly that reason. Persisting label images would
-- undo that in the one format nobody can redact, so documents are fetched from
-- the provider for one authorized access and are never stored (D-233).
--
-- There is no schedule, for the same reason `reviewed_operations` has none. A
-- label is bought when a person looks at a price and agrees to it. Nothing in
-- here can be set to buy postage later.

-- Section 33 puts shipping in the orders family, and a package belongs to the
-- lines of one order. Composite foreign keys are how every cross-business
-- reference in this schema is prevented, and the line table has no
-- business-scoped key yet because nothing had needed to point at a line before.
alter table channel_order_lines
  add constraint channel_order_lines_business_scoped unique (business_id, id);

-- One business's account with one shipping provider.
--
-- Not a row in `connections`. A connection is a channel: it has listings,
-- orders, quantities, mappings, webhooks, cursors, and quota windows, and every
-- one of those is meaningless for a company that sells postage. Widening the
-- provider enum would have made every channel-shaped query answer carefully for
-- a row that can never take part in synchronization at all.
create table shipping_accounts (
  id                  uuid        primary key default gen_random_uuid(),
  business_id         uuid        not null references businesses (id) on delete cascade,

  -- easypost | easyship
  provider            text        not null,
  -- sandbox | production
  environment         text        not null,
  display_name        text        not null,

  -- pending | active | paused | disconnected
  status              text        not null default 'pending',

  -- What the provider says it will do: voids, asynchronous refunds, tracking,
  -- rate expiry, document kinds. Recorded rather than assumed, because section
  -- 2 says "supported void/refund actions" and a screen must not offer a button
  -- this account cannot honour. Verification V-04 is what fills this in
  -- honestly; until it runs, an adapter reports what it can prove.
  capabilities        jsonb       not null default '{}',

  -- What the provider called this account when the credential was last checked.
  account_label       text,
  last_checked_at     timestamptz,
  last_failure_summary text,

  created_by_user_id  uuid        references users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint shipping_accounts_provider_known
    check (provider in ('easypost', 'easyship')),
  constraint shipping_accounts_environment_known
    check (environment in ('sandbox', 'production')),
  constraint shipping_accounts_status_known
    check (status in ('pending', 'active', 'paused', 'disconnected')),

  -- Section 34: "per-business encrypted API key", singular. One account per
  -- provider per environment, so "which key did that label go on" always has
  -- one answer.
  constraint shipping_accounts_one_per_provider
    unique (business_id, provider, environment),
  constraint shipping_accounts_business_scoped unique (business_id, id)
);

create index shipping_accounts_by_business
  on shipping_accounts (business_id, status);

-- The API key, encrypted, with the same custody rules as every other provider
-- credential (section 19).
--
-- A separate table from `connection_secrets` rather than a widened one. That
-- table's rows are keyed to a connection by foreign key; a store that could
-- point at either a connection or a shipping account would need two nullable
-- keys and a check that exactly one is set, which is a shape that permits
-- neither to be enforced properly and reads as an accident to whoever finds it.
create table shipping_account_secrets (
  id                  uuid        primary key default gen_random_uuid(),
  business_id         uuid        not null,
  account_id          uuid        not null,

  -- easypost_api_key | easyship_api_key
  secret_type         text        not null,
  ciphertext          text        not null,
  key_version         integer     not null,

  created_at          timestamptz not null default now(),
  retired_at          timestamptz,

  constraint shipping_account_secrets_type_known
    check (secret_type in ('easypost_api_key', 'easyship_api_key')),
  constraint shipping_account_secrets_account_fkey
    foreign key (business_id, account_id)
    references shipping_accounts (business_id, id) on delete cascade
);

-- One live credential of each kind per account. A rotation writes the
-- replacement and retires what it replaced in one transaction, so an
-- interrupted rotation leaves a working key rather than none.
create unique index shipping_account_secrets_one_live
  on shipping_account_secrets (account_id, secret_type)
  where retired_at is null;

create index shipping_account_secrets_key_version
  on shipping_account_secrets (key_version);

-- A parcel being prepared, or one that has gone.
--
-- Partial shipments are ordinary (section 14: "the application supports partial
-- shipments"), so an order has as many packages as it needs and each names the
-- location it ships from. Section 9 requires that location to have a full
-- address before a label can be bought from it; the address lives on the
-- location and is checked at quote time rather than copied here, so a corrected
-- address corrects the next label rather than leaving a stale copy behind.
create table shipment_packages (
  id                  uuid        primary key default gen_random_uuid(),
  business_id         uuid        not null references businesses (id) on delete cascade,
  order_id            uuid        not null,
  location_id         uuid        not null,

  -- draft | labelled | shipped | cancelled
  --
  -- `labelled` and `shipped` are separate states because section 14 says
  -- plainly that buying a label is not shipping: "a user explicitly marks each
  -- package shipped". Collapsing them would tell a customer their parcel is on
  -- its way while it is still on the bench.
  status              text        not null default 'draft',

  weight_grams        integer     not null,
  length_mm           integer,
  width_mm            integer,
  height_mm           integer,

  -- For carriers that price insurance from the contents' value.
  declared_value_amount   numeric(18, 4),
  declared_value_currency text,

  reference           text,
  notes               text,

  created_by_user_id  uuid        references users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  shipped_at          timestamptz,
  shipped_by_user_id  uuid        references users (id) on delete set null,
  cancelled_at        timestamptz,

  constraint shipment_packages_status_known
    check (status in ('draft', 'labelled', 'shipped', 'cancelled')),
  constraint shipment_packages_weight_positive
    check (weight_grams > 0),
  constraint shipment_packages_dimensions_positive
    check (
      (length_mm is null or length_mm > 0)
      and (width_mm is null or width_mm > 0)
      and (height_mm is null or height_mm > 0)
    ),
  constraint shipment_packages_declared_value_complete
    check (
      (declared_value_amount is null) = (declared_value_currency is null)
    ),
  -- A shipped package says when, and by whom. Section 14 makes marking shipped
  -- a person's act, and a row claiming it happened with nobody attached to it
  -- is the same defect as an executed operation with no confirmer.
  constraint shipment_packages_shipped_is_recorded
    check (
      status <> 'shipped'
      or (shipped_at is not null and shipped_by_user_id is not null)
    ),

  constraint shipment_packages_order_fkey
    foreign key (business_id, order_id)
    references channel_orders (business_id, id) on delete cascade,
  constraint shipment_packages_location_fkey
    foreign key (business_id, location_id)
    references locations (business_id, id) on delete restrict,
  constraint shipment_packages_business_scoped unique (business_id, id)
);

create index shipment_packages_by_order
  on shipment_packages (business_id, order_id, created_at);

create index shipment_packages_open
  on shipment_packages (business_id, status)
  where status in ('draft', 'labelled');

-- What is in the parcel.
--
-- Quantities per order line, so a line can be split across packages and a
-- package can hold several lines. The rule that the packages of one line never
-- exceed what that line has left to ship is enforced by the service under a row
-- lock on the line, not by a constraint here: the sum spans rows, and a trigger
-- that recomputed it would have to take the same lock to be correct, leaving
-- the same rule written twice in two languages.
create table shipment_package_lines (
  id                  uuid        primary key default gen_random_uuid(),
  business_id         uuid        not null,
  package_id          uuid        not null,
  order_line_id       uuid        not null,
  quantity            integer     not null,

  created_at          timestamptz not null default now(),

  constraint shipment_package_lines_quantity_positive
    check (quantity > 0),
  -- One row per line per package. Two rows for the same line would make "how
  -- many of this are in this box" a sum rather than a fact.
  constraint shipment_package_lines_unique unique (package_id, order_line_id),
  constraint shipment_package_lines_package_fkey
    foreign key (business_id, package_id)
    references shipment_packages (business_id, id) on delete cascade,
  constraint shipment_package_lines_order_line_fkey
    foreign key (business_id, order_line_id)
    references channel_order_lines (business_id, id) on delete cascade
);

create index shipment_package_lines_by_order_line
  on shipment_package_lines (business_id, order_line_id);

-- What a provider said this parcel would cost, and when it said it.
--
-- Kept rather than recomputed at confirmation time. Section 30's US-13 requires
-- that "quote expiry/cost is shown", and a screen that re-quoted on each render
-- would show a different number every time somebody scrolled — while the
-- confirmation would then be against whichever quote happened to be current,
-- which is precisely what the reviewed-operation fingerprint exists to prevent.
create table shipment_rate_quotes (
  id                  uuid        primary key default gen_random_uuid(),
  business_id         uuid        not null,
  package_id          uuid        not null,
  account_id          uuid        not null,

  -- The provider's own shipment, which the rates belong to. A rate is not
  -- free-standing at either provider: it prices one parcel between two
  -- addresses, and buying quotes this identifier back so the purchase cannot
  -- be for a different parcel that happened to have a matching rate id.
  provider_shipment_id text       not null,

  -- Every rate offered, exactly as quoted. The confirmation screen shows this
  -- list; the fingerprint covers the one being bought.
  rates               jsonb       not null,

  quoted_at           timestamptz not null,
  -- The provider's own deadline, where it publishes one. Null means the
  -- provider does not expire quotes and only the review window applies.
  provider_expires_at timestamptz,

  requested_by_user_id uuid       references users (id) on delete set null,
  created_at          timestamptz not null default now(),

  constraint shipment_rate_quotes_package_fkey
    foreign key (business_id, package_id)
    references shipment_packages (business_id, id) on delete cascade,
  constraint shipment_rate_quotes_account_fkey
    foreign key (business_id, account_id)
    references shipping_accounts (business_id, id) on delete cascade,
  constraint shipment_rate_quotes_business_scoped unique (business_id, id)
);

create index shipment_rate_quotes_recent
  on shipment_rate_quotes (business_id, package_id, quoted_at desc);

-- The label that was bought, and what happened to it afterwards.
--
-- `operation_id` is not null and references `reviewed_operations`, which makes a
-- label with no confirmation behind it literally unstorable. Section 21 requires
-- "purchase label after cost confirmation" and section 30's US-13 that the
-- purchase be "confirmed and idempotent"; this column is the half of that the
-- database can enforce by itself.
create table shipment_labels (
  id                  uuid        primary key default gen_random_uuid(),
  business_id         uuid        not null,
  package_id          uuid        not null,
  account_id          uuid        not null,
  quote_id            uuid        not null,
  operation_id        uuid        not null references reviewed_operations (id) on delete restrict,

  provider_label_id   text        not null,
  provider_shipment_id text       not null,
  rate_id             text        not null,

  carrier             text        not null,
  service             text        not null,
  tracking_number     text        not null,

  -- What was actually charged. Compared against what was confirmed before the
  -- row is written: a provider that repriced between the quote and the click
  -- has sold something nobody agreed to, and the purchase fails rather than
  -- being recorded at the new price.
  amount              numeric(18, 4) not null,
  currency            text        not null,
  purchased_at        timestamptz not null,

  -- purchased | void_requested | voided | void_refused
  --
  -- `void_requested` exists because some carriers decide a refund days later,
  -- once they have confirmed the label went unscanned. Reporting that as
  -- refunded would be a number in somebody's accounts that never arrives.
  state               text        not null default 'purchased',
  refund_amount       numeric(18, 4),
  refund_currency     text,
  void_requested_at   timestamptz,
  void_requested_by_user_id uuid  references users (id) on delete set null,
  voided_at           timestamptz,
  void_detail         text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint shipment_labels_state_known
    check (state in ('purchased', 'void_requested', 'voided', 'void_refused')),
  constraint shipment_labels_amount_not_negative
    check (amount >= 0),
  constraint shipment_labels_currency_shaped
    check (currency ~ '^[A-Z]{3}$'),
  constraint shipment_labels_refund_complete
    check ((refund_amount is null) = (refund_currency is null)),
  constraint shipment_labels_void_is_attributed
    check (
      state = 'purchased'
      or (void_requested_at is not null and void_requested_by_user_id is not null)
    ),
  constraint shipment_labels_voided_is_recorded
    check (state <> 'voided' or voided_at is not null),

  constraint shipment_labels_package_fkey
    foreign key (business_id, package_id)
    references shipment_packages (business_id, id) on delete cascade,
  constraint shipment_labels_account_fkey
    foreign key (business_id, account_id)
    references shipping_accounts (business_id, id) on delete restrict,
  constraint shipment_labels_quote_fkey
    foreign key (business_id, quote_id)
    references shipment_rate_quotes (business_id, id) on delete restrict,
  constraint shipment_labels_business_scoped unique (business_id, id)
);

-- One label per package at a time.
--
-- This is the duplicate-purchase guarantee, and it is here rather than only in
-- the service because the failure it prevents costs real money: two people
-- confirming the same package's rate at the same moment, or one person whose
-- browser retried a form post.
--
-- Only `voided` frees the package. A refund the carrier is still considering
-- leaves a label that may yet be used, and one the carrier has refused leaves a
-- label that is definitely still valid and definitely still paid for — buying a
-- second one in either case would spend money to replace postage the business
-- already owns.
create unique index shipment_labels_one_live_per_package
  on shipment_labels (business_id, package_id)
  where state in ('purchased', 'void_requested', 'void_refused');

-- The provider's own identifier, unique within the account that bought it. A
-- retry under the same idempotency key returns the same provider label, and this
-- turns "the provider replayed it" into one row rather than two.
create unique index shipment_labels_provider_unique
  on shipment_labels (account_id, provider_label_id);

create index shipment_labels_by_tracking
  on shipment_labels (business_id, tracking_number);

-- What the carrier says happened.
--
-- Deduplicated on the provider's event identifier, because tracking arrives
-- from polling and possibly from webhooks, and the same scan reported twice is
-- one event. Nothing here is inventory: section 11 already decided what a
-- shipment means for stock, and a tracking event is evidence about a parcel.
create table shipment_tracking_events (
  id                  uuid        primary key default gen_random_uuid(),
  business_id         uuid        not null,
  label_id            uuid        not null,

  provider_event_id   text        not null,
  status              text        not null,
  occurred_at         timestamptz not null,
  description         text,
  -- City and country at most. A street address here would put the buyer's
  -- location into a table that outlives the order.
  location            text,

  recorded_at         timestamptz not null default now(),

  constraint shipment_tracking_events_status_known
    check (status in (
      'pre_transit', 'in_transit', 'out_for_delivery', 'delivered',
      'available_for_pickup', 'return_to_sender', 'failure', 'unknown'
    )),
  constraint shipment_tracking_events_unique unique (label_id, provider_event_id),
  constraint shipment_tracking_events_label_fkey
    foreign key (business_id, label_id)
    references shipment_labels (business_id, id) on delete cascade
);

create index shipment_tracking_events_recent
  on shipment_tracking_events (business_id, label_id, occurred_at desc);

-- Telling the channel that the parcel has gone.
--
-- Section 13 requires eBay fulfillments carrying tracking; section 14 offers "a
-- separately confirmed customer-visible WooCommerce order note with tracking"
-- and, when every quantity has shipped, "a confirmed WooCommerce update to
-- `completed`". Each is a separate row because each is separately confirmed,
-- separately permissioned, and separately capable of failing.
--
-- The idempotency key is what stops an ambiguous timeout producing two
-- fulfillments for one parcel — section 13 asks for exactly this: "ambiguous
-- fulfillment retries first query existing fulfillments".
create table shipment_channel_pushes (
  id                  uuid        primary key default gen_random_uuid(),
  business_id         uuid        not null,
  package_id          uuid        not null,
  connection_id       uuid        not null,

  -- ebay_fulfillment | woocommerce_order_note | woocommerce_status
  kind                text        not null,
  -- pending | succeeded | failed | unsupported
  state               text        not null default 'pending',

  -- What the channel called what we created, when it created something.
  external_reference  text,
  idempotency_key     text        not null,
  attempts            integer     not null default 0,
  failure_summary     text,

  confirmed_by_user_id uuid       references users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  completed_at        timestamptz,

  constraint shipment_channel_pushes_kind_known
    check (kind in ('ebay_fulfillment', 'woocommerce_order_note', 'woocommerce_status')),
  constraint shipment_channel_pushes_state_known
    check (state in ('pending', 'succeeded', 'failed', 'unsupported')),
  constraint shipment_channel_pushes_attempts_not_negative
    check (attempts >= 0),
  constraint shipment_channel_pushes_failure_is_explained
    check (state <> 'failed' or failure_summary is not null),

  constraint shipment_channel_pushes_package_fkey
    foreign key (business_id, package_id)
    references shipment_packages (business_id, id) on delete cascade,
  constraint shipment_channel_pushes_connection_fkey
    foreign key (business_id, connection_id)
    references connections (business_id, id) on delete cascade,
  constraint shipment_channel_pushes_idempotent
    unique (business_id, idempotency_key)
);

create index shipment_channel_pushes_by_package
  on shipment_channel_pushes (business_id, package_id, created_at);

-- Buying a label is a reviewed operation.
--
-- It belongs on the same table as publishing a listing and copying a price for
-- the reason milestone 5 gave for having one table at all: the guarantees are
-- identical. Somebody with `purchase_labels`, authenticated within the step-up
-- window, agreed to one exact cost that was quoted recently enough to still be
-- honoured, and the effect happens once.
--
-- Voiding is deliberately not on this list. There is no preview whose values
-- could move underneath a confirmer — the label exists, its cost is already
-- spent, and the only question is whether the carrier will refund it. Section
-- 21's confirmation tier names "label purchase" and does not name voiding, so
-- voiding is an ordinary permissioned action with recent authentication rather
-- than a proposal somebody has to be shown first (D-236).
alter table reviewed_operations
  drop constraint reviewed_operations_kind_known;

alter table reviewed_operations
  add constraint reviewed_operations_kind_known
    check (kind in (
      'draft_create', 'draft_publish', 'price_copy', 'restock_to_live',
      'order_copy', 'label_purchase'
    ));
