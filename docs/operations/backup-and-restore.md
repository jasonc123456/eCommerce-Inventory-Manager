# Backup and restore

The most important page here, and the one most often read for the first time on
a bad day. Section 23 requires nightly encrypted logical backups, a verified one
before every upgrade, and a full restore tested quarterly.

## How the encryption works, and why it matters

Backups are encrypted to an `age` public key. **The matching private key must not
be on this host.** That is the entire control (D-143): the keyring that decrypts
every stored credential is in `.env` on this machine, so a backup this machine
could also decrypt would give an attacker who reached the filesystem both halves.

Generate the pair somewhere else — a laptop, a password manager, a hardware
token's backing store:

```bash
age-keygen -o inventory-manager-backup.key     # keep this off the server
grep 'public key' inventory-manager-backup.key # put this in .env
```

Then in `DEPLOY_ROOT/.env`:

```
EIM_BACKUP_PUBLIC_KEY=age1...
```

If you lose the private key, every backup you hold is noise. Store it the way
you would store the only copy of a door key.

## Taking a backup

```bash
cd "$DEPLOY_ROOT/workspace/eCommerce-Inventory-Manager"
./scripts/backup.sh --kind daily
```

What it does, in order: records a `running` row, dumps through `pg_dump` in the
postgres container, encrypts in the same pipeline so no plaintext ever reaches
this disk, writes the artifact and a manifest to `DEPLOY_ROOT/data/backups`,
records the size and checksum, then prunes by the rotation.

Expected output ends with a path and a `sha256`. Anything else is a failure, and
the failure is also in `backup_runs` and on the health screen.

### Nightly

Use the host's scheduler; the application deliberately does not run a
sleep-until-3am container, because a container that has been dead for a month
looks exactly like one that is waiting.

```
# crontab -e
17 3 * * *   cd /srv/inventory-manager/workspace/eCommerce-Inventory-Manager && ./scripts/backup.sh --kind daily
23 3 * * 0   cd /srv/inventory-manager/workspace/eCommerce-Inventory-Manager && ./scripts/backup.sh --kind weekly
31 3 1 * *   cd /srv/inventory-manager/workspace/eCommerce-Inventory-Manager && ./scripts/backup.sh --kind monthly
```

### Rotation

Seven daily, four weekly, twelve monthly. `pre_upgrade` and `manual` backups are
never pruned: the first is what a rollback needs, and the second was taken by
somebody who had a reason.

## Restoring

**This destroys data.** Read the whole section before running anything.

- **Prerequisites**: the private key, and the artifact with its manifest.
- **Irreversible**: restoring into the live database drops every table first.
- **Rollback**: take a backup before restoring. The script refuses to overwrite
  a live database with no successful backup in the last hour.

### The quarterly drill

Restore into a scratch database. This is the version to practise, and the one
section 23 asks for four times a year:

```bash
./scripts/restore.sh data/backups/eim-daily-20260301T031700Z.sql.age \
  --identity ~/inventory-manager-backup.key \
  --record
```

It verifies the checksum against the manifest _before_ decrypting, restores into
`eim_restore_check`, prints the schema version and the row counts of five anchor
tables, and records the drill against the backup row so the health surface can
show that a restore has actually been proven this quarter.

Read the counts. A restore that completes with zero businesses in it is a
restore that worked perfectly on an empty dump.

Then drop the scratch database — the script prints the command.

### The real thing

```bash
./scripts/backup.sh --kind manual          # first: a way back from the restore
./scripts/restore.sh data/backups/<artifact> \
  --identity ~/inventory-manager-backup.key \
  --into eim --i-mean-it
docker compose restart web worker
curl -fsS http://127.0.0.1:3000/api/ready
```

Restore into a database whose schema version matches the running image. If the
backup is older than the current schema, deploy the matching release _first_,
restore, then upgrade forward — restoring an old dump under a new build leaves
an application whose readiness check correctly says it disagrees with its own
database.

## When a backup fails

The health screen shows `backups` as degraded after 36 hours without a success
and failing after 72, and an installation alert is raised. Common causes:

| Symptom                            | Cause                                                                |
| ---------------------------------- | -------------------------------------------------------------------- |
| `EIM_BACKUP_PUBLIC_KEY is not set` | No key configured; no backup is possible.                            |
| `the backup was empty`             | The dump produced nothing — check the postgres container is healthy. |
| Disk fills a few days in           | Rotation is not running, or `--kind manual` is being used nightly.   |
