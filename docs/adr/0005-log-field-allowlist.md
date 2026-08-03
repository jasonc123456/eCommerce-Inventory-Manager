# 5. Log fields pass an allowlist, not a denylist

**Status:** Accepted (M0)

## Context

Section 22 requires that sensitive values never reach a log at any level, and
that enabling debug or trace changes the amount of detail rather than the
redaction policy.

The usual implementation is a denylist: pino's `redact` option takes paths like
`req.headers.authorization` and censors them. It protects the field names
somebody thought of.

That is the wrong shape for the failure that actually happens. An eBay or
WooCommerce client throws an error with the whole HTTP exchange hanging off it,
so `error.response.request.headers.authorization` is a real path to a real
bearer token, under a name nobody predicted, reached by a log call somebody
wrote in a hurry during an incident.

## Decision

Invert it. Only field names on an explicit allowlist may appear in a log line;
everything else is dropped and reported by name in an `unloggedFields` array.

Two rules keep the list honest:

1. **Identifiers only, never the things they identify.** `businessId` is
   allowed; `businessName` is not. An opaque identifier is meaningless to
   somebody who steals the logs and sufficient for somebody diagnosing an
   incident.
2. **Allowlisted keys carry scalars.** An object under an allowlisted key is
   dropped, because the allowlist vouches for the key and says nothing about
   what a caller nested beneath it. `err` is the one exception and goes through
   a serializer that copies three known-safe properties.

The filter runs in pino's `formatters.log` hook, which sees the fully merged
object for a line. Child bindings are filtered separately at child-creation
time, because pino caches them as a serialized fragment that the log formatter
never sees again.

## Alternatives rejected

**pino's `redact` with a thorough path list.** Protects what was anticipated. The
tokens that leak are the ones nobody anticipated.

**Reviewing log calls in code review.** Works until the incident where somebody
adds a log line at two in the morning, which is the exact circumstance the
control exists for.

**Structured logging with a typed field interface.** Would give compile-time
safety, and would not cover the ambient correlation context, the error
serializer, or anything reaching the logger through a generic wrapper. Worth
adding on top later; not a substitute.

## Consequences

Adding a field to a log line is a deliberate edit to
`packages/observability/src/fields.ts`, which is where the question "could this
ever hold a token, an address, or a customer's name?" gets asked.

Dropped fields are visible rather than silent. `unloggedFields` lists the names,
which are developer-written and leak nothing, so a mistake shows up the first
time anyone reads the output.

The allowlist cannot police the contents of an error message. An error built by
interpolating a secret into its message will log that secret. That obligation
sits with the code that throws, and section 19 states it.

## When to revisit

If the allowlist grows large enough that people stop reading it before adding to
it, the control has stopped working and needs a different shape — most likely a
typed field interface enforced at the call site.
