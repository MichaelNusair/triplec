#!/bin/bash
#
# Build an AWS deployment's application payload: the tarball that
# scripts/install-payload.sh installs into /opt/claude-web on the instance.
#
#   scripts/build-payload.sh [OUT]      default OUT: dist/payload.tar.gz
#
# Run from a checkout with a triplec.config.json (or the environment) that
# infra/config.js accepts. Two callers: deploy.sh, before it ships the tarball over
# S3 and SSM, and the on-box updater (scripts/triplec-update.mjs), which builds the
# next commit on the box itself with the config the last payload carried.
#
# Builds what is in this working tree, tests not included: both callers run the
# suite themselves before getting here.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
OUT="${1:-dist/payload.tar.gz}"
case "$OUT" in /*) ;; *) OUT="$ROOT/$OUT" ;; esac

eval "$(node infra/print-config.js)"

echo "  packaging the editor extensions"
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
# The root half of an install (run by deploy.sh over SSM and by the on-box updater)
# and the updater itself with the settings module it shares with the configs. See
# docs/UPDATES.md.
cp scripts/install-payload.sh scripts/triplec-update.mjs scripts/auto-update-config.mjs dist/stage/scripts/
# The box page's settings (scripts/box-config.mjs), and the config's own validation
# to check them with: infra/config.js, which imports only node and the two modules
# beside it in scripts/. Nothing else of infra/ ships.
cp scripts/box-config.mjs dist/stage/scripts/
mkdir -p dist/stage/infra && cp infra/config.js dist/stage/infra/
# This deployment's configuration, resolved, for the updater on the box: it builds
# the next payload there with this script, which needs the same config this run
# had. Nothing in it is a secret (secrets are ARNs; their values stay in Secrets
# Manager), and the box it describes is the one place it is going.
mkdir -p dist/stage/deployment
node infra/print-config.js --json > dist/stage/deployment/config.json
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
COPYFILE_DISABLE=1 tar -czf "$OUT" -C dist/stage \
  chat-service pwa vsix scripts claude-broker userdata deployment infra
