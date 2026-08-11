-- 0024_ai
--
-- Optional AI assistance (sections 5, 7, 10, 18, 19, 33, 34).
--
-- Three tables, and the shape of them follows from one sentence in section 18:
-- "AI is optional and disabled until configured per business." Everything a
-- model can do here is off until somebody with `manage_ai` turns it on, and the
-- default of every column that could widen what it sees or what it costs is the
-- narrow one.
--
-- Two absences are deliberate and are asserted by the milestone 7 exit gate.
--
-- There is no schedule, no cadence, and no queue reference. Section 18 says AI
-- is "administrator-triggered for a single draft/recipe suggestion" with "no
-- background or automatic publication", so there is nowhere in here to record
-- that a suggestion should be produced later. The same absence as
-- `reviewed_operations`, for a related reason: a suggestion nobody asked for is
-- a bill nobody agreed to, and one that arrived while nobody was looking is a
-- field filled in by a machine with no reviewer attached.
--
-- There is no conversation, no message list, and no thread. One question, one
-- answer, one row. A stored thread is what makes an agent, and section 3
-- excludes that from version 1 in every form it takes.
--
-- Raw prompts and responses are not retained by default (section 18), and the
-- columns that could hold them are nullable and stay null unless a business has
-- explicitly asked to keep them for debugging.

-- One business's configured endpoint.
--
-- Not a row in `connections`, for the same reason a shipping account is not:
-- a connection is a channel with listings, orders, mappings, and webhooks, and
-- none of that is meaningful for something that answers questions about text.
--
-- One per business. Two configured endpoints would mean every suggestion had to
-- say which one it used and every screen had to ask, and the answer to "which
-- model wrote this" would depend on a routing rule nobody wrote down. Switching
-- from a local Ollama to a cloud endpoint is an edit to this row, which the
-- audit trail records as an edit.
create table ai_providers (
  id                  uuid        primary key default gen_random_uuid(),
  business_id         uuid        not null references businesses (id) on delete cascade,

  -- openai_compatible | ollama
  kind                text        not null,

  -- Canonicalized and validated against the section 19 SSRF policy before it is
  -- stored, and again before every request. Stored canonical so that two spellings
  -- of one endpoint cannot become two configurations.
  base_url            text        not null,
  model               text        not null,

  -- Section 18's first sentence, as a column. Nothing infers this from the
  -- presence of a credential: a business that stored a key and has not switched
  -- the feature on has not switched the feature on.
  enabled             boolean     not null default false,

  -- Whether the endpoint answered when it was last checked. Separate from
  -- `enabled` because they fail differently and mean different things: one is a
  -- decision, the other is an observation.
  -- unchecked | ready | failing
  status              text        not null default 'unchecked',

  request_timeout_ms  integer     not null default 30000,
  max_output_tokens   integer     not null default 800,

  -- Section 18: "images are sent only when the administrator enables image
  -- analysis for that request". This column is the outer permission — whether
  -- the option may be offered at all — and a request must still ask for it. Two
  -- switches rather than one because a business that never wants a photograph
  -- leaving the building should not depend on nobody ticking a box.
  image_analysis_enabled boolean  not null default false,

  -- Section 18: "do not retain raw prompts/responses by default".
  retain_prompts      boolean     not null default false,

  -- Budgets. Section 18 requires spend limits and section 34 "token/spend caps",
  -- and both are expressed here as ceilings that always exist rather than
  -- nullable columns where null means unlimited. A local Ollama costs nothing in
  -- money and still costs a machine's time, which is why the request and token
  -- ceilings are the ones that are always present.
  monthly_request_cap integer     not null default 200,
  monthly_token_cap   bigint      not null default 500000,

  -- Money, which only a cloud endpoint has. The rates are entered by the
  -- operator from their provider's price list, because no application can know
  -- what somebody is paying; when they are present the cost of each suggestion
  -- is computed and the cap applies.
  cost_currency                 text,
  cost_per_million_input_tokens  numeric(18, 6),
  cost_per_million_output_tokens numeric(18, 6),
  monthly_cost_cap_amount        numeric(18, 4),

  last_checked_at     timestamptz,
  last_failure_summary text,

  created_by_user_id  uuid        references users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint ai_providers_kind_known
    check (kind in ('openai_compatible', 'ollama')),
  constraint ai_providers_status_known
    check (status in ('unchecked', 'ready', 'failing')),
  constraint ai_providers_timeout_bounded
    check (request_timeout_ms between 1000 and 120000),
  constraint ai_providers_output_bounded
    check (max_output_tokens between 64 and 8000),
  constraint ai_providers_caps_positive
    check (monthly_request_cap > 0 and monthly_token_cap > 0),

  -- A money cap that cannot be computed is worse than no money cap, because it
  -- reads on the screen as a limit that is being enforced. Either all three
  -- pricing facts are present or the ceiling is expressed in tokens alone.
  constraint ai_providers_cost_cap_is_computable
    check (
      monthly_cost_cap_amount is null
      or (cost_currency is not null
        and cost_per_million_input_tokens is not null
        and cost_per_million_output_tokens is not null)
    ),
  constraint ai_providers_cost_rates_positive
    check (
      (cost_per_million_input_tokens is null or cost_per_million_input_tokens >= 0)
      and (cost_per_million_output_tokens is null or cost_per_million_output_tokens >= 0)
      and (monthly_cost_cap_amount is null or monthly_cost_cap_amount > 0)
    ),

  constraint ai_providers_one_per_business unique (business_id),
  constraint ai_providers_business_scoped unique (business_id, id)
);

