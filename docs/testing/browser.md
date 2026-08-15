# The browser tier

The only tier that opens a page.

Everything else in this repository tests decisions. `pnpm test` proves what a
function returns; `pnpm test:integration` proves what PostgreSQL does with it;
`apps/web/src/accessibility.test.ts` reads every screen's _source_ and asserts
structural properties — a first-level heading, no status carried by colour
alone, no positive `tabIndex`, no error text outside `Notice`.

None of them can see a rendered page. So none of them could see:

- a contrast ratio, which is a property of two colours a browser has resolved
  from custom properties;
- a layout that scrolls sideways at 320 pixels;
- a drawer whose links stay focusable behind the page it is covering;
- a form that silently needs JavaScript to submit;
- a link that a mail scanner spends before its recipient reads it.

All five are failures this tier caught on its first run. Three of them were real
and are fixed; the notes below say which.

## Running it

```bash
./scripts/e2e.sh                      # every project
./scripts/e2e.sh --project chromium   # one engine, much faster
./scripts/e2e.sh --grep deletion      # anything else Playwright accepts
./scripts/e2e.sh report               # serve the last HTML report on :9323
./scripts/e2e.sh down                 # stop the stack
```

Nothing is installed on the host. `docker-compose.e2e.yml` brings up the
browsers and their system libraries, Node, a disposable PostgreSQL in memory,
and a mail capture. The first run builds the image and downloads three browsers,
which takes a few minutes; afterwards it is cached.

## What it drives

Section 2 supports Chrome, Edge, Firefox, and Safari, including mobile Safari
and mobile Chrome. Those are three engines, and all three run:

| Project         | Engine                   | Runs                                             |
| --------------- | ------------------------ | ------------------------------------------------ |
| `install`       | Chromium                 | the setup journey every other project depends on |
| `chromium`      | Chromium                 | every spec                                       |
| `firefox`       | Gecko                    | `*.cross.spec.ts`                                |
| `webkit`        | WebKit                   | `*.cross.spec.ts`                                |
| `mobile-safari` | WebKit, iPhone viewport  | `*.cross.spec.ts`                                |
| `mobile-chrome` | Chromium, Pixel viewport | `*.cross.spec.ts`                                |

Only `*.cross.spec.ts` runs on all five. Rendering, focus, and layout are where
engines differ; a nine-step deletion journey is where they do not, and running
it five times would spend minutes re-proving the same server behaviour.

## What it runs against

The **standalone server**, started as `node apps/web/.next/standalone/apps/web/server.js`
— which is what the release image's `CMD` runs. Not `next start`: that against an
`output: 'standalone'` build is a combination Next.js prints a warning about, so
a tier using it would be proving things about a server no release runs (D-282).

In front of it, a TLS terminator (`apps/e2e/src/tls-proxy.ts`) holding a
self-signed certificate it generates for itself. That is not decoration. Section
19 requires `EIM_PUBLIC_URL` to be HTTPS in production and the configuration
loader refuses to start otherwise — correctly, and not something to work around
with a test-only exemption, because an exemption is a branch that decides
whether a security rule applies. Terminating TLS instead is also the shape
production runs in, so the tier exercises the forwarded headers that shape
produces rather than pretending they do not exist.

## The setup project

`tests/install.setup.ts` claims a clean installation through the interface:
request the setup link, read it out of the mailbox, present the setup secret,
sign in, create the first business. Every other spec depends on it and inherits
the session it saves.

This is deliberately the real journey rather than rows inserted into a database.
It is the "clean install from documentation" drill from
[the pilot runbook](../operations/pilot.md), run on every push, against the exact
gap that made this application unusable on a fresh database — `createBusiness`
did not exist, so signing in led to an app where every screen said you were not
a member of anything.

## Mail

Read from the capture service over its HTTP API (`apps/e2e/src/mailpit.ts`),
never from `sign_in_challenges`. A token read from the database would still pass
if the template dropped the link, if the carrier configuration was wrong, or if
nothing was ever sent.

`EIM_MAGIC_LINK_TOKEN_CARRIER` is `query` here because it is `query` in
production, where Office 365 Safe Links drops the URL fragment (D-182). That is
the setting the deployment actually runs and the one with no coverage anywhere
else.

## The sixty-second cooldown

Section 20 allows one sign-in request per address per minute, and the suite
serves it rather than switching it off (D-283). A limit a test can turn off is a
limit nobody is testing, and this one is the only thing between an address and
unlimited authentication mail. The cost is that specs which sign in raise their
timeout, which is visible at the top of each file.

`requestSignInLink` watches the mailbox rather than the notice on screen,
because section 20 gives the same generic sentence to a request that was
accepted, one for an unknown address, and one that was throttled. Reading the
screen to decide whether to retry would mean depending on exactly the
distinction the product refuses to make.

## What it found on the first run

Kept here because a test tier's value is easiest to judge from what it caught.

1. **The setup link was malformed on the query carrier.** `magicLinkUrl`
   appended `?t=` unconditionally, and installation setup points at
   `/setup?step=complete`, so the token arrived as part of the `step` value and
   the page showed step one again. Invisible on the default carrier, total on
   the one this installation runs — an installation that could not be claimed.
   Fixed in `packages/mail/src/templates.ts`.

2. **Two colour tokens failed WCAG 2.2 AA.** `--text-subtle` was 3.4:1 on the
   sunken surface in light mode and 4.5:1 on the raised surface in dark. Those
   are the sidebar's group headings and every statistic's label — the smallest
   text in the interface. Fixed in `apps/web/src/app/globals.css`.

3. **`Referrer-Policy: no-referrer` broke every form on the authentication
   pages for anybody without JavaScript.** The Fetch standard makes a browser
   send `Origin: null` on a POST that is a top-level navigation when the policy
   is `no-referrer`, and a Server Action refuses a request whose origin does not
   match its host. With JavaScript the submission is a fetch and carries a real
   origin, so the failure was invisible — on the sign-in screen, which is where
   people arrive when something has already gone wrong. Fixed by moving those
   pages to `strict-origin`, which sends the origin and nothing else: no path,
   no query, no token (D-281).

Two further findings were in the tests rather than in the application, and both
are worth knowing:

- A drawer moved off-screen by a transform is still "visible" to Playwright. The
  property that matters is that a keyboard cannot reach it, and the only honest
  way to ask that is to try focusing a link and see whether focus moved.
- `revalidatePath` unmounts the form that would have rendered an action's return
  message, so asserting on that message tests nothing. Assert on the server state
  the page now shows instead.

## What it still does not cover

- **Passkey registration and login.** The ceremony needs a virtual authenticator;
  section 25 already defers this and it is still deferred.
- **Real certificate handling.** The terminator is self-signed and the suite sets
  `ignoreHTTPSErrors`. Certificates belong to the deployment, not the
  application.
- **Live providers.** Nothing here calls eBay or WooCommerce, by standing
  instruction and by section 25.
