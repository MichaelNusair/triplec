#!/usr/bin/env bash
#
# Host-mode conformance: one check per requirement, each printed as its ID and
# PASS or FAIL, exit 0 only when nothing failed.
#
#   scripts/host-conformance.sh --static [--profile FILE]...
#   scripts/host-conformance.sh [--config FILE] [--live] [--exercise]
#                               [--expect-tools "claude node git"] [--public-url URL]
#
#   --static         only what needs no installed system: installer lint, config
#                    validation, the git-call and path audits. This is what CI runs.
#   --profile FILE   (static) a host config to validate; repeatable. Default: the
#                    example in deploy/host.
#   --config FILE    (installed) the host config the installer used
#                    (default ~/.config/triplec/config.json)
#   --live           also run the checks that drive a real chat: a reply through
#                    the CLI's own credentials (B1), the permission relay (D1).
#                    Each costs one short model call.
#   --exercise       also run the checks that change state, and put it back: E4
#                    removes a clean, pushed slot the way a worktree reaper would,
#                    then reopens it.
#   --expect-tools   commands that must resolve on the login-shell PATH the
#                    service gives the CLI (A4). Default: "claude node git".
#   --public-url URL the address the VM's own HTTPS proxy serves this install at,
#                    checked with curl (A6, C2). Optional: from the VM itself that
#                    proxy may not be reachable, and then this is a laptop's check.
#   --public-cacert F  the CA that signed that proxy's certificate, when it is a
#                    private one the system store does not hold.
#
# Checks that need a person — installing the PWA on a phone, a push arriving,
# tapping Approve on one — are PASSed on their machine-checkable half and say what
# is left for the person, because their sign-off is a separate act.
#
# Read-only unless --exercise: it signs in to the service, reads its journal, asks
# sudo for `nginx -t` and the same hashes the installer recorded, and nothing else.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
STATIC=0
LIVE=0
EXERCISE=0
CONFIG="${HOME}/.config/triplec/config.json"
PROFILES=()
EXPECT_TOOLS="claude node git"
PUBLIC_URL=""
PUBLIC_CURL=(curl -s)

while [ $# -gt 0 ]; do
  case "$1" in
    --static) STATIC=1; shift ;;
    --profile) PROFILES+=("${2:?--profile needs a file}"); shift 2 ;;
    --config) CONFIG="${2:?--config needs a file}"; shift 2 ;;
    --live) LIVE=1; shift ;;
    --exercise) EXERCISE=1; shift ;;
    --expect-tools) EXPECT_TOOLS="${2:?}"; shift 2 ;;
    --public-url) PUBLIC_URL="${2%/}"; shift 2 ;;
    --public-cacert) PUBLIC_CURL+=(--cacert "${2:?}"); shift 2 ;;
    -h | --help) sed -n '2,34p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# One verdict per requirement. A requirement checked from two sides — statically and
# on the installed system — is one line: FAIL if either side failed, with both
# pieces of evidence.
IDS=(A1 A2 A3 A4 A5 A6 B1 B2 B3 B4 C1 C2 C3 C4 C5 C6 D1 D2 D3 D4 E1 E2 E3 E4 E5 E6 F1 F2 F3 F4 F5)
declare -A VERDICT=()
declare -A EVIDENCE=()
result() { # ID PASS|FAIL evidence...
  local id="$1" verdict="$2"
  shift 2
  if [ -n "${VERDICT[$id]:-}" ]; then
    [ "$verdict" = FAIL ] && VERDICT[$id]=FAIL
    EVIDENCE[$id]="${EVIDENCE[$id]}; $*"
  else
    VERDICT[$id]="$verdict"
    EVIDENCE[$id]="$*"
  fi
}
pass() { result "$1" PASS "${@:2}"; }
fail() { result "$1" FAIL "${@:2}"; }
report() {
  local failed=0 id
  for id in "${IDS[@]}"; do
    [ -n "${VERDICT[$id]:-}" ] || continue
    printf '%-3s %s  %s\n' "$id" "${VERDICT[$id]}" "${EVIDENCE[$id]}"
    [ "${VERDICT[$id]}" = PASS ] || failed=$((failed + 1))
  done
  echo
  if [ "$failed" -eq 0 ]; then echo "$1: all PASS"; else echo "$1: $failed FAIL"; fi
  [ "$failed" -eq 0 ]
}

NODE="$(command -v node || true)"

# --- the static subset ----------------------------------------------------------------

