#!/bin/bash
set -euxo pipefail
exec > >(tee /var/log/bootstrap.log) 2>&1

# cloud-init runs without HOME set; the code-server installer reads it under
# `set -u` and aborts. Export it before anything else runs.
export HOME="${HOME:-/root}"

APP_PORT="__APP_PORT__"
REGION="__REGION__"
PASSWORD_SECRET_ARN="__PASSWORD_SECRET_ARN__"
SESSION_SECRET_ARN="__SESSION_SECRET_ARN__"
WHISPER_SECRET_ARN="__WHISPER_SECRET_ARN__"
GITHUB_SECRET_ARN="__GITHUB_SECRET_ARN__"
DATA_VOLUME_ID="__DATA_VOLUME_ID__"
DOMAIN_NAME="__DOMAIN_NAME__"
VPC_CIDR="__VPC_CIDR__"
AUTH_MODE="__AUTH_MODE__"
OIDC_CLIENT_ID="__OIDC_CLIENT_ID__"
# Who is allowed in when AUTH_MODE is oidc. The load balancer only proves the
# caller has an account with the provider — with Google, that is everyone — so
# this list is the check that matters, and the chat service refuses to start in
# oidc mode without it. Comma-separated addresses; the domain form is for a
# provider that owns a domain.
OIDC_ALLOWED_EMAILS="__OIDC_ALLOWED_EMAILS__"
OIDC_ALLOWED_DOMAIN="__OIDC_ALLOWED_DOMAIN__"
GIT_USER_NAME="__GIT_USER_NAME__"
GIT_USER_EMAIL="__GIT_USER_EMAIL__"
DEFAULT_MODEL="__DEFAULT_MODEL__"
# `bypassPermissions` lets Claude run commands without asking, which is the
# point of the product but also means anyone who gets past the login page has a
# shell. Configurable so a deployment can choose `acceptEdits` or `plan`.
PERMISSION_MODE="__PERMISSION_MODE__"
EFFORT_LEVEL="__EFFORT_LEVEL__"
# What this deployment calls itself, in front of every title the app shows: the
# label under a project's home screen icon, the browser tab, the editor window.
# Empty means one deployment with nothing to tell apart, and titles name the
# project alone. It reaches the chat service as PWA_NAME (see the unit below) and
# the editor as window.title. infra/config.js restricts it to a short plain label
# of letters, digits, spaces, dots, dashes and underscores, which is what makes it
# safe to put in a systemd Environment line and a JSON settings file from here.
PWA_NAME="__PWA_NAME__"

USER_NAME="coder"
DATA_MNT="/workspace"

# ---------------------------------------------------------------------------
# Packages
# ---------------------------------------------------------------------------
# Split into required vs nice-to-have: a single unavailable optional package
# must not abort provisioning (this script runs under `set -e`).
# tmux is load-bearing, not a convenience: it is what makes a Claude session
# outlive the browser. code-server tears the extension host down within seconds
# of the last WebSocket closing (measured: 5s, mid-turn, work lost), and the
# extension's CLI dies with it. A session started under tmux belongs to the tmux
# server instead, so it survives closing the editor, a code-server restart, and a
# redeploy — and several devices can attach to the same live session at once.
# That server gets its own systemd unit further down; being merely detached from
# the terminal is not enough, because a server started from an editor terminal
# still sits in code-server's cgroup and dies when that unit restarts.
# zsh is the interactive shell for this box (see the User section below). It is
# in the required list rather than the optional one because the login shell is
# set to it: a missing zsh would leave the user with no working shell at all.
dnf install -y git tar gzip unzip jq nginx gcc gcc-c++ make cmake python3 python3-pip \
  openssl shadow-utils nvme-cli xfsprogs tmux zsh
# ripgrep is not in the AL2023 repos; Claude Code ships its own, so this is
# only a convenience for interactive shell use.
dnf install -y ripgrep || echo "ripgrep unavailable in repos; skipping"

# The shared libraries a headless Chromium links against. Not a runtime dependency
# of anything here — this is for agents, and it is the other half of giving them
# sudo (see the User section). A browser is the one install that does not work by
# reading the error: Playwright fetches its own binary into ~/.cache with no
# privileges, then fails on these, and `playwright install-deps` cannot help
# because it only knows apt — on AL2023 it exits 127 on a missing apt-get. That
# left the package names to be rediscovered from `ldd` output, one NOT_FOUND at a
# time. `chromium` itself is not in the AL2023 repos (checked 2026-09-21), so
# there is no distro package to lean on instead.
# Verified by rendering a page with chrome-headless-shell on arm64, ldd clean.
dnf install -y nss nspr atk at-spi2-atk at-spi2-core cups-libs libdrm libX11 \
  libXcomposite libXdamage libXext libXfixes libXrandr libxcb libxkbcommon \
  mesa-libgbm alsa-lib pango cairo expat dbus-libs libxshmfence ||
  echo "headless browser libraries unavailable; a browser will need them installed by hand"

# Node 22 (Claude Code CLI requires >= 18; 22 is current LTS)
curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
dnf install -y nodejs

# ---------------------------------------------------------------------------
# User
# ---------------------------------------------------------------------------
id -u "$USER_NAME" &>/dev/null || useradd -m -s /bin/zsh "$USER_NAME"

# Also switch an account created by an earlier deploy, when bash was the default.
# Only when it differs, so the log says something when it actually changes — and
# so a shell deliberately changed on the box to something else is left alone.
CURRENT_SHELL="$(getent passwd "$USER_NAME" | cut -d: -f7)"
if [ "$CURRENT_SHELL" = /bin/bash ]; then
  usermod -s /bin/zsh "$USER_NAME"
  echo "login shell for $USER_NAME: $CURRENT_SHELL -> /bin/zsh"
fi

# Passwordless sudo for the workspace user. This account used to be deliberately
# outside sudoers, and that cost real work: an agent asked to drive a headless
# browser could download the browser (Playwright fetches its own into ~/.cache)
# but not the shared libraries it links against, because those are RPMs — so the
# task simply failed, repeatedly, with no way for the agent to fix it. The same
# went for every other `dnf install`.
#
# It bought nothing in exchange. The boundary it looked like is not one: `coder`
# owns /opt/claude-web, so it already controls the code the chat service's unit
# executes, and everyone who reaches this box arrives as `coder` running `claude`
# under bypassPermissions. There is no second user to protect and no privilege
# here that was not already reachable — docs/SECURITY.md is explicit that anyone
# past the login has a shell, and this only stops pretending that shell is
# fenced. Restricting the grant to package managers was the other option and is
# worse: it is a denylist wearing an allowlist's clothes (`dnf`, `npm -g`, `pip`,
# `rpm`, `curl | bash`, `systemctl`…), and each miss looks to an agent exactly
# like the wall this removes.
#
# Validated before it is installed, because a sudoers file sudo cannot parse
# disables sudo entirely — including the path you would use to repair it. No dot
# in the filename: sudo ignores those.
SUDOERS_STAGE="$(mktemp)"
printf '# Written by bootstrap.sh; see AGENTS.md "The box you are on".\n%s ALL=(ALL) NOPASSWD:ALL\n' \
  "$USER_NAME" > "$SUDOERS_STAGE"
