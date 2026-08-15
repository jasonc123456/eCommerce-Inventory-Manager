-- 0035_business_deletion
--
-- Deleting a business, with the owner asked twice (sections 5, 13, 19).
--
-- Section 5 lists `delete_business` as "deleting the business and its data" and
-- nothing implemented it, so the permission named an act nobody could perform.
--
-- Why a table rather than a button.
--
-- The destructive action every operator eventually regrets is the one that
-- happened between deciding and thinking. So deletion is two acts separated by
-- a channel the browser does not control: a request made in the application,
-- and a confirmation that arrives by email at the address the owner signs in
-- with. A stolen session cookie is enough for the first and not for the second.
--
-- The row is what makes the two halves one operation. It carries who asked,
-- when it expires, and whether it has been settled — so a confirmation can be
-- checked against something rather than trusted because it decrypts.
--
-- What is stored is a hash of the link, never the link. Anybody who can read
-- this table can already read the database they would be deleting, but the same
-- is true of a backup, a replica, and a support export — and a token sitting in
-- one of those is a deletion waiting for somebody to paste it.
--
-- One outstanding request per business, enforced by a partial unique index. The
-- alternative is five live links in five inboxes, where cancelling the one you
-- remember leaves four that still work.

create table business_deletion_requests (
  id                    uuid        primary key default gen_random_uuid(),

  business_id           uuid        not null references businesses (id) on delete cascade,

  -- Restricted rather than cascaded: the person who asked for a deletion is
  -- part of the evidence, and a user account removed later must not quietly
  -- take that with it.
  requested_by_user_id  uuid        not null references users (id) on delete restrict,
  requested_at          timestamptz not null default now(),

  -- The emailed link, keyed-hashed. Unique so a confirmation is a lookup rather
  -- than a scan, and so two requests can never collide on one token.
  token_hash            text        not null,

  -- Short. A destructive confirmation is something the owner is waiting for,
  -- and a link that stays live for days is a link that outlives the intent.
  expires_at            timestamptz not null,

  confirmed_at          timestamptz,
  confirmed_by_user_id  uuid        references users (id) on delete set null,

  cancelled_at          timestamptz,
  cancelled_by_user_id  uuid        references users (id) on delete set null,

  -- Free text from the owner, kept because "why did this business disappear"
  -- is the question somebody asks a year later.
  reason                text,

  -- A request is settled once, one way. Both timestamps set would mean a
  -- deletion that was also cancelled, which is not a state anything can act on.
  constraint business_deletion_requests_settled_once
    check (confirmed_at is null or cancelled_at is null),

  -- Every settlement says who. An unattributed deletion of somebody's shop is
  -- exactly the record this table exists to prevent.
  constraint business_deletion_requests_confirmation_is_attributed
    check ((confirmed_at is null) = (confirmed_by_user_id is null)),

  constraint business_deletion_requests_cancellation_is_attributed
    check ((cancelled_at is null) = (cancelled_by_user_id is null))
);

create unique index business_deletion_requests_token
  on business_deletion_requests (token_hash);

create unique index business_deletion_requests_one_outstanding
  on business_deletion_requests (business_id)
  where confirmed_at is null and cancelled_at is null;

create index business_deletion_requests_by_business
  on business_deletion_requests (business_id, requested_at desc);
