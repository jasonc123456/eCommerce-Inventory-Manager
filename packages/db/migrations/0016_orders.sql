-- 0016_orders
--
-- Canonical orders and the idempotency record that makes ingesting them safe
-- (sections 11, 12, 15).
--
-- Section 15 requires importing "every order line for operational visibility and
-- deduplication" while reserving or consuming "only lines whose inventory
-- mappings are active and eligible". So an order row is not a claim that
-- anything happened to stock: it is the record of what a channel says was
-- bought, and each line separately records what this application did about it.
-- A line with no mapping is still stored, still visible, and still raises a
-- warning — it simply moved nothing.
--
-- Two things here are load-bearing:
--
--   `processed_events` is the deduplication boundary for the whole pipeline.
--   Section 12 wants provider event identity where a provider supplies one and a
--   normalized payload fingerprint only where it does not, and it wants a
--   replayed event to return its prior outcome rather than mutate again. Both
--   are unique indexes, because deduplication implemented as a select-then-
--   insert is deduplication with a race in it.
--
--   `provider_sequence` is what makes out-of-order delivery survivable. Section
--   12: "provider revisions/sequences take precedence over arrival order." An
--   update carrying an older sequence than the row already holds is discarded,
--   so a webhook that overtakes its predecessor cannot roll a status backwards.

create table channel_orders (
  id                  uuid        primary key default gen_random_uuid(),
  business_id         uuid        not null,
  connection_id       uuid        not null,

  external_order_id   text        not null,
  -- The provider's own word for the state, kept verbatim for the timeline.
  provider_status     text,

  -- awaiting   nothing is committed yet: a cart, an unpaid order
  -- committed  a qualifying order; mapped lines have reserved or consumed
  -- fulfilled  shipped or otherwise handed over
  -- cancelled  ended before shipment
  -- refunded   money returned; says nothing about physical goods (section 11)
  demand_state        text        not null default 'awaiting',

  placed_at           timestamptz,
  -- When this order first qualified. Section 11 commits inventory once, on the
  -- first qualifying transition, not on every subsequent update that still
  -- qualifies.
  first_committed_at  timestamptz,

  -- Section 12: provider revisions take precedence over arrival order.
  provider_revision   text,
  provider_sequence   bigint,

  currency            text,
  total_amount        numeric(18, 4),

  -- A pseudonymous handle, never a name or an address. Section 13's erasure
  -- obligations are much simpler when buyer detail was never copied here.
  buyer_reference     text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint channel_orders_demand_state_known
    check (demand_state in ('awaiting', 'committed', 'fulfilled', 'cancelled', 'refunded')),
  constraint channel_orders_unique unique (connection_id, external_order_id),
  constraint channel_orders_business_scoped unique (business_id, id),
  constraint channel_orders_connection_fkey
    foreign key (business_id, connection_id)
    references connections (business_id, id) on delete cascade
);

create index channel_orders_recent on channel_orders (business_id, placed_at desc);
create index channel_orders_by_state on channel_orders (business_id, demand_state, updated_at);

create trigger channel_orders_touch_updated_at
  before update on channel_orders
  for each row execute function eim_touch_updated_at();

