-- 0010_inventory_settings
--
-- Where stock physically sits, and how much of it is withheld (sections 8, 9).
--
-- The foundation migration created `locations`, `canonical_items`, and
-- `location_balances` with the columns the availability calculation needs.
-- Section 9 asks for more than the calculation does: a location is a real pool
-- with a description, an allocation priority, an optional ship-from and return
-- address, and an explicit link to the merchant location identifier a provider
-- knows it by. None of that changes a quantity, which is why it was not needed
-- earlier and why it is all additive now.
--
-- The substantive change is to safety stock. Section 8 states three things that
-- the single `location_balances.safety_stock` column cannot hold at once: the
-- business default is one unit, a per-item override is allowed *including zero*,
-- and the withheld figure is subtracted per location. A `not null default 0`
-- column cannot distinguish "this location withholds nothing" from "this
-- location has not been told what to withhold" — and under a business default of
-- one, those two mean different numbers. So the column becomes nullable, null
-- meaning inherit, and the two levels it inherits from get somewhere to live.
--
-- Making it nullable is an expand: every existing row keeps its explicit value,
-- and an explicit 0 stays an explicit 0, which section 8 permits as a deliberate
-- override rather than reading as an absent one.

-- ---------------------------------------------------------------------------
-- Business inventory settings
-- ---------------------------------------------------------------------------

-- One row per business. Separate from `businesses` because these are operating
-- policy an owner changes, not identity: a mode switch here needs an impact
-- preview (section 11) while renaming a business does not.
create table business_inventory_settings (
  business_id            uuid        primary key references businesses (id) on delete cascade,

  -- Section 8: "Default business safety stock is one unit."
  default_safety_stock   integer     not null default 1,

  -- Section 11: each business chooses one consumption mode. Switching requires
  -- an impact preview and either no open reservations or a confirmed migration,
  -- which is enforced in the service rather than here — the database cannot see
  -- whether a human was shown a preview.
  consumption_mode       text        not null default 'reserve_until_fulfilled',

  -- Section 9: splitting one order across locations requires an enabled business
  -- setting. Off by default, because a split shipment costs real money that the
  -- operator has not agreed to.
  split_fulfillment      boolean     not null default false,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint business_inventory_settings_mode_valid check (
    consumption_mode in ('reserve_until_fulfilled', 'consume_immediately')
  ),
  constraint business_inventory_settings_default_safety_nonnegative check (
    default_safety_stock >= 0
  )
);

-- ---------------------------------------------------------------------------
-- Locations
-- ---------------------------------------------------------------------------

alter table locations
  add column description text,

  -- Section 9: "Sales use configured location priority and prefer a single
  -- location." Lower sorts first. Ties break by code, so allocation is
  -- deterministic even before an operator has ranked anything.
  add column priority integer not null default 100,

  add constraint locations_priority_bounded check (priority between 0 and 10000),
  add constraint locations_description_bounded check (
    description is null or length(description) <= 2000
  );

-- Allocation reads this on every sale: active locations of one business in
-- priority order.
create index locations_priority_idx
  on locations (business_id, priority, code)
  where deleted_at is null and is_active;

-- Section 9: "A full address is optional for inventory but required for label
-- purchase from that location." A separate table rather than columns on
-- `locations`, because there are two of them — where a parcel ships from and
-- where a return goes back to — and they are frequently not the same place.
create table location_addresses (
  id            uuid        primary key default gen_random_uuid(),
  business_id   uuid        not null,
  location_id   uuid        not null,
  purpose       text        not null,

  name          text,
  company       text,
  line1         text        not null,
  line2         text,
  city          text        not null,
  region        text,
  postal_code   text,
  country_code  text        not null,
  phone         text,
  email         text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint location_addresses_purpose_valid check (purpose in ('ship_from', 'return')),
  constraint location_addresses_country_shaped check (country_code ~ '^[A-Z]{2}$'),
  constraint location_addresses_line1_present check (length(btrim(line1)) > 0),
  constraint location_addresses_city_present check (length(btrim(city)) > 0),

  constraint location_addresses_location_fkey
    foreign key (business_id, location_id)
    references locations (business_id, id) on delete cascade
);

-- One ship-from and one return address per location. A second of either is an
-- ambiguity a label purchase would have to guess at.
create unique index location_addresses_unique
  on location_addresses (location_id, purpose);

-- Section 9: "Internal locations map explicitly to eBay merchant location
-- identifiers." Explicitly, because inferring the link from a name match would
-- put stock in the wrong warehouse the first time two warehouses were named
-- alike. Per connection, since the same physical shelf is a different identifier
-- to each account it is registered with.
create table location_channel_links (
  id                   uuid        primary key default gen_random_uuid(),
  business_id          uuid        not null,
  location_id          uuid        not null,
  connection_id        uuid        not null,
  -- The provider's own key for this place: an eBay merchant location key, or a
  -- WooCommerce multi-inventory location where one exists.
  external_location_id text        not null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint location_channel_links_external_shaped check (
    length(btrim(external_location_id)) between 1 and 128
  ),

  constraint location_channel_links_location_fkey
    foreign key (business_id, location_id)
    references locations (business_id, id) on delete cascade,
  constraint location_channel_links_connection_fkey
    foreign key (business_id, connection_id)
    references connections (business_id, id) on delete cascade
);

-- A connection's identifier names one internal location, and one internal
-- location has one identifier at a connection. Both directions matter: the first
-- stops two shelves claiming the same remote pool, the second stops one shelf
-- writing to two.
create unique index location_channel_links_external_unique
  on location_channel_links (connection_id, external_location_id);
create unique index location_channel_links_location_unique
  on location_channel_links (connection_id, location_id);

-- ---------------------------------------------------------------------------
-- Canonical items
-- ---------------------------------------------------------------------------

alter table canonical_items
  -- Section 8: a per-item override of safety stock, including zero, reduces the
  -- shared pool for every channel. Null inherits the business default; a stored
  -- 0 is a decision to withhold nothing.
  add column safety_stock_override integer,

  add column description text,

  add constraint canonical_items_safety_override_nonnegative check (
    safety_stock_override is null or safety_stock_override >= 0
  ),
  add constraint canonical_items_description_bounded check (
    description is null or length(description) <= 4000
  );

-- ---------------------------------------------------------------------------
-- Location balances
-- ---------------------------------------------------------------------------

alter table location_balances
  -- Null now means "inherit", which is what most rows want and what the column
  -- previously had no way to say. See the header.
  alter column safety_stock drop not null,
  alter column safety_stock drop default;

alter table location_balances
  -- Section 9: "Item-location records may include a bin, shelf, or storage
  -- note." Free text on purpose — version 1 does not model a warehouse hierarchy
  -- and should not pretend to by parsing these.
  add column bin  text,
  add column note text,

  add constraint location_balances_bin_bounded check (bin is null or length(bin) <= 64),
  add constraint location_balances_note_bounded check (note is null or length(note) <= 1000);

-- ---------------------------------------------------------------------------
-- Metadata triggers
-- ---------------------------------------------------------------------------

create trigger business_inventory_settings_touch_updated_at
  before update on business_inventory_settings
  for each row execute function eim_touch_updated_at();

create trigger location_addresses_touch_updated_at
  before update on location_addresses
  for each row execute function eim_touch_updated_at();

create trigger location_channel_links_touch_updated_at
  before update on location_channel_links
  for each row execute function eim_touch_updated_at();