visudo -cf "$SUDOERS_STAGE"
install -o root -g root -m 0440 "$SUDOERS_STAGE" "/etc/sudoers.d/90-$USER_NAME"
rm -f "$SUDOERS_STAGE"

# And then ask sudo itself, rather than trusting that dropping a file in that
# directory was enough — /etc/sudoers has to `@includedir` it, and a deploy that
# reported success over a still-unprivileged account is the failure this whole
# block exists to end. Loud here beats an agent discovering it a week later.
sudo -l -U "$USER_NAME" | grep -q 'NOPASSWD: ALL'

# ---------------------------------------------------------------------------
# Persistent data volume
# ---------------------------------------------------------------------------
TOKEN="$(curl -fsS -X PUT http://169.254.169.254/latest/api/token \
  -H 'X-aws-ec2-metadata-token-ttl-seconds: 300')"
SELF_ID="$(curl -fsS -H "X-aws-ec2-metadata-token: $TOKEN" \
  http://169.254.169.254/latest/meta-data/instance-id)"

# Attach the workspace volume to ourselves. Done here rather than with a
# CfnVolumeAttachment because CloudFormation creates the new attachment before
# removing the old one during an instance replacement, which always fails.
ATTACHED_TO="$(aws ec2 describe-volumes --volume-ids "$DATA_VOLUME_ID" --region "$REGION" \
  --query 'Volumes[0].Attachments[0].InstanceId' --output text 2>/dev/null || echo None)"

if [ "$ATTACHED_TO" != "$SELF_ID" ]; then
  if [ "$ATTACHED_TO" != "None" ] && [ -n "$ATTACHED_TO" ]; then
    # A replaced-but-not-yet-reaped predecessor still holds it.
    aws ec2 detach-volume --volume-id "$DATA_VOLUME_ID" --region "$REGION" || true
    aws ec2 wait volume-available --volume-ids "$DATA_VOLUME_ID" --region "$REGION" || true
  fi
  for _ in $(seq 1 30); do
    if aws ec2 attach-volume --volume-id "$DATA_VOLUME_ID" --instance-id "$SELF_ID" \
         --device /dev/sdf --region "$REGION"; then
      break
    fi
    sleep 10
  done
  aws ec2 wait volume-in-use --volume-ids "$DATA_VOLUME_ID" --region "$REGION" || true
fi

# On Nitro instances the requested /dev/sdf shows up as an NVMe device whose
# serial is the volume ID (minus the dash), so match on that rather than guess
# a device name.
SERIAL="$(echo "$DATA_VOLUME_ID" | tr -d '-')"
DEV=""
for _ in $(seq 1 60); do
  for candidate in /dev/nvme*n1; do
    [ -b "$candidate" ] || continue
    if nvme id-ctrl -H "$candidate" 2>/dev/null | grep -qi "$SERIAL" ||
       udevadm info --query=property --name="$candidate" 2>/dev/null | grep -qi "$SERIAL"; then
      DEV="$candidate"; break
    fi
  done
  # Non-Nitro / older virtualization keeps the literal name.
  [ -z "$DEV" ] && [ -b /dev/sdf ] && DEV=/dev/sdf
  [ -n "$DEV" ] && break
  sleep 5
done

if [ -z "$DEV" ]; then
  echo "FATAL: workspace volume $DATA_VOLUME_ID never appeared" >&2
  lsblk >&2
  exit 1
fi

# Refuse to touch the disk that carries the running root filesystem.
ROOT_SRC="$(findmnt -no SOURCE / || true)"
ROOT_DISK="$(lsblk -no PKNAME "$ROOT_SRC" 2>/dev/null || true)"
if [ -n "$ROOT_DISK" ] && [ "$DEV" = "/dev/$ROOT_DISK" ]; then
  echo "FATAL: resolved $DEV is the root disk; refusing to format" >&2
  exit 1
fi

# Format only if the volume is blank — this is what preserves data across
# instance replacement.
if ! blkid "$DEV"; then
  mkfs.xfs "$DEV"
fi

mkdir -p "$DATA_MNT"
UUID="$(blkid -s UUID -o value "$DEV")"
grep -q "$UUID" /etc/fstab || echo "UUID=$UUID $DATA_MNT xfs defaults,nofail 0 2" >> /etc/fstab
mount -a

# Projects and Claude Code session history both live on the persistent volume.
mkdir -p "$DATA_MNT/projects" "$DATA_MNT/claude" "$DATA_MNT/code-server-data" \
         "$DATA_MNT/code-server-ext"
chown -R "$USER_NAME:$USER_NAME" "$DATA_MNT"

# Symlink ~/.claude to the volume so `--resume` finds sessions after a rebuild.
sudo -u "$USER_NAME" bash -euxo pipefail <<VOLLINK
cd /home/$USER_NAME
[ -L .claude ] || { rm -rf .claude; ln -s "$DATA_MNT/claude" .claude; }
VOLLINK

# ---------------------------------------------------------------------------
# Interactive shell (zsh)
# ---------------------------------------------------------------------------
# The environment this box needs in a shell — Bedrock region and model, the
# GitHub token resolver — is in /etc/profile.d, which is a bash convention. It
# keeps working under zsh only because AL2023's zsh package wires it up: its
# /etc/zshrc sources /etc/profile.d/*.sh under `emulate -L ksh` for non-login
# shells (what a code-server terminal is), and its /etc/zprofile sources
# /etc/profile for login shells. Verify that still holds before moving this box
# to a distro whose zsh does not, or `claude` in a terminal loses its model.
#
# Our own defaults go in a separate file that this script owns and rewrites, with
# ~/.zshrc only sourcing it. That way improvements land on an existing box on the
# next deploy, while anything the user adds to ~/.zshrc survives — the same
# reason the editor settings above are merged rather than overwritten. `emulate
# -L ksh` is why they cannot live in /etc/profile.d instead: it localises
# options, so a `setopt` there would be reverted as the file finished loading.
install -d -o "$USER_NAME" -g "$USER_NAME" "$DATA_MNT/shell"
# Two heredocs: this one expands $DATA_MNT, the one below must not expand
# anything (it is full of `$vcs_info_msg_0_` and prompt escapes). The usual
# placeholder + sed would have done it in one, but every placeholder in this file
# is diffed against stack.js (see AGENTS.md) and this value is not one of those:
# it is substituted here, so adding one would only break that check.
cat > /etc/claude-web-zshrc <<ZSHRCPATHS
# Managed by TripleC's bootstrap.sh — rewritten on every deploy.
# Put your own settings in ~/.zshrc, below the line that sources this file.

# History on the persistent volume: /home is on the root volume and does not
# survive an instance replacement.
HISTFILE=$DATA_MNT/shell/zsh_history
ZSHRCPATHS
cat >> /etc/claude-web-zshrc <<'ZSHRC'

