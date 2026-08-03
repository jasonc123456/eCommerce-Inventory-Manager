# 1. TypeScript 6, not 7

**Status:** Accepted (M0)

## Context

TypeScript 7 is released and is the natively compiled rewrite of the compiler,
roughly an order of magnitude faster on a workspace this size. It is the obvious
default for a project starting today.

Section 26 requires type-aware linting: `typescript-eslint`'s
`strictTypeChecked` rules, which use the type checker to find things a
syntax-only linter cannot — a floating promise, an unnecessary condition, an
unsafe `any` crossing a boundary. In a worker that drops inventory work if a
promise is not awaited, those rules are not stylistic.

`typescript-eslint` declares a peer range of `>=4.8.4 <6.1.0`. It does not
support TypeScript 7, because the compiler rewrite changed the internal API the
type-aware rules are built on.

## Decision

Pin TypeScript **6.0.3** across the workspace.

## Alternatives rejected

**TypeScript 7 without type-aware linting.** Faster builds, and the loss of
every rule that made the linter worth configuring. Section 26 makes type-aware
linting non-negotiable, and the reason is sound: the defects those rules catch
are the ones that reach production quietly.

**TypeScript 7 with the peer dependency overridden.** The peer range is not
advisory. The rules would fail at runtime against an API that no longer exists.

**Two compilers, 7 for building and 6 for linting.** Two type checkers
disagreeing about the same code, with no way to tell which one is right. A
codebase where the build passes and the lint fails for reasons neither tool can
explain is worse than a slow build.

## Consequences

Type checking is slower than it needs to be. On this workspace it is a few
seconds, which is not currently worth anything to fix.

The compiler is pinned exactly rather than by range, so the upgrade is a
deliberate act rather than something that happens during an unrelated install.

## When to revisit

When `typescript-eslint` ships support for TypeScript 7. Watch
[typescript-eslint#10884](https://github.com/typescript-eslint/typescript-eslint/issues/10884)
or its successor. The upgrade should then be a one-line change to the catalog
plus a full lint run.
