#!/bin/bash
#
# Install the payload that has just been unpacked into /opt/claude-web, as root,
# on an AWS deployment's instance.
#
# Two callers, one script, so the two cannot drift:
#   - deploy.sh, over SSM, after copying the tarball from S3 and unpacking it here;
#   - scripts/triplec-update.mjs, the on-box updater, after building the payload
#     from a fetched commit and unpacking it here.
#
# These lines used to be a Python list inside deploy.sh's SSM command. They are
# the same commands in the same order; only the quoting is gone, since nothing here
# sits inside a command substitution any more.
#
# Exit non-zero on anything a caller should not report as installed. It is written
# to be re-run: a second run over the same payload changes nothing that matters.
set -euxo pipefail

[ "$(id -u)" -eq 0 ] || { echo "install-payload.sh must run as root" >&2; exit 1; }

# One install at a time. A deploy and the updater are both allowed to install, and
# two of them interleaving would each restart services mid-way through the other's
# bootstrap run. -w: a long install ahead of this one is waited for, not failed.
exec 9>/run/triplec-install.lock
flock -w 900 9 || { echo "another install has held /run/triplec-install.lock for 15 minutes" >&2; exit 1; }

cd /opt/claude-web

# Delete AppleDouble stubs FIRST. They are prevented at the tar end now, but this
# must still run before anything else walks the tree: when it ran after the vsix
# move below, a leftover `._claude-voice.vsix` made the directory non-empty and
# `rmdir` failed the whole deploy.
find /opt/claude-web -name '._*' -delete || true
# `rm -rf` rather than `rmdir`: this directory is ours and disposable, and failing
# the deploy over an unexpected file in it buys nothing.
mv -f /opt/claude-web/vsix/*.vsix /opt/claude-web/ && rm -rf /opt/claude-web/vsix
# Fail loudly: a silent npm failure leaves the service dead with a confusing
# 'CHDIR' error, which has happened more than once.
cd /opt/claude-web/chat-service && npm install --omit=dev
test -d /opt/claude-web/chat-service/node_modules || { echo 'npm install produced no node_modules'; exit 1; }
chown -R coder:coder /opt/claude-web
# `cc <project>` starts or rejoins a permanent Claude session under tmux. On PATH
# for both the editor terminal and an SSM shell.
install -m 0755 /opt/claude-web/scripts/cc-session.sh /usr/local/bin/cc
command -v tmux >/dev/null || dnf install -y tmux
# The broker that lets one conversation be driven from several devices: its
# systemd unit, and the editor setting that points the panel at it. A script of
# its own because the unit and the settings merge belong next to the code they
# install.
bash /opt/claude-web/claude-broker/install.sh

# Both extensions changed publisher with the rename to TripleC, and a VS Code
# extension's identity is publisher.name, so installing the new .vsix does not
# replace the old one, it sits down next to it. Two copies of the voice extension
# means the command registers twice and the overlay applies twice. Uninstalling by
# the old id is therefore part of shipping the rename. `|| true` because on every
# box provisioned after the rename there is nothing there to remove.
code_server() {
  sudo -u coder HOME=/home/coder /usr/bin/code-server \
    --user-data-dir /workspace/code-server-data \
    --extensions-dir /workspace/code-server-ext "$@"
}
code_server --uninstall-extension claude-web.claude-voice || true
code_server --uninstall-extension claude-web.claude-mobile-shell || true
code_server --install-extension /opt/claude-web/claude-voice.vsix --force
code_server --install-extension /opt/claude-web/claude-mobile.vsix --force
systemctl enable --now claude-chat

# Install the provisioning script from the payload, the way a boot installs it.
#
# Nothing else does. UserData is what writes /opt/bootstrap.sh, and it runs once
# per instance: CloudFormation applies a UserData change to a running box by
# stopping it, rewriting the attribute and starting it again, and cloud-init does
# not re-run its scripts-user stage on a restart. So an edit to
# infra/userdata/bootstrap.sh used to reach this box only via a replacement that no
# longer happens, and the reprovision below would re-run whatever ancient copy was
# on disk while reporting success.
#
# The substitution values are the ones CloudFormation wrote, and they live in the
# instance UserData rather than in this payload, so the boot script is reused
# verbatim with two edits: its S3 fetch becomes a copy from the payload, and its
# own install and run are cut off so the placeholder check below happens before
# anything reaches /opt.
BOOTSRC=/opt/claude-web/userdata/bootstrap.sh
IMDS=$(curl -sf -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' || true)
curl -sf -H "X-aws-ec2-metadata-token: $IMDS" -o /tmp/userdata.boot http://169.254.169.254/latest/user-data || true
if [ -s "$BOOTSRC" ] && grep -q '__PASSWORD_SECRET_ARN__' "$BOOTSRC" &&
  grep -q 'install -m 0755 /tmp/bootstrap.sh /opt/bootstrap.sh' /tmp/userdata.boot; then
  # The boot script names /tmp/bootstrap.sh, and this runs on every install rather
  # than once on a fresh instance, so the predictable path is cleared first. rm -f
  # unlinks a symlink rather than following it, which is the point: everything
  # below this line runs as root.
  rm -f /tmp/bootstrap.sh /tmp/userdata.local
  sed -E -e "s#^aws s3 cp .*bootstrap[.]sh.*#cp $BOOTSRC /tmp/bootstrap.sh#" \
    -e '/^install -m 0755 .tmp.bootstrap[.]sh/d' -e '/^bash .opt.bootstrap[.]sh/d' \
    /tmp/userdata.boot > /tmp/userdata.local
  bash /tmp/userdata.local > /var/log/bootstrap-refresh.log 2>&1 ||
    { echo 'bootstrap refresh failed:'; tail -20 /var/log/bootstrap-refresh.log; exit 1; }
  # A leftover __PLACEHOLDER__ would write a config with no secret in it, so this
  # is checked while the file is still in /tmp and nothing has run it.
  if grep -qE '__[A-Z_]+__' /tmp/bootstrap.sh; then
    echo 'bootstrap refresh left placeholders unsubstituted'
    exit 1
  fi
  install -m 0755 /tmp/bootstrap.sh /opt/bootstrap.sh
  echo 'bootstrap refreshed from payload'
else
  echo "WARNING: no bootstrap refresh; re-running the copy on disk" >&2
fi
# Re-run provisioning on the live instance. The instance is no longer replaced on
# every script edit (see userDataCausesReplacement in stack.js), so this is what
# applies bootstrap changes: nginx routing, editor settings, units. It is written to
# be idempotent.
if [ -x /opt/bootstrap.sh ]; then
  bash /opt/bootstrap.sh > /var/log/reprovision.log 2>&1 ||
    { echo 'reprovision failed:'; tail -20 /var/log/reprovision.log; exit 1; }
fi

# The restarts, and they belong *after* that reprovision.
#
# The reprovision is what writes the systemd units and the editor settings, and
# bootstrap.sh deliberately never restarts anything (`enable --now` leaves a unit
# that is already running exactly as it is, because restarting it is what kills
# live sessions). So restarting first and reprovisioning second leaves the service
# running with the *previous* unit: the file on disk is new, the process
# environment is not, and `systemctl show` reads the file, so it all looks applied.
# That shipped on 2026-09-20 with PWA_NAME, arriving one deploy late.
systemctl restart claude-chat
systemctl restart code-server

# A reload that nginx refuses is silent from out here. `nginx -t` loads the config
# from scratch, so it never sees a conflict with the shared memory the running
# master already holds; `systemctl reload` only sends SIGHUP and exits 0 whatever
# comes of it. When the master then rejects the new config it logs [emerg], keeps
# serving the *old* one, and stays up. That happened on 2026-09-19 with a limit_req
# zone whose key changed under an unchanged name. So read the error log across the
# reload and fail on [emerg].
ERRLOG=/var/log/nginx/error.log
if [ ! -f "$ERRLOG" ]; then echo "cannot verify the nginx reload: $ERRLOG does not exist"; exit 1; fi
BEFORE=$(stat -c %s "$ERRLOG")
nginx -t && systemctl reload nginx
sleep 3
NEW=$(tail -c +$((BEFORE + 1)) "$ERRLOG" | grep '\[emerg\]' || true)
if [ -n "$NEW" ]; then
  echo 'nginx refused the new config and is still serving the old one:'
  printf '%s\n' "$NEW"
  exit 1
fi

# `is-active` exits non-zero if any unit is down, so a half-broken install cannot
# report success. claude-broker included so a broker that dies after install.sh
# checked it (during the reprovision above, say) fails the install rather than
# quietly leaving every browser page with its own Claude again.
systemctl is-active claude-chat code-server nginx claude-broker
curl -fsS -o /dev/null http://127.0.0.1:9997/healthz || { echo 'chat service not answering'; exit 1; }
curl -fsS -o /dev/null http://127.0.0.1:9999/healthz || curl -fsS -o /dev/null http://127.0.0.1:9999/ ||
  { echo 'code-server not answering'; exit 1; }