# Completion. Nothing else calls compinit: the package puts it in the skeleton
# ~/.zshrc, which is only copied for a home directory created after zsh was
# installed, and this one is not. `-u` because a group-writable directory in
# $fpath otherwise turns every shell's first prompt into a security prompt.
autoload -Uz compinit && compinit -u
setopt COMPLETE_IN_WORD

# Shared between shells, because the usual reason to want history here is a
# command typed on a phone and repeated on a laptop. SHARE_HISTORY also appends
# each command as it is typed, which matters more here than it looks: a shell in
# a tab dies with the tab, and that is the normal way a shell ends on this
# surface — history written only at exit would be history mostly lost.
HISTSIZE=50000
SAVEHIST=50000
setopt SHARE_HISTORY EXTENDED_HISTORY HIST_IGNORE_DUPS
setopt HIST_IGNORE_SPACE HIST_REDUCE_BLANKS

# A short prompt: two lines, so a long path or a deep repo does not leave three
# columns to type in on a phone, and the command always starts at the margin.
setopt PROMPT_SUBST
autoload -Uz vcs_info
# Branch in one of the basic eight colours, not a 256-colour grey: %F{242} is
# only valid where terminfo reports 256 colours, and zsh emits a malformed escape
# rather than falling back where it does not — an ssm session is often plain
# `xterm`, even though the editor's terminal is `xterm-256color`.
zstyle ':vcs_info:git:*' formats ' %F{yellow}%b%f'
precmd() { vcs_info }
PROMPT='%F{cyan}%~%f${vcs_info_msg_0_}
%(?..%F{red}%? %f)%# '

# Arrow keys search the history for what has already been typed, which on a
# phone keyboard is the difference between recalling a command and retyping it.
autoload -Uz up-line-or-beginning-search down-line-or-beginning-search
zle -N up-line-or-beginning-search
zle -N down-line-or-beginning-search
bindkey '^[[A' up-line-or-beginning-search
bindkey '^[[B' down-line-or-beginning-search

setopt AUTO_CD INTERACTIVE_COMMENTS NO_BEEP
ZSHRC

# Append the source line only if it is missing, so this is idempotent and does
# not disturb whatever else the user has put in the file.
sudo -u "$USER_NAME" bash -euo pipefail <<ZSHLINK
cd /home/$USER_NAME
touch .zshrc
grep -q '^source /etc/claude-web-zshrc' .zshrc ||
  printf '%s\n' 'source /etc/claude-web-zshrc' >> .zshrc
ZSHLINK

# ---------------------------------------------------------------------------
# Secrets
# ---------------------------------------------------------------------------
# Disable tracing around the secret so it doesn't land in /var/log/bootstrap.log.
set +x
CS_PASSWORD="$(aws secretsmanager get-secret-value \
  --secret-id "$PASSWORD_SECRET_ARN" --region "$REGION" \
  --query SecretString --output text)"
SESSION_SECRET="$(aws secretsmanager get-secret-value \
  --secret-id "$SESSION_SECRET_ARN" --region "$REGION" \
  --query SecretString --output text)"

# The chat service reads its credentials from this file. It gates a process that
# runs shell commands, so an empty value here must stop the service rather than
# open it — server.js refuses to start without both, and this check makes the
# reason obvious in the bootstrap log instead of only in journalctl.
if [ -z "$CS_PASSWORD" ] || [ -z "$SESSION_SECRET" ]; then
  set -x
  echo "FATAL: login password or session secret is empty; refusing to configure the chat service." >&2
  exit 1
fi

install -d -m 0755 /etc
cat > /etc/claude-auth.env <<AUTHENV
AUTH_PASSWORD=$CS_PASSWORD
SESSION_SECRET=$SESSION_SECRET
CW_AUTH_MODE=$AUTH_MODE
CW_OIDC_EXPECTED_CLIENT_ID=$OIDC_CLIENT_ID
CW_OIDC_ALLOWED_EMAILS=$OIDC_ALLOWED_EMAILS
CW_OIDC_ALLOWED_DOMAIN=$OIDC_ALLOWED_DOMAIN
CW_REGION=$REGION
AUTHENV
# Readable only by the service account: anything else running on the box would
# otherwise be able to mint its own session cookie.
chmod 600 /etc/claude-auth.env
chown "$USER_NAME:$USER_NAME" /etc/claude-auth.env
set -x

# ---------------------------------------------------------------------------
# code-server
# ---------------------------------------------------------------------------
# Skip when already present: the installer's `rpm -U` exits non-zero if the same
# version is installed, which aborts an otherwise-idempotent re-provision.
if ! command -v code-server >/dev/null 2>&1; then
  curl -fsSL https://code-server.dev/install.sh | sh -s -- --version 4.131.0
else
  echo "code-server already installed: $(code-server --version | head -1)"
fi

# VS Code 1.131 bundles Copilot and shows its "Build with Agent" pane on
# startup, which competes with the Claude panel for the same space and wins the
# layout race. Remove both the pane's trigger and the extension so there is
# exactly one AI surface on screen.
VSCODE_DIR=/usr/lib/code-server/lib/vscode
if [ -f "$VSCODE_DIR/product.json" ]; then
  cp -n "$VSCODE_DIR/product.json" "$VSCODE_DIR/product.json.orig" || true
  python3 - "$VSCODE_DIR/product.json" <<'STRIPCHAT'
import json, sys
path = sys.argv[1]
data = json.load(open(path))
removed = [k for k in ('defaultChatAgent', 'chatWelcomeView', 'gitHubEntitlement')
           if data.pop(k, None) is not None]
json.dump(data, open(path, 'w'), indent=2)
print(f"product.json: removed {removed or 'nothing'}")
STRIPCHAT
fi
if [ -d "$VSCODE_DIR/extensions/copilot" ]; then
  mv "$VSCODE_DIR/extensions/copilot" "$VSCODE_DIR/extensions/.copilot-disabled"
fi

install -d -o "$USER_NAME" -g "$USER_NAME" "/home/$USER_NAME/.config/code-server"
set +x   # the heredoc below interpolates the password
cat > "/home/$USER_NAME/.config/code-server/config.yaml" <<CSCONF
bind-addr: 127.0.0.1:9999
auth: password
password: $CS_PASSWORD
cert: false
disable-telemetry: true
disable-update-check: true
user-data-dir: $DATA_MNT/code-server-data
extensions-dir: $DATA_MNT/code-server-ext
CSCONF
chmod 600 "/home/$USER_NAME/.config/code-server/config.yaml"
chown "$USER_NAME:$USER_NAME" "/home/$USER_NAME/.config/code-server/config.yaml"
set -x

