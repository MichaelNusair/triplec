# Updates

TripleC has no releases. `main` is the release, and a deployment updates when
its owner decides to. This page covers the two ways to update: by hand, with one
command, or automatically, if a deployment turns that on. Both run the same safety
checks.

Automatic updates are **off** unless you turn them on.

## Update by hand

On the box:

```bash
sudo triplec-update run --now                                  # an AWS deployment
~/.local/share/triplec/bin/triplec-update run --now            # a host install
```

This fetches the branch, runs the test suite, installs the update, checks it, and
rolls back if anything fails (see [What an update does](#what-an-update-does)). It
works in every mode, `"off"` included. `--now` means "a person is asking", so it
skips the waiting described below and never skips a check.

Two more commands, neither of which changes anything:

```bash
triplec-update check     # fetch, and say what an update would do right now
triplec-update status    # the settings, what is installed, and the last run
```

The routes you had before still work. On a host install that is
`deploy/host/upgrade.sh` from your checkout. On AWS it is `./deploy.sh` from a
machine with AWS credentials, which is also the only route for a change to the
stack itself.

## Automatic updates

Set `autoUpdate` in your deployment's config: `triplec.config.json` for AWS,
`~/.config/triplec/config.json` for a host install. Every key is optional.

```json
"autoUpdate": {
  "mode": "install",
  "soakHours": 24,
  "window": "02-06",
  "idleMinutes": 30
}
```

| Key | Default | Meaning |
|---|---|---|
| `mode` | `"off"` | `"off"`: nothing runs. `"notify"`: push a notification when an update is ready, and never install. `"install"`: install it. |
| `repo` | upstream | The repository to follow. Leave it empty for `github.com/MichaelNusair/triplec`; a fork sets its own. |
| `branch` | `"main"` | The branch to follow. |
| `soakHours` | `24` | How long a commit must have been on the branch before it is taken. `0` takes the tip. |
| `window` | `""` | When an install may happen: `""` for any time, or `"HH-HH"` in the box's local time (UTC on AWS). `"02-06"` is 02:00 to 05:59, and `"22-04"` wraps past midnight. |
| `idleMinutes` | `30` | Install only after this many minutes in which no Claude conversation has written to its transcript. `0` doesn't wait. |
| `push` | `true` | Send push notifications when an update is installed, ready, held or failed. |

Then apply the config the usual way. That is `./deploy.sh --app-only` on AWS,
because the setting travels in the payload and not in the stack. On a host
install it is `deploy/host/install.sh`, which writes the timer when `mode` isn't
`"off"` and removes it when `mode` is.

A timer runs the check every hour, `triplec-update.timer`. On AWS it is installed
on every box and exits straight away while `mode` is `"off"`; on a host install it
exists only while `mode` is on. Its output is in
`journalctl -u triplec-update`, and the full log of the last update is in
`last-run.log` under the state directory: `/workspace/triplec-update` on AWS,
`~/.local/state/triplec/update` on a host install.

## What an update does

Each step guards against something specific:

1. **Soak.** A commit is taken only once it has been on the branch `soakHours`.
   This is counted from when *this box* first saw it there, because a commit's own
   date says when it was written, not when it was pushed. If a commit is reverted
   within the window, your deployment never gets it.
2. **Fast-forward only.** The update must be a descendant of the installed commit.
   It never downgrades, never installs a commit that is off the branch, and never
   installs over a build with uncommitted changes (one deployed from a dirty
   tree). In that case it waits until a clean commit has been installed by hand.
3. **Hold what can't be applied here.** On AWS, an update that changes the stack
   (anything under `infra/` other than `infra/userdata/`) is held, because an
   instance can't redeploy the stack it runs in. You get one notification saying
   so. Run `./deploy.sh` from a machine with AWS credentials, and updates resume
   from that commit.
4. **Wait for quiet.** An install restarts the chat service and the editor, which
   ends any turn in progress. So it waits until it is inside `window` and no
   conversation has been active for `idleMinutes`.
5. **Test.** `npm ci` and the full `npm test` run in the updater's own clone. If
   the tests fail, nothing is installed.
6. **Install.** On AWS this builds the payload on the box
   (`scripts/build-payload.sh`) and installs it with `scripts/install-payload.sh`,
   the same script `deploy.sh` runs over SSM. On a host install it runs
   `deploy/host/install.sh` from the updater's clone, so the box needs `sudo`
   without a password. Without that, the update is held with a message saying so.
7. **Verify.** `/healthz` must answer. The API must refuse a request that has no
   login (`/api/projects` and `/api/models` must not answer 200). The build the
   service reports must be the commit that was just installed.
8. **Roll back.** If the install or the verification fails, the commit that was
   running before is built and installed again the same way, and checked the same
   way. The failed commit is not retried automatically; the next newer one is.
   `run --now` retries it.

The updater never touches your own checkout. It works in a clone of its own
under the state directory, so local commits and uncommitted work in your checkout
are never affected.

## Trust

Automatic updates mean running new code from `repo` without a person reading it
first. On a TripleC box that code can run shell commands as you, and on AWS as
root. So turning on `"install"` means trusting whoever can push to that branch,
and anyone who takes over their account, with your box, up to a day after they
push (or right away with `soakHours: 0`).

That is the same trust you give `deploy/host/upgrade.sh` or `git pull && ./deploy.sh`
when you run them without reading the diff. The difference is that nobody is
watching when it happens. If that is too much, use `"notify"`: you get a
notification, read the commits, and run `triplec-update run --now` yourself.