static_checks() {
  # A1: the installer and its siblings are valid shell, and lint clean when shellcheck
  # is there to ask.
  local scripts=("$REPO"/deploy/host/*.sh "$REPO"/deploy/host/test/*.sh "$REPO"/scripts/host-conformance.sh)
  local bad=""
  for f in "${scripts[@]}"; do bash -n "$f" 2>/dev/null || bad="$bad $(basename "$f")"; done
  if [ -n "$bad" ]; then
    fail A1 "syntax errors in:$bad"
  elif command -v shellcheck >/dev/null; then
    if out="$(shellcheck "${scripts[@]}" 2>&1)"; then pass A1 "installer scripts parse and pass shellcheck"; else fail A1 "shellcheck: $(echo "$out" | head -3 | tr '\n' ' ')"; fi
  else
    pass A1 "installer scripts parse (shellcheck not installed; CI runs it)"
  fi

  # A2: no code outside chat-service/host.js names the workspace user or volume.
  local hits
  hits="$(grep -rnE '\bcoder\b|/workspace\b' "$REPO/chat-service" "$REPO/claude-broker" \
    --include='*.js' --include='*.py' --include=wrapper \
    --exclude='*-test.js' --exclude=host.js --exclude-dir=node_modules 2>/dev/null |
    grep -vE '^[^:]+:[0-9]+:\s*(//|\*|/\*|#)' || true)"
  if [ -z "$hits" ]; then pass A2 "user, home and paths come from config; AWS defaults only in chat-service/host.js"; else fail A2 "literals outside host.js: $(echo "$hits" | head -3 | tr '\n' ' ')"; fi

  # F5: the operator docs exist, and every profile validates.
  for d in docs/HOST.md deploy/host/README.md docs/SECURITY.md; do
    [ -f "$REPO/$d" ] || fail F5 "missing $d"
  done
  [ ${#PROFILES[@]} -gt 0 ] || PROFILES=("$REPO/deploy/host/triplec.host.example.json")
  if [ -z "$NODE" ]; then
    fail F5 "node is needed to validate host configs"
  else
    local bad_profiles=""
    for p in "${PROFILES[@]}"; do
      "$NODE" "$REPO/deploy/host/config.mjs" validate "$p" >/dev/null 2>&1 || bad_profiles="$bad_profiles $p"
    done
    if [ -z "$bad_profiles" ]; then pass F5 "config validates: ${PROFILES[*]##*/}"; else fail F5 "invalid config:$bad_profiles"; fi
  fi

  # E3: no TripleC git call passes a history-depth flag. Test fixtures excluded —
  # they build the shallow clone the check is about.
  hits="$(grep -rnE --exclude='*-test.js' --exclude='*-test.mjs' --exclude=host-conformance.sh --exclude-dir=node_modules \
    -e '--(depth|deepen|unshallow)\b' "$REPO/chat-service" "$REPO/claude-broker" "$REPO/scripts" "$REPO/deploy/host" 2>/dev/null |
    grep -vE '^[^:]+:[0-9]+:\s*(//|\*|#)' || true)"
  if [ -z "$hits" ]; then pass E3 "no git invocation passes --depth, --deepen or --unshallow"; else fail E3 "$(echo "$hits" | head -3 | tr '\n' ' ')"; fi

  # D2 (static half): the CLI is run with no setting-source, settings or MCP
  # overrides, so it loads exactly what it loads over SSH.
  if grep -nE "'--(setting-sources|settings|strict-mcp-config|mcp-config|bare)'" "$REPO/chat-service/session-manager.js" >/dev/null; then
    fail D2 "session-manager.js passes a settings/MCP override to the CLI"
  else
    pass D2 "the CLI is started with no settings, hooks or MCP overrides (static half)"
  fi

  # F4: this script, and the CI job that runs this subset.
  if [ -f "$REPO/.github/workflows/host-static.yml" ] && grep -q 'host-conformance.sh --static' "$REPO/.github/workflows/host-static.yml"; then
    pass F4 "conformance script present; CI runs its static subset"
  else
    fail F4 "no CI job runs scripts/host-conformance.sh --static"
  fi
}

if [ "$STATIC" = 1 ]; then
  static_checks
  report "static subset"
  exit
fi

# --- an installed system -------------------------------------------------------------------

