#!/usr/bin/env bash
#
# Restores an encrypted logical backup (section 23).
#
#   ./scripts/restore.sh data/backups/eim-daily-20260301T030000Z.sql.age --into eim_restore_check
#   ./scripts/restore.sh data/backups/eim-daily-20260301T030000Z.sql.age --into eim --i-mean-it
#
# This command destroys data. Section 27 requires that commands which mutate or
# restore identify "prerequisites, backup, expected output, verification,
# rollback, and irreversible effects", so read this header before running it.
#
#   Prerequisites  The private key matching EIM_BACKUP_PUBLIC_KEY. It is not on
#                  this host by design (D-143). Provide it as a file and pass
#                  --identity, or paste it when prompted.
#
#   Irreversible   Restoring into the live database drops every table in it
#                  first. There is no undo. `--into` defaults to a scratch
#                  database for that reason, and overwriting the live one needs
#                  --i-mean-it as well.
#
#   Verification   The script compares the artifact's sha256 against its
#                  manifest before decrypting anything, then reports the schema
#                  version and row counts of a few anchor tables afterwards.
#
#   Rollback       Take a backup first. The script refuses to overwrite a live
#                  database that has no backup from the last hour.
#
# The quarterly drill section 23 asks for is this script with its default
# `--into`: restore into a scratch database, read the counts, record the result
# against the backup row with --record.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_ROOT="$(cd "${REPO_ROOT}/../.." && pwd)"
COMPOSE_FILE="${DEPLOY_ROOT}/docker-compose.yml"

ARTIFACT=""
TARGET_DB="eim_restore_check"
IDENTITY=""
CONFIRMED="no"
RECORD="no"

while [ $# -gt 0 ]; do
  case "$1" in
    --into) TARGET_DB="${2:?--into needs a database name}"; shift 2 ;;
    --identity) IDENTITY="${2:?--identity needs a path}"; shift 2 ;;
    --i-mean-it) CONFIRMED="yes"; shift ;;
    --record) RECORD="yes"; shift ;;
    --help|-h) sed -n '2,31p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) ARTIFACT="$1"; shift ;;
  esac
done

if [ -z "${ARTIFACT}" ]; then
  echo "Give the path of a .sql.age artifact. --help explains the rest." >&2
  exit 2
fi

if [ ! -f "${ARTIFACT}" ]; then
  echo "No such artifact: ${ARTIFACT}" >&2
  exit 1
fi

if [ ! -f "${COMPOSE_FILE}" ]; then
  echo "No docker-compose.yml at ${DEPLOY_ROOT}." >&2
  exit 1
fi

compose() { docker compose -f "${COMPOSE_FILE}" "$@"; }
psql_exec() { compose exec -T postgres psql -v ON_ERROR_STOP=1 -U eim -d "${1}" -Aqt -c "${2}"; }

# ---------------------------------------------------------------------------
# Verify before decrypting
# ---------------------------------------------------------------------------
#
# The checksum is checked first because it is the cheap test, and because a
# truncated artifact that decrypts halfway is a worse thing to discover with a
# dropped schema behind you.

MANIFEST="${ARTIFACT}.manifest.json"

if [ -f "${MANIFEST}" ]; then
  EXPECTED="$(grep -o '"sha256"[^,]*' "${MANIFEST}" | cut -d'"' -f4)"
  ACTUAL="$(sha256sum "${ARTIFACT}" | cut -d' ' -f1)"

  if [ "${EXPECTED}" != "${ACTUAL}" ]; then
    echo "The artifact does not match its manifest." >&2
    echo "  expected ${EXPECTED}" >&2
    echo "  actual   ${ACTUAL}" >&2
    echo "Do not restore this. Find another copy." >&2
    exit 1
  fi

  echo "Checksum matches the manifest."
else
  echo "No manifest beside this artifact; the checksum cannot be verified." >&2
  echo "Continuing, because a backup taken before manifests existed is still a backup." >&2
fi

# ---------------------------------------------------------------------------
# Refuse to be careless with the live database
# ---------------------------------------------------------------------------

if [ "${TARGET_DB}" = "eim" ]; then
  if [ "${CONFIRMED}" != "yes" ]; then
    echo "Restoring into the live database drops every table in it first." >&2
    echo "Re-run with --i-mean-it if that is what you want." >&2
    exit 1
  fi

  RECENT="$(psql_exec eim "select count(*) from backup_runs
                            where outcome = 'succeeded'
                              and completed_at > now() - interval '1 hour';" | tr -d '[:space:]')"

  if [ "${RECENT}" = "0" ]; then
    echo "No successful backup in the last hour." >&2
    echo "Take one first: ./scripts/backup.sh --kind pre_upgrade" >&2
    echo "Restoring without a rollback point is how one bad afternoon becomes two." >&2
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Restore
# ---------------------------------------------------------------------------

echo "Restoring into database '${TARGET_DB}'..."

psql_exec postgres "drop database if exists \"${TARGET_DB}\";" >/dev/null
psql_exec postgres "create database \"${TARGET_DB}\" owner eim;" >/dev/null

DECRYPT=(compose run --rm -T --entrypoint age backup --decrypt)

if [ -n "${IDENTITY}" ]; then
  if [ ! -f "${IDENTITY}" ]; then
    echo "No such identity file: ${IDENTITY}" >&2
    exit 1
  fi
  # Passed on stdin rather than mounted, so the private key does not land in a
  # bind mount on the host it is supposed to be absent from.
  DECRYPT+=(--identity /dev/stdin)
  # shellcheck disable=SC2094  # the identity and the artifact are different files
  cat "${IDENTITY}" "${ARTIFACT}" | "${DECRYPT[@]}" \
    | compose exec -T postgres psql -v ON_ERROR_STOP=1 -U eim -d "${TARGET_DB}" >/dev/null
else
  echo "No --identity given; age will prompt for a passphrase."
  "${DECRYPT[@]}" < "${ARTIFACT}" \
    | compose exec -T postgres psql -v ON_ERROR_STOP=1 -U eim -d "${TARGET_DB}" >/dev/null
fi

# ---------------------------------------------------------------------------
# Say what arrived
# ---------------------------------------------------------------------------

echo
echo "Restored. What is in it:"
echo "  schema version   $(psql_exec "${TARGET_DB}" 'select max(version) from eim_schema_migrations;' | tr -d '[:space:]')"

for table in businesses users canonical_items inventory_ledger orders; do
  COUNT="$(psql_exec "${TARGET_DB}" "select count(*) from ${table};" 2>/dev/null | tr -d '[:space:]' || echo '-')"
  printf '  %-16s %s\n' "${table}" "${COUNT}"
done

if [ "${RECORD}" = "yes" ]; then
  NAME="$(basename "${ARTIFACT}")"
  psql_exec eim "update backup_runs
                    set restore_verified_at = now(),
                        restore_notes = 'restored into ${TARGET_DB//\'/\'\'}'
                  where artifact_name = '${NAME//\'/\'\'}';" >/dev/null
  echo
  echo "Recorded the drill against ${NAME}."
fi

if [ "${TARGET_DB}" != "eim" ]; then
  echo
  echo "This was a drill. Drop the scratch database when you are done:"
  echo "  docker compose -f ${COMPOSE_FILE} exec postgres psql -U eim -d postgres -c 'drop database \"${TARGET_DB}\";'"
fi
