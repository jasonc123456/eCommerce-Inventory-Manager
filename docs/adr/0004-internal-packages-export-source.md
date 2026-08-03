# 4. Internal packages export TypeScript source

**Status:** Accepted (M0)

## Context

The workspace has seven internal packages consumed by two applications. The
conventional arrangement is for each package to compile to `dist/` and export
that, which means the applications depend on build artifacts and every command —
typecheck, test, lint, dev server — has to run after a build of everything
upstream, in the right order.

The first attempt did exactly this and produced two immediate problems. Nothing
could typecheck before a full build, and Turbopack could not resolve the
NodeNext convention of importing `./x.js` to mean `./x.ts`, which is what the
packages emitted under `moduleResolution: nodenext`.

## Decision

Internal packages export their TypeScript source directly:

```json
{ "main": "./src/index.ts", "types": "./src/index.ts", "exports": { ".": "./src/index.ts" } }
```

They use `module: preserve` with bundler resolution and extensionless relative
imports. Every consumer is a bundler — Next.js for the web tier, esbuild for the
worker, Vitest for tests, tsx for the CLIs — so none of them needs the packages
compiled first.

This is only defensible because these packages are private and never published.
A published package must ship compiled JavaScript and declarations; consumers do
not compile their dependencies.

## Alternatives rejected

**Compile each package to `dist/`.** The conventional answer, and it makes every
command depend on a correct build order. It also produces the failure mode where
a stale `dist/` makes a test pass against code that is no longer in `src/`,
which is the worst kind of green build.

**Project references with composite builds.** TypeScript's own answer to this,
and it works, but it adds `tsconfig.build.json` and `.tsbuildinfo` per package
and gives incremental compilation to a workspace where a full check takes a few
seconds anyway. Complexity without a matching payoff.

**Keep `.js` specifiers and configure the bundlers around them.** Turbopack has
no clean way to do this for transpiled packages. Working around it would have
been fragile in exactly the tool that builds the production artifact.

## Consequences

`transpilePackages` in the Next.js configuration must list every internal
package the web tier imports. Forgetting one is a build error rather than a
silent problem.

The worker bundles with esbuild into a single file, which suits the runtime
image: no `node_modules` and no package manager in the container.

The packages cannot be published as-is. If one is ever extracted for reuse, it
gains a build step at that point, which is the right time to add one.

## When to revisit

If any of these packages is published, or if a consumer appears that is not a
bundler — a plain `node script.js` importing `@eim/domain`, for instance. Either
would require compiled output, and the change is contained to the package
manifests and tsconfigs.
