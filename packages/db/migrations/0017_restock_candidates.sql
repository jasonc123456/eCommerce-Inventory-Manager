-- 0017_restock_candidates
--
-- Goods a channel says were refunded or returned, before anybody has seen them
-- (section 11, section 15).
--
-- Section 11 draws a line this table exists to hold: "shipped/fulfilled
-- inventory is not restored by cancellation or financial refund alone", and
-- "restoration occurs only from a sufficiently explicit channel restock signal
-- or authorized confirmation." A refund is a movement of money. Whether the
-- physical goods came back is a separate fact, and on most channels nobody
-- tells us — so the honest model is a candidate that waits for a human to say
-- how many units arrived and where they were put.
--
-- Nothing here touches a balance. Confirming a candidate posts an ordinary
-- ledger receipt, which is what keeps section 8's rule intact: stock never
-- changes without an entry explaining it, and "a customer was refunded" is not
-- an explanation for stock appearing on a shelf.

create table restock_candidates (
  id                  uuid        primary key default gen_random_uuid(),
  business_id         uuid        not null,
  connection_id       uuid        not null,

  order_id            uuid,
  order_line_id       uuid,

  -- What the channel says came back, which is a claim rather than an event.
  external_order_id   text        not null,
  external_line_id    text,
  canonical_item_id   uuid,

  -- refund | return | dispute | cancellation_after_shipment
  origin              text        not null,
  claimed_quantity    integer     not null,

  -- pending    waiting for somebody to confirm what physically arrived
  -- confirmed  a receipt has been posted for it
  -- declined   the goods did not come back, or were not resellable
  -- superseded a correlated restock explained it without confirmation
  status              text        not null default 'pending',

  -- Set on confirmation. The quantity is what an authorized person says
  -- arrived, which is deliberately allowed to differ from the claim: a return
  -- of three that turns up as two damaged and one saleable is ordinary.
  confirmed_quantity  integer,
  confirmed_location_id uuid,
  confirmed_by_user_id  uuid references users (id) on delete set null,
  confirmed_at        timestamptz,
  -- The ledger entry the confirmation produced, so the timeline joins up.
  ledger_entry_id     uuid        references inventory_ledger (id) on delete restrict,

  reason              text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint restock_candidates_origin_known
    check (origin in ('refund', 'return', 'dispute', 'cancellation_after_shipment')),
  constraint restock_candidates_status_known
    check (status in ('pending', 'confirmed', 'declined', 'superseded')),
  constraint restock_candidates_claim_positive check (claimed_quantity >= 1),
  constraint restock_candidates_confirmed_not_negative
    check (confirmed_quantity is null or confirmed_quantity >= 0),
  -- A confirmed candidate has a quantity and a place. Without both, "confirmed"
  -- would mean something different in each row that carried it.
  constraint restock_candidates_confirmation_complete
    check (
      status <> 'confirmed'
      or (confirmed_quantity is not null and confirmed_location_id is not null)
    ),

  -- One candidate per line per origin. A provider that redelivers a refund
  -- notification must not accumulate a queue of identical decisions.
  constraint restock_candidates_unique
    unique (connection_id, external_order_id, external_line_id, origin),

  constraint restock_candidates_connection_fkey
    foreign key (business_id, connection_id)
    references connections (business_id, id) on delete cascade,
  constraint restock_candidates_item_fkey
    foreign key (business_id, canonical_item_id)
    references canonical_items (business_id, id) on delete restrict,
  constraint restock_candidates_location_fkey
    foreign key (business_id, confirmed_location_id)
    references locations (business_id, id) on delete restrict
);

create index restock_candidates_pending
  on restock_candidates (business_id, created_at)
  where status = 'pending';

create trigger restock_candidates_touch_updated_at
  before update on restock_candidates
  for each row execute function eim_touch_updated_at();