# ---------------------------------------------------------------------------
# GitHub auth
# ---------------------------------------------------------------------------
# A git credential helper that reads the PAT from Secrets Manager on demand.
# Preferred over ~/.git-credentials or a token baked into the remote URL: the
# secret is never written to disk, rotating it needs no redeploy, and anything
# running in the workspace can't read it out of a file.
cat > /usr/local/bin/git-credential-secretsmanager <<'HELPER'
#!/bin/bash
# git calls this with an operation argument; only `get` needs to do anything.
[ "$1" = "get" ] || exit 0
TOKEN="$(aws secretsmanager get-secret-value \
  --secret-id "$GITHUB_SECRET_ARN" --region "$AWS_REGION" \
  --query SecretString --output text 2>/dev/null \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))' 2>/dev/null)"
[ -n "$TOKEN" ] || exit 0
echo "username=x-access-token"
echo "password=$TOKEN"
HELPER
chmod 755 /usr/local/bin/git-credential-secretsmanager

# The helper runs as a subprocess of git, so it needs these in its environment.
cat > /etc/profile.d/00-github-env.sh <<GHENV
export GITHUB_SECRET_ARN="$GITHUB_SECRET_ARN"
export AWS_REGION="$REGION"
GHENV

sudo -u "$USER_NAME" git config --global credential.helper secretsmanager
sudo -u "$USER_NAME" git config --global credential.https://github.com.username x-access-token
# Long-lived clones and Claude's own git calls both benefit from these.
sudo -u "$USER_NAME" git config --global user.name "$GIT_USER_NAME"
sudo -u "$USER_NAME" git config --global user.email "$GIT_USER_EMAIL"
sudo -u "$USER_NAME" git config --global init.defaultBranch main
sudo -u "$USER_NAME" git config --global push.autoSetupRemote true

# gh CLI, so Claude can open PRs and read issues as it does locally.
if ! command -v gh >/dev/null 2>&1; then
  GH_VER=2.65.0
  curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VER}/gh_${GH_VER}_linux_arm64.tar.gz" \
    -o /tmp/gh.tar.gz &&
    tar -xzf /tmp/gh.tar.gz -C /tmp &&
    install -m 0755 "/tmp/gh_${GH_VER}_linux_arm64/bin/gh" /usr/local/bin/gh &&
    rm -rf /tmp/gh.tar.gz "/tmp/gh_${GH_VER}_linux_arm64" ||
    echo "gh install failed; git still works via the credential helper"
fi

# gh reads GH_TOKEN from the environment; resolve it from the secret at login.
cat > /etc/profile.d/01-gh-token.sh <<'GHTOKEN'
_gh_token() {
  aws secretsmanager get-secret-value \
    --secret-id "$GITHUB_SECRET_ARN" --region "$AWS_REGION" \
    --query SecretString --output text 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))' 2>/dev/null
}
if [ -n "${GITHUB_SECRET_ARN:-}" ] && [ -z "${GH_TOKEN:-}" ]; then
  GH_TOKEN="$(_gh_token)"
  [ -n "$GH_TOKEN" ] && export GH_TOKEN GITHUB_TOKEN="$GH_TOKEN"
fi
GHTOKEN

# ---------------------------------------------------------------------------
# Bedrock env for Claude Code (CLI + extension inherit this)
# ---------------------------------------------------------------------------
# Quoted heredoc: the placeholders are substituted by the sed below, not by this
# shell, so that a literal `$` never reaches the generated profile script.
cat > /etc/profile.d/claude-bedrock.sh <<'BEDROCKENV'
export CLAUDE_CODE_USE_BEDROCK=1
export AWS_REGION=__REGION__
export ANTHROPIC_MODEL=__DEFAULT_MODEL__
BEDROCKENV
sed -i -e "s|__REGION__|$REGION|" -e "s|__DEFAULT_MODEL__|$DEFAULT_MODEL|" \
  /etc/profile.d/claude-bedrock.sh

# ---------------------------------------------------------------------------
# Claude Code CLI + the official VS Code extension
# ---------------------------------------------------------------------------
npm install -g @anthropic-ai/claude-code

# The official extension is published on Open VSX, which is the marketplace
# code-server uses. Install the arm64 build to match this Graviton instance.
EXT_VSIX="/tmp/claude-code.vsix"
EXT_URL="$(curl -fsSL https://open-vsx.org/api/anthropic/claude-code/linux-arm64/latest |
  jq -r '.files.download')"
curl -fsSL "$EXT_URL" -o "$EXT_VSIX"
sudo -u "$USER_NAME" HOME="/home/$USER_NAME" \
  /usr/bin/code-server \
    --user-data-dir "$DATA_MNT/code-server-data" \
    --extensions-dir "$DATA_MNT/code-server-ext" \
    --install-extension "$EXT_VSIX"

# Voice dictation companion extension (built and shipped by deploy.sh).
#
# The uninstall first is the rename to TripleC catching up with an extensions
# directory on the persistent volume. An extension's identity is publisher.name,
# both extensions changed publisher, and the volume outlives the instance — so
# without this a replaced box restores the pre-rename copies and then installs the
# new ones beside them. Nothing fails; the voice command simply registers twice.
if [ -f /opt/claude-web/claude-voice.vsix ]; then
  for old_id in claude-web.claude-voice claude-web.claude-mobile-shell; do
    sudo -u "$USER_NAME" HOME="/home/$USER_NAME" \
      /usr/bin/code-server \
        --user-data-dir "$DATA_MNT/code-server-data" \
        --extensions-dir "$DATA_MNT/code-server-ext" \
        --uninstall-extension "$old_id" || true
  done
  sudo -u "$USER_NAME" HOME="/home/$USER_NAME" \
    /usr/bin/code-server \
      --user-data-dir "$DATA_MNT/code-server-data" \
      --extensions-dir "$DATA_MNT/code-server-ext" \
      --install-extension /opt/claude-web/claude-voice.vsix
fi

# ---------------------------------------------------------------------------
# Local speech-to-text (whisper.cpp)
# ---------------------------------------------------------------------------
# Runs on-box: no API quota to request, no key, no per-request cost, and audio
# never leaves the instance. Measured here (2 vCPU arm64, base.en): ~4s for 11s
# of audio. Built from source because there is no arm64 package.
if [ ! -x /opt/whisper/whisper-cli ]; then
  (
    set -euxo pipefail
    rm -rf /opt/whisper-src && mkdir -p /opt/whisper-src
    git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git /opt/whisper-src
    cd /opt/whisper-src
    cmake -B build -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF
    cmake --build build -j"$(nproc)" --target whisper-cli

    install -d /opt/whisper/models
    install -m 0755 build/bin/whisper-cli /opt/whisper/whisper-cli
    # The CLI links against the shared ggml libraries it just built.
    find build -name 'libggml*.so*' -o -name 'libwhisper*.so*' \
      | xargs -I{} cp -P {} /opt/whisper/
    sh ./models/download-ggml-model.sh base.en
    mv models/ggml-base.en.bin /opt/whisper/models/
    cd / && rm -rf /opt/whisper-src
  ) || echo "whisper build failed; voice will need Azure credentials"
fi

# whisper-cli finds its co-located shared libraries without LD_LIBRARY_PATH.
if [ -x /opt/whisper/whisper-cli ]; then
  echo '/opt/whisper' > /etc/ld.so.conf.d/whisper.conf
  ldconfig
