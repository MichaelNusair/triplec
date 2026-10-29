#!/usr/bin/env bash
#
# Host mode: install (or update) TripleC on a Linux VM that already belongs to a
# developer — Ubuntu 24.04 LTS, arm64 or x86_64, reached through a private HTTPS
# proxy or a tailnet. The AWS deployment's counterpart is infra/userdata/bootstrap.sh;
# that script owns its whole machine, this one is a guest on someone else's.
#
#   deploy/host/install.sh [--config FILE] [--profile FILE] [--source DIR] [--dry-run]
#
#   --config FILE   the host config (default ~/.config/triplec/config.json)
#   --profile FILE  a starting config, copied to --config's path if nothing is there
#   --source DIR    the TripleC checkout to install from (default: this script's)
#   --dry-run       print what would change, change nothing
#
# Being a guest is the design constraint. Run as the developer, not root, and sudo
# is used for exactly four things: apt-get, the systemd unit files and systemctl,
# the one nginx site file this installer owns (plus nginx -t / reload), and reading
# the files the "before" snapshot hashes. Nothing else under /etc is written —
# not sudoers, not sshd, not the firewall, not any other nginx file, not cloud
# credentials. deploy/host/README.md lists what it touches and what it never does.
#
# Idempotent, and quietly so: every file is compared before it is written, apt runs
# only for a package that is missing, and a service restarts only when something it
# runs changed. A second run on an unchanged machine changes nothing and says
# "no changes" — which is what makes it safe to run from a cron job or upgrade.sh.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="$(cd "$HERE/../.." && pwd)"
CONFIG=""
PROFILE=""
DRY=0

usage() { sed -n '8,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --config) CONFIG="${2:?--config needs a file}"; shift 2 ;;
    --profile) PROFILE="${2:?--profile needs a file}"; shift 2 ;;
    --source) SOURCE="$(cd "${2:?--source needs a directory}" && pwd)"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# Pinned, like bootstrap.sh pins them: an installer that fetches "latest" installs
# a different thing every week and cannot be reasoned about from its source.
CODE_SERVER_VERSION=4.131.0
WHISPER_VERSION=1.7.6
NODE_MAJOR=22
NGINX_SITE=/etc/nginx/conf.d/triplec.conf
UNIT_DIR=/etc/systemd/system
EDITOR_PORT=9999

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# Every change is recorded here, so the run can end by saying what it did — or,
# in a dry run, what it would have done — and "no changes" means exactly that.
CHANGES=()
changed() {
  CHANGES+=("$1")
  if [ "$DRY" = 1 ]; then say "  would: $1"; else say "  $1"; fi
}

[ "$(id -u)" -ne 0 ] || die "run this as the developer who will use TripleC, not as root. It uses sudo itself for the few steps that need it."
# shellcheck source=/dev/null
[ -f /etc/os-release ] && . /etc/os-release
if [ "${ID:-}" != ubuntu ] || [ "${VERSION_ID:-}" != 24.04 ]; then
  warn "host mode is built and tested for Ubuntu 24.04 LTS; this is ${PRETTY_NAME:-an unknown system}. Continuing."
fi
command -v sudo >/dev/null || die "sudo is required (for apt-get, systemd units and the nginx site file)."

ME="$(id -un)"
MY_GROUP="$(id -gn)"
CONFIG="${CONFIG:-$HOME/.config/triplec/config.json}"

