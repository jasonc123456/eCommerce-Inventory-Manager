-- 0001_foundation
--
-- The tenancy and inventory core (section 17). This is milestone M0's slice: the
-- tables everything else hangs off, plus one worked example of every constraint
-- technique section 17 requires, so that the patterns are established and tested
-- before the remaining entity families arrive in M1.
--
-- The techniques demonstrated here, and where to find each:
--
--   opaque UUID primary keys                every table
--   business_id on every business-owned row locations, canonical_items, ...
--   composite foreign keys                  location_balances, inventory_ledger
--   scoped partial unique constraints       every soft-deletable natural key
--   CHECK constraints on quantities         location_balances
--   append-only enforcement                 inventory_ledger
--   narrowly justified triggers             updated_at, final owner, append-only
--   partial and BRIN indexes                the index block at the end
--
-- Migrations are forward-only and hand-written. Nothing here is generated, and
-- nothing here may be edited once it has been applied to a real installation:
-- the runner records a checksum and refuses to proceed if a file changes.

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

-- Section 17 forbids hiding business workflows in triggers but permits narrowly
-- justified integrity and metadata tasks. Maintaining updated_at is the
-- canonical metadata task: doing it in application code means every future
-- writer, including a psql session during an incident, has to remember.
create or replace function eim_touch_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Identity and tenancy
-- ---------------------------------------------------------------------------

-- Users are installation-level identities, not business-level ones. The same
-- person operating three businesses is one row here with three memberships.
create table users (
  id            uuid primary key default gen_random_uuid(),
  email         text        not null,
  display_name  text,
  status        text        not null default 'active',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,

  constraint users_status_valid check (status in ('active', 'suspended', 'deleted')),
  constraint users_email_shaped check (email like '%@%' and length(email) between 3 and 320)
);

-- Addresses are compared case-insensitively, and the uniqueness applies only to
-- live rows: section 17 soft-deletes ordinary users so history keeps a stable
-- reference, which means a deleted address must not block re-registration.
create unique index users_email_unique on users (lower(email)) where deleted_at is null;