[ -n "$NODE" ] || { echo "node is not on PATH" >&2; exit 2; }
[ -f "$CONFIG" ] || { echo "no host config at $CONFIG — run deploy/host/install.sh first, or pass --config" >&2; exit 2; }
cfg() { "$NODE" "$REPO/deploy/host/config.mjs" get "$CONFIG" "$1"; }
INSTALL_DIR="$(cfg installDir)"
CONFIG_DIR="$(cfg configDir)"
STATE_DIR="$(cfg stateDir)"
NGINX_PORT="$(cfg listen.nginxPort)"
APP_PORT="$(cfg listen.appPort)"
ENV_FILE="$CONFIG_DIR/triplec.env"
SECRETS="$CONFIG_DIR/secrets.env"
APP="http://127.0.0.1:$APP_PORT"
SITE=/etc/nginx/conf.d/triplec.conf
envv() { sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | head -1; }
feat() { case ",$(envv TRIPLEC_FEATURES)," in *",$1,"*) echo true ;; *) echo false ;; esac; }
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
JAR="$WORK/cookies"
PW="$(sed -n 's/^AUTH_PASSWORD=//p' "$SECRETS" 2>/dev/null || true)"
signed_in=0
if [ -n "$PW" ]; then
  code="$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR" -H 'Content-Type: application/json' \
    --data-binary @- "$APP/api/login" <<<"{\"password\":\"$PW\"}")"
  [ "$code" = 204 ] && signed_in=1
fi
api() { curl -s -b "$JAR" "$@"; }
status() { curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "$@"; }
MAIN_PID="$(systemctl show -p MainPID --value triplec-chat 2>/dev/null || echo 0)"
proc_env() { [ "$MAIN_PID" -gt 0 ] 2>/dev/null && tr '\0' '\n' <"/proc/$MAIN_PID/environ" 2>/dev/null; }
FIRST_PROJECT="$("$NODE" -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(p[0])console.log(p[0].path)' "$CONFIG_DIR/projects.json" 2>/dev/null || true)"
[ -n "$FIRST_PROJECT" ] || FIRST_PROJECT="$(envv PROJECTS_ROOT)"

static_checks

# A1: a re-run would change nothing.
if out="$("$REPO/deploy/host/install.sh" --config "$CONFIG" --dry-run 2>&1)" && echo "$out" | grep -q 'no changes'; then
  pass A1 "install.sh --dry-run on this machine: no changes (a second run is a no-op)"
else
  fail A1 "a re-run would change: $(echo "$out" | grep 'would:' | head -3 | tr '\n' ' ')"
fi

# A2: services run as the developer.
unit_user="$(systemctl show -p User --value triplec-chat 2>/dev/null)"
proc_user="$(ps -o user= -p "$MAIN_PID" 2>/dev/null | tr -d ' ')"
if [ "$unit_user" = "$(id -un)" ] && [ "$proc_user" = "$(id -un)" ]; then pass A2 "triplec-chat runs as $(id -un)"; else fail A2 "triplec-chat runs as unit=$unit_user process=$proc_user, not $(id -un)"; fi

# A3: the developer's own ~/.claude and ~/.claude.json.
svc_home="$(proc_env | sed -n 's/^HOME=//p')"
svc_claude="$(proc_env | sed -n 's/^CLAUDE_HOME=//p')"
if [ "$svc_home" = "$HOME" ] && [ "$svc_claude" = "$HOME/.claude" ]; then
  pass A3 "sessions use HOME=$HOME and $HOME/.claude${HOME:+ (MCP servers from ~/.claude.json)}"
else
  fail A3 "service HOME=$svc_home CLAUDE_HOME=$svc_claude, expected $HOME and $HOME/.claude"
fi

# A4: the login shell's PATH, and the tools on it.
# shellcheck disable=SC2016 # expanded by the login shell, not here
login_path="$("${SHELL:-/bin/bash}" -l -c 'printf %s "$PATH"' 2>/dev/null | tail -1)"
missing=""
for t in $EXPECT_TOOLS; do PATH="$login_path" command -v "$t" >/dev/null 2>&1 || missing="$missing $t"; done
svc_path="$(proc_env | sed -n 's/^PATH=//p')"
if [ "$(envv TRIPLEC_LOGIN_PATH)" != 1 ]; then
  fail A4 "claude.loginShellPath is off: the CLI gets the unit's PATH"
elif [ -n "$missing" ]; then
  fail A4 "not on the login PATH:$missing"
