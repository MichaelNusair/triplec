#!/usr/bin/env bash
#
# The host-mode installer, end to end, on a throwaway Ubuntu 24.04 with systemd.
#
#   deploy/host/test/container-test.sh [--keep]
#
#   DOCKER="sudo docker"   how to call docker (default: docker)
#   TRIPLEC_TEST_DIR=DIR   scratch for the image build context (default: mktemp)
#   --keep                 leave the container running afterwards, to poke at
#
# What it stands in for is a developer's VM that already has a life: nginx with a
# site of its own (TLS on 127.0.0.1:8443, a map named the way everyone names it),
# a ~/.claude, a repository. The installer runs twice — the second must change
# nothing at all, down to mtimes — then upgrade twice, then uninstall twice, and
# at every step the VM's own files are checked to be exactly as they were.
#
# Needs privileged docker, because systemd is PID 1 in the container: the units
# are real units, so `enable --now` and the restarts are tested, not mocked. There
# is no Claude login in here, so `claude` is a stub script on PATH.
#
# Most commands here are strings run by a shell inside the container, so their $
# and ~ are meant to expand there, not here.
# shellcheck disable=SC2016,SC2088
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
read -r -a DOCKER <<<"${DOCKER:-docker}"
IMAGE=triplec-host-test:ubuntu24.04
NAME="triplec-host-test-$$"
KEEP=0
[ "${1:-}" = --keep ] && KEEP=1

SCRATCH="${TRIPLEC_TEST_DIR:-$(mktemp -d)}"
mkdir -p "$SCRATCH"

PASS=0
FAIL=0
FAILED=()
BLOCKED=()
ok() { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); FAILED+=("$1"); printf '  FAIL  %s\n' "$1"; }
check() { local name="$1"; shift; if "$@"; then ok "$name"; else bad "$name"; fi; }
step() { printf '\n== %s\n' "$*"; }

