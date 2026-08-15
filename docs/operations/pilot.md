# Running the controlled pilot

Version 1 requires a 30-day live pilot. This is how to run one, in the order you
do it, and what each step is for.

The short version: put a business into **observe**, watch what the system says it
would do for a few days, then let it write to one mapping, then a handful, then
everything — and keep the clock running for thirty days from the first live
write.

## Why staged at all

The first live connection is an installation that has never written to a real
provider being pointed at a real seller account with a scheduler that runs every
thirty seconds. The staging exists so that the first mistake costs one listing
instead of the catalogue.

The gate has no override. An unenrolled mapping is not written even to reduce a
quantity — see [the stage gate](#the-stage-gate) for why — and every write it
holds back is recorded with the number it would have sent. That log is the point
of the exercise.

## Before you start

- The installation is deployed, healthy, and backed up. `/health` is green, and
  `EIM_BACKUP_PUBLIC_KEY` is set with its private half **off this host**.
- Connections are made and catalogues imported. Nothing writes yet.
- Mappings are approved and activated. Activation is not the same as enrollment:
  an active mapping is one the system _may_ write; an enrolled one is one the
  pilot _will_.

## 1. Observe

On `/pilot`, set the stage to **Observe**.

Everything is computed and nothing is sent. Every change produces a row under
"What the stage held back", showing the quantity the system wanted to write
beside the quantity the channel currently holds.

Leave it here until you have read a few days of that list and the rows are
boring. What you are looking for:

- Rows where the intended and observed quantities differ for a reason you cannot
  explain. That is a mapping problem, and finding it now costs nothing.
- Mappings you did not expect to see at all.
- Nothing at all, which means orders are not arriving — check `/health` and the
  connection status rather than proceeding.

The pilot clock has **not** started. `observe` writes nothing, so there is
nothing yet to measure.

## 2. Single

Set the stage to **Single** and enrol one mapping — a low-volume item you would
not mind getting wrong.

This is the first live write, and it starts the thirty days. The start is
stamped by this transition and cannot be set by hand; going back to `observe`
and forward again does not reset it.

Watch on `/pilot`:

- The item's quantity on the channel changes when stock moves here.
- The convergence figures start filling in.
- Everything else still appears in the withheld log.

## 3. Cohort

Set the stage to **Cohort** with a ceiling — twenty is a reasonable first number
— and enrol a mix: a fast mover, a variation, a kit, something on each channel.

The ceiling is enforced when you enrol rather than when a write happens, so you
cannot enrol past it, and you cannot narrow the stage while more mappings are
enrolled than the narrower stage allows. Remove the ones you do not want written
first.

## 4. Full

Set the stage to **Full**. Every mapping is written; nothing is withheld; the
withheld log stops growing and stays as history.

## 5. The drills

Three of section 1's criteria cannot be observed from ordinary running. Do them
deliberately, during the pilot, and record each one on `/pilot` — including the
ones that fail, which are the most useful rows in the table.

### Recovering from a 24-hour outage

Disconnect one provider for a full day and let it come back.

```bash
# On the deployment host, with the pilot running:
docker compose -f "$DEPLOY_ROOT/docker-compose.yml" exec web \
  psql "$EIM_DATABASE_URL" -c \
  "update connection_sync_settings set paused = true, paused_reason = 'outage drill'"
```

Wait twenty-four hours. Then un-pause, and watch the queue drain.

What you are checking is that recovery needs **no direct database repair**: the
cursors resume, the reconciliation sweep finds what changed while you were away,
and the ledger identity still holds. If you had to run an `update` to fix
inventory, the drill failed — record it as failed and say what you had to do.

### Restoring a backup

```bash
./scripts/restore.sh --verify <artifact>
```

Restores into an isolated empty database, runs the integrity checks, and stamps
`restore_verified_at` on that backup. The pilot screen reads it from there — it
is a claim about a specific artifact you still have, rather than a note that a
restore happened once.

### Installing cleanly from the documentation

On a fresh machine, follow [install.md](install.md) and nothing else. No
knowledge from having built the thing, no commands from your shell history.

Where the documentation is wrong, fix the documentation — that is the whole
point of the drill — then record it.

## 6. Reading the bar

`/pilot` shows section 1's eight criteria with one of three verdicts.

**met** — there is evidence and it is good.

**not met** — there is evidence and it is bad.

**undemonstrated** — there is no evidence either way. Nobody has classified the
oversales; no outage drill has been run; too few changes have settled to tell 95%
from 94%.

The third is the one that matters. It blocks a release exactly as `not met` does,
but it tells you to go and do something rather than to go and fix something.

### Classifying an oversale

Every oversale files an incident. Whether it was **attributable to a
synchronization defect** is a judgement about cause, and nothing in the data can
make it:

- Two buyers taking the last unit on two channels in the same second is an
  oversale and is not a defect. No interval short of instantaneous prevents it,
  which is what safety stock is for.
- A target that sat unwritten for an hour is the same outcome and is entirely
  ours.

Classify each one with a finding. A finding is required — by the screen and by
the database — because an unattributed verdict on whether the product oversold
somebody is worse than no verdict.

One defect fails the criterion, and the honest response is to fix it and restart
the window from the fix.

### Reading the convergence figure

The headline is the share of changes that reached their channel within two
minutes. Beside it are the exclusions, and you should read them.

Excluded means section 1 says the objective does not apply: the provider was
unavailable or throttling, the mapping stopped being writable, or the stage gate
withheld the write. Out of scope means it was an import or a reconciliation
rather than an individual inventory event.

They are printed rather than filtered because any percentage survives contact
with enough exclusions. If the excluded count is large relative to the measured
one, the figure above it is not describing your installation.

## The stage gate

Worth stating plainly, because it is the one thing about staging that surprises
people: **an unenrolled mapping is not written even to reduce a quantity.**

The objection is fair — if stock is gone and a channel is still advertising it,
staying silent is how an oversell happens. The answer is that a mapping which is
not enrolled is one this installation has not been given authority over. You are
still managing it however you managed it before, and our idea of its quantity may
be an import from days ago. Writing a "protective" zero over a live listing on
that basis is a destructive write nobody authorized.

A boundary a flag can cross is not a boundary. What the gate does instead is tell
you exactly what it would have done, so you can enrol the mapping if you want
that.

## When the pilot passes

Thirty days elapsed, every criterion met. The pilot screen says so, and it is
computed rather than declared — there is no button anywhere that marks a pilot
as passed.

Then see [the release checklist](../release/checklist.md).
