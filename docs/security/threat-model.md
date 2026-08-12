# Threat model and secret handling

What this application assumes, what it defends, and what it does not.

## What is assumed

- The host is trusted. `.env` holds the keyring, and anybody who can read it can
  decrypt every stored credential. Owner-only permissions are checked at
  startup and by upgrade preflight.
- The reverse proxy terminates TLS and is configured with the addresses in
  `EIM_TRUSTED_PROXY_CIDRS`. Client-address decisions trust no other header.
- The database is reachable only from the application network. The Compose
  template publishes no PostgreSQL port.

## What is defended

**Cross-business access.** Composite foreign keys mean a row can only ever point
at a row in its own business — a failure of application authorization still
cannot produce a cross-tenant relationship, because the schema refuses it.

**Server-side request forgery.** Every outbound request goes through one client
that validates the destination, refuses private address space unless explicitly
allowed, pins the resolved address, and revalidates after every redirect. That
covers WooCommerce stores, AI endpoints, and alert destinations alike.

**Credential exposure.** Business credentials are encrypted with an AEAD whose
associated data binds the ciphertext to the business, the resource, and the kind
of secret — a ciphertext moved between rows fails to decrypt rather than quietly
authenticating as somebody else. Secrets are masked after entry and never
returned to a browser.

**Log and payload leakage.** Logging is allowlisted by field name: a value has
to be named to be logged. Outbound alert payloads are built field by field from
a fixed list rather than filtered, so adding something is an edit somebody
reviews.

**Backup compromise.** Backups encrypt to a key whose private half is held off
the host. A copy of the disk yields ciphertext.

**Replay.** Signed outbound webhooks cover a timestamp inside the signature.
Inbound provider deliveries deduplicate on a fingerprint of what the delivery is
about rather than on the provider's own identifier.

## What is not defended

- **A compromised host.** Root on the machine means the keyring, and the keyring
  means the credentials. The mitigation is the backup key being elsewhere.
- **A malicious installation administrator.** They hold configuration and health
  authority by design. Business data is a separate authority, but an
  administrator who can edit `.env` can do anything.
- **Denial of service.** Rate limits are per route, business, and address, and
  are for correctness and quota protection rather than for absorbing an attack.
  That belongs to the proxy or the network in front of it.
- **A malicious dependency.** Grouped update review, license checks, secret
  scanning, and a two-day minimum release age reduce the exposure; they do not
  eliminate it.

## Secret handling rules

1. No secret is ever returned to a browser after entry, including partially.
2. No secret is written to a log at any level. Debug mode changes detail, never
   redaction policy.
3. Nothing that could help decrypt a backup is stored beside the backups.
4. A credential-bearing URL is a credential: Slack and Discord webhook URLs are
   encrypted, and only their host is shown.
5. Rotation replaces and retires in one transaction, so there is never a moment
   with two live secrets or none.

## Reporting a vulnerability

Privately, through GitHub Security Advisories or the address in
[SECURITY.md](../../SECURITY.md). Do not open a public issue for an undisclosed
vulnerability.
