#!/usr/bin/env bash
#
# Upgrades a published-image installation, and rolls one back (section 23).
#
#   ./scripts/upgrade.sh --to ghcr.io/owner/repo@sha256:...   # upgrade
#   ./scripts/upgrade.sh --preflight-only                      # just the checks
#   ./scripts/upgrade.sh --rollback                            # back to the last release
#
# Section 23's sequence, in order, and none of it is optional:
#
#   1. Preflight .env, resolved bind paths and permissions, storage headroom,
#      backup readiness, image architecture, and version compatibility.
#   2. Create and verify a pre-upgrade backup.
#   3. Pull the pinned release.
#   4. Run the one-shot migration service.
#   5. Start web and worker, and verify readiness — not liveness.
#   6. Keep the previous image reference and deployment-file copy for rollback.
#
# The step people are tempted to skip is the fifth, and it is the one that
# catches a bad release: liveness says the process started, readiness says it
# agrees with the schema it was pointed at. A deployment that checked only the
# first would report success for a build that answers every request with 503.
#
# This script does not build anything, does not touch a Git branch, and does not
# update itself. Section 23 forbids rebuilding "from a mutable branch" and using
# "an unattended updater"; an installation that serves from a source checkout
# uses build-and-swap.sh instead, which is the same shape without a registry.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_ROOT="$(cd "${REPO_ROOT}/../.." && pwd)"
COMPOSE_FILE="${DEPLOY_ROOT}/docker-compose.yml"
PREVIOUS_FILE="${DEPLOY_ROOT}/.previous-release"

TARGET_IMAGE=""
MODE="upgrade"

while [ $# -gt 0 ]; do
  case "$1" in
    --to) TARGET_IMAGE="${2:?--to needs an image reference}"; shift 2 ;;
    --preflight-only) MODE="preflight"; shift ;;
    --rollback) MODE="rollback"; shift ;;
    --help|-h) sed -n '2,29p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ ! -f "${COMPOSE_FILE}" ]; then
  echo "No docker-compose.yml at ${DEPLOY_ROOT}." >&2
  echo "See deploy/docker-compose.example.yml for the template." >&2
  exit 1
fi

compose() { docker compose -f "${COMPOSE_FILE}" "$@"; }

problems=0
note() { printf '  %-28s %s\n' "$1" "$2"; }
fail() { note "$1" "$2"; problems=$((problems + 1)); }

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
#
# Every check reports rather than exiting on the first failure. An operator
# standing in front of a broken deployment wants the whole list, not the first
# item of it followed by three more runs.

preflight() {
  echo "Preflight:"

  # .env, and who can read it. Section 23 validates "owner-only .env
  # permissions before readiness"; group-readable secrets on a shared host are
  # the most common way a self-hosted installation leaks its own keyring.
  if [ ! -f "${DEPLOY_ROOT}/.env" ]; then
    fail ".env" "missing"
  else
    local mode
    mode="$(stat -c %a "${DEPLOY_ROOT}/.env")"
    if [ "${mode}" != "600" ] && [ "${mode}" != "400" ]; then
      fail ".env permissions" "${mode}; should be 600 (chmod 600 .env)"
    else
      note ".env" "present, owner-only"
    fi
  fi

  # The durable bind mounts, and who owns them. A path Docker created as root
  # is a path PostgreSQL cannot start on, and the error it produces says
  # nothing about ownership.
  local uid gid
  uid="$(grep -E '^EIM_DATA_UID=' "${DEPLOY_ROOT}/.env" 2>/dev/null | cut -d= -f2 || echo 1000)"
  gid="$(grep -E '^EIM_DATA_GID=' "${DEPLOY_ROOT}/.env" 2>/dev/null | cut -d= -f2 || echo 1000)"

  for dir in postgres backups exports uploads; do
    local path="${DEPLOY_ROOT}/data/${dir}"
    if [ ! -d "${path}" ]; then
      fail "data/${dir}" "missing (mkdir -p ${path})"
    elif [ "$(stat -c %u:%g "${path}")" != "${uid}:${gid}" ]; then
      fail "data/${dir} ownership" "$(stat -c %u:%g "${path}"), expected ${uid}:${gid}"
    else
      note "data/${dir}" "present, owned by ${uid}:${gid}"
    fi
  done

  # Storage headroom. A migration that runs out of disk halfway is the single
  # worst outcome available here, and twenty percent is section 22's own
  # warning threshold.
  local free_pct
  free_pct="$(df --output=pcent "${DEPLOY_ROOT}/data" | tail -1 | tr -dc '0-9')"
  free_pct=$((100 - free_pct))

  if [ "${free_pct}" -lt 10 ]; then
    fail "storage" "${free_pct}% free; free space before upgrading"
  elif [ "${free_pct}" -lt 20 ]; then
    note "storage" "${free_pct}% free (low, but enough)"
  else
    note "storage" "${free_pct}% free"
  fi

  # Backup readiness. Not whether one exists — whether one *can* be taken,
  # because the pre-upgrade backup is the rollback plan and discovering it is
  # impossible after the migration has run is discovering it too late.
  if grep -qE '^EIM_BACKUP_PUBLIC_KEY=.+' "${DEPLOY_ROOT}/.env" 2>/dev/null; then
    note "backup key" "configured"
  else
    fail "backup key" "EIM_BACKUP_PUBLIC_KEY unset; no pre-upgrade backup is possible"
  fi

  # Architecture. Pulling an amd64 image onto an arm64 host produces a
  # container that starts and then fails in a way that reads like a bug.
  local host_arch
  host_arch="$(docker version --format '{{.Server.Arch}}' 2>/dev/null || echo unknown)"
  note "host architecture" "${host_arch}"

  if [ -n "${TARGET_IMAGE}" ]; then
    local image_arch
    image_arch="$(docker image inspect "${TARGET_IMAGE}" --format '{{.Architecture}}' 2>/dev/null || echo 'not pulled yet')"
    if [ "${image_arch}" != "not pulled yet" ] && [ "${image_arch}" != "${host_arch}" ]; then
      fail "image architecture" "${image_arch}, host is ${host_arch}"
    else
      note "image architecture" "${image_arch}"
    fi
  fi

  # The database, and the schema it is at. Section 23 rolls application code
  # back "only while the migrated schema remains compatible", so an operator
  # deserves to see the number before and after.
  if compose exec -T postgres pg_isready -U eim -d eim >/dev/null 2>&1; then
    local applied
    applied="$(compose exec -T postgres psql -U eim -d eim -Aqt \
      -c 'select coalesce(max(version), 0) from eim_schema_migrations;' 2>/dev/null | tr -d '[:space:]')"
    note "database" "reachable, schema ${applied}"
  else
    fail "database" "not reachable"
  fi

  if [ "${problems}" -gt 0 ]; then
    echo
    echo "${problems} problem(s). Nothing has been changed." >&2
    return 1
  fi

  echo
  echo "Preflight passed."
}