create table businesses (
  id          uuid primary key default gen_random_uuid(),
  name        text        not null,
  slug        text        not null,
  -- D-136. Quiet hours and the nightly reconciliation window are business-level
  -- concepts, and before this amendment only locations carried a timezone, so
  -- there was no defensible answer for a business whose locations disagree.
  timezone    text        not null default 'UTC',
  status      text        not null default 'active',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,

  constraint businesses_status_valid check (status in ('active', 'suspended', 'deleted')),
  constraint businesses_slug_shaped check (slug ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'),
  constraint businesses_name_present check (length(btrim(name)) > 0)
);

create unique index businesses_slug_unique on businesses (slug) where deleted_at is null;

create table memberships (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid        not null references businesses (id) on delete cascade,
  user_id      uuid        not null references users (id) on delete restrict,
  role         text        not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint memberships_role_valid check (role in ('owner', 'manager', 'operator', 'viewer')),
  constraint memberships_unique_per_user unique (business_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Catalog and locations
-- ---------------------------------------------------------------------------

create table locations (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid        not null references businesses (id) on delete cascade,
  code         text        not null,
  name         text        not null,
  -- Locations keep their own timezone. A business in one country may hold stock
  -- in a warehouse in another, and cut-off times follow the stock.
  timezone     text        not null default 'UTC',
  is_active    boolean     not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,

  constraint locations_code_shaped check (length(btrim(code)) between 1 and 64),

  -- Redundant against the primary key on its own, and that is the point: it is
  -- the target a composite foreign key needs in order to carry business_id
  -- along with the row reference.
  constraint locations_business_scoped unique (business_id, id)
);

create unique index locations_code_unique
  on locations (business_id, lower(code))
  where deleted_at is null;

-- The canonical item is the unit of truth for stock. Channel listings and store
-- products project from it; it never projects from them.
create table canonical_items (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid        not null references businesses (id) on delete cascade,
  sku          text        not null,
  name         text        not null,
  is_active    boolean     not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,

  constraint canonical_items_sku_shaped check (length(btrim(sku)) between 1 and 128),
  constraint canonical_items_business_scoped unique (business_id, id)
);

create unique index canonical_items_sku_unique
  on canonical_items (business_id, lower(sku))
  where deleted_at is null;

-- ---------------------------------------------------------------------------
-- Inventory
-- ---------------------------------------------------------------------------

-- Materialized current balances, updated transactionally alongside the ledger.
-- The ledger is the record of what happened; this table is the answer to "how
-- many are there now" without replaying it.
create table location_balances (
  business_id       uuid    not null,
  canonical_item_id uuid    not null,
  location_id       uuid    not null,
  on_hand           integer not null default 0,
  reserved          integer not null default 0,
  -- Section 9: safety stock is withheld per location and only then summed
  -- (D-132). Storing it per location is what makes that possible.
  safety_stock      integer not null default 0,
  updated_at        timestamptz not null default now(),

  constraint location_balances_pkey primary key (business_id, canonical_item_id, location_id),

  -- Section 17: composite foreign keys prevent a cross-business relationship
  -- even if application authorization fails. Referencing (business_id, id)
  -- rather than (id) means a row can only ever point at an item and a location
  -- belonging to its own business; there is no code path that can violate it.
  constraint location_balances_item_fkey
    foreign key (business_id, canonical_item_id)
    references canonical_items (business_id, id) on delete cascade,
  constraint location_balances_location_fkey
    foreign key (business_id, location_id)
    references locations (business_id, id) on delete cascade,

  -- Section 8: availability is never negative, and a shortage is recorded as
  -- its own quantity rather than as negative stock.
  constraint location_balances_on_hand_nonnegative check (on_hand >= 0),
  constraint location_balances_reserved_nonnegative check (reserved >= 0),
  constraint location_balances_safety_stock_nonnegative check (safety_stock >= 0),
  -- Reserving more than exists is the oversell this system exists to prevent.
  constraint location_balances_reserved_within_on_hand check (reserved <= on_hand)
);

-- Append-only canonical ledger. Section 17: a committed inventory event is
-- never edited or deleted to correct stock; a linked reversal is appended
-- instead, so the history of a discrepancy survives its correction.
create table inventory_ledger (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid        not null,
  canonical_item_id uuid        not null,
  location_id       uuid        not null,
  occurred_at       timestamptz not null default now(),
  recorded_at       timestamptz not null default now(),
  kind              text        not null,
  quantity_delta    integer     not null,
  -- Set when this entry reverses an earlier one. Section 17 requires the link,
  -- so that a correction can be explained rather than merely observed.
  reversal_of_id    uuid references inventory_ledger (id) on delete restrict,
  actor_user_id     uuid references users (id) on delete set null,
  reason            text,
  correlation_id    uuid,

  constraint inventory_ledger_kind_valid check (
    kind in ('receipt', 'shipment', 'adjustment', 'transfer_in', 'transfer_out', 'reversal', 'reconciliation')
  ),
  -- A zero-delta entry records nothing and would only dilute the timeline.
  constraint inventory_ledger_delta_nonzero check (quantity_delta <> 0),
  -- Only a reversal may name the entry it reverses, and no entry may reverse
  -- itself.
  constraint inventory_ledger_reversal_consistent check (
    (kind = 'reversal') = (reversal_of_id is not null)
  ),
  constraint inventory_ledger_not_self_reversing check (reversal_of_id is distinct from id),

  constraint inventory_ledger_item_fkey
    foreign key (business_id, canonical_item_id)
    references canonical_items (business_id, id) on delete restrict,
  constraint inventory_ledger_location_fkey
    foreign key (business_id, location_id)
    references locations (business_id, id) on delete restrict
);

-- ---------------------------------------------------------------------------
-- Integrity triggers
--
-- Section 17 permits triggers for narrowly justified integrity and metadata
-- tasks and forbids them for business workflow. Each of the three below is
-- an invariant that must hold no matter which client is connected, including a
-- psql session opened during an incident, which is exactly the case application
-- code cannot cover.
-- ---------------------------------------------------------------------------

create trigger users_touch_updated_at
  before update on users
  for each row execute function eim_touch_updated_at();

create trigger businesses_touch_updated_at
  before update on businesses
  for each row execute function eim_touch_updated_at();

create trigger memberships_touch_updated_at
  before update on memberships
  for each row execute function eim_touch_updated_at();

create trigger locations_touch_updated_at
  before update on locations
  for each row execute function eim_touch_updated_at();

create trigger canonical_items_touch_updated_at
  before update on canonical_items
  for each row execute function eim_touch_updated_at();

create trigger location_balances_touch_updated_at
  before update on location_balances
  for each row execute function eim_touch_updated_at();

-- Append-only enforcement. Section 17's rule is about correctness of the audit
-- trail, so it cannot be a convention: a stock correction applied with an UPDATE
-- would leave no evidence that the original figure ever existed.
create or replace function eim_inventory_ledger_is_append_only() returns trigger
language plpgsql
as $$
begin
  raise exception
    'inventory_ledger is append-only; append a linked reversal entry instead of %ing it',
    lower(tg_op)
    using errcode = 'restrict_violation';
end;
$$;

create trigger inventory_ledger_append_only
  before update or delete on inventory_ledger
  for each row execute function eim_inventory_ledger_is_append_only();

-- Final-owner protection. Section 17 lists this among the invariants the
-- database must enforce, because losing the last owner locks a business out of
-- its own settings with no in-application way back in.
--
-- A constraint trigger deferred to commit is what makes a legitimate ownership
-- handover possible: promoting the new owner and demoting the old one inside
-- one transaction passes, while either half alone fails.
create or replace function eim_business_retains_an_owner() returns trigger
language plpgsql
as $$
declare
  affected_business uuid := coalesce(new.business_id, old.business_id);
  owner_count integer;
begin
  -- A business being deleted has no owners to protect.
  if not exists (
    select 1 from businesses
    where id = affected_business and deleted_at is null
  ) then
    return null;
  end if;

  select count(*) into owner_count
  from memberships
  where business_id = affected_business and role = 'owner';

  if owner_count = 0 then
    raise exception 'business % must retain at least one owner', affected_business
      using errcode = 'restrict_violation';
  end if;

  return null;
end;
$$;

create constraint trigger memberships_retain_owner
  after update or delete on memberships
  deferrable initially deferred
  for each row execute function eim_business_retains_an_owner();

-- ---------------------------------------------------------------------------
-- Indexes
--
-- Section 17: build indexes from documented query paths, use partial indexes
-- for the narrow hot sets, and do not index every field speculatively. Each
-- index below names the query it serves.
-- ---------------------------------------------------------------------------

-- "Which businesses does this user belong to", on every authenticated request.
create index memberships_user_idx on memberships (user_id);

-- "Who are this business's owners", used by the invariant above and by the
-- notification routing in section 22. Partial, because owners are a small
-- fraction of memberships and the other roles never take this path.
create index memberships_owner_idx on memberships (business_id) where role = 'owner';

-- "List the active locations and items for this business", the catalog and
-- mapping screens. Partial, because soft-deleted rows are never listed.
create index locations_active_idx on locations (business_id) where deleted_at is null and is_active;
create index canonical_items_active_idx
  on canonical_items (business_id)
  where deleted_at is null and is_active;

-- "Show this item's inventory timeline", newest first. Business-scoped and
-- composite, matching the access path exactly.
create index inventory_ledger_item_timeline_idx
  on inventory_ledger (business_id, canonical_item_id, occurred_at desc);

-- Section 17 suggests BRIN for sufficiently large append-only chronological
-- tables. The ledger is the one table here that is certain to become that: it
-- is insert-only, physically ordered by time, and grows without bound. BRIN
-- costs a few pages where a B-tree over the same column would cost gigabytes.
-- It earns its place only at scale, which is why it is here and nowhere else.
create index inventory_ledger_recorded_at_brin
  on inventory_ledger using brin (recorded_at) with (pages_per_range = 32);

-- Reversal lookups: "has this entry already been reversed".
create index inventory_ledger_reversal_idx
  on inventory_ledger (reversal_of_id)
  where reversal_of_id is not null;