else
  pass A4 "login-shell PATH is used; resolves: $EXPECT_TOOLS${svc_path:+ (unit PATH is replaced at startup)}"
fi

# A5: only what is enabled is installed, and off means 404.
a5=""
if [ "$(feat editor)" = false ]; then
  [ -x "$INSTALL_DIR/code-server/bin/code-server" ] && a5="$a5 code-server-installed"
  c="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$NGINX_PORT/editor/")"; [ "$c" = 404 ] || a5="$a5 /editor/=$c"
fi
if [ "$(feat voice)" = false ]; then
  [ -e "$INSTALL_DIR/whisper" ] && a5="$a5 whisper-installed"
fi
if [ -z "$a5" ]; then pass A5 "features: $(envv TRIPLEC_FEATURES); off features are not installed and their routes 404"; else fail A5 "$a5"; fi

# A6: one site file, nginx -t, every other nginx file unchanged, the chat loads.
a6=""
sudo -n nginx -t >/dev/null 2>&1 || a6="$a6 nginx-t-fails"
grep -q "listen 127.0.0.1:$NGINX_PORT;" "$SITE" 2>/dev/null || a6="$a6 site-not-loopback-$NGINX_PORT"
if [ -f "$STATE_DIR/pre-install.sha256" ]; then
  changed_nginx="$(grep '  /etc/nginx/' "$STATE_DIR/pre-install.sha256" | sudo -n sha256sum -c --quiet - 2>&1 | grep -v '^sha256sum:' || true)"
  [ -z "$changed_nginx" ] || a6="$a6 changed:$(echo "$changed_nginx" | head -2 | tr '\n' ' ')"
else
  a6="$a6 no-pre-install-snapshot"
fi
c="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$NGINX_PORT/healthz")"; [ "$c" = 200 ] || a6="$a6 healthz=$c"
if [ -n "$PUBLIC_URL" ]; then
  c="$("${PUBLIC_CURL[@]}" -o /dev/null -w '%{http_code}' "$PUBLIC_URL/healthz")"; [ "$c" = 200 ] || a6="$a6 public-healthz=$c"
fi
if [ -z "$a6" ]; then pass A6 "nginx -t ok; one site on 127.0.0.1:$NGINX_PORT; other nginx files unchanged${PUBLIC_URL:+; $PUBLIC_URL answers}"; else fail A6 "$a6"; fi

# B1: login mode sets no provider variables.
provider="$(proc_env | grep -E '^(CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY)|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN)=' || true)"
mode="$(envv CLAUDE_AUTH_MODE)"
if [ "$mode" = login ] && [ -n "$provider" ]; then
  fail B1 "login mode, but the service environment has: $(echo "$provider" | cut -d= -f1 | tr '\n' ' ')"
elif [ "$LIVE" = 1 ] && [ -n "$FIRST_PROJECT" ]; then
  if out="$(TRIPLEC_SECRETS_FILE="$SECRETS" "$NODE" "$REPO/scripts/host-conformance-live.mjs" reply --base "$APP" --cwd "$FIRST_PROJECT" --install-dir "$INSTALL_DIR" 2>&1)"; then
    pass B1 "authMode $mode; ${out#PASS }"
  else
    fail B1 "authMode $mode; ${out#FAIL }"
  fi
else
  pass B1 "authMode $mode with no provider variables (run with --live to get a reply through it)"
fi

# B2: no --model unless configured.
if [ "$signed_in" = 1 ]; then
  default="$(api "$APP/api/models" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).default)}catch{console.log("?")}})')"
  configured="$(envv ANTHROPIC_MODEL)"
  if [ "$default" = "$configured" ]; then pass B2 "default model: ${configured:-the CLI default}"; else fail B2 "the service offers default '$default', config says '$configured'"; fi
else
  fail B2 "could not sign in to ask (no password login)"
fi

# B3: nothing AWS.
aws="$(proc_env | grep -E '^(AWS_|GITHUB_SECRET_ARN=)' | cut -d= -f1 | tr '\n' ' ' || true)"
if [ -z "$aws" ] && [ "$(stat -c %a "$SECRETS" 2>/dev/null)" = 600 ]; then pass B3 "no AWS_* or Secrets Manager; secrets file is 0600"; else fail B3 "${aws:+environment has: $aws}$( [ "$(stat -c %a "$SECRETS" 2>/dev/null)" = 600 ] || echo " secrets file mode $(stat -c %a "$SECRETS" 2>/dev/null)")"; fi

