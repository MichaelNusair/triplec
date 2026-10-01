/**
 * Service worker: notifications, and deliberately nothing else.
 *
 * There is no `fetch` handler here, and that absence is the most important line in
 * the file. A registered worker controls navigations until it is replaced, so a
 * worker that mishandles a request can wedge the app in a way the app cannot fix:
 * the page never finishes loading, so the code that would update the worker never
 * runs either, and the only escape is clearing site data by hand. That happened
 * once, which is why the previous version of this file existed only to unregister
 * itself. Caching still buys this app nothing — it is a live WebSocket client — so
 * nothing here touches the network on the app's behalf.
 *
 * What it is for: a browser will only deliver a push message to a service worker,
 * and only if the worker shows a notification for it. So this is the smallest
 * worker that can receive `{title, body, tag}` from turn-watcher.js and put it on
 * the lock screen.
 *
 * /chat/reset.html remains the escape hatch: it unregisters whatever is registered
 * and clears storage, for a phone that ends up in a state nobody predicted.
 */
const ICON = '/chat/pwa-icons/icon-192.png';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Left behind by the caching worker that predates all of this. A phone that
      // skipped the self-uninstalling version still has them.
      const names = await caches.keys();
      await Promise.all(names.map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

/**
 * A turn ended somewhere nobody is looking.
 *
 * The payload is the JSON that turn-watcher.js built, decrypted by the browser
 * before it gets here. `showNotification` is not optional: a `userVisibleOnly`
 * subscription that receives a push and shows nothing gets one warning and then has
 * its subscription revoked, so every path out of here shows *something*.
 */
self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let data = {};
      try {
        data = event.data ? event.data.json() : {};
      } catch {
        // Not ours, or truncated. Show what there is rather than nothing at all.
        data = { body: (() => { try { return event.data.text(); } catch { return ''; } })() };
      }

      const tag = data.tag || 'cw-turn';
      const options = {
        body: data.body || '',
        icon: ICON,
        // One notification per conversation. `renotify` is what makes a *new*
        // answer buzz rather than silently replacing the previous one in place.
        tag,
        renotify: true,
        /*
         * Buzz. A notification whose channel has been quietened by Android is shown
         * silently at the bottom of the shade, which is indistinguishable from never
         * arriving if the phone is in a pocket — and that is the state this was in
         * while every side of the delivery reported success. The pattern is a request,
         * not a guarantee: the platform still decides, and ignores it when the site's
         * channel importance is low or Do Not Disturb is on.
         */
        vibrate: [180, 90, 180],
        // When the turn actually ended, not when the phone happened to wake up: a
        // notification delivered late otherwise claims to be current.
        timestamp: Date.parse(data.at || '') || Date.now(),
        data: {
          project: data.project || null,
          sessionId: data.sessionId || null,
          at: data.at || null,
          // Where tapping it goes. Built by the server, which is the only side that
          // knows where a project lives on disk — see projectStartUrl in
          // chat-service/manifest.js and the payload in turn-watcher.js.
          url: typeof data.url === 'string' ? data.url : null,
        },
      };

      /*
       * A notification that is refused rather than shown, which is the most
       * consequential thing that can happen in this file.
       *
       * Android can refuse to display for reasons that live entirely outside the
       * browser — notifications turned off for Chrome as an app, or its "Sites"
       * channel disabled — and the browser's answer to a `userVisibleOnly` push that
       * showed nothing is to revoke the subscription. The phone then mints a new one,
       * receives one more push, is refused again, and is revoked again: a device that
       * looks freshly subscribed whenever anyone checks and has never displayed
       * anything. There is nothing to retry, so this is caught only so that the
       * receipt below can say which of the two happened.
       */
      let refused = null;
      try {
        await self.registration.showNotification(data.title || 'Claude Code', options);
      } catch (err) {
        refused = err;
      }

      /*
       * What the browser believes is on screen, which is the last fact available from
       * inside the phone.
       *
       * `showNotification` resolving only means Chrome accepted the call. Android can
       * then decline to surface anything — notifications turned off for the installed
       * app rather than for the browser, a channel demoted to silent, Do Not Disturb —
       * and nothing reports that back here. So the count is sent too: a notification
       * the browser is still holding is one the phone has and is not showing you, which
       * is a different problem from one that never arrived, and they had until now
       * produced exactly the same evidence.
       */
      let held = null;
      try {
        held = (await self.registration.getNotifications({ tag })).length;
      } catch {
        /* Old browser, or a worker with no permission to look. Not worth failing for. */
      }

      /*
       * Which subscription this arrived on, so the receipt can be matched to a device.
       *
       * The server has a page waiting for this answer — the switch that has just sent a
       * test asks for the receipt by endpoint — and `credentials: 'include'` is not
       * enough to say which device a receipt is about: one login has several, and the
       * user agent string does not distinguish two phones. Best-effort, because a
       * receipt is worth sending even when this cannot be read.
       */
      let endpoint = null;
      try {
        endpoint = (await self.registration.pushManager.getSubscription())?.endpoint || null;
      } catch {
        /* Then the journal still gets the line; only the waiting page loses out. */
      }

      /*
       * Tell the server it arrived.
       *
       * Without this the server's knowledge stops at the push service: FCM answers
       * 201 and everything after that — whether Chrome woke this worker at all,
       * whether Android then chose to show anything — happens where no log on the box
       * can see it. So "it said it sent one and nothing appeared" was unanswerable,
       * and this line is the answer: a receipt saying `shown` means Android is holding
       * a notification it was given, a receipt saying otherwise names the refusal, and
       * no receipt at all means the message never reached this worker.
       *
       * After the notification, and never in front of it: the notification is the
       * point and a failing network must not cost one. Chrome also revokes a
       * subscription that receives a push and shows nothing, so nothing may be
       * allowed to throw before it.
       */
      try {
        await fetch('/api/push/received', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tag,
            endpoint,
            shown: !refused,
            held,
            error: refused ? String(refused.message || refused).slice(0, 200) : undefined,
          }),
        });
      } catch {
        /* A receipt is diagnostics. Losing one costs nothing that matters here. */
      }
    })(),
  );
});

