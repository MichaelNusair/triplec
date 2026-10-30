#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

# --app-only ships the payload to the instance that is already running and skips
# `cdk deploy` entirely. It exists because a full deploy driven from the box
# itself cannot finish: CloudFormation applies a UserData change by *stopping*
# this instance, rewriting the attribute and starting it again, and every stage
# after `cdk deploy` — the SSM waits, the payload push, the verification — dies
# with the box. Measured on 2026-09-18: change set executed 09:47:17, instance
# stopped 09:47:24, started 09:47:48, stack green at 09:48:02 with no payload
# ever pushed.
#
# It applies everything in the payload — chat service, both extensions, the
# overlay, `cc` — *and* the provisioning script itself: infra/userdata/bootstrap.sh
# now ships in the payload and is installed the way a boot installs it, then run.
# That is deliberate, and it is the fix for the second half of the trap above: the
# stop/start means cloud-init never re-runs (its scripts-user stage is once per
# instance, not per boot), so nothing else on the box ever refreshes
# /opt/bootstrap.sh. The stack would go green carrying a new script that the
# running instance had never executed — which is how a /p/ route sat in the
# template for fifteen minutes without existing in nginx.
#
# So: --app-only from the box ships app *and* provisioning changes. A full deploy
# from a machine that is not the box is still what updates the stack, so that a
# replacement boots the same script this installs, and it is the only thing that
# can change AWS resources. That is no longer advice: a full deploy started on the
# stack's own instance is refused a few dozen lines below, before anything is built
# and before any AWS write.
APP_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --app-only) APP_ONLY=1 ;;
    -h|--help)
      echo "Usage: ./deploy.sh [--app-only]"
      echo "  --app-only  push the payload to the running instance; no stack update"
      exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
# Everything account-specific comes from triplec.config.json (see
# triplec.config.example.json). infra/config.js is the single source of truth for
# defaults and validation, so this reads through it rather than parsing the JSON
# again and drifting from it.
#
# Including the *name* of the file, which is why this asks config.js where the
# config is rather than testing for a filename. A deployment made before the
# rename to TripleC still has its settings in claude-web.config.json, on a machine
# this repository cannot reach — config.js still loads either name, and a check
# here that knew only the new one would tell those deployments they have no
# configuration at all.
CONFIG_FILE="$(node --input-type=module -e "
import { configPath } from 'file://$ROOT/infra/config.js';
import { existsSync } from 'fs';
const found = configPath();
process.stdout.write(existsSync(found) ? found : '');
" 2>/dev/null || true)"
if [ -z "$CONFIG_FILE" ] && [ -z "${TRIPLEC_DOMAIN:-}" ] && [ -z "${CLAUDE_WEB_DOMAIN:-}" ]; then
  cat >&2 <<'NOCONFIG'
No configuration found.

  cp triplec.config.example.json triplec.config.json
  $EDITOR triplec.config.json      # set domainName and hostedZoneName

You need an AWS account, a Route53 hosted zone you control, and Bedrock model
access enabled in your region. See docs/DEPLOY.md.
NOCONFIG
  exit 1
fi

eval "$(node infra/print-config.js)"

DOMAIN="$CFG_DOMAIN"
REGION="$CFG_REGION"
PROFILE="$CFG_PROFILE"
STACK_NAME="$CFG_STACK"

# An empty --profile is not a valid flag, so the profile is only passed when the
# deployment actually configured one; otherwise the default credential chain is
# used, which is what most people and all CI systems want.
AWS_ARGS=(--region "$REGION")
[ -n "$PROFILE" ] && AWS_ARGS+=(--profile "$PROFILE")

printf '\n\033[1mDeploying\033[0m %s\n' "https://$DOMAIN"
printf '  region %s   auth %s   permissions %s   admin-role %s\n' \
  "$REGION" "$CFG_AUTH_MODE" "$CFG_PERMISSION_MODE" "$CFG_ADMIN"
# Which deployment this is, in its own words. Two of them in one account means two
# configs and one repository, and "which one am I about to change" is worth stating
# rather than inferring from a hostname.
if [ -n "$CFG_PWA_NAME" ]; then
  printf '  name %s   (windows are titled "%s: <project>")\n' "$CFG_PWA_NAME" "$CFG_PWA_NAME"
fi

# Credentials are checked before anything is built, because when they are wrong
# the failure otherwise lands minutes in, after the tests and the vsix packaging,
# wearing a message about something else. Two real cases: an expired SSO session,
# and — after this stack replaced its own instance — an `awsProfile` still naming
# a profile that lived in the old root volume's ~/.aws and was simply gone.
if ! IDENTITY="$(aws sts get-caller-identity --query Arn --output text "${AWS_ARGS[@]}" 2>&1)"; then
  {
    echo "Cannot use these AWS credentials:"
    echo "  $IDENTITY"
    [ -n "$PROFILE" ] &&
      echo "  awsProfile in $(basename "$CONFIG_FILE") is \"$PROFILE\". Clear it to fall back to" &&
      echo "  the default credential chain (on the instance, that is its own role)."
  } >&2
  exit 1
fi
printf '  identity %s\n' "$IDENTITY"

# ---------------------------------------------------------------------------
# A full deploy may not be driven from the instance it deploys to.
# ---------------------------------------------------------------------------
# This is the trap described at the top of the file, turned into a refusal. The
# script used to start such a deploy quite happily and leave you to find the
# half-applied result: CloudFormation stops this instance to apply a UserData
# change, so the SSM waits, the payload push, the login checks and the summary all
# die with the box, and the stack goes green carrying code the running instance
# never received.
#
# It is checked here — before the tests, the vsix packaging and any AWS write —
# because the whole point is to cost you five seconds instead of five minutes and
# a stack you now have to reason about.
#
# Both ways forward are cheap, so nothing is lost by refusing: --app-only from
# here ships the app *and* the provisioning script, and a full deploy from any
# machine that is not this one changes AWS resources with nothing downstream of
# the stop/start. docs/DEPLOY.md names the box this account uses for that.
if [ "$APP_ONLY" -eq 0 ]; then
  # A laptop has no metadata service, and 169.254.169.254 is a link-local address
  # that will never answer there — so this has to fail fast rather than hang the
  # deploy of someone who is already doing the right thing.
  IMDS_TOKEN="$(curl -sf -m 1 -X PUT http://169.254.169.254/latest/api/token \
    -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' 2>/dev/null || true)"
  SELF_ID=""
  [ -n "$IMDS_TOKEN" ] && SELF_ID="$(curl -sf -m 1 \
    -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" \
    http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null || true)"
  # Empty or None when the stack does not exist yet, which is the one case where a
  # full deploy from anywhere is safe: there is no running instance for it to pull
  # out from under itself.
  STACK_INSTANCE="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue | [0]" \
    --output text "${AWS_ARGS[@]}" 2>/dev/null || true)"
  if [ -n "$SELF_ID" ] && [ "$SELF_ID" = "$STACK_INSTANCE" ]; then
    cat >&2 <<REFUSE