# B4: dictation clean-up.
if [ "$signed_in" = 1 ]; then
  out="$(api -H 'Content-Type: application/json' -d '{"text":"um so deploy it"}' "$APP/api/polish")"
  if [ "$(feat polish)" = false ]; then
    case "$out" in *'"text":"um so deploy it"'*'"changed":false'*) pass B4 "polish off: the raw transcript comes back" ;; *) fail B4 "polish off, but: $out" ;; esac
  else
    case "$out" in *'"text"'*) pass B4 "polish on: $out" ;; *) fail B4 "polish route answered: $out" ;; esac
  fi
else
  fail B4 "could not sign in to ask"
fi

# C1: loopback only.
listeners="$(ss -Hltn "sport = :$APP_PORT" 2>/dev/null | awk '{print $4}')"
if [ -n "$listeners" ] && ! echo "$listeners" | grep -vqE '^(127\.|\[::1\]|\[::ffff:127\.)'; then
  pass C1 "app listens on $(echo "$listeners" | tr '\n' ' ')only"
else
  fail C1 "app listeners: ${listeners:-none}"
fi

# C2: Secure, HttpOnly cookie through a TLS proxy; the chat at the root.
if [ -n "$PW" ]; then
  hdr="$(curl -s -D - -o /dev/null -H 'X-Forwarded-Proto: https' -H 'Content-Type: application/json' --data-binary @- "http://127.0.0.1:$NGINX_PORT/api/login" <<<"{\"password\":\"$PW\"}" | tr -d '\r' | grep -i '^set-cookie:')"
  root="$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "http://127.0.0.1:$NGINX_PORT/")"
  if [ -n "$PUBLIC_URL" ]; then
    # And through the real proxy, which is the case the requirement is about.
    phdr="$("${PUBLIC_CURL[@]}" -D - -o /dev/null -H 'Content-Type: application/json' --data-binary @- "$PUBLIC_URL/api/login" <<<"{\"password\":\"$PW\"}" | tr -d '\r' | grep -i '^set-cookie:')"
    echo "$phdr" | grep -q 'Secure;' && echo "$phdr" | grep -q HttpOnly || hdr="through $PUBLIC_URL: ${phdr:-no cookie}"
  fi
  if echo "$hdr" | grep -q 'Secure;' && echo "$hdr" | grep -q HttpOnly && [ "${root%% *}" = 302 ]; then
    pass C2 "cookie is Secure and HttpOnly behind a proxy${PUBLIC_URL:+ and through $PUBLIC_URL}; / redirects to the chat"
  else
    fail C2 "cookie: ${hdr:-none}; root: $root"
  fi
else
  fail C2 "no password login to test the cookie with"
fi

# C3: an application ping.
if out="$(TRIPLEC_SECRETS_FILE="$SECRETS" "$NODE" "$REPO/scripts/host-conformance-live.mjs" ping --base "$APP" --install-dir "$INSTALL_DIR" 2>&1)"; then
  pass C3 "${out#PASS }; clients reconnect and reattach after 75s of silence"
else
  fail C3 "${out#FAIL }"
fi

# C4: the identity header is believed only from tailscaled's socket.
forged="$(curl -s -o /dev/null -w '%{http_code}' -H 'Tailscale-User-Login: someone@example.com' -H 'Accept: application/json' "http://127.0.0.1:$NGINX_PORT/api/projects")"
direct="$(curl -s -o /dev/null -w '%{http_code}' -H "Tailscale-User-Login: $(envv CW_TRUSTED_EMAILS | cut -d, -f1)" -H 'Accept: application/json' "$APP/api/projects")"
if [ "$(envv CW_AUTH_MODE)" = trusted-header ]; then
  if [ "$forged" = 401 ] && [ "$direct" = 401 ] && grep -q 'Tailscale-User-Login ""' "$SITE"; then
    pass C4 "a forged header through nginx ($forged) and from a non-tailscaled socket ($direct) is refused; owner via Serve is the manual half"
  else
    fail C4 "forged via nginx: $forged, owner's header from this user's socket: $direct"
  fi
else
  if [ "$forged" = 401 ]; then pass C4 "auth mode $(envv CW_AUTH_MODE); identity headers are not trusted ($forged)"; else fail C4 "a forged identity header got $forged"; fi
fi

