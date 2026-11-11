#!/bin/bash
#
# triplec-browser — a real Google Chrome on this box, for the mux's Browser pane.
#
# Two processes, one unit (triplec-browser.service), so they start, stop and
# restart together:
#
#   Xvnc     TigerVNC's X server, which is a VNC server too: a virtual screen
#            switched to whatever size the viewer asks for (see resizeScreen in
#            chat-service/browser.js), served as RFB on a unix socket (0600, in a
#            0700 runtime directory). No TCP port at all — the chat service is the
#            only way in, and it carries the login check (/ws/browser, behind
#            auth.js like every other socket). The X side is locked with an xauth
#            cookie: an X display is a keyboard and a screen, and without one any
#            account on the box could type into this browser.
#            One process rather than Xvfb plus x11vnc, because it knows exactly
#            what changed on screen instead of copying the screen out and comparing
#            it: measured on this box, full-screen scrolling at 2400x1500 went from
#            5 to 10 frames a second, and small changes from 37 to 60.
#   chrome   the full browser, not the headless shell: tabs, omnibox, extensions,
#            downloads, a profile that persists. Restarted if it exits, because
#            closing its last window is something a person will do. It also listens
#            for DevTools on 127.0.0.1:BROWSER_DEBUG_PORT, which is how a Claude on
#            this box drives the same browser the person is watching.
#
# If Xvnc dies, this exits and systemd restarts the lot.
#
# Settings, all from the unit's environment:
#   BROWSER_RUN_DIR     the socket and the X cookie (the unit's RuntimeDirectory)
#   BROWSER_PROFILE     Chrome's user data directory, kept across restarts
#   BROWSER_DISPLAY     the X display number, e.g. :91
#   BROWSER_DEBUG_PORT  DevTools on loopback, e.g. 9222
#   BROWSER_SIZE        the size it starts at (default 1440x900 times the scale)
#   BROWSER_SCALE       Chrome's device scale factor, a whole number (default 1;
#                       config: browser.scale). 2 is sharp on a high-DPI display
#                       but scrolls at about a third of the rate.
#                       The screen has this many pixels per CSS pixel of the page
#                       showing it, so a high-DPI display gets every pixel it can
#                       show and Chrome's UI stays the size it is on that display.
#                       Must match TRIPLEC_BROWSER_SCALE for the chat service.
#   BROWSER_CHROME      the binary (default: google-chrome, then chromium)
#   BROWSER_ACCOUNT     open the profile signed in as this Google account
#                       (config: browser.account); empty is Chrome's last-used one
set -u

RUN="${BROWSER_RUN_DIR:?BROWSER_RUN_DIR is not set}"
PROFILE="${BROWSER_PROFILE:?BROWSER_PROFILE is not set}"
DISP="${BROWSER_DISPLAY:-:91}"
PORT="${BROWSER_DEBUG_PORT:-9222}"
SCALE="${BROWSER_SCALE:-1}"
case "$SCALE" in 1|2|3) ;; *) echo "triplec-browser: BROWSER_SCALE must be 1, 2 or 3" >&2; exit 1 ;; esac
SIZE="${BROWSER_SIZE:-$((1440 * SCALE))x$((900 * SCALE))}"
CHROME="${BROWSER_CHROME:-}"
if [ -z "$CHROME" ]; then
  for c in google-chrome google-chrome-stable chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1; then CHROME="$(command -v "$c")"; break; fi
  done
fi
[ -n "$CHROME" ] || { echo "triplec-browser: no Chrome or Chromium on PATH" >&2; exit 1; }

umask 077
mkdir -p "$RUN" "$PROFILE"
chmod 0700 "$RUN"
export XAUTHORITY="$RUN/Xauthority"
export DISPLAY="$DISP"
rm -f "$XAUTHORITY" "$RUN/vnc.sock"
: >"$XAUTHORITY"
xauth -q -f "$XAUTHORITY" add "$DISP" . "$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"