Refusing a full deploy: this is the instance the stack manages ($SELF_ID).

CloudFormation applies a UserData change by stopping this instance and starting
it again. Everything this script does after 'cdk deploy' — waiting for SSM,
pushing the payload, checking that the app still requires a login — would die
with the box, leaving the stack green and the running app never updated.

Two ways forward:

  ./deploy.sh --app-only      Ships the app and infra/userdata/bootstrap.sh to
                              the running instance. No AWS resource changes.

  From any other machine:     git fetch && git reset --hard origin/main
                              ./deploy.sh
                              This is the only thing that can change the stack.

Push your work first either way: this script ships the working tree it is run
from, so a deploy box with a stale clone will quietly ship stale code.
REFUSE
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
step "Installing what the tests need"
# ---------------------------------------------------------------------------
# This used to be `[ -d node_modules/ws ] || npm install` inside the auth step,
# which meant a dependency added *after* a machine's first deploy was never
# installed on it: node_modules/ws existed, so nothing ran, and the suite died on
# ERR_MODULE_NOT_FOUND for a package sitting right there in package.json. That is
# a trap that only springs on the second deploy from a given box — which is to say,
# on the deploy box, and never on the machine the dependency was added on. npm is
# quick when there is nothing to do, so ask it every time instead of guessing from
# one directory.
(
  cd chat-service
  npm install --silent --no-audit --no-fund
) || { echo "npm install failed in chat-service — not deploying." >&2; exit 1; }

# ---------------------------------------------------------------------------
step "Checking authentication"
# ---------------------------------------------------------------------------
# Runs first and blocks the deploy, because this is the check that matters: the
# chat service can execute shell commands, and it once shipped reachable without
# credentials. Boots the real server and confirms every route and the WebSocket
# upgrade refuse an unauthenticated caller.
(
  cd chat-service
  node auth-test.js
) || { echo "AUTH TESTS FAILED — refusing to deploy." >&2; exit 1; }
# Route *coverage* is the other half of that, and until 2026-09-21 this gate did not
# run it: `manifest-test.js` reads the nginx config out of `infra/userdata/bootstrap.sh`
# and requires `auth_request` on every location that reaches code-server. That file is
# part of this payload, so without this line the deploy ships the routing and never
# checks it — and a route that reaches the editor without the gate is a shell on this
# box for whoever finds it, which is the failure that already happened once.
(
  cd chat-service
  node manifest-test.js
) || { echo "AUTH ROUTE COVERAGE FAILED — refusing to deploy." >&2; exit 1; }

# ---------------------------------------------------------------------------
step "Checking the client boots"
# ---------------------------------------------------------------------------
# `node --check` only parses. This actually runs app.js in a DOM, because a
# runtime error at load leaves the page stuck on "Loading…" with no other
# symptom — and that has shipped before.
(
  cd chat-service
  node smoke-test.js
) || { echo "client smoke test failed — not deploying." >&2; exit 1; }

# ---------------------------------------------------------------------------
step "Checking several chats at once"
# ---------------------------------------------------------------------------
# Everything a second chat tab is for happens where no browser can show it: in a
# thread that is off screen. What this holds down is the part that would cost work
# rather than pixels — closing a tab must not stop the conversation behind it, the
# tab limit must not silence a chat that is still working, and no session id may
# ever be held by two panes at once.
(
  cd chat-service
  node pane-test.js
) || { echo "multi-chat tests failed — not deploying." >&2; exit 1; }

# ---------------------------------------------------------------------------
step "Checking that a message can be heard"
# ---------------------------------------------------------------------------
# Read-aloud in the chat app is entirely invisible from a desktop browser and
# inaudible from a test, so this drives it directly: that a code block is read by
# the server rather than a browser voice (which reads code as a minute of
# punctuation names), that the nth button reads the nth block, that a deployment
# with no voice configured offers no controls at all rather than buttons that
# explain a 401, and that an unset voice leaves the choice per message to the
# server — which is what reads a Hebrew answer in Hebrew.
(
  cd chat-service
  node read-test.js
) || { echo "read-aloud tests failed — not deploying." >&2; exit 1; }

# ---------------------------------------------------------------------------
step "Checking the spoken conversation's client"
# ---------------------------------------------------------------------------
# The other half of realtime-test.js: that one covers minting a credential, this
# one covers the browser spending it. Everything here is invisible from the server
# because the audio never reaches it — so what is checked is that the conversation
# sends nothing to our own box for the life of it (it is meant to be a dead end
# Claude cannot be reached through), that the microphone is asked for before a
# session is paid for, and that every way out of it stops the microphone.
(
  cd chat-service
  node talk-test.js
) || { echo "spoken conversation client tests failed — not deploying." >&2; exit 1; }

# ---------------------------------------------------------------------------
step "Checking the editor overlay"
# ---------------------------------------------------------------------------
# Nothing but nginx loads this file, so a load-time error removes the mic, the
# project switcher and the layout rescue from the editor with no other symptom.
# It also checks that the rescue's keyboard chords still match the keybindings
# the mobile extension declares — two files, no shared code, and a silent
# failure if they drift.
(
  cd chat-service
  node overlay-test.js
) || { echo "editor overlay test failed — not deploying." >&2; exit 1; }