fi

# Voice configuration, read at service start. Local whisper is used by default;
# Azure is used instead if the secret holds credentials.
cat > /etc/claude-voice.env <<VOICEENV
WHISPER_SECRET_ARN=$WHISPER_SECRET_ARN
AWS_REGION=$REGION
WHISPER_BIN=/opt/whisper/whisper-cli
WHISPER_MODEL=/opt/whisper/models/ggml-base.en.bin
VOICEENV

# ---------------------------------------------------------------------------
# Editor defaults + trust the projects dir (no "do you trust?" prompt on phone)
# ---------------------------------------------------------------------------
install -d -o "$USER_NAME" -g "$USER_NAME" "$DATA_MNT/code-server-data/User"
# Written here as well as by the mobile-shell extension, so the very first load
# is already configured — the extension only activates after the workbench is up.
# Merged into any existing file rather than overwritten, so preferences changed
# in the editor survive a reboot or an instance replacement.
cat > /tmp/mobile-defaults.json <<'SETTINGS'
{
  "security.workspace.trust.enabled": false,
  "workbench.startupEditor": "none",
  "workbench.colorTheme": "Default Dark Modern",
  "workbench.activityBar.location": "hidden",
  "workbench.statusBar.visible": false,
  "workbench.editor.showTabs": "none",
  "workbench.editor.editorActionsLocation": "hidden",
  "workbench.layoutControl.enabled": false,
  "workbench.tips.enabled": false,
  "breadcrumbs.enabled": false,
  "window.menuBarVisibility": "hidden",
  "terminal.integrated.fontSize": 13,
  "terminal.integrated.defaultProfile.linux": "zsh",
  "editor.fontSize": 15,
  "editor.lineHeight": 1.6,
  "editor.minimap.enabled": false,
  "editor.lineNumbers": "off",
  "editor.glyphMargin": false,
  "editor.folding": false,
  "chat.disableAIFeatures": true,
  "workbench.secondarySideBar.defaultVisibility": "hidden",
  "claudeCode.allowDangerouslySkipPermissions": true,
  "claudeCode.initialPermissionMode": "bypassPermissions",
  "claudeCode.hideOnboarding": true,
  "claudeCode.disableLoginPrompt": true,
  "claudeCode.autosave": true
}
SETTINGS

SETTINGS_FILE="$DATA_MNT/code-server-data/User/settings.json"

# What the editor window calls itself, which is a setting rather than something the
# overlay can do: code-server writes document.title from `window.title` and rewrites
# it on every editor change, so anything set from JavaScript is overwritten within
# seconds. ${rootName} is the open folder — the project — and ${activeEditorShort}
# the file, so a tab reads "name: project - file.js". Those are code-server's own
# variables, hence the single quotes: this shell must not expand them.
WINDOW_TITLE=""
if [ -n "$PWA_NAME" ]; then
  WINDOW_TITLE="$PWA_NAME"': ${rootName}${separator}${activeEditorShort}'
fi

python3 - "$SETTINGS_FILE" /tmp/mobile-defaults.json "$WINDOW_TITLE" <<'MERGE'
import json, sys, os
target, defaults_path, window_title = sys.argv[1], sys.argv[2], sys.argv[3]
defaults = json.load(open(defaults_path))
current = {}
if os.path.exists(target):
    try:
        current = json.load(open(target))
    except (ValueError, OSError):
        current = {}  # corrupt file: fall back to defaults rather than fail
# Existing values win, so anything changed in the editor is preserved.
merged = {**defaults, **current}
# The window title is the exception: assigned when the deployment has a name and
# removed when it does not, rather than merely defaulted. This file lives on the
# persistent data volume and outlives every deploy, so a value the config no longer
# asks for would otherwise be permanent — the same reason the CLI settings below are
# assigned rather than setdefault'd.
if window_title:
    merged['window.title'] = window_title
else:
    merged.pop('window.title', None)
with open(target, 'w') as fh:
    json.dump(merged, fh, indent=2)
print(f"settings merged: {len(defaults)} defaults, {len(current)} existing")
MERGE
rm -f /tmp/mobile-defaults.json
chown -R "$USER_NAME:$USER_NAME" "$DATA_MNT/code-server-data/User"

# The CLI reads its own settings file (separate from VS Code settings). Set the
# same default there so terminal sessions and the chat service don't prompt
# either. Merged, so existing permission rules are kept.
python3 - "$DATA_MNT/claude/settings.json" "$PERMISSION_MODE" "$EFFORT_LEVEL" <<'CLAUDESETTINGS'
import json, os, sys
target, permission_mode, effort = sys.argv[1], sys.argv[2], sys.argv[3]
current = {}
if os.path.exists(target):
    try:
        current = json.load(open(target))
    except (ValueError, OSError):
        current = {}
perms = current.get('permissions') or {}
perms['defaultMode'] = permission_mode
current['permissions'] = perms
# Assigned, not setdefault: this file lives on the persistent data volume, so it
# survives every deploy. setdefault meant the value written by the *first* deploy
# won, and effortLevel in triplec.config.json was silently ignored from then
# on — a box ran xhigh for three deploys that each reported shipping max. The
# config is the authoritative answer, the same way defaultMode above is, so a
# hand-edit here is reset by the next deploy rather than outliving it.
current['effortLevel'] = effort
os.makedirs(os.path.dirname(target), exist_ok=True)
with open(target, 'w') as fh:
    json.dump(current, fh, indent=2)
print(f'claude settings: defaultMode={permission_mode} effortLevel={effort}')
CLAUDESETTINGS
chown -R "$USER_NAME:$USER_NAME" "$DATA_MNT/claude"

# ---------------------------------------------------------------------------
# nginx: chat at /chat/, VS Code at /editor/
# ---------------------------------------------------------------------------
# Routing, and why it is shaped this way:
#
#   = /          a redirect to /chat/, so the bare domain still opens the chat
#   /chat/       the chat app: its shell and its own static assets, prefix
#                stripped by proxy_pass
#   /login /api/ /ws   the chat service's endpoints
#   /editor/     code-server's entry point, prefix stripped
#   /p/<name>/   code-server again, on a path that belongs to one project
#   /            catch-all to code-server, which serves its own absolute asset
#                URLs (/static/..., /stable-.../...) from here
#
# The chat's assets are namespaced under /chat/ rather than code-server being
# moved to a sub-path, because code-server has no supported nginx sub-path
# configuration — it emits absolute asset URLs and expects to own the root.
# Keeping the catch-all pointed at it means it still does, while the chat's
# assets live somewhere the catch-all can never swallow. An earlier version
# served the chat's index at /chat while its <script src="/app.js"> resolved to
# the catch-all, so the chat shell loaded and its code did not.
#
# SECURITY: no location here decides anything itself. The chat service
# authenticates every request it serves (chat-service/auth.js), code-server checks
# its own password, and in oidc mode the code-server routes additionally ask
# auth.js who the caller is through auth_request — a delegation, not a decision.
# Authentication belongs in the process whose data is at stake. An earlier config
# claimed an `auth_request` gate here without writing one and left the chat API
# open to the internet, so this one is written and asserted in manifest-test.js.
#
# Why the workbench needs that gate in oidc mode, specifically: code-server's
# password proves someone knows a shared secret, which says nothing about *which*
# identity is holding it. The load balancer in front admits any account the
# provider will authenticate — with Google, every account that exists — so "any
# Google account plus the code-server password" reached a full IDE with a
# terminal, as an identity that was never on oidc.allowedEmails. Found 2026-09-19
# by signing in with an unlisted address and landing in the editor. The chat was
# never exposed: every chat request goes through auth.js, which checks the
# allowlist. The editor simply never went through auth.js at all.
mkdir -p /opt/claude-web

