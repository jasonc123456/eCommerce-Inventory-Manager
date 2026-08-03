# 8. Next.js App Router and Tailwind for the web tier

**Status:** Accepted (M0)

## Context

The web tier serves an operator interface, the OAuth callbacks, the webhook
receivers, and a server-sent-events stream. Section 21 requires WCAG 2.2 AA.
Section 19 requires a nonce-based Content-Security-Policy. Section 23 wants a
small runtime image.

## Decision

**Next.js 16 with the App Router**, `output: 'standalone'`, and **Tailwind CSS
v4**. Accessible component primitives will come from Radix by way of shadcn/ui
when the interface is built in M1.

## Why

Server components keep credential handling and authorization on the server by
default rather than by discipline. In an application whose central risk is
cross-business data exposure, a default that has to be opted out of is worth
more than one that has to be opted into.

`output: 'standalone'` produces a self-contained server directory, so the
runtime image ships without `node_modules` or a package manager. Smaller image,
smaller attack surface to keep patched.

Tailwind v4 has no runtime CSS-in-JS, which matters because a nonce-based CSP
and runtime style injection are directly at odds. Its configuration lives in CSS
rather than a JavaScript config file, so there is one less build input.

Radix primitives handle focus management, keyboard interaction, and ARIA
semantics — the parts of WCAG 2.2 AA that are laborious to get right and easy to
get subtly wrong. shadcn/ui copies components into the repository rather than
adding a dependency, so they can be corrected in place.

## Alternatives rejected

**Remix or React Router.** A good fit and a smaller framework. Next.js was
chosen for the larger self-hosting ecosystem and the standalone output;
a self-hosted project benefits from the deployment path most people have already
debugged.

**A separate API and a client-rendered front end.** Two deployables, two
authorization surfaces, and CORS between them. No benefit here: there is no
second consumer of the API.

**A component library with built-in styling (MUI, Mantine).** Faster to a
working screen, and both use runtime style injection that fights the CSP.

## Consequences

Next.js's release cadence is fast. The version is pinned exactly in the catalog
and upgraded deliberately.

`next build` inherits `NODE_ENV` rather than forcing production. The development
container sets `NODE_ENV=development` for every process, and building under it
produces a server bundle mixing React's development and production internals,
which fails while prerendering Next's built-in error page. The build script sets
`NODE_ENV=production` explicitly so the build means what it says regardless of
the shell it runs from.

## When to revisit

If the standalone output stops being a reliable deployment target, or if server
components turn out to complicate the SSE and webhook paths more than they help
the interface. Neither is visible from M0.