# ---------------------------------------------------------------------------
step "Checking the voice that reads messages aloud"
# ---------------------------------------------------------------------------
# Polly bills per character, so most of what this checks is what the voice
# *refuses*: the daily budget, a message too long to read aloud, an id nobody
# prepared, and audio replayed from the cache rather than bought twice. It also
# checks where a message is cut into pieces, which is the part of this a listener
# can hear. Runs against a fake synthesiser — no credentials, nothing spent.
(
  cd chat-service
  node speak-test.js
) || { echo "voice tests failed — not deploying." >&2; exit 1; }

# ---------------------------------------------------------------------------
step "Checking the spoken conversation"
# ---------------------------------------------------------------------------
# This one mints a credential for a browser to talk to OpenAI directly, and the
# conversation it opens deliberately cannot reach Claude — no tools, no import that
# could. Most of what this checks is that boundary, because the failure it prevents
# is a voice with no transcript saying "done, I pushed it" when nothing was pushed.
# The rest is the money: the daily count is spent before the call and handed back if
# it fails. Runs against a fake OpenAI — no key, no realtime minutes billed.
(
  cd chat-service
  node realtime-test.js
) || { echo "spoken conversation tests failed — not deploying." >&2; exit 1; }

# ---------------------------------------------------------------------------
step "Checking which model hears you"
# ---------------------------------------------------------------------------
# Dictation has three backends now, and the routing between them is the kind of
# thing that fails without failing: the model installed on this box is
# `ggml-base.en.bin`, and handed Hebrew it returns a fluent English sentence
# nobody said, straight into the box where a prompt is typed. So this checks that
# a non-English request never reaches it — and, across four passes with fake keys,
# that English still goes to the free local model rather than quietly starting to
# cost money per minute, and that Hebrew goes to the free recognizer before the
# metered one. No whisper run, no network, no audio transcribed.
(
  cd chat-service
  node transcribe-test.js
) || { echo "dictation routing tests failed — not deploying." >&2; exit 1; }
# And what happens to the words afterwards. The cleanup pass sends a half-finished
# message to a model and puts the answer back in somebody's composer, so its two
# failures are putting text there that nobody said, and losing text that was only
# ever spoken once. Both are bounded in `polish.js` rather than prompted for.
(
  cd chat-service
  node polish-test.js
) || { echo "dictation cleanup tests failed — not deploying." >&2; exit 1; }

# ---------------------------------------------------------------------------
step "Checking the Hebrew voice and the Hebrew ear"
# ---------------------------------------------------------------------------
# Hebrew is the one language on this box that has no free local answer: Polly has
# no he-IL voice at all and skips the characters silently, and the installed
# dictation model is English-only. Azure AI Speech covers both, on an F0 tier that
# answers 429 rather than billing — which is the whole reason it is the backend, so
# the test asserts that the quota message says nothing is charged. The other half is
# escaping: SSML is XML, a code block is full of `&&` and `<`, and unescaped it is
# a 400 that would leave prose readable and code not. Runs against a fake Azure —
# no key, no network, and none of the month's free characters spent.
(
  cd chat-service
  node azure-speech-test.js
) || { echo "Hebrew voice tests failed — not deploying." >&2; exit 1; }

# ---------------------------------------------------------------------------
step "Checking the project lifecycle"
# ---------------------------------------------------------------------------
# Removing a project deletes a directory tree, so this exercises the refusals
# against real git repositories: unpushed commits, no remote, a stash. A bug here
# loses work that exists nowhere else, which no later fix recovers.
(
  cd chat-service
  node project-test.js
) || { echo "project lifecycle tests failed — not deploying." >&2; exit 1; }

# ---------------------------------------------------------------------------
step "Checking the app can say which build it is"
# ---------------------------------------------------------------------------
# The version line's two failure modes are both silent, and this deploy is the
# thing that creates one of them: it writes the stamp read by build.js a few
# hundred lines below. So the resolution order is checked here — a stamp is never
# guessed at, and a stamp written by a deploy box cannot carry markup into the
# `<meta>` tag it lands in — along with the client's answer for a tab that was
# loaded before this deploy and is about to be out of date.
(
  cd chat-service
  node build-test.js
) || { echo "build identity tests failed — not deploying." >&2; exit 1; }

# ---------------------------------------------------------------------------
step "Checking the operations surface"
# ---------------------------------------------------------------------------
# /chat/admin can signal processes, so what it *refuses* is the code under test:
# nothing stopped mid-turn without an answered question, no pid signalled that has
# not just been re-found under the broker, and no session name handed to tmux
# unvalidated. Runs the page in a DOM too, since this is the surface you would be
# opening to find out why something else is broken.
(
  cd chat-service
  node admin-test.js
) || { echo "admin tests failed — not deploying." >&2; exit 1; }

# ---------------------------------------------------------------------------
step "Checking what a device is told, and what makes a phone buzz"
# ---------------------------------------------------------------------------
# Both of these fail quietly in production, which is why they belong in a gate: the
# watcher's `tick()` catches its own throw and logs one line, so a broken watcher
# stops noticing turns and nothing buzzes, while `claude-status.js` only answers the
# editor's overlay, so a wrong answer is a chip that lies rather than a page that
# breaks. Neither shows up in the steps above — until 2026-09-21 a tree that had
# deleted a function turn-watcher.js still called would have shipped from here.
(
  cd chat-service
  node status-test.js
) || { echo "status tests failed — not deploying." >&2; exit 1; }
(
  cd chat-service
  node turn-watcher-test.js
) || { echo "turn watcher tests failed — not deploying." >&2; exit 1; }
# The rest of the same chain, which fails in the same register. `push.js` hand-rolls
# VAPID and RFC 8291 encryption, so a mistake there is a push service returning 400 to
# a server nobody is reading the logs of; `sw.js` runs in a worker with no console
# anyone sees, so a throw in `notificationclick` looks exactly like a phone ignoring
# the tap. Every step of "a turn ended" → "a thumb on a notification" is now gated.
(
  cd chat-service
  node push-test.js
) || { echo "push tests failed — not deploying." >&2; exit 1; }
(
  cd chat-service
  node sw-test.js
) || { echo "service worker tests failed — not deploying." >&2; exit 1; }
# The mux and the worktree slots under it. A slot is a git worktree that a new chat
# fast-forwards, so what is gated here is that preparing one never loses an edit or
# a commit, and that removing a project refuses while a slot holds uncommitted work.
(
  cd chat-service
  node mux-test.js
) || { echo "mux and slot tests failed — not deploying." >&2; exit 1; }
# The mux's terminal panes: a pty on this box behind a socket, so a shell. Gated here
# is that `cc` opens exactly the session it names (a bare tmux target is a prefix
# match), that the socket refuses without a session or a tmux server to own what it
# starts, and the relay's sizes, hang-up and exit status on a real pty.
(
  cd chat-service
  node term-test.js
) || { echo "terminal tests failed — not deploying." >&2; exit 1; }

