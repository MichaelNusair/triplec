#!/bin/bash
#
# triplec-browser — a real Google Chrome on this box, for the mux's Browser pane.
#
# Three processes, one unit (triplec-browser.service), so they start, stop and
# restart together:
#
#   Xvfb     a virtual screen, sized up to BROWSER_MAX and switched to whatever size
#            the viewer asks for (see resizeScreen in chat-service/browser.js).
#            Locked with an xauth cookie: an X display is a keyboard and a screen,
#            and without one any account on the box could type into this browser.
#   x11vnc   that screen, as RFB, on a unix socket in a 0700 runtime directory. No
#            TCP port at all — the chat service is the only way in, and it carries
#            the login check (/ws/browser, behind auth.js like every other socket).
#   chrome   the full browser, not the headless shell: tabs, omnibox, extensions,
#            downloads, a profile that persists. Restarted if it exits, because
#            closing its last window is something a person will do. It also listens
#            for DevTools on 127.0.0.1:BROWSER_DEBUG_PORT, which is how a Claude on
#            this box drives the same browser the person is watching.
#
# If Xvfb or x11vnc dies, this exits and systemd restarts the lot.
#
# Settings, all from the unit's environment:
#   BROWSER_RUN_DIR     the socket and the X cookie (the unit's RuntimeDirectory)
#   BROWSER_PROFILE     Chrome's user data directory, kept across restarts
#   BROWSER_DISPLAY     the X display number, e.g. :91
#   BROWSER_DEBUG_PORT  DevTools on loopback, e.g. 9222
#   BROWSER_MAX         the largest the screen can become, e.g. 2560x1600
#   BROWSER_SIZE        the size it starts at, e.g. 1440x900
#   BROWSER_CHROME      the binary (default: google-chrome, then chromium)
set -u

RUN="${BROWSER_RUN_DIR:?BROWSER_RUN_DIR is not set}"
PROFILE="${BROWSER_PROFILE:?BROWSER_PROFILE is not set}"
DISP="${BROWSER_DISPLAY:-:91}"
PORT="${BROWSER_DEBUG_PORT:-9222}"
MAX="${BROWSER_MAX:-2560x1600}"
SIZE="${BROWSER_SIZE:-1440x900}"
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

# A display left locked by a previous run that died hard: Xvfb refuses to start on it.
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

Xvfb "$DISP" -screen 0 "${MAX}x24" -auth "$XAUTHORITY" -nolisten tcp -noreset &
pids+=($!)
for _ in $(seq 1 50); do
  xrandr >/dev/null 2>&1 && break
  sleep 0.1
done
xrandr >/dev/null 2>&1 || { echo "triplec-browser: Xvfb did not come up on $DISP" >&2; exit 1; }

# Start at BROWSER_SIZE rather than the maximum: the same steps the chat service
# takes on every resize — a mode of exactly that size, then the output switched to it.
w="${SIZE%x*}"; h="${SIZE#*x}"
xrandr --newmode "$SIZE" 0 "$w" 0 0 0 "$h" 0 0 0 2>/dev/null
xrandr --addmode screen "$SIZE" 2>/dev/null
xrandr --output screen --mode "$SIZE" 2>/dev/null

# -xrandr resize: follow the screen when it changes size, and tell the viewer, so the
# page never shows a stale frame of the wrong shape. -noxdamage because Xvfb's
# damage reports are unreliable and x11vnc's own polling is cheap at this size.
x11vnc -display "$DISP" -auth "$XAUTHORITY" -unixsock "$RUN/vnc.sock" -rfbport 0 \
  -forever -shared -nopw -xrandr resize -noxdamage -quiet -noipv6 \
  -o "$RUN/x11vnc.log" &
pids+=($!)

chrome_loop() {
  while :; do
    cur="$(xrandr 2>/dev/null | sed -n 's/.* current \([0-9]*\) x \([0-9]*\),.*/\1,\2/p')"
    # --remote-debugging-port binds 127.0.0.1 only; a dedicated --user-data-dir is
    # also what Chrome requires before it will accept a debugger at all.
    "$CHROME" --user-data-dir="$PROFILE" \
      --remote-debugging-port="$PORT" \
      --no-first-run --no-default-browser-check \
      --password-store=basic \
      --window-position=0,0 --window-size="${cur:-${w},${h}}" \
      --disable-features=TranslateUI \
      >>"$RUN/chrome.log" 2>&1
    sleep 1
  done
}
chrome_loop &
pids+=($!)

# Whichever of the three ends first. Chrome's loop never does; the other two mean the
# screen is gone, and the unit's Restart= brings everything back together.
wait -n
echo "triplec-browser: Xvfb or x11vnc exited; restarting" >&2
exit 1
