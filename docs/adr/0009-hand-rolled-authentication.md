# 9. Authentication is built on primitives, not a framework

**Status:** Accepted (M0). Implementation lands in M1.

## Context

Section 20 specifies authentication in unusual detail: magic links whose token
arrives in the URL fragment and is submitted by POST so it never reaches a
server log or a referrer header; keyed-hash eight-digit codes; passkeys; TOTP
with recovery codes; trusted devices; a ten-minute step-up window for sensitive
actions; and a break-glass command-line path for an administrator locked out of
their own installation.

## Decision

Build on primitives — `@simplewebauthn/server`, `otpauth`, `node:crypto`, and
sessions in PostgreSQL — rather than adopting an authentication framework.

Deferring the implementation to M1 does not defer the decision: it determines
what the session and identity tables look like, and those are schema.

## Why

Every candidate framework has its own opinion about session storage, its own
callback lifecycle, and its own idea of what a login flow looks like. Section 20
disagrees with all of them on specifics that exist for reasons — the fragment
transport is there because a token in a query string ends up in access logs, and
that is not a preference a framework will accommodate.

Adopting a framework here means writing most of the flow as custom callbacks
anyway, while inheriting its session model and its upgrade cadence. That is the
worst of both: the constraints of a dependency without the leverage.

Meanwhile the parts that are genuinely hard and genuinely dangerous to
improvise — WebAuthn attestation and assertion verification, TOTP — are exactly
the parts that have good, focused, single-purpose libraries. Those get used.

## Alternatives rejected

**Auth.js (NextAuth).** The default for Next.js. Its adapter model assumes its
own schema, its session handling assumes its own cookie, and neither matches
section 20. Step-up authentication and trusted devices have no place in it.

**Lucia.** Closer in philosophy, and it was deprecated as a library in favour of
being a guide, which is a strong signal that this layer is better owned than
depended on.

**Keycloak or another identity provider.** A second service to deploy, back up,
and upgrade, for a self-hosted application whose main appeal is running as one
stack. It would also move authorization decisions away from the data they are
about.

**Rolling our own WebAuthn or TOTP.** Not a candidate. The libraries exist
because these are hard to implement correctly and silent when done wrong.

## Consequences

This is the highest-risk decision in M0. Authentication code that is wrong is
wrong in ways that do not show up in tests, so it needs the highest coverage
requirement (section 25's 90% branch threshold applies here), property tests for
token and session lifetimes, and explicit tests for every negative path.

Session revocation, rotation, and fixation defences are ours to get right.

The break-glass path must be usable by an operator with shell access and no
working browser session, and must leave an audit record.

## When to revisit

Before M1 begins, since that is when it becomes expensive to change. If a
framework appears that models step-up windows and trusted devices as first-class
concepts, it is worth a serious look — those are the two requirements that rule
out today's options.