# --- node -------------------------------------------------------------------------
# Before the config, because config.mjs is what reads it. The developer's own node
# is preferred — the one their login shell finds, so an nvm or a mise install counts
# — and only when there is none (or it is older than 20) does this add NodeSource's
# apt repository. Whichever it is, its absolute path goes into the unit: systemd has
# no login shell to find it with.
node_ok() { [ -n "$1" ] && [ -x "$1" ] && "$1" -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' 2>/dev/null; }
login_shell="${SHELL:-/bin/bash}"
[ -x "$login_shell" ] || login_shell=/bin/bash
NODE="$("$login_shell" -lc 'command -v node' 2>/dev/null </dev/null | tail -n1 || true)"
node_ok "$NODE" || NODE="$(command -v node || true)"
node_ok "$NODE" || NODE=""

APT_LOG="$(mktemp "${TMPDIR:-/tmp}/triplec-apt.XXXXXX")"
pkg_installed() { dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'install ok installed'; }
apt_install() {
  [ $# -gt 0 ] || return 0
  changed "apt-get install $*"
  [ "$DRY" = 1 ] && return 0
  # Quiet unless it fails: dpkg's progress is noise in a summary meant to be read.
  if ! { sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "$@"; } >"$APT_LOG" 2>&1; then
    tail -n 30 "$APT_LOG" >&2
    die "apt-get failed (full log: $APT_LOG)"
  fi
}

if [ -z "$NODE" ]; then
  say "Node >= 20 not found on your login PATH; installing Node $NODE_MAJOR from NodeSource."
  if [ "$DRY" = 1 ]; then
    changed "add the NodeSource apt repository and install nodejs"
    say "dry run: config validation needs node, so it stops here."
    exit 0
  fi
  need=()
  for p in curl ca-certificates; do pkg_installed "$p" || need+=("$p"); done
  apt_install "${need[@]}"
  # The key as ASCII armour with an .asc name, which apt reads directly: no gnupg
  # dependency just to dearmor one file.
  key_tmp="$(mktemp)"
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o "$key_tmp"
  sudo install -d -m 0755 /etc/apt/keyrings
  sudo install -m 0644 "$key_tmp" /etc/apt/keyrings/nodesource.asc
  rm -f "$key_tmp"
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.asc] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" |
    sudo tee /etc/apt/sources.list.d/nodesource.list >/dev/null
  CHANGES+=("added the NodeSource apt repository")
  apt_install nodejs
  NODE=/usr/bin/node
  node_ok "$NODE" || die "installed nodejs, but $NODE is not node >= 20"
fi
NPM="$(dirname "$NODE")/npm"
[ -x "$NPM" ] || die "found node at $NODE but no npm next to it"
PATH="$(dirname "$NODE"):$PATH"
export PATH

# --- config ----------------------------------------------------------------------------
CONFIG_MJS="$HERE/config.mjs"
if [ ! -f "$CONFIG" ]; then
  [ -n "$PROFILE" ] || die "no config at $CONFIG. Start from the example:
  $0 --profile $HERE/triplec.host.example.json
(then edit $CONFIG and run this again), or pass --config FILE."
  [ -f "$PROFILE" ] || die "profile $PROFILE does not exist"
  "$NODE" "$CONFIG_MJS" validate "$PROFILE" >/dev/null || die "the profile $PROFILE is not a valid config (see above)"
  changed "copy $PROFILE to $CONFIG"
  if [ "$DRY" = 1 ]; then
    CONFIG="$PROFILE"
  else
    install -D -m 0644 "$PROFILE" "$CONFIG"
  fi
fi
"$NODE" "$CONFIG_MJS" validate "$CONFIG" >/dev/null || die "fix $CONFIG and run this again."

cfg() { "$NODE" "$CONFIG_MJS" get "$CONFIG" "$1"; }
USER_NAME="$(cfg user)"
HOME_DIR="$(cfg home)"
INSTALL_DIR="$(cfg installDir)"
CONFIG_DIR="$(cfg configDir)"
STATE_DIR="$(cfg stateDir)"
PROJECTS_ROOT="$(cfg projectsRoot)"
NGINX_PORT="$(cfg listen.nginxPort)"
APP_PORT="$(cfg listen.appPort)"
SECRETS_BACKEND="$(cfg secrets.backend)"
CLAUDE_AUTH="$(cfg claude.authMode)"
AUTH_MODE="$(cfg auth.mode)"
F_EDITOR="$(cfg features.editor)"
F_VOICE="$(cfg features.voice)"
F_MUX="$(cfg features.mux)"

# The service runs as the configured user, and every file below is written as the
# user running this. Those have to be the same person, or the unit would start a
# service that cannot read its own payload.
[ "$USER_NAME" = "$ME" ] || die "the config names user \"$USER_NAME\", but this is running as \"$ME\". Run it as $USER_NAME."
[ "$HOME_DIR" = "$HOME" ] || warn "config home $HOME_DIR differs from \$HOME ($HOME); using the config's."
case "$INSTALL_DIR" in "$SOURCE" | "$SOURCE"/*) die "installDir $INSTALL_DIR is inside the source $SOURCE; run install.sh from your checkout." ;; esac
[ -f "$SOURCE/chat-service/server.js" ] || die "$SOURCE is not a TripleC checkout (no chat-service/server.js)"

say "TripleC host mode: installing from $SOURCE"
say "  config $CONFIG -> $INSTALL_DIR, as $USER_NAME"
[ "$DRY" = 1 ] && say "  (dry run: nothing will be changed)"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/triplec-install.XXXXXX")"
trap 'rm -rf "$WORK" "$APT_LOG"' EXIT

# --- the "before" snapshot -----------------------------------------------------------------
# Hashes of everything this installer promises never to touch, taken once, on the
# first run, before anything else changes. scripts/host-conformance.sh compares the
# machine against it, so the promise is checked rather than taken on trust. Never
# overwritten: a second snapshot would be of a machine TripleC has already been on.
#
# The firewall is hashed as text with its counters and timestamps removed — both
# move on a live box, and a snapshot that differs every time proves nothing.
SNAPSHOT="$STATE_DIR/pre-install.sha256"
firewall_text() {
  { sudo nft list ruleset 2>/dev/null || sudo iptables-save 2>/dev/null || true; } |
    sed -E -e '/^#/d' -e 's/\[[0-9]+:[0-9]+\]//g' -e 's/packets [0-9]+ bytes [0-9]+//g'
}
take_snapshot() {
  {
    printf '# TripleC host mode: hashes of the machine before the first install, %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    for d in /etc/sudoers.d /etc/ssh; do
      [ -d "$d" ] && sudo find "$d" -xtype f -print0 | sort -z | sudo xargs -0 -r sha256sum
    done
    # The configuration, not the token caches and logs gcloud rewrites on every call.
    for g in "$HOME_DIR/.config/gcloud/active_config" "$HOME_DIR/.config/gcloud/configurations"; do
      [ -e "$g" ] && find "$g" -xtype f -print0 | sort -z | xargs -0 -r sha256sum
    done
    [ -d /etc/nginx ] && sudo find /etc/nginx -xtype f ! -path "$NGINX_SITE" -print0 | sort -z | sudo xargs -0 -r sha256sum
    printf '%s  firewall:ruleset\n' "$(firewall_text | sha256sum | cut -d' ' -f1)"
  } >"$WORK/snapshot"
}
if [ ! -f "$SNAPSHOT" ]; then
  changed "record the pre-install snapshot at $SNAPSHOT"
  if [ "$DRY" = 0 ]; then
    take_snapshot
    install -D -m 0600 "$WORK/snapshot" "$SNAPSHOT"
  fi
fi

# --- packages ---------------------------------------------------------------------------------
# Only what is missing, so a second run runs no apt at all. nginx only when there
# is no nginx binary of any kind: a VM that already has one (from a PPA, built from
# source) keeps it, and this adds a site to it.
NGINX_INSTALLED_NOW=0
need=()
for p in git curl ca-certificates; do pkg_installed "$p" || need+=("$p"); done
if ! command -v nginx >/dev/null && [ ! -x /usr/sbin/nginx ]; then
  need+=(nginx)
  NGINX_INSTALLED_NOW=1
fi
if [ "$F_MUX" = true ]; then
  for p in tmux python3; do pkg_installed "$p" || need+=("$p"); done
fi
if [ "$F_VOICE" = true ]; then
  for p in build-essential cmake; do pkg_installed "$p" || need+=("$p"); done
fi
apt_install "${need[@]}"
NGINX_BIN="$(command -v nginx || echo /usr/sbin/nginx)"

# --- file helpers ---------------------------------------------------------------------------------
# sync_file SRC DEST MODE [root]: write DEST only if its content or mode differs.
# Returns 0 when it wrote (or would write), 1 when DEST was already right, so a
# caller can `if sync_file ...; then` to learn whether something changed.
sync_file() {
  local src="$1" dest="$2" mode="$3" root="${4:-}"
  if [ -f "$dest" ] && cmp -s "$src" "$dest" && [ "$(stat -c %a "$dest")" = "${mode#0}" ]; then
    return 1
  fi
  if [ -f "$dest" ]; then changed "update $dest"; else changed "create $dest"; fi
  [ "$DRY" = 1 ] && return 0
  if [ -n "$root" ]; then
    sudo install -D -m "$mode" -o root -g root "$src" "$dest"
  else
    install -D -m "$mode" "$src" "$dest"
  fi
  return 0
}

# --- payload ----------------------------------------------------------------------------------------
# Staged the way deploy.sh stages it — the chat service, with pwa/ copied into its
# public/ and the icon set the manifest names — and then synced into installDir file
# by file, so an unchanged tree is an unchanged install. The tests stay behind: they
# are for the checkout, and some of them need devDependencies this never installs.
STAGE="$WORK/stage"
mkdir -p "$STAGE"
tar -C "$SOURCE" -cf - \
  --exclude=node_modules --exclude='*-test.js' --exclude=build.json \
  --exclude=chat-service/public/manifest.webmanifest --exclude=chat-service/public/sw.js \
  --exclude=chat-service/public/reset.html --exclude=chat-service/public/pwa-icons \
  chat-service | tar -C "$STAGE" -xf -
cp "$SOURCE/pwa/manifest.webmanifest" "$SOURCE/pwa/sw.js" "$SOURCE/pwa/reset.html" "$STAGE/chat-service/public/"
mkdir -p "$STAGE/chat-service/public/pwa-icons"
# Named files out of the manifest, as infra/config.js reads them: an icon the
# manifest asks for and the payload lacks is an install that silently has none.
"$NODE" -e 'for (const i of JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).icons || []) console.log(String(i.src).split("/").pop())' \
  "$SOURCE/pwa/manifest.webmanifest" | while read -r icon; do
  cp "$SOURCE/pwa-icons/$icon" "$STAGE/chat-service/public/pwa-icons/"
done
mkdir -p "$STAGE/scripts" "$STAGE/docs" "$STAGE/deploy/host"
cp "$SOURCE/scripts/cc-session.sh" "$STAGE/scripts/"
for doc in SECURITY.md HOST.md; do
  [ -f "$SOURCE/docs/$doc" ] && cp "$SOURCE/docs/$doc" "$STAGE/docs/"
done
# This directory too, so uninstall.sh works after the checkout is gone.
for f in install.sh upgrade.sh uninstall.sh config.mjs README.md triplec.host.example.json; do
  [ -f "$SOURCE/deploy/host/$f" ] && cp "$SOURCE/deploy/host/$f" "$STAGE/deploy/host/"
done
if [ "$F_MUX" = true ]; then
  # `cc` for the mux's terminal panes, pinned to this install's projects root. A
  # wrapper rather than a copy, so the script itself updates with the payload; the
  # marker line is how uninstall.sh and the next run recognise it as ours.
  mkdir -p "$STAGE/bin"
  cat >"$STAGE/bin/cc" <<CC
#!/bin/sh
# triplec-host-cc: installed by TripleC's deploy/host/install.sh; uninstall.sh removes it.
# Opens or rejoins a permanent Claude session for a project. See scripts/cc-session.sh.
PROJECTS_ROOT="\${PROJECTS_ROOT:-$PROJECTS_ROOT}"
export PROJECTS_ROOT
exec "$INSTALL_DIR/scripts/cc-session.sh" "\$@"
CC
  chmod 0755 "$STAGE/bin/cc"
fi
if [ "$F_EDITOR" = true ]; then
  mkdir -p "$STAGE/claude-broker" "$STAGE/pwa"
  cp "$SOURCE/claude-broker/broker.js" "$SOURCE/claude-broker/wrapper" "$SOURCE/claude-broker/package.json" "$STAGE/claude-broker/"
  chmod 0755 "$STAGE/claude-broker/wrapper"
  cp "$SOURCE/pwa/mobile-overlay.js" "$STAGE/pwa/"
fi

PAYLOAD_CHANGED=0
LOCK_CHANGED=0
while IFS= read -r -d '' rel; do
  rel="${rel#./}"
  mode=0644
  [ -x "$STAGE/$rel" ] && mode=0755
  if sync_file "$STAGE/$rel" "$INSTALL_DIR/$rel" "$mode"; then
    PAYLOAD_CHANGED=1
    [ "$rel" = chat-service/package-lock.json ] && LOCK_CHANGED=1
  fi
done < <(cd "$STAGE" && find . -type f -print0 | sort -z)

# Files a previous version shipped and this one does not. Only inside the
# directories this installer owns, and never node_modules, whisper or build.json.
if [ -d "$INSTALL_DIR" ]; then
  while IFS= read -r -d '' rel; do
    rel="${rel#./}"
    [ "$rel" = chat-service/build.json ] && continue
    if [ ! -e "$STAGE/$rel" ]; then
      changed "remove $INSTALL_DIR/$rel (no longer shipped)"
      PAYLOAD_CHANGED=1
      [ "$DRY" = 1 ] || rm -f "$INSTALL_DIR/$rel"
    fi
  done < <(cd "$INSTALL_DIR" && find chat-service scripts bin pwa claude-broker docs deploy \
    -path chat-service/node_modules -prune -o -type f -print0 2>/dev/null | sort -z)
fi

# build.json, as deploy.sh writes it, so the app can name the build it is running.
# Rewritten only when the build is a different one: builtAt is a timestamp, and a
# file that changed on every run would make every run a deploy.
BUILD_COMMIT="$(git -C "$SOURCE" rev-parse --short HEAD 2>/dev/null || true)"
BUILD_COMMIT_AT="$(git -C "$SOURCE" log -1 --format=%ct 2>/dev/null || true)"
BUILD_SUBJECT="$(git -C "$SOURCE" log -1 --format=%s 2>/dev/null || true)"
BUILD_DIRTY=false
[ -n "$(git -C "$SOURCE" status --porcelain -uno 2>/dev/null || true)" ] && BUILD_DIRTY=true
BUILD_VERSION="$("$NODE" -e 'try { console.log(require(process.argv[1]).version || "") } catch { console.log("") }' "$SOURCE/package.json")"
if "$NODE" - "$INSTALL_DIR/chat-service/build.json" "$PAYLOAD_CHANGED" "$DRY" \
  "$BUILD_VERSION" "$BUILD_COMMIT" "$BUILD_COMMIT_AT" "$BUILD_SUBJECT" "$BUILD_DIRTY" <<'STAMP'
const fs = require('fs');
const [file, payloadChanged, dry, version, commit, commitAt, subject, dirty] = process.argv.slice(2);
const want = { version, commit, commitAt: /^\d+$/.test(commitAt) ? Number(commitAt) * 1000 : null, subject, dirty: dirty === 'true' };
let have = null;
try { have = JSON.parse(fs.readFileSync(file, 'utf8')); delete have.builtAt; } catch {}
if (payloadChanged !== '1' && have && JSON.stringify(have) === JSON.stringify(want)) process.exit(1);
if (dry !== '1') fs.writeFileSync(file, `${JSON.stringify({ ...want, builtAt: Date.now() }, null, 2)}\n`);
STAMP
then
  changed "stamp $INSTALL_DIR/chat-service/build.json (${BUILD_COMMIT:-unknown}$([ "$BUILD_DIRTY" = true ] && echo +))"
  PAYLOAD_CHANGED=1
fi

NPM_RAN=0
if [ "$LOCK_CHANGED" = 1 ] || [ ! -d "$INSTALL_DIR/chat-service/node_modules" ]; then
  changed "npm ci --omit=dev in $INSTALL_DIR/chat-service"
  if [ "$DRY" = 0 ]; then
    (cd "$INSTALL_DIR/chat-service" && { "$NPM" ci --omit=dev --no-audit --no-fund --loglevel=error || "$NPM" install --omit=dev --no-audit --no-fund --loglevel=error; })
    [ -d "$INSTALL_DIR/chat-service/node_modules" ] || die "npm produced no node_modules in $INSTALL_DIR/chat-service"
  fi
  NPM_RAN=1
fi

# --- cc on PATH ---------------------------------------------------------------------------------
# `cc` is also the C compiler's name. So ~/.local/bin/cc is ours only while no other
# `cc` exists anywhere on the login PATH: install it when the name is free, leave a
# foreign one alone, and take ours back out the moment a compiler appears — a
# shadowed `cc` breaks every `make` this developer runs, which is far worse than
# typing the full path. The service never depends on this: it uses CC_SCRIPT.
CC_LINK="$HOME_DIR/.local/bin/cc"
CC_NOTE=""
is_ours() { [ -f "$1" ] && grep -q '^# triplec-host-cc' "$1" 2>/dev/null; }
if [ "$F_MUX" = true ]; then
  # shellcheck disable=SC2016 # expanded by the login shell, not this one
  login_path="$("$login_shell" -lc 'printf %s "$PATH"' 2>/dev/null </dev/null || true)"
  other_cc=""
  IFS=: read -r -a path_dirs <<<"${login_path:-$PATH}:/usr/bin:/bin"
  for d in "${path_dirs[@]}"; do
    [ -n "$d" ] && [ -x "$d/cc" ] && [ "$d/cc" != "$CC_LINK" ] && { other_cc="$d/cc"; break; }
  done
  if [ -e "$CC_LINK" ] && ! is_ours "$CC_LINK"; then
    CC_NOTE="$CC_LINK is not TripleC's; left alone. TripleC's is $INSTALL_DIR/bin/cc"
  elif [ -n "$other_cc" ]; then
    CC_NOTE="\`cc\` is already $other_cc (likely the C compiler), so TripleC's is not on PATH: use $INSTALL_DIR/bin/cc"
    if is_ours "$CC_LINK"; then
      changed "remove $CC_LINK (it would shadow $other_cc)"
      [ "$DRY" = 1 ] || rm -f "$CC_LINK"
    fi
  else
    sync_file "$STAGE/bin/cc" "$CC_LINK" 0755 || true
  fi
elif is_ours "$CC_LINK"; then
  changed "remove $CC_LINK (features.mux is off)"
  [ "$DRY" = 1 ] || rm -f "$CC_LINK"
fi

# --- voice: whisper.cpp ----------------------------------------------------------------------------
# From a release tarball, not a clone: a pinned, checksummable source, and no
# history to fetch. Static, so the binary needs no ld.so.conf entry under /etc —
# bootstrap.sh's shared-library layout would need one. Built with the compiler
# named outright, because a `cc` on PATH is not necessarily one.
WHISPER_DIR="$INSTALL_DIR/whisper"
if [ "$F_VOICE" = true ] && { [ ! -x "$WHISPER_DIR/whisper-cli" ] || [ ! -s "$WHISPER_DIR/models/ggml-base.en.bin" ]; }; then
  changed "build whisper.cpp v$WHISPER_VERSION into $WHISPER_DIR"
  if [ "$DRY" = 0 ]; then
    src="$STATE_DIR/whisper-src"
    rm -rf "$src" && mkdir -p "$src"
    curl -fsSL "https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v$WHISPER_VERSION.tar.gz" | tar -xz -C "$src" --strip-components=1
    (
      cd "$src"
      env CC=/usr/bin/gcc CXX=/usr/bin/g++ cmake -B build -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON >/dev/null
      cmake --build build -j"$(nproc)" --target whisper-cli >/dev/null
    )
    install -D -m 0755 "$src/build/bin/whisper-cli" "$WHISPER_DIR/whisper-cli"
    mkdir -p "$WHISPER_DIR/models"
    curl -fsSL -o "$WHISPER_DIR/models/ggml-base.en.bin.part" \
      https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
    mv "$WHISPER_DIR/models/ggml-base.en.bin.part" "$WHISPER_DIR/models/ggml-base.en.bin"
    rm -rf "$src"
  fi
  PAYLOAD_CHANGED=1
fi

# --- editor: code-server ------------------------------------------------------------------------------
# The standalone release, into installDir rather than ~/.local/bin: it needs no
# root and no package, uninstall.sh takes it with everything else, and a developer
# who already has a code-server on PATH keeps theirs. Its own config file and data
# directories, for the same reason.
#
# Two gates, as on the workspace box: nginx asks the chat service (auth_request) on
# every editor route, and code-server has a password of its own. The second is not
# redundant here. Loopback is not private on a VM whose own HTTPS proxy maps a
# hostname per port to 127.0.0.1:<port> — anyone who can reach that proxy reaches
# code-server's port directly, past this nginx and its gate. Its password is what
# stops them. See docs/SECURITY.md, "Host mode on a developer VM".
CODE_SERVER="$INSTALL_DIR/code-server/bin/code-server"
CS_DATA="$STATE_DIR/code-server"
EDITOR_CHANGED=0
if [ "$F_EDITOR" = true ]; then
  if [ ! -x "$CODE_SERVER" ] || ! "$CODE_SERVER" --version 2>/dev/null | grep -q "^$CODE_SERVER_VERSION"; then
    changed "install code-server $CODE_SERVER_VERSION into $INSTALL_DIR/code-server"
    if [ "$DRY" = 0 ]; then
      curl -fsSL https://code-server.dev/install.sh |
        sh -s -- --method=standalone --prefix="$INSTALL_DIR/code-server" --version "$CODE_SERVER_VERSION" >/dev/null
      "$CODE_SERVER" --version >/dev/null || die "code-server did not install into $INSTALL_DIR/code-server"
    fi
    EDITOR_CHANGED=1
  fi
  # Generated once, kept 0600 beside the other secrets, never printed.
  EDITOR_PASSWORD_FILE="$CONFIG_DIR/editor-password"
  if [ ! -s "$EDITOR_PASSWORD_FILE" ]; then
    changed "generate $EDITOR_PASSWORD_FILE (code-server's own password)"
    if [ "$DRY" = 0 ]; then
      mkdir -p "$CONFIG_DIR"
      (umask 077 && head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' >"$EDITOR_PASSWORD_FILE")
    fi
  fi
  EDITOR_PASSWORD="$(cat "$EDITOR_PASSWORD_FILE" 2>/dev/null || echo pending-dry-run)"
  cat >"$WORK/code-server.yaml" <<CSCONF
# Written by TripleC's deploy/host/install.sh. Loopback, and a password of its own
# as well as the chat service's gate in nginx: on a VM whose proxy reaches every
# loopback port, the port alone keeps nobody out.
bind-addr: 127.0.0.1:$EDITOR_PORT
auth: password
password: $EDITOR_PASSWORD
cert: false
disable-telemetry: true
disable-update-check: true
user-data-dir: $CS_DATA/data
extensions-dir: $CS_DATA/extensions
CSCONF
  sync_file "$WORK/code-server.yaml" "$CONFIG_DIR/code-server.yaml" 0600 && EDITOR_CHANGED=1

  # The official Claude Code extension, from Open VSX (code-server's marketplace),
  # for this machine's architecture — as bootstrap.sh installs it.
  if [ "$DRY" = 1 ] && [ ! -x "$CODE_SERVER" ]; then
    changed "install the Claude Code extension"
  elif ! "$CODE_SERVER" --config "$CONFIG_DIR/code-server.yaml" --list-extensions 2>/dev/null | grep -qi '^anthropic\.claude-code$'; then
    changed "install the Claude Code extension into $CS_DATA/extensions"
    if [ "$DRY" = 0 ]; then
      case "$(uname -m)" in aarch64 | arm64) vsx_arch=linux-arm64 ;; *) vsx_arch=linux-x64 ;; esac
      vsix_url="$(curl -fsSL "https://open-vsx.org/api/anthropic/claude-code/$vsx_arch/latest" |
        "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).files.download))')"
      curl -fsSL "$vsix_url" -o "$WORK/claude-code.vsix"
      "$CODE_SERVER" --config "$CONFIG_DIR/code-server.yaml" --install-extension "$WORK/claude-code.vsix" >/dev/null ||
        warn "the Claude Code extension did not install; the editor works without its panel"
    fi
    EDITOR_CHANGED=1
  fi

  # Point the extension at the broker's wrapper, so one panel conversation can be
  # shared between devices — what claude-broker/install.sh does on AWS. Set rather
  # than defaulted: it is infrastructure, not a preference.
  if [ "$DRY" = 0 ] || [ -f "$CS_DATA/data/User/settings.json" ]; then
    if "$NODE" - "$CS_DATA/data/User/settings.json" "$INSTALL_DIR/claude-broker/wrapper" "$DRY" <<'MERGE'
const fs = require('fs');
const path = require('path');
const [file, wrapper, dry] = process.argv.slice(2);
let cur = {};
try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
if (cur['claudeCode.claudeProcessWrapper'] === wrapper) process.exit(1);
cur['claudeCode.claudeProcessWrapper'] = wrapper;
if (dry !== '1') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(cur, null, 2)}\n`);
}
MERGE
    then
      changed "set claudeCode.claudeProcessWrapper in $CS_DATA/data/User/settings.json"
    fi
  fi
fi

# --- rendered config ---------------------------------------------------------------------------------
"$NODE" "$CONFIG_MJS" env "$CONFIG" >"$WORK/triplec.env"
"$NODE" "$CONFIG_MJS" projects "$CONFIG" >"$WORK/projects.json"
ENV_CHANGED=0
sync_file "$WORK/triplec.env" "$CONFIG_DIR/triplec.env" 0644 && ENV_CHANGED=1
sync_file "$WORK/projects.json" "$CONFIG_DIR/projects.json" 0644 && ENV_CHANGED=1

# --- secrets -------------------------------------------------------------------------------------------
# Generated once and never rewritten: a new password on every run would sign every
# device out on every upgrade. Never printed either — only where it is. 0600,
# because the service refuses a secrets file anyone else can read.
SECRETS="$CONFIG_DIR/secrets.env"
rand_hex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
if [ "$SECRETS_BACKEND" = file ]; then
  if [ ! -f "$SECRETS" ]; then
    changed "generate $SECRETS (login password and cookie signing key)"
    if [ "$DRY" = 0 ]; then
      mkdir -p "$CONFIG_DIR"
      (
        umask 077
        {
          echo "# TripleC secrets. Generated once by deploy/host/install.sh, never overwritten."
          echo "# Keep this file 0600. Add ANTHROPIC_API_KEY=... here if claude.authMode is apiKey."
          echo "AUTH_PASSWORD=$(rand_hex 24)"
          echo "SESSION_SECRET=$(rand_hex 32)"
        } >"$SECRETS"
      )
      ENV_CHANGED=1
    fi
  elif [ "$(stat -c %a "$SECRETS")" != 600 ]; then
    changed "chmod 600 $SECRETS (it was $(stat -c %a "$SECRETS"))"
    [ "$DRY" = 1 ] || chmod 600 "$SECRETS"
    ENV_CHANGED=1
  fi
  if [ "$CLAUDE_AUTH" = apiKey ] && ! grep -q '^ANTHROPIC_API_KEY=.' "$SECRETS" 2>/dev/null; then
    warn "claude.authMode is apiKey, but $SECRETS has no ANTHROPIC_API_KEY line. Add one, then: sudo systemctl restart triplec-chat"
  fi
fi

# --- systemd -----------------------------------------------------------------------------------------------
# System units with User=, rather than user units, so they start at boot without
# lingering being enabled for this account — one less setting changed on the VM.
UNITS_CHANGED=0
CHAT_UNIT_CHANGED=0
TMUX_UNIT_CHANGED=0
EDITOR_UNIT_CHANGED=0
after_chat="network-online.target"
wants_chat="network-online.target"
if [ "$F_MUX" = true ]; then
  after_chat="$after_chat triplec-tmux.service"
  wants_chat="$wants_chat triplec-tmux.service"
fi
cat >"$WORK/triplec-chat.service" <<UNIT
# Written by TripleC's deploy/host/install.sh; re-run it rather than editing this.
[Unit]
Description=TripleC chat service (host mode)
Documentation=file://$INSTALL_DIR/deploy/host/README.md
After=$after_chat
Wants=$wants_chat

[Service]
Type=simple
User=$USER_NAME
Group=$MY_GROUP
# Settings only. The password and cookie key are read by the service from the
# 0600 file the env names (TRIPLEC_SECRETS_FILE), never placed in this unit.
EnvironmentFile=$CONFIG_DIR/triplec.env
WorkingDirectory=$INSTALL_DIR/chat-service
ExecStart=$NODE server.js
Restart=on-failure
RestartSec=2
StandardOutput=journal
StandardError=journal
SyslogIdentifier=triplec-chat

[Install]
WantedBy=multi-user.target
UNIT
sync_file "$WORK/triplec-chat.service" "$UNIT_DIR/triplec-chat.service" 0644 root && { UNITS_CHANGED=1; CHAT_UNIT_CHANGED=1; }

# The tmux server for the mux's terminal panes, in a unit of its own for the reason
# bootstrap.sh's claude-tmux.service gives: a tmux session lives in its server's
# cgroup, so a server first started by the chat service would die with it on the
# next restart, taking every terminal session along. `exit-empty off` keeps the
# server up between sessions, so the next `cc` never starts one somewhere else.
# Default socket, no PrivateTmp, so `tmux ls` over SSH is this same server.
if [ "$F_MUX" = true ]; then
  cat >"$WORK/triplec-tmux.service" <<UNIT
# Written by TripleC's deploy/host/install.sh; re-run it rather than editing this.
[Unit]
Description=TripleC tmux server (terminal sessions for the mux)
After=network-online.target
Wants=network-online.target

[Service]
Type=forking
User=$USER_NAME
Group=$MY_GROUP
Environment=HOME=$HOME_DIR
WorkingDirectory=$HOME_DIR
ExecStart=/bin/sh -c 'tmux start-server \\; set-option -s exit-empty off'
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT
  sync_file "$WORK/triplec-tmux.service" "$UNIT_DIR/triplec-tmux.service" 0644 root && { UNITS_CHANGED=1; TMUX_UNIT_CHANGED=1; }
fi

if [ "$F_EDITOR" = true ]; then
  cat >"$WORK/triplec-editor.service" <<UNIT
# Written by TripleC's deploy/host/install.sh; re-run it rather than editing this.
[Unit]
Description=TripleC editor (code-server on 127.0.0.1:$EDITOR_PORT)
After=network-online.target triplec-tmux.service
Wants=network-online.target

[Service]
Type=simple
User=$USER_NAME
Group=$MY_GROUP
Environment=HOME=$HOME_DIR
WorkingDirectory=$PROJECTS_ROOT
ExecStart=$CODE_SERVER --config $CONFIG_DIR/code-server.yaml
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
  sync_file "$WORK/triplec-editor.service" "$UNIT_DIR/triplec-editor.service" 0644 root && { UNITS_CHANGED=1; EDITOR_UNIT_CHANGED=1; }

  # The broker that keeps the panel's `claude` alive and shared — the host-mode copy
  # of claude-broker.service. Same runtime directory, so the wrapper finds it.
  cat >"$WORK/triplec-broker.service" <<UNIT
# Written by TripleC's deploy/host/install.sh; re-run it rather than editing this.
[Unit]
Description=TripleC broker (one claude per editor conversation, shared by devices)
After=network-online.target

[Service]
Type=simple
User=$USER_NAME
Group=$MY_GROUP
Environment=HOME=$HOME_DIR
WorkingDirectory=$INSTALL_DIR/claude-broker
ExecStart=$NODE broker.js
RuntimeDirectory=claude-broker
RuntimeDirectoryMode=0700
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT
  sync_file "$WORK/triplec-broker.service" "$UNIT_DIR/triplec-broker.service" 0644 root && UNITS_CHANGED=1
fi

if [ "$UNITS_CHANGED" = 1 ]; then
  changed "systemctl daemon-reload"
  [ "$DRY" = 1 ] || sudo systemctl daemon-reload
fi

# enable --now for a unit that is not already enabled and running; a restart only
# for one whose code, env or unit changed. Never a restart of the tmux server or the
# broker: those hold live sessions, and ending them is a decision for the developer.
WAS_STARTED=()
ensure_up() {
  local unit="$1"
  if systemctl is-enabled --quiet "$unit" 2>/dev/null && systemctl is-active --quiet "$unit" 2>/dev/null; then
    return 0
  fi
  changed "systemctl enable --now $unit"
  [ "$DRY" = 1 ] || sudo systemctl enable --now --quiet "$unit"
  WAS_STARTED+=("$unit")
}
started() { local u; for u in "${WAS_STARTED[@]}"; do [ "$u" = "$1" ] && return 0; done; return 1; }

[ "$F_MUX" = true ] && ensure_up triplec-tmux.service
if [ "$F_EDITOR" = true ]; then
  ensure_up triplec-broker.service
  ensure_up triplec-editor.service
  if [ "$EDITOR_CHANGED$EDITOR_UNIT_CHANGED" != 00 ] && ! started triplec-editor.service; then
    changed "systemctl restart triplec-editor (editor changed)"
    [ "$DRY" = 1 ] || sudo systemctl restart triplec-editor.service
  fi
fi
ensure_up triplec-chat.service
if [ "$PAYLOAD_CHANGED$ENV_CHANGED$CHAT_UNIT_CHANGED$NPM_RAN" != 0000 ] && ! started triplec-chat.service; then
  changed "systemctl restart triplec-chat (payload, config or unit changed)"
  [ "$DRY" = 1 ] || sudo systemctl restart triplec-chat.service
fi
TMUX_NOTE=""
[ "$TMUX_UNIT_CHANGED" = 1 ] && ! started triplec-tmux.service &&
  TMUX_NOTE="triplec-tmux.service changed but was not restarted (that ends every terminal session). When convenient: sudo systemctl restart triplec-tmux"

# A feature switched off leaves its unit behind otherwise, still running.
for pair in "triplec-tmux:$F_MUX" "triplec-editor:$F_EDITOR" "triplec-broker:$F_EDITOR"; do
  unit="${pair%%:*}.service"
  if [ "${pair#*:}" != true ] && [ -f "$UNIT_DIR/$unit" ]; then
    changed "stop, disable and remove $unit (its feature is off)"
    if [ "$DRY" = 0 ]; then
      sudo systemctl disable --now --quiet "$unit" 2>/dev/null || true
      sudo rm -f "$UNIT_DIR/$unit"
      sudo systemctl daemon-reload
    fi
  fi
done
# After its unit has stopped, not before.
if [ "$F_EDITOR" != true ] && [ -d "$INSTALL_DIR/code-server" ]; then
  changed "remove $INSTALL_DIR/code-server (features.editor is off)"
  [ "$DRY" = 1 ] || rm -rf "$INSTALL_DIR/code-server"
fi

# --- nginx ------------------------------------------------------------------------------------------------
# One file, and only one: conf.d/triplec.conf. It listens on loopback, is nobody's
# default_server, and touches no map, upstream or variable the VM's own nginx might
# define — its names all start with triplec_. Whatever terminates TLS in front (the
# VM's proxy, a tunnel) forwards to it; the chat service authenticates every request.
#
# Every location sets the full header list, because nginx inherits proxy_set_header
# from the server block only into a location that sets none of its own — one
# location adding a header would silently drop all the others there.
#
# The Tailscale identity headers are cleared on every request through this
# listener. In trusted-header mode the chat service believes them only on a
# connection from a process owned by peerUid (tailscaled, root), and nginx's
# workers are not root — so that check already refuses them. This is the second
# lock: whatever reaches nginx, from a VM proxy or anywhere else, cannot carry an
# identity through it.
proxy_headers() {
  cat <<HDRS
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$http_x_forwarded_proto;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$triplec_connection_upgrade;
        proxy_set_header Tailscale-User-Login "";
        proxy_set_header Tailscale-User-Name "";
        proxy_set_header Tailscale-User-Profile-Pic "";
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
        proxy_request_buffering off;
HDRS
}

{
  cat <<NGINX
# TripleC (host mode). Written by deploy/host/install.sh, removed by uninstall.sh.
# The only nginx file TripleC owns; it edits no other. Re-run the installer rather
# than editing this — a change here is overwritten.
map \$http_upgrade \$triplec_connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 127.0.0.1:$NGINX_PORT;
    server_name _;
    client_max_body_size 100M;

    # Everything goes to the chat service unchanged; in host mode it serves the
    # /chat/ prefix and the bare-root redirect itself.
    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
$(proxy_headers)
    }
NGINX
  if [ "$F_EDITOR" = true ]; then
    cat <<NGINX

    # Who is asking, answered by the chat service: 204 for a signed-in caller, 401
    # otherwise. internal, so no client can request it; no body, because a 100M
    # upload streamed to the gate as well as the upstream doubles every write.
    location = /__triplec_identity {
        internal;
        proxy_pass http://127.0.0.1:$APP_PORT/api/auth-check;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
$(proxy_headers)
    }

    # Not signed in: to the chat's login rather than a bare 401 page.
    location @triplec_login {
        absolute_redirect off;
        return 302 /chat/;
    }

    # The editor. Gated here by the chat service's login, and by code-server's own
    # password behind it (see the editor section above for why both).
    location /editor/ {
        auth_request /__triplec_identity;
        error_page 401 = @triplec_login;
        proxy_pass http://127.0.0.1:$EDITOR_PORT/;
        proxy_redirect / /editor/;
$(proxy_headers)
    }

    # One installable app per project: the editor again, on a path of its own.
    # See bootstrap.sh for why a path and not a query string.
    location ~ ^/p/(?<triplec_project>[A-Za-z0-9][A-Za-z0-9._-]*)(?:/|\$) {
        auth_request /__triplec_identity;
        error_page 401 = @triplec_login;
        absolute_redirect off;
        port_in_redirect off;
        rewrite ^/p/([A-Za-z0-9][A-Za-z0-9._-]*)\$ /p/\$1/ redirect;
        rewrite ^/p/[A-Za-z0-9][A-Za-z0-9._-]*/?(.*)\$ /\$1 break;
        proxy_pass http://127.0.0.1:$EDITOR_PORT;
        proxy_redirect / /p/\$triplec_project/;
$(proxy_headers)
    }
}
NGINX
  else
    cat <<NGINX

    # The editor is off (features.editor): nothing answers on its paths.
    location /editor/ { return 404; }
    location /p/ { return 404; }
}
NGINX
  fi
} >"$WORK/triplec.conf"

