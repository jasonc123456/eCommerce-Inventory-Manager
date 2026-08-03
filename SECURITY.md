# Security policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub's [Security Advisories](https://github.com/jasonc123456/eCommerce-Inventory-Manager/security/advisories/new)
on this repository. That creates a private thread visible only to the maintainers.

Please include:

- what the vulnerability allows an attacker to do,
- the steps to reproduce it, and the version or commit you tested,
- whether you believe it is already being exploited.

You will get an acknowledgement within **three working days**, and an assessment
with a plan and a rough timeline within **ten working days**. If the report is
accepted you will be credited in the advisory unless you would rather not be.

This is a self-hosted application maintained by a small number of people, so
these are honest commitments rather than a service level agreement.

## What is in scope

Anything that could lead to:

- **Cross-business data exposure.** One business seeing another's inventory,
  orders, customers, or connections. This is the most serious class of bug in
  the project.
- **Authentication or authorization bypass**, including privilege escalation
  within a business, and any way to act without a permission the interface says
  is required.
- **Credential exposure.** Marketplace tokens, store keys, webhook secrets, or
  the encryption keyring reaching a log, a response, an export, or a backup.
- **Server-side request forgery** through connection or webhook configuration.
- **Remote code execution**, injection into SQL or a shell, or path traversal.
- **Inventory corruption reachable by an untrusted party**, for example by
  forging a webhook to force an oversell.

## What is out of scope

- Vulnerabilities that require an installation administrator to act against
  their own installation. An administrator can already read the database.
- Findings from an automated scanner with no demonstrated impact.
- Missing hardening headers on endpoints that serve no sensitive content.
- Denial of service by overwhelming a self-hosted instance with traffic. Capacity
  is the operator's to size, and rate limits are documented in the deployment guide.
- Social engineering, physical access, or attacks on the operator's own
  infrastructure.

## Supported versions

Until the first stable release, only the tip of `main` is supported. There is no
backport branch, so the fix for any accepted report will be to upgrade.

## Deployment security

The application ships with a threat model and a hardening checklist in the
deployment documentation. Two properties are worth repeating here because they
are the ones an operator can most easily undo:

- The database and mail services are on an internal network and must not be
  published to the internet.
- `.env` holds the encryption keyring in plaintext on disk. It must be readable
  only by its owner, and the backup encryption key must live somewhere other
  than the machine being backed up.
