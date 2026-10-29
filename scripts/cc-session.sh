#!/bin/bash
#
# cc — open, or rejoin, a permanent Claude Code session for a project.
#
# Why this exists: the VS Code extension's Claude process is a child of the
# extension host, and code-server tears that down within seconds of the last
# browser WebSocket closing. Measured on this box: extension host and `claude`
# both dead 5 seconds after the tab closed, mid-turn, with the work lost.
#
# tmux moves the process into a server that is detached from every terminal, so:
#   * closing the editor, the browser, or the laptop lid changes nothing
#   * attaching from a second device joins the SAME live session — same screen,
#     same scrollback, both cursors — rather than starting a second Claude
#   * the session outlives code-server restarts and redeploys
#
# It runs the real CLI, so model switching (/model), permission modes, @file
# references, thinking and tool output are all the genuine Claude Code UX rather
# than a reimplementation of it.
#
# This is no longer only a power-user command: the editor surface opens Claude
# through it (see mobile-extension/extension.js), because the extension's own
# webview cannot survive a page reload — a reload builds a new extension host,
# and the panel's `claude` is a child of the old one. So the options set below
# are tuned for a phone attached to a long-lived session, not just for an ssm
# shell.
set -euo pipefail

PROJECTS="${PROJECTS_ROOT:-/workspace/projects}"
name="${1:-}"

if [ -z "$name" ]; then
  printf '\033[1mLive Claude sessions\033[0m\n'
  if tmux ls 2>/dev/null | grep -q '^claude-'; then
    tmux ls 2>/dev/null | grep '^claude-' | sed 's/^claude-/  /'
  else
    printf '  (none running)\n'
  fi
  printf '\n\033[1mProjects\033[0m\n'
  ls -1 "$PROJECTS" 2>/dev/null | sed 's/^/  /'
  printf '\nUsage: cc <project>              # start or rejoin\n'
  printf '       cc <project>/slot-3       # the same, in one of its worktree slots\n'
  printf '       cc <project> --kill        # end the session for good\n'
  exit 0
fi

# An absolute path is accepted as well as a project name, because the editor
# surface calls this with the workspace folder it already has. Resolving it here
# rather than teaching the extension where PROJECTS_ROOT is keeps that knowledge
# in one place — this script — and means the two cannot disagree about it.
#
# A worktree — one of the mux's slots, `<project>/.claude/worktrees/slot-3` — is
# named `<project>/slot-3`, whether it arrives as that or as its path. The basename
# alone would be `slot-3`, which every project has: two projects' slot 3 would share
# one tmux session, and opening one would join the other's Claude. The mux's terminal
# panes run exactly this script, so `cc demo/slot-3` from any terminal — a phone's
# included — is the same session as the pane.
if [ "${name#/}" != "$name" ]; then
  dir="$name"
  case "$dir" in
    */.claude/worktrees/*)
      rest="${dir#*/.claude/worktrees/}"
      name="$(basename "${dir%%/.claude/worktrees/*}")/${rest%%/*}"
      ;;
    *) name="$(basename "$dir")" ;;
  esac
elif [ "${name#*/}" != "$name" ]; then
  project="${name%%/*}"
  worktree="${name#*/}"
  case "$project/$worktree" in
    */*/*|.*|*/.*|/*|*/) printf 'Not a project/worktree name: %s\n' "$name" >&2; exit 1 ;;
  esac
  dir="$PROJECTS/$project/.claude/worktrees/$worktree"
else
  dir="$PROJECTS/$name"
fi

# A project registry (a host install whose repositories were there first) names
# projects that are not directories under $PROJECTS. Asked only when the
# name did not resolve the ordinary way, so the workspace box never reads it.
if [ ! -d "$dir" ] && [ -n "${TRIPLEC_PROJECTS_FILE:-}" ] && [ -r "$TRIPLEC_PROJECTS_FILE" ]; then
  project="${name%%/*}"
  registered="$(python3 -I -c 'import json,sys
for p in json.load(open(sys.argv[1])):
    if p.get("name") == sys.argv[2]:
        print(p["path"])' "$TRIPLEC_PROJECTS_FILE" "$project" 2>/dev/null || true)"
  if [ -n "$registered" ]; then
    if [ "$project" = "$name" ]; then dir="$registered"; else dir="$registered/.claude/worktrees/${name#*/}"; fi
  fi