# A display left locked by a previous run that died hard: Xvnc refuses to start on it.
num="${DISP#:}"
if [ -e "/tmp/.X${num}-lock" ] && ! kill -0 "$(tr -d ' ' <"/tmp/.X${num}-lock" 2>/dev/null)" 2>/dev/null; then
  rm -f "/tmp/.X${num}-lock" "/tmp/.X11-unix/X${num}"
fi

pids=()
cleanup() {
  trap - EXIT INT TERM
  [ "${#pids[@]}" -gt 0 ] && kill "${pids[@]}" 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT INT TERM

# -rfbport -1: no TCP listener. -SecurityTypes None is for the socket only, which is
# 0600 and this account's. -SendPrimary=0: only an explicit copy reaches the viewer's
# clipboard, not every stretch of text that happens to be selected. -FrameRate 60:
# its default is 60 too, said here so nobody lowers it by accident.
Xvnc "$DISP" -geometry "$SIZE" -depth 24 -auth "$XAUTHORITY" -nolisten tcp \
  -rfbport -1 -rfbunixpath "$RUN/vnc.sock" -rfbunixmode 0600 -SecurityTypes None \
  -AlwaysShared -FrameRate 60 -SendPrimary=0 -desktop "TripleC browser" \
  >>"$RUN/xvnc.log" 2>&1 &
pids+=($!)
for _ in $(seq 1 50); do
  xrandr >/dev/null 2>&1 && break
  sleep 0.1
done
xrandr >/dev/null 2>&1 || { echo "triplec-browser: Xvnc did not come up on $DISP" >&2; exit 1; }
w="${SIZE%x*}"; h="${SIZE#*x}"

# The profile directory signed in as BROWSER_ACCOUNT, from Chrome's own record of its
# profiles. Asked on every start, because the profile is made the first time someone
# signs in, after this has already run — and a name like "Profile 1" is Chrome's to
# choose, so the account is what the config names, never the directory.
profile_for_account() {
  [ -n "${BROWSER_ACCOUNT:-}" ] && [ -f "$PROFILE/Local State" ] || return 0
  python3 -I -c '
import json, sys
try:
    cache = json.load(open(sys.argv[1]))["profile"]["info_cache"]
except Exception:
    sys.exit(0)
want = sys.argv[2].strip().lower()
for directory, info in cache.items():
    if str(info.get("user_name", "")).strip().lower() == want:
        print(directory)
        break
' "$PROFILE/Local State" "$BROWSER_ACCOUNT" 2>/dev/null
}

chrome_loop() {
  while :; do
    cur="$(xrandr 2>/dev/null | sed -n 's/.* current \([0-9]*\) x \([0-9]*\),.*/\1 \2/p')"
    read -r cw ch <<<"${cur:-$w $h}"
    # --window-size is in Chrome's own (scaled) pixels; the screen is in real ones.
    win="$((cw / SCALE)),$((ch / SCALE))"
    dir="$(profile_for_account)"
    profile_args=()
    if [ -n "$dir" ]; then
      profile_args=(--profile-directory="$dir")
    elif [ -n "${BROWSER_ACCOUNT:-}" ]; then
      echo "triplec-browser: no profile is signed in as $BROWSER_ACCOUNT yet; sign in once in the Browser pane" >&2
    fi
    # --remote-debugging-port binds 127.0.0.1 only; a dedicated --user-data-dir is
    # also what Chrome requires before it will accept a debugger at all.
    "$CHROME" --user-data-dir="$PROFILE" \
      --remote-debugging-port="$PORT" \
      --no-first-run --no-default-browser-check \
      --password-store=basic \
      "${profile_args[@]}" \
      --force-device-scale-factor="$SCALE" \
      --window-position=0,0 --window-size="$win" \
      --disable-features=TranslateUI \
      >>"$RUN/chrome.log" 2>&1
    sleep 1
  done
}
chrome_loop &
pids+=($!)

# Whichever ends first. Chrome's loop never does; Xvnc ending means the screen is
# gone, and the unit's Restart= brings everything back together.
wait -n
echo "triplec-browser: Xvnc exited; restarting" >&2
exit 1