# ---------------------------------------------------------------------------
step "Checking the Claude broker"
# ---------------------------------------------------------------------------
# The broker sits between the editor's Claude panel and the real CLI, so a bug
# here takes away the interface rather than degrading it. Boots the real broker
# over a real socket and checks both halves: two clients share one process, and
# every failure path still runs Claude directly.
(
  node claude-broker/broker-test.js
) || { echo "broker tests failed — not deploying." >&2; exit 1; }

# ---------------------------------------------------------------------------
step "Packaging the voice dictation extension"
# ---------------------------------------------------------------------------
mkdir -p dist
for ext in voice-extension mobile-extension; do
  out="claude-voice.vsix"
  [ "$ext" = "mobile-extension" ] && out="claude-mobile.vsix"
  (
    cd "$ext"
    npx --yes @vscode/vsce@latest package \
      --skip-license \
      --allow-missing-repository \
      --out "$ROOT/dist/$out"
  )
done

if [ "$APP_ONLY" -eq 1 ]; then
# ---------------------------------------------------------------------------
step "Skipping infrastructure (--app-only)"
# ---------------------------------------------------------------------------
# Read the running stack's outputs into the same file `cdk deploy` would have
# written, so every stage after this one is one code path rather than two.
# Via a file rather than a shell variable in the heredoc: output values are
# arbitrary strings and an unquoted heredoc would expand a `$` in one of them.
aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs' --output json "${AWS_ARGS[@]}" \
  > "$ROOT/dist/stack-outputs.json" ||
  { echo "Cannot read outputs for stack $STACK_NAME — is it deployed?" >&2; exit 1; }
python3 - "$STACK_NAME" "$ROOT/dist/stack-outputs.json" "$ROOT/dist/outputs.json" <<'PY'
import json, sys
stack, src, dst = sys.argv[1:4]
outputs = json.load(open(src)) or []
json.dump({stack: {o['OutputKey']: o['OutputValue'] for o in outputs}}, open(dst, 'w'))
PY
echo "  using the running stack: no AWS resource changes from infra/lib are applied,"
echo "  but infra/userdata/bootstrap.sh is — it ships in the payload and is installed"
echo "  and re-run on the instance below."
else
# ---------------------------------------------------------------------------
step "Deploying infrastructure"
# ---------------------------------------------------------------------------
CDK_ARGS=()
CDK_CREDS=""
if [ -n "$PROFILE" ]; then
  # The CDK CLI understands a narrower slice of ~/.aws/config than the AWS CLI
  # does. A profile that sources its credentials from somewhere CDK has not
  # implemented — `credential_source = Ec2InstanceMetadata` is the one that bit
  # us, deploying from an instance — fails with "Unable to resolve AWS account to
  # use" while every `aws` call in this script using the same profile works.
  #
  # So the profile is resolved by the tool that understands it, and CDK is handed
  # the result as plain environment credentials. `--profile` is then deliberately
  # not passed: it would send CDK back to the config file it cannot read.
  if CDK_CREDS="$(aws configure export-credentials --profile "$PROFILE" --format env 2>/dev/null)" \
    && [ -n "$CDK_CREDS" ]; then
    echo "  resolved profile $PROFILE into environment credentials for CDK"
  else
    # Older AWS CLIs have no export-credentials. Fall back to the flag, which
    # works for the ordinary profile types.
    CDK_CREDS=""
    CDK_ARGS+=(--profile "$PROFILE")
  fi
fi
(
  cd infra
  [ -d node_modules ] || npm install
  # Scoped to this subshell so the rest of the script keeps using --profile.
  [ -n "$CDK_CREDS" ] && eval "$CDK_CREDS"
  npx cdk deploy "$STACK_NAME" \
    "${CDK_ARGS[@]+"${CDK_ARGS[@]}"}" \
    --require-approval never \
    --outputs-file "$ROOT/dist/outputs.json"
) || { echo "CDK deploy failed — stopping before the payload step." >&2; exit 1; }
fi

# A failed CDK run can leave a stale outputs file from a previous deploy, which
# would silently point the rest of this script at the wrong instance.
[ -s "$ROOT/dist/outputs.json" ] || { echo "No stack outputs written." >&2; exit 1; }

read_output() {
  python3 -c "
import json,sys
print(json.load(open('$ROOT/dist/outputs.json'))['$STACK_NAME'].get('$1',''))"
}

INSTANCE_ID="$(read_output InstanceId)"
[ -n "$INSTANCE_ID" ] || { echo "No InstanceId in stack outputs." >&2; exit 1; }
step "Instance: $INSTANCE_ID"

# ---------------------------------------------------------------------------
step "Waiting for SSM agent"
# ---------------------------------------------------------------------------
state=None
for _ in $(seq 1 60); do
  state="$(aws ssm describe-instance-information \
    --filters "Key=InstanceIds,Values=$INSTANCE_ID" \
    --query 'InstanceInformationList[0].PingStatus' --output text \
    "${AWS_ARGS[@]}" 2>/dev/null || echo None)"
  [ "$state" = "Online" ] && break
  sleep 10
done
[ "$state" = "Online" ] || { echo "SSM never came online." >&2; exit 1; }

