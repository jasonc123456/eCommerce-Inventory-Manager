-- 0021_reviewed_operations
--
-- Operations a person authorizes one at a time (sections 11, 13, 14, 20, 30).
--
-- Everything in milestone 5 — turning a listing into a draft on the other
-- platform, publishing that draft, copying a price once, returning an eligible
-- eBay listing to sale, copying an eBay order into WooCommerce — shares one
-- shape, and this table is that shape. Each is proposed from freshly read state,
-- shown to a person in full, confirmed by that person against the exact thing
-- they were shown, and then carried out exactly once.
--
-- Three properties are worth stating, because they are what the columns are for
-- rather than incidental to them.
--
-- A confirmation authorizes one execution of one preview. `preview_fingerprint`
-- is a hash of the values a decision turns on, and the confirmer must send back
-- the fingerprint of the screen they actually read. If the underlying state
-- moved between the proposal and the click, the fingerprints disagree and the
-- confirmation is refused rather than applied to numbers nobody approved.
-- Section 30's AC-10 asks for a "fresh source value [and] exact confirmation";
-- this is both, and the second is meaningless without the first.
--
-- There is no schedule here. No interval column, no next-run column, no repeat
-- count — and their absence is deliberate rather than merely current. Section 3
-- excludes recurring price synchronization and automatic publication from
-- version 1, and the way to make that true is for the mechanism to be incapable
-- of it: a row reaches a terminal state and a trigger refuses to bring it back.
-- A future recurring feature would have to add a table, which is a change a
-- reviewer can see, instead of setting a field nobody noticed.
--
-- Execution and confirmation are separate states because a provider call can
-- fail ambiguously. Retrying is then required for correctness — but every
-- attempt carries the same `idempotency_key`, so the provider applies the change
-- once however many times we ask.

create table reviewed_operations (
  id                  uuid        primary key default gen_random_uuid(),
  business_id         uuid        not null references businesses (id) on delete cascade,

  -- draft_create | draft_publish | price_copy | restock_to_live | order_copy
  kind                text        not null,

  -- proposed | confirmed | executing | executed | failed | expired | cancelled
  state               text        not null default 'proposed',

  -- What this is about: a mapping, a listing, an order. Free text built at the
  -- call site, and the reason a second proposal for the same subject collides
  -- with the first rather than stacking beside it.
  subject_key         text        not null,

  -- What the confirmer must hold. Recorded on the proposal rather than derived
  -- again at confirmation, so the check cannot drift from what the proposal was
  -- built to require, and so an audit reader can see what was demanded without
  -- reconstructing the code that ran that day.
  required_permission text        not null,
  requires_recent_authentication boolean not null default true,

  -- Exactly what was shown, and a hash over the parts of it a person's decision
  -- turns on. Both, not one: the fingerprint is what the confirmation is checked
  -- against, and the preview is what a reader six months later needs to see to
  -- understand what was agreed to.
  preview             jsonb       not null,
  preview_fingerprint text        not null,

  -- When the provider values inside the preview were actually read, and how old
  -- that read may be by the time somebody confirms. Section 30's AC-10 requires
  -- a fresh source value; a preview built from a value read this morning is a
  -- proposal to overwrite whatever the price is now with whatever it was then.
  source_observed_at  timestamptz not null,
  source_max_age_ms   bigint      not null,

  -- The proposal's own deadline, which is not the same thing. Source freshness
  -- asks whether the numbers are still true; expiry asks whether the intent is.
  expires_at          timestamptz not null,

  -- Links, so an operation can be opened rather than merely read.
  mapping_id          uuid,
  canonical_item_id   uuid,
  source_connection_id uuid,
  destination_connection_id uuid,
  -- A provider-side identifier this operation is about: an order id, a listing
  -- id, a product id. Which one depends on the kind.
  external_reference  text,

  -- Publication points at the draft creation that produced the draft. Section
  -- 13 requires "separate confirmation" for publication, and section 14 that
  -- "saving destination draft and publishing are separate confirmations" — two
  -- rows, two confirmers, two audit entries, rather than one row with a second
  -- flag set.
  parent_operation_id uuid        references reviewed_operations (id) on delete cascade,

  -- Sent to the provider on every attempt of this operation and never reused.
  idempotency_key     text        not null,

  proposed_by_user_id uuid        references users (id) on delete set null,
  proposed_at         timestamptz not null default now(),
  confirmed_by_user_id uuid       references users (id) on delete set null,
  confirmed_at        timestamptz,
  executed_at         timestamptz,
  settled_at          timestamptz,

  -- Provider attempts made under this confirmation. Counted rather than capped
  -- here; the retry schedule in section 12 owns the ceiling.
  attempts            integer     not null default 0,

  outcome             jsonb,
  failure_summary     text,

  constraint reviewed_operations_kind_known
    check (kind in (
      'draft_create', 'draft_publish', 'price_copy', 'restock_to_live', 'order_copy'
    )),
  constraint reviewed_operations_state_known
    check (state in (
      'proposed', 'confirmed', 'executing', 'executed', 'failed', 'expired', 'cancelled'
    )),

  -- Anything past 'proposed' towards execution was agreed to by somebody, and
  -- the row has to say who. An executed operation with no confirmer is exactly
  -- the automatic publication section 3 excludes, so it is unstorable.
  constraint reviewed_operations_execution_was_confirmed
    check (
      state not in ('confirmed', 'executing', 'executed', 'failed')
      or (confirmed_by_user_id is not null and confirmed_at is not null)
    ),
  constraint reviewed_operations_executed_is_recorded
    check (state <> 'executed' or executed_at is not null),
  constraint reviewed_operations_failure_is_explained
    check (state <> 'failed' or failure_summary is not null),
  constraint reviewed_operations_freshness_positive
    check (source_max_age_ms > 0),
  constraint reviewed_operations_attempts_not_negative
    check (attempts >= 0),

  -- The column list on SET NULL matters on a composite key. Without it
  -- PostgreSQL nulls every referencing column, `business_id` included, and the
  -- delete fails on a not-null violation instead of detaching the operation.
  -- Naming the nullable half is what makes the history survive the mapping.
  constraint reviewed_operations_mapping_fkey
    foreign key (business_id, mapping_id)
    references channel_mappings (business_id, id) on delete set null (mapping_id),
  constraint reviewed_operations_item_fkey
    foreign key (business_id, canonical_item_id)
    references canonical_items (business_id, id) on delete set null (canonical_item_id)
);

