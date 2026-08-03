## What this changes

<!-- One or two sentences. What behaviour is different afterwards? -->

## Why

<!-- The problem being solved. Link the issue if there is one. -->

## How to check it

<!-- What a reviewer should run or look at to convince themselves. -->

## Checklist

- [ ] Commits are signed off (`git commit -s`) and have plain subjects with no type prefix
- [ ] `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` passes
- [ ] Tests cover the behaviour changed, not just the lines touched
- [ ] `pnpm changeset` added, if this is user-visible
- [ ] The specification is updated, if this changes a rule it describes
- [ ] No secrets, real credentials, or deployment state in the diff

## Anything worth flagging

<!--
Delete what does not apply.

- Touches inventory arithmetic, authentication, or authorization
- Adds or changes a database migration
- Changes a provider adapter contract
- Adds a dependency (which licence? why this one?)
- Changes a configuration key (is .env.example regenerated?)
-->
