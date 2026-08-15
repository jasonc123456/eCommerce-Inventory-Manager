# Releasing version 1

Everything here is a gate, and every gate is one somebody can actually check.
None of them is "the team agrees it is ready".

## 1. The pilot bar

Open `/pilot` for the pilot business.

- [ ] Thirty days have elapsed since the first live write.
- [ ] Every one of section 1's eight criteria reads **met**. Not
      `undemonstrated`: a criterion nobody has evidence for is not a criterion
      that passed.
- [ ] Every oversale incident is classified with a finding, and none is a defect.
- [ ] The excluded sample count is small relative to the measured one. If most of
      the traffic was excluded, the headline figure is not describing this
      installation, and the honest move is to say so rather than to ship it.

The screen computes `passes` from all of this. There is no button that sets it.

## 2. The acceptance criteria

- [ ] `pnpm vitest run --project integration packages/pilot` passes. It walks
      [the conformance matrix](acceptance.md) and fails when a cited proof has
      moved.
- [ ] AC-10 and AC-11 still carry their caveats, and the release notes repeat
      them. Version 1 ships the eBay order copy and all shipping **unavailable**,
      pending V-03 and V-04.

## 3. The build

- [ ] `pnpm format:check && pnpm lint && pnpm typecheck` clean.
- [ ] `pnpm test` and the integration project both green.
- [ ] `security` workflow green — dependency advisories and image scan.
- [ ] `EXPECTED_SCHEMA_VERSION` matches the migration files. The release
      workflow re-checks this, because a build whose readiness check disagrees
      with its own schema reports unready on every request in production while
      passing every test that runs from source.

## 4. The tag

Releases are cut from a tag, never from a branch. Nothing about this is
automatic: the release workflow runs on a pushed tag and on nothing else.

```bash
git tag -s v1.0.0 -m 'version 1'
git push origin v1.0.0
```

The workflow then builds `linux/amd64` and `linux/arm64`, attaches an SBOM and
provenance, signs the image keylessly with Sigstore, and writes the notes.

- [ ] The published digest is recorded here and in the deployment's
      `docker-compose.yml`. Pin the **digest**; a tag is a name somebody can
      move.
- [ ] `cosign verify` against the published digest succeeds from a machine that
      did not build it.

## 5. After

- [ ] Upgrade the owner deployment to the released digest with
      `./scripts/upgrade.sh --to <digest>`, which takes a verified pre-upgrade
      backup first and waits for **readiness** rather than liveness.
- [ ] Confirm `/health` is green and `/pilot` still reads what it read before.
- [ ] Record the release in the changelog.

## What is deliberately not on this list

**A performance sign-off separate from the pilot.** AC-19's thresholds are the
pilot's own convergence figures. A synthetic benchmark that passed while the
pilot missed its objective would be a benchmark measuring the wrong thing.

**A manual smoke test of provider writes.** The pilot is thirty days of exactly
that, against real accounts, with a staged gate. A checklist item asking somebody
to click through it once afterwards would add nothing and would imply the pilot
had not been enough.
