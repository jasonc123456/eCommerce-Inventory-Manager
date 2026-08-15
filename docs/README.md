# Documentation

Markdown, versioned with the source (section 27). The specification itself lives
outside this repository at `DEPLOY_ROOT/ebay-woocommerce-sync-requirements-specification.md`
and remains the canonical planning package; what is here is what an operator,
an owner, or a contributor needs while actually doing something.

## Self-hosting operator

- [Installing](operations/install.md) — the host layout, `.env`, first start.
- [Upgrading and rolling back](operations/upgrade.md) — preflight, migrations, readiness.
- [Backup and restore](operations/backup-and-restore.md) — nightly backups, the quarterly drill.
- [Moving to another server](operations/server-migration.md) — the supported portable path.
- [Health and alerts](operations/health-and-alerts.md) — what each check means and what to do.
- [Running the controlled pilot](operations/pilot.md) — the four stages, the three drills, and how to read the bar.

## Releasing

- [Release checklist](release/checklist.md) — the gates, in order, none of them an opinion.
- [AC-01 through AC-20](release/acceptance.md) — each criterion and the artifact that proves it.

## Security administrator

- [Threat model and secret handling](security/threat-model.md) — what is assumed, what is not.

## Contributor

- [Architecture decisions](adr/) — one record per material decision.
- [CONTRIBUTING.md](../CONTRIBUTING.md) — setup, tests, commit policy.
- [SECURITY.md](../SECURITY.md) — reporting a vulnerability.

## What is deliberately not here

A generated documentation website. Section 27 defers one "until usage/content
volume justifies its maintenance and deployment cost", and a site that is a
build step behind the source is worse than a directory that is not.