create table channel_order_lines (
  id                  uuid        primary key default gen_random_uuid(),
  business_id         uuid        not null,
  order_id            uuid        not null,

  external_line_id    text        not null,
  -- The channel entity sold, as the provider names it. This is what a mapping
  -- is looked up by, and it is stored even when no mapping exists.
  external_item_id    text,
  variation_id        text,
  sku                 text,
  title               text,

  quantity            integer     not null,
  -- Per-line lifecycle. Section 11 processes "partial order increases,
  -- decreases, shipments, cancellations, refunds, and restocks per line and
  -- quantity", which a single order-level status cannot express.
  cancelled_quantity  integer     not null default 0,
  shipped_quantity    integer     not null default 0,
  refunded_quantity   integer     not null default 0,

  -- What this application did about the line, which is not the same as what the
  -- channel did about it.
  --
  -- untreated   not yet considered; the order has not qualified
  -- reserved    units committed under `reserve until fulfilled`
  -- consumed    units taken off hand immediately
  -- unmapped    no mapping exists for this channel entity
  -- ineligible  a mapping exists but may not move stock right now
  -- released    committed units were given back before shipment
  treatment           text        not null default 'untreated',
  treatment_reason    text,

  mapping_id          uuid,
  canonical_item_id   uuid,
  reservation_id      uuid        references stock_reservations (id) on delete set null,

  -- Section 11: "record the shortage quantity explicitly" rather than allowing
  -- a balance to go negative or cancelling a customer's order.
  shortage            integer     not null default 0,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint channel_order_lines_quantity_positive check (quantity >= 1),
  constraint channel_order_lines_shortage_bounded
    check (shortage >= 0 and shortage <= quantity),
  constraint channel_order_lines_treatment_known
    check (treatment in ('untreated', 'reserved', 'consumed', 'unmapped', 'ineligible', 'released')),
  constraint channel_order_lines_unique unique (order_id, external_line_id),
  constraint channel_order_lines_order_fkey
    foreign key (business_id, order_id)
    references channel_orders (business_id, id) on delete cascade,
  constraint channel_order_lines_item_fkey
    foreign key (business_id, canonical_item_id)
    references canonical_items (business_id, id) on delete restrict,
  constraint channel_order_lines_mapping_fkey
    foreign key (business_id, mapping_id)
    references channel_mappings (business_id, id) on delete set null
);

create index channel_order_lines_by_order on channel_order_lines (order_id);
create index channel_order_lines_needing_attention
  on channel_order_lines (business_id, treatment)
  where treatment in ('unmapped', 'ineligible') or shortage > 0;

create trigger channel_order_lines_touch_updated_at
  before update on channel_order_lines
  for each row execute function eim_touch_updated_at();

-- The deduplication boundary for every inbound signal.
--
-- One row per event this application has finished processing, holding the
-- outcome it produced. Section 12: "replayed events return prior outcomes
-- without additional mutation" — which requires storing the outcome, not merely
-- the fact of having seen the event.
create table processed_events (
  id                  uuid        primary key default gen_random_uuid(),
  business_id         uuid,
  connection_id       uuid        not null,
  provider            text        not null,

  -- webhook | poll | verification | manual | reconciliation. Recorded for the
  -- timeline, never for deduplication: section 15 routes every trigger through
  -- one pipeline, so the same event arriving twice by two routes is still one
  -- event and must deduplicate against itself.
  source              text        not null,
  event_type          text        not null,

  resource_type       text,
  resource_id         text,

  -- The provider's own event identifier, where it supplies one.
  external_event_id   text,
  -- The provider's revision or sequence for the resource, where it supplies one.
  revision            text,
  -- A hash of the normalized payload. Section 12 allows this only as a fallback
  -- when no provider event id exists, because two genuinely distinct events can
  -- normalize to the same bytes and collapsing them would lose one.
  payload_fingerprint text,

  outcome             jsonb       not null default '{}',
  processed_at        timestamptz not null default now(),

  constraint processed_events_identified
    check (external_event_id is not null or payload_fingerprint is not null),
  constraint processed_events_connection_fkey
    foreign key (connection_id) references connections (id) on delete cascade
);

-- Where the provider gives an event id, that is the identity, full stop.
create unique index processed_events_by_event_id
  on processed_events (connection_id, event_type, external_event_id)
  where external_event_id is not null;

-- Where it does not, resource identity plus a payload fingerprint stands in.
create unique index processed_events_by_fingerprint
  on processed_events (connection_id, event_type, resource_id, payload_fingerprint)
  where external_event_id is null;

create index processed_events_retention on processed_events (processed_at);
