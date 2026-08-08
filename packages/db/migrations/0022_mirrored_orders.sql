-- 0022_mirrored_orders
--
-- Orders this application created on a channel, rather than observed (section 11).
--
-- There is exactly one of these in version 1: the optional, manually triggered
-- copy of an eBay order into a WooCommerce store. Section 11 grants it in one
-- paragraph and then spends most of that paragraph on the danger, which is what
-- this table exists to defuse: "all resulting WooCommerce events/stock changes
-- are mirror projections and cannot create another canonical sale."
--
-- The problem is real and entirely ordinary. A copied order lands in a store
-- this application is also synchronizing. WooCommerce announces it by webhook
-- like any other order; the order pipeline fetches it, finds mapped lines, and
-- would commit inventory for a sale that the original eBay order already
-- committed. The customer bought one unit and the ledger would record two.
--
-- So every copy is recorded here before it is created, and the order pipeline
-- checks this table before committing demand. The order is still imported in
-- full — an operator looking at the store's orders should see it, with its
-- lines, exactly as they would any other — but it moves no stock, because the
-- stock already moved when eBay sold it.
--
-- The row is keyed by the destination order, because that is what the pipeline
-- has in its hand when it needs the answer. The source is carried alongside so
-- the two halves of one sale can be read together.

create table mirrored_orders (
  id                  uuid        primary key default gen_random_uuid(),
  business_id         uuid        not null references businesses (id) on delete cascade,

  -- Where the sale actually happened.
  source_connection_id uuid       not null,
  source_external_order_id text   not null,

  -- Where the copy was written.
  destination_connection_id uuid  not null,
  -- Null between reserving the row and the provider answering. A copy that
  -- failed halfway leaves a row naming no destination order, which is honest:
  -- it says an attempt was made and did not land.
  destination_external_order_id text,

  -- The reviewed operation that authorized this. Section 11 has no automatic
  -- copying, so a mirror with no operation behind it should be impossible, and
  -- the column is not null to keep it that way.
  operation_id        uuid        not null references reviewed_operations (id) on delete restrict,

  -- What was done about WooCommerce's own stock reduction, recorded as a fact
  -- rather than assumed from the version. Section 11 requires the copy action
  -- to suppress it rather than "relying on later reconciliation to paper over
  -- it", and this is the evidence that it did.
  suppression_technique text      not null,
  suppression_confirmed boolean   not null default false,

  created_at          timestamptz not null default now(),
  created_by_user_id  uuid        references users (id) on delete set null,

  constraint mirrored_orders_business_fkey
    foreign key (business_id) references businesses (id) on delete cascade
);

-- One mirror per destination order. This is the lookup the order pipeline makes
-- on every ingest, so it is a unique index rather than a plain one: it answers
-- the question and enforces the answer at the same time.
create unique index mirrored_orders_by_destination
  on mirrored_orders (destination_connection_id, destination_external_order_id)
  where destination_external_order_id is not null;

-- One copy per source order per store. Section 11 has no automatic copying and
-- no fuzzy detection of copies made outside the application; what it can do is
-- refuse to make the same copy twice itself.
create unique index mirrored_orders_by_source
  on mirrored_orders (source_connection_id, source_external_order_id, destination_connection_id);
