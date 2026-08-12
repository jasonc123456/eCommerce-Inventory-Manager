# Installing

For the supported self-hosted deployment described in section 23. It assumes
Docker with Compose v2 and nothing else on the host — no Node, no pnpm, no
PostgreSQL client.

## The host layout

This layout is fixed, and the tooling assumes it exactly:

```
/srv/inventory-manager/          # DEPLOY_ROOT — anywhere you like
├── .env                         # real secrets; never in Git
├── docker-compose.yml           # your copy of the template; never in Git
├── data/                        # DATA_ROOT — every durable bind mount
│   ├── postgres/
│   ├── backups/
│   ├── exports/
│   └── uploads/
└── workspace/
    └── eCommerce-Inventory-Manager/   # this repository
```

Two of those rules are load-bearing rather than stylistic. The repository is the
only Git worktree — do not `git init` at DEPLOY_ROOT. And the real `.env` and
`docker-compose.yml` live _outside_ the repository, so that a `git add -A` in a
hurry cannot publish an installation's keyring.

## 1. Prepare the directories

```bash
export DEPLOY_ROOT=/srv/inventory-manager
mkdir -p "$DEPLOY_ROOT"/data/{postgres,backups,exports,uploads}
mkdir -p "$DEPLOY_ROOT"/workspace
cd "$DEPLOY_ROOT"/workspace
git clone https://github.com/jasonc123456/eCommerce-Inventory-Manager.git
```

The directories must be created before the first `docker compose up`. Docker
creates a missing bind-mount source as root, and PostgreSQL running as your own
user then cannot write to its own data directory — with an error message that
says nothing about ownership.

```bash
# Whoever will administer this installation owns the data root.
chown -R "$(id -u):$(id -g)" "$DEPLOY_ROOT/data"
```

## 2. Write the configuration

```bash
cd "$DEPLOY_ROOT"
cp workspace/eCommerce-Inventory-Manager/.env.example .env
chmod 600 .env
```

`.env.example` is generated from the configuration schema and documents every
setting: what it is for, whether it is required, and how sensitive it is. Every
`CHANGE_ME` must be replaced. The three that stop the application starting if
they are wrong:

```bash
# 48 bytes of randomness, base64. Signs session cookies.
openssl rand -base64 48

# 32 bytes, base64, inside the keyring JSON. Encrypts every stored credential.
# Losing this loses every provider connection in every business.
openssl rand -base64 32
```

`EIM_PUBLIC_URL` must be the exact canonical origin your proxy serves, including
the scheme and without a trailing slash. Sign-in links, the eBay deletion
endpoint challenge, and every webhook URL are built from it, and eBay's endpoint
verification compares a hash of the string — a mismatch fails with a message
that only says validation failed.

`EIM_DATA_UID` and `EIM_DATA_GID` must be the ids that own `data/`. Check with
`id -u` and `id -g`.

## 3. Write the Compose file

```bash
cp workspace/eCommerce-Inventory-Manager/deploy/docker-compose.example.yml \
   docker-compose.yml
```

Then edit two things. Pin the image to a release digest — the release notes for
every version print the line to paste. And set `EIM_POSTGRES_PASSWORD` in
`.env`, which the template requires rather than defaults, because a database
password with a default is a database password everybody has.

If you have no reverse proxy, write a `Caddyfile` beside the Compose file and
start with `--profile caddy`:

```
inventory.example.com {
    reverse_proxy web:3000
}
```

## 4. Start it

```bash
docker compose up -d
docker compose logs -f migrate    # migrations run once, then the service exits
```

The `migrate` service applies the schema and exits; `web` and `worker` wait for
it to succeed. A failed migration therefore stops the deployment rather than
starting an application against a schema it does not agree with.

## 5. Check that it is ready

```bash
curl -fsS http://127.0.0.1:3000/api/ready
```

Readiness, not liveness. `{"status":"ready"}` means the process is serving _and_
the schema matches what this build expects. A 503 with a schema check in it
means the migration step did not run, or ran a different build.

## 6. Create the first administrator

Set `EIM_INITIAL_ADMIN_EMAIL` and `EIM_SETUP_SECRET` in `.env`, restart, and
visit `/setup`. The secret is spent once and the route stops existing.

## Afterwards

- Set `EIM_BACKUP_PUBLIC_KEY` and schedule [backups](backup-and-restore.md).
  Nothing else in this document matters if this one is skipped.
- Read [health and alerts](health-and-alerts.md) and configure a destination.
- Point a Prometheus at `/api/metrics` if you run one — it returns 404 until
  `EIM_METRICS_TOKEN` is set, which is deliberate.