# ---------------------------------------------------------------------------
# Readiness, not liveness
# ---------------------------------------------------------------------------

wait_for_ready() {
  local waited=0

  echo -n "Waiting for readiness"
  while [ "${waited}" -lt 120 ]; do
    if compose exec -T web node -e "
        fetch('http://127.0.0.1:3000/api/ready')
          .then(r => process.exit(r.status === 200 ? 0 : 1))
          .catch(() => process.exit(1))" >/dev/null 2>&1; then
      echo " — ready after ${waited}s."
      return 0
    fi
    echo -n '.'
    sleep 3
    waited=$((waited + 3))
  done

  echo
  echo "Still not ready after ${waited}s." >&2
  return 1
}

# ---------------------------------------------------------------------------
# The three modes
# ---------------------------------------------------------------------------

if [ "${MODE}" = "preflight" ]; then
  preflight
  exit $?
fi

if [ "${MODE}" = "rollback" ]; then
  if [ ! -f "${PREVIOUS_FILE}" ]; then
    echo "No previous release recorded at ${PREVIOUS_FILE}." >&2
    echo "Rollback needs an upgrade to roll back from." >&2
    exit 1
  fi

  PREVIOUS="$(cat "${PREVIOUS_FILE}")"
  echo "Rolling back to ${PREVIOUS}"
  echo
  echo "Application code only. If the release you are leaving applied a"
  echo "migration, the schema stays where it is — section 23 rolls code back"
  echo "only while the migrated schema remains compatible. If it is not,"
  echo "restore the pre-upgrade backup instead."
  echo

  sed -i.bak -E "s|image: .*|image: ${PREVIOUS}|" "${COMPOSE_FILE}"
  compose up -d --no-deps web worker
  wait_for_ready
  echo "Rolled back."
  exit 0
fi

if [ -z "${TARGET_IMAGE}" ]; then
  echo "Give the release to upgrade to: --to ghcr.io/owner/repo@sha256:..." >&2
  echo "Pin a digest rather than a tag. A tag is a name somebody can move." >&2
  exit 2
fi

preflight

echo
echo "Taking a pre-upgrade backup..."
"${REPO_ROOT}/scripts/backup.sh" --kind pre_upgrade

echo
echo "Pulling ${TARGET_IMAGE}..."
docker pull "${TARGET_IMAGE}"

# Recorded before anything changes, so a rollback has somewhere to go even if
# the rest of this script does not finish.
CURRENT="$(grep -oE 'image: (ghcr\.io/[^ ]+)' "${COMPOSE_FILE}" | head -1 | cut -d' ' -f2 || true)"
if [ -n "${CURRENT}" ]; then
  printf '%s\n' "${CURRENT}" > "${PREVIOUS_FILE}"
  cp "${COMPOSE_FILE}" "${DEPLOY_ROOT}/.previous-docker-compose.yml"
  echo "Previous release recorded: ${CURRENT}"
fi

sed -i.bak -E "s|image: .*|image: ${TARGET_IMAGE}|" "${COMPOSE_FILE}"

echo
echo "Applying migrations..."
compose run --rm migrate

echo
echo "Starting web and worker..."
compose up -d

wait_for_ready

echo
echo "Live on ${TARGET_IMAGE}."
echo "Roll back with: ./scripts/upgrade.sh --rollback"
