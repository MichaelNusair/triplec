#!/usr/bin/env bash
#
# Host mode: bring a TripleC install up to date with its checkout.
#
#   deploy/host/upgrade.sh [--config FILE] [--source DIR] [--no-pull]
#
# A fast-forward pull of the checkout, then install.sh — which compares everything
# and changes only what moved, so this is safe to run as often as you like. Run it
# twice and the second run says "no changes".
#
# --ff-only and nothing else: no --depth, --deepen or --unshallow, ever. A shallow
# clone is a different repository to every tool that reads history (the build
# stamp included), and a pull that cannot fast-forward means someone committed on
# this checkout — which is theirs to sort out, not an upgrade's to merge or rebase.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="$(cd "$HERE/../.." && pwd)"
PULL=1
ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --config) ARGS+=(--config "${2:?--config needs a file}"); shift 2 ;;
    --source) SOURCE="$(cd "${2:?--source needs a directory}" && pwd)"; shift 2 ;;
    --no-pull) PULL=0; shift ;;
    -h | --help) sed -n '4,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ "$(id -u)" -ne 0 ] || { echo "error: run this as the developer, not root." >&2; exit 1; }
[ -x "$SOURCE/deploy/host/install.sh" ] || [ -f "$SOURCE/deploy/host/install.sh" ] ||
  { echo "error: $SOURCE is not a TripleC checkout (no deploy/host/install.sh)." >&2; exit 1; }

if [ "$PULL" = 1 ]; then
  git -C "$SOURCE" rev-parse --git-dir >/dev/null 2>&1 ||
    { echo "error: $SOURCE is not a git checkout; pass --no-pull to install it as it is." >&2; exit 1; }
  echo "Updating $SOURCE"
  git -C "$SOURCE" pull --ff-only
fi

# The installer from the tree just pulled, not this copy of it: an upgrade that ran
# last version's installer over this version's payload would install neither.
exec bash "$SOURCE/deploy/host/install.sh" --source "$SOURCE" "${ARGS[@]}"