# C5: audit lines in the journal, and no secret in it.
journal="$(journalctl -u triplec-chat --no-pager -o cat 2>/dev/null || sudo -n journalctl -u triplec-chat --no-pager -o cat 2>/dev/null)"
secret="$(sed -n 's/^SESSION_SECRET=//p' "$SECRETS" 2>/dev/null)"
leak=0
for v in "$secret" "$PW"; do [ -n "$v" ] && printf '%s' "$journal" | grep -qF -- "$v" && leak=1; done
if ! printf '%s' "$journal" | grep -q '"audit":"triplec"'; then
  fail C5 "no audit lines in journalctl -u triplec-chat"
elif [ "$leak" = 1 ]; then
  fail C5 "the journal contains a secret value"
elif [ "$(envv CW_SINGLE_OWNER)" != 1 ]; then
  fail C5 "singleOwner is off"
else
  n="$(printf '%s\n' "$journal" | grep -c '"audit":"triplec"')"
  pass C5 "$n audit lines; no secret in the journal; single owner"
fi

# C6: what a phone needs, served; installing and a push arriving are the owner's.
if [ "$signed_in" = 1 ]; then
  m="$(status "$APP/chat/manifest.webmanifest")"; w="$(status "$APP/chat/sw.js")"
  k="$( [ "$(feat push)" = true ] && status "$APP/api/push/key" || echo off)"
  if [ "$m" = 200 ] && [ "$w" = 200 ] && { [ "$k" = 200 ] || [ "$k" = off ]; }; then
    pass C6 "manifest, service worker and push key are served (manual: install on iOS and Android over the tailnet, receive a finish notification)"
  else
    fail C6 "manifest $m, sw.js $w, push key $k"
  fi
else
  fail C6 "could not sign in to check the PWA assets"
fi

# D1: prompts by default, relayed.
pm="$(envv DEFAULT_PERMISSION_MODE)"
if [ "$pm" != manual ] && [ "$pm" != acceptEdits ]; then
  fail D1 "default permission mode is $pm"
elif [ "$LIVE" = 1 ] && [ -n "$FIRST_PROJECT" ]; then
  if out="$(TRIPLEC_SECRETS_FILE="$SECRETS" "$NODE" "$REPO/scripts/host-conformance-live.mjs" permission --base "$APP" --cwd "$FIRST_PROJECT" --install-dir "$INSTALL_DIR" 2>&1)" &&
    sleep 1 && journalctl -u triplec-chat --since '-5 min' -o cat 2>/dev/null | grep -q '"event":"permission_decision"'; then
    pass D1 "default $pm; ${out#PASS }; decision audited (manual: approve and deny on a phone)"
  else
    fail D1 "default $pm; ${out#FAIL }"
  fi
else
  pass D1 "default permission mode $pm, relayed to the chat (run with --live to exercise it; manual: approve and deny on a phone)"
fi

# D2 (installed half): sessions see the same hooks as the CLI over SSH, because
# they run with the same HOME and nothing overrides settings. The blocked-edit
# comparison against a repository's own hook is the owner's (see docs/HOST.md).

# D3: nothing changed in sudoers, ssh, gcloud config or the firewall.
if [ -f "$STATE_DIR/pre-install.sha256" ]; then
  d3="$(grep -E '  (/etc/sudoers.d/|/etc/ssh/|.*/\.config/gcloud/)' "$STATE_DIR/pre-install.sha256" | sudo -n sha256sum -c --quiet - 2>&1 | grep -v '^sha256sum:' || true)"
  fw_then="$(sed -n 's/  firewall:ruleset$//p' "$STATE_DIR/pre-install.sha256")"
  fw_now="$({ sudo -n nft list ruleset 2>/dev/null || sudo -n iptables-save 2>/dev/null || true; } | sed -E -e '/^#/d' -e 's/\[[0-9]+:[0-9]+\]//g' -e 's/packets [0-9]+ bytes [0-9]+//g' | sha256sum | cut -d' ' -f1)"
  for d in /etc/sudoers.d /etc/ssh; do
    now="$(sudo -n find "$d" -xtype f 2>/dev/null | sort)"
    for f in $now; do grep -q "  $f\$" "$STATE_DIR/pre-install.sha256" || d3="$d3 new:$f"; done
  done
  [ "$fw_then" = "$fw_now" ] || d3="$d3 firewall-ruleset-changed"
  if [ -z "$d3" ]; then pass D3 "sudoers.d, /etc/ssh, gcloud configuration and the firewall match the pre-install snapshot"; else fail D3 "$(echo "$d3" | head -3 | tr '\n' ' ')"; fi