fi

# The caller already knows the session's name — the chat service's terminal panes,
# which hand over a registered project's directory and need the session called what
# the project is called, not what its directory is called.
if [ -n "${CC_SESSION_NAME:-}" ]; then
  case "$CC_SESSION_NAME" in
    */*/*|.*|*/.*|/*|*/|*[!A-Za-z0-9._/-]*) printf 'Not a session name: %s\n' "$CC_SESSION_NAME" >&2; exit 1 ;;
  esac
  name="$CC_SESSION_NAME"
fi

if [ ! -d "$dir" ]; then
  printf 'No such project or slot: %s\n\nAvailable:\n' "$name" >&2
  ls -1 "$PROJECTS" 2>/dev/null | sed 's/^/  /' >&2
  exit 1
fi

session="claude-$name"

# Every target below is exact: `=name` for a session, `=name:` where tmux wants a
# window. A bare `-t claude-api` is a *prefix* match when no session has exactly that
# name, so `cc api` with nothing running used to rejoin `claude-api-v2` — and with
# slots, `cc demo` would walk into `claude-demo/slot-3`, another agent's terminal,
# and report it as "Rejoining" yours. Verified against tmux 3.6a.
if [ "${2:-}" = "--kill" ]; then
  tmux kill-session -t "=$session" 2>/dev/null && echo "Ended $name." || echo "No session for $name."
  exit 0
fi

if tmux has-session -t "=$session" 2>/dev/null; then
  printf '\033[1;32mRejoining\033[0m live session for %s — it never stopped.\n' "$name"
else
  printf '\033[1;36mStarting\033[0m a permanent session for %s.\n' "$name"
  # `bash -lc` so the session picks up /etc/profile.d: Bedrock config, region,
  # default model, and the GitHub token resolver. Without a login shell the CLI
  # starts without Bedrock credentials and fails on the first message.
  tmux new-session -d -s "$session" -c "$dir" 'bash -lc claude'
  # Don't let a crashed CLI silently leave an empty shell that looks alive.
  tmux set-option -t "=$session:" remain-on-exit off >/dev/null 2>&1 || true
  # Size the window to the client that used it last, not to the smallest one
  # attached. This is tmux's default from 2.9 on, and is set explicitly anyway
  # because it is load-bearing here and a ~/.tmux.conf can turn it off: with
  # `smallest`, a phone left attached in a pocket permanently shrinks the laptop
  # that just took over, which looks exactly like the handoff being broken.
  tmux set-option -t "=$session:" window-size latest >/dev/null 2>&1 || true
fi

# Being detached from the terminal is not by itself enough to survive a deploy.
# tmux sessions are forked by the tmux server, so they inherit its cgroup, and a
# server first started from an editor terminal sits inside code-server.service —
# which is KillMode=control-group, so `systemctl restart code-server` takes the
# sessions with it. Observed 2026-09-17, mid-deploy, on a running task. The fix is
# claude-tmux.service owning the server (see infra/userdata/bootstrap.sh); all
# this can do is say so, because an unprivileged `cc` cannot move a process
# between cgroups. A warning rather than a refusal: the session works, it is only
# fragile, and refusing to open Claude would be the worse outcome.
server_pid="$(tmux display-message -p '#{pid}' 2>/dev/null || true)"
if [ -n "$server_pid" ] && [ -r "/proc/$server_pid/cgroup" ] &&
  ! grep -qE 'claude-tmux|triplec-tmux' "/proc/$server_pid/cgroup"; then
  printf '\033[1;33mNote:\033[0m this tmux server is not claude-tmux.service, so a deploy or a\n' >&2
  printf '      code-server restart will end this session. Check: systemctl status claude-tmux\n' >&2
fi

# Deliberately no `-d`: that would detach other clients. Allowing several means
# a phone and a laptop can watch the same run at once, which is the point — and
# `window-size latest` above is what keeps the one you are typing on from being
# squeezed by the one you are not.
exec tmux attach-session -t "=$session"
