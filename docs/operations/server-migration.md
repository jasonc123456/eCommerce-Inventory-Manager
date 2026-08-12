# Moving to another server

The supported portable path is a logical backup and restore. Copying a stopped
`data/postgres` directory works only between identical major versions on
identical platforms, and is an advanced procedure rather than the documented one.

## Before you touch anything

Check the destination: architecture (`docker version --format '{{.Server.Arch}}'`),
Docker and Compose versions, disk capacity for the data plus a restore's worth of
headroom, and that you can create the same uid and gid that own `data/` today.

## The sequence

**1. Stop the mutating half on the source.** The web tier can keep serving —
people can still read — but nothing should be writing to channels mid-move.

```bash
docker compose stop worker
```

**2. Take a final backup and verify it.**

```bash
./scripts/backup.sh --kind manual
./scripts/restore.sh data/backups/<artifact> --identity ~/backup.key
```

Restore it into the scratch database _on the old host_, where you can still
compare. A backup verified only on the new machine is a backup verified after
the point of no return.

**3. Copy the durable directories.** `data/exports` and `data/uploads`. Not
`data/postgres` — that is what the logical backup is for.

```bash
rsync -a data/exports data/uploads newhost:/srv/inventory-manager/data/
```

**4. Transfer `.env` separately, through a different channel.** It holds the
keyring that decrypts every stored credential. It does not belong in the same
archive, on the same transfer, or in the same message as the backup — that is
the whole reason the backup is encrypted to a key held elsewhere.

**5. Recreate the Compose file at the new DEPLOY_ROOT** from the template, with
the same pinned digest as the source is running. Migrating and upgrading at once
means never knowing which one broke.

**6. Restore, then validate before switching DNS.**

```bash
docker compose up -d postgres
./scripts/restore.sh <artifact> --identity ~/backup.key --into eim --i-mean-it
docker compose up -d
curl -fsS http://127.0.0.1:3000/api/ready
```

Then sign in and check, in this order:

- A provider credential decrypts — open a connection's health. If the keyring
  did not come across correctly, this is where it shows, and it shows as
  "cannot decrypt" rather than as something subtle.
- Members and permissions are intact.
- Mappings are present and their statuses are unchanged.
- Queues drain: watch `/health` until `queue` and `workers` are both `ok`.
- Webhook registrations point at the new public URL, if it changed.
- SMTP: the `smtp` check on `/health`.
- `EIM_BACKUP_PUBLIC_KEY` is set on the new host, and take one backup there.

**7. Change DNS or the proxy only after those pass.** Keep the old host stopped
but intact until the rollback window closes — a week is not excessive.

## If the public URL changes

`EIM_PUBLIC_URL` is used to build sign-in links, the eBay deletion endpoint, and
every webhook URL, and eBay verifies its endpoint by hashing the exact string.
Changing it means re-registering the marketplace deletion destination and
reconnecting WooCommerce webhooks. Plan for that before, not during.