# Recover the real client address. The ALB appends the caller's IP to
# X-Forwarded-For, so without this every request appears to come from the load
# balancer and the login throttle in auth.js would lump all callers together.
cat > /etc/nginx/conf.d/00-realip.conf <<REALIP
set_real_ip_from $VPC_CIDR;
real_ip_header X-Forwarded-For;
real_ip_recursive on;

# Slow down password guessing at the edge, before it reaches Node. auth.js also
# locks out per IP; this is the cheap first layer, and it stays scoped to the login
# endpoint so a burst of chat traffic is never throttled.
#
# The key is the *path*, not the location, and that is the whole point. This limit
# used to hang off \`location = /api/login\`, which left /chat/api/login unthrottled:
# the /chat/ prefix strips to the same handler through a location that had no
# limit, so 20 rapid guesses all reached Node while /api/login stopped at 6.
# Measured, not theorised. Keying on the path means the limit follows the endpoint
# into any location that serves it, including one added later.
#
# nginx does not count a request whose key is empty, so this throttles exactly the
# paths named here and nothing else. \$uri rather than \$request_uri because \$uri is
# decoded and normalised: /chat/api/%6Cogin, /chat//api/login and
# /chat/../api/login all arrive here as a name written below instead of slipping
# past it as an unrecognised string.
# The zone is named for its key, and renaming it is mandatory whenever that key
# changes. nginx keeps a shared memory zone across a reload and refuses one whose
# key has changed underneath it:
#
#   [emerg] limit_req "login" uses the "\$login_attempt" key while previously it
#           used the "\$binary_remote_addr" key
#
# That refusal aborts the whole reconfigure, so the master keeps serving the *old*
# config — and neither \`nginx -t\` nor \`systemctl reload\` reports it, because -t
# tests a fresh load with no existing zone and reload only sends a signal. A deploy
# that changed this key while keeping the name looked entirely successful and
# changed nothing; deploy.sh now reads the error log after reloading for exactly
# this. A new name is a new zone, so there is nothing to conflict with.
map \$uri \$login_attempt {
    default          "";
    /api/login       \$binary_remote_addr;
    /chat/api/login  \$binary_remote_addr;
}
limit_req_zone \$login_attempt zone=login_by_path:10m rate=12r/m;
limit_req_status 429;

# What gets injected into the <head> of code-server's HTML: the mobile viewport
# and the overlay that adds the mic and the project switcher.
#
# It lives in a map because it must not go into every HTML response. code-server
# serves VS Code webviews from this same origin under .../webview/browser/pre/,
# and the Claude Code panel is one of those webviews — injecting there mounted a
# second mic and a second project switcher inside the panel's iframe, a few
# pixels off the workbench's own pair. nginx has no way to switch sub_filter off
# per request, but a sub_filter replacement string may contain variables, so the
# decision moves here. The overlay also refuses to run outside the top frame;
# this keeps the bytes from being shipped at all.
map \$request_uri \$cmo_head {
    default '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,maximum-scale=1,user-scalable=no"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><script src="/mobile-overlay.js" defer></script>';
    "~*/webview/browser/pre/" '';
}
REALIP

# Whether the code-server routes carry the identity gate. Empty in password mode,
# where a single secret already gates both surfaces and adding a second door would
# only lock out someone who uses the editor and never opens the chat.
IDENTITY_GATE=""
if [ "$AUTH_MODE" = "oidc" ]; then
  IDENTITY_GATE="auth_request /__identity;"
fi

