-- 0004_bootstrap_setup_token
--
-- The one-time setup link for the first installation administrator (section 20).
--
-- Section 20's bootstrap flow has two factors that a sign-in does not: the
-- configured address must receive a one-time link, and whoever opens it must
-- also present the temporary setup secret from the deployment host's .env.
-- Possession of the inbox alone is not enough, and neither is possession of the
-- file.
--
-- The token lives here rather than in `login_challenges` because the two flows
-- are not the same thing wearing different labels. A login challenge resolves to
-- an existing account and refuses when there is none; bootstrap runs precisely
-- when there is no account, and its success creates one. Reusing the table would
-- have meant a nullable-user special case on the one path where getting it wrong
-- hands somebody an installation.

alter table installation_bootstrap
  -- Keyed hash, like every other bearer token. The raw value exists only in the
  -- message that was sent.
  add column setup_token_hash text,
  add column setup_token_issued_at timestamptz,
  add column setup_token_expires_at timestamptz;

alter table installation_bootstrap
  -- A hash with no expiry would never age out, and an expiry with no hash would
  -- describe a token that does not exist.
  add constraint installation_bootstrap_setup_token_complete check (
    (setup_token_hash is null) = (setup_token_expires_at is null)
  ),
  -- Once bootstrap has closed there is nothing left to authorize, and a token
  -- surviving that would be a credential for an endpoint that no longer exists.
  add constraint installation_bootstrap_no_token_after_completion check (
    completed_at is null or setup_token_hash is null
  );