NGINX_CHANGED=0
if [ -f "$NGINX_SITE" ] && cmp -s "$WORK/triplec.conf" "$NGINX_SITE"; then
  :
else
  NGINX_CHANGED=1
  if [ -f "$NGINX_SITE" ]; then changed "update $NGINX_SITE"; else changed "create $NGINX_SITE"; fi
  if [ "$DRY" = 0 ]; then
    had_site=0
    if [ -f "$NGINX_SITE" ]; then
      cp "$NGINX_SITE" "$WORK/triplec.conf.previous"
      had_site=1
    fi
    sudo install -D -m 0644 -o root -g root "$WORK/triplec.conf" "$NGINX_SITE"
    if ! out="$(sudo "$NGINX_BIN" -t 2>&1)"; then
      if [ "$had_site" = 1 ]; then
        sudo install -m 0644 -o root -g root "$WORK/triplec.conf.previous" "$NGINX_SITE"
      else
        sudo rm -f "$NGINX_SITE"
      fi
      printf '%s\n' "$out" >&2
      die "nginx rejected the new $NGINX_SITE, so the previous state was restored and nothing was reloaded."
    fi
  fi
fi
if [ "$NGINX_CHANGED" = 1 ]; then
  if systemctl is-active --quiet nginx 2>/dev/null; then
    changed "systemctl reload nginx"
    [ "$DRY" = 1 ] || sudo systemctl reload nginx
  else
    changed "systemctl start nginx (it was not running)"
    [ "$DRY" = 1 ] || sudo systemctl start nginx
  fi
