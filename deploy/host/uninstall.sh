#!/usr/bin/env bash
#
# Host mode: remove TripleC from this VM.
#
#   deploy/host/uninstall.sh [--config FILE] [--purge]
#
# Removes what install.sh added and nothing else: the triplec-* units, the one
# nginx site file, the install directory and the `cc` on PATH if it is ours. The
# config directory (with the password in it) stays unless --purge, so a reinstall
# signs nobody out; --purge also takes the state directory and its pre-install
# snapshot.
#
# Never touched, with or without --purge: ~/.claude and ~/.claude.json (your Claude
# login, settings and every conversation), your projects and repositories, apt
# packages (nginx, node, tmux may be someone else's too), and every other nginx file.
#
# Idempotent: on a machine without TripleC it changes nothing and exits 0.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG=""
PURGE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --config) CONFIG="${2:?--config needs a file}"; shift 2 ;;
    --purge) PURGE=1; shift ;;
    -h | --help) sed -n '4,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ "$(id -u)" -ne 0 ] || { echo "error: run this as the developer, not root." >&2; exit 1; }
CONFIG="${CONFIG:-$HOME/.config/triplec/config.json}"
NGINX_SITE=/etc/nginx/conf.d/triplec.conf
UNIT_DIR=/etc/systemd/system
UNITS=(triplec-chat.service triplec-editor.service triplec-broker.service triplec-tmux.service)
CHANGES=0
did() { echo "  $1"; CHANGES=$((CHANGES + 1)); }

# Where things are, from the config when it is still there; the installer's
# defaults when it is not. A node that cannot be found means the defaults too —
# an uninstall must not depend on the runtime it may be removing.
INSTALL_DIR="$HOME/.local/share/triplec"
CONFIG_DIR="$(dirname "$CONFIG")"
STATE_DIR="$HOME/.local/state/triplec"
NODE="$(command -v node || true)"
[ -n "$NODE" ] || NODE="$(grep -h '^ExecStart=' "$UNIT_DIR/triplec-chat.service" 2>/dev/null | sed 's/^ExecStart=//; s/ .*//' || true)"
if [ -f "$CONFIG" ] && [ -n "$NODE" ] && [ -x "$NODE" ]; then
  for mjs in "$HERE/config.mjs" "$INSTALL_DIR/deploy/host/config.mjs"; do
    [ -f "$mjs" ] || continue
    if "$NODE" "$mjs" validate "$CONFIG" >/dev/null 2>&1; then
      INSTALL_DIR="$("$NODE" "$mjs" get "$CONFIG" installDir)"
      CONFIG_DIR="$("$NODE" "$mjs" get "$CONFIG" configDir)"
      STATE_DIR="$("$NODE" "$mjs" get "$CONFIG" stateDir)"
    fi
    break
  done
fi

# Refuse anything that is not plainly an install directory before an rm -rf. The
# one way this goes badly wrong is a config pointing installDir at $HOME or a repo.
safe_to_remove() {
  local d="$1"
  case "$d" in "" | / | "$HOME" | "$HOME/" | "$HOME/.claude"* | "$HOME/.claude.json") return 1 ;; esac
  [ -d "$d" ] || return 1
  [ -e "$d/.git" ] && return 1
  return 0
}

echo "TripleC host mode: uninstalling"

units_removed=0
for unit in "${UNITS[@]}"; do
  if systemctl is-active --quiet "$unit" 2>/dev/null || systemctl is-enabled --quiet "$unit" 2>/dev/null; then
    sudo systemctl disable --now --quiet "$unit" 2>/dev/null || true
    did "stopped and disabled $unit"
  fi
  if [ -f "$UNIT_DIR/$unit" ]; then
    sudo rm -f "$UNIT_DIR/$unit"
    did "removed $UNIT_DIR/$unit"
    units_removed=1
  fi
done
if [ "$units_removed" = 1 ]; then
  sudo systemctl daemon-reload
  did "systemctl daemon-reload"
fi

if [ -f "$NGINX_SITE" ]; then
  sudo rm -f "$NGINX_SITE"
  did "removed $NGINX_SITE"
  if command -v nginx >/dev/null || [ -x /usr/sbin/nginx ]; then
    sudo "$(command -v nginx || echo /usr/sbin/nginx)" -t
    if systemctl is-active --quiet nginx 2>/dev/null; then
      sudo systemctl reload nginx
      did "reloaded nginx"
    fi
  fi
fi

CC_LINK="$HOME/.local/bin/cc"
if [ -f "$CC_LINK" ] && grep -q '^# triplec-host-cc' "$CC_LINK" 2>/dev/null; then
  rm -f "$CC_LINK"
  did "removed $CC_LINK"
fi

if [ -d "$INSTALL_DIR" ]; then
  if safe_to_remove "$INSTALL_DIR" &&
    { [ -f "$INSTALL_DIR/chat-service/server.js" ] || [ -d "$INSTALL_DIR/deploy/host" ]; }; then
    rm -rf "$INSTALL_DIR"
    did "removed $INSTALL_DIR"
  else
    echo "  left $INSTALL_DIR alone: it does not look like a TripleC install" >&2
  fi
fi

if [ "$PURGE" = 1 ]; then
  for f in triplec.env projects.json secrets.env code-server.yaml config.json; do
    if [ -f "$CONFIG_DIR/$f" ]; then
      rm -f "$CONFIG_DIR/$f"
      did "removed $CONFIG_DIR/$f"
    fi
  done
  rmdir "$CONFIG_DIR" 2>/dev/null || true
  if [ -d "$STATE_DIR" ] && safe_to_remove "$STATE_DIR"; then
    rm -rf "$STATE_DIR"
    did "removed $STATE_DIR"
  fi
elif [ -d "$CONFIG_DIR" ]; then
  echo "  kept $CONFIG_DIR (config and password); --purge removes it"
fi

if [ "$CHANGES" = 0 ]; then
  echo "no changes (TripleC is not installed)"
else
  echo "$CHANGES change(s) made. ~/.claude, ~/.claude.json and your projects were not touched."
fi
