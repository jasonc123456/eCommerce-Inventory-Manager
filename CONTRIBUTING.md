# Contributing

Thank you for considering a contribution. This document covers what you need to
know before opening a pull request.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Licence and the Developer Certificate of Origin

This project is licensed under **AGPL-3.0-only**. Contributions are accepted
under the same licence, and there is no contributor licence agreement to sign
and no copyright assignment. You keep the copyright in what you write.

What is required is a **Developer Certificate of Origin** sign-off on every
commit, which is a statement that you have the right to contribute the code:

```
git commit -s -m "add the reconciliation repair plan"
```

The `-s` flag appends a `Signed-off-by` trailer with the name and email from
your Git configuration. The full text of what you are certifying is at
<https://developercertificate.org/> and is reproduced at the end of this file.

A DCO sign-off is deliberately lighter than a contributor licence agreement: it
asks you to confirm the code is yours to give, and nothing more.

## Getting set up

You need Docker and Git. Everything else runs inside a container, so no version
of Node or pnpm on your machine will affect the result.

```bash
git clone https://github.com/jasonc123456/eCommerce-Inventory-Manager.git
cd eCommerce-Inventory-Manager
./scripts/dev.sh pnpm install
./scripts/dev.sh pnpm test
```

`scripts/dev.sh` runs a command inside the development container. It starts the
stack on first use. If you would rather work natively, Node 24 and pnpm 11 are
what the container provides, and every command below works without the wrapper.

Useful commands:

| Command                  | What it does                                   |
| ------------------------ | ---------------------------------------------- |
| `pnpm test`              | Unit tests with coverage                       |
| `pnpm test:integration`  | Integration tests against a real PostgreSQL 18 |
| `pnpm lint`              | ESLint, with warnings treated as errors        |
| `pnpm typecheck`         | TypeScript across every package                |
| `pnpm format`            | Prettier, writing changes                      |
| `pnpm env:check --write` | Regenerate `.env.example` from the schema      |

## Commit messages

Write a short, plain subject in the imperative mood, under 72 characters:

```
add the kit capacity calculation
fix the lease renewal race on a slow tick
```

Do **not** use a Conventional Commits type prefix. `feat:`, `fix:`, and `chore:`
are noise here: the diff already says what kind of change it is, and the prefix
crowds out the part of the subject line that carries information.

Do not add trailers attributing authorship to a tool. `Signed-off-by` from
`git commit -s` is required; nothing else belongs there.

A `commit-msg` hook enforces both rules.

## Changesets

Any change that affects behaviour needs a changeset, which is how the release
notes are written:

```bash
pnpm changeset
```

Pick the packages affected and the kind of change, and describe it in a sentence
aimed at somebody running the application rather than somebody reading the diff.
Documentation-only and internal refactoring changes do not need one.

## What a pull request needs

- The fast tier green: format, lint, types, unit tests, secret scan, licences.
- Tests for the behaviour you changed. See below for what "tested" means here.
- A changeset, if the change is user-visible.
- The specification updated, if you changed a rule it describes. The
  specification is a living document and the code is not allowed to drift from
  it silently.

Keep pull requests focused. A pull request that fixes a bug and reformats four
files is two pull requests, and the reformatting will hide the fix.

## Testing expectations

Section 25 of the specification sets these; the short version:

**Inventory, authentication, authorization, and security code needs 90% branch
coverage.** Everything else needs 80% overall. These are enforced, not
aspirational.

**Integration tests run against a real PostgreSQL 18.** There is no in-memory
fallback and there will not be one. Composite foreign keys, deferred constraint
triggers, partial unique indexes, and `SKIP LOCKED` are the things most worth
testing and the things a fake cannot reproduce.

**Test the rule, not the implementation.** A test that asserts a function calls
another function tells you nothing when the design changes. A test that asserts
an over-reserved location cannot contribute stock will still be right in five
years.

**Property tests for the inventory arithmetic.** The availability calculation
has invariants — never negative, never exceeding on-hand, monotonic in safety
stock — and fast-check will find the counterexample you did not think of.

## Architecture boundaries

The linter enforces these, and it will tell you off before a reviewer has to:

- `packages/domain` and `packages/authz` are pure. No framework, no database,
  no provider transport, no filesystem. They are the rules, and they must be
  readable and testable without any of that.
- `packages/providers` holds adapter contracts and fakes. Adapters normalize
  what a provider says; they never decide inventory policy.
- `packages/db` owns persistence. It does not know about HTTP.
- `apps/worker` never calls the web tier over loopback HTTP. Everything it needs
  is in the database.

If a boundary is genuinely in the way, say so in the pull request and we will
discuss moving it. Do not add an eslint-disable.

## Security

Do not report vulnerabilities in a pull request or a public issue. See
[SECURITY.md](SECURITY.md).

Two rules that come up constantly:

- Nothing reads `process.env` outside `packages/config`. Configuration is
  validated in one place so it cannot be half-validated in ten.
- Log fields go through an allowlist. If you need a new field on a log line, add
  it to `packages/observability/src/fields.ts` and ask, in the review, whether it
  could ever hold a token, an address, or a customer's name.

## Developer Certificate of Origin 1.1

```
By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I have the right
    to submit it under the open source license indicated in the file; or

(b) The contribution is based upon previous work that, to the best of my
    knowledge, is covered under an appropriate open source license and I have
    the right under that license to submit that work with modifications, whether
    created in whole or in part by me, under the same open source license
    (unless I am permitted to submit under a different license), as indicated in
    the file; or

(c) The contribution was provided directly to me by some other person who
    certified (a), (b) or (c) and I have not modified it.

(d) I understand and agree that this project and the contribution are public and
    that a record of the contribution (including all personal information I
    submit with it, including my sign-off) is maintained indefinitely and may be
    redistributed consistent with this project or the open source license(s)
    involved.
```