else
  fail D3 "no pre-install snapshot at $STATE_DIR/pre-install.sha256"
fi

# D4: the addendum ships with the install and the installer links it.
if grep -q '^## Host mode on a developer VM' "$INSTALL_DIR/docs/SECURITY.md" 2>/dev/null && grep -qi 'production' "$INSTALL_DIR/docs/SECURITY.md" &&
  grep -q 'host-mode-on-a-developer-vm' "$REPO/deploy/host/install.sh"; then
  pass D4 "SECURITY.md host-mode addendum installed, names production reach, linked from the installer's output"
else
  fail D4 "the host-mode addendum is missing from $INSTALL_DIR/docs/SECURITY.md or the installer output"
fi

# E1: the registry is what the chat lists.
if [ "$signed_in" = 1 ]; then
  want="$("$NODE" -e 'for(const p of JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")))console.log(p.name+"="+p.path)' "$CONFIG_DIR/projects.json" 2>/dev/null | sort)"
  got="$(api "$APP/api/projects" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const p of JSON.parse(s).projects)console.log(p.name+"="+p.path)})' 2>/dev/null | sort)"
  if [ -n "$want" ] && [ "$want" = "$got" ]; then pass E1 "registered: $(echo "$want" | tr '\n' ' ')"; elif [ -z "$want" ]; then fail E1 "no projects registered"; else fail E1 "registry: $(echo "$want" | tr '\n' ' ') listed: $(echo "$got" | tr '\n' ' ')"; fi
else
  fail E1 "could not sign in to list projects"
fi

# E2: slot count and set-up command, per project.
if [ "$signed_in" = 1 ]; then
  # shellcheck disable=SC2016 # JavaScript template literals
  e2="$("$NODE" -e '
    const fs=require("fs");const reg=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    console.log(reg.map(p=>`${p.name}:${p.slots.count} slots, set-up ${p.slots.postCreate?"configured":"not configured"}`).join("; "))' "$CONFIG_DIR/projects.json" 2>/dev/null)"
  first="$("$NODE" -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(r[0])console.log(r[0].name)' "$CONFIG_DIR/projects.json" 2>/dev/null)"
  n="$(api "$APP/api/slots?project=$first" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).slots.length)}catch{console.log(0)}})')"
  if [ "${n:-0}" -gt 0 ]; then pass E2 "$e2"; else fail E2 "no slots answered for $first"; fi
else
  fail E2 "could not sign in"
fi

# E3 (installed half): registered clones that were shallow are still shallow.
e3=""
while IFS= read -r p; do
  [ -d "$p/.git" ] || continue
  [ -f "$p/.git/shallow" ] && [ "$(git -C "$p" rev-parse --is-shallow-repository)" != true ] && e3="$e3 $p"
done < <("$NODE" -e 'for(const p of JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")))console.log(p.path)' "$CONFIG_DIR/projects.json" 2>/dev/null)

# E4: a slot the reaper removed comes back, history and all.
if [ "$EXERCISE" = 1 ] && [ "$signed_in" = 1 ]; then
  e4="$("$NODE" - "$CONFIG_DIR/projects.json" "$APP" "$JAR" <<'NODE'
const [file, app, jar] = process.argv.slice(2);
const fs = require('fs'); const { execFileSync } = require('child_process');
const cookie = fs.readFileSync(jar, 'utf8').split('\n').filter((l) => l.includes('cw_session')).map((l) => { const c = l.split('\t'); return `${c[5]}=${c[6]}`; })[0];
const p = JSON.parse(fs.readFileSync(file, 'utf8'))[0];
const n = p.slots.count; const slot = `${p.path}/.claude/worktrees/slot-${n}`;
const git = (...a) => execFileSync('git', a, { cwd: p.path, encoding: 'utf8' }).trim();
(async () => {
  const H = { Cookie: cookie, 'Content-Type': 'application/json' };
  const prep = await (await fetch(`${app}/api/slots/prepare`, { method: 'POST', headers: H, body: JSON.stringify({ project: p.name, slot: n }) })).json();
  if (!prep.ok) return console.log(`FAIL could not prepare slot-${n}: ${prep.error}`);
  if (prep.dirty || prep.unpushed) return console.log(`FAIL slot-${n} is not clean and pushed, so a reaper would not take it; pick another`);
  const before = (await (await fetch(`${app}/api/projects`, { headers: H })).json()).projects.find((x) => x.name === p.name).sessions.filter((s) => s.cwd === slot).length;
  git('worktree', 'remove', slot);
  const listed = (await (await fetch(`${app}/api/projects`, { headers: H })).json()).projects.find((x) => x.name === p.name).sessions.filter((s) => s.cwd === slot).length;
  const again = await (await fetch(`${app}/api/slots/prepare`, { method: 'POST', headers: H, body: JSON.stringify({ project: p.name, slot: n }) })).json();
  const back = fs.existsSync(`${slot}/.git`);
  console.log(again.ok && back && listed === before ? `PASS slot-${n} removed and recreated; ${listed} past conversation(s) still listed` : `FAIL recreated=${back} listed ${listed} of ${before}`);
})();
NODE
)"
  case "$e4" in PASS*) pass E4 "${e4#PASS }" ;; *) fail E4 "${e4#FAIL }" ;; esac
