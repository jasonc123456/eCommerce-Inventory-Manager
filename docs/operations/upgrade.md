# Upgrading and rolling back

## Before you start

```bash
cd "$DEPLOY_ROOT/workspace/eCommerce-Inventory-Manager"
git pull                                # the scripts, not the application
./scripts/upgrade.sh --preflight-only
```

Preflight reports everything at once rather than stopping at the first problem,
because somebody standing in front of a broken deployment wants the list.

It checks `.env` exists and is owner-only, that every bind mount exists and is
owned by the configured uid and gid, that there is storage headroom, that a
backup key is configured, that the image architecture matches the host, and that
the database is reachable and at a known schema version.

## Upgrading

```bash
./scripts/upgrade.sh --to ghcr.io/jasonc123456/ecommerce-inventory-manager@sha256:...
```

Pin the **digest**, not a tag. Every release's notes print the exact line. A tag
is a name somebody can move; a digest is the image.

The script then: runs preflight, takes and verifies a `pre_upgrade` backup,
pulls the release, records the outgoing image for rollback, runs the one-shot
migration service, starts web and worker, and waits for **readiness** rather
than liveness. Liveness only says a process started — a build that disagrees
with its schema answers every request with 503 and is perfectly alive.

### Verify

```bash
curl -fsS http://127.0.0.1:3000/api/ready
docker compose logs --since 5m web worker | grep -i error
```

Then open `/health` as an installation administrator and confirm `versions`
reads "web and worker both …". A mixed rollout is a worker running the previous
release against the new schema.

## Rolling back

```bash
./scripts/upgrade.sh --rollback
```

Application code only. **Rolling the image back does not roll the schema back**,
and section 23 permits a code rollback only while the migrated schema remains
compatible. Every release's notes say whether its migrations are backward
compatible.

If they are not, the path is the pre-upgrade backup:

```bash
./scripts/upgrade.sh --to <previous digest>
./scripts/restore.sh data/backups/eim-pre_upgrade-<stamp>.sql.age \
  --identity ~/inventory-manager-backup.key --into eim --i-mean-it
```

There is no automatic down-migration and there will not be. A destructive
migration run backwards without a person reading it is how a bad afternoon
becomes an unrecoverable one.

## Upgrading a source-checkout deployment

An installation serving from a checkout rather than a published image uses
`build-and-swap.sh` at DEPLOY_ROOT instead. Same shape: build the new release
into a directory the running server is not reading, apply migrations, swap,
restart, confirm readiness, and leave the previous build on disk as the rollback
target (D-147).

## What never happens

No unattended updater. No rebuild from a mutable branch. No Docker socket
mounted into the application. Section 23 excludes all three, and the absence is
in the Compose template and this script rather than in a policy document.