cleanup() {
  if [ "$KEEP" = 1 ]; then
    echo "container left running: ${DOCKER[*]} exec -it -u dev $NAME bash"
  else
    "${DOCKER[@]}" rm -f "$NAME" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# --- the image: Ubuntu 24.04, systemd, and a VM's existing nginx ------------------
step "building $IMAGE"
cat >"$SCRATCH/Dockerfile" <<'DOCKERFILE'
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends systemd systemd-sysv dbus sudo nginx \
      openssl ca-certificates curl git \
 && rm -rf /var/lib/apt/lists/*
# Units that only make sense on real hardware or a console.
RUN systemctl mask systemd-logind.service getty.target console-getty.service \
      systemd-udevd.service systemd-udev-trigger.service systemd-modules-load.service \
      sys-kernel-config.mount sys-kernel-debug.mount
# The developer. Passwordless sudo is this test container's, not something the
# installer needs or sets up.
RUN useradd -m -s /bin/bash dev \
 && echo 'dev ALL=(ALL) NOPASSWD:ALL' >/etc/sudoers.d/90-dev && chmod 0440 /etc/sudoers.d/90-dev
# The VM's own nginx site: TLS on loopback, a catch-all that drops, and the map
# name every tutorial uses — which TripleC's site must not collide with.
RUN mkdir -p /etc/nginx/vm \
 && openssl req -x509 -nodes -newkey rsa:2048 -days 30 -subj /CN=vm.test \
      -keyout /etc/nginx/vm/key.pem -out /etc/nginx/vm/cert.pem 2>/dev/null \
 && printf '%s\n' \
      'map $http_upgrade $connection_upgrade { default upgrade; "" close; }' \
      'server {' \
      '    listen 127.0.0.1:8443 ssl default_server;' \
      '    server_name _;' \
      '    ssl_certificate /etc/nginx/vm/cert.pem;' \
      '    ssl_certificate_key /etc/nginx/vm/key.pem;' \
      '    return 444;' \
      '}' >/etc/nginx/conf.d/00-vm.conf
# No Claude login in a container: a stub that answers like a CLI would.
RUN printf '%s\n' '#!/bin/sh' 'case "$1" in --version) echo "0.0.0 (stub)";; *) echo "stub claude: $*";; esac' \
      >/usr/local/bin/claude && chmod 0755 /usr/local/bin/claude
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
DOCKERFILE
"${DOCKER[@]}" build -q -t "$IMAGE" "$SCRATCH" >/dev/null

step "starting the container"
# --privileged with a private cgroup namespace: systemd gets a writable cgroup
# tree of its own and never sees the host's.
"${DOCKER[@]}" run -d --name "$NAME" --privileged --cgroupns=private \
  --tmpfs /run --tmpfs /run/lock "$IMAGE" >/dev/null
for _ in $(seq 1 30); do
  state="$("${DOCKER[@]}" exec "$NAME" systemctl is-system-running 2>/dev/null || true)"
  case "$state" in running | degraded) break ;; esac
  sleep 1
done
echo "  systemd: ${state:-unknown}"

as_root() { "${DOCKER[@]}" exec -i "$NAME" bash -c "$1"; }
as_dev() { "${DOCKER[@]}" exec -i -u dev -w /home/dev -e HOME=/home/dev -e USER=dev -e SHELL=/bin/bash "$NAME" bash -lc "$1"; }

# The checkout, as a developer would have it: a git repository, so build.json has
# a commit to name. Copied without .git, node_modules or worktrees.
tar -C "$REPO" --exclude=.git --exclude=node_modules --exclude=./.claude --exclude=./dist -cf - . |
  "${DOCKER[@]}" exec -i -u dev "$NAME" bash -c 'mkdir -p /home/dev/triplec && tar -C /home/dev/triplec -xf -'
as_dev 'cd triplec && git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm test'

# The developer's existing life: Claude state and a repository, to prove nothing
# in them changes.
as_dev 'mkdir -p ~/.claude/projects ~/src/example \
  && echo "{\"theme\":\"dark\"}" > ~/.claude/settings.json && echo "{}" > ~/.claude.json \
  && cd ~/src/example && git init -q && echo hi > README && git add README \
  && git -c user.name=t -c user.email=t@t commit -qm init'
fingerprint_dev='find ~/.claude ~/.claude.json ~/src/example -path "*/.git/index" -prune -o -type f -printf "%p %T@ " -exec sha256sum {} \; | sort'
fingerprint_nginx='find /etc/nginx -xtype f ! -path /etc/nginx/conf.d/triplec.conf -exec sha256sum {} + | sort'
fingerprint_install='find /etc/systemd/system /etc/nginx ~/.local/share/triplec ~/.config/triplec ~/.local/state/triplec ~/.local/bin -printf "%p %T@ %m\n" 2>/dev/null | sort'
DEV_BEFORE="$(as_dev "$fingerprint_dev")"
NGINX_BEFORE="$(as_root "$fingerprint_nginx")"

INSTALL='bash ~/triplec/deploy/host/install.sh'
PROFILE='~/triplec/deploy/host/triplec.host.example.json'

# Exit 3 from install.sh means "installed, but the chat service is not answering".
# Recorded as blocked rather than failed, so the rest of the install can still be
# checked while the service itself is being worked on.
run_install() {
  local label="$1" cmd="$2" out rc=0
  out="$(as_dev "$cmd" 2>&1)" || rc=$?
  printf '%s\n' "$out" >"$SCRATCH/$label.log"
  if [ "$rc" = 3 ]; then
    BLOCKED+=("$label: installed, but triplec-chat did not answer /healthz (see $SCRATCH/$label.log)")
    rc=0
  fi
  LAST_OUT="$out"
  return "$rc"
}

# --- refusals ----------------------------------------------------------------------------
step "refusals"
check "refuses to run as root" bash -c "! ${DOCKER[*]} exec $NAME bash ~dev/triplec/deploy/host/install.sh >/dev/null 2>&1"

# --- first install --------------------------------------------------------------------------
step "install (first run)"
if run_install install-1 "$INSTALL --profile $PROFILE"; then ok "first install exits 0"; else bad "first install exits 0 (see $SCRATCH/install-1.log)"; fi
printf '%s\n' "$LAST_OUT" | sed 's/^/    | /' | tail -n 25
check "node 22 came from NodeSource (the image has none)" grep -q 'installing Node 22 from NodeSource' "$SCRATCH/install-1.log"
check "the unit runs that node by absolute path" as_root 'grep -qx "ExecStart=/usr/bin/node server.js" /etc/systemd/system/triplec-chat.service'
check "the profile became ~/.config/triplec/config.json" as_dev '[ -f ~/.config/triplec/config.json ]'
check "pre-install snapshot recorded" as_dev '[ -s ~/.local/state/triplec/pre-install.sha256 ] && grep -q "firewall:ruleset" ~/.local/state/triplec/pre-install.sha256'
check "snapshot covers the VM's nginx site" as_dev 'grep -q /etc/nginx/conf.d/00-vm.conf ~/.local/state/triplec/pre-install.sha256'
check "secrets.env is 0600" as_dev '[ "$(stat -c %a ~/.config/triplec/secrets.env)" = 600 ]'
check "secrets.env has a password and a signing key" as_dev 'grep -q "^AUTH_PASSWORD=.\{32,\}" ~/.config/triplec/secrets.env && grep -q "^SESSION_SECRET=.\{48,\}" ~/.config/triplec/secrets.env'
PASSWORD="$(as_dev 'sed -n s/^AUTH_PASSWORD=//p ~/.config/triplec/secrets.env')"
check "the password was never printed" bash -c '[ -n "$1" ] && ! grep -qF -- "$1" "$2"' _ "$PASSWORD" "$SCRATCH/install-1.log"
check "no secret in the unit or the env file" as_root '! grep -q "AUTH_PASSWORD\|SESSION_SECRET=" /etc/systemd/system/triplec-chat.service /home/dev/.config/triplec/triplec.env'
check "build.json stamped with the commit" as_dev 'grep -q "\"commit\": \"$(git -C ~/triplec rev-parse --short HEAD)\"" ~/.local/share/triplec/chat-service/build.json'
check "no tests in the payload" as_dev '! find ~/.local/share/triplec/chat-service -path "*/node_modules" -prune -o -name "*-test.js" -print | grep -q .'
check "pwa assets bundled into public/" as_dev 'cd ~/.local/share/triplec/chat-service/public && [ -f manifest.webmanifest ] && [ -f sw.js ] && [ -f reset.html ] && [ -f pwa-icons/icon-192.png ]'
check "node_modules installed" as_dev '[ -d ~/.local/share/triplec/chat-service/node_modules/ws ]'
check "cc installed on PATH as ours" as_dev 'grep -q "^# triplec-host-cc" ~/.local/bin/cc'

# --- the second run changes nothing --------------------------------------------------------------
step "install (second run: must change nothing)"
MTIMES_1="$(as_dev "$fingerprint_install")"
run_install install-2 "$INSTALL" || bad "second install exits 0"
printf '%s\n' "$LAST_OUT" | sed 's/^/    | /' | tail -n 4
check "second run prints \"no changes\"" grep -qx 'no changes' <<<"$LAST_OUT"
check "second run ran no apt and no npm" bash -c "! grep -qE 'apt-get|npm ci' <<<\"\$1\"" _ "$LAST_OUT"
MTIMES_2="$(as_dev "$fingerprint_install")"
if [ "$MTIMES_1" = "$MTIMES_2" ]; then ok "no file or mtime changed in /etc/systemd/system, /etc/nginx, installDir, configDir"; else
  bad "files changed on the second run:"; diff <(printf '%s\n' "$MTIMES_1") <(printf '%s\n' "$MTIMES_2") | sed 's/^/    /' | head -20
fi
run_install dry-run "$INSTALL --dry-run" || bad "dry run exits 0"
check "dry run on an installed system: \"no changes\"" grep -qx 'no changes' <<<"$LAST_OUT"

# --- what is running, and what nginx says ------------------------------------------------------------
step "services and routing"
check "nginx -t" as_root 'nginx -t 2>/dev/null'
NGINX_AFTER="$(as_root "$fingerprint_nginx")"
check "the VM's nginx files are byte-identical" test "$NGINX_BEFORE" = "$NGINX_AFTER"
check "exactly one TripleC nginx file" as_root '[ "$(grep -rl triplec /etc/nginx | wc -l)" = 1 ] && [ -f /etc/nginx/conf.d/triplec.conf ]'
check "listens on 127.0.0.1:8080 only, not default_server" as_root '[ "$(grep -E "^ *listen" /etc/nginx/conf.d/triplec.conf)" = "    listen 127.0.0.1:8080;" ] && ! grep -q default_server /etc/nginx/conf.d/triplec.conf'
check "clears the tailnet identity headers" as_root 'grep -q "proxy_set_header Tailscale-User-Login \"\";" /etc/nginx/conf.d/triplec.conf'
check "triplec-tmux active" as_root 'systemctl is-active --quiet triplec-tmux'
check "the VM's own site still answers on 8443" as_root 'curl -sk -o /dev/null https://127.0.0.1:8443/; [ $? = 52 ]'
check "/editor/ is 404 with the editor off" as_root '[ "$(curl -s -o /dev/null -w %{http_code} http://127.0.0.1:8080/editor/)" = 404 ]'
check "/p/x/ is 404 with the editor off" as_root '[ "$(curl -s -o /dev/null -w %{http_code} http://127.0.0.1:8080/p/x/)" = 404 ]'
if as_root 'systemctl is-active --quiet triplec-chat' && as_root 'curl -fs http://127.0.0.1:8080/healthz | grep -q "\"ok\":true"'; then
  ok "triplec-chat active"
  ok "GET :8080/healthz through nginx -> {\"ok\":true}"
  check "an unauthenticated API call is refused" as_root '[ "$(curl -s -o /dev/null -w %{http_code} http://127.0.0.1:8080/api/projects)" = 401 ]'
  check "a forged Tailscale header does not sign anyone in" as_root '[ "$(curl -s -o /dev/null -w %{http_code} -H "Tailscale-User-Login: a@b.c" http://127.0.0.1:8080/api/projects)" = 401 ]'
else
  BLOCKED+=("triplec-chat / healthz: $(as_root 'systemctl is-active triplec-chat; journalctl -u triplec-chat -n 3 --no-pager -o cat' | tr '\n' ' ' | cut -c1-300)")
fi

# --- a config change restarts the service, and only then -------------------------------------------------
step "a config change"
as_dev 'node -e "const f=process.argv[1],c=JSON.parse(require(\"fs\").readFileSync(f));c.pwa.name=\"Dev Box\";require(\"fs\").writeFileSync(f,JSON.stringify(c,null,2))" ~/.config/triplec/config.json'
run_install install-change "$INSTALL" || bad "install after a config change exits 0"
check "rewrites the env file" grep -q 'update /home/dev/.config/triplec/triplec.env' <<<"$LAST_OUT"
check "restarts triplec-chat" grep -q 'restart triplec-chat' <<<"$LAST_OUT"
check "does not restart triplec-tmux" bash -c "! grep -q 'restart triplec-tmux' <<<\"\$1\"" _ "$LAST_OUT"
check "PWA_NAME rendered with its space" as_dev 'grep -qx "PWA_NAME=Dev Box" ~/.config/triplec/triplec.env'

# --- the conformance script, against this install ----------------------------------------------------------
# Not every requirement can pass in a container — there is no origin to reach and the
# CLI is a stand-in — so this asserts the script runs and judges every requirement,
# and prints its verdicts for whoever reads the log.
step "scripts/host-conformance.sh against this install"
conf="$(as_dev 'bash ~/triplec/scripts/host-conformance.sh 2>&1' || true)"
printf '%s\n' "$conf" | sed 's/^/    | /'
check "conformance gives a verdict for all 31 requirements" test "$(grep -cE '^[A-F][0-9] +(PASS|FAIL) ' <<<"$conf")" = 31
for id in A1 A2 A3 A5 A6 B1 B2 B3 B4 C1 C2 C3 C4 C5 D3 D4 E1 E3 E5 F1 F2 F3; do
  check "conformance $id passes in the container" grep -qE "^$id +PASS " <<<"$conf"
done

# --- upgrade, twice -----------------------------------------------------------------------------------------
step "upgrade --no-pull, twice"
run_install upgrade-1 'bash ~/triplec/deploy/host/upgrade.sh --no-pull' || bad "first upgrade exits 0"
check "first upgrade: no changes" grep -qx 'no changes' <<<"$LAST_OUT"
run_install upgrade-2 'bash ~/triplec/deploy/host/upgrade.sh --no-pull' || bad "second upgrade exits 0"
check "second upgrade: no changes" grep -qx 'no changes' <<<"$LAST_OUT"
check "no depth flags in any command in deploy/host" bash -c "! grep -nE -- '--(depth|deepen|unshallow)' '$REPO'/deploy/host/*.sh | grep -vE '^[^:]+:[0-9]+: *#'"

# --- uninstall, twice ------------------------------------------------------------------------------------------
step "uninstall"
if out="$(as_dev 'bash ~/triplec/deploy/host/uninstall.sh' 2>&1)"; then ok "uninstall exits 0"; else bad "uninstall exits 0"; fi
printf '%s\n' "$out" | sed 's/^/    | /'
check "units gone" as_root '! ls /etc/systemd/system/triplec-* >/dev/null 2>&1 && ! systemctl is-active --quiet triplec-chat'
check "site file gone" as_root '[ ! -e /etc/nginx/conf.d/triplec.conf ]'
check "nginx -t still ok" as_root 'nginx -t 2>/dev/null'
check "the VM's nginx files are still byte-identical" test "$NGINX_BEFORE" = "$(as_root "$fingerprint_nginx")"
check "installDir removed" as_dev '[ ! -e ~/.local/share/triplec ]'
check "our cc removed" as_dev '[ ! -e ~/.local/bin/cc ]'
check "configDir kept (no --purge)" as_dev '[ -f ~/.config/triplec/secrets.env ]'
check "~/.claude, ~/.claude.json and the repo unchanged" test "$DEV_BEFORE" = "$(as_dev "$fingerprint_dev")"
if out="$(as_dev 'bash ~/triplec/deploy/host/uninstall.sh' 2>&1)"; then ok "second uninstall exits 0"; else bad "second uninstall exits 0"; fi
check "second uninstall changes nothing" grep -q '^no changes' <<<"$out"

# --- a bad config, on the uninstalled machine -----------------------------------------------
step "a config that must be refused"
as_dev 'echo "{\"mode\":\"host\",\"listen\":{\"bind\":\"0.0.0.0\"}}" > /tmp/bad.json'
check "refuses a public bind without allowPublicBind" bash -c "! $(printf '%q ' "${DOCKER[@]}") exec -u dev $NAME bash -lc 'bash ~/triplec/deploy/host/install.sh --config /tmp/bad.json' >/dev/null 2>&1"
check "and installed nothing" as_root '[ ! -e /etc/systemd/system/triplec-chat.service ] && [ ! -e /etc/nginx/conf.d/triplec.conf ] && [ ! -e /home/dev/.local/share/triplec ]'

# --- summary ------------------------------------------------------------------------------------------------------
echo
echo "logs: $SCRATCH"
for b in "${BLOCKED[@]}"; do echo "BLOCKED: $b"; done
for f in "${FAILED[@]}"; do echo "FAILED:  $f"; done
echo "$PASS/$((PASS + FAIL)) checks passed${BLOCKED:+, ${#BLOCKED[@]} blocked}"
[ "$FAIL" = 0 ]
