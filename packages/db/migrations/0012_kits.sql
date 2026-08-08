-- 0012_kits
--
-- Fixed-quantity kits (section 10).
--
-- Section 10's first sentence is the whole design: "a kit has no independent
-- physical stock." A kit is a canonical item whose availability is computed from
-- its components rather than counted on a shelf, and a kit sale decrements the
-- components rather than the kit.
--
-- That makes "no ledger entry and no balance row may name a kit" a correctness
-- invariant rather than a convention, and section 17 is explicit that
-- application validation improves error messages but never substitutes for the
-- database protecting correctness. So it is enforced structurally: the two
-- tables that hold stock carry a column that is always false, and a composite
-- foreign key requires the canonical item they name to agree.
--
-- A consequence worth stating plainly: an item that has ever held stock can
-- never be turned into a kit, because its existing ledger entries would violate
-- that foreign key. That is the intended answer. A kit is a recipe, not a
-- container, and converting a stocked item into one would leave its counted
-- units belonging to nothing.

alter table canonical_items
  add column is_kit boolean not null default false,

  -- The target the foreign keys below need. Redundant against the primary key
  -- alone, which is the point — it carries is_kit along with the row reference.
  add constraint canonical_items_kind_scoped unique (business_id, id, is_kit);

alter table location_balances
  add column item_is_kit boolean not null default false,
  add constraint location_balances_never_a_kit check (item_is_kit = false),
  add constraint location_balances_item_kind_fkey
    foreign key (business_id, canonical_item_id, item_is_kit)
    references canonical_items (business_id, id, is_kit) on delete cascade;

alter table inventory_ledger
  add column item_is_kit boolean not null default false,
  add constraint inventory_ledger_never_a_kit check (item_is_kit = false),
  add constraint inventory_ledger_item_kind_fkey
    foreign key (business_id, canonical_item_id, item_is_kit)
    references canonical_items (business_id, id, is_kit) on delete restrict;

-- ---------------------------------------------------------------------------
-- Recipes
-- ---------------------------------------------------------------------------

-- Section 10: recipes are versioned, future sales use the new recipe, and
-- existing orders retain the recipe version active at purchase. So a recipe is
-- never edited in place; a new version supersedes the old one and the old one
-- stays.
create table kit_recipes (
  id                  uuid        primary key default gen_random_uuid(),
  business_id         uuid        not null,
  -- The kit itself, which must be a canonical item marked as one.
  canonical_item_id   uuid        not null,
  kit_is_kit          boolean     not null default true,
  version             integer     not null,

  -- draft       being authored; computes nothing and sells nothing
  -- active       the recipe in force
  -- superseded   replaced by a later version, retained for historical orders
  status              text        not null default 'draft',

  notes               text,
  created_by_user_id  uuid        references users (id) on delete set null,
  approved_by_user_id uuid        references users (id) on delete set null,
  approved_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint kit_recipes_status_valid check (status in ('draft', 'active', 'superseded')),
  constraint kit_recipes_version_positive check (version >= 1),
  constraint kit_recipes_is_a_kit check (kit_is_kit = true),
  -- Section 10: administrators author recipes manually, and optional AI may
  -- suggest components but cannot save or activate one. An active recipe
  -- therefore always names the person who approved it.
  constraint kit_recipes_approval_recorded check (
    status = 'draft' or (approved_at is not null and approved_by_user_id is not null)
  ),

  constraint kit_recipes_version_unique unique (canonical_item_id, version),
  constraint kit_recipes_business_scoped unique (business_id, id),
  constraint kit_recipes_kit_fkey
    foreign key (business_id, canonical_item_id, kit_is_kit)
    references canonical_items (business_id, id, is_kit) on delete cascade
);

-- One recipe is in force at a time. A second would leave "how many can we make"
-- with two answers.
create unique index kit_recipes_one_active
  on kit_recipes (canonical_item_id)
  where status = 'active';

create table kit_recipe_components (
  business_id                 uuid    not null,
  recipe_id                   uuid    not null,
  -- Denormalized so the database itself can refuse a kit that contains itself.
  kit_canonical_item_id       uuid    not null,
  component_canonical_item_id uuid    not null,
  -- Components are ordinary stocked items. A kit inside a kit would have no
  -- units to contribute, since a kit has no independent physical stock.
  component_is_kit            boolean not null default false,
  required_quantity           integer not null,

  constraint kit_recipe_components_pkey primary key (recipe_id, component_canonical_item_id),

  -- Section 10: positive whole-number required quantities.
  constraint kit_recipe_components_quantity_positive check (required_quantity >= 1),
  constraint kit_recipe_components_not_self check (
    component_canonical_item_id <> kit_canonical_item_id
  ),
  constraint kit_recipe_components_not_a_kit check (component_is_kit = false),

  constraint kit_recipe_components_recipe_fkey
    foreign key (business_id, recipe_id)
    references kit_recipes (business_id, id) on delete cascade,
  constraint kit_recipe_components_component_fkey
    foreign key (business_id, component_canonical_item_id, component_is_kit)
    references canonical_items (business_id, id, is_kit) on delete restrict
);

create index kit_recipe_components_by_component
  on kit_recipe_components (business_id, component_canonical_item_id);

create trigger kit_recipes_touch_updated_at
  before update on kit_recipes
  for each row execute function eim_touch_updated_at();
