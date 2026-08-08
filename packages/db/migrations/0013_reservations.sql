-- 0013_reservations
--
-- Committed demand, and where it was taken from (sections 9, 11, 12).
--
-- Section 11 gives each business one of two consumption modes: reserve until
-- fulfilled, or consume immediately. Both are recorded here, and the mode in
-- force *at the time of the order* is stored on the reservation rather than read
-- from settings later. A business that switches mode next month must still be
-- able to cancel an order placed this month and have the right thing happen.
--
-- Allocations are the other half. Section 11 requires that "exact order
-- allocations are retained so cancellation/restock restores the same locations",
-- which rules out recomputing where the units came from at cancellation time —
-- by then priority may have changed, a location may be archived, and stock has
-- certainly moved. So each allocation row records the location and, when the
-- units were consumed rather than reserved, the ledger entry that consumed them.
--
-- A kit reservation allocates its components, never the kit: a kit has no
-- independent physical stock (section 10). The recipe version used is recorded,
-- because section 10 reverses a kit sale with the recipe that was active at
-- purchase.

create table stock_reservations (
  id                  uuid        primary key default gen_random_uuid(),
  business_id         uuid        not null,

  -- What was ordered. May be a kit, in which case the allocations name its
  -- components instead.
  canonical_item_id   uuid        not null,
  quantity            integer     not null,

  -- Where the demand came from. Kept loose deliberately: canonical orders
  -- arrive in the next milestone, and a reservation that could only be created
  -- by an order row would leave this milestone unable to test its own rules.
  connection_id       uuid        not null,
  external_order_id   text        not null,
  external_line_id    text        not null,

  -- Section 11: the mode in force when this order was taken, not the mode in
  -- force when it is cancelled.
  consumption_mode    text        not null,

  -- Section 10: reversing a kit sale uses the recipe active at purchase.
  kit_recipe_id       uuid        references kit_recipes (id) on delete restrict,

  -- open      units are committed to this demand
  -- consumed  the units have shipped and left on-hand
  -- released  cancelled before shipment; units returned to their locations
  status              text        not null default 'open',

  -- Section 11: "record the shortage quantity explicitly" rather than letting a
  -- balance go negative.
  shortage            integer     not null default 0,
  -- Section 9: no single location could fulfil and splitting is disabled, so an
  -- allocation conflict is owed. Recorded rather than raised here, because the
  -- conflict record itself belongs with reconciliation.
  split_blocked       boolean     not null default false,

  released_reason     text,
  resolved_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint stock_reservations_quantity_positive check (quantity >= 1),
  constraint stock_reservations_shortage_bounded check (shortage between 0 and quantity),
  constraint stock_reservations_mode_valid check (
    consumption_mode in ('reserve_until_fulfilled', 'consume_immediately')
  ),
  constraint stock_reservations_status_valid check (status in ('open', 'consumed', 'released')),
  constraint stock_reservations_resolution_recorded check (
    (status = 'open') = (resolved_at is null)
  ),
  -- A release an operator cannot read is stock that reappeared for no stated
  -- reason, which section 11 does not allow: releasing a stale reservation
  -- requires a reason, a preview, and a confirmation.
  constraint stock_reservations_release_explained check (
    status <> 'released' or released_reason is not null
  ),

  constraint stock_reservations_business_scoped unique (business_id, id),
  constraint stock_reservations_item_fkey
    foreign key (business_id, canonical_item_id)
    references canonical_items (business_id, id) on delete restrict,
  constraint stock_reservations_connection_fkey
    foreign key (business_id, connection_id)
    references connections (business_id, id) on delete cascade
);

-- Section 12: database uniqueness constraints enforce deduplication. One order
-- line produces one reservation, ever — including after a release, so a replayed
-- cancellation followed by a replayed order cannot reserve the units twice.
create unique index stock_reservations_line_unique
  on stock_reservations (connection_id, external_order_id, external_line_id);

create index stock_reservations_open
  on stock_reservations (business_id, canonical_item_id)
  where status = 'open';

create table reservation_allocations (
  id                uuid        primary key default gen_random_uuid(),
  business_id       uuid        not null,
  reservation_id    uuid        not null,

  -- The stocked item actually taken: the ordered item, or a kit component.
  canonical_item_id uuid        not null,
  location_id       uuid        not null,
  quantity          integer     not null,

  -- Set when the units were consumed immediately rather than reserved. A
  -- cancellation reverses this entry rather than inventing a compensating
  -- receipt, so the timeline reads as one event corrected rather than two
  -- unrelated movements.
  ledger_entry_id   uuid        references inventory_ledger (id) on delete restrict,

  created_at        timestamptz not null default now(),

  constraint reservation_allocations_quantity_positive check (quantity >= 1),
  constraint reservation_allocations_unique
    unique (reservation_id, canonical_item_id, location_id),

  constraint reservation_allocations_reservation_fkey
    foreign key (business_id, reservation_id)
    references stock_reservations (business_id, id) on delete cascade,
  constraint reservation_allocations_item_fkey
    foreign key (business_id, canonical_item_id)
    references canonical_items (business_id, id) on delete restrict,
  constraint reservation_allocations_location_fkey
    foreign key (business_id, location_id)
    references locations (business_id, id) on delete restrict
);

create index reservation_allocations_by_item
  on reservation_allocations (business_id, canonical_item_id, location_id);

create trigger stock_reservations_touch_updated_at
  before update on stock_reservations
  for each row execute function eim_touch_updated_at();