# ---------------------------------------------------------------------------
step "Waiting for first-boot provisioning to finish"
# ---------------------------------------------------------------------------
# SSM answers well before cloud-init is done. Installing the payload before
# Node exists fails with "npm: command not found", so gate on cloud-init.
WAIT_ID="$(aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --comment "wait for cloud-init" \
  --parameters 'commands=["cloud-init status --wait || true","command -v npm >/dev/null || { echo MISSING_NPM; tail -40 /var/log/bootstrap.log; exit 1; }","command -v code-server >/dev/null || { echo MISSING_CODE_SERVER; tail -40 /var/log/bootstrap.log; exit 1; }"]' \
  --timeout-seconds 1800 \
  --query 'Command.CommandId' --output text \
  "${AWS_ARGS[@]}")"

while true; do
  st="$(aws ssm get-command-invocation --command-id "$WAIT_ID" --instance-id "$INSTANCE_ID" \
    --query Status --output text "${AWS_ARGS[@]}" 2>/dev/null || echo Pending)"
  case "$st" in
    Success) break ;;
    Failed|Cancelled|TimedOut)
      echo "Provisioning did not complete ($st):" >&2
      aws ssm get-command-invocation --command-id "$WAIT_ID" --instance-id "$INSTANCE_ID" \
        --query 'StandardOutputContent' --output text \
        "${AWS_ARGS[@]}" >&2
      exit 1 ;;
  esac
  sleep 15
done

# ---------------------------------------------------------------------------
step "Uploading application payload"
# ---------------------------------------------------------------------------
# Shipped separately from userdata so editing the voice extension or PWA assets
# doesn't force an EC2 replacement.
rm -rf dist/stage && mkdir -p dist/stage
cp -R chat-service dist/stage/chat-service
rm -rf dist/stage/chat-service/node_modules
# ---------------------------------------------------------------------------
# Which build this is
# ---------------------------------------------------------------------------
# Stamped into the payload here because here is the only place that knows. A
# deploy ships a tarball with no `.git` in it, so the running service cannot ask
# git what it is; and the checkout on the box answers for the checkout, which on
# the shared workspace instance is routinely several commits away from what is
# installed. Without this, "am I running what I pushed" has no answer inside the
# app — which is the whole reason chat-service/build.js exists.
#
# `dirty` is recorded rather than refused: `--app-only` deliberately ships the
# working tree, and a sha that quietly stood for uncommitted work would be the one
# kind of version number worse than none. The app shows it as `<sha>+`.
BUILD_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || true)"
BUILD_COMMIT_AT="$(git log -1 --format=%ct 2>/dev/null || true)"
BUILD_SUBJECT="$(git log -1 --format=%s 2>/dev/null || true)"
# -uno: an untracked scratch file in a shared checkout is not a different build.
if [ -n "$(git status --porcelain -uno 2>/dev/null || true)" ]; then
  BUILD_DIRTY=true
else
  BUILD_DIRTY=false
fi
python3 - "$BUILD_COMMIT" "$BUILD_COMMIT_AT" "$BUILD_SUBJECT" "$BUILD_DIRTY" \
  > dist/stage/chat-service/build.json <<'STAMP'
import json, sys, time
commit, commit_at, subject, dirty = sys.argv[1:5]
try:
    version = json.load(open('package.json'))['version']
except Exception:
    version = ''
json.dump(
    {
        'version': version,
        'commit': commit,
        'commitAt': int(commit_at) * 1000 if commit_at.isdigit() else None,
        'subject': subject,
        'dirty': dirty == 'true',
        'builtAt': int(time.time() * 1000),
    },
    sys.stdout,
    indent=2,
)
sys.stdout.write('\n')
STAMP
if [ "$BUILD_DIRTY" = true ]; then
  echo "  build: ${BUILD_COMMIT:-unknown}+ (uncommitted changes in this tree)"
else
  echo "  build: ${BUILD_COMMIT:-unknown}"
fi
# The overlay script is injected into the editor shell by nginx, so it ships as
# a top-level asset rather than inside the chat service.
mkdir -p dist/stage/pwa && cp pwa/mobile-overlay.js dist/stage/pwa/
# Ships in the payload rather than baked into userdata, so `cc` can be updated
# without replacing the instance.
mkdir -p dist/stage/scripts && cp scripts/cc-session.sh dist/stage/scripts/
# The provisioning script, as the template it is — placeholders unsubstituted. The
# instance's own UserData is what substitutes them (see the refresh block below),
# because it already holds the values CloudFormation wrote and this deploy does not.
mkdir -p dist/stage/userdata && cp infra/userdata/bootstrap.sh dist/stage/userdata/
# The broker that keeps one `claude` per conversation for the editor's panel. No
# dependencies beyond node, so it ships as plain files with no npm install.
mkdir -p dist/stage/claude-broker
# package.json is not decoration here: `wrapper` has no file extension, so its
# `"type": "module"` is what makes node load it as an ES module.
cp claude-broker/broker.js claude-broker/wrapper claude-broker/package.json \
  claude-broker/claude-broker.service claude-broker/install.sh dist/stage/claude-broker/
mkdir -p dist/stage/vsix
cp dist/claude-voice.vsix dist/claude-mobile.vsix dist/stage/vsix/
# The chat UI serves its own PWA assets, so bundle them into its public dir. The
# overlay as well: the mux loads it from /chat/ for its voice (see mux.js).
cp pwa/manifest.webmanifest pwa/sw.js pwa/reset.html pwa/mobile-overlay.js dist/stage/chat-service/public/
mkdir -p dist/stage/chat-service/public/pwa-icons
# Which icon set, from the config: two deployments of this repository are two apps
# on the same phone, and an icon is how you tell them apart. Named files rather
# than a glob so the set can keep its source artwork next to it, and so a missing
# one is an error here instead of an icon that silently does not exist on a home
# screen — config.js has already checked all of them are present.
for icon in $CFG_PWA_ICON_FILES; do
  cp "$CFG_PWA_ICON_DIR/$icon" dist/stage/chat-service/public/pwa-icons/
