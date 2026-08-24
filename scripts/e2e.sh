#!/usr/bin/env bash
#
# Runs the browser tier (section 25, D-116).
#
#   ./scripts/e2e.sh                      # every project
#   ./scripts/e2e.sh --project chromium   # one project
#   ./scripts/e2e.sh --grep deletion      # anything else playwright accepts
#   ./scripts/e2e.sh report               # serve the last HTML report on :9323
#   ./scripts/e2e.sh down                 # stop the stack
#
# Everything happens inside docker-compose.e2e.yml: the browsers, their system
# libraries, Node, the database, and the mail capture. Nothing is installed on
# the host, which is the same rule the rest of this deployment follows.
#
# The order below is the part worth reading. The database is emptied and
# migrated *before* Playwright starts, because Playwright is what starts the
# application server and the first thing the suite proves is that a clean
# installation can be claimed — which is only true on an installation nobody has
# claimed yet.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE=(docker compose -f "${REPO_ROOT}/docker-compose.e2e.yml")

# Where this tier's build lands. Must match E2E_DIST_DIR in
# apps/e2e/src/environment.ts, which is where Playwright learns to find the
# server it starts; a mismatch fails loudly at startup rather than quietly.
E2E_DIST_DIR=".next.e2e"

cd "${REPO_ROOT}"

if [ "${1:-}" = "down" ]; then
  "${COMPOSE[@]}" down --remove-orphans
  exit 0
fi

# Match the host owner so node_modules, the build output, and the report land
# owned by the person who ran this rather than by root.
DEV_UID="$(id -u)" DEV_GID="$(id -g)" "${COMPOSE[@]}" up -d --build

# CI is forwarded rather than inherited: `docker compose exec` passes none of
# the host environment, and the suite reads CI to decide whether to retry, to
# refuse a `.only`, and to reuse an already-running server.
run() {
  docker compose -f "${REPO_ROOT}/docker-compose.e2e.yml" exec -T -u dev -w /workspace \
    -e "CI=${CI:-}" e2e "$@"
}

if [ "${1:-}" = "report" ]; then
  echo "The report is at http://127.0.0.1:9323 — stop it with Ctrl-C." >&2
  docker compose -f "${REPO_ROOT}/docker-compose.e2e.yml" exec \
    -u dev -w /workspace/apps/e2e -p 9323:9323 e2e pnpm report
  exit 0
fi

# NODE_ENV is production in this container so the application under test is the
# one that ships. pnpm would read that as "omit devDependencies", and the whole
# browser tier is a devDependency, so the install alone is told otherwise.
echo "==> installing" >&2
run env NODE_ENV=development pnpm install --frozen-lockfile

# Into a build directory of its own, never apps/web/.next.
#
# This stack bind-mounts the working tree, so a build here writes to the same
# files any other process is reading from it. On a host that serves the site
# from apps/web/.next — which is what this deployment does until M8 publishes an
# image — an ordinary `next build` deletes the chunks the running server is
# still handing out, and the site starts answering 500 for assets its own HTML
# asks for. It survives a restart, because by then the build it was serving is
# gone. Building somewhere else is the whole fix: nothing else needs to know.
echo "==> building the application under test" >&2
run env NEXT_DIST_DIR="${E2E_DIST_DIR}" pnpm --filter @eim/web build

# `next build` rewrites apps/web/next-env.d.ts to reference whichever distDir it
# was given, and that file is tracked. Left alone, every run of this tier dirties
# the working tree with a reference to a directory only this tier builds — which
# then fails `pnpm typecheck` for anyone who has not run it. The deployment's
# build-and-swap.sh restores it for the same reason.
git checkout -- apps/web/next-env.d.ts 2>/dev/null || true

# Next.js splits the standalone output from the static assets and the public
# directory on purpose: the server tree omits everything the build proved was
# unreachable. The release image copies all three into place (see the
# Dockerfile), and so does this, because the tier serves the same tree the
# release does rather than the one `next start` would serve.
#
# The directory inside the standalone tree is named after distDir, so it is
# discovered rather than assumed — the name is Next.js's to choose, and a wrong
# guess would copy the assets somewhere the server never looks.
echo "==> assembling the standalone server" >&2
run env "E2E_DIST_DIR=${E2E_DIST_DIR}" sh -c '
  set -e
  dist="apps/web/${E2E_DIST_DIR}"
  root="${dist}/standalone/apps/web"
  inner="$(ls -d "${root}"/.next* | head -n 1)"
  rm -rf "${inner}/static" "${root}/public"
  cp -r "${dist}/static" "${inner}/static"
  cp -r apps/web/public "${root}/public"
'

echo "==> resetting the database" >&2
run pnpm --filter @eim/e2e exec tsx src/cli/reset.ts

echo "==> running the browser tier" >&2
run pnpm --filter @eim/e2e test:browser "$@"
