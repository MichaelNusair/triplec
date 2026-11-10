/**
 * What tapping a notification does, which nothing else can check.
 *
 * pwa/sw.js runs in a service worker, and a service worker is the least observable
 * place this repository puts code: it has no DOM, no console anyone reads, and it is
 * woken by the operating system rather than by a page. A mistake in `notificationclick`
 * therefore has exactly one symptom — a notification that does nothing when tapped —
 * which is indistinguishable from the deliberate do-nothing this file's subject used to
 * be, and from a phone that simply delivered the tap somewhere else. That was the
 * reported bug, and it went unnoticed for as long as it did because no test loaded this
 * file at all.
 *
 * So the worker is loaded here with `self` stubbed — the only dependency it has — and
 * its two handlers are driven with the events a browser would hand them. What is
 * asserted is the part that cannot be seen from a phone: which window gets focused,
 * which URL gets opened when there is none, that the session id reaches the window
 * either way, and that a payload arriving from the network cannot send the tap to
 * another origin.
 *
 * Run: node chat-service/sw-test.js
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const workerJs = readFileSync(join(here, '..', 'pwa', 'sw.js'), 'utf8');

const failures = [];
let checks = 0;
const ok = (msg, cond) => {
  checks += 1;
  if (!cond) failures.push(msg);
};

const ORIGIN = 'https://claude.example.com';

/**
 * Boot the worker against a fake `self`, and hand back both the handlers it
 * registered and a log of everything it did through them.
 *
 * `new Function` rather than an import: this file is a classic script that expects
 * `self` in scope and exports nothing, which is what a service worker is. Running it
 * with `self` as a parameter is the closest thing to the environment it really has —
 * and it means a syntax error or a reference to something a worker does not have
 * fails here rather than on a phone.
 */
function boot({ windows = [], receiptFails = false, showRefused = null, onScreen = [{ tag: 'x' }], opens = null, cacheNames = [] } = {}) {
  const log = {
    shown: [],      // registration.showNotification(...)
    opened: [],     // clients.openWindow(...)
    focused: [],    // client.focus()
    posted: [],     // client.postMessage(...)
    fetched: [],    // fetch(...)
    order: [],      // what happened, in the order it happened
    closed: 0,      // notification.close()
    pending: [],    // whatever was handed to event.waitUntil
  };
  const listeners = new Map();

  const self = {
    location: new URL(`${ORIGIN}/chat/sw.js`),
    addEventListener: (type, fn) => listeners.set(type, fn),
    skipWaiting: () => {},
    registration: {
      showNotification: (title, options) => {
        log.order.push('show');
        // A platform that refuses to display. Android does this for reasons outside the
        // browser — notifications off for the browser as an app, its "Sites" channel
        // disabled — and it is the case that cost this app a phone for a day.
        if (showRefused) return Promise.reject(new Error(showRefused));
        log.shown.push({ title, ...options });
        return Promise.resolve();
      },
      // What the browser says is on screen. A platform that accepted the call and
      // surfaced nothing is the case this exists to tell apart, so it is settable.
      getNotifications: () => Promise.resolve(onScreen),
      pushManager: { subscribe: () => Promise.reject(new Error('not exercised here')) },
    },
    clients: {
      claim: () => Promise.resolve(),
      matchAll: () => Promise.resolve(windows),
      openWindow: (url) => {
        log.opened.push(String(url));
        return Promise.resolve(null);
      },
    },
  };

  /*
   * The one store the worker reads: this device's choice of where a tap lands, which
   * the mux and the overlay write with `caches.open('triplec-prefs').put(...)`. `opens`
   * null is a device that never chose.
   */
  log.deleted = [];
  const caches = {
    keys: () => Promise.resolve(cacheNames),
    delete: (name) => {
      log.deleted.push(name);
      return Promise.resolve(true);
    },
    open: (name) => Promise.resolve({
      match: (key) => Promise.resolve(
        name === 'triplec-prefs' && key === '/chat/prefs/notification-opens' && opens !== null
          ? { text: () => Promise.resolve(opens) }
          : undefined,
      ),
    }),
  };
  /*
   * The worker is allowed exactly one request: the receipt that says a notification was
   * actually shown. Everything else is still a failure — a worker that fetches on the
   * app's behalf is what wedged this app once, and why it has no `fetch` handler.
   *
   * `receiptFails` is the normal case rather than an edge one: the phone that is woken
   * by a push is frequently the phone with no usable network, and the notification must
   * not be lost to a failed piece of diagnostics.
   */
  const fetchStub = (url, options = {}) => {
    log.fetched.push({ url: String(url), options });
    log.order.push('receipt');
    if (!String(url).includes('/api/push/received')) {
      return Promise.reject(new Error('the worker fetched something unasked'));
    }
    return receiptFails ? Promise.reject(new Error('offline')) : Promise.resolve({ ok: true });
  };

  // eslint-disable-next-line no-new-func
  new Function('self', 'caches', 'atob', 'fetch', workerJs)(
    self,
    caches,
    (text) => Buffer.from(String(text), 'base64').toString('binary'),
    fetchStub,
  );

  return { listeners, log };
}