done
echo "  icons: $CFG_PWA_ICON_DIR"
# COPYFILE_DISABLE stops macOS tar from emitting AppleDouble `._*` companions for
# every file carrying an extended attribute (macOS adds com.apple.provenance to
# downloaded and newly written files). Those stubs land on the instance, show up
# as phantom files in the editor, and left a non-empty directory behind that
# broke the vsix cleanup below.
COPYFILE_DISABLE=1 tar -czf dist/payload.tar.gz -C dist/stage \
  chat-service pwa vsix scripts claude-broker userdata

# Staged through S3 rather than inlined into the SSM command.
#
# SSM caps a parameter value at ~100 KB, and base64 inflates by a third, so the
# inline route hit a hard wall the moment the chat service grew — which it did,
# the first time authentication was added. The transfer bucket already exists for
# migrate.sh and the instance role can already read it, so this has no
# infrastructure cost and no size cliff to trip over again.
TRANSFER_BUCKET="$(read_output TransferBucketName)"
[ -n "$TRANSFER_BUCKET" ] || { echo "No TransferBucketName in stack outputs." >&2; exit 1; }

PAYLOAD_KEY="payload/$(date +%Y%m%d-%H%M%S)-$$.tar.gz"
step "Staging payload via s3://$TRANSFER_BUCKET/$PAYLOAD_KEY"
aws s3 cp dist/payload.tar.gz "s3://$TRANSFER_BUCKET/$PAYLOAD_KEY" \
  "${AWS_ARGS[@]}" --only-show-errors

