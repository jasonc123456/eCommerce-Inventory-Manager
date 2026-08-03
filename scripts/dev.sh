#!/usr/bin/env bash
#
# Runs a command inside the application container.
#
#   ./scripts/dev.sh pnpm install
#   ./scripts/dev.sh pnpm test
#   ./scripts/dev.sh bash
#
# The container bind-mounts this repository, so node_modules and build output
# land on the host and the editor can read them. It runs as the host user, so
# nothing it writes is root-owned.
#
# Two stacks are supported, and this script picks whichever applies:
#
#   1. A real deployment. If a docker-compose.yml exists at the deployment root
#      (the grandparent of this repository), that is the operational stack for
#      this host and is used as-is. It is untracked and lives outside the
#      repository on purpose (specification section 23, D-092).
#
#   2. A plain checkout. Otherwise the portable docker-compose.dev.yml in this
#      repository is used, which needs no deployment-root layout.
#
# If you have Node 24 and pnpm 11 natively, skip this and run pnpm directly.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_ROOT="$(cd "${REPO_ROOT}/../.." && pwd)"

if [ -f "${DEPLOY_ROOT}/docker-compose.yml" ]; then
  COMPOSE_FILE="${DEPLOY_ROOT}/docker-compose.yml"
  COMPOSE_DIR="${DEPLOY_ROOT}"
  SERVICE="app"
else
  COMPOSE_FILE="${REPO_ROOT}/docker-compose.dev.yml"
  COMPOSE_DIR="${REPO_ROOT}"
  SERVICE="dev"
  # Docker creates a missing bind-mount source as root, which stops PostgreSQL
  # from starting as the host user. Create it first so it is owned correctly.
  mkdir -p "${REPO_ROOT}/.devdata/postgres"
fi

cd "${COMPOSE_DIR}"

CONTAINER="$(docker compose -f "${COMPOSE_FILE}" ps -q "${SERVICE}" 2>/dev/null || true)"

if [ -z "${CONTAINER}" ] || [ "$(docker inspect -f '{{.State.Running}}' "${CONTAINER}" 2>/dev/null)" != "true" ]; then
  echo "Starting the ${SERVICE} stack from ${COMPOSE_FILE}..." >&2
  docker compose -f "${COMPOSE_FILE}" up -d --build
  CONTAINER="$(docker compose -f "${COMPOSE_FILE}" ps -q "${SERVICE}")"
fi

if [ "$#" -eq 0 ]; then
  set -- bash
fi

DOCKER_TTY_FLAGS=()
if [ -t 0 ] && [ -t 1 ]; then
  DOCKER_TTY_FLAGS=(-it)
fi

exec docker exec "${DOCKER_TTY_FLAGS[@]}" -u dev -w /workspace "${CONTAINER}" "$@"
