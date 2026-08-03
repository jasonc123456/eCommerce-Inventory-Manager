# Changesets

A changeset is a short note describing a change, written for somebody running
the application rather than somebody reading the diff. They accumulate here and
are collapsed into the release notes when a version is cut.

Add one with `pnpm changeset`.

Not every change needs one. Documentation, internal refactoring, and test-only
changes do not alter what anybody observes, and a release note for them is noise
in the file people read to decide whether to upgrade.