/** A window the browser would hand back from clients.matchAll. */
function fakeWindow(url, log, { focusable = true } = {}) {
  const client = {
    url,
    focus: () => {
      if (!focusable) return Promise.reject(new Error('cannot focus'));
      log.focused.push(url);
      return Promise.resolve(client);
    },
    postMessage: (message) => log.posted.push(message),
  };
  return client;
}

/** Tap a notification whose `data` is what the push handler would have stored. */
async function tap(data, { windows = [], opens = null } = {}) {
  // The array is handed to the worker before it is filled, and `matchAll` closes over
  // it — which is how the windows can be built against the log of the same boot they
  // will be reported by.
  const clients = [];
  const { listeners, log } = boot({ windows: clients, opens });
  for (const url of windows) clients.push(fakeWindow(url, log));

  const handler = listeners.get('notificationclick');
  if (!handler) {
    failures.push('the worker registered no notificationclick handler at all');
    return log;
  }
  const waits = [];
  handler({
    notification: { data, close: () => { log.closed += 1; } },
    waitUntil: (promise) => waits.push(promise),
  });
  await Promise.all(waits);
  return log;
}

// --------------------------------------------------------------- the payload
/*
 * The URL has to survive the push handler, because that is where it is read out of
 * the encrypted payload and put somewhere the click handler can still find it minutes
 * or hours later. A notification sits on a lock screen long after the push that made
 * it, and `notification.data` is the only thing that persists with it.
 */
{
  const { listeners, log } = boot();
  const push = listeners.get('push');
  ok('the worker registered no push handler', Boolean(push));
  const waits = [];
  const payload = {
    title: 'Claude finished · demo',
    body: 'Done.',
    tag: 'turn-abc',
    project: 'demo',
    sessionId: 'S1',
    at: '2026-09-21T08:00:00.000Z',
    url: '/p/demo/?folder=%2Fworkspace%2Fprojects%2Fdemo&session=S1',
    muxUrl: '/chat/mux?project=demo&slot=2&session=S1',
  };
  push({ data: { json: () => payload }, waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);

  const shown = log.shown[0];
  ok('the push handler showed no notification, which costs the subscription', Boolean(shown));
  ok(
    `the notification does not carry where to go: ${JSON.stringify(shown?.data)} — the ` +
      'tap happens long after this, with nothing else left to read',
    shown?.data?.url === payload.url,
  );
  ok('the notification lost which conversation it was about', shown?.data?.sessionId === 'S1');
  ok(
    `the notification dropped its place in the mux: ${JSON.stringify(shown?.data)} — a device ` +
      'that chose the mux would land in the editor anyway',
    shown?.data?.muxUrl === payload.muxUrl,
  );

  /*
   * The receipt. Without it the server's knowledge of a notification stops at the push
   * service's 201, and everything after that — whether Chrome woke this worker at all,
   * whether Android then chose to show anything — happens where no log on the box can
   * see it. "It said it sent one and nothing appeared" was unanswerable for a day
   * because of exactly that gap, so a notification that is shown says so.
   */
  const receipt = log.fetched[0];
  ok(
    `the worker told nobody the notification arrived: ${JSON.stringify(log.fetched)} — the ` +
      'server can then only report what the push service accepted, not what was shown',
    receipt?.url === '/api/push/received',
  );
  ok(
    'the receipt does not say which notification it is for, so two in a row are indistinguishable',
    JSON.parse(receipt?.options?.body || '{}').tag === 'turn-abc',
  );
  ok(
    'a receipt for a notification that was shown does not say so, which is the half of the ' +
      'question that means the phone is holding it rather than never receiving it',
    JSON.parse(receipt?.options?.body || '{}').shown === true,
  );
  ok(
    'the receipt does not say how many the browser is holding, which is the difference ' +
      'between a notification the phone is hiding and one it discarded',
    JSON.parse(receipt?.options?.body || '{}').held === 1,
  );
  ok(
    'the receipt was sent without credentials, and the route that records it is behind ' +
      'authentication — it would be a redirect to a login page',
    receipt?.options?.credentials === 'include',
  );
  ok(
    `the receipt was sent before the notification: ${log.order.join(' → ')} — Chrome revokes ` +
      'a userVisibleOnly subscription that shows nothing, so nothing may run in front of it',
    log.order[0] === 'show',
  );
}

// ------------------------------------------------------- a receipt that fails
/*
 * The phone woken by a push is often the phone with no usable network, and the receipt
 * is diagnostics: losing one costs a log line. Losing the notification costs the
 * feature, and Chrome charges for it — a `userVisibleOnly` subscription that receives a
 * push and shows nothing is revoked after one warning.
 */
{
  const { listeners, log } = boot({ receiptFails: true });
  const waits = [];
  listeners.get('push')({
    data: { json: () => ({ title: 'Claude finished', body: 'Done.', tag: 'turn-xyz' }) },
    waitUntil: (p) => waits.push(p),
  });
  let threw = null;
  try {
    await Promise.all(waits);
  } catch (err) {
    threw = err;
  }
  ok(
    `a failed receipt propagated out of the push handler (${threw?.message}) — the browser ` +
      'counts that as a push that showed nothing',
    threw === null,
  );
  ok('the notification was not shown when the receipt could not be sent', log.shown.length === 1);
}

// --------------------------------------- shown, and then not on screen at all
/*
 * The case that cannot be seen from anywhere else: `showNotification` resolves, so
 * every side of the delivery reports success, and the platform has surfaced nothing.
 * Android does this when notifications are off for the installed app rather than for
 * the browser — the page is never told. The count is the only evidence, so it travels
 * even when it is zero, which JSON.stringify would drop if it were undefined.
 */
{
  const { listeners, log } = boot({ onScreen: [] });
  const waits = [];
  listeners.get('push')({
    data: { json: () => ({ title: 'Claude finished', body: 'Done.', tag: 'turn-vanished' }) },
    waitUntil: (p) => waits.push(p),
  });
  await Promise.all(waits);
  const body = JSON.parse(log.fetched[0]?.options?.body || '{}');
  ok(
    `a notification that was accepted and then vanished is reported as an ordinary ` +
      `success: ${JSON.stringify(body)}`,
    body.shown === true && body.held === 0,
  );
}

// ------------------------------------------- a platform that will not display
/*
 * The failure that looks like a delivery problem and is not.
 *
 * `showNotification` rejects when the phone has decided the browser may not show
 * anything, and the browser's answer to a `userVisibleOnly` push that displayed
 * nothing is to revoke the subscription. The device then subscribes again, receives
 * one push, is refused again, and reads as freshly subscribed the entire time — which
 * is exactly what a day of this looked like from the box. The push handler is the only
 * place that can tell, so it says so instead of failing silently.
 */
{
  const { listeners, log } = boot({ showRefused: 'Notifications are blocked' });
  const waits = [];
  listeners.get('push')({
    data: { json: () => ({ title: 'Claude finished', body: 'Done.', tag: 'turn-refused' }) },
    waitUntil: (p) => waits.push(p),
  });
  let threw = null;
  try {
    await Promise.all(waits);
  } catch (err) {
    threw = err;
  }
  ok(
    `a refused notification propagated out of the handler (${threw?.message}), so the only ` +
      'record of it is an unhandled rejection in a worker nobody can see',
    threw === null,
  );
  const body = JSON.parse(log.fetched[0]?.options?.body || '{}');
  ok(
    `the server was not told the notification could not be shown: ${JSON.stringify(body)} — ` +
      'without this, "nothing appeared" and "nothing arrived" are the same evidence',
    log.fetched[0]?.url === '/api/push/received' && body.shown === false,
  );
  ok(
    'the receipt does not say why the platform refused, which is the one detail that ' +
      'points at the phone rather than at this box',
    /blocked/i.test(body.error || ''),
  );
  ok('a refused notification was recorded as shown', log.shown.length === 0);
}

// ----------------------------------------------- a payload that is not ours
/*
 * Something else's push, or a truncated one. `event.data.json()` throws, and the one
 * unacceptable outcome is showing nothing: the subscription is spent either way, so it
 * may as well be spent on something the operator can see.
 */
{
  const { listeners, log } = boot();
  const waits = [];
  listeners.get('push')({
    data: {
      json: () => { throw new Error('not json'); },
      text: () => 'something else entirely',
    },
    waitUntil: (p) => waits.push(p),
  });
  await Promise.all(waits);
  ok(
    'a payload that is not ours showed no notification, which costs the subscription itself',
    log.shown.length === 1,
  );
  ok(
    `an unreadable payload lost the text it did have: ${JSON.stringify(log.shown[0]?.body)}`,
    log.shown[0]?.body === 'something else entirely',
  );
  ok(
    'an untagged notification has no tag, so a second one appears alongside the first ' +
      'instead of replacing it',
    log.shown[0]?.tag === 'cw-turn',
  );
}

// ------------------------------------------------------------- nothing open
/*
 * The plain case, and the one the bug report was about: a phone with nothing open,
 * a tap, and an editor for that project on screen afterwards.
 */
{
  const url = '/p/demo/?folder=%2Fworkspace%2Fprojects%2Fdemo&session=S1';
  const log = await tap({ project: 'demo', sessionId: 'S1', url });
  ok(
    `the tap opened ${JSON.stringify(log.opened)} — it has to be the project window the ` +
      'notification names, query and all, or the editor opens with no folder',
    log.opened.length === 1 && log.opened[0] === url,
  );
  ok('the notification was left on the lock screen after being tapped', log.closed === 1);
}

// -------------------------------------------------- that project already open
/*
 * A window for this project is focused, not replaced.
 *
 * On Android an installed web app has exactly one window, so opening would mean
 * navigating the workbench that is already there — a full code-server reload to arrive
 * at the place it was already showing. The session id then has to travel by message,
 * because the URL of a window that already exists cannot be changed without that
 * reload being exactly what happens.
 */
{
  const url = '/p/demo/?folder=%2Fworkspace%2Fprojects%2Fdemo&session=S2';
  const log = await tap(
    { project: 'demo', sessionId: 'S2', url },
    { windows: [`${ORIGIN}/p/demo/?folder=%2Fworkspace%2Fprojects%2Fdemo`] },
  );
  ok(
    'a window for this project was already open and the tap opened another one — on a ' +
      'phone that is a workbench reload to land where it already was',
    log.opened.length === 0,
  );
  ok('the window that was already open was never focused', log.focused.length === 1);
  ok(
    `the focused window was not told which conversation: ${JSON.stringify(log.posted)} — its ` +
      'URL cannot change without a reload, so this message is the only way to say',
    log.posted.length === 1 && log.posted[0]?.sessionId === 'S2',
  );
  ok(
    'the message to the window carries no type, so the overlay cannot tell it from any ' +
      'other postMessage the workbench receives',
    log.posted[0]?.type === 'cw-notification-click',
  );
}

// ------------------------------------------------- a different project open
/*
 * The editor open on *another* project must not absorb the tap. It is the same origin
 * and the same installed code-server, so only the path tells them apart — which is
 * the whole reason /p/<name>/ exists (see chat-service/manifest.js).
 */
{
  const url = '/p/demo/?folder=%2Fworkspace%2Fprojects%2Fdemo&session=S1';
  const log = await tap(
    { project: 'demo', sessionId: 'S1', url },
    { windows: [`${ORIGIN}/p/other/?folder=%2Fworkspace%2Fprojects%2Fother`, `${ORIGIN}/chat/`] },
  );
  ok(
    'a window on a different project took the tap — the notification for demo would ' +
      'focus the editor for other and change nothing on screen',
    log.focused.length === 0,
  );
  ok(`the tap opened ${JSON.stringify(log.opened)} instead of ${url}`, log.opened[0] === url);
}

// --------------------------------------------------------------- the fallback
/*
 * Two notifications have no project window to go to: the test notification from the
 * switch, which is about no conversation at all, and one for a transcript whose
 * directory is not a project. Both are real, and both have to land somewhere.
 */
{
  const log = await tap({ project: null, sessionId: null });
  ok(
    `a notification with no URL opened ${JSON.stringify(log.opened)} — the chat app is the ` +
      'one address that is always right',
    log.opened.length === 1 && log.opened[0] === '/chat/',
  );
}
{
  const log = await tap({ sessionId: 'S1', url: '/chat/' }, { windows: [`${ORIGIN}/chat/`] });
  ok('the chat app was already open and the tap opened a second one', log.opened.length === 0);
  ok('the open chat app was not focused by a tap that belongs to it', log.focused.length === 1);
}

// ------------------------------------------------------------ somebody else's URL
/*
 * The URL arrives over the network, inside the push payload. Nothing in this
 * deployment sends anything but a path — but `//elsewhere.example` is a URL to another
 * site that reads like one, and a worker that opened it would turn a notification into
 * a redirect someone else chose. Rejected in favour of the fallback rather than
 * repaired.
 */
for (const hostile of ['//elsewhere.example/', 'https://elsewhere.example/', 'javascript:alert(1)', 'p/demo/']) {
  const log = await tap({ project: 'demo', sessionId: 'S1', url: hostile });
  ok(
    `a payload asking for ${JSON.stringify(hostile)} opened ${JSON.stringify(log.opened)} — ` +
      'anything that is not a path on this origin has to fall back to the chat app',
    log.opened.length === 1 && log.opened[0] === '/chat/',
  );
}

// ------------------------------------------------- a device that chose the mux
/*
 * Where a tap lands is the device's choice, read at the moment of the tap. Unset is
 * the editor, as it always was; 'mux' takes the notification's mux address; and a
 * notification with no mux address — the test one, a transcript outside any project,
 * one sent before the choice existed — still goes somewhere useful.
 */
{
  const data = {
    project: 'demo',
    sessionId: 'S1',
    url: '/p/demo/?folder=%2Fworkspace%2Fprojects%2Fdemo&session=S1',
    muxUrl: '/chat/mux?project=demo&slot=2&session=S1',
  };
  let log = await tap(data);
  ok(`a device that never chose landed on ${JSON.stringify(log.opened)}, not the editor`,
    log.opened[0] === data.url);
  log = await tap(data, { opens: 'editor' });
  ok(`a device that chose the editor landed on ${JSON.stringify(log.opened)}`, log.opened[0] === data.url);
  log = await tap(data, { opens: 'mux' });
  ok(`a device that chose the mux landed on ${JSON.stringify(log.opened)}`, log.opened[0] === data.muxUrl);
  log = await tap(data, { opens: 'nonsense' });
  ok(`an unreadable choice landed on ${JSON.stringify(log.opened)} rather than the editor`,
    log.opened[0] === data.url);

  log = await tap({ ...data, muxUrl: null }, { opens: 'mux' });
  ok(`a notification with no mux address, on a mux device, opened ${JSON.stringify(log.opened)} — ` +
    'the editor it does name is better than nothing', log.opened[0] === data.url);
  log = await tap({ sessionId: null }, { opens: 'mux' });
  ok(`the test notification, on a mux device, opened ${JSON.stringify(log.opened)}`, log.opened[0] === '/chat/mux');

  for (const hostile of ['//elsewhere.example/', 'https://elsewhere.example/mux']) {
    log = await tap({ ...data, muxUrl: hostile }, { opens: 'mux' });
    ok(`a mux address of ${JSON.stringify(hostile)} was followed: ${JSON.stringify(log.opened)}`,
      log.opened[0] === data.url);
  }

  // A mux already open is focused and told, like an editor is.
  log = await tap(data, { opens: 'mux', windows: [`${ORIGIN}/chat/mux`, `${ORIGIN}/p/demo/?folder=x`] });
  ok('an open mux was passed over for another window', log.opened.length === 0 && log.focused[0] === `${ORIGIN}/chat/mux`);
  ok(`the open mux was not told where: ${JSON.stringify(log.posted)}`, log.posted[0]?.url === data.muxUrl);
}

// --------------------------------------------- the choice survives an update
/*
 * The worker clears every cache on activation, for the caching worker that predates
 * it. The choice lives in one, so that cache has to be the exception — or every deploy
 * that touched this file would put every device back on the editor.
 */
{
  const { listeners, log } = boot({ cacheNames: ['old-app-shell', 'triplec-prefs'] });
  const waits = [];
  listeners.get('activate')({ waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  ok(`activation deleted ${JSON.stringify(log.deleted)} — the preferences have to survive it`,
    log.deleted.includes('old-app-shell') && !log.deleted.includes('triplec-prefs'));
}

// ----------------------------------------------------------------- the report
if (failures.length) {
  console.error(`sw-test: ${failures.length} of ${checks} checks failed\n`);
  for (const line of failures) console.error(`  FAIL ${line}`);
  process.exit(1);
}
console.log(`sw-test: ${checks}/${checks} checks passed`);