/**
 * Tapping it goes to the project it is about.
 *
 * This used to close the notification and stop, on the argument that there is no URL
 * for a conversation inside code-server's Claude panel. Half of that is still true —
 * the panel cannot be told which conversation to show, because it is a proprietary
 * webview with no such address — but the conclusion was wrong: a tap that does
 * nothing at all reads as a broken notification, and the reported symptom was exactly
 * that ("clicking does nothing, just dismisses it"), on Android and on the desktop.
 *
 * So it opens the project's own window — `/p/<project>/?folder=…`, the installable
 * app per project from chat-service/manifest.js — and hands the session id to the
 * overlay in it, which *can* say which conversation this was about: it pins that
 * conversation and opens its status sheet, with the message, the opening prompt and
 * Read aloud. Deliberately not the chat app: notifications only ever fire for
 * sessions this app is not driving (see turn-watcher.js), and opening one of those in
 * the chat app would start a second `claude --resume` against the same transcript —
 * the thing claude-broker exists to prevent.
 *
 * An existing window for that project is focused rather than replaced. A phone gives
 * an installed web app one window, so "open" would mean navigating the workbench that
 * is already there — throwing away a loaded editor to arrive where it already was.
 * The session id therefore travels by postMessage as well as in the URL, because the
 * URL of a window that already exists cannot be changed without reloading it.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(openFor(event.notification.data || {}));
});

/**
 * Where a notification points, as a path on this origin.
 *
 * `/chat/` is the fallback, and it covers two real cases rather than being defensive
 * for its own sake: the test notification from the switch, which is about no
 * conversation at all, and a notification for a transcript whose directory is not a
 * project (someone's home directory, a checkout elsewhere) — that has no project
 * window to open. Anything that is not a path on this origin is treated as absent:
 * this value arrives over the network, and `//elsewhere/` is a URL to somebody else's
 * site that reads like a path.
 */
function destination(data) {
  const url = typeof data.url === 'string' ? data.url : '';
  return url.startsWith('/') && !url.startsWith('//') ? url : '/chat/';
}

/** Is this window already the app the notification is pointing at? */
function inSameApp(clientUrl, target) {
  try {
    const here = new URL(clientUrl);
    // Path prefix, not equality: the workbench navigates inside /p/<project>/ as it
    // loads, and the query carries `?folder=` in one and not the other.
    return here.origin === target.origin && here.pathname.startsWith(target.pathname);
  } catch {
    return false;
  }
}

async function openFor(data) {
  const url = destination(data);
  const target = new URL(url, self.location.origin);
  let windows = [];
  try {
    // `includeUncontrolled`, because every window this can reach is one: this worker
    // is scoped to /chat/ and has no `fetch` handler, so it controls nothing — and the
    // window worth focusing is an editor at /p/<project>/, outside that scope.
    windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  } catch {
    /* Answer as though there were none, which opens one. */
  }

  const existing = windows.find((client) => inSameApp(client.url, target));
  if (existing) {
    try {
      // focus() answers with the client on Chrome and undefined on some others; the
      // one we already hold is as good for postMessage either way.
      const focused = (await existing.focus?.()) || existing;
      focused.postMessage?.({
        type: 'cw-notification-click',
        project: data.project || null,
        sessionId: data.sessionId || null,
        at: data.at || null,
        url,
      });
      return;
    } catch {
      // A window that cannot be focused (it is closing, another app owns the
      // foreground) must not swallow the tap.
    }
  }

  try {
    await self.clients.openWindow(url);
  } catch {
    /* Nothing further to try: the tap is spent and the notification is closed. */
  }
}

/**
 * The browser rotated the subscription.
 *
 * Chrome does this on its own — a push service key rotation, a long silence — and
 * the old endpoint stops working. Without this the phone simply goes quiet, with
 * nothing wrong anywhere and nothing in any log, so the worker re-subscribes and
 * tells the server itself rather than waiting for someone to open the app.
 */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      try {
        let subscription = event.newSubscription;
        if (!subscription) {
          const res = await fetch('/api/push/key', { credentials: 'include' });
          if (!res.ok) return;
          const { key } = await res.json();
          subscription = await self.registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: keyBytes(key),
          });
        }
        await fetch('/api/push/subscribe', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(subscription),
        });
      } catch {
        /* Nothing useful to do out here. The app re-subscribes on its next load. */
      }
    })(),
  );
});

/** base64url → bytes, which is the only form `applicationServerKey` accepts. */
function keyBytes(base64url) {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
