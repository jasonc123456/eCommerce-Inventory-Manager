#!/usr/bin/env bash
#
# Runs a Git hook through lefthook, wherever the toolchain happens to live.
#
# The hooks lefthook installs into .git/hooks hard-code the absolute path of the
# node_modules it was installed from. Installed from inside the development
# container that path is /workspace/..., which does not exist on the host, so
# every hook fails with "node: No such file or directory" the first time
# somebody pushes. The repository is bind-mounted, so both sides see the same
# .git directory and neither can write shims the other can use.
#
# This wrapper resolves that by deciding at run time: use the toolchain directly
# if it is on PATH, and otherwise reach into the container. Hooks then work for
# a contributor with Node installed natively and for one who has only Docker,
# without either of them configuring anything.
set -euo pipefail

HOOK="$1"
shift

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if command -v pnpm >/dev/null 2>&1 && [ -x "${REPO_ROOT}/node_modules/.bin/lefthook" ]; then
  exec pnpm exec lefthook run "${HOOK}" -- "$@"
fi

if [ ! -x "${REPO_ROOT}/scripts/dev.sh" ]; then
  echo "hook ${HOOK}: no local toolchain and no scripts/dev.sh; skipping" >&2
  exit 0
fi

# Translate any argument that is an absolute path inside the repository to the
# path the container sees. Git passes the commit message file this way.
args=()
for arg in "$@"; do
  case "${arg}" in
    "${REPO_ROOT}"/*) args+=("/workspace${arg#"${REPO_ROOT}"}") ;;
    *) args+=("${arg}") ;;
  esac
done

exec "${REPO_ROOT}/scripts/dev.sh" pnpm exec lefthook run "${HOOK}" -- "${args[@]}"