else
  pass E4 "covered by chat-service/host-test.js; run with --exercise to remove and recreate a slot here"
fi
[ -z "$e3" ] || fail E3 "no longer shallow:$e3"

# E5: retire off means no removal route.
if [ "$(feat retire)" = false ]; then
  c="$(status -H 'Content-Type: application/json' -d '{"name":"x"}' "$APP/api/projects/remove")"
  if [ "$c" = 404 ]; then pass E5 "retire off: POST /api/projects/remove is 404"; else fail E5 "retire off, but the removal route answered $c"; fi
else
  fail E5 "retire is on"
fi

# E6: git credentials are the VM's own.
if [ -n "$(proc_env | grep '^GITHUB_SECRET_ARN=' || true)" ]; then
  fail E6 "GITHUB_SECRET_ARN is set"
elif [ -n "$FIRST_PROJECT" ] && GIT_TERMINAL_PROMPT=0 timeout 30 git -C "$FIRST_PROJECT" ls-remote --exit-code origin HEAD >/dev/null 2>&1; then
  pass E6 "no GITHUB_SECRET_ARN; git reaches origin with the VM's own credentials"
else
  fail E6 "git ls-remote origin failed in ${FIRST_PROJECT:-no project} with the VM's own credentials"
fi

# F1: units.
f1=""
for u in triplec-chat $( [ "$(feat mux)" = true ] && echo triplec-tmux ); do
  [ "$(systemctl is-enabled "$u" 2>/dev/null)" = enabled ] || f1="$f1 $u-not-enabled"
  [ "$(systemctl is-active "$u" 2>/dev/null)" = active ] || f1="$f1 $u-not-active"
  [ "$(systemctl show -p Restart --value "$u")" = on-failure ] || f1="$f1 $u-restart"
  systemctl show -p After --value "$u" | grep -q network-online.target || f1="$f1 $u-not-after-network"
  [ "$(systemctl show -p User --value "$u")" = "$(id -un)" ] || f1="$f1 $u-user"
done
if [ -z "$f1" ]; then pass F1 "units enabled, active, Restart=on-failure, after network-online, as $(id -un), logging to journald"; else fail F1 "$f1"; fi

# F2: the session cap, and memory per session on the admin page.
cap="$(envv MAX_LIVE_SESSIONS)"
if [ -z "$cap" ]; then
  fail F2 "maxLiveSessions is not set"
elif [ "$(feat admin)" = true ] && [ "$signed_in" = 1 ]; then
  c="$(status "$APP/api/admin/overview")"
  if [ "$c" = 200 ]; then pass F2 "maxLiveSessions $cap; admin overview reports memory per session"; else fail F2 "admin overview answered $c"; fi
else
  pass F2 "maxLiveSessions $cap"
fi

# F3: upgrade and uninstall are present and idempotent by construction.
if [ -x "$REPO/deploy/host/upgrade.sh" ] && [ -x "$REPO/deploy/host/uninstall.sh" ] &&
  ! grep -nE 'rm -rf[^#]*(\.claude|repos)' "$REPO/deploy/host/uninstall.sh" >/dev/null; then
  pass F3 "upgrade.sh and uninstall.sh present; uninstall never touches ~/.claude or repositories (container test runs both twice)"
else
  fail F3 "upgrade.sh/uninstall.sh missing, or uninstall touches ~/.claude or a repository"
fi

for id in "${IDS[@]}"; do [ -n "${VERDICT[$id]:-}" ] || fail "$id" "no check ran"; done
report conformance