fi

# --- verify + summary -----------------------------------------------------------------------------------------
say ""
if [ "$DRY" = 1 ]; then
  if [ "${#CHANGES[@]}" -eq 0 ]; then say "no changes"; else say "dry run: ${#CHANGES[@]} change(s) would be made; nothing was changed."; fi
  exit 0
fi

# Healthy means answering, not merely "active": a crash loop is active between
# restarts. /healthz is the one route that needs no login.
healthy=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$APP_PORT/healthz" 2>/dev/null | grep -q '"ok":true'; then
    healthy=1
    break
  fi
  sleep 1
done

status_of() { systemctl is-active "$1" 2>/dev/null || true; }
say "Services"
say "  triplec-chat    $(status_of triplec-chat.service)"
[ "$F_MUX" = true ] && say "  triplec-tmux    $(status_of triplec-tmux.service)"
[ "$F_EDITOR" = true ] && say "  triplec-editor  $(status_of triplec-editor.service)" &&
  say "  triplec-broker  $(status_of triplec-broker.service)"
say "  nginx           $(status_of nginx)"
say ""
say "Open"
say "  http://127.0.0.1:$NGINX_PORT/   on this VM (e.g. through an SSH tunnel)"
say "  or through your VM's HTTPS proxy, pointed at 127.0.0.1:$NGINX_PORT"
if [ "$AUTH_MODE" = trusted-header ]; then
  say "  over a tailnet: tailscale serve --bg --https=443 http://127.0.0.1:$APP_PORT   (the app port, not nginx's: see README)"