cat > /etc/nginx/conf.d/claude-web.conf <<NGINXCONF
server {
    listen $APP_PORT default_server;
    server_name _;
    client_max_body_size 100M;

    # Applied here, at the server, rather than on the login location: every location
    # inherits it, so no route can serve a login attempt without it. Which requests
    # this actually counts is decided by \$login_attempt in 00-realip.conf, and it is
    # empty for everything that is not a login — so this line throttles guessing and
    # nothing else, including the 100M uploads and the long-lived streams below.
    limit_req zone=login_by_path burst=5 nodelay;

    # Compression, and it belongs to the editor routes even though it is set here.
    #
    # Those routes strip the browser's Accept-Encoding, because sub_filter cannot
    # rewrite bytes it cannot read — and that one header was throwing away
    # compression code-server had already done. Left alone it answers /static/…
    # and /vscode-remote-resource with \`Content-Encoding: br\` and a year of
    # max-age; stripped, it answers with the raw file. Measured on the box:
    # workbench.web.main.internal.js 17.2M -> 4.3M, the Claude panel's own webview
    # bundle 5.2M -> 1.4M, the workbench CSS 1.25M -> 160K. About 24M of
    # JavaScript per cold editor load, uncompressed, which is what a phone on a
    # mobile link feels as the panel taking forever to appear.
    #
    # nginx's gzip filter runs *after* sub_filter, so the injection still happens
    # and the browser still gets compressed bytes: the strip stays where it is and
    # the compression moves one hop later. gzip rather than brotli because AL2023
    # ships no nginx brotli module (checked: the repos have brotli itself and
    # nginx-mod-{headers-more,njs,stream,…}, not that one) — a few hundred
    # kilobytes worse than code-server's br, against the ~18M this puts back.
    #
    # \`gzip_proxied any\` is load-bearing: every route below is a proxy_pass, and
    # without it nginx compresses none of them. Cost is ~0.5s of one CPU per 17M
    # asset, and only on a cold load — these carry max-age=31536000, so a warm
    # browser re-downloads nothing. text/event-stream is absent from the list on
    # purpose, and so is anything already compressed (woff2, png, the vsix).
    gzip on;
    gzip_proxied any;
    gzip_vary on;
    gzip_comp_level 5;
    gzip_min_length 1024;
    gzip_types text/css text/javascript application/javascript application/json
               application/manifest+json image/svg+xml application/wasm;

    # ALB health check — must not require a password.
    location = /healthz {
        access_log off;
        return 200 'ok';
        add_header Content-Type text/plain;
    }

    # Mobile CSS injected into the editor shell below.
    location = /mobile-overlay.js { root /opt/claude-web/pwa; add_header Cache-Control "no-cache"; }

    # The auth_request target for the code-server routes further down. \`internal\`
    # means nginx will only reach it from a subrequest, never from a client.
    #
    # It forwards the caller's own headers — including the load balancer's signed
    # x-amzn-oidc-data — to /api/auth-check, which answers 204 when auth.js says
    # the identity is allowed and 401 when it is not. That is exactly the contract
    # auth_request wants, and it means the allowlist is read from one place for
    # both surfaces instead of being duplicated here.
    #
    # The body is dropped: this asks a question about the caller, and streaming a
    # 100M upload to the gate as well as the upstream would double every write.
    location = /__identity {
        internal;
        proxy_pass http://127.0.0.1:9997/api/auth-check;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }

    # --- Chat (primary interface) -------------------------------------------
    # The bare domain sends you to the chat, which lives at /chat/ and not here.
    #
    # It used to be served here, and moving it is what lets a project be
    # installed at all. A manifest's scope is a path prefix, an installed web app
    # on Android claims every URL under its scope, and the chat app's scope was
    # '/' — the whole origin, every /p/<name>/ included — so with the chat icon on
    # the home screen Chrome answered every project install with "already
    # installed". Narrowing the chat app to /chat/ is what leaves those paths
    # unclaimed. See pwa/manifest.webmanifest and chat-service/manifest.js.
    #
    # The redirect is not a courtesy: an install can only be offered from a page
    # inside the scope of the manifest it links, so a bare domain that served the
    # shell in place would be a chat app nobody could install. Path-only, for the
    # same reason the project route is — nginx behind the load balancer would
    # otherwise name the port it listens on.
    location = / {
        absolute_redirect off;
        port_in_redirect off;
        return 302 /chat/;
    }

    # The chat app, and its own static assets. The trailing slash on proxy_pass
    # strips /chat/, so the chat service sees / and /app.js while the browser asks
    # for /chat/ and /chat/app.js.
    location /chat/ {
        proxy_pass http://127.0.0.1:9997/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_buffering off;
    }

    # The chat app's "Editor" shortcut, which has to live inside the app's scope.
    # A browser drops a manifest shortcut whose URL is outside it — silently, so
    # pointing that shortcut straight at /editor/ would simply lose it. Nothing new
    # reaches code-server here: this answers with a redirect and the browser
    # follows it to the one route that has always served the workbench. An exact
    # match, so it takes precedence over the /chat/ prefix above without depending
    # on the order they are written in.
    location = /chat/editor/ {
        absolute_redirect off;
        port_in_redirect off;
        return 302 /editor/;
    }

    location /login {
        proxy_pass http://127.0.0.1:9997;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }

    # The one unauthenticated endpoint that checks a secret, so the only one worth
    # guessing against. The throttle for it is inherited from the server block above
    # and keyed on the path, which is what also covers the /chat/api/login spelling
    # of this same handler.
    location = /api/login {
        proxy_pass http://127.0.0.1:9997;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:9997;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 3600s;
        proxy_request_buffering off;
        proxy_buffering off;
    }
    location /ws {
        proxy_pass http://127.0.0.1:9997;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_read_timeout 3600s;
        proxy_buffering off;
    }

    # --- VS Code with the real Claude extension -----------------------------
    # Entry point only. code-server thinks it lives at the root, so its own
    # Location headers point there; proxy_redirect keeps the browser inside
    # /editor/ instead of bouncing it back to the chat at /.
    location /editor/ {
        $IDENTITY_GATE
        proxy_pass http://127.0.0.1:9999/;
        proxy_redirect / /editor/;
        proxy_set_header Accept-Encoding "";
        sub_filter '</head>' '\${cmo_head}</head>';
        # And code-server's own manifest link is defused, because this address is not
        # an app. Its identity here is /editor/ — the same for every project, since the
        # query is not part of a scope — so the first project installed from this page
        # takes it and every project after that is refused as "already installed". That
        # is the report this exists for. A project installs from its own window,
        # /p/<name>/, which is the route below; \`rel\` is what changes because an
        # unknown relation is ignored by every browser and still greppable in a view-
        # source when someone is working out where a manifest went.
        sub_filter 'rel="manifest" href="./manifest.json"' 'rel="cw-no-manifest" href="./manifest.json"';
        sub_filter_once on;
        sub_filter_types text/html;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Host \$host;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }

    # --- One installable app per project ------------------------------------
    # /p/<name>/ is the editor again, reached by a path that belongs to exactly
    # one project. It exists because a web app manifest's scope is a path prefix
    # compared *without* the query string: while every project's start_url was
    # /editor/?folder=<path>, every project described an app with the same scope,
    # so Android had one installed web app claiming the origin and refused the
    # second project as "already installed".
    #
    # The query is forwarded rather than rebuilt from \$cwproj, so this route needs
    # no opinion about where projects live — chat-service/manifest.js is the only
    # place that knows, and it generates both halves of this URL together. The
    # browser keeps the query because the overlay reads ?folder= to know which
    # project it is in.
    #
    # The prefix is stripped and everything below it forwarded, which is not
    # decoration: code-server answers an unauthenticated request with a *relative*
    # redirect (Location: ./login?...), so the browser resolves it against this path
    # and asks for /p/<name>/login. An exact-match route would 404 there, which is
    # what the first launch of a project icon looks like once its password cookie has
    # expired. The rewrite is what /editor/ gets from \`proxy_pass .../\`; a regex
    # location cannot use that form, so it is spelled out instead. The query survives
    # the rewrite untouched.
    #
    # Nothing is gated here that is not gated at /editor/: this proxies to the same
    # code-server, which does its own password check. A path that reached the
    # workbench without one would be remote code execution.
    location ~ ^/p/(?<cwproj>[A-Za-z0-9][A-Za-z0-9._-]*)(?:/|\$) {
        # The slash is not optional, because those redirects are relative: without it
        # /p/<name> resolves ./login to /p/login, which is this same route with the
        # project called "login", which redirects to ./login again — a loop the browser
        # gives up on. 302 rather than 301: nothing links this form, so there is no
        # reason to leave it in anyone's cache.
        #
        # Path-only, because nginx does not know its own address. It listens on
        # __APP_PORT__ behind the load balancer that terminates TLS, so left to build
        # an absolute Location it names the port it can see and the scheme it is spoken
        # to in: http://<your-host>:8080/p/<name>/, which is unreachable from a
        # phone. Verified in production, where that is exactly what it sent.
        $IDENTITY_GATE
        absolute_redirect off;
        port_in_redirect off;
        rewrite ^/p/([A-Za-z0-9][A-Za-z0-9._-]*)\$ /p/\$1/ redirect;
        rewrite ^/p/[A-Za-z0-9][A-Za-z0-9._-]*/?(.*)\$ /\$1 break;
        proxy_pass http://127.0.0.1:9999;
        proxy_redirect / /p/\$cwproj/;
        proxy_set_header Accept-Encoding "";
        sub_filter '</head>' '\${cmo_head}</head>';
        # And the manifest this page links becomes this project's, here, rather than
        # in JavaScript after the fact.
        #
        # code-server links one of its own: <link rel="manifest" href="./manifest.json">.
        # That file names no \`id\` and no \`scope\`, so a browser defaults both to the
        # directory the link resolves in — which under this route is /p/<name>/, the
        # exact identity chat-service/manifest.js mints for this project, wearing the
        # name "code-server". Install it once and the project's own manifest is
        # "already installed" from then on, permanently, because the icon on the home
        # screen holds the identity the install asks for. The overlay does replace the
        # link, but that is a script racing a browser's install check, and it cannot
        # run at all before it loads.
        sub_filter 'rel="manifest" href="./manifest.json"' 'rel="manifest" href="/chat/manifest.webmanifest?project=\$cwproj"';
        sub_filter_once on;
        sub_filter_types text/html;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Host \$host;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }

    # Catch-all: code-server's absolute asset and WebSocket URLs. Gated too — this
    # is the door every unmatched path goes through, so leaving it open would make
    # the two gates above decoration.
    location / {
        $IDENTITY_GATE
        proxy_pass http://127.0.0.1:9999/;
        # Inject mobile layout CSS and viewport meta into the workbench shell.
        # Only viewport/PWA meta plus the overlay script. Deliberately NO
        # stylesheet: CSS that touches \`.part.*\` desynchronises the workbench's
        # JS-computed absolute layout and renders as a blank gray screen.
        sub_filter '</head>' '\${cmo_head}</head>';
        # Defused here too, for the same reason as at /editor/: no path that falls
        # through to here belongs to one project, so any app installed from one claims
        # a scope that is not a project's and collides with the ones that are.
        sub_filter 'rel="manifest" href="./manifest.json"' 'rel="cw-no-manifest" href="./manifest.json"';
        sub_filter_once on;
        sub_filter_types text/html;
        # sub_filter cannot rewrite compressed bytes.
        proxy_set_header Accept-Encoding "";
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Host \$host;

        # code-server is WebSocket-driven; these are load-bearing.
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }
}
NGINXCONF

# Drop the default server block so ours owns the port.
sed -i '/^\s*listen\s*80;/,$ s/^/#/' /etc/nginx/nginx.conf 2>/dev/null || true
cat > /etc/nginx/nginx.conf <<'MAINCONF'
user nginx;
worker_processes auto;
error_log /var/log/nginx/error.log notice;
pid /run/nginx.pid;
events { worker_connections 1024; }
http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;
    sendfile on;
    keepalive_timeout 65;
    map $http_upgrade $connection_upgrade { default upgrade; '' close; }
    include /etc/nginx/conf.d/*.conf;
}
MAINCONF

# ---------------------------------------------------------------------------
# Services
# ---------------------------------------------------------------------------
cat > /etc/systemd/system/code-server.service <<SVC
[Unit]
Description=code-server with Claude Code
After=network.target $DATA_MNT.mount claude-tmux.service
Requires=$DATA_MNT.mount
# Not Requires: the editor is still useful if the session server is down, but it
# must come up second, or the first `cc` from an editor terminal starts a tmux
# server of its own inside this unit's cgroup and loses its durability.
Wants=claude-tmux.service

[Service]
Type=simple
User=$USER_NAME
Environment=HOME=/home/$USER_NAME
EnvironmentFile=/etc/claude-voice.env
Environment=CLAUDE_CODE_USE_BEDROCK=1
Environment=AWS_REGION=$REGION
Environment=ANTHROPIC_MODEL=$DEFAULT_MODEL
Environment=GITHUB_SECRET_ARN=$GITHUB_SECRET_ARN
WorkingDirectory=$DATA_MNT/projects
ExecStart=/usr/bin/code-server
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SVC

cat > /etc/systemd/system/claude-chat.service <<SVC
[Unit]
Description=Claude chat (mobile UI + transcription)
After=network.target $DATA_MNT.mount
Requires=$DATA_MNT.mount

[Service]
Type=simple
User=$USER_NAME
EnvironmentFile=/etc/claude-voice.env
# Login password + cookie signing key. server.js aborts if either is missing, so
# a failure to read this file stops the service rather than opening it.
EnvironmentFile=/etc/claude-auth.env
Environment=HOME=/home/$USER_NAME
Environment=CODER_HOME=/home/$USER_NAME
Environment=PORT=9997
Environment=PROJECTS_ROOT=$DATA_MNT/projects
Environment=CLAUDE_HOME=$DATA_MNT/claude
# What the app calls itself. The chat service puts it in front of every title it
# serves — the manifests, so a home screen icon says which deployment it opens, and
# the HTML shells, so a browser tab does too. Quoted because a name may contain a
# space, and empty is the single-deployment default rather than a missing value.
Environment="PWA_NAME=$PWA_NAME"
Environment=CLAUDE_CODE_USE_BEDROCK=1
Environment=AWS_REGION=$REGION
Environment=ANTHROPIC_MODEL=$DEFAULT_MODEL
Environment=GITHUB_SECRET_ARN=$GITHUB_SECRET_ARN
WorkingDirectory=/opt/claude-web/chat-service
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SVC

# The tmux server that holds the Claude sessions, owned by its own unit.
#
# It has to be its own unit. tmux sessions are forked by the tmux *server*, so
# they inherit the server's cgroup — and a server started by the first `cc` is
# started from an editor terminal, which puts it inside code-server.service.
# That unit is KillMode=control-group (systemd's default), so `systemctl restart
# code-server` kills the whole tree and takes the Claude sessions with it. Every
# deploy restarts code-server. Observed 2026-09-17: a task running in tmux died
# mid-deploy, which is the exact failure tmux was introduced to prevent.
#
# `exit-empty off` is load-bearing: without it the server exits when its last
# session is killed, and the next `cc` would quietly start a replacement inside
# code-server's cgroup again — durability lost with nothing to see. `cc` warns
# if it ever finds itself talking to a server outside this unit.
#
# The socket is the default one (/tmp/tmux-<uid>/default) so that plain `tmux`
# in an SSM shell is the same server. That means no PrivateTmp here, ever.
cat > /etc/systemd/system/claude-tmux.service <<SVC
[Unit]
Description=Long-lived tmux server for Claude sessions
After=network.target $DATA_MNT.mount
Requires=$DATA_MNT.mount

[Service]
Type=forking
User=$USER_NAME
Environment=HOME=/home/$USER_NAME
WorkingDirectory=$DATA_MNT/projects
ExecStart=/bin/sh -c 'tmux start-server \; set-option -s exit-empty off'
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
SVC

systemctl daemon-reload
# `enable --now`, never `restart`: this script re-runs on every deploy, and
# restarting this unit is precisely the thing that would kill live sessions.
systemctl enable --now claude-tmux
systemctl enable --now code-server
if [ -f /opt/claude-web/chat-service/server.js ]; then
  (cd /opt/claude-web/chat-service && npm install --omit=dev)
  chown -R "$USER_NAME:$USER_NAME" /opt/claude-web/chat-service
  systemctl enable --now claude-chat
fi
systemctl enable --now nginx
nginx -t && systemctl reload nginx

echo "bootstrap complete for https://$DOMAIN_NAME"
