-- 0011_channel_mappings
--
-- What a canonical item is sold as, and where (sections 6, 7, 8, 9).
--
-- A mapping is the join between one canonical item and one thing a provider
-- sells. Section 7 makes two demands of it that shape this schema more than
-- anything else.
--
-- The first is that a channel entity belongs to only one canonical item at a
-- time, while any number of entities across connections may share one canonical
-- item. That asymmetry is a partial unique index on the channel side and no
-- constraint at all on the canonical side.
--
-- The second is that mapping changes are versioned, that removed mappings are
-- archived rather than erased, and that historical sales keep the version that
-- was active at purchase. So the mapping row carries the current state and
-- `channel_mapping_versions` carries what it used to be — which is what makes an
-- order from March explicable after the mapping was repointed in April.
--
-- Locations are a child table rather than an array column because section 9
-- requires each mapping to select eligible locations and a composite foreign key
-- is what makes selecting another business's warehouse unrepresentable.

create table channel_mappings (
  id                  uuid        primary key default gen_random_uuid(),
  business_id         uuid        not null,
  connection_id       uuid        not null,
  -- The channel entity: a WooCommerce product or variation, an eBay listing or
  -- variation, as recorded by the import.
  provider_item_id    uuid        not null,
  canonical_item_id   uuid        not null,

  -- draft      proposed, not yet approved (section 7 requires approval)
  -- approved   approved but not yet proven against the channel
  -- active     synchronizing
  -- paused     approved, temporarily not writing: incomplete variations, a
  --            missing entity, an unresolved conflict
  -- archived   removed, retained for history
  status              text        not null default 'draft',
  pause_reason        text,

  -- Section 8: a per-channel buffer withholds units from this channel without
  -- hiding them from others, and a cap is a ceiling on advertised quantity.
  -- Neither is a second pool-level safety stock.
  channel_buffer      integer     not null default 0,
  channel_cap         integer,

  -- Incremented on every change that produces a version row.
  version             integer     not null default 1,

  created_by_user_id  uuid        references users (id) on delete set null,
  approved_by_user_id uuid        references users (id) on delete set null,
  approved_at         timestamptz,
  activated_at        timestamptz,
  archived_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint channel_mappings_status_valid check (
    status in ('draft', 'approved', 'active', 'paused', 'archived')
  ),
  constraint channel_mappings_buffer_nonnegative check (channel_buffer >= 0),
  constraint channel_mappings_cap_nonnegative check (channel_cap is null or channel_cap >= 0),
  constraint channel_mappings_version_positive check (version >= 1),

  -- Section 7 requires approval before a mapping can do anything. Recording who
  -- and when is what makes "every mapping requires approval" checkable after the
  -- fact rather than merely asserted by the code path that set the status.
  constraint channel_mappings_approval_recorded check (
    status not in ('approved', 'active', 'paused') or approved_at is not null
  ),
  constraint channel_mappings_activation_recorded check (
    status <> 'active' or activated_at is not null
  ),
  constraint channel_mappings_archival_recorded check (
    (status = 'archived') = (archived_at is not null)
  ),
  -- A pause an operator cannot read is a mapping that has silently stopped.
  constraint channel_mappings_pause_explained check (
    (status = 'paused') = (pause_reason is not null)
  ),

  constraint channel_mappings_business_scoped unique (business_id, id),
  constraint channel_mappings_item_fkey
    foreign key (business_id, canonical_item_id)
    references canonical_items (business_id, id) on delete restrict,
  constraint channel_mappings_connection_fkey
    foreign key (business_id, connection_id)
    references connections (business_id, id) on delete cascade,
  constraint channel_mappings_provider_item_fkey
    foreign key (business_id, provider_item_id)
    references provider_items (business_id, id) on delete restrict
);

-- Section 7: "A channel entity belongs to only one canonical inventory item at
-- a time." Partial, so an archived mapping does not block the entity being
-- mapped again — which is the whole point of archiving rather than deleting.
create unique index channel_mappings_one_live_per_entity
  on channel_mappings (provider_item_id)
  where status <> 'archived';

-- The query path the projection takes: every mapping of one canonical item that
-- is currently writing.
create index channel_mappings_by_item
  on channel_mappings (business_id, canonical_item_id)
  where status in ('active', 'paused');

create index channel_mappings_by_connection
  on channel_mappings (connection_id, status);

-- Section 9: each mapping selects one or more eligible locations, and advertised
-- availability sums only those.
create table channel_mapping_locations (
  business_id  uuid not null,
  mapping_id   uuid not null,
  location_id  uuid not null,

  constraint channel_mapping_locations_pkey primary key (mapping_id, location_id),

  constraint channel_mapping_locations_mapping_fkey
    foreign key (business_id, mapping_id)
    references channel_mappings (business_id, id) on delete cascade,
  constraint channel_mapping_locations_location_fkey
    foreign key (business_id, location_id)
    references locations (business_id, id) on delete restrict
);

-- Section 7: mapping changes are versioned, and structural versions remain while
-- referenced by retained orders or ledger events. This table is append-only for
-- the same reason the ledger is: an order from March is explained by the version
-- that was live in March, and editing it would silently rewrite that
-- explanation.
create table channel_mapping_versions (
  id                 uuid        primary key default gen_random_uuid(),
  business_id        uuid        not null,
  mapping_id         uuid        not null,
  version            integer     not null,

  -- The definition as it stood. Denormalized on purpose: reading the current
  -- mapping row would answer with today's canonical item, not the one this
  -- version pointed at.
  canonical_item_id  uuid        not null,
  channel_buffer     integer     not null,
  channel_cap        integer,
  location_ids       uuid[]      not null default '{}',
  status             text        not null,

  change_reason      text,
  created_by_user_id uuid        references users (id) on delete set null,
  created_at         timestamptz not null default now(),

  constraint channel_mapping_versions_version_positive check (version >= 1),
  constraint channel_mapping_versions_unique unique (mapping_id, version),
  constraint channel_mapping_versions_mapping_fkey
    foreign key (business_id, mapping_id)
    references channel_mappings (business_id, id) on delete cascade
);

create index channel_mapping_versions_timeline
  on channel_mapping_versions (mapping_id, version desc);

create trigger channel_mappings_touch_updated_at
  before update on channel_mappings
  for each row execute function eim_touch_updated_at();

create or replace function eim_channel_mapping_versions_are_append_only() returns trigger
language plpgsql as $$
begin
  raise exception
    'channel_mapping_versions is append-only; record a new version instead of %ing one',
    lower(tg_op);
end;
$$;

create trigger channel_mapping_versions_append_only
  before update or delete on channel_mapping_versions
  for each row execute function eim_channel_mapping_versions_are_append_only();