fi
if [ "$SECRETS_BACKEND" = file ]; then
  say ""
  say "Password: in $SECRETS (never printed). To read it:"
  say "  sed -n s/^AUTH_PASSWORD=//p $SECRETS"
fi
[ -n "$CC_NOTE" ] && say "" && say "Note: $CC_NOTE"
[ -n "$TMUX_NOTE" ] && say "" && say "Note: $TMUX_NOTE"
if [ "$NGINX_INSTALLED_NOW" = 1 ] && [ -e /etc/nginx/sites-enabled/default ]; then
  say ""
  say "Note: nginx was installed for TripleC, and Ubuntu's package enables its own default site on port 80"
  say "      on every interface. TripleC does not touch it; remove /etc/nginx/sites-enabled/default if you do not want it."
fi
claude_bin="$("$login_shell" -lc 'command -v claude' 2>/dev/null </dev/null | tail -n1 || true)"
if [ -z "$claude_bin" ]; then
  say ""
  say "Note: no \`claude\` on your login PATH. Install Claude Code and run \`claude\` once to sign in (claude.authMode \"$CLAUDE_AUTH\")."
fi
say ""
say "Security notes for a VM with network reach: $INSTALL_DIR/docs/SECURITY.md#host-mode-on-a-developer-vm"
say "  (also https://github.com/MichaelNusair/triplec/blob/main/docs/SECURITY.md#host-mode-on-a-developer-vm)"
say ""
if [ "${#CHANGES[@]}" -eq 0 ]; then
  say "no changes"
else
  say "${#CHANGES[@]} change(s) made."
fi

if [ "$healthy" = 0 ]; then
  warn "triplec-chat is not answering on http://127.0.0.1:$APP_PORT/healthz. Last log lines:"
  sudo journalctl -u triplec-chat.service -n 20 --no-pager >&2 || true
  # 3, not 1: everything above was installed; only the service is unwell. Lets a
  # caller tell "the install failed" from "the install worked, the app did not start".
  exit 3
fi