-- The cloud API key, encrypted, with the same custody rules as every other
-- provider credential (section 19). A local Ollama normally has none, which is
-- why nothing here requires one to exist.
create table ai_provider_secrets (
  id                  uuid        primary key default gen_random_uuid(),
  business_id         uuid        not null,
  provider_id         uuid        not null,

  -- ai_api_key
  secret_type         text        not null,
  ciphertext          text        not null,
  key_version         integer     not null,

  created_at          timestamptz not null default now(),
  retired_at          timestamptz,

  constraint ai_provider_secrets_type_known
    check (secret_type in ('ai_api_key')),
  constraint ai_provider_secrets_provider_fkey
    foreign key (business_id, provider_id)
    references ai_providers (business_id, id) on delete cascade
);

create unique index ai_provider_secrets_one_live
  on ai_provider_secrets (provider_id, secret_type)
  where retired_at is null;

create index ai_provider_secrets_key_version
  on ai_provider_secrets (key_version);

-- Every time somebody asked, and what came back.
--
-- This table is three things at once, and that is deliberate rather than
-- economical. It is the provenance record section 18 requires — "store the
-- resulting draft, provider/model identifier, timestamp, and approving user".
-- It is the spend ledger the budget is computed from, which is why a row is
-- written for a refusal and for a failure as well as for an answer: an attempt
-- that consumed tokens and returned nonsense still cost what it cost. And it is
-- the evidence that a suggestion was reviewed rather than applied, because the
-- operation it fed is named here and settled there.
--
-- Splitting them would mean a usage counter that could disagree with the
-- history explaining it, which is the same mistake as a materialized balance
-- that does not equal its ledger.
create table ai_suggestions (
  id                  uuid        primary key default gen_random_uuid(),
  business_id         uuid        not null references businesses (id) on delete cascade,

  -- Which configuration answered, where it still exists.
  --
  -- A single-column reference rather than the composite one used everywhere
  -- else in this schema, and the reason is the `on delete set null` beside it: a
  -- composite key can only be nulled if every column in it is nullable, and
  -- `business_id` is the one column on this row that must never be. The
  -- protection the composite key would give is kept by the service, which reads
  -- a provider by business and identity together and writes the same business
  -- onto the row it produces. Section 33's cross-business rule is not weakened
  -- here; it is enforced one level up because the alternative was a nullable
  -- business column on an evidence table.
  provider_id         uuid        references ai_providers (id) on delete set null,

  -- draft_fields | kit_recipe | mapping_candidates
  kind                text        not null,

  -- What was asked about, in the terms the asking screen used. Free text
  -- rather than a foreign key: a suggestion is evidence about a moment, and it
  -- should survive the item it discussed being deleted, exactly as an audit row
  -- does.
  subject_kind        text        not null,
  subject_reference   text        not null,

  -- Snapshots, not references. The provider row can be edited afterwards, and a
  -- suggestion must keep saying which model actually answered it.
  provider_kind       text,
  model               text,

  -- succeeded | malformed | refused | failed
  --
  -- `refused` is this application declining before any call was made: the
  -- feature is off, the budget is spent, the caller lacks `manage_ai`. `failed`
  -- is the endpoint. `malformed` is an endpoint that answered with something
  -- that could not be validated, which section 36 requires be handled as an
  -- ordinary outcome rather than an error.
  status              text        not null,
  refusal_reason      text,
  failure_summary     text,

  -- The validated suggestion, and only ever that. Whatever the model returned
  -- beyond the schema was dropped before this row was written.
  payload             jsonb,
  warnings            jsonb       not null default '[]',

  prompt_tokens       integer,
  completion_tokens   integer,
  estimated_cost_amount numeric(18, 6),
  cost_currency       text,
  latency_ms          integer,

  -- How many images were sent, so a privacy question has an answer without
  -- anybody having to trust a setting's history.
  images_sent         integer     not null default 0,

  -- Null unless the business asked for raw prompts and responses to be kept.
  retained_prompt     text,
  retained_response   text,

  requested_by_user_id uuid       references users (id) on delete set null,
  requested_at        timestamptz not null default now(),

  -- Section 18's provenance, completed. A suggestion that fed a draft names the
  -- reviewed operation it fed, and that row names the person who confirmed it.
  applied_operation_id uuid       references reviewed_operations (id) on delete set null,
  applied_by_user_id   uuid       references users (id) on delete set null,
  applied_at           timestamptz,

  constraint ai_suggestions_kind_known
    check (kind in ('draft_fields', 'kit_recipe', 'mapping_candidates')),
  constraint ai_suggestions_status_known
    check (status in ('succeeded', 'malformed', 'refused', 'failed')),

  -- A payload exists only where something was validated. This is what stops a
  -- failed attempt leaving a half-parsed answer behind that a screen would
  -- happily render.
  constraint ai_suggestions_payload_matches_status
    check ((status = 'succeeded') = (payload is not null)),
  constraint ai_suggestions_refusal_is_explained
    check (status <> 'refused' or refusal_reason is not null),

  -- Nothing was sent, so nothing was spent. A refusal that recorded token usage
  -- would inflate the budget it was protecting.
  constraint ai_suggestions_refusal_costs_nothing
    check (
      status <> 'refused'
      or (prompt_tokens is null and completion_tokens is null and images_sent = 0)
    ),
  constraint ai_suggestions_usage_not_negative
    check (
      (prompt_tokens is null or prompt_tokens >= 0)
      and (completion_tokens is null or completion_tokens >= 0)
      and images_sent >= 0
    ),
  constraint ai_suggestions_cost_has_currency
    check ((estimated_cost_amount is null) = (cost_currency is null)),

  -- An application is a person accepting a suggestion, so it names both.
  constraint ai_suggestions_application_is_complete
    check (
      (applied_at is null and applied_by_user_id is null)
      or (applied_at is not null and applied_by_user_id is not null)
    ),
  -- Only something that was validated can be accepted.
  constraint ai_suggestions_only_valid_applies
    check (applied_at is null or status = 'succeeded'),

  constraint ai_suggestions_business_scoped unique (business_id, id)
);

-- The budget query: everything this business asked for inside the window.
create index ai_suggestions_by_business
  on ai_suggestions (business_id, requested_at desc);

-- The provenance query: what fed this operation.
create index ai_suggestions_by_operation
  on ai_suggestions (applied_operation_id)
  where applied_operation_id is not null;