-- One live operation per subject.
--
-- Without this, a person who clicks "copy this price" four times has four
-- confirmable proposals for the same listing, and confirming all four is a
-- recurring price change assembled by hand. The states listed are the
-- non-terminal ones, so a completed operation never blocks the next one.
create unique index reviewed_operations_one_live_per_subject
  on reviewed_operations (business_id, kind, subject_key)
  where state in ('proposed', 'confirmed', 'executing');

-- One provider effect per key, enforced here as well as at the provider,
-- because a provider that silently ignores an idempotency key would otherwise
-- leave us with no record that we had already asked.
create unique index reviewed_operations_idempotency_unique
  on reviewed_operations (business_id, idempotency_key);

create index reviewed_operations_awaiting_confirmation
  on reviewed_operations (business_id, kind, expires_at)
  where state = 'proposed';

create index reviewed_operations_recent
  on reviewed_operations (business_id, proposed_at desc);

create index reviewed_operations_by_parent
  on reviewed_operations (parent_operation_id)
  where parent_operation_id is not null;

-- A terminal operation stays terminal.
--
-- This is the enforcement of "no recurring path". An executed price copy cannot
-- be walked back to 'confirmed' and executed again, an expired proposal cannot
-- be revived past the freshness it was refused for, and a cancelled one cannot
-- be un-cancelled. Each of those would be a second effect from a single
-- confirmation, which is the thing section 30's AC-10 exists to prevent.
--
-- Doing it again is always allowed — by proposing again, from state read again,
-- and showing it to somebody again. That is the whole point.
create or replace function eim_reviewed_operations_stay_settled() returns trigger
language plpgsql
as $$
begin
  if old.state in ('executed', 'failed', 'expired', 'cancelled')
     and new.state is distinct from old.state then
    raise exception
      'reviewed operation % is already %; propose a new one rather than reviving it',
      old.id, old.state
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create trigger reviewed_operations_stay_settled
  before update on reviewed_operations
  for each row execute function eim_reviewed_operations_stay_settled();

-- Every refusal at the confirmation gate, kept whether or not it was the
-- confirmer's fault.
--
-- Section 19 requires audit coverage of publication and pricing mutations, and
-- the audit trail records those. This records the ones that did not happen: the
-- confirmations refused because the preview had moved, the source read had gone
-- stale, the permission was missing, or the authentication was too old. That is
-- the evidence that the gate is doing anything at all — a gate with no record of
-- ever having refused is indistinguishable from an open door.
create table reviewed_operation_refusals (
  id                  uuid        primary key default gen_random_uuid(),
  operation_id        uuid        not null references reviewed_operations (id) on delete cascade,
  business_id         uuid        not null,

  -- already_decided | expired | stale_preview | stale_source |
  -- not_permitted | recent_authentication_required
  reason              text        not null,
  attempted_by_user_id uuid       references users (id) on delete set null,
  detail              text,
  refused_at          timestamptz not null default now(),

  constraint reviewed_operation_refusals_reason_known
    check (reason in (
      'already_decided', 'expired', 'stale_preview', 'stale_source',
      'not_permitted', 'recent_authentication_required'
    )),
  constraint reviewed_operation_refusals_business_fkey
    foreign key (business_id) references businesses (id) on delete cascade
);

create index reviewed_operation_refusals_by_operation
  on reviewed_operation_refusals (operation_id, refused_at desc);