CMD_ID="$(aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --comment "TripleC payload" \
  --cli-input-json "$(python3 - "$TRANSFER_BUCKET" "$PAYLOAD_KEY" "$REGION" <<'PY'
import json, sys
bucket, key, region = sys.argv[1], sys.argv[2], sys.argv[3]
cmds = [
  "set -euxo pipefail",
  "mkdir -p /opt/claude-web && cd /opt/claude-web",
  f"aws s3 cp s3://{bucket}/{key} /tmp/payload.tar.gz --region {region}",
  "tar -xzf /tmp/payload.tar.gz -C /opt/claude-web",
  "rm -f /tmp/payload.tar.gz",
  # Delete AppleDouble stubs FIRST. They are prevented at the tar end now, but
  # this must still run before anything else walks the tree: when it ran after
  # the vsix move below, a leftover `._claude-voice.vsix` made the directory
  # non-empty and `rmdir` failed the whole deploy.
  "find /opt/claude-web -name '._*' -delete || true",
  # `rm -rf` rather than `rmdir`: this directory is ours and disposable, and
  # failing the deploy over an unexpected file in it buys nothing.
  "mv -f /opt/claude-web/vsix/*.vsix /opt/claude-web/ && rm -rf /opt/claude-web/vsix",
  # Fail loudly: a silent npm failure leaves the service dead with a confusing
  # 'CHDIR' error, which has happened more than once.
  "cd /opt/claude-web/chat-service && npm install --omit=dev",
  "test -d /opt/claude-web/chat-service/node_modules || { echo 'npm install produced no node_modules'; exit 1; }",
  "chown -R coder:coder /opt/claude-web",
  # `cc <project>` starts or rejoins a permanent Claude session under tmux. On
  # PATH for both the editor terminal and an SSM shell.
  # NOTE: no apostrophes in comments here — this block sits inside a command
  # substitution, and bash tracks single quotes through it, so one stray
  # apostrophe breaks the whole script with a confusing EOF error.
  "install -m 0755 /opt/claude-web/scripts/cc-session.sh /usr/local/bin/cc",
  "command -v tmux >/dev/null || dnf install -y tmux",
  # The broker that lets one conversation be driven from several devices: its
  # systemd unit, and the editor setting that points the panel at it.
  #
  # A script rather than commands here, because the unit and the settings merge
  # belong next to the code they install, and because this block is a python
  # heredoc inside a command substitution — a nested heredoc is exactly the shape
  # that breaks it.
  "bash /opt/claude-web/claude-broker/install.sh",
  # Both extensions changed publisher with the rename to TripleC, and a VS Code
  # extension's identity is publisher.name — so installing the new .vsix does not
  # replace the old one, it sits down next to it. Two copies of the voice
  # extension means the command registers twice and the overlay applies twice, on
  # a box where nothing would say which copy answered.
  #
  # Uninstalling by the old id is therefore part of shipping the rename, not
  # tidying after it. `|| true` because on every box provisioned after the rename
  # there is nothing there to remove, and that is not an error.
  "sudo -u coder HOME=/home/coder /usr/bin/code-server"
  " --user-data-dir /workspace/code-server-data"
  " --extensions-dir /workspace/code-server-ext"
  " --uninstall-extension claude-web.claude-voice || true",
  "sudo -u coder HOME=/home/coder /usr/bin/code-server"
  " --user-data-dir /workspace/code-server-data"
  " --extensions-dir /workspace/code-server-ext"
  " --uninstall-extension claude-web.claude-mobile-shell || true",
  "sudo -u coder HOME=/home/coder /usr/bin/code-server"
  " --user-data-dir /workspace/code-server-data"
  " --extensions-dir /workspace/code-server-ext"
  " --install-extension /opt/claude-web/claude-voice.vsix --force",
  "sudo -u coder HOME=/home/coder /usr/bin/code-server"
  " --user-data-dir /workspace/code-server-data"
  " --extensions-dir /workspace/code-server-ext"
  " --install-extension /opt/claude-web/claude-mobile.vsix --force",
  "systemctl enable --now claude-chat",
  # Install the provisioning script from the payload, the way a boot installs it.
  #
  # Nothing else does. UserData is what writes /opt/bootstrap.sh, and it runs once
  # per instance: CloudFormation applies a UserData change to a running box by
  # stopping it, rewriting the attribute and starting it again, and cloud-init does
  # not re-run its scripts-user stage on a restart. So an edit to
  # infra/userdata/bootstrap.sh used to reach this box only via a replacement that
  # no longer happens, and the deploy below would re-run whatever ancient copy was
  # on disk while reporting success.
  #
  # The substitution values are the ones CloudFormation wrote, and they live in the
  # instance UserData rather than in this deploy — so the boot script is reused
  # verbatim with two edits: its S3 fetch becomes a copy from the payload, and its
  # own install and run are cut off so the placeholder check below happens before
  # anything reaches /opt.
  "BOOTSRC=/opt/claude-web/userdata/bootstrap.sh",
  "IMDS=$(curl -sf -X PUT http://169.254.169.254/latest/api/token"
  " -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' || true)",
  "curl -sf -H \"X-aws-ec2-metadata-token: $IMDS\" -o /tmp/userdata.boot"
  " http://169.254.169.254/latest/user-data || true",
  "if [ -s \"$BOOTSRC\" ] && grep -q '__PASSWORD_SECRET_ARN__' \"$BOOTSRC\""
  " && grep -q 'install -m 0755 /tmp/bootstrap.sh /opt/bootstrap.sh' /tmp/userdata.boot; then"
  # The boot script names /tmp/bootstrap.sh, and this now runs on every deploy
  # rather than once on a fresh instance — so the predictable path is cleared
  # first. rm -f unlinks a symlink rather than following it, which is the point:
  # everything below this line runs as root.
  " rm -f /tmp/bootstrap.sh /tmp/userdata.local;"
  " sed -E -e \"s#^aws s3 cp .*bootstrap[.]sh.*#cp $BOOTSRC /tmp/bootstrap.sh#\""
  " -e '/^install -m 0755 .tmp.bootstrap[.]sh/d' -e '/^bash .opt.bootstrap[.]sh/d'"
  " /tmp/userdata.boot > /tmp/userdata.local;"
  " bash /tmp/userdata.local > /var/log/bootstrap-refresh.log 2>&1 || "
  "{ echo 'bootstrap refresh failed:'; tail -20 /var/log/bootstrap-refresh.log; exit 1; };"
  # A leftover __PLACEHOLDER__ would write a config with no secret in it, so this
  # is checked while the file is still in /tmp and nothing has run it.
  " if grep -qE '__[A-Z_]+__' /tmp/bootstrap.sh; then"
  " echo 'bootstrap refresh left placeholders unsubstituted'; exit 1; fi;"
  " install -m 0755 /tmp/bootstrap.sh /opt/bootstrap.sh;"
  " echo 'bootstrap refreshed from payload';"
  " else echo \"WARNING: no bootstrap refresh; re-running the copy on disk\" >&2; fi",
  # Re-run provisioning on the live instance. The instance is no longer
  # replaced on every script edit (see userDataCausesReplacement in stack.js),
  # so this is what applies bootstrap changes — nginx routing, editor settings,
  # the built-in-chat removal. It is written to be idempotent.
  "if [ -x /opt/bootstrap.sh ]; then bash /opt/bootstrap.sh > /var/log/reprovision.log 2>&1 || "
  "{ echo 'reprovision failed:'; tail -20 /var/log/reprovision.log; exit 1; }; fi",
  # The restarts, and they belong *after* that reprovision.
  #
  # The reprovision is what writes the systemd units and the editor settings, and
  # bootstrap.sh deliberately never restarts anything — `enable --now` leaves a unit
  # that is already running exactly as it is, because restarting it is what kills
  # live sessions. So a deploy that restarts first and reprovisions second leaves the
  # service running with the *previous* unit: the file on disk is new, the process
  # environment is not, and `systemctl show` reads the file, so it all looks applied.
  #
  # That shipped on 2026-09-20 with `PWA_NAME`. Payload 12:49:35, restart 12:49:44,
  # unit rewritten 12:50:11 — the deploy reported success and every title still said
  # "Claude", and the variable would have arrived one deploy late, looking like it had
  # worked all along. Anything a deploy adds to a unit has this shape.
  "systemctl restart claude-chat",
  "systemctl restart code-server",
  # A reload that nginx refuses is silent from out here. `nginx -t` loads the
  # config from scratch, so it never sees a conflict with the shared memory the
  # running master already holds; `systemctl reload` only sends SIGHUP and exits 0
  # whatever comes of it. When the master then rejects the new config it logs
  # [emerg], keeps serving the *old* one, and stays up — so every signal this
  # deploy had said success while nothing had changed. That happened on 2026-09-19
  # with a limit_req zone whose key changed under an unchanged name, and it cost an
  # hour of looking for the bug in a config file that was correct and simply was
  # not running. So read the error log across the reload and fail on [emerg].
  "ERRLOG=/var/log/nginx/error.log",
  "if [ ! -f \"$ERRLOG\" ]; then echo \"cannot verify the nginx reload: $ERRLOG does not exist\"; exit 1; fi",
  "BEFORE=$(stat -c %s \"$ERRLOG\")",
  "nginx -t && systemctl reload nginx",
  "sleep 3",
  "NEW=$(tail -c +$((BEFORE + 1)) \"$ERRLOG\" | grep '\\[emerg\\]' || true)",
  "if [ -n \"$NEW\" ]; then echo 'nginx refused the new config and is still serving the old one:';"
  " printf '%s\\n' \"$NEW\"; exit 1; fi",
  # `is-active` exits non-zero if any unit is down, which fails the SSM command
  # — so a half-broken deploy can no longer report success.
  # claude-broker included so a broker that dies after install.sh checked it —
  # during the reprovision above, say — fails the deploy rather than quietly
  # leaving every browser page with its own Claude again.
  "systemctl is-active claude-chat code-server nginx claude-broker",
  "curl -fsS -o /dev/null http://127.0.0.1:9997/healthz || { echo 'chat service not answering'; exit 1; }",
  "curl -fsS -o /dev/null http://127.0.0.1:9999/healthz || curl -fsS -o /dev/null http://127.0.0.1:9999/ || { echo 'code-server not answering'; exit 1; }",
]
print(json.dumps({"Parameters": {"commands": cmds}}))
PY
)" \
  --timeout-seconds 900 \
  --query 'Command.CommandId' --output text \
  "${AWS_ARGS[@]}")"

