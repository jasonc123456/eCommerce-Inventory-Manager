#!/usr/bin/env bash
#
# Takes one encrypted logical backup (section 23).
#
#   ./scripts/backup.sh                 # a manual backup
#   ./scripts/backup.sh --kind daily    # what the host's scheduler runs nightly
#   ./scripts/backup.sh --kind pre_upgrade
#
# Everything happens inside containers. Nothing is installed on the host: the
# dump comes from the postgres image's own pg_dump, and the encryption from the
# application image's `age`.
#
# Four properties this script exists to guarantee.
#
# The backup is encrypted before it is written, not after. A plaintext dump that
# exists for even a moment is a plaintext dump that exists in a filesystem
# snapshot, and the whole point of D-143 is that the private key is not on this
# machine — so the window in which this host could read the data has to be zero.
#
# The row is written before the dump starts. A backup that dies halfway leaves a
# `running` row rather than no row, because a missing row and a failed one look
# identical from the outside and only one of them is honest.
#
# The rotation never prunes a `pre_upgrade` backup. Section 23 keeps seven
# daily, four weekly, and twelve monthly; the one taken before an upgrade is
# what a rollback needs, and rotating it out on the eighth day would remove the
# only thing standing between a bad migration and a bad week.
#
# The checksum is over the encrypted artifact. It verifies the file the operator
# actually has, rather than something that was true before encryption.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_ROOT="$(cd "${REPO_ROOT}/../.." && pwd)"
COMPOSE_FILE="${DEPLOY_ROOT}/docker-compose.yml"
BACKUP_DIR="${DEPLOY_ROOT}/data/backups"

KIND="manual"

while [ $# -gt 0 ]; do
  case "$1" in
    --kind) KIND="${2:?--kind needs a value}"; shift 2 ;;
    --help|-h)
      sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "${KIND}" in
  daily|weekly|monthly|pre_upgrade|manual) ;;
  *) echo "kind must be daily, weekly, monthly, pre_upgrade, or manual" >&2; exit 2 ;;
esac

if [ ! -f "${COMPOSE_FILE}" ]; then
  echo "No docker-compose.yml at ${DEPLOY_ROOT}." >&2
  echo "This script backs up a real deployment; see deploy/docker-compose.yml for the template." >&2
  exit 1
fi

# shellcheck disable=SC1091  # the operator's own file, outside this repository
set -a; . "${DEPLOY_ROOT}/.env"; set +a

if [ -z "${EIM_BACKUP_PUBLIC_KEY:-}" ]; then
  echo "EIM_BACKUP_PUBLIC_KEY is not set." >&2
  echo "Backups are encrypted to a key whose private half must live off this host (D-143)." >&2
  echo "Generate one somewhere else with 'age-keygen', keep the private half there," >&2
  echo "and put the public half in .env." >&2
  exit 1
fi

mkdir -p "${BACKUP_DIR}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARTIFACT="eim-${KIND}-${STAMP}.sql.age"
TARGET="${BACKUP_DIR}/${ARTIFACT}"

compose() { docker compose -f "${COMPOSE_FILE}" "$@"; }

psql_exec() {
  compose exec -T postgres psql -v ON_ERROR_STOP=1 -U eim -d eim -Aqt -c "$1"
}

# The row comes first, so an interrupted backup is visible as one.
RUN_ID="$(psql_exec "insert into backup_runs (kind) values ('${KIND}') returning id;" | tr -d '[:space:]')"

fail() {
  local reason="$1"
  # Quoting for SQL by doubling single quotes. The reason is written by this
  # script, never by a command's stderr: a pg_dump error carries the connection
  # string, and this row is read on a screen.
  psql_exec "update backup_runs
                set outcome = 'failed', completed_at = now(),
                    failure_reason = '${reason//\'/\'\'}'
              where id = '${RUN_ID}';" >/dev/null || true
  echo "Backup failed: ${reason}" >&2
  exit 1
}

echo "Taking a ${KIND} backup..."

# One pipeline, so the plaintext dump never touches a disk on this host.
# `--no-owner` and `--no-privileges` keep the dump restorable into a database
# whose role names differ, which is what makes a host migration a restore rather
# than an afternoon of GRANT statements.
if ! compose exec -T postgres pg_dump -U eim -d eim --no-owner --no-privileges \
    | compose run --rm -T --entrypoint age backup -r "${EIM_BACKUP_PUBLIC_KEY}" -o /dev/stdout \
    > "${TARGET}"; then
  rm -f "${TARGET}"
  fail "the dump or the encryption step did not complete"
fi

if [ ! -s "${TARGET}" ]; then
  rm -f "${TARGET}"
  fail "the backup was empty"
fi

SIZE="$(stat -c %s "${TARGET}")"
SHA="$(sha256sum "${TARGET}" | cut -d' ' -f1)"

# A manifest beside the artifact, so the file is identifiable without the
# database that recorded it — which is exactly the situation a restore is.
cat > "${TARGET}.manifest.json" <<JSON
{
  "artifact": "${ARTIFACT}",
  "kind": "${KIND}",
  "takenAt": "${STAMP}",
  "sizeBytes": ${SIZE},
  "sha256": "${SHA}",
  "schemaVersion": "$(psql_exec 'select max(version) from eim_schema_migrations;' | tr -d '[:space:]')",
  "encryption": "age, to the public key in EIM_BACKUP_PUBLIC_KEY",
  "note": "The private key is not on this host. Restoring needs it (D-143)."
}
JSON

psql_exec "update backup_runs
              set outcome = 'succeeded', completed_at = now(),
                  artifact_name = '${ARTIFACT}', size_bytes = ${SIZE}, sha256 = '${SHA}'
            where id = '${RUN_ID}';" >/dev/null

echo "Wrote ${TARGET} (${SIZE} bytes)"
echo "sha256 ${SHA}"

# ---------------------------------------------------------------------------
# Rotation (section 23: seven daily, four weekly, twelve monthly)
# ---------------------------------------------------------------------------
#
# Applied per kind, and never to pre_upgrade or manual. An operator who took a
# backup by hand had a reason; deleting it on a schedule they did not set is the
# kind of helpfulness nobody thanks you for.

prune() {
  local kind="$1" keep="$2"
  local -a artifacts
  mapfile -t artifacts < <(ls -1t "${BACKUP_DIR}"/eim-"${kind}"-*.sql.age 2>/dev/null || true)

  if [ "${#artifacts[@]}" -le "${keep}" ]; then
    return
  fi

  for stale in "${artifacts[@]:${keep}}"; do
    echo "Removing ${stale##*/} (keeping ${keep} ${kind})"
    rm -f "${stale}" "${stale}.manifest.json"
  done
}

prune daily 7
prune weekly 4
prune monthly 12

echo "Done."