step "Installing payload (SSM command $CMD_ID)"
while true; do
  status="$(aws ssm get-command-invocation \
    --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
    --query Status --output text \
    "${AWS_ARGS[@]}" 2>/dev/null || echo Pending)"
  case "$status" in
    Success) break ;;
    Failed|Cancelled|TimedOut)
      echo "Payload install $status:" >&2
      aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
        --query StandardErrorContent --output text \
        "${AWS_ARGS[@]}" >&2
      exit 1 ;;
  esac
  sleep 10
done

# ---------------------------------------------------------------------------
step "Verifying https://$DOMAIN"
# ---------------------------------------------------------------------------
code=none
for _ in $(seq 1 36); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$DOMAIN/healthz" || true)"
  [ "$code" = "200" ] && break
  sleep 10
done

# ---------------------------------------------------------------------------
step "Confirming the deployed app requires a login"
# ---------------------------------------------------------------------------
# The local auth tests prove the code is correct; this proves the thing actually
# serving traffic is. A proxy or listener misconfiguration that exposed the chat
# API would pass every unit test and still be an open shell, which is precisely
# the failure this project already shipped once.
verify_closed() {
  local path="$1" label="$2" status
  status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$DOMAIN$path" || echo 000)"
  case "$status" in
    401|403|302|303) printf '  \033[1;32m✓\033[0m %-28s → %s (closed)\n' "$label" "$status" ;;
    000) printf '  \033[1;33m?\033[0m %-28s → unreachable; check again once DNS settles\n' "$label" ;;
    *)
      printf '  \033[1;31m✗ %s returned %s — THIS ENDPOINT IS OPEN\033[0m\n' "$label" "$status"
      return 1 ;;
  esac
}

AUTH_OK=0
verify_closed /api/projects  "GET /api/projects"  || AUTH_OK=1
verify_closed /api/models    "GET /api/models"    || AUTH_OK=1
# /chat/ and not /: the chat shell moved there so that an installed project icon
# stops colliding with the chat app's scope, and / is now an nginx redirect that
# would answer 302 — "closed" to the case below — whatever the app decided. This
# asks the page that actually holds the shell.
verify_closed /chat/         "GET /chat/"         || AUTH_OK=1
verify_closed /              "GET /"              || AUTH_OK=1

if [ "$AUTH_OK" -ne 0 ]; then
  printf '\n\033[1;31mDEPLOY VERIFICATION FAILED: the chat API answered without a login.\033[0m\n' >&2
  printf 'Claude runs shell commands on this instance, so treat this as an open\n' >&2
  printf 'remote-execution endpoint. Restrict allowedCidrs or stop the instance now:\n' >&2
  printf '  aws ec2 stop-instances --instance-ids %s %s\n\n' "$INSTANCE_ID" "${AWS_ARGS[*]}" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# What this secret *is* depends on the auth mode, and saying the wrong one sends
# you to the wrong login. In password mode it gates both the chat and the editor.
# In oidc mode the chat is gated by the provider and the app-side allowlist, and
# this password is only code-server's own — still real, still asked for, but
# behind the Google login rather than instead of it.
if [ "$CFG_AUTH_MODE" = "oidc" ]; then
  step "Reading the editor's password"
else
  step "Reading the sign-in password"
fi
# ---------------------------------------------------------------------------
# This header earns its place by being the answer to "why does the deploy always
# hang at the login checks". It never did. Those checks are three curls with
# --max-time; they print and finish. What came after them was this call, with no
# header of its own, so a stall here landed under the *previous* step's output and
# read as that step hanging — with the summary, the last thing the script prints,
# never arriving.
#
# Three things made a stall here silent and unbounded, and all three are fixed
# below. `2>/dev/null` threw away the reason. The AWS CLI's default timeouts are
# 60s per attempt with retries on top. And stdin was still the terminal, so a
# profile whose credentials come from something interactive — an SSO device code,
# an MFA prompt, a hardware key — waited forever for an answer nobody could see it
# asking for. That is the shape of a deploy that "gets stuck at the end" on one
# machine and not another: it is the credential helper, not the deploy.
#
# The password is a convenience, not the deploy. If it cannot be read, say why in
# one line, print the command that fetches it, and still print the summary.
PW_ARN="$(read_output PasswordCommand | sed -n 's/.*--secret-id \([^ ]*\).*/\1/p')"
PW_ERR="$(mktemp)"
PW_HINT=""
if ! PW="$(aws secretsmanager get-secret-value --secret-id "$PW_ARN" \
  --query SecretString --output text \
  --cli-connect-timeout 5 --cli-read-timeout 15 \
  "${AWS_ARGS[@]}" 2>"$PW_ERR" </dev/null)"; then
  PW="unread — $(tr -d '\r' < "$PW_ERR" | grep -v '^[[:space:]]*$' | tail -1 | cut -c1-120)"
  PW_HINT="$(read_output PasswordCommand)"
fi
rm -f "$PW_ERR"

printf '\n'
if [ "$code" = "200" ]; then
  printf '\033[1;32m✓ Live at https://%s\033[0m\n' "$DOMAIN"
else
  printf '\033[1;33m! /healthz returned %s — DNS or target registration may still be settling.\033[0m\n' "$code"
fi

SHELL_CMD="aws ssm start-session --target $INSTANCE_ID ${AWS_ARGS[*]}"

cat <<SUMMARY

  URL       https://$DOMAIN
  Password  $PW
  Editor    https://$DOMAIN/editor/
  Shell     $SHELL_CMD
SUMMARY

if [ "$CFG_AUTH_MODE" = "oidc" ]; then
  cat <<SUMMARY

  Sign in with ${CFG_OIDC_ISSUER#https://}. Holding an account there only gets
  you to the door: the addresses in oidc.allowedEmails are what
  chat-service/auth.js actually lets through, for the editor as well as the
  chat. The password above is code-server's own, asked for behind that check
  rather than instead of it.
SUMMARY
else
  cat <<SUMMARY

  Sign in with the password above. It gates the chat; the editor asks for the
  same one separately.
SUMMARY
fi

if [ -n "$PW_HINT" ]; then
  printf '\n  The password could not be read from here. Everything above is deployed;\n'
  printf '  fetch it with:\n\n    %s\n' "$PW_HINT"
fi
