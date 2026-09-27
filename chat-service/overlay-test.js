/**
 * Boot the editor's mobile overlay in a real DOM and prove its escape hatch works.
 *
 * The overlay is injected raw into code-server by nginx, so nothing else ever
 * loads it: a runtime error at the top means the mic, the project switcher and
 * the layout rescue all silently vanish from the editor, and the only symptom is
 * buttons that aren't there. It has also mounted twice before, inside the Claude
 * panel's iframe, which is covered here too.
 *
 * The layout rescue gets the most attention because it is the part that cannot
 * report its own failure. It drives the mobile extension through a synthesised
 * keyboard chord, which is a contract between two files that share no code —
 * `pwa/mobile-overlay.js` decides which keys to send, `mobile-extension/
 * package.json` decides which keys mean something. If those drift apart, the
 * button stops working and nothing anywhere throws. So the chords are read out
 * of the extension's manifest and compared against what the buttons actually
 * dispatch.
 *
 * Run: node chat-service/overlay-test.js
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { JSDOM, VirtualConsole } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const overlayJs = readFileSync(join(root, 'pwa', 'mobile-overlay.js'), 'utf8');
const manifest = JSON.parse(readFileSync(join(root, 'mobile-extension', 'package.json'), 'utf8'));

const failures = [];
const fail = (msg) => failures.push(msg);
let checks = 0;
const ok = (msg, cond) => {
  checks++;
  if (!cond) fail(msg);
};

// ---------------------------------------------------------------- the chords
/**
 * What VS Code's keybinding service reads off a keydown, derived from a
 * `contributes.keybindings` entry. Function keys are the only ones used, so the
 * mapping stays deliberately narrow: guessing at a wider table would invent
 * agreement that hasn't been checked.
 */
function parseKeybinding(key) {
  const parts = key.toLowerCase().split('+');
  const base = parts.pop();
  const fn = /^f(\d{1,2})$/.exec(base);
  if (!fn) return null;
  return {
    key: base.toUpperCase(),
    keyCode: 111 + Number(fn[1]), // F1 is 112
    ctrlKey: parts.includes('ctrl'),
    altKey: parts.includes('alt'),
    shiftKey: parts.includes('shift'),
  };
}

const bound = new Map();
for (const kb of manifest.contributes?.keybindings ?? []) {
  const parsed = parseKeybinding(kb.key);
  if (!parsed) {
    fail(`keybinding for ${kb.command} is not a function-key chord: ${kb.key}`);
    continue;
  }
  bound.set(kb.command, parsed);
}

ok(
  'mobile-extension binds no keybinding for claudeMobile.backToClaude — the overlay ' +
    'button has nothing to trigger',
  bound.has('claudeMobile.backToClaude'),
);
ok(
  'mobile-extension binds no keybinding for claudeMobile.toggleChrome',
  bound.has('claudeMobile.toggleChrome'),
);
ok(
  'mobile-extension binds no keybinding for claudeMobile.toggleTerminal — the bar’s ' +
    'terminal button has nothing to trigger',
  bound.has('claudeMobile.toggleTerminal'),
);

/*
 * The terminal has to open in the *editor area*. `workbench.panel.defaultLocation`
 * is `right` on this surface, so a panel terminal is a narrow column beside Claude
 * with the soft keyboard over it. Checked in the source because there is no VS Code
 * API to run against here, and the failure it guards is silent: a panel terminal
 * still works, it is just unusable on the device this exists for.
 */
const extensionJs = readFileSync(join(root, 'mobile-extension', 'extension.js'), 'utf8');
ok(
  'the extension registers no handler for claudeMobile.toggleTerminal',
  extensionJs.includes("registerCommand('claudeMobile.toggleTerminal'"),
);
ok(
  'the terminal is not opened in the editor area (TerminalLocation.Editor)',
  /TerminalLocation\.Editor/.test(extensionJs),
);
ok(
  'nothing reuses an existing terminal, so every press or reload stacks a new shell',
  /vscode\.window\.terminals/.test(extensionJs),
);

const declared = new Set((manifest.contributes?.commands ?? []).map((c) => c.command));
for (const command of bound.keys()) {
  ok(`${command} is bound to a key but not declared in contributes.commands`, declared.has(command));
}

// ------------------------------------------------------------- the top frame
// jsdom logs unimplemented navigation as a jsdomError; that is not a failure.
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', () => {});
virtualConsole.on('error', (m) => fail(`console error: ${m}`));

/*
 * The head starts with a manifest link that is not this project's, because that is
 * the case that fails silently: a browser installs the first manifest it finds, and
 * code-server is free to grow one of its own between releases. The switcher section
 * below checks that exactly one survives, and which.
 */
const dom = new JSDOM(
  '<!doctype html><html><head><link rel="manifest" href="/editor/manifest.json"></head>' +
    '<body><iframe id="panel" srcdoc="<p>webview</p>"></iframe></body></html>',
  {
    runScripts: 'outside-only',
    // Any HTTPS origin will do; localStorage needs a real one.
    url: 'https://claude.example.com/editor/?folder=%2Fworkspace%2Fprojects%2Fdemo',
    virtualConsole,
  },
);
const w = dom.window;
w.addEventListener('error', (e) => fail(`uncaught: ${e.message}`));

// The project switcher's only source of truth. Two projects, one of them the
// folder this window already has open (see the URL above).
// What the dictation cleanup route answers, and what it was asked. `null` is the
// route being unavailable, which is a case the sheet has to survive rather than a
// case it can report.
let polishReply = null;
const polishCalls = [];

/*
 * What the status route answers, and what it was asked.
 *
 * It starts as `null` — the route unreachable — because that is the state the
 * overlay has to survive silently, and the initial check runs at load, before any
 * test can intervene. A phone whose chat-service session has lapsed gets a 401
 * here, and the one thing it must not get is a banner across the editor.
 */
let statusReply = null;
const statusCalls = [];

/*
 * What the opening-prompt route answers, and which conversations it was asked about.
 *
 * `null` is every way of not being able to answer — a lapsed chat-service session, a
 * deployment older than the route — and it is the state the rest of this file runs
 * in, because the sheet has to be exactly what it was before this existed when the
 * ask fails. The log is the other half of the point: the answer cannot change for
 * the life of a conversation, so asking twice for one is a bug, not an inefficiency.
 */
let firstPromptReply = null;
const firstPromptCalls = [];

/*
 * The server voice, which is off until the section that tests it.
 *
 * `null` is a deployment that cannot synthesise — no Polly permission, an older
 * server with no such route, or a chat-service session that has lapsed — and it is
 * the state every other section here runs in, because the browser's own voice is
 * what those are about and it has to keep working with no server behind it.
 */
let voiceReply = null;
const voiceCalls = [];
/** What /api/speak/prepare was asked, and what it answers. */
const prepareCalls = [];
let prepareStatus = 0;
/** Which segments were fetched, and which one to refuse. */
const segmentCalls = [];
let refuseSegment = -1;

w.fetch = (url, options = {}) => {
  const target = String(url);
  if (target.includes('/api/voice-status')) {
    voiceCalls.push(target);
    if (!voiceReply) {
      return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
    }
    // Shaped like the real route: transcription's answer with the voice's nested
    // inside it, because they are two halves of one question.
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ configured: true, backend: 'local', speech: voiceReply }),
    });
  }
  if (target.includes('/api/speak/prepare')) {
    const body = JSON.parse(options.body || '{}');
    prepareCalls.push(body);
    // No server voice means no route to read with either, which is what a device
    // with a lapsed chat-service session gets — and it is what the sections after
    // this one run against, so they fall back to the browser's voice as before.
    if (!voiceReply) {
      return Promise.resolve({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: 'not signed in' }),
      });
    }
    if (prepareStatus) {
      return Promise.resolve({
        ok: false,
        status: prepareStatus,
        json: () => Promise.resolve({ error: 'the voice has read 300000 characters today' }),
      });
    }
    // Three pieces, like a real summary: enough to prove the chain and the
    // one-ahead prefetch, few enough to step through by hand.
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        id: 'aa11bb22cc33dd44',
        voice: body.voice || 'Ruth',
        engine: 'generative',
        segments: 3,
        chars: (body.text || '').length,
      }),
    });
  }
  if (target.includes('/api/speak?')) {
    const segment = Number(new w.URL(target, 'https://claude.example.com').searchParams.get('segment'));
    segmentCalls.push(segment);
    if (segment === refuseSegment) {
      return Promise.resolve({
        ok: false,
        status: 502,
        json: () => Promise.resolve({ error: 'the voice failed' }),
      });
    }
    // The body is drained and discarded: this fetch is for the status — a refusal is
    // a sentence worth repeating — and to warm the cache the element then reads the
    // same URL from. The bytes never pass through the overlay.
    return Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve({ segment }) });
  }
  if (target.includes('/api/first-prompt')) {
    const asked = new w.URL(target, 'https://claude.example.com').searchParams;
    firstPromptCalls.push({ cwd: asked.get('cwd'), sessionId: asked.get('sessionId') });
    if (!firstPromptReply) {
      return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(firstPromptReply(asked.get('sessionId'))),
    });
  }
  if (target.includes('/api/claude-status')) {
    statusCalls.push(target);
    if (!statusReply) {
      return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(statusReply) });
  }
  if (target.includes('/api/projects')) {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        projects: [
          { name: 'demo', path: '/workspace/projects/demo' },
          { name: 'other', path: '/workspace/projects/other' },
        ],
      }),
    });
  }
  if (target.includes('/api/polish')) {
    polishCalls.push(JSON.parse(options.body || '{}').text);
    if (!polishReply) {
      return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(polishReply) });
  }
  return Promise.reject(new Error(`unexpected fetch: ${target}`));
};

// jsdom has no clipboard, and the clipboard is the only way text leaves the
// dictation sheet, so it is recorded rather than stubbed away.
const copied = [];
Object.defineProperty(w.navigator, 'clipboard', {
  configurable: true,
  value: { writeText: (text) => { copied.push(String(text)); return Promise.resolve(); } },
});

try {
  w.eval(overlayJs);
} catch (err) {
  console.error(`FAIL: mobile-overlay.js threw on load — ${err.constructor.name}: ${err.message}`);
  console.error(err.stack?.split('\n').slice(0, 5).join('\n'));
  process.exit(1);
}

const doc = w.document;
for (const id of ['cmo-fab', 'cmo-layout', 'cmo-projects', 'cmo-status', 'cmo-mic']) {
  ok(`#${id} did not mount`, doc.getElementById(id));
}

// --------------------------------------------------------- is Claude working
/*
 * The chip answers, on arrival, the question the Claude panel makes you wait
 * seconds for: is Claude still working, and if not, what did it last say. The
 * panel loads the whole transcript on every page load and renders it oldest-first,
 * so the newest message — the one needed in order to reply — arrives last.
 *
 * The failure that matters most is the quiet one. The editor and the chat API are
 * gated separately, so a device signed into code-server alone gets a 401 here, and
 * an older deployment has no such route at all. Both must leave the editor exactly
 * as it was: this thing floats over someone's screen, and being wrong about that
 * is worse than not being there.
 */
await new Promise((resolve) => setTimeout(resolve, 20)); // the check at load
ok('the status route was never asked, so the chip cannot appear at all', statusCalls.length === 1);
ok(
  'an unreachable status route still put a chip over the editor — a lapsed chat ' +
    'session or an older deployment would show it on every page load',
  !doc.getElementById('cmo-chip'),
);

// ------------------------------------------------------------ the load history
/*
 * Every load leaves a line behind, because a workbench that reloads itself on a
 * phone cannot be diagnosed from the instance — the server sees an identical dead
 * extension host whichever cause it was.
 */
const loads = () => JSON.parse(w.localStorage.getItem('claude-editor-loads') || '[]');
ok('the load was not recorded, so a reload leaves no evidence', loads().length === 1);
ok(
  'the recorded load does not say which folder it opened',
  loads()[0]?.folder === '/workspace/projects/demo',
);

// ------------------------------------------------------------- the iframe case
/*
 * The Claude panel is served from this same origin, so nginx's injection reached
 * it and a second mic and project switcher mounted inside the panel — a few
 * pixels off the workbench's own. The overlay refuses to run outside the top
 * frame; this is that refusal.
 */
const inner = doc.getElementById('panel').contentWindow;
try {
  inner.eval(overlayJs);
} catch (err) {
  fail(`overlay threw inside a subframe: ${err.message}`);
}
ok(
  'the overlay mounted inside a subframe — the Claude panel will show a second ' +
    'set of buttons',
  !inner.document.getElementById('cmo-fab'),
);
ok(
  'a subframe recorded a page load, which would count every webview as a reload',
  loads().length === 1,
);

// -------------------------------------------------------------- layout rescue
doc.getElementById('cmo-layout').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

const sheet = doc.getElementById('cmo-sheet');
ok('the Layout button did not open the sheet', sheet.classList.contains('cmo-open'));
for (const id of ['cmo-back', 'cmo-chrome', 'cmo-reload', 'cmo-layout-close']) {
  ok(`the Layout sheet is missing #${id}`, doc.getElementById(id));
}
ok(
  'the Layout sheet does not link the device reset, which is the last resort when ' +
    'a reload comes back broken',
  /reset\.html/.test(doc.getElementById('cmo-panel').innerHTML),
);
ok(
  'the Layout sheet does not show the load history — the one place a phone-only ' +
    'reload becomes readable evidence',
  /load/.test(doc.getElementById('cmo-loads')?.textContent ?? ''),
);

/*
 * Listen on the *window*, which is where VS Code's keybinding service listens,
 * and put focus somewhere else first — in the editor the focused element is
 * usually the Claude panel's iframe. A chord that only reaches its own button is
 * a chord VS Code never sees.
 */
const seen = [];
w.addEventListener('keydown', (e) => {
  seen.push({
    key: e.key,
    code: e.code,
    keyCode: e.keyCode,
    ctrlKey: e.ctrlKey,
    altKey: e.altKey,
    shiftKey: e.shiftKey,
  });
});

function chordFor(buttonId) {
  seen.length = 0;
  doc.getElementById('panel').focus();
  doc.getElementById(buttonId).dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  return seen;
}

function assertChord(buttonId, command) {
  const want = bound.get(command);
  if (!want) return; // already reported above
  const got = chordFor(buttonId);
  checks++;
  const match = got.find(
    (e) =>
      e.keyCode === want.keyCode &&
      e.ctrlKey === want.ctrlKey &&
      e.altKey === want.altKey &&
      e.shiftKey === want.shiftKey,
  );
  if (!match) {
    fail(
      `#${buttonId} did not send ${command}'s chord to the window. ` +
        `expected keyCode ${want.keyCode} with ctrl/alt/shift ` +
        `${want.ctrlKey}/${want.altKey}/${want.shiftKey}; saw ` +
        (got.length ? JSON.stringify(got) : 'no keydown at all'),
    );
    return;
  }
  ok(`#${buttonId} sent keyCode ${match.keyCode} but key "${match.key}"`, match.key === want.key);
}

assertChord('cmo-back', 'claudeMobile.backToClaude');

// The sheet closes itself a moment after each tap, so reopen for the next one.
doc.getElementById('cmo-layout').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
assertChord('cmo-chrome', 'claudeMobile.toggleChrome');

// This one is on the bar rather than in a sheet: one tap, from wherever you are.
assertChord('cmo-terminal', 'claudeMobile.toggleTerminal');

// --------------------------------------------------------- the project switcher
/*
 * Tapping the project you are already in used to navigate anyway, which reloads
 * the whole workbench, restarts the extension host and discards anything typed
 * into the Claude panel — to arrive exactly where you already were. The switcher
 * is also the natural thing to open just to check which project this window has,
 * so that tap is normal, not a mistake.
 *
 * jsdom cannot navigate, so the observable difference is the sheet: the no-op path
 * closes it, the navigating path leaves it open.
 */
doc.getElementById('cmo-projects').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await new Promise((resolve) => setTimeout(resolve, 20)); // the fetch above

const items = [...doc.querySelectorAll('.cmo-item')];
ok('the project switcher listed no projects', items.length === 2);
const currentItem = items.find((el) => el.dataset.path.includes('demo'));
const otherItem = items.find((el) => el.dataset.path.includes('other'));
ok(
  'the project this window already has open is not marked as open',
  currentItem?.dataset.open === '1' && /open/.test(currentItem.textContent),
);
ok('a project that is not open was marked as open', otherItem && !otherItem.dataset.open);

/*
 * Switching project used to cost you the window you were in: the sheet assigned
 * `location.href`, so project B replaced project A and nothing offered a second
 * one. The chat app already gives a project its own window; this is the editor
 * catching up, and the mechanism is that a project row is a real link.
 *
 * jsdom cannot open tabs or long-press, so what is checked here is the contract
 * that makes both possible in a browser: a real `href` on every row (the only
 * thing a long-press menu can act on — and the only route to a separate *window*),
 * a `target="_blank"` sibling for a new tab, and which of the two this file
 * handles itself. That last one is the part that breaks silently: swallow the
 * click on the ⧉ anchor and it stops opening a tab, with nothing to show for it.
 */
const rows = [...doc.querySelectorAll('.cmo-item-row')];
ok('a project is no longer a row that can hold a second control', rows.length === 2);
ok(
  'a project row is not a link, so a long press offers nothing to open elsewhere',
  items.length === 2 &&
    items.every(
      (el) => el.tagName === 'A' && /^\/p\/[^/]+\/\?folder=/.test(el.getAttribute('href')),
    ),
);
ok(
  'the project row links somewhere other than the folder it names',
  otherItem?.getAttribute('href') ===
    `/p/other/?folder=${encodeURIComponent('/workspace/projects/other')}`,
);

/*
 * Why the rows point at /p/<name>/ and not /editor/?folder=<path>, which is the
 * URL they used and which code-server itself still answers on.
 *
 * A manifest's scope is a path prefix, and scope matching ignores the query. Every
 * project living under /editor/ meant every project manifest described an app with
 * the same scope, so Android had one installed web app claiming them all and every
 * install after the first was refused as "already installed" — the whole reported
 * bug. The path prefix is the fix, so it is the thing worth asserting: not that the
 * hrefs are right, but that they *differ before the query*. See
 * chat-service/manifest.js, which mints the matching scope.
 */
const prefixOf = (el) => (el?.getAttribute('href') || '').split('?')[0];
ok(
  'two projects share a URL prefix, so their manifests share a scope and Android ' +
    'installs only the first of them',
  prefixOf(currentItem) !== prefixOf(otherItem),
);
ok(
  'a project row points outside the per-project path, where scopes collide',
  items.every((el) => prefixOf(el) !== '/' && !prefixOf(el).startsWith('/editor/')),
);

const newTabs = [...doc.querySelectorAll('.cmo-item-new')];
ok('no "open in a new tab" control was offered per project', newTabs.length === 2);
ok(
  'the new-tab control does not open a new tab, or leaks the opener to it',
  newTabs.every(
    (el) => el.getAttribute('target') === '_blank' && /noopener/.test(el.getAttribute('rel') || ''),
  ),
);
ok(
  'the new-tab control points somewhere other than its own project',
  newTabs.some(
    (el) =>
      el.getAttribute('href') ===
      `/p/other/?folder=${encodeURIComponent('/workspace/projects/other')}`,
  ),
);

/*
 * Who handles the tap. The row is this file's business — a plain tap still means
 * "open it here", so the anchor's own navigation has to be suppressed. The ⧉ is
 * the browser's business, and a `preventDefault` anywhere near it would quietly
 * turn it into a button that does nothing.
 */
const rowTap = new w.MouseEvent('click', { bubbles: true, cancelable: true });
otherItem?.dispatchEvent(rowTap);
ok('a tap on the project row was left to the anchor, opening it twice', rowTap.defaultPrevented);
ok(
  'tapping another project closed the sheet, which hides the switch from the user',
  sheet.classList.contains('cmo-open'),
);

const newTabTap = new w.MouseEvent('click', { bubbles: true, cancelable: true });
newTabs[0]?.dispatchEvent(newTabTap);
ok(
  'something swallowed the tap on ⧉, so it no longer opens a tab',
  !newTabTap.defaultPrevented,
);

// ------------------------------------------------- a window per project
/*
 * A home-screen icon per project, which on Android is the only way to have two
 * projects open at once.
 *
 * A phone gives an installed web app exactly one window and no API opens a second,
 * so the lever is app *identity*: a manifest with an unfamiliar `id` is a distinct
 * application even when served from the same URL, and a distinct application is a
 * distinct icon with its own task. chat-service/manifest-test.js covers the ids
 * themselves; what is checked here is the half that lives in the page, and every
 * one of these fails silently on a phone if it is wrong:
 *
 *   the link is in *this* document, because the manifest a browser installs is the
 *   one linked from the page you install from, and this page is code-server's;
 *
 *   exactly one link survives, because the first one found is the one installed;
 *
 *   `use-credentials`, because a manifest is fetched with credentials omitted by
 *   default and the route serving it is behind the session gate — without it the
 *   fetch is a 401 and the install offer never appears at all;
 *
 *   `beforeinstallprompt` is captured rather than left alone, because the offer
 *   belongs next to the project it is about, not in a strip across the workbench.
 */
const links = [...doc.head.querySelectorAll('link[rel="manifest"]')];
ok(
  'more than one manifest is linked, and the browser installs whichever comes ' +
    'first — the foreign one was left in front of this project’s',
  links.length === 1,
);
ok(
  'the linked manifest is not this project’s, so installing gives another icon for ' +
    'whatever that one describes',
  links[0]?.getAttribute('href') === '/chat/manifest.webmanifest?project=demo',
);
ok(
  'the manifest is linked without use-credentials — it is fetched with credentials ' +
    'omitted by default, so the gated route answers 401 and nothing is installable',
  links[0]?.getAttribute('crossorigin') === 'use-credentials',
);

const openSwitcher = async () => {
  doc.getElementById('cmo-projects').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 20));
};

ok(
  'the switcher does not offer this project its own window, which is the whole ' +
    'feature — and the only place it can be offered is next to the project list',
  doc.getElementById('cmo-install'),
);
ok(
  'the install button does not name the project it would install, so it reads as ' +
    '"install this website"',
  /demo/.test(doc.getElementById('cmo-install')?.textContent ?? ''),
);
ok(
  'the sheet does not explain that a phone gives one window per installed app — ' +
    'without it, an icon per project looks like clutter rather than the answer',
  /one window/.test(doc.getElementById('cmo-panel')?.textContent ?? ''),
);

/*
 * With no `beforeinstallprompt` in hand there is nothing to prompt with, and this
 * window — /editor/?folder=… , see the URL this file boots at — is the reason there
 * is none. A project's manifest is scoped to /p/<name>/ and a browser only offers to
 * install the app a page links while the page is inside that app's scope, so from
 * here no browser will ever offer, and its own menu cannot either. The button says
 * where it is going and goes; the section at the bottom of this file has the case
 * where it stays put and names the menu instead.
 */
doc.getElementById('cmo-install').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await new Promise((resolve) => setTimeout(resolve, 10));
ok(
  'a browser with no install event was told nothing, so the button looks broken on ' +
    'every iPhone',
  /demo/.test(doc.getElementById('cmo-install-status')?.textContent ?? ''),
);

// Chrome's event, as far as this feature can tell one from the real thing.
let prompts = 0;
const installEvent = new w.Event('beforeinstallprompt', { cancelable: true });
installEvent.prompt = () => {
  prompts += 1;
  return Promise.resolve();
};
installEvent.userChoice = Promise.resolve({ outcome: 'accepted' });
w.dispatchEvent(installEvent);
ok(
  'the mini-infobar was left to appear across the workbench, where there is no room ' +
    'for it and no explanation of what it is offering',
  installEvent.defaultPrevented,
);

await openSwitcher();
doc.getElementById('cmo-install').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await new Promise((resolve) => setTimeout(resolve, 10));
ok('the install button never showed the browser’s own prompt', prompts === 1);
ok(
  'an accepted install said nothing, so there is no way to tell it worked from ' +
    'inside the window it was done from',
  /home screen/i.test(doc.getElementById('cmo-install-status')?.textContent ?? ''),
);

// Re-queried, because the sheet has been drawn again since `currentItem` was found
// and a tap on the node it replaced proves nothing about the sheet on screen.
const openRow = [...doc.querySelectorAll('.cmo-item')].find((el) => el.dataset.open === '1');
openRow?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
ok(
  'tapping the already-open project did not just close the sheet — it reloads the ' +
    'editor for nothing',
  openRow && !sheet.classList.contains('cmo-open'),
);

// ----------------------------------------------------------- dictation drafts
/*
 * The Claude panel is a sandboxed iframe, so dictated words have to wait in the
 * overlay's textarea until they are copied across — and the workbench reloads
 * itself whenever the browser restores the page from the back/forward cache, which
 * on a phone is every app switch. A paragraph of speech exists nowhere else, so it
 * has to survive that.
 */
const openMic = () =>
  doc.getElementById('cmo-mic').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

openMic();
const textarea = doc.getElementById('cmo-text');
ok('the mic button did not open a dictation sheet', textarea);
if (textarea) {
  textarea.value = 'a paragraph nobody typed twice';
  textarea.dispatchEvent(new w.Event('input'));
  await new Promise((resolve) => setTimeout(resolve, 500)); // the save is debounced
  ok(
    'dictated text left no draft behind, so a reload takes the whole paragraph',
    /nobody typed twice/.test(w.localStorage.getItem('cmo-dictation-draft') || ''),
  );

  // What a reload looks like from here: the sheet is built again from scratch.
  openMic();
  ok(
    'reopening the dictation sheet did not recover the words already spoken',
    doc.getElementById('cmo-text')?.value === 'a paragraph nobody typed twice',
  );

  // Cancel is an explicit decision to throw the text away; dismissing the sheet by
  // tapping outside it is not, and those two are one stray tap apart.
  doc.getElementById('cmo-cancel').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  ok(
    'Cancel left the discarded dictation in storage, so it comes back next time',
    !w.localStorage.getItem('cmo-dictation-draft'),
  );
}

// -------------------------------------------------------- copying the dictation
/*
 * What leaves this sheet is whatever is on the clipboard, so the cleanup pass is
 * only allowed to improve it, never to be the thing that produces it. Two orders
 * are asserted: the raw text is copied inside the tap (a clipboard write issued
 * after an `await` is refused on iOS), and the punctuated version replaces it only
 * once it has actually arrived.
 */
const copy = async () => {
  doc.getElementById('cmo-copy').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 30));
};

const dictate = async (text) => {
  openMic();
  const box = doc.getElementById('cmo-text');
  box.value = text;
  box.dispatchEvent(new w.Event('input'));
  await new Promise((resolve) => setTimeout(resolve, 20));
};

const spoken = 'the transcript nobody punctuated';
const punctuated = 'The transcript nobody punctuated.';

copied.length = 0;
polishCalls.length = 0;
polishReply = { text: punctuated, changed: true };
await dictate(spoken);
await copy();

ok('Copy did not send the dictation to be punctuated', polishCalls[0] === spoken);
ok(
  'Copy did not put the raw text on the clipboard first — a cleanup that fails or ' +
    'a clipboard that only allows writes inside the tap would lose the dictation',
  copied[0] === spoken,
);
ok('the punctuated text never reached the clipboard', copied[1] === punctuated);
ok(
  'the punctuated text was copied but not shown — it arrives in Claude looking ' +
    'like something the user never dictated',
  doc.getElementById('cmo-text')?.value === punctuated,
);
ok(
  'the handed-over dictation is still stored, so it comes back on the next tap',
  !w.localStorage.getItem('cmo-dictation-draft'),
);

// The route being unreachable (no Bedrock access, a lapsed chat session, a
// timeout) must be indistinguishable from the feature not being there.
copied.length = 0;
polishReply = null;
await dictate('another sentence nobody punctuated');
await copy();
ok(
  'a failed cleanup pass took the dictation with it instead of copying it as-is',
  copied.length === 1 && copied[0] === 'another sentence nobody punctuated',
);
ok(
  'a failed cleanup pass left the dictation in storage as well as on the clipboard',
  !w.localStorage.getItem('cmo-dictation-draft'),
);

// ---------------------------------------------------- what Claude last said
/*
 * The idle branch. This is the one that saves the wait: nothing is running, so
 * there is nothing to wait for, and the last message is the whole payload.
 *
 * The message is model output. It routinely contains code, angle brackets and
 * things that look like markup, and it lands in a sheet built from a template
 * string — so the check is not that it renders, but that it renders as *text*.
 */
const said = 'Done. Try <img src=x onerror="alert(1)"> and `a < b` in one line.\n\nSecond line.';
statusReply = {
  cwd: '/workspace/projects/demo',
  sessionId: 'abc123',
  state: 'idle',
  source: 'broker',
  clients: 0,
  last: { role: 'assistant', text: said, at: new Date().toISOString() },
  bytes: 5.1 * 1024 * 1024,
  at: Date.now(),
};

/*
 * Scoped to the bar, not `getElementById`: the dictation sheet has a
 * `<p id="cmo-status">` of its own, so while that sheet is open the plain lookup
 * is ambiguous and returns whichever comes first in the document. It happens to
 * be this button — which is a fact about the order two elements are appended in,
 * not something to build every later check on.
 */
const tapStatus = async () => {
  doc.querySelector('#cmo-fab #cmo-status').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 30));
};

await tapStatus();
const chipEl = doc.getElementById('cmo-chip');
ok('an idle conversation showed no chip, so the last message is still unread', chipEl);
ok(
  'the chip does not show what Claude said — the only thing that saves the wait',
  /Done\. Try/.test(chipEl?.querySelector('.cmo-chip-text')?.textContent ?? ''),
);
ok(
  'the chip is on one line, so a long message pushes the editor around',
  /nowrap/.test(w.getComputedStyle(chipEl.querySelector('.cmo-chip-text')).whiteSpace || 'nowrap'),
);
ok(
  'an idle conversation is shown with the working animation',
  !chipEl?.querySelector('.cmo-dot')?.classList.contains('cmo-busy'),
);
ok(
  'the status sheet did not open',
  sheet.classList.contains('cmo-open') && doc.getElementById('cmo-status-said'),
);
/*
 * The message is rendered as markdown, so the sheet's text is the message *without*
 * its markers — the backticked span here becomes an element and its backticks stop
 * being characters. What has to survive is every other character, including the ones
 * that look like markup.
 */
const saidEl = () => doc.getElementById('cmo-status-said');
ok(
  'the sheet shows a truncated message — the point of it is that one line was not enough',
  (saidEl()?.textContent ?? '').includes('Done. Try <img src=x onerror="alert(1)"> and'),
);
ok(
  'the second paragraph of the message is missing from the sheet',
  /Second line\./.test(saidEl()?.textContent ?? ''),
);
ok(
  'the message was injected as markup, not text: an <img> from a model reply built ' +
    'an element in the editor',
  !doc.querySelector('#cmo-status-said img'),
);
ok(
  'a backticked span in the message was not rendered as code, so the sheet still ' +
    'shows the backticks it was written with',
  saidEl()?.querySelector('code')?.textContent === 'a < b',
);
ok(
  'the sheet does not say where the verdict came from — the broker knows, the ' +
    'transcript only shows the state a conversation was left in',
  /broker/.test(doc.getElementById('cmo-status-detail')?.textContent ?? ''),
);
ok(
  'the sheet does not say how big the transcript is, which is the only number that ' +
    'explains the wait',
  /5\.1 MB/.test(doc.getElementById('cmo-panel')?.textContent ?? ''),
);

// ------------------------------------------------------------ the other branch
/*
 * The working branch. Here the wait *is* worth it — the answer has not been said
 * yet — so the chip says so and does not offer a stale message as if it were the
 * reply. Getting this backwards is the expensive direction: it invites typing over
 * a turn that is still running.
 */
statusReply = { ...statusReply, state: 'working', clients: 1 };
await tapStatus();
const busyChip = doc.getElementById('cmo-chip');
ok(
  'a conversation with a turn in flight is not reported as working',
  /working/i.test(busyChip?.querySelector('.cmo-chip-text')?.textContent ?? ''),
);
ok(
  'the working chip still shows the previous message, which reads as the reply',
  !/Done\. Try/.test(busyChip?.querySelector('.cmo-chip-text')?.textContent ?? ''),
);
ok(
  'the working chip is not animated, so it looks the same as a finished one',
  busyChip?.querySelector('.cmo-dot')?.classList.contains('cmo-busy'),
);
ok(
  'the sheet does not say Claude is working',
  /working/i.test(doc.querySelector('#cmo-panel .cmo-title')?.textContent ?? ''),
);

// ------------------------------------------------------------- the third branch
/*
 * The branch between the other two: Claude has stopped and is waiting for an answer.
 *
 * Reported as `state: 'question'` — an unanswered `AskUserQuestion` at the end of the
 * transcript. It has to be its own thing on screen because it is the one state where
 * waiting accomplishes nothing: on disk and to the broker it is a turn in flight, so
 * every surface used to say "Claude is working…" about a conversation that had stopped
 * and would stay stopped. On the transcripts on this box that was a median of three
 * minutes and, once, 5.9 hours.
 *
 * The question itself is model output and lands in a sheet built from a template
 * string, so — like the message above — the check is not that it renders but that it
 * renders as text.
 */
const asking = (over = {}) => ({
  id: 'toolu_bdrk_01waiting',
  at: new Date().toISOString(),
  answered: false,
  pending: true,
  questions: [
    {
      header: 'Deploy',
      question: 'Ship this with <img src=x onerror="alert(1)"> app-only, or the whole stack?',
      options: ['App only', 'Full deploy'],
      multiSelect: false,
      answer: null,
    },
  ],
  ...over,
});

statusReply = { ...statusReply, state: 'question', clients: 1, question: asking() };
await tapStatus();
const askChip = doc.getElementById('cmo-chip');
const askChipText = () => askChip?.querySelector('.cmo-chip-text')?.textContent ?? '';
ok(
  `a conversation waiting for an answer says something else on the chip: ${JSON.stringify(askChipText())}`,
  /waiting for your answer/i.test(askChipText()),
);
ok(
  'the chip does not say which question it is waiting on, so it is not specific enough to act on',
  /Deploy/.test(askChipText()),
);
ok(
  'a question reads as work in progress on the chip — the one thing it is not',
  !/working/i.test(askChipText()),
);
ok(
  'the waiting dot blinks like a working one, so a question looks like something in progress',
  askChip?.querySelector('.cmo-dot')?.classList.contains('cmo-ask') &&
    !askChip?.querySelector('.cmo-dot')?.classList.contains('cmo-busy'),
);
ok(
  'the sheet does not say Claude is waiting for an answer',
  /waiting for your answer/i.test(doc.querySelector('#cmo-panel .cmo-title')?.textContent ?? ''),
);
const askBlock = () => doc.getElementById('cmo-ask');
ok(
  'the question is not shown, so the sheet says someone is waiting without saying for what',
  /app-only, or the whole stack\?/.test(askBlock()?.textContent ?? ''),
);
ok(
  'the question’s own label is missing from the sheet',
  /Deploy/.test(askBlock()?.querySelector('.cmo-ask-head')?.textContent ?? ''),
);
ok(
  'the options are missing, and they are usually the whole of the decision',
  [...(askBlock()?.querySelectorAll('.cmo-ask-opts li') ?? [])].map((li) => li.textContent).join('|') ===
    'App only|Full deploy',
);
ok(
  'a question from the model was injected as markup: an <img> in it built an element ' +
    'in the editor',
  !askBlock()?.querySelector('img'),
);
ok(
  'the sheet does not say where the answer has to go, which is the only thing to do about it',
  /in the panel/i.test(doc.getElementById('cmo-panel')?.textContent ?? ''),
);

// A multi-select ask says so, because "pick any" changes what the card in the panel
// expects of you.
statusReply = {
  ...statusReply,
  question: asking({ questions: [{ header: 'Surfaces', question: 'Which should say it?', options: ['Chip', 'Push'], multiSelect: true, answer: null }] }),
};
await tapStatus();
ok(
  'a multi-select question is shown as though only one option could be picked',
  /pick any/i.test(askBlock()?.querySelector('.cmo-ask-head')?.textContent ?? ''),
);

/*
 * The other half, and the one the panel cannot help with. Opening a conversation makes
 * the panel re-render every question in it as a fresh card, answered or not — so the
 * cards on screen say nothing about whether anything is waiting, and the same question
 * can be answered twice. This is the only surface that can say otherwise, and
 * `question.answer` is what it says it with.
 *
 * Only on a replay: the first answer of a page, or a switch to another conversation.
 * Those are the two moments the panel redraws history, so those are the two moments
 * this is news rather than noise.
 */
statusReply = {
  ...statusReply,
  sessionId: 'def456',
  state: 'idle',
  clients: 0,
  question: asking({ answered: true, pending: false, questions: [{ header: 'Deploy', question: 'Ship app-only, or the whole stack?', options: ['App only', 'Full deploy'], multiSelect: false, answer: 'App only' }] }),
};
await tapStatus();
const noteEl = () => doc.getElementById('cmo-chip')?.querySelector('.cmo-chip-note');
ok(
  `switching to a conversation whose question is already answered says nothing about it: ${JSON.stringify(noteEl()?.textContent ?? '')}`,
  /already answered/i.test(noteEl()?.textContent ?? '') && noteEl()?.classList.contains('cmo-on'),
);
ok(
  'the chip does not say which option was taken, which is what makes it checkable ' +
    'against the card the panel is redrawing',
  /App only/.test(noteEl()?.textContent ?? ''),
);
ok(
  'the sheet does not say the question was already answered — the card in the panel ' +
    'looks exactly like a live one',
  /You answered this/i.test(askBlock()?.textContent ?? '') && /redraws every question card/.test(askBlock()?.textContent ?? ''),
);

// Same conversation, asked again: the panel is not redrawing anything, so the note
// would be a fact repeated at someone who has already read it.
await tapStatus();
ok(
  'the answered note stays on the chip after the first sight of the conversation, ' +
    'where it is no longer news',
  !noteEl()?.classList.contains('cmo-on') && !noteEl()?.textContent,
);

// Asked, dismissed, and the conversation carried on past it: two of the 76 asks on
// this box. Nothing is waiting and nothing was chosen, so there is nothing to say.
statusReply = { ...statusReply, sessionId: 'ghi789', question: asking({ answered: false, pending: false }) };
await tapStatus();
ok(
  'a question the conversation walked past is described as though it mattered',
  Boolean(askBlock()) && !askBlock().textContent,
);

// Unanswered, and nothing is running it: the card in the panel leads nowhere, so the
// way on is to say the answer as an ordinary message.
statusReply = { ...statusReply, sessionId: 'jkl012', live: false, question: asking() };
await tapStatus();
ok(
  'an abandoned question offers no way to answer it, and the card in the panel goes nowhere',
  /as a message instead/i.test(askBlock()?.textContent ?? ''),
);

// And in the list: the row that will never move on its own is the one to say so about.
statusReply = {
  ...statusReply,
  sessionId: 'abc123',
  state: 'idle',
  question: null,
  conversations: [
    { sessionId: 'abc123', title: 'This one', state: 'idle', at: Date.now(), current: true },
    { sessionId: 'def456', title: 'The waiting one', state: 'question', at: Date.now() - 6e5 },
    { sessionId: 'ghi789', title: 'The busy one', state: 'working', at: Date.now() - 3e5 },
  ],
};
await tapStatus();
ok(
  'the head of the list does not count the conversations waiting on an answer, which ' +
    'are the ones to open first',
  /1 waiting on you/.test(doc.getElementById('cmo-convo-head')?.textContent ?? ''),
);
const waitingRow = [...doc.querySelectorAll('#cmo-convos .cmo-convo')].find((row) =>
  /The waiting one/.test(row.textContent ?? ''),
);
ok(
  'a conversation waiting on an answer is listed like any other',
  /waiting on you/.test(waitingRow?.querySelector('.cmo-convo-meta')?.textContent ?? ''),
);
ok(
  'and its dot is the working one, so the list says it is busy rather than stuck',
  waitingRow?.querySelector('.cmo-dot')?.classList.contains('cmo-ask') &&
    !waitingRow?.querySelector('.cmo-dot')?.classList.contains('cmo-busy'),
);

// Back to the working branch, whose sheet the next section reads.
delete statusReply.conversations;
delete statusReply.live;
statusReply = { ...statusReply, state: 'working', clients: 1, question: null };
await tapStatus();

// ---------------------------------------------------------- reading it aloud
/*
 * Say the last message out loud.
 *
 * Three things here can fail silently on the device this is for and nowhere else,
 * which is why they are asserted rather than tried by hand:
 *
 *   iOS refuses speech that did not start inside the tap, so the first utterance
 *   has to be queued synchronously from the click — the same rule the clipboard
 *   write in the dictation sheet follows, and the same way of getting it wrong.
 *
 *   iOS also speaks only the first of a long queue and drops the rest, so the
 *   pieces are chained on `end`. A broken chain reads as a summary that stops
 *   after one sentence, which sounds like the answer ending there.
 *
 *   Speech over a live microphone is dictated straight back into the composer, so
 *   Claude ends up quoting itself as the user's next message.
 *
 * The reduction is checked too, because a final message is written to be read: a
 * literal reading is "asterisk asterisk Done asterisk asterisk" and every slash of
 * every path, out loud.
 */

// The sheet from the working branch above is still open, and jsdom has no
// speechSynthesis — which is also every desktop browser with speech disabled.
ok(
  'a browser that cannot speak was still offered Read aloud, so the button does ' +
    'nothing and reads as something being broken',
  !doc.getElementById('cmo-speak'),
);

/*
 * A synthesiser, as far as this feature can tell one apart from the real thing:
 * it records what it was asked to say, and calls `end` on the next turn of the
 * loop rather than at once, because a chain that only works synchronously is the
 * bug being guarded against.
 */
const utterances = [];
const langs = [];
let cancels = 0;
let speechGeneration = 0;
/*
 * How long a piece takes to be spoken. Zero — the next turn of the loop — for
 * everything that only cares about the order pieces arrive in. The section on
 * following the sheet raises it, because interrupting a message that has already
 * finished proves nothing about interrupting one.
 */
let speechMs = 0;

class FakeUtterance {
  constructor(text) {
    this.text = text;
    this.lang = '';
    this.onend = null;
    this.onerror = null;
  }
}
w.SpeechSynthesisUtterance = FakeUtterance;
w.speechSynthesis = {
  speak(utterance) {
    const generation = speechGeneration;
    utterances.push(utterance.text);
    langs.push(utterance.lang);
    // Cancelled utterances never report `end`; that is what makes Stop stop.
    setTimeout(() => {
      if (generation === speechGeneration && utterance.onend) utterance.onend();
    }, speechMs);
  },
  cancel() {
    cancels += 1;
    speechGeneration += 1;
  },
};

// A final message shaped like the ones this exists for: a heading, emphasis,
// inline code, a fenced block, a link, a bare URL, a full path, a line reference,
// a check-marked list, and enough prose to need more than one utterance.
const finalMessage = [
  '## Done',
  '',
  '**Fixed** the guard in `pwa/mobile-overlay.js` — it now reads the mic button’s',
  'class instead of `recognition`, which the recorder path never sets. See',
  '/workspace/projects/triplec/chat-service/auth.js:42-51 and the note in',
  '[AGENTS.md](https://claude.example.com/AGENTS.md).',
  '',
  '```js',
  'const speaking = false; // 3 < 4 && "quoted"',
  '```',
  '',
  '- ✅ `npm run test:auth` passes',
  '- ✅ the overlay still mounts, checked at https://claude.example.com/editor/',
  '- *One* thing left: the entry in AGENTS.md.',
  '',
  'That is everything worth saying about it, and it is deliberately long enough that',
  'a synthesiser has to be handed more than one utterance to get through it, because',
  'a phone that says only the first sentence of a summary is worse than a phone that',
  'says nothing at all — you would believe it had finished.',
].join('\n');

statusReply = {
  ...statusReply,
  state: 'idle',
  clients: 0,
  last: { role: 'assistant', text: finalMessage, at: new Date().toISOString() },
};
await tapStatus();

const speakBtn = () => doc.getElementById('cmo-speak');
const barBtn = doc.querySelector('#cmo-fab #cmo-status');
const tapSpeak = () =>
  speakBtn()?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const settle = async (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));
/*
 * Wait for the queue to drain, rather than for a fixed delay.
 *
 * Every piece is one more turn of the event loop, and a box running twelve of
 * these at once misses a fixed budget often enough to matter — after which every
 * later check starts from "still reading" and three of them fail for one reason.
 * `settle` is still right where the assertion is that nothing happened.
 */
const drain = async (limit = 5000) => {
  const until = Date.now() + limit;
  while (barBtn.classList.contains('cmo-speaking') && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

ok('the status sheet offers no way to hear the message it is showing', speakBtn());
ok('the Read aloud button does not say what it does', speakBtn()?.textContent === 'Read aloud');

/*
 * The code block, on a phone with no server voice.
 *
 * A block is turned into words in chat-service/speak.js and nowhere else, so this
 * device cannot read one however it is asked — the browser's own voice would spell
 * out the punctuation, which is the thing the feature exists to avoid. A button
 * that cannot work must not be offered, and a message whose code was skipped
 * without explanation is the failure this replaces.
 */
ok(
  'a block read button was offered on a device that has no voice able to read code — ' +
    'the reduction is on the server, and the browser would spell out the punctuation',
  !doc.querySelector('[data-cmo-block]'),
);
ok(
  'a phone with no server voice is not told why the code block in the message is not ' +
    'offered, so the read that says "Code block" looks like all it can ever do',
  /server voice/.test(doc.getElementById('cmo-code-reads')?.textContent || ''),
);

tapSpeak();
ok(
  'nothing was queued inside the tap — speech that starts after an await is refused ' +
    'outright on iOS, which is the only surface this feature is for',
  utterances.length === 1,
);
ok(
  'the bar does not show that it is reading, so dismissing the sheet leaves a phone ' +
    'talking with no visible way to stop it',
  barBtn.classList.contains('cmo-speaking'),
);
ok(
  'the bar button still offers to open the status sheet while it is reading, instead ' +
    'of offering Stop',
  /stop/i.test(barBtn.getAttribute('aria-label') || ''),
);
ok('the sheet button did not turn into Stop', speakBtn()?.textContent === 'Stop');

await drain();
ok(
  'only one utterance was ever utterances — the chain on `end` is what gets iOS past the ' +
    'first piece, and without it a summary stops after one sentence',
  utterances.length > 1,
);
ok(
  'an utterance was queued with no language, so it is read in whatever voice the ' +
    'device defaults to rather than the one dictation uses',
  langs.every((lang) => lang === 'en-US'),
);
ok(
  'a piece longer than the chunk limit was queued, so Stop cannot stop until it ends',
  utterances.every((piece) => piece.length <= 260),
);
ok(
  'the reading did not end on its own, so the bar is left showing Stop for a voice ' +
    'that has finished',
  !barBtn.classList.contains('cmo-speaking'),
);

const heard = utterances.join(' ');
ok('the markup was read out: backticks survived the reduction', !heard.includes('`'));
ok('the markup was read out: bold markers survived the reduction', !heard.includes('**'));
ok('the markup was read out: a heading was read as hashes', !heard.includes('##'));
ok(
  'emphasis was read as asterisks — "asterisk One asterisk thing left"',
  /\bOne thing left\b/.test(heard) && !heard.includes('*'),
);
ok('a list marker was read out instead of being a pause', !/(^|\s)- /.test(heard));
ok(
  'a URL was read out character by character instead of being named',
  !heard.includes('http') && !heard.includes('](') && /\blink\b/.test(heard),
);
ok(
  'a code block was read out loud, or dropped without saying it was there — one is ' +
    'a minute of punctuation names, the other misreports the message',
  /Code block/.test(heard) && !heard.includes('&&'),
);
ok(
  'a full path was read out slash by slash instead of by its file name',
  !heard.includes('/workspace/') && !heard.includes('pwa/') &&
    /\bmobile-overlay\.js\b/.test(heard),
);
ok(
  'a line reference was left as a colon, which runs the number into the next sentence',
  /auth\.js, line 42 to 51/.test(heard),
);
ok('a check mark was pronounced instead of dropped', !heard.includes('✅'));
ok(
  'a hard-wrapped sentence was broken at the wrap — a full stop dropped into the ' +
    'middle of a sentence is heard as a real one, and changes what it says',
  /the mic button’s class instead of recognition/.test(heard),
);
ok(
  'consecutive bullets were run into one sentence, which is what a list sounds like ' +
    'with no pauses in it',
  /passes\. the overlay still mounts/.test(heard),
);
ok(
  'a heading was run into the paragraph under it',
  /^Done\. Fixed/.test(heard),
);
ok(
  'the last sentence was left unterminated, so the voice ends on a rising note and ' +
    'sounds cut off',
  /\.$/.test(utterances[utterances.length - 1] || ''),
);
ok(
  'the message lost its words along with its markup',
  /\bDone\b/.test(heard) && /\bpasses\b/.test(heard) && /believe it had finished/.test(heard),
);

// ------------------------------------------------------------------ stopping
/*
 * Stop, from both controls. The sheet's button is the obvious one; the bar's is the
 * one that matters, because the sheet is dismissed by tapping beside it and the
 * voice carries on afterwards.
 */
tapSpeak();
let cancelsAtStart = cancels;
let utterancesAtStart = utterances.length;
tapSpeak();
await settle();
ok('Stop in the sheet did not cancel the synthesiser', cancels > cancelsAtStart);
ok(
  'Stop in the sheet cancelled the current utterance but the queue carried on',
  utterances.length === utterancesAtStart,
);
ok('Stop left the bar showing that it is still reading', !barBtn.classList.contains('cmo-speaking'));

tapSpeak();
cancelsAtStart = cancels;
utterancesAtStart = utterances.length;
const statusCallsAtStart = statusCalls.length;
barBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await settle();
ok('the bar button did not stop the reading', cancels > cancelsAtStart);
ok('the bar button stopped the current utterance but not the queue', utterances.length === utterancesAtStart);
ok(
  'the bar button asked for the status again while it was reading, so Stop also ' +
    'reopens the sheet over the editor',
  statusCalls.length === statusCallsAtStart,
);

/*
 * Dismissing the sheet is not Stop — the voice is meant to outlive it, so you can
 * go back to watching the panel while it reads. Opening dictation *is*, because a
 * live recognizer hears this and types Claude's own reply into the composer.
 */
tapSpeak();
doc.getElementById('cmo-status-close').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
ok('closing the sheet also stopped the reading', barBtn.classList.contains('cmo-speaking'));
ok('closing the sheet did not close it', !sheet.classList.contains('cmo-open'));

utterancesAtStart = utterances.length;
openMic();
await settle();
ok('opening the dictation sheet did not open it', doc.getElementById('cmo-text'));
ok(
  'a microphone went live while it was still reading — the recognizer transcribes ' +
    'Claude’s own reply into the composer, and the recorder uploads it',
  !barBtn.classList.contains('cmo-speaking') && utterances.length === utterancesAtStart,
);

// ------------------------------------------------- what it says it is reading
/*
 * A message read out during a turn that is still running is the *previous* answer,
 * and heard on its own it sounds like the reply to whatever is being worked on.
 */
statusReply = { ...statusReply, state: 'working', clients: 1 };
await tapStatus();
utterances.length = 0;
tapSpeak();
ok(
  'the last message was read out during a live turn without saying so, so it is ' +
    'heard as the answer to the thing still being worked on',
  /^Still working\. Last message:/.test(utterances[0] || ''),
);

// The mic being live is the one refusal the sheet has to explain, because the
// button is right there and nothing happens when it is pressed. Drained first, so
// the tap below reopens the sheet instead of being read as Stop.
await drain();
doc.getElementById('cmo-mic').classList.add('cmo-rec');
await tapStatus();
utterances.length = 0;
tapSpeak();
ok('speech started over a live microphone', utterances.length === 0);
ok(
  'nothing was utterances and the sheet said nothing about why',
  /mic/i.test(doc.getElementById('cmo-status-detail')?.textContent ?? ''),
);
doc.getElementById('cmo-mic').classList.remove('cmo-rec');

/*
 * Following a different conversation is leaving this one, and the voice has to go
 * with it: the message being read belongs to the conversation being left, and
 * hearing it under a sheet describing another one is worse than silence.
 */
statusReply = {
  ...statusReply,
  state: 'idle',
  conversations: [
    { sessionId: 'abc123', title: 'This one', state: 'idle', at: Date.now(), current: true },
    { sessionId: 'def456', title: 'The other one', state: 'working', at: Date.now() - 6e5 },
  ],
};
await tapStatus();
ok('the conversations list did not render, so this proves nothing', doc.querySelectorAll('.cmo-convo').length >= 2);
tapSpeak();
ok('nothing was being read, so switching cannot be shown to stop it', barBtn.classList.contains('cmo-speaking'));
utterancesAtStart = utterances.length;
doc.querySelectorAll('.cmo-convo')[1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await settle();
ok(
  'following another conversation left the previous one’s message being read aloud ' +
    'under a sheet describing a different conversation',
  !barBtn.classList.contains('cmo-speaking') && utterances.length === utterancesAtStart,
);
delete statusReply.conversations;

// --------------------------------------------------------------- the long one
/*
 * A message that is minutes of speech is read to the end.
 *
 * It used to be cut at 2400 characters with "that is as far as I will read; the rest
 * is on screen" — and that sentence is the bug: someone listening is listening
 * because they are *not* looking at the screen, so being told to go and look is
 * being told to do the thing they asked the voice for. It fired on the long
 * summaries, which are the ones worth hearing. Stop answers the wrong message.
 */
const essay = `${'Every sentence here is a real sentence with a full stop at the end of it. '.repeat(60)}`;
statusReply = {
  ...statusReply,
  state: 'idle',
  last: { role: 'assistant', text: essay, at: new Date().toISOString() },
};
await tapStatus();
utterances.length = 0;
tapSpeak();
await drain();
const essayHeard = utterances.join(' ');
ok(
  `a very long message was cut short: ${essayHeard.length} characters of ${essay.length} ` +
    'were spoken — the listener is not looking at the screen, which is why they are listening',
  essayHeard.length > essay.length - 20,
);
ok(
  'the read announced that it was stopping early, on a message it read all of',
  !/as far as I will read/.test(essayHeard) && !/rest is on screen/.test(essayHeard),
);
ok(
  'the last sentence of a long message was not the last thing spoken',
  /full stop at the end of it\.$/.test(essayHeard.trim()),
);

// --------------------------------------------- following the sheet while it is open
/*
 * The sheet answers a question whose answer changes while it is on screen: a turn
 * ends, another message is written mid-turn, someone types into the panel. Left
 * alone it kept showing the snapshot from the tap that opened it, and the way to
 * see anything newer was to keep tapping Refresh. So while it is open it asks
 * again every five seconds, and reads out what it finds.
 *
 * Reading out is the part that has to be fenced in rather than merely working:
 * every other utterance in this file starts inside a tap, and these do not. The
 * fence is the sheet — open only because it was just tapped open, on screen while
 * it happens, and dismissing it ends it — so the checks below are mostly about
 * what does *not* speak: an unchanged message, a message that was already there
 * when the sheet opened, and anything at all once the sheet is gone.
 *
 * Everything on a timer in the overlay is gated on the tab being visible, and
 * jsdom reports `prerender`, so nothing above this line has ever run one. It is
 * overridden here rather than at the top deliberately: it also releases the
 * fifteen-second heartbeat, which would otherwise turn up inside the counts below.
 */
Object.defineProperty(doc, 'visibilityState', { configurable: true, get: () => 'visible' });

// Read out of the overlay rather than restated, because the number is the
// requirement: five seconds is what was asked for, and the waits below are timed
// against whatever the file actually says.
const numberOf = (name) => Number(new RegExp(`const ${name} = (\\d+)`).exec(overlayJs)?.[1]);
const SHEET_POLL_MS = numberOf('SHEET_POLL_MS');
const HEARTBEAT_MS = numberOf('STATUS_HEARTBEAT_MS');
ok('the open sheet no longer refreshes every five seconds, which is what was asked for', SHEET_POLL_MS === 5000);

/*
 * Give each piece a duration for the rest of the file, and watch for the reading
 * to *start* rather than checking whether it is still going after a fixed wait.
 * A reading that began and finished inside one `settle` looks identical to one
 * that never began, and this box runs several of these suites at once.
 */
speechMs = 40;
const rise = async (limit = 3000) => {
  const until = Date.now() + limit;
  while (!barBtn.classList.contains('cmo-speaking') && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return barBtn.classList.contains('cmo-speaking');
};

const answer = (text) => ({
  ...statusReply,
  state: 'idle',
  clients: 0,
  last: { role: 'assistant', text, at: new Date().toISOString() },
});

const firstAnswer = 'First answer. The migration script is written.';
statusReply = answer(firstAnswer);
utterances.length = 0;
await tapStatus();
ok(
  'opening the sheet read out the message that was already on it — every tap on the ' +
    'bar would start the phone talking',
  utterances.length === 0,
);

const followHint = () => doc.getElementById('cmo-status-follow')?.textContent ?? '';
ok(
  'the sheet refreshes itself and says nothing about it, so a phone that starts ' +
    'talking has nothing on screen explaining why',
  /every 5 seconds/.test(followHint()),
);
ok('the sheet does not say that a new message will be read aloud', /read/i.test(followHint()));
ok('the sheet does not say how to stop it', /Stop/.test(followHint()));

/*
 * A change found by a background ask. The window regaining focus is one of them,
 * and it takes exactly the path the five-second poll takes — a silent
 * `refreshStatus` — so it stands in for the timer in every check but the cadence
 * one below, which is the only place worth spending real seconds on.
 */
const secondAnswer = 'Second answer. The migration is done, and the tests pass.';
statusReply = answer(secondAnswer);
w.dispatchEvent(new w.Event('focus'));
const startedOnItsOwn = await rise();
await drain();
ok(
  'a message that arrived while the sheet was open never reached it — the sheet is ' +
    'still showing the answer from the tap that opened it',
  doc.getElementById('cmo-status-said')?.textContent === secondAnswer,
);
ok('the message that arrived was not read out', /migration is done/.test(utterances.join(' ')));
ok(
  'a voice that started on its own did not open with why it is talking',
  /^Claude finished\./.test(utterances[0] || ''),
);
ok(
  'the bar offers no Stop for a reading nobody asked for, which is the one that ' +
    'most needs one',
  startedOnItsOwn,
);

utterances.length = 0;
w.dispatchEvent(new w.Event('focus'));
await settle();
ok(
  'the same message was read out again on the next ask — a sheet left open would ' +
    'repeat it every five seconds',
  utterances.length === 0,
);

/*
 * The cadence itself, which is the one thing here that costs real seconds to
 * prove: nothing is touched, and five seconds later the sheet has asked again and
 * read out what came back.
 *
 * The heartbeat is the only other thing that asks unprompted — every fifteen
 * seconds since the page loaded — so the window is nudged clear of it. Otherwise a
 * coincidence and a poll that is really there look the same from here.
 */
const loadedAt = loads()[0].t;
const untilHeartbeat = () => HEARTBEAT_MS - ((Date.now() - loadedAt) % HEARTBEAT_MS);
if (untilHeartbeat() < SHEET_POLL_MS + 900) {
  await new Promise((resolve) => setTimeout(resolve, untilHeartbeat() + 300));
}

const thirdAnswer = 'Third answer. Deployed, and the box is green.';
statusReply = answer(thirdAnswer);
utterances.length = 0;
const asksBefore = statusCalls.length;
await new Promise((resolve) => setTimeout(resolve, SHEET_POLL_MS + 800));
ok(
  'the open sheet never asked again on its own, so it goes on showing the answer ' +
    'from the tap that opened it',
  statusCalls.length > asksBefore,
);
ok(
  'the poll found a newer message and did not put it on the sheet',
  doc.getElementById('cmo-status-said')?.textContent === thirdAnswer,
);
ok('the poll found a newer message and did not read it out', /box is green/.test(utterances.join(' ')));

/*
 * The newest message is the one wanted, so one that lands while the previous is
 * still being read replaces it instead of queueing behind it — a phone reading two
 * answers in a row, oldest first, is worse than one that reads neither.
 */
const longAnswer = 'This is one sentence of a long answer. '.repeat(30);
statusReply = answer(longAnswer);
utterances.length = 0;
w.dispatchEvent(new w.Event('focus'));
// Caught while it is still reading — many pieces at 40 ms each — so the change
// below lands on a message in flight rather than on one already finished.
ok('nothing was still being read, so nothing here can show an interruption', await rise());

const newest = 'Newest answer. Ignore everything above this line.';
statusReply = answer(newest);
utterances.length = 0;
w.dispatchEvent(new w.Event('focus'));
await settle(150);
const afterInterrupt = utterances.join(' ');
ok(
  'a newer message queued behind the one being read instead of replacing it',
  /Ignore everything above/.test(afterInterrupt) && !/one sentence of a long answer/.test(afterInterrupt),
);
await drain();

// A message written mid-turn is not the answer, and being read one that is not the
// answer without being told is how you end up replying to a turn still running.
statusReply = { ...answer('Fourth answer. Running the test suite now.'), state: 'working', clients: 1 };
utterances.length = 0;
w.dispatchEvent(new w.Event('focus'));
await settle();
ok(
  'a message read out mid-turn did not say the turn is still running',
  /^Still working\./.test(utterances[0] || ''),
);
await drain();

/*
 * The other message that is not the answer: the turn was killed partway, so the last
 * thing said is a half-finished thought and nothing is coming after it. Read out bare
 * it is heard as the conclusion, which is how you sit waiting for a turn that has
 * already stopped — the phone-side half of the "Claude finished" bug. `cutOff` comes
 * from /api/claude-status; see NO_ANSWER in chat-service/claude-status.js.
 */
statusReply = { ...answer('Fifth answer, cut off halfway through the sen'), cutOff: 'interrupted' };
utterances.length = 0;
w.dispatchEvent(new w.Event('focus'));
await settle();
ok(
  'a message from a killed turn was read out as though the turn had finished',
  /^Claude stopped before finishing\./.test(utterances[0] || ''),
);
ok(
  'the sheet still calls a killed turn "Your turn", which is what it looks like and ' +
    'not what happened',
  /Claude stopped/.test(doc.querySelector('.cmo-title')?.textContent || ''),
);
ok(
  'the sheet does not say how to pick a cut-off turn back up',
  /continue/.test(doc.getElementById('cmo-sheet')?.textContent || ''),
);
await drain();

/*
 * Dismissing the sheet is how you stop it. The voice already reading a message
 * outlives the sheet on purpose — that is checked further up — but nothing new
 * starts. This is the worst outcome the feature has: a phone talking about a
 * conversation with the sheet that explains it gone, and no Stop in sight but the
 * one on the bar.
 */
doc.getElementById('cmo-status-close').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
statusReply = answer('Fifth answer, said after the sheet was dismissed.');
utterances.length = 0;
w.dispatchEvent(new w.Event('focus'));
await settle();
ok('a message that arrived after the sheet was dismissed was read out anyway', utterances.length === 0);
ok(
  'the dismissed sheet was redrawn behind the scenes, so reopening it skips past the ' +
    'message it was showing',
  !/dismissed/.test(doc.getElementById('cmo-panel')?.textContent ?? ''),
);

/*
 * Another sheet in front of it is the same answer. Layout and the project switcher
 * are one tap from the status sheet and replace it in place, so the conversation it
 * was following is no longer what anyone is looking at — and a voice reading a
 * message out under a sheet about something else is the same wrong as reading one
 * out under a sheet about another conversation, which is checked further up.
 */
await tapStatus();
doc.getElementById('cmo-layout').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
statusReply = answer('Sixth answer, said while the Layout sheet was open.');
utterances.length = 0;
w.dispatchEvent(new w.Event('focus'));
await settle();
ok(
  'a change was read out under a different sheet, which is describing something else',
  utterances.length === 0,
);
speechMs = 0;

// ------------------------------------------------------------- the server voice
/*
 * Reading with Polly instead of with `speechSynthesis`.
 *
 * Everything above is the browser's own voice, which is the fallback and has to
 * keep working on its own — those sections run with /api/voice-status answering
 * 401, which is a real deployment (the editor and the chat API are gated
 * separately) and the one this must not break.
 *
 * This section is the other half: audio synthesised on the box, fetched a piece at
 * a time and played in a chain. Four things about it can fail in ways nothing
 * would report, and they are what is checked here.
 *
 *   **The tap.** iOS grants audio permission to an element, inside a gesture, and
 *   the audio being played does not exist yet at that moment — so the element has
 *   to be unlocked *during* the tap and given its real source afterwards. Get this
 *   wrong and the feature works everywhere except the phone it was written for.
 *
 *   **The chain.** A message is several files. If the next one is not fetched
 *   while the current one plays there are gaps, and if `ended` does not chain, a
 *   phone says the first sentence of a summary and stops — which is worse than
 *   saying nothing, because you would believe it had finished.
 *
 *   **Stop.** Every fetch and every handler outlives the read that started it, so
 *   a piece arriving after Stop must not start playing.
 *
 *   **The fallback.** Every refusal — no budget left, no permission, no network —
 *   has to end with the message being read in the robotic voice rather than with
 *   silence, and the sheet has to say which voice it ended up using.
 */
const audioSrcs = [];   // every src handed to the element, in order
/*
 * Every URL the overlay tried to mint for the element. Has to stay empty — see the
 * policy note in `play` below.
 */
const objectUrls = [];
let audioElements = 0;  // how many elements were created, ever
let audioNode = null;   // the element the overlay is holding
/** Where a piece of the prepared message is fetched from, and played from. */
const segUrl = (n) => `/api/speak?id=aa11bb22cc33dd44&segment=${n}`;

class FakeAudio {
  constructor() {
    audioElements += 1;
    audioNode = this;
    this.src = '';
    this.paused = true;
    this.onended = null;
    this.onerror = null;
    this.preload = '';
  }
  play() {
    audioSrcs.push(this.src);
    /*
     * The Content-Security-Policy, enforced here, because this is the layer that
     * enforces it in a browser and no other layer can see it.
     *
     * This overlay is injected into code-server's workbench, and that page carries
     * code-server's policy: `media-src 'self'`. A `blob:` or `data:` source is not
     * `'self'`, so the element refuses it and reports an `error` — *after* the audio
     * has been fetched. That is how this shipped once: the network showed every mp3
     * arriving with a 200, the server was synthesising and being billed, and the
     * phone read every message in the robotic voice anyway, because a blocked
     * source looks exactly like a broken one and the fallback did its job.
     *
     * So a fake that plays anything it is given cannot see the only bug this
     * section has actually had. This one refuses what the browser refuses.
     */
    if (/^(blob|data):/i.test(this.src)) {
      this.paused = true;
      const blocked = new Error(`media-src 'self' blocked ${this.src}`);
      if (this.onerror) this.onerror(blocked);
      return Promise.reject(blocked);
    }
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  load() {}
  removeAttribute(name) {
    if (name === 'src') this.src = '';
  }
  /** What the browser does when a file finishes: the chain hangs off this. */
  finish() {
    if (this.onended) this.onended();
  }
}
w.Audio = FakeAudio;
// Left in place so that reaching for them is a recorded failure rather than a
// TypeError that could be read as this harness being incomplete.
w.URL.createObjectURL = (blob) => {
  objectUrls.push(blob);
  return `blob:segment-${blob?.segment}`;
};
w.URL.revokeObjectURL = (url) => objectUrls.push(String(url));

voiceReply = {
  configured: true,
  engine: 'generative',
  // The server's default, which is the free provider's voice where there is one — see
  // `preferredVoice` in speak.js. A phone that has never chosen is read in this.
  voice: 'Ava',
  /*
   * Shaped like the real answer, which now has three kinds of voice in it: Polly's,
   * which are per-language and cannot say a word of Hebrew; Azure's, free, a Hebrew
   * pair and an English pair; and the multilingual OpenAI ones, whose `language` is
   * deliberately not a locale. `Lupe` is the one that should be filtered out of a
   * picker on an English phone, and the others are the ones that must not be.
   */
  voices: [
    { id: 'Ava', gender: 'Female', language: 'en-US', provider: 'azure' },
    { id: 'Ruth', gender: 'Female', language: 'en-US', provider: 'polly' },
    { id: 'Matthew', gender: 'Male', language: 'en-US', provider: 'polly' },
    { id: 'Lupe', gender: 'Female', language: 'es-US', provider: 'polly' },
    { id: 'Hila', gender: 'Female', language: 'he-IL', provider: 'azure' },
    { id: 'marin', gender: 'Female', language: 'multi', provider: 'openai' },
  ],
  budget: { day: '2026-09-18', chars: 0, limit: 300000 },
  firstSegmentChars: 160,
};

// The page loaded before any of this was available, which is the normal way round:
// the editor has its own password and the chat service has another, so a phone is
// routinely signed into one and not the other. The voice has to arrive without a
// reload.
const voiceAsks = voiceCalls.length;
statusReply = {
  ...statusReply,
  state: 'idle',
  // An ordinary finished turn: the section above left a cut-off one behind, and
  // what is being checked here is the voice, not the lead-in that explains a turn
  // that stopped.
  cutOff: null,
  last: { role: 'assistant', text: finalMessage, at: new Date().toISOString() },
};
await tapStatus();
ok(
  'the overlay never asked about voices again, so a phone that loaded before it was ' +
    'signed in is stuck with the robotic voice until it is reloaded',
  voiceCalls.length > voiceAsks,
);

const voiceSelect = () => doc.getElementById('cmo-voice');
ok('the sheet offers no way to choose the voice', voiceSelect());
const options = [...(voiceSelect()?.options ?? [])].map((o) => o.value);
ok(
  `the voice picker does not offer the voices the server has: ${options.join(', ')}`,
  options.includes('Ruth') && options.includes('Matthew'),
);
ok(
  'the picker offers voices for a language this phone does not read in, which is ' +
    'thirty options to scroll past on the way to the local ones',
  !options.includes('Lupe'),
);
ok(
  'the robotic voice cannot be chosen, so there is no way back from a voice that ' +
    'costs money or a server that is refusing',
  options.includes('browser'),
);
ok(
  `the picker does not start on the server's own default: ${voiceSelect()?.value}`,
  voiceSelect()?.value === voiceReply.voice,
);
/*
 * The exception to the filter above, and the reason this deployment needed one.
 *
 * Polly has no Hebrew voice at all — forty languages and `he-IL` is not one of them
 * — so on a phone set to English the only voices that can read a Hebrew message are
 * the two whose language does not match the phone. Filtering by `navigator.language`
 * hid exactly those, which left a picker full of voices, none of which could say the
 * message it was sent, and no hint that another one existed.
 */
ok(
  `a Hebrew voice is hidden on an English phone, which is every voice that could read ` +
    `a Hebrew message: ${options.join(', ')}`,
  options.includes('Hila'),
);
ok(
  'the multilingual voice is hidden too — it is the only one that can read a message ' +
    'with Hebrew and English in it, whatever the phone is set to',
  options.includes('marin'),
);
ok(
  `'multi' was shown as if it were a language code: ` +
    `${JSON.stringify([...(voiceSelect()?.options ?? [])].find((o) => o.value === 'marin')?.textContent)}`,
  /any language/.test(
    [...(voiceSelect()?.options ?? [])].find((o) => o.value === 'marin')?.textContent || '',
  ),
);
/*
 * The note about whichever voice the sheet opens on — which is the server's default,
 * so on this deployment it is the free one. What it has to say is what a listener
 * cannot hear: that nothing is being charged, and what happens when the month's
 * allowance is gone.
 */
const note = () => doc.getElementById('cmo-voice-note')?.textContent || '';
ok(
  `the sheet opens on ${voiceSelect()?.value} and describes it as: ${JSON.stringify(note())}`,
  voiceSelect()?.value === 'Ava' && /free tier/.test(note()) && !/seven cents/.test(note()),
);
ok(
  // Both Azure voices are on the one free resource, so the note used to be written for
  // the only one there was. Left that way, the voice everybody is read in by default
  // describes itself as unable to read the language it is reading.
  `the default voice calls itself Hebrew-only: ${JSON.stringify(note())}`,
  !/Hebrew only/i.test(note()),
);
// What each of the others means is different in the two ways that matter — what it
// can read, and what it costs — so the note has to be asked of the voice rather than
// assume whichever one the sheet opened on.
voiceSelect().value = 'Ruth';
voiceSelect().dispatchEvent(new w.Event('change'));
ok(
  'the sheet does not say what the paid voice costs, which is the one thing about ' +
    'it that is not obvious from hearing it',
  /seven cents/.test(note()),
);
ok(
  'the note about Polly does not admit it cannot read Hebrew, which is the reason ' +
    'there is more than one server voice here',
  /No Hebrew/.test(note()),
);
voiceSelect().value = 'Hila';
voiceSelect().dispatchEvent(new w.Event('change'));
ok(
  `choosing the Hebrew voice still describes Polly's bill: ${JSON.stringify(note())}`,
  /free tier/.test(note()) && !/seven cents/.test(note()) && /Hebrew only/i.test(note()),
);
voiceSelect().value = 'marin';
voiceSelect().dispatchEvent(new w.Event('change'));
ok(
  'choosing the multilingual voice does not say that it is the one for a message in ' +
    'two languages, or that it is metered',
  /every language/.test(doc.getElementById('cmo-voice-note')?.textContent || '') &&
    /metered/.test(doc.getElementById('cmo-voice-note')?.textContent || ''),
);
// Back to the default, which is what the section below reads with.
voiceSelect().value = 'Ruth';
voiceSelect().dispatchEvent(new w.Event('change'));
w.localStorage.removeItem('cmo-voice');

// -------------------------------------------------------------- one tap, one read
utterances.length = 0;
audioSrcs.length = 0;
prepareCalls.length = 0;
segmentCalls.length = 0;
tapSpeak();

ok(
  'the audio element was not unlocked inside the tap — a silent file has to be played ' +
    'during the gesture, because the real audio does not exist yet and iOS will not ' +
    'play what no gesture started',
  audioSrcs.length === 1 && audioSrcs[0] === '/api/speak/silence',
);
ok(
  'the bar does not show that it is reading until the network answers, so a tap looks ' +
    'like it did nothing',
  barBtn.classList.contains('cmo-speaking'),
);
ok('the sheet button did not turn into Stop', speakBtn()?.textContent === 'Stop');
ok(
  'the robotic voice spoke as well, so the message is read twice at once',
  utterances.length === 0,
);

await settle();
ok('the server was not asked to prepare anything', prepareCalls.length === 1);
ok(
  `a device that has never chosen a voice named one anyway: ${JSON.stringify(prepareCalls[0]?.voice)} ` +
    '— the default belongs in one place, on the server, and a copy frozen into a ' +
    'phone at first use is a copy that never changes',
  prepareCalls[0]?.voice === '',
);
ok(
  'the markdown was sent as-is, so the voice reads out every asterisk and every slash ' +
    'of every path',
  !/[*`#]|\/workspace\//.test(prepareCalls[0]?.text || 'x*'),
);
ok(
  'the message was sent without the reduction that makes a path a word',
  /auth\.js, line 42 to 51/.test(prepareCalls[0]?.text || ''),
);
ok(
  `the pieces were not fetched one ahead: ${segmentCalls.join(', ')}`,
  segmentCalls.length === 2 && segmentCalls[0] === 0 && segmentCalls[1] === 1,
);
ok(
  `the first piece was not played: ${audioSrcs.join(', ')}`,
  audioSrcs[audioSrcs.length - 1] === segUrl(0),
);
ok(
  'the audio was turned into a blob: URL, which code-server’s `media-src \'self\'` ' +
    'refuses — the mp3 arrives, the element rejects it, and every message is read in ' +
    'the robotic voice instead',
  objectUrls.length === 0,
);

// ------------------------------------------------------------------- the chain
ok(
  'a second audio element was created, and only the first one is unlocked — on iOS ' +
    'every read after the first would be silent',
  audioElements === 1,
);
audioNode.finish();
await settle();
ok(
  `the message stopped after its first piece — a phone that says one sentence of a ` +
    `summary reads as one that finished: ${audioSrcs.join(', ')}`,
  audioSrcs[audioSrcs.length - 1] === segUrl(1),
);
ok(
  `the piece after the one now playing was not fetched: ${segmentCalls.join(', ')}`,
  segmentCalls.includes(2),
);
ok('the bar stopped showing that it is reading mid-message', barBtn.classList.contains('cmo-speaking'));

audioNode.finish();
await settle();
audioNode.finish();
await settle();
ok(
  'the bar still says it is reading after the last piece finished, so the only Stop ' +
    'on screen is one that stops nothing',
  !barBtn.classList.contains('cmo-speaking'),
);
ok('the sheet button did not go back to Read aloud', speakBtn()?.textContent === 'Read aloud');

// ----------------------------------------------------------------------- stopping
segmentCalls.length = 0;
audioSrcs.length = 0;
tapSpeak();
await settle();
const playing = audioNode;
barBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
ok('Stop left the audio playing', playing.paused);
ok('Stop left the source attached, so the browser keeps buffering it', playing.src === '');
const afterStop = audioSrcs.length;
playing.finish();
await settle();
ok(
  'a piece that arrived after Stop went on playing, which is the one thing Stop has ' +
    'to prevent',
  audioSrcs.length === afterStop,
);
ok('Stop left the bar looking like it is still reading', !barBtn.classList.contains('cmo-speaking'));

// -------------------------------------------------------------- when it refuses
/*
 * A refusal has to end with the message being read, not with silence. The budget
 * is the one that will actually happen — it is a 429 with a sentence explaining
 * itself, and the answer is the robotic voice and a note saying so.
 */
await tapStatus();
prepareStatus = 429;
utterances.length = 0;
audioSrcs.length = 0;
tapSpeak();
await settle();
ok(
  'a server that refused to read left the phone silent, with no fallback to the voice ' +
    'the browser has',
  utterances.length > 0,
);
ok(
  'the fallback did not read the message from the top',
  /Fixed the guard/.test(utterances.join(' ')),
);
ok(
  'the sheet does not say which voice it ended up reading with, or why',
  /browser|300000/.test(doc.getElementById('cmo-status-detail')?.textContent || ''),
);
await drain();
prepareStatus = 0;

/*
 * A piece that fails *after* one has played is the opposite case: starting the
 * message again in a different voice is worse than stopping, because what you hear
 * is the same summary twice in two voices with no explanation.
 */
await tapStatus();
refuseSegment = 1;
utterances.length = 0;
tapSpeak();
await settle();
audioNode.finish();
await settle();
ok(
  'a failure halfway through restarted the whole message in the robotic voice',
  utterances.length === 0,
);
ok(
  'nothing says why the reading stopped halfway through',
  /Stopped reading/.test(doc.getElementById('cmo-status-detail')?.textContent || ''),
);
ok('a failed read left the bar showing Stop', !barBtn.classList.contains('cmo-speaking'));
refuseSegment = -1;

// ------------------------------------------------------- choosing the other voice
await tapStatus();
prepareCalls.length = 0;
utterances.length = 0;
voiceSelect().value = 'browser';
voiceSelect().dispatchEvent(new w.Event('change'));
ok(
  'choosing a voice does not say what it means',
  /satnav/.test(doc.getElementById('cmo-voice-note')?.textContent || ''),
);
tapSpeak();
await settle();
ok('the server was still asked to read, after the browser voice was chosen', prepareCalls.length === 0);
ok('the browser voice was not used, after being chosen', utterances.length > 0);
ok(
  'the choice was not remembered, so it has to be made again on every message',
  w.localStorage.getItem('cmo-voice') === 'browser',
);
await drain();

// Back to the server voice, and it has to be remembered as an explicit choice too.
await tapStatus();
prepareCalls.length = 0;
voiceSelect().value = 'Matthew';
voiceSelect().dispatchEvent(new w.Event('change'));
tapSpeak();
await settle();
ok(
  `choosing a named voice did not ask for it: ${prepareCalls[0]?.voice}`,
  prepareCalls[0]?.voice === 'Matthew',
);
ok('switching back to a server voice was not remembered', w.localStorage.getItem('cmo-voice') === 'Matthew');
barBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

/*
 * A message arriving while the sheet is open is read out — the one thing here that
 * is not driven by a tap, and the reason the element is unlocked when the sheet is
 * opened rather than only when Read aloud is pressed.
 */
await tapStatus();
prepareCalls.length = 0;
statusReply = {
  ...statusReply,
  last: { role: 'assistant', text: 'The seventh answer, which arrived by itself.', at: new Date().toISOString() },
};
w.dispatchEvent(new w.Event('focus'));
await settle();
ok(
  'a message that arrived while the sheet was open was not read out in the server voice',
  prepareCalls.length === 1 && /seventh answer/.test(prepareCalls[0]?.text || ''),
);
ok(
  'the arriving message was not announced as one that just landed',
  /^Claude finished\./.test(prepareCalls[0]?.text || ''),
);
barBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

// ------------------------------------------------- reading a code block as code
/*
 * The per-block read button.
 *
 * "Code block." is the right thing to say while reading a summary aloud, and the
 * wrong thing to be stuck with: sometimes the block is the answer. So each fenced
 * block gets a button, and pressing it sends that block to the server as
 * `kind: 'code'` — the words a listener hears are decided in speak.js, so both
 * surfaces hear the same thing and the reduction can change without reshipping
 * this file to a phone that has cached it.
 *
 * Two blocks on purpose: one fenced with backticks and tagged, one fenced with
 * tildes and untagged. The numbering a listener hears has to match the numbering on
 * the buttons, which is the only thing connecting what was skipped to the button
 * that reads it.
 */
const codeMessage = [
  '## Two changes',
  '',
  'The guard, first:',
  '',
  '```js',
  'const speaking = false; // 3 < 4 && "quoted"',
  'if (speaking) stopSpeech();',
  '```',
  '',
  'Then the limit the recognizer refuses past:',
  '',
  '~~~',
  'max_seconds = 55',
  '~~~',
  '',
  'Both are deployed.',
].join('\n');

w.localStorage.setItem('cmo-voice', 'Matthew');
statusReply = {
  ...statusReply,
  last: { role: 'assistant', text: codeMessage, at: new Date().toISOString() },
};
await tapStatus();

const blockBtns = () => [...doc.querySelectorAll('[data-cmo-block]')];
const tapBlock = (i) =>
  blockBtns()[i]?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

ok(
  `the fenced blocks did not each get a button: ${blockBtns().length} for two blocks — ` +
    'a tilde fence is a fence, and an untagged one is the commonest kind',
  blockBtns().length === 2,
);
ok(
  `the button does not say which block it reads, in which language, or how much of ` +
    `it there is: ${JSON.stringify(blockBtns()[0]?.textContent)}`,
  /block 1/i.test(blockBtns()[0]?.textContent || '') &&
    /\bjs\b/.test(blockBtns()[0]?.textContent || '') &&
    /\b2 lines\b/.test(blockBtns()[0]?.textContent || ''),
);
ok(
  `the second button is not the second block, or counts a line as lines: ` +
    `${JSON.stringify(blockBtns()[1]?.textContent)}`,
  /block 2/i.test(blockBtns()[1]?.textContent || '') &&
    /\b1 line\b/.test(blockBtns()[1]?.textContent || ''),
);

// What the read of the message itself says about the blocks it skipped.
prepareCalls.length = 0;
utterances.length = 0;
tapSpeak();
await settle();
ok(
  `the read of the message does not number the blocks it skipped, so "Code block" ` +
    `twice leaves no way to tell which button reads which: ` +
    `${JSON.stringify(prepareCalls[0]?.text)}`,
  /Code block 1\./.test(prepareCalls[0]?.text || '') &&
    /Code block 2\./.test(prepareCalls[0]?.text || ''),
);
ok(
  'the code was read out as part of the message after all',
  !(prepareCalls[0]?.text || '').includes('&&') &&
    !(prepareCalls[0]?.text || '').includes('max_seconds'),
);
ok(
  'the tilde-fenced block was read out as prose — the old strip only knew about ' +
    'backticks, so a tilde fence was spoken character by character',
  !(prepareCalls[0]?.text || '').includes('~~~'),
);
barBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

// And what pressing a block button sends.
prepareCalls.length = 0;
utterances.length = 0;
tapBlock(0);
await settle();
ok(
  `pressing a block button did not ask the server for it: ${prepareCalls.length} calls`,
  prepareCalls.length === 1,
);
ok(
  `the block was sent as prose, so the server reduced nothing and the voice reads ` +
    `the punctuation: ${JSON.stringify(prepareCalls[0]?.kind)}`,
  prepareCalls[0]?.kind === 'code',
);
ok(
  `the language on the fence was not passed on, so the server cannot say what it is ` +
    `reading: ${JSON.stringify(prepareCalls[0]?.lang)}`,
  prepareCalls[0]?.lang === 'js',
);
ok(
  'the block was reduced before being sent — the operators are exactly what the ' +
    'server needs in order to say them as words',
  (prepareCalls[0]?.text || '').includes('&&') &&
    (prepareCalls[0]?.text || '').includes('const speaking'),
);
ok(
  'the fence went with it, so the first thing read is three backticks',
  !(prepareCalls[0]?.text || '').includes('```') &&
    !(prepareCalls[0]?.text || '').includes('Two changes'),
);
ok(
  'the browser voice read the raw code as well, which is the punctuation spelled out',
  utterances.length === 0,
);
ok(
  `the button that is reading does not offer Stop: ${JSON.stringify(blockBtns()[0]?.textContent)}`,
  blockBtns()[0]?.textContent === 'Stop',
);
ok(
  'the other block button says Stop too, so both look like they are reading',
  /block 2/i.test(blockBtns()[1]?.textContent || ''),
);

// Its own button is Stop; a different one switches instead of stopping.
tapBlock(0);
ok('tapping the block that is reading did not stop it', !barBtn.classList.contains('cmo-speaking'));
ok(
  `the button did not go back to its own label after stopping: ` +
    `${JSON.stringify(blockBtns()[0]?.textContent)}`,
  /block 1/i.test(blockBtns()[0]?.textContent || ''),
);

prepareCalls.length = 0;
tapBlock(0);
await settle();
tapBlock(1);
await settle();
ok(
  `tapping the other block did not read it: ${prepareCalls.map((c) => c.text).join(' | ')}`,
  prepareCalls.length === 2 && (prepareCalls[1]?.text || '').includes('max_seconds'),
);
ok(
  `an untagged fence invented a language: ${JSON.stringify(prepareCalls[1]?.lang)}`,
  prepareCalls[1]?.lang === '',
);
barBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

/*
 * A refused code read is a refusal, not a handover.
 *
 * The prose read falls back to the browser's voice, and that is right for prose.
 * For code it would read out every bracket for a minute, so the answer is silence
 * and a sentence saying where the block still is.
 */
prepareStatus = 429;
utterances.length = 0;
tapBlock(0);
await settle();
ok(
  'a refused code read fell back to the browser voice, which reads code out one ' +
    'character at a time — the thing this feature exists to avoid',
  utterances.length === 0,
);
ok(
  `nothing said why the block was not read: ` +
    `${JSON.stringify(doc.getElementById('cmo-status-detail')?.textContent)}`,
  /not read/.test(doc.getElementById('cmo-status-detail')?.textContent || ''),
);
ok('a refused code read left the bar showing Stop', !barBtn.classList.contains('cmo-speaking'));
prepareStatus = 0;

/*
 * A device set to its own voice still sees the buttons, and is told why one cannot
 * work, rather than being quietly overridden or quietly given nothing.
 */
await tapStatus();
voiceSelect().value = 'browser';
voiceSelect().dispatchEvent(new w.Event('change'));
ok(
  'the block buttons vanished when the browser voice was chosen, which explains ' +
    'nothing to someone who wants to hear the code',
  blockBtns().length === 2,
);
prepareCalls.length = 0;
utterances.length = 0;
tapBlock(0);
await settle();
ok(
  'a device set to its own voice had its choice overridden, or spelled the code out',
  prepareCalls.length === 0 && utterances.length === 0,
);
ok(
  `nothing explains why the block was not read on a device set to its own voice: ` +
    `${JSON.stringify(doc.getElementById('cmo-status-detail')?.textContent)}`,
  /server/.test(doc.getElementById('cmo-status-detail')?.textContent || ''),
);
ok(
  'choosing the browser voice does not admit it cannot read a code block',
  /code block/i.test(doc.getElementById('cmo-voice-note')?.textContent || ''),
);
barBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

// Leave the surface as the rest of the file expects to find it: no server voice, so
// the sections after this one exercise the browser's own again.
voiceReply = null;
w.localStorage.removeItem('cmo-voice');

// ----------------------------------------------------- being told from here
/*
 * The notification switch on the editor's own sheet.
 *
 * The push feature notifies about sessions *out here* — the Claude Code panel in
 * this editor, and anything under tmux — and until now the only switch for it was
 * in the chat app's Settings sheet. Someone who only ever opens the editor, which
 * is how this box is actually used, had no way to turn on the one feature written
 * for them; the report that started this was "I don't see push notifications, I
 * don't know how to enable them".
 *
 * The order of the first three acts is the whole of what can go silently wrong:
 * permission must be asked while the tap still counts as user activation (mobile
 * Chrome refuses a prompt that comes after a network round trip), the worker must
 * be the chat app's one so both surfaces share a subscription, and the key must be
 * the server's — a subscription made with the wrong one looks healthy here and
 * fails at the push service for good. None of those report themselves on a phone.
 */
const KEY = 'BOe1x_hUOKzZBnbTz5xLNlOaqZ3Ah3ll7SzKfHRSfrnRHkTKuNJlvBQCLGnJJKKUpUKzIxq2xR2oyF6qkkeGaAo';
const ENDPOINT = 'https://push.example.com/device/abc123';
// Ordered log of everything the switch did, so "asked permission first" and
// "told the server before the browser forgot" can be asserted rather than assumed.
const acts = [];
const registered = [];
const lookups = [];
const posted = {};
let subscribeOpts = null;
let unsubscribeCalls = 0;
let subscription = null;

const makeSubscription = (key, endpoint) => ({
  endpoint,
  options: { applicationServerKey: key },
  // What the browser sends the server: the real thing has a toJSON, and posting
  // the object without it would send `{}`.
  toJSON: () => ({ endpoint, keys: { p256dh: 'p256dh-bytes', auth: 'auth-bytes' } }),
  unsubscribe: () => {
    acts.push('browser-unsubscribe');
    unsubscribeCalls += 1;
    subscription = null;
    return Promise.resolve(true);
  },
});

let subscribeCount = 0;
const registration = {
  scope: 'https://claude.example.com/chat/',
  pushManager: {
    getSubscription: () => Promise.resolve(subscription),
    subscribe: (opts) => {
      acts.push('browser-subscribe');
      subscribeOpts = opts;
      subscribeCount += 1;
      // Each one gets its own endpoint, because a replacement subscription having a
      // different endpoint is the entire point of making one — with a single fixed
      // string, "the server was told about the new subscription" would be true of
      // code that never made one.
      subscription = makeSubscription(
        opts.applicationServerKey,
        subscribeCount === 1 ? ENDPOINT : `${ENDPOINT}-${subscribeCount}`,
      );
      return Promise.resolve(subscription);
    },
  },
};

Object.defineProperty(w.navigator, 'serviceWorker', {
  configurable: true,
  value: {
    register: (url) => {
      acts.push('register');
      registered.push(String(url));
      return Promise.resolve(registration);
    },
    // Nothing to hand back until something has registered one, which is what makes
    // "opening the editor installs nothing" checkable.
    getRegistration: (scope) => {
      // Logged in both places: `lookups` is which scope, and `acts` is when — the
      // ordering check below is only worth anything if a read counts as an act, since
      // reading the state is the easiest thing to accidentally await before the
      // permission prompt.
      lookups.push(String(scope));
      acts.push('lookup');
      return Promise.resolve(registered.length ? registration : null);
    },
  },
});
w.PushManager = function PushManager() {};
class FakeNotification {}
FakeNotification.permission = 'default';
let permissionAnswer = 'granted';
FakeNotification.requestPermission = () => {
  acts.push('permission');
  FakeNotification.permission = permissionAnswer;
  return Promise.resolve(permissionAnswer);
};
w.Notification = FakeNotification;

const jsonReply = (body, status = 200) =>
  Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });

/*
 * What the two POSTs answer, one entry per call, the last one reused.
 *
 * Both of them carry news this side cannot work out for itself: whether the push
 * service has forgotten the endpoint the browser keeps handing over. `mine` is this
 * device's own result rather than a fleet total — the total is what let a phone
 * report a test notification as sent one second after its own was refused.
 */
const answers = {
  subscribe: [{ ok: true, devices: 1 }],
  test: [{ sent: 1, devices: 1, mine: { ok: true, status: 201, gone: false } }],
};

/*
 * What the server says this project's manifest is. Mutable because the install check
 * has to be asked the same question twice: once about a page inside the app's scope
 * and once about a page outside it, which are the two answers it exists to tell
 * apart. This document is at /editor/ (see the URL above), so `/p/demo/` is the
 * out-of-scope case.
 */
let fakeManifest = { id: '/p/demo/', short_name: 'demo', scope: '/p/demo/' };
const priorFetch = w.fetch;
w.fetch = (url, options = {}) => {
  const target = String(url);
  if (target.includes('/api/push/key')) {
    acts.push('key');
    return jsonReply({ key: KEY });
  }
  if (target.includes('/api/push/subscribe')) {
    acts.push('server-subscribe');
    posted.subscribe = JSON.parse(options.body || '{}');
    return jsonReply(answers.subscribe.length > 1 ? answers.subscribe.shift() : answers.subscribe[0]);
  }
  if (target.includes('/api/push/unsubscribe')) {
    acts.push('server-unsubscribe');
    posted.unsubscribe = JSON.parse(options.body || '{}');
    return jsonReply({ ok: true });
  }
  if (target.includes('/api/push/test')) {
    acts.push('test');
    posted.test = JSON.parse(options.body || '{}');
    return jsonReply(answers.test.length > 1 ? answers.test.shift() : answers.test[0]);
  }
  if (target.includes('manifest.webmanifest')) {
    return jsonReply(fakeManifest);
  }
  return priorFetch(url, options);
};

const notifyBtn = () => doc.getElementById('cmo-notify');
const notifyLine = () => doc.getElementById('cmo-notify-status')?.textContent ?? '';
const tapNotify = async () => {
  notifyBtn()?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await settle(80);
};

await tapStatus();
await settle(40);
ok(
  'the status sheet offers no way to be told when a turn ends — the only switch for ' +
    'it is in the chat app, which someone who lives in the editor never opens',
  notifyBtn(),
);
ok(
  'drawing the sheet registered a service worker uninvited — opening the editor must ' +
    'install nothing on a device that has never asked for notifications',
  registered.length === 0,
);
ok(
  'the subscription was looked up outside the chat app’s scope, so the editor and the ' +
    'chat app would each hold one and only one of them would be told to stop',
  lookups.length > 0 && lookups.every((s) => s === '/chat/'),
);
ok(
  'the switch does not say what the notifications are about, so it reads as "notify me ' +
    'about something"',
  /tmux/.test(notifyLine()),
);

// Cleared so that the first act *after the tap* is what is being asserted about,
// rather than whatever drawing the sheet did before it.
acts.length = 0;
await tapNotify();
ok(
  `permission was asked after something was awaited (${acts.join(' → ')}) — mobile ` +
    'Chrome refuses a prompt that is no longer the consequence of the tap',
  acts[0] === 'permission',
);
ok(
  `the worker registered was not the chat app’s: ${JSON.stringify(registered)} — a ` +
    'second worker means a second subscription the chat app cannot see',
  registered.length === 1 && registered[0] === '/chat/sw.js',
);
ok(
  'the subscription was not made userVisibleOnly, which Chrome requires and which is ' +
    'true of every push this app sends',
  subscribeOpts?.userVisibleOnly === true,
);
const sentKey = subscribeOpts?.applicationServerKey;
ok(
  `the application server key is not a P-256 point: ${sentKey?.length} bytes starting ` +
    `${sentKey?.[0]} — a subscription made with the wrong key looks healthy here and ` +
    'fails at the push service forever',
  sentKey?.length === 65 && sentKey[0] === 4,
);
ok(
  'the server was never told which device to send to',
  posted.subscribe?.endpoint === ENDPOINT && Boolean(posted.subscribe?.keys?.auth),
);
ok(
  `the order was wrong: ${acts.join(' → ')} — the key has to be in hand before ` +
    'subscribing, and the server told before anything is sent',
  acts.indexOf('key') < acts.indexOf('browser-subscribe') &&
    acts.indexOf('browser-subscribe') < acts.indexOf('server-subscribe') &&
    acts.indexOf('server-subscribe') < acts.indexOf('test'),
);
ok(
  'no test notification was sent, so a switch that has quietly failed looks exactly ' +
    'like one that worked until the notification that mattered is missed',
  acts.includes('test'),
);
ok(
  'the switch still offers to turn notifications on after turning them on',
  /Turn off/.test(notifyBtn()?.textContent ?? ''),
);
ok(
  'the test did not say which device asked, so the server can only answer with a total ' +
    'across every device — and a desktop that received it makes this phone say "sent"',
  posted.test?.endpoint === ENDPOINT,
);
ok('nothing said that a test notification had been sent', /test notification/.test(notifyLine()));

/*
 * The sheet redraws itself every five seconds, and what the switch just said has to
 * survive that: a line reading "a test notification has just been sent" is worth
 * nothing if the poll wipes it two seconds later.
 */
statusReply = answer('Seventh answer, arriving just after the switch was used.');
w.dispatchEvent(new w.Event('focus'));
await settle(120);
await drain();
ok(
  'the sheet’s own refresh wiped what the switch had just said',
  /test notification/.test(notifyLine()),
);
ok(
  'the switch forgot it was on when the sheet refreshed itself',
  /Turn off/.test(notifyBtn()?.textContent ?? ''),
);

await tapNotify();
ok(
  'the server was not told the device is going away — it would go on sending to an ' +
    'endpoint the browser has dropped',
  posted.unsubscribe?.endpoint === ENDPOINT,
);
ok(
  `the browser dropped the subscription before the server was told: ${acts.join(' → ')} ` +
    '— after that the endpoint that identifies this device is gone',
  acts.indexOf('server-unsubscribe') < acts.indexOf('browser-unsubscribe'),
);
ok('the browser still holds a subscription', unsubscribeCalls === 1 && subscription === null);
ok(
  'the switch does not offer to turn notifications back on',
  /Notify me/.test(notifyBtn()?.textContent ?? ''),
);

/*
 * The failure all of this was built for, and the reason it went a day unnoticed:
 * the push service forgets a device while the browser goes on handing out the same
 * subscription, still carrying the right key. Nothing on this side can tell — the
 * only evidence anywhere is the refusal the server hears — so the recovery has to be
 * driven by what the server says back, and it has to happen on the tap rather than
 * being reported as a problem for someone to solve.
 */
acts.length = 0;
const subscribesBefore = subscribeCount;
answers.test = [
  { sent: 0, devices: 1, failed: 1, pruned: 1, mine: { ok: false, status: 410, gone: true } },
  { sent: 1, devices: 1, mine: { ok: true, status: 201, gone: false } },
];
await tapNotify();
ok(
  `a device told its own endpoint was refused kept it: ${acts.join(' → ')} — it will ` +
    're-offer the dead endpoint on every load, be pruned again, and never buzz',
  subscribeCount - subscribesBefore === 2,
);
ok(
  'the refused subscription was not dropped at the browser first, so the replacement is ' +
    'the same endpoint again',
  acts.filter((a) => a === 'browser-unsubscribe').length === 1,
);
ok(
  `the server was not given the replacement: ${JSON.stringify(posted.subscribe?.endpoint)}`,
  posted.subscribe?.endpoint === `${ENDPOINT}-${subscribeCount}`,
);
ok(
  `the replacement was never tested: ${acts.join(' → ')} — the recovery is only worth ` +
    'anything if it is checked before the switch claims to be on',
  acts.filter((a) => a === 'test').length === 2 && posted.test?.endpoint === `${ENDPOINT}-${subscribeCount}`,
);
ok(
  `after recovering, the switch does not say a notification was sent: ${notifyLine()}`,
  /test notification has just been sent/.test(notifyLine()),
);

/*
 * The same news, arriving at the other end: the server already knew this endpoint was
 * refused, so it says so when it is offered again. That is the silent case — no tap,
 * no test, just a page load — and answering it here is what stops the loop.
 */
await tapNotify();
acts.length = 0;
const beforeGoneSubscribe = subscribeCount;
answers.subscribe = [{ gone: true }, { ok: true, devices: 1 }];
answers.test = [{ sent: 1, devices: 1, mine: { ok: true, status: 201, gone: false } }];
await tapNotify();
ok(
  `the server said the endpoint it was offered is gone and the device kept it anyway: ${acts.join(' → ')}`,
  subscribeCount - beforeGoneSubscribe === 2,
);
ok(
  'the endpoint the server refused is the one it ended up holding',
  posted.subscribe?.endpoint === `${ENDPOINT}-${subscribeCount}`,
);
ok(
  `a server that answers "gone" twice loops: ${acts.filter((a) => a === 'server-subscribe').length} ` +
    'subscribe posts for one tap',
  acts.filter((a) => a === 'server-subscribe').length === 2,
);

/*
 * A refusal that is not "gone" — a rate limit, a push service having a bad day —
 * cannot be recovered from here, and the only wrong answer is to claim it worked.
 */
await tapNotify();
acts.length = 0;
answers.subscribe = [{ ok: true, devices: 1 }];
answers.test = [{ sent: 0, devices: 1, failed: 1, mine: { ok: false, status: 429, gone: false } }];
await tapNotify();
ok(
  `the push service refused this device and the switch said it worked: ${notifyLine()}`,
  /refused/.test(notifyLine()) && /429/.test(notifyLine()),
);
ok(
  'a refusal that is not "gone" resubscribed anyway, which loses a working subscription ' +
    'to a temporary error',
  acts.filter((a) => a === 'browser-subscribe').length === 1,
);

// Back to a server that works, for whatever runs after this.
await tapNotify();
answers.test = [{ sent: 1, devices: 1, mine: { ok: true, status: 201, gone: false } }];

/*
 * A site that has been refused permission cannot ask again — the browser answers
 * once — so a button there does nothing at all, and the only useful thing to show
 * is where the setting now lives.
 */
FakeNotification.permission = 'denied';
await tapStatus();
await settle(40);
ok(
  'a site with notifications blocked still shows a switch, which cannot do anything ' +
    'and reads as broken',
  !notifyBtn(),
);
ok(
  'a blocked site is not told where the setting now lives, which is the only place it ' +
    'can be changed',
  /Site settings/.test(doc.getElementById('cmo-panel')?.textContent ?? ''),
);

// ------------------------------------------------- why the install was refused
/*
 * "It says this app is already installed" cannot be reproduced anywhere but the
 * phone that said it: whether Chrome offers an install depends on what is on that
 * home screen. Android matches an installed web app to a page by scope, and the
 * chat app's manifest claims the whole origin — so the chat icon is the first
 * suspect, and this check is how the device names it instead of being guessed at
 * from here. It has to print the build too: a workbench left open across a deploy
 * runs the script it loaded, which is the other explanation for a control that
 * appears to do nothing.
 */
Object.defineProperty(w.navigator, 'getInstalledRelatedApps', {
  configurable: true,
  value: () =>
    Promise.resolve([
      { platform: 'webapp', url: 'https://claude.example.com/chat/manifest.webmanifest', id: 'Claude' },
    ]),
});

const buildStamp = /const OVERLAY_BUILD = '([^']+)'/.exec(overlayJs)?.[1];
ok('the overlay carries no build stamp, so a stale page cannot be told from a bug', buildStamp);

await openSwitcher();
ok(
  'the switcher offers no way to find out why an install was refused, and the answer ' +
    'only exists on the phone',
  doc.getElementById('cmo-install-why'),
);
doc.getElementById('cmo-install-why').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await settle(80);
const why = doc.getElementById('cmo-install-status')?.textContent ?? '';
ok(
  'the install check does not say which build of the overlay answered — a page open ' +
    'across a deploy is the other explanation for a missing feature',
  why.includes(buildStamp),
);
ok(
  'the install check does not name the manifest this page would install',
  /manifest\.webmanifest\?project=demo/.test(why),
);
ok('the install check does not report the identity the server gave it', /id \/p\/demo\//.test(why));
ok(
  'the install check does not say whether Chrome offered an install, which is the ' +
    'thing being asked about',
  /Chrome has not offered/.test(why),
);
ok(
  'the install check does not name the installed app Chrome thinks this page belongs ' +
    'to, which is the whole reason it exists',
  /Claude/.test(why),
);
/*
 * And says what to do about it, which changed once Chrome's rule was read rather than
 * inferred. The advice used to be "remove the chat icon and add it again", on the
 * theory that the icon held a stale scope. It does not help: `isAppInstalledForUrl` is
 * `hasAtLeastOneWebApkForOrigin`, so *any* installed app on this origin turns Chrome's
 * own menu into "already installed" for every page here, freshly installed or not.
 * What works is the page's own offer, so that is what the report has to point at.
 */
ok(
  'the install check names the app in the way but not what to do about it',
  /button above/.test(why),
);
ok(
  'the install check blames the installed app without saying that the refusal is per ' +
    'origin — the one fact that stops someone reinstalling the chat icon to no effect',
  /per origin/.test(why),
);

/*
 * The other reason Chrome offers no install, and the one this shape introduced: a
 * page outside the scope of the manifest it links. /p/<name>/ is a narrow scope by
 * design, so the editor's older addresses — /editor/?folder=…, or the catch-all —
 * are outside every project's app, and Chrome's silence there is indistinguishable
 * from "already installed" unless something says so. This document is at /editor/.
 */
ok(
  'the install check does not notice that this page is outside the manifest’s scope, ' +
    'which is a silence that looks exactly like "already installed"',
  /outside that scope/.test(why),
);
ok(
  'the install check reports the page as out of scope without saying which page',
  new RegExp(`at ${w.location.pathname}`).test(why),
);

// And the same question about a page the manifest does claim, which must not be
// reported as a problem: an inverted or unconditional test here would read as a
// permanent excuse for a missing install button.
fakeManifest = { ...fakeManifest, scope: '/editor/' };
doc.getElementById('cmo-install-why').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await settle(80);
const whyInScope = doc.getElementById('cmo-install-status')?.textContent ?? '';
ok(
  'a page inside the manifest’s scope is still reported as outside it',
  whyInScope.includes('scope /editor/') && !/outside that scope/.test(whyInScope),
);
fakeManifest = { ...fakeManifest, scope: '/p/demo/' };

// --------------------------------------------------------- markdown, rendered
/*
 * The sheet is where a final message is read on a phone, and a final message is
 * written: bold, bullets, a fenced diff in the middle of it. It used to show the
 * asterisks.
 *
 * Two kinds of check here, and the second kind is the one that matters. The first
 * is that each form becomes the element it should. The second is that *no* model
 * text ever becomes markup — the renderer builds nodes and puts text through
 * `textContent`, and the way that regresses is someone finding it easier to
 * assemble a string and assign `innerHTML`. Both the HTML in the fenced block and
 * the `javascript:` URL below are there to fail loudly if that happens.
 */
const openFresh = async (text) => {
  doc.getElementById('cmo-status-close')?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await settle(30);
  statusReply = answer(text);
  await tapStatus();
  await settle(30);
  return doc.getElementById('cmo-status-said');
};

const md = await openFresh(
  [
    '## Heading with `code` in it',
    '',
    'Paragraph with **bold**, *italic*, __also bold__ and a [link](https://example.com/x).',
    'Wrapped onto a second line.',
    '',
    '- first bullet, **emphasised**',
    '- second bullet',
    '',
    '3. step three',
    '4. step four',
    '',
    '---',
    '',
    '```js',
    'const a = 1 < 2;',
    '  if (a) console.log("<b>hi</b>");',
    '```',
    '',
    'Tap [here](javascript:alert(1)) to see.',
  ].join('\n'),
);

ok(
  'the message is still shown as its own source — the markdown markers are on screen',
  !/[*`#]/.test(md?.textContent ?? '') && !/^\s*-\s/m.test(md?.textContent ?? ''),
);
ok('a heading was not rendered as one', /Heading with/.test(md?.querySelector('.cmo-md-h')?.textContent ?? ''));
ok(
  'inline markdown inside a heading was left as source, so a heading is the one place ' +
    'backticks still show',
  md?.querySelector('.cmo-md-h code')?.textContent === 'code',
);
ok(
  '**bold** did not become bold, which is the marker that started this',
  [...(md?.querySelectorAll('strong') ?? [])].some((el) => el.textContent === 'bold'),
);
ok('__bold__ did not become bold', [...(md?.querySelectorAll('strong') ?? [])].some((el) => el.textContent === 'also bold'));
ok('*italic* did not become italic', md?.querySelector('em')?.textContent === 'italic');
ok(
  'a wrapped sentence became two paragraphs, so a message reads as though it were ' +
    'broken up',
  [...(md?.querySelectorAll('p') ?? [])].some(
    (el) => /Paragraph with/.test(el.textContent) && /second line/.test(el.textContent),
  ),
);
ok('a bulleted list did not become a list', md?.querySelectorAll('ul li').length === 2);
ok(
  'inline markdown inside a list item was left as source',
  md?.querySelector('ul li strong')?.textContent === 'emphasised',
);
ok('a numbered list did not become one', md?.querySelectorAll('ol li').length === 2);
ok(
  'a numbered list that starts at 3 restarts at 1, so the steps are renumbered under ' +
    'the reader',
  md?.querySelector('ol')?.getAttribute('start') === '3',
);
ok('a rule between sections did not become one', md?.querySelectorAll('hr').length === 1);
ok(
  'a fenced block did not become a code block',
  md?.querySelector('pre code')?.textContent ===
    'const a = 1 < 2;\n  if (a) console.log("<b>hi</b>");',
);
ok(
  'HTML inside a fenced block became an element: model output is being assigned as ' +
    'markup somewhere in the renderer',
  !md?.querySelector('pre b'),
);
ok(
  'a link in the message is not tappable',
  md?.querySelector('a[href="https://example.com/x"]')?.textContent === 'link',
);
ok(
  'a link opens over the workbench instead of beside it',
  md?.querySelector('a[href="https://example.com/x"]')?.target === '_blank' &&
    /noopener/.test(md?.querySelector('a[href="https://example.com/x"]')?.rel ?? ''),
);
ok(
  'a javascript: URL from a model became a link — one tap would run whatever the ' +
    'message asked for, in a page that can drive the editor',
  ![...(md?.querySelectorAll('a') ?? [])].some((el) =>
    /^javascript:/i.test(el.getAttribute('href') || ''),
  ),
);
ok(
  'a link that was refused vanished instead of staying readable as text',
  /here \(javascript:alert\(1\)\)/.test(md?.textContent ?? ''),
);

/*
 * Tables, which are most of what a status answer is made of — surface, check,
 * result — and which were left out of the first version of the renderer on the
 * grounds that they do not fit a phone. A table left as source does not fit a phone
 * either; it is a screenful of pipes. The fixture is shaped like the real thing,
 * including inline code in the cells and a row shorter than its header.
 */
const table = await openFresh(
  [
    'Checked rather than asserted:',
    '',
    '| Surface | Check | Result |',
    '|---|---|---|',
    '| `site/index.html` | local md5 vs S3 ETag | both |',
    '| git | `git status`, `origin/main..HEAD` | clean |',
    '| api/index.js | live |',
    '',
    'Nothing under api/ has changed.',
  ].join('\n'),
);
ok('a table was not rendered as one', table?.querySelectorAll('table').length === 1);
ok(
  'the table has no header row, so the columns are unlabelled',
  [...(table?.querySelectorAll('th') ?? [])].map((el) => el.textContent).join(',') ===
    'Surface,Check,Result',
);
ok('the table lost or gained rows', table?.querySelectorAll('tbody tr').length === 3);
ok(
  'a row shorter than the header was not padded, so every column after the gap ' +
    'misaligns',
  [...(table?.querySelectorAll('tbody tr') ?? [])].every((tr) => tr.cells.length === 3),
);
ok(
  'inline markdown inside a cell was left as source',
  table?.querySelector('tbody td code')?.textContent === 'site/index.html',
);
ok(
  'the alignment row was rendered as a row of dashes instead of being read',
  !/-{3}/.test(table?.textContent ?? ''),
);
ok(
  'the pipes are still on screen, which is the whole complaint',
  !/\|/.test(table?.textContent ?? ''),
);
ok(
  'the table is not wrapped in anything that can scroll sideways, so three columns ' +
    'of prose either wrap into a wall or push the sheet off the screen',
  table?.querySelector('.cmo-md-table > table'),
);
ok(
  'the prose around the table was swallowed by it',
  /Checked rather than asserted:/.test(table?.textContent ?? '') &&
    /Nothing under api\/ has changed\./.test(table?.textContent ?? ''),
);

/*
 * A header alone is ambiguous — plenty of sentences contain a pipe — so it is the
 * alignment row underneath that makes a table. Without this check the renderer
 * turns a shell pipeline into a one-row table.
 */
const piped = await openFresh('Run `ps aux | grep node` and read it.\nThen | tidy up.');
ok(
  'a sentence with a pipe in it became a table',
  !piped?.querySelector('table') && /ps aux \| grep node/.test(piped?.textContent ?? ''),
);

const aligned = await openFresh('| a | b | c |\n|:---|---:|:---:|\n| 1 | 2 | 3 |');
ok(
  'the column alignments in the delimiter row were ignored',
  [...(aligned?.querySelectorAll('thead th') ?? [])].map((el) => el.style.textAlign).join(',') ===
    'left,right,center',
);

/*
 * The chip and the conversation list are one line of plain text each, so they get
 * the markers taken off instead of rendered. The fixture is the artefact from the
 * phone: an answer whose second paragraph opens with `**`, cut to length, arriving
 * in the list as a stray pair of asterisks hanging off the previous sentence.
 */
const marked = 'Done with my half. Here is where things stand.\n\n**Shipped** the `renderer` and:\n\n- one\n- two';
statusReply = {
  ...answer(marked),
  conversations: [
    { sessionId: 'abc123', state: 'idle', title: 'Naming the windows', said: marked, at: Date.now() },
    { sessionId: 'def456', state: 'idle', said: '## Heading\n\nA second one.', at: Date.now() },
  ],
};
doc.getElementById('cmo-status-close')?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await settle(30);
await tapStatus();
await settle(30);
ok(
  'the chip shows the markdown it was written with, so a one-line summary ends in a ' +
    'stray marker',
  !/[*`#]/.test(doc.getElementById('cmo-chip')?.querySelector('.cmo-chip-text')?.textContent ?? ''),
);
ok(
  'stripping the markers ate the words with them',
  /Done with my half/.test(
    doc.getElementById('cmo-chip')?.querySelector('.cmo-chip-text')?.textContent ?? '',
  ),
);
/*
 * The list is titles, and nothing else.
 *
 * It used to fall back to the opening of the last message, which read as a list of
 * five rows all starting "Done —" and, worse, made a real bug invisible: the title
 * was read from a field the CLI does not write, so every row took the fallback and
 * the list looked wordy rather than broken. A row with no title now says so.
 */
const labels = [...doc.querySelectorAll('#cmo-convos .cmo-convo-label')].map((el) => el.textContent);
ok(
  `the titled conversation is not listed under its title: ${JSON.stringify(labels[0])}`,
  labels[0] === 'Naming the windows',
);
ok(
  `a conversation with no title is labelled with its last message: ${JSON.stringify(labels[1])}`,
  labels[1] === 'Untitled conversation',
);
ok(
  'the list quotes what was said somewhere in a row label',
  !labels.join(' | ').includes('Heading') && !labels.join(' | ').includes('Done with my half'),
);

/*
 * A transcript is read while it is still being written, so the fence at the end of
 * a half-written block has not arrived yet. Dropping the block until it closes
 * would blank the most recent thing Claude said.
 */
const partial = await openFresh('Here it is:\n\n```\nunfinished output');
ok(
  'a code block that has not been closed yet is dropped, so a message being written ' +
    'loses its tail',
  partial?.querySelector('pre code')?.textContent === 'unfinished output',
);

/*
 * Anything unrecognised has to come out as the characters it went in as — an ASCII
 * diagram or a stack trace is not markdown, and this sheet showed it correctly
 * before there was a renderer at all.
 */
const plain = await openFresh('Layout:\n  a -> b\n  b -> c');
ok(
  'an indented diagram lost its leading spaces, so anything drawn in text collapses',
  /Layout:\n {2}a -> b\n {2}b -> c/.test(plain?.textContent ?? ''),
);

// --------------------------------------------- the prompt it started with
/*
 * The opening prompt, on the sheet and on the clipboard.
 *
 * What it is for: the message most worth sending again is the one a conversation
 * began with, and it is the one a long conversation buries — once it has been
 * compacted the CLI's own history no longer holds it, and nobody scrolls a 12MB
 * transcript back to the top on a phone. The transcript still has it at the front of
 * the file, so the sheet that already answers "what is going on in this
 * conversation" is where it belongs.
 *
 * Three properties are worth more than the rendering here. It must be the text that
 * was typed, character for character, because it is going straight back into Claude's
 * input. It must be asked for once per conversation and not on every poll, because
 * the sheet redraws itself every few seconds while it follows a turn. And a failed
 * ask must leave the sheet exactly as it was — this thing floats over someone's
 * editor, and the editor and the chat API are gated separately.
 */
doc.getElementById('cmo-status-close')?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await settle(30);

// Newlines, markdown characters and a backtick, because this is shown as typed
// rather than rendered — and copied as typed, which is the part that matters.
const opening = 'Reuse the **first** prompt I sent.\n\nIt is the one worth `sending` again.';
firstPromptReply = (sessionId) => ({
  cwd: '/workspace/projects/demo',
  sessionId,
  text: sessionId === 'abc123' ? opening : `whatever ${sessionId} began with`,
  at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
  chars: opening.length,
});
firstPromptCalls.length = 0;
statusReply = { ...answer('Shipped it.'), sessionId: 'abc123' };
await tapStatus();
await settle(30);

const firstEl = () => doc.getElementById('cmo-first-block')?.querySelector('.cmo-first');
ok('the sheet does not show the prompt the conversation started with', firstEl());
ok(
  `the opening prompt was not shown as it was typed: ${JSON.stringify(firstEl()?.textContent)}`,
  firstEl()?.textContent === opening,
);
ok(
  'the opening prompt was rendered as markdown — it is a thing to copy, not a message to read',
  !firstEl()?.querySelector('strong') && !firstEl()?.querySelector('code'),
);
ok(
  'the sheet does not say when the conversation started, which is how you tell two of them apart',
  /3 h ago/.test(doc.querySelector('#cmo-first-block .cmo-section')?.textContent ?? ''),
);
ok(
  `the route was asked about the wrong conversation: ${JSON.stringify(firstPromptCalls)}`,
  firstPromptCalls.length === 1 &&
    firstPromptCalls[0].sessionId === 'abc123' &&
    firstPromptCalls[0].cwd === '/workspace/projects/demo',
);

// The redraw the sheet does on its own, every few seconds while it follows a turn.
// Re-asking here would re-send a paragraph that cannot have changed, over and over.
statusReply = { ...answer('Shipped it, and started the deploy.'), sessionId: 'abc123' };
await settle(6000);
ok(
  `the opening prompt was asked for again on a redraw: ${firstPromptCalls.length} asks`,
  firstPromptCalls.length === 1,
);
ok('the opening prompt vanished when the sheet redrew itself', firstEl()?.textContent === opening);

copied.length = 0;
// Optional, so a missing button is reported as the failure below rather than
// crashing the run and taking the rest of the failures with it.
doc.getElementById('cmo-first-copy')?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await settle(30);
ok(
  `Copy put something other than the opening prompt on the clipboard: ${JSON.stringify(copied)}`,
  copied.length === 1 && copied[0] === opening,
);
ok(
  'Copy said nothing about what to do with what it copied',
  /paste/i.test(doc.getElementById('cmo-first-status')?.textContent ?? ''),
);
// The input it is going to be pasted into is behind this sheet, so the copy closes
// it — the same handover the dictation sheet does.
await settle(1200);
ok('Copy left the sheet over the editor it is about to be pasted into', !sheet.classList.contains('cmo-open'));

// Another conversation is another prompt, and is asked for on its own.
statusReply = { ...answer('The other one finished too.'), sessionId: 'def456' };
await tapStatus();
await settle(30);
ok(
  `switching conversations did not ask about the new one: ${JSON.stringify(firstPromptCalls)}`,
  firstPromptCalls.length === 2 && firstPromptCalls[1].sessionId === 'def456',
);
ok(
  `the sheet kept the previous conversation's opening prompt: ${JSON.stringify(firstEl()?.textContent)}`,
  firstEl()?.textContent === 'whatever def456 began with',
);

/*
 * A conversation nobody typed the start of — one opened by another session's
 * message. Saying so is the point: an empty space where the prompt goes reads as a
 * feature that is broken.
 */
firstPromptReply = (sessionId) => ({ cwd: '/workspace/projects/demo', sessionId, text: null, at: null, chars: 0 });
statusReply = { ...answer('Answered a peer.'), sessionId: 'peer789' };
await tapStatus();
await settle(30);
ok(
  'a conversation with no typed opening leaves a blank space where the prompt goes',
  /no opening prompt/i.test(doc.getElementById('cmo-first-block')?.textContent ?? ''),
);

/*
 * And the failure that must be invisible: the chat service refuses this route while
 * code-server is perfectly happy, which is what a lapsed session looks like out
 * here. Nothing about the sheet may change.
 */
firstPromptReply = null;
statusReply = { ...answer('Still readable.'), sessionId: 'lapsed999' };
await tapStatus();
await settle(30);
ok(
  'a refused opening-prompt ask put something on the sheet anyway',
  (doc.getElementById('cmo-first-block')?.textContent ?? '') === '',
);
ok(
  'a refused opening-prompt ask took the rest of the sheet with it',
  /Still readable\./.test(doc.getElementById('cmo-status-said')?.textContent ?? ''),
);
doc.getElementById('cmo-status-close')?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await settle(30);

// -------------------------------------------- taking the answer off the sheet
/*
 * Selecting and copying what Claude said.
 *
 * Reading is not all anybody does with an answer: a line of it goes into a commit
 * message, a path out of it goes into a terminal. None of that was possible here. The
 * overlay is appended to the workbench's `<body>`, which sets `user-select: none` —
 * reasonable for an editor, where a drag across the sidebar should not highlight it —
 * and inherited by every block on the sheet, so a long-press over the message selected
 * nothing at all.
 *
 * jsdom does not inherit `user-select` down the tree, so the first check is that the
 * block declares itself selectable, not that a selection would work in a browser. That
 * declaration is the thing that regresses: it is one line, it has no visible effect
 * until somebody tries to copy something, and it was missing for as long as this sheet
 * existed.
 */
firstPromptReply = null;
// Markdown, because the markdown is what goes on the clipboard: an answer is copied
// into something that is itself text, and the fence is the part that survives.
const takeaway = 'Shipped **it**.\n\n```sh\ngit push origin main\n```';
const takeawayEl = await openFresh(takeaway);
/** Select the message, as a long-press or a drag through it does. */
const selectMessage = () => {
  const range = doc.createRange();
  range.selectNodeContents(saidEl());
  const selection = w.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
};
ok(
  'the message block does not declare itself selectable, so it inherits the workbench’s ' +
    'body { user-select: none } and no part of an answer can be selected or copied',
  w.getComputedStyle(takeawayEl).userSelect === 'text',
);

copied.length = 0;
const copyNote = () => doc.getElementById('cmo-said-copy-note')?.textContent ?? '';
// Optional, so a missing button is this failure rather than a crash that takes the
// rest of the run with it.
doc.getElementById('cmo-said-copy')?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await settle(30);
ok(
  `Copy put something other than the message Claude wrote on the clipboard: ${JSON.stringify(copied)}`,
  copied.length === 1 && copied[0] === takeaway,
);
ok('Copy did not say it had copied anything', /copied/i.test(copyNote()));
/*
 * And it leaves the sheet up, where the opening prompt's Copy closes it. The
 * difference is where the text is going: a prompt is on its way into Claude's input,
 * which is behind this sheet, and an answer is on its way out of this machine
 * entirely — closing then hides the rest of the message being quoted from.
 */
await settle(1200);
ok(
  'Copy closed the sheet, taking the message away from whoever was quoting from it',
  sheet.classList.contains('cmo-open'),
);

/*
 * A refused clipboard, which is iOS's ordinary behaviour outside a gesture it likes:
 * the fallback is to leave the message selected so the platform's own Copy can take
 * it, and to say so. Silence here is the failure — the tap looks like it worked.
 */
Object.defineProperty(w.navigator, 'clipboard', {
  configurable: true,
  value: { writeText: () => Promise.reject(new Error('refused')) },
});
doc.getElementById('cmo-said-copy')?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await settle(30);
ok('a refused clipboard write left the sheet claiming it had copied the message', /press copy/i.test(copyNote()));
ok(
  'a refused clipboard write left nothing selected, so the platform’s own Copy has ' +
    'nothing to take',
  String(w.getSelection() ?? '').includes('git push origin main'),
);
Object.defineProperty(w.navigator, 'clipboard', {
  configurable: true,
  value: { writeText: (text) => { copied.push(String(text)); return Promise.resolve(); } },
});

/*
 * The other half of being able to copy something: the sheet must not pull it out from
 * under you. This sheet redraws itself every five seconds while it follows a turn, and
 * a redraw replaces the nodes a selection points at, so a message arriving mid-select
 * used to end the select. Holding the redraw costs a few seconds of staleness; the
 * change is not dropped, it is drawn as soon as the selection is let go.
 */
const held = 'A second answer, which must wait its turn.';
selectMessage();
statusReply = answer(held);
await settle(6000);
ok(
  'a redraw while the message was selected threw the selection away',
  /git push origin main/.test(saidEl()?.textContent ?? ''),
);
w.getSelection()?.removeAllRanges();
await settle(6000);
ok(
  `the change never arrived once the selection was let go: ${JSON.stringify(saidEl()?.textContent)}`,
  (saidEl()?.textContent ?? '').includes(held),
);

/*
 * And the dismissal, for the same reason. A drag that starts in the panel and finishes
 * past its edge lands as a click on the backdrop, which is the gesture that closes the
 * sheet — so selecting the last line of a message closed the sheet and lost it.
 */
selectMessage();
sheet.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await settle(30);
ok(
  'a drag that finished outside the panel closed the sheet and threw away the selection ' +
    'it had just made',
  sheet.classList.contains('cmo-open'),
);
// A plain tap beside the sheet still dismisses it: in a browser the pointer going down
// collapses the selection before the click, which is what this does by hand.
w.getSelection()?.removeAllRanges();
sheet.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await settle(30);
ok('a tap beside the sheet no longer dismisses it', !sheet.classList.contains('cmo-open'));

// ------------------------------------------------- arriving from a notification
/*
 * A tapped notification, from this end of it.
 *
 * pwa/sw.js opens `/p/<project>/?folder=…&session=<id>` — see chat-service/sw-test.js
 * for the worker's half — and the whole value of that URL is what this file's subject
 * does with the `session` in it. The panel cannot be told which conversation to show,
 * so pinning it out here and opening the sheet over it is the only way the thing
 * someone was buzzed about ends up in front of them. A tap that lands on the editor
 * showing whatever it guessed is the bug that was reported, one step further along.
 *
 * Its own documents, because the URL is the input: this window's location cannot be
 * changed after `w.eval`, and `navigator.serviceWorker` has to exist *before* the
 * overlay runs for the message listener to be registered at all.
 */
{
  /**
   * A fresh overlay, with the two things this section is about wired up: the URL it
   * loaded at, and a service worker container that can deliver a message.
   */
  function bootOverlay(url) {
    const quiet = new VirtualConsole();
    quiet.on('jsdomError', () => {});
    quiet.on('error', (m) => fail(`console error in the notification boot: ${m}`));
    const dom2 = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
      runScripts: 'outside-only',
      url,
      virtualConsole: quiet,
    });
    const win = dom2.window;
    win.addEventListener('error', (e) => fail(`uncaught in the notification boot: ${e.message}`));

    const statusAsks = [];
    let reply = (sessionId) => ({
      cwd: '/workspace/projects/demo',
      sessionId: sessionId || 'guessed-one',
      state: 'idle',
      clients: 0,
      conversations: [],
      last: { role: 'assistant', text: `the answer in ${sessionId || 'the guess'}`, at: new Date().toISOString() },
    });
    win.fetch = (target) => {
      const asked = String(target);
      if (asked.includes('/api/claude-status')) {
        const params = new win.URL(asked, url).searchParams;
        statusAsks.push({ cwd: params.get('cwd'), sessionId: params.get('sessionId') });
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(reply(params.get('sessionId'))) });
      }
      // Everything else this page asks for on load — the opening prompt, the voice —
      // is refused, which is the state a lapsed chat-service session leaves it in and
      // the state the rest of this file runs in.
      return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
    };

    const swMessages = [];
    Object.defineProperty(win.navigator, 'serviceWorker', {
      configurable: true,
      value: {
        addEventListener: (type, fn) => { if (type === 'message') swMessages.push(fn); },
        register: () => Promise.resolve(null),
        getRegistration: () => Promise.resolve(null),
      },
    });

    try {
      win.eval(overlayJs);
    } catch (err) {
      fail(`mobile-overlay.js threw when loaded at ${url} — ${err.message}`);
    }
    return {
      win,
      doc: win.document,
      statusAsks,
      setReply: (fn) => { reply = fn; },
      /** What the worker does to a window that is already open. */
      deliver: (data) => swMessages.forEach((fn) => fn({ data })),
      listening: () => swMessages.length,
    };
  }

  const PROJECT = 'https://claude.example.com/p/demo/?folder=%2Fworkspace%2Fprojects%2Fdemo';
  const tapped = bootOverlay(`${PROJECT}&session=S9`);
  await settle(60);

  ok(
    `the first status ask was ${JSON.stringify(tapped.statusAsks[0])} — the conversation the ` +
      'notification named has to be pinned before the first fetch, or the sheet draws the ' +
      'guess and replaces it a moment later',
    tapped.statusAsks.length === 1 && tapped.statusAsks[0].sessionId === 'S9',
  );
  const tappedSheet = tapped.doc.getElementById('cmo-sheet');
  ok(
    'arriving from a notification showed nothing — the editor opens on whatever the ' +
      'panel was already showing, which is the tap doing nothing all over again',
    tappedSheet?.classList.contains('cmo-open'),
  );
  ok(
    `the sheet does not show the message it was tapped for: ${JSON.stringify(
      tapped.doc.getElementById('cmo-status-said')?.textContent,
    )}`,
    /the answer in S9/.test(tapped.doc.getElementById('cmo-status-said')?.textContent ?? ''),
  );
  /*
   * And the parameter is spent. The workbench reloads itself on every bfcache restore
   * — switch apps on a phone and come back — so a `session` left in the URL would
   * re-open this sheet over the editor for as long as the window lived.
   */
  ok(
    `the session parameter is still in the URL (${tapped.win.location.search}), so every ` +
      'reload of this window re-opens the sheet for a notification tapped hours ago',
    !tapped.win.location.search.includes('session='),
  );
  ok(
    `?folder= did not survive being rewritten: ${tapped.win.location.search} — it is what ` +
      'code-server opens the workspace from, and the overlay reads it for every ask',
    tapped.win.location.search === '?folder=%2Fworkspace%2Fprojects%2Fdemo',
  );

  // A second notification, tapped while that window is open. There is no navigation
  // this time — an installed app has one window — so the id arrives by message.
  ok('the overlay never listened for the service worker, so a second tap says nothing',
    tapped.listening() > 0);
  tapped.doc.getElementById('cmo-status-close')?.dispatchEvent(new tapped.win.MouseEvent('click', { bubbles: true }));
  await settle(30);
  tapped.deliver({ type: 'cw-notification-click', project: 'demo', sessionId: 'S10', url: '/p/demo/?session=S10' });
  await settle(60);
  ok(
    `the tap on an open window asked about ${JSON.stringify(tapped.statusAsks.at(-1))} — the ` +
      'window cannot be renavigated without throwing away a loaded workbench, so this ' +
      'message is the only way it can be told',
    tapped.statusAsks.at(-1)?.sessionId === 'S10',
  );
  ok(
    'the message from the worker did not open the sheet, so a notification tapped while ' +
      'the editor is open still does nothing visible',
    tappedSheet?.classList.contains('cmo-open') &&
      /the answer in S10/.test(tapped.doc.getElementById('cmo-status-said')?.textContent ?? ''),
  );

  // Somebody else's postMessage. The workbench receives its own — this listener is on
  // the same container — and must not treat one as a conversation to follow.
  const asks = tapped.statusAsks.length;
  tapped.deliver({ type: 'vscode-something-else', sessionId: 'not-a-conversation' });
  tapped.deliver(null);
  tapped.deliver('a string');
  await settle(40);
  ok(
    'an unrelated message to the workbench was read as a notification tap',
    tapped.statusAsks.length === asks,
  );

  /*
   * And the ordinary load, which is every load that is not a tap: no pin, no sheet.
   * Opening the editor must not put a sheet over it, and the answer has to be about
   * whatever the panel is showing rather than about a conversation nobody named.
   */
  const plain = bootOverlay(PROJECT);
  await settle(60);
  ok(
    `an ordinary load pinned a conversation: ${JSON.stringify(plain.statusAsks[0])}`,
    plain.statusAsks.length === 1 && plain.statusAsks[0].sessionId === null,
  );
  ok(
    'opening the editor put the status sheet over it, unasked',
    !plain.doc.getElementById('cmo-sheet')?.classList.contains('cmo-open'),
  );
}

// --------------------------------------------- starting dictation over from nothing
/*
 * The reported bug: dictation "remembers something", and clearing the box by hand and
 * speaking again does not get rid of it. It cannot — none of the state that puts the
 * words back is in the box. It is `committedText` (seeded from the saved draft, so a
 * reload does not lose a paragraph), the draft itself, and whatever is already on its
 * way to the server. So Reset has to reach all of them, and the three things below
 * are the ones a user cannot do for themselves: a phrase the recognizer delivers
 * after the tap, an upload that cannot be recalled, and a microphone whose permission
 * prompt is still on screen.
 *
 * Its own window, like the talk section: this one has a speech recognizer and a
 * microphone, and those have to be in place before `w.eval` rather than swapped in
 * afterwards.
 */
{
  function bootDictation(options = {}) {
    const state = {
      transcript: 'the sentence the server sent back',
      holdMic: false,
      releaseMic: null,
      holdTranscribe: false,
      releaseTranscribe: null,
      polish: null,
      holdPolish: false,
      releasePolish: null,
    };

    const quiet = new VirtualConsole();
    quiet.on('jsdomError', () => {});
    for (const level of ['error', 'warn', 'log', 'info', 'debug']) {
      quiet.on(level, (m) => {
        if (level === 'error') fail(`console error in the dictation boot: ${m}`);
      });
    }
    const dom2 = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
      runScripts: 'outside-only',
      url: 'https://claude.example.com/editor/?folder=%2Fworkspace%2Fprojects%2Fdemo',
      virtualConsole: quiet,
    });
    const win = dom2.window;
    win.addEventListener('error', (e) => fail(`uncaught in the dictation boot: ${e.message}`));

    const copies = [];
    const mics = [];
    const recorders = [];
    const recognizers = [];
    const uploads = [];

    win.fetch = (url, init = {}) => {
      const target = String(url);
      if (target.includes('/api/transcribe')) {
        uploads.push(target);
        const answer = {
          ok: true,
          status: 200,
          text: () => Promise.resolve(state.transcript),
          json: () => Promise.resolve({ text: state.transcript }),
        };
        if (state.holdTranscribe) {
          return new Promise((resolve) => {
            state.releaseTranscribe = () => resolve(answer);
          });
        }
        return Promise.resolve(answer);
      }
      if (target.includes('/api/polish')) {
        const answer = state.polish
          ? {
            ok: true,
            status: 200,
            text: () => Promise.resolve(''),
            json: () => Promise.resolve(state.polish),
          }
          : { ok: false, status: 503, text: () => Promise.resolve(''), json: () => Promise.resolve({}) };
        if (state.holdPolish) {
          return new Promise((resolve) => {
            state.releasePolish = () => resolve(answer);
          });
        }
        return Promise.resolve(answer);
      }
      // Everything else on this page — the project list, the status poll — is
      // someone else's section. Unreachable is a state the overlay survives.
      return Promise.resolve({
        ok: false,
        status: 503,
        text: () => Promise.resolve(''),
        json: () => Promise.resolve({}),
      });
    };

    /*
     * A recognizer that can be told to deliver a phrase, and asked afterwards whether
     * it was stopped. Both halves matter: the stop is the microphone being handed
     * back, and delivering a phrase to a stopped recognizer is the case that made a
     * reset look temporary.
     */
    win.SpeechRecognition = class FakeRecognition {
      constructor() {
        this.started = 0;
        this.stopped = 0;
        recognizers.push(this);
      }
      start() {
        this.started += 1;
      }
      stop() {
        this.stopped += 1;
      }
      /** Deliver one phrase, final or interim, shaped the way a browser shapes it. */
      say(text, isFinal = true) {
        const alternatives = [{ transcript: text }];
        alternatives.isFinal = isFinal;
        this.onresult?.({ results: [alternatives] });
      }
      /**
       * End the session, which mobile Safari does on every brief pause. This is
       * what moves a phrase out of the live session and into `committedText` — the
       * state a user cannot see, cannot clear, and finds under the next dictation.
       */
      end() {
        this.onend?.();
      }
    };

    Object.defineProperty(win.navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: () => {
          const track = { kind: 'audio', stopped: 0, stop() { this.stopped += 1; } };
          const stream = { tracks: [track], getTracks: () => [track] };
          mics.push(stream);
          if (state.holdMic) {
            return new Promise((resolve) => {
              state.releaseMic = () => resolve(stream);
            });
          }
          return Promise.resolve(stream);
        },
      },
    });

    win.MediaRecorder = class FakeRecorder {
      static isTypeSupported() {
        return true;
      }
      constructor(stream) {
        this.stream = stream;
        this.state = 'inactive';
        this.mimeType = 'audio/webm';
        recorders.push(this);
      }
      start() {
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
        this.ondataavailable?.({ data: { size: 4 } });
        this.onstop?.();
      }
    };

    // Enough of an audio pipeline for toWav: the bytes are never looked at, only
    // whether the upload happens and what is done with the answer.
    win.AudioContext = class FakeAudioContext {
      decodeAudioData() {
        return Promise.resolve({ duration: 0.01 });
      }
      close() {}
    };
    win.OfflineAudioContext = class FakeOffline {
      constructor(channels, length) {
        this.length = length;
      }
      createBufferSource() {
        return { buffer: null, connect() {}, start() {} };
      }
      startRendering() {
        return Promise.resolve({ getChannelData: () => new Float32Array(this.length) });
      }
    };

    Object.defineProperty(win.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (text) => { copies.push(String(text)); return Promise.resolve(); } },
    });

    if (options.speech === false) delete win.SpeechRecognition;

    try {
      win.eval(overlayJs);
    } catch (err) {
      fail(`mobile-overlay.js threw in the dictation boot — ${err.message}`);
    }

    const doc2 = win.document;
    const tap = (id) =>
      doc2.getElementById(id)?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

    return {
      win,
      doc: doc2,
      state,
      copies,
      mics,
      recorders,
      recognizers,
      uploads,
      tap,
      box: () => doc2.getElementById('cmo-text'),
      value: () => doc2.getElementById('cmo-text')?.value ?? null,
      // Scoped to the panel: the FAB has a `#cmo-status` button of its own, and
      // getElementById answers with whichever came first — which is the button.
      status: () => doc2.querySelector('#cmo-panel #cmo-status')?.textContent ?? '',
      live: () => doc2.getElementById('cmo-mic')?.classList.contains('cmo-rec'),
      open: () => doc2.getElementById('cmo-sheet')?.classList.contains('cmo-open'),
      draft: () => {
        try {
          return JSON.parse(win.localStorage.getItem('cmo-dictation-draft') || 'null')?.text || '';
        } catch {
          return '';
        }
      },
      /** Dismiss the sheet the way a tap beside it does — which keeps the draft. */
      dismiss: () =>
        doc2
          .getElementById('cmo-sheet')
          .dispatchEvent(new win.MouseEvent('click', { bubbles: true })),
    };
  }

  // ------------------------------------------------ is the control there at all
  const d = bootDictation();
  await settle(40);
  d.tap('cmo-mic');
  ok('the mic button did not open a dictation sheet in the boot with a recognizer', d.box());
  ok(
    'the dictation sheet offers no way to start over — the reported bug is that ' +
      'clearing the box by hand does not, and that is the only tool the user has',
    d.doc.getElementById('cmo-reset'),
  );
  ok('opening the sheet did not start the microphone', d.live() && d.recognizers.length === 1);

  // ----------------------------------------- what a reset actually has to reach
  const spoken = 'the sentence nobody wants to see again';
  d.recognizers[0].say(spoken);
  ok(`the recognizer's phrase did not reach the box: ${d.value()}`, d.value() === spoken);
  // The pause that ends the session and commits the phrase, which is the state the
  // bug report is about: it is not in the box, so emptying the box does not touch it.
  d.recognizers[0].end();
  await settle(500); // the draft write is debounced
  ok('a dictated phrase left no draft, so this test is not proving anything yet',
    d.draft() === spoken);

  d.tap('cmo-reset');
  ok('Reset left the dictated text in the box', d.value() === '');
  ok('Reset left the draft in storage — it comes back on the next tap', d.draft() === '');
  ok('Reset did not stop the recognizer, so the microphone is still live',
    d.recognizers[0].stopped > 0);
  ok('Reset left the mic button showing a live microphone', !d.live());
  ok(`Reset said nothing about what it had done: ${d.status()}`, /reset/i.test(d.status()));

  // The first of the three a user cannot do for themselves: a stopped recognizer
  // still delivers what it had heard.
  d.recognizers[0].say('a phrase that arrived after the tap');
  ok(
    `a phrase delivered after the reset landed in the box anyway: ${d.value()} — this ` +
      'is exactly the "it remembers something" the button is for',
    d.value() === '',
  );

  // And the draft is what survives a reload, so it must not come back either.
  await settle(500);
  ok('the phrase that arrived after the reset was written to the draft', d.draft() === '');

  // Starting the mic again has to start from nothing. `committedText` is what the
  // recognizer prepends to every result, so a reset that leaves it holding the old
  // paragraph puts the whole thing back on the first word spoken.
  d.tap('cmo-again');
  d.recognizers[d.recognizers.length - 1].say('starting again from nothing');
  ok(
    `dictating after a reset brought the old text back with it: ${d.value()}`,
    d.value() === 'starting again from nothing',
  );
  d.tap('cmo-reset');
  d.dismiss();
  d.tap('cmo-mic');
  ok(
    `reopening the sheet after a reset recovered the old words: ${d.value()}`,
    d.value() === '',
  );

  // ---------------------------------------------------------- putting it back
  {
    const u = bootDictation();
    await settle(40);
    u.tap('cmo-mic');
    const words = 'a paragraph that took two minutes to say';
    u.recognizers[0].say(words);
    u.recognizers[0].end();
    u.tap('cmo-reset');
    ok(
      'a reset that threw away a paragraph of speech offered no way back, one tap ' +
        'from Copy & close',
      u.doc.getElementById('cmo-undo'),
    );
    u.tap('cmo-undo');
    ok(`Undo did not put the text back: ${u.value()}`, u.value() === words);
    await settle(500);
    ok('the restored text was not written down, so a reload loses it', u.draft() === words);

    // Restart mic has to carry on from the restored text. The recognizer rewrites the
    // whole box from `committedText` on every result, so an Undo that restores only
    // what is on screen has the next sentence wipe it again.
    u.tap('cmo-again');
    u.recognizers[u.recognizers.length - 1].say('and one more sentence');
    ok(
      `speaking after Undo replaced the restored text instead of continuing it: ${u.value()}`,
      u.value() === `${words} and one more sentence`,
    );
  }

  // --------------------------------------- an upload that cannot be called back
  {
    // No recognizer, so dictation falls to recording and transcribing on the server.
    const r = bootDictation({ speech: false });
    await settle(40);
    r.tap('cmo-mic');
    await settle(40);
    ok('the fallback path never opened a microphone', r.mics.length === 1);
    ok('the fallback path never started recording', r.recorders.length === 1);

    // Mid-recording, which is when the mic light is on and the button is reached for.
    r.tap('cmo-reset');
    await settle(40);
    ok(
      'Reset left the recorder running — the phone is still listening and the words go ' +
        'on accumulating',
      r.recorders[0].state === 'inactive',
    );
    ok(
      'Reset stopped the recorder but not the microphone, so the mic light stays on',
      r.mics[0].tracks.every((t) => t.stopped > 0),
    );
    ok(
      'Reset uploaded the recording it was told to throw away',
      r.uploads.length === 0,
    );

    // And the one that cannot be called back: an upload already on the network.
    const u2 = bootDictation({ speech: false });
    await settle(40);
    u2.tap('cmo-mic');
    await settle(40);
    u2.state.holdTranscribe = true;
    u2.recorders[0].stop();
    await settle(60);
    ok('the recording was never uploaded, so this proves nothing', u2.uploads.length === 1);

    u2.tap('cmo-reset');
    u2.state.releaseTranscribe();
    await settle(60);
    ok(
      `a transcription that arrived after the reset landed in the box: ${u2.value()} — a ` +
        'reset that undoes itself a second later is the bug, not the fix',
      u2.value() === '',
    );
  }

  // ------------------------------- a permission prompt still waiting on an answer
  {
    const p = bootDictation({ speech: false });
    await settle(40);
    p.state.holdMic = true;
    p.tap('cmo-mic');
    await settle(40);
    ok('the held microphone request never happened', p.mics.length === 1 && !p.recorders.length);
    p.tap('cmo-reset');
    p.state.releaseMic();
    await settle(60);
    ok(
      'a microphone granted after the reset was kept and recorded from — the prompt is ' +
        'modal and answered by a human, so this is the ordinary case, not a race',
      p.mics[0].tracks.every((t) => t.stopped > 0) && p.recorders.length === 0,
    );
  }

  // -------------------------------------- a cleanup pass still out on the network
  {
    const c = bootDictation();
    await settle(40);
    c.tap('cmo-mic');
    const raw = 'the transcript nobody punctuated';
    c.recognizers[0].say(raw);
    c.state.polish = { text: 'The transcript nobody punctuated.', changed: true };
    c.state.holdPolish = true;
    c.tap('cmo-copy');
    await settle(40);
    ok('Copy did not put the raw text on the clipboard inside the tap', c.copies[0] === raw);

    c.tap('cmo-reset');
    c.state.releasePolish();
    await settle(60);
    ok(
      `a punctuated version of the old dictation was written back after the reset: ${c.value()}`,
      c.value() === '',
    );
    ok(
      'the sheet closed itself on the back of a copy the user had already reset away',
      c.open(),
    );
  }
}

// ------------------------------------------ talking a message over out loud
/*
 * A spoken conversation about the message on the sheet — the editor's half of what
 * chat-service/talk-test.js checks in the chat app.
 *
 * Everything above is the overlay reading *to* you. This is the overlay letting you
 * answer back: a WebRTC session to OpenAI, opened with a credential this box mints and
 * spends nowhere near it, about one message and nothing else. Four things about it can
 * go wrong quietly, and they are what this section is for.
 *
 *   **It must not be able to reach Claude.** That is the promise the sheet makes in
 *   words, and on this surface the ways to break it are specific: this overlay drives
 *   the panel by dispatching keyboard chords and by writing to the clipboard. So a
 *   conversation is held open here while transcripts arrive, and the test asserts that
 *   not one chord is pressed, nothing is copied, and every request this page makes is
 *   one of the three read-only status routes it was already making.
 *
 *   **The microphone must not survive it.** Hang up, Close, a tap beside the sheet,
 *   another sheet drawn over it, a dropped line, the timer, every refusal, and the
 *   workbench reloading itself — eight ways out, and each one is checked for every
 *   track being stopped. A MediaStream that is merely dropped leaves the recording
 *   indicator lit and the phone listening.
 *
 *   **The gesture.** getUserMedia is refused on iOS outside a tap, and the microphone
 *   is asked for before the credential is minted — a session reserved against the day's
 *   count and then abandoned is one spent for nothing.
 *
 *   **The credential.** It is a bearer token for a metered third-party service. It may
 *   not be stored, printed, or put on the page.
 */
{
  /** The routes this page is allowed to touch on our own box while a line is open. */
  const ALLOWED = ['/api/claude-status', '/api/voice-status', '/api/first-prompt', '/api/realtime/token'];
  const SECRET = 'ek_this_is_the_credential';
  // Shaped like the thing this feature exists for: a Hebrew answer with a fenced block
  // in it, which is both of the two reasons the read-aloud work happened.
  const MESSAGE = [
    'סידרתי את זה — הבעיה הייתה בבדיקה עצמה.',
    '',
    '```js',
    'const speaking = false; // 3 < 4',
    '```',
    '',
    'אפשר לדבר על זה.',
  ].join('\n');
  const OPENING = 'תקרא לי את ההודעה הזאת בעברית.';

  /**
   * A fresh overlay with a microphone, a peer connection and an OpenAI that answers.
   *
   * Its own document, like the notification section above: what is being tested is
   * partly what the page does on load, and this window's fakes have to be in place
   * before `w.eval` rather than swapped in afterwards.
   */
  function bootTalk(options = {}) {
    const state = {
      realtime: {
        configured: true,
        model: 'gpt-realtime-mini',
        voice: 'marin',
        maxMinutes: 10,
        budget: { sessions: 1, limit: 40 },
        ...(options.realtime || {}),
      },
      speech: options.speech || null,
      mintStatus: 0,
      sdpStatus: 0,
      micDenied: false,
      holdSdp: false,
      releaseSdp: null,
      said: MESSAGE,
      ...options.state,
    };
    if (options.realtime === null) state.realtime = null;

    const logs = [];
    const quiet = new VirtualConsole();
    quiet.on('jsdomError', () => {});
    for (const level of ['error', 'warn', 'log', 'info', 'debug']) {
      quiet.on(level, (m) => {
        logs.push(String(m));
        if (level === 'error') fail(`console error in the talk boot: ${m}`);
      });
    }
    const dom2 = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
      runScripts: 'outside-only',
      url: 'https://claude.example.com/p/demo/?folder=%2Fworkspace%2Fprojects%2Fdemo',
      virtualConsole: quiet,
    });
    const win = dom2.window;
    win.addEventListener('error', (e) => fail(`uncaught in the talk boot: ${e.message}`));

    /** Every request this page made, in order, whoever it was to. */
    const calls = [];
    /** Which of the microphone and the credential was asked for first. */
    const order = [];
    const peers = [];
    const mics = [];
    const audios = [];
    /** Every chord this overlay pressed — the only way it can reach Claude. */
    const chords = [];
    const copied = [];

    win.fetch = (url, init = {}) => {
      const target = String(url);
      calls.push({ url: target, init });
      // Matched on the path rather than the host: which vendor holds the conversation
      // is the box's decision, and a stub that only knows `api.openai.com` would score
      // an offer sent nowhere as a pass.
      if (target.includes('/v1/realtime/calls')) {
        if (state.sdpStatus) {
          return Promise.resolve({ ok: false, status: state.sdpStatus, text: () => Promise.resolve('') });
        }
        const answer = { ok: true, status: 200, text: () => Promise.resolve('v=0 answer from OpenAI') };
        if (state.holdSdp) {
          return new Promise((resolve) => {
            state.releaseSdp = () => resolve(answer);
          });
        }
        return Promise.resolve(answer);
      }
      if (target.includes('/api/realtime/token')) {
        order.push('mint');
        if (state.mintStatus) {
          return Promise.resolve({
            ok: false,
            status: state.mintStatus,
            json: () => Promise.resolve({ error: 'that is 40 conversations today, which is the limit' }),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            value: SECRET,
            ...(state.callUrl ? { callUrl: state.callUrl, provider: 'azure' } : {}),
            expiresAt: new Date(Date.now() + 120000).toISOString(),
            model: 'gpt-realtime-mini',
            voice: 'marin',
            sessionId: 'rt_abc',
            maxMinutes: state.maxMinutes ?? 10,
            budget: { sessions: 1, limit: 40 },
          }),
        });
      }
      if (target.includes('/api/voice-status')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            configured: false,
            speech: state.speech,
            realtime: state.realtime,
          }),
        });
      }
      if (target.includes('/api/first-prompt')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ text: OPENING, at: new Date().toISOString() }),
        });
      }
      if (target.includes('/api/claude-status')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            cwd: '/workspace/projects/demo',
            sessionId: 'S-talk',
            state: 'idle',
            clients: 0,
            conversations: [],
            last: state.said
              ? { role: 'assistant', text: state.said, at: new Date().toISOString() }
              : null,
          }),
        });
      }
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    };

    /*
     * A microphone whose tracks can be asked whether they were stopped, which is the
     * only question this section asks of it more than once.
     */
    if (options.mediaDevices !== false) {
      Object.defineProperty(win.navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: (constraints) => {
            order.push('mic');
            if (state.micDenied) {
              const err = new Error('Permission denied');
              err.name = 'NotAllowedError';
              return Promise.reject(err);
            }
            const track = {
              kind: 'audio',
              stopped: 0,
              // Live tracks start enabled, and muting is what turns this off.
              enabled: true,
              stop() {
                this.stopped += 1;
              },
            };
            const stream = { constraints, tracks: [track], getTracks: () => [track] };
            mics.push(stream);
            return Promise.resolve(stream);
          },
        },
      });
    }

    if (options.webrtc !== false) {
      win.RTCPeerConnection = class FakePeer {
        constructor() {
          peers.push(this);
          this.added = [];
          this.channels = [];
          this.local = null;
          this.remote = null;
          this.closed = 0;
          this.connectionState = 'new';
          this.ontrack = null;
          this.onconnectionstatechange = null;
        }
        addTrack(track, stream) {
          this.added.push({ track, stream });
        }
        createDataChannel(label) {
          const channel = {
            label,
            onmessage: null,
            closed: 0,
            close() {
              this.closed += 1;
            },
          };
          this.channels.push(channel);
          return channel;
        }
        createOffer() {
          return Promise.resolve({ type: 'offer', sdp: 'v=0 offer from the phone' });
        }
        setLocalDescription(description) {
          this.local = description;
          return Promise.resolve();
        }
        setRemoteDescription(description) {
          this.remote = description;
          return Promise.resolve();
        }
        close() {
          this.closed += 1;
          this.connectionState = 'closed';
        }
        /* --- what the far end does, from the test's side --- */
        connect() {
          this.connectionState = 'connected';
          this.onconnectionstatechange?.();
        }
        drop() {
          this.connectionState = 'failed';
          this.onconnectionstatechange?.();
        }
        arrive(stream) {
          this.ontrack?.({ streams: [stream] });
        }
        say(message) {
          this.channels[0]?.onmessage?.({ data: JSON.stringify(message) });
        }
      };
    }

    win.Audio = class FakeAudio {
      constructor() {
        audios.push(this);
        this.srcs = [];
        this.srcObject = null;
        this.autoplay = false;
        this.playsInline = false;
        this.attributes = {};
      }
      set src(value) {
        this.srcs.push(String(value));
      }
      get src() {
        return this.srcs[this.srcs.length - 1] || '';
      }
      setAttribute(name, value) {
        this.attributes[name] = value;
      }
      removeAttribute() {}
      load() {}
      pause() {}
      play() {
        return Promise.resolve();
      }
    };

    Object.defineProperty(win.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (text) => { copied.push(String(text)); return Promise.resolve(); } },
    });

    try {
      win.eval(overlayJs);
    } catch (err) {
      fail(`mobile-overlay.js threw in the talk boot — ${err.message}`);
    }

    const doc2 = win.document;
    // After `eval`, so this listener sees what the overlay dispatches rather than being
    // the thing it dispatches to. The chord is how the panel is driven from out here.
    doc2.addEventListener('keydown', (e) => chords.push(e.key), true);

    const tap = (id) =>
      doc2.getElementById(id)?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

    return {
      win,
      doc: doc2,
      state,
      calls,
      order,
      peers,
      mics,
      audios,
      chords,
      copied,
      logs,
      tap,
      /** Open the status sheet, and wait for the opening prompt to land on it. */
      openStatus: async () => {
        tap('cmo-status');
        await settle(40);
      },
      /** Which requests went to our own box, as paths. */
      ours: () =>
        calls
          .map((c) => c.url)
          .filter((u) => u.startsWith('/') || u.startsWith('https://claude.example.com/'))
          .map((u) => u.split('?')[0]),
      mint: () => calls.find((c) => c.url.includes('/api/realtime/token')),
      sdp: () => calls.find((c) => c.url.includes('/v1/realtime/calls')),
      state2: state,
      text: (id) => doc2.getElementById(id)?.textContent ?? '',
      /** Every microphone track this page ever opened, whichever call it belonged to. */
      tracks: () => mics.flatMap((m) => m.tracks),
      allStopped: () => mics.length > 0 && mics.flatMap((m) => m.tracks).every((t) => t.stopped > 0),
    };
  }

  // --------------------------------------------------- is the control there at all
  const b = bootTalk();
  await settle(60);
  await b.openStatus();

  ok(
    'the status sheet offers no way to talk the message over, on a box that can hold ' +
      'one — the whole feature is unreachable from the editor',
    b.doc.getElementById('cmo-talk'),
  );
  ok(
    'the Read aloud button appeared on a box with no speech voice, which is a control ' +
      'that can only explain itself after the tap',
    !b.doc.getElementById('cmo-speak'),
  );

  {
    // No key on the box: the server says so, and the sheet must say nothing at all.
    const nokey = bootTalk({ realtime: { configured: false, reason: 'no OpenAI key' } });
    await settle(60);
    await nokey.openStatus();
    ok(
      'a box with no OpenAI key still offered Talk it over — one tap, a mint, a 403, ' +
        'and a microphone opened for nothing',
      !nokey.doc.getElementById('cmo-talk'),
    );
    ok(
      'the sheet did not draw at all on a box with no realtime voice',
      /S-talk|סידרתי/.test(nokey.text('cmo-status-said')),
    );
  }
  {
    // A browser that cannot hold a session. Some webviews cannot, and a button that
    // takes the tap and then does nothing is the shape this file keeps refusing.
    const old = bootTalk({ webrtc: false });
    await settle(60);
    await old.openStatus();
    ok(
      'a browser with no RTCPeerConnection was offered Talk it over anyway',
      !old.doc.getElementById('cmo-talk'),
    );
  }
  {
    const nomic = bootTalk({ mediaDevices: false });
    await settle(60);
    await nomic.openStatus();
    ok(
      'a browser with no getUserMedia was offered Talk it over anyway',
      !nomic.doc.getElementById('cmo-talk'),
    );
  }
  {
    // Both capabilities at once, which is the deployment this was written for: the two
    // buttons are separate because the two answers are separate.
    const both = bootTalk({
      speech: { configured: true, voice: 'Ruth', voices: [{ id: 'Ruth', language: 'en-US', provider: 'polly' }] },
    });
    await settle(60);
    await both.openStatus();
    ok(
      'a box with both a voice and a key lost one of the two buttons',
      both.doc.getElementById('cmo-talk') && both.doc.getElementById('cmo-speak'),
    );
  }
  {
    // Nothing said yet. There is no message to talk about, so there is no button —
    // the same rule Read aloud follows two hundred lines above.
    const quiet2 = bootTalk({ state: { said: '' } });
    await settle(60);
    await quiet2.openStatus();
    ok(
      'a conversation with nothing said in it offered a conversation about nothing',
      !quiet2.doc.getElementById('cmo-talk'),
    );
  }

  // ------------------------------------------------------- starting one
  b.tap('cmo-talk');
  await settle(60);

  ok(
    `the microphone and the credential were asked for in the order ${JSON.stringify(b.order)} — ` +
      'the credential first means a session reserved against the day and then thrown ' +
      'away when the microphone is refused',
    b.order.join(',') === 'mic,mint',
  );
  const asked = b.mics[0]?.constraints?.audio;
  ok(
    `the microphone was asked for as ${JSON.stringify(b.mics[0]?.constraints)} — echo ` +
      'cancellation is not a nicety on a phone held at arm’s length while the far end ' +
      'is talking through the speaker',
    asked && asked.echoCancellation === true && asked.noiseSuppression === true,
  );

  const minted = JSON.parse(b.mint()?.init?.body || '{}');
  ok(
    `the message was not sent as it was written: ${JSON.stringify(minted.text)?.slice(0, 80)}`,
    minted.text === MESSAGE,
  );
  ok(
    'the fences were stripped out of the message before it was sent — the code in it is ' +
      'most of what there is to talk about',
    minted.text.includes('```js'),
  );
  ok(
    `the prompt sent with it was ${JSON.stringify(minted.prompt)} — the conversation's ` +
      'opening prompt is the only context this surface has, and the sheet already has it',
    minted.prompt === OPENING,
  );
  ok(
    `the client chose something that costs money: ${JSON.stringify(Object.keys(minted))} — ` +
      'the model, the voice, the length and the instructions are the server’s to decide',
    Object.keys(minted).sort().join(',') === 'prompt,text',
  );

  const sdpCall = b.sdp();
  ok(
    `the offer went to ${sdpCall?.url} — it has to go straight to OpenAI, because a relay ` +
      'through this box is the latency this feature exists to avoid',
    sdpCall?.url?.startsWith('https://api.openai.com/v1/realtime/calls?model='),
  );
  ok(
    'the model was not named in the SDP call, which is how OpenAI is told what to answer as',
    sdpCall?.url?.includes('model=gpt-realtime-mini'),
  );
  ok(
    'the minted credential was not the bearer on the SDP call',
    sdpCall?.init?.headers?.Authorization === `Bearer ${SECRET}`,
  );
  ok(
    `the offer was sent as ${JSON.stringify(sdpCall?.init?.headers?.['Content-Type'])}`,
    sdpCall?.init?.headers?.['Content-Type'] === 'application/sdp' &&
      sdpCall?.init?.body === 'v=0 offer from the phone',
  );

  const peer = b.peers[0];
  ok('no peer connection was made at all', peer);
  ok(
    'the microphone track was not added to the connection, so the far end hears silence',
    peer?.added.length === 1 && peer.added[0].track === b.mics[0].tracks[0],
  );
  ok(
    'the oai-events channel was not opened, so nothing can be shown of what was said',
    peer?.channels[0]?.label === 'oai-events',
  );
  ok(
    'the answer from OpenAI was never applied to the connection',
    peer?.remote?.type === 'answer' && peer.remote.sdp === 'v=0 answer from OpenAI',
  );

  ok(
    `the sheet does not say what this is not: ${JSON.stringify(b.text('cmo-panel').slice(0, 120))}`,
    /cannot run anything/.test(b.text('cmo-panel')) &&
      /tell Claude what you said/.test(b.text('cmo-panel')),
  );
  ok(
    `the sheet does not say what it is doing: ${JSON.stringify(b.text('cmo-talk-state'))}`,
    /listening/i.test(b.text('cmo-talk-state')),
  );
  ok(
    `the sheet does not say what this costs or when it ends: ${JSON.stringify(b.text('cmo-talk-note'))}`,
    /marin/.test(b.text('cmo-talk-note')) &&
      /1 of 40/.test(b.text('cmo-talk-note')) &&
      /10 minutes/.test(b.text('cmo-talk-note')),
  );
  ok(
    `the clock is not running: ${JSON.stringify(b.text('cmo-talk-clock'))}`,
    /^0:0\d/.test(b.text('cmo-talk-clock')),
  );

  // The far end's audio, which is a stream and must never become a URL: code-server's
  // own Content-Security-Policy says `media-src 'self'`, and this page is inside it.
  peer.arrive({ id: 'far-end' });
  await settle(20);
  const far = b.audios.find((a) => a.srcObject);
  ok('the far end’s audio was never attached to an element', far);
  ok(
    `the stream was turned into a URL (${JSON.stringify(far?.srcs)}), which code-server’s ` +
      'media-src refuses',
    far?.srcs.length === 0,
  );
  ok(
    'the audio element was not set to play inline, so iOS takes over the screen with the call',
    far?.autoplay === true && far?.playsInline === true && far?.attributes?.playsinline === '',
  );

  // -------------------------------------- not one word of it reaches this box
  const before = b.calls.length;
  peer.say({ type: 'response.output_audio_transcript.delta', delta: 'The test was' });
  peer.say({ type: 'response.output_audio_transcript.delta', delta: ' the broken part.' });
  peer.say({
    type: 'response.output_audio_transcript.done',
    transcript: 'The test was the broken part.',
  });
  peer.say({ type: 'conversation.item.input_audio_transcription.delta', delta: 'push that' });
  peer.say({
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: 'push that for me',
  });
  await settle(40);

  ok(
    `a live conversation made ${b.calls.length - before} request(s) to somewhere: ` +
      `${JSON.stringify(b.calls.slice(before).map((c) => c.url))} — nothing said in it may ` +
      'be carried anywhere, least of all to the box running Claude',
    b.calls.length === before,
  );
  ok(
    `this page pressed ${JSON.stringify(b.chords)} while a conversation was open — a chord ` +
      'is how this overlay drives the panel, so one pressed here is a voice channel ' +
      'typing into Claude',
    b.chords.length === 0,
  );
  ok(
    `something was copied during the conversation: ${JSON.stringify(b.copied)} — the ` +
      'clipboard is the other way text gets from here into Claude',
    b.copied.length === 0,
  );
  ok(
    `a request went somewhere it should not: ${JSON.stringify(b.ours())}`,
    // `includes` as well as `every`: an empty list satisfies `every`, and an empty list
    // is also what a broken harness produces.
    b.ours().includes('/api/realtime/token') && b.ours().every((path) => ALLOWED.includes(path)),
  );

  // ------------------------------------------------------------ the transcript
  const lines = () => [...b.doc.querySelectorAll('#cmo-talk-log .cmo-talk-line')];
  ok(
    `the transcript shows ${lines().length} lines rather than two`,
    lines().length === 2,
  );
  ok(
    `the deltas were not joined into one line: ${JSON.stringify(lines()[0]?.textContent)}`,
    /The test was the broken part\.$/.test(lines()[0]?.textContent ?? ''),
  );
  ok(
    'the finished line is still dimmed as a half-heard one',
    !lines()[0]?.classList.contains('cmo-partial'),
  );
  ok(
    `the two halves are not told apart: ${JSON.stringify(lines().map((el) => el.querySelector('.cmo-who')?.textContent))}`,
    lines()[0]?.querySelector('.cmo-who')?.textContent === 'the voice' &&
      lines()[1]?.querySelector('.cmo-who')?.textContent === 'you',
  );
  ok(
    `what it heard was not replaced by the final transcript: ${JSON.stringify(lines()[1]?.textContent)}`,
    /push that for me$/.test(lines()[1]?.textContent ?? ''),
  );

  // A partial one, which has to look unfinished: a half-heard sentence shown as final is
  // how you end up certain it said something it did not.
  peer.say({ type: 'response.audio_transcript.delta', delta: 'I cannot do that' });
  await settle(20);
  ok(
    'the older spelling of the transcript event was ignored, so a session on the previous ' +
      'API version shows an empty transcript',
    lines().length === 3,
  );
  ok(
    'a line still being said is not dimmed',
    lines()[2]?.classList.contains('cmo-partial'),
  );

  // Markup in a transcript, which is text a model heard over a network — the least
  // trusted string on this surface.
  peer.say({
    type: 'response.audio_transcript.done',
    transcript: 'try <img src=x onerror="alert(1)"> instead',
  });
  await settle(20);
  ok(
    'a transcript was built as markup rather than as text',
    !b.doc.querySelector('#cmo-talk-log img') &&
      /<img src=x/.test(lines()[2]?.textContent ?? ''),
  );

  peer.say({ type: 'error', error: { message: 'the session expired' } });
  await settle(20);
  ok(
    `an error from the far end was swallowed: ${JSON.stringify(b.text('cmo-talk-state'))}`,
    /the session expired/.test(b.text('cmo-talk-state')),
  );

  // ------------------------------------------------ the credential goes nowhere
  const stored = JSON.stringify(b.win.localStorage);
  ok(
    'the minted credential was written to localStorage, where the next page to load can ' +
      'read it — and every other script on this origin with it',
    // The store is asserted non-empty first: this overlay writes its load history there,
    // so an empty one means the dump is not being read and the check below is free.
    stored.length > 2 && !stored.includes('ek_'),
  );
  ok(
    'the credential is on the page',
    !b.doc.body.textContent.includes(SECRET) && !b.doc.body.innerHTML.includes(SECRET),
  );
  ok(
    `the credential was printed: ${JSON.stringify(b.logs.filter((l) => l.includes('ek_')))}`,
    !b.logs.some((l) => l.includes('ek_')),
  );

  // ------------------------------------------------- muting, without hanging up
  /*
   * Why this is a control of its own rather than "hang up and start another one": the
   * session is minted with semantic turn detection and `interrupt_response` on, so
   * anything the phone hears cuts off the sentence being explained — and a second
   * session costs another of the day's forty. So mute has to silence the microphone
   * while keeping the line, which means `enabled = false` on the track and emphatically
   * not `stop()`. Both halves are asserted, because stopping the track would look
   * exactly like muting for about one second and then be unrecoverable.
   */
  const muteBtn = () => b.doc.getElementById('cmo-talk-mute');
  ok('a live line offers no way to mute the microphone', muteBtn());
  ok(
    'the microphone starts out muted, so the first thing said into it goes nowhere',
    b.tracks().length > 0 && b.tracks().every((t) => t.enabled === true),
  );

  b.tap('cmo-talk-mute');
  await settle(20);
  ok(
    'muting left the microphone sending, so every word in the room still reaches the far end',
    b.tracks().every((t) => t.enabled === false),
  );
  ok(
    'muting stopped the track instead of disabling it — that closes the microphone, so ' +
      'the line cannot be unmuted and talking again costs another of the day’s sessions',
    b.tracks().every((t) => t.stopped === 0),
  );
  ok(
    'muting closed the connection, which is hanging up by another name',
    peer.closed === 0 && b.peers.length === 1,
  );
  ok(
    'muting closed the event channel, so the transcript stops where the mute did',
    peer.channels[0].closed === 0,
  );
  ok(
    'muting took the far end’s audio away too — being able to listen is the whole ' +
      'reason to mute rather than hang up',
    Boolean(b.audios.find((a) => a.srcObject)),
  );
  ok(
    `the sheet still claims to be listening while muted: ${JSON.stringify(b.text('cmo-talk-state'))}`,
    /^muted/i.test(b.text('cmo-talk-state')),
  );
  ok(
    `the sheet does not say the line is still open while muted: ` +
      `${JSON.stringify(b.text('cmo-talk-state'))} — muting instead of hanging up and ` +
      'then pocketing the phone is the one mistake this button makes possible',
    /still open/i.test(b.text('cmo-talk-state')),
  );
  ok(
    `the control does not say how to undo itself: ${JSON.stringify(muteBtn()?.textContent)}`,
    muteBtn()?.textContent === 'Unmute',
  );
  ok(
    'a screen reader is not told the toggle is on',
    muteBtn()?.getAttribute('aria-pressed') === 'true',
  );

  b.tap('cmo-talk-mute');
  await settle(20);
  ok(
    'unmuting did not give the microphone back, so mute is a one-way door',
    b.tracks().every((t) => t.enabled === true),
  );
  ok(
    `the sheet still says muted after unmuting: ${JSON.stringify(b.text('cmo-talk-state'))}`,
    /^listening$/i.test(b.text('cmo-talk-state')),
  );
  ok(
    `the control did not go back: ${JSON.stringify(muteBtn()?.textContent)}`,
    muteBtn()?.textContent === 'Mute' && muteBtn()?.getAttribute('aria-pressed') === 'false',
  );

  {
    /*
     * And it is not sticky. A conversation that opened muted because the last one ended
     * that way is one you talk into for ten seconds before finding out — with the day's
     * count already spent on it.
     */
    const again = bootTalk();
    await settle(60);
    await again.openStatus();
    again.tap('cmo-talk');
    await settle(60);
    again.tap('cmo-talk-mute');
    await settle(20);
    ok(
      'mute did nothing on a second conversation',
      again.mics[0].tracks.every((t) => t.enabled === false),
    );
    again.tap('cmo-talk-end');
    await settle(20);
    ok(
      `the control is still offered with no line to mute: ` +
        `${JSON.stringify(again.doc.getElementById('cmo-talk-mute')?.textContent)}`,
      again.doc.getElementById('cmo-talk-mute')?.disabled === true &&
        again.doc.getElementById('cmo-talk-mute')?.textContent === 'Mute',
    );
    await again.openStatus();
    again.tap('cmo-talk');
    await settle(60);
    ok('the second conversation never opened', again.mics.length === 2);
    ok(
      'a new conversation inherited the last one’s mute — it is listening to nothing and ' +
        'says it is listening',
      again.mics[1].tracks.every((t) => t.enabled === true),
    );
    ok(
      `the new line’s sheet says: ${JSON.stringify(again.text('cmo-talk-state'))}`,
      /^listening$/i.test(again.text('cmo-talk-state')),
    );
    ok(
      `the control did not reset: ${JSON.stringify(again.doc.getElementById('cmo-talk-mute')?.textContent)}`,
      again.doc.getElementById('cmo-talk-mute')?.textContent === 'Mute',
    );
    again.tap('cmo-talk-end');
    await settle(20);
  }

  // ------------------------------------------------------------- hanging up
  b.tap('cmo-talk-end');
  await settle(20);
  ok('Hang up did not close the connection', peer.closed > 0);
  ok('Hang up did not close the event channel', peer.channels[0].closed > 0);
  ok(
    'Hang up left the microphone live — the recording indicator stays lit and the phone ' +
      'is still listening',
    b.allStopped(),
  );
  ok(
    `the sheet does not say the line has gone: ${JSON.stringify(b.text('cmo-talk-state'))}`,
    /hung up/i.test(b.text('cmo-talk-state')),
  );
  ok(
    'the transcript went with the line, and it is the only record there was',
    lines().length === 3,
  );
  ok(
    'the clock is still counting after the line was closed',
    b.text('cmo-talk-clock') === '',
  );
  // Twice is what a thumb does to a button that has already worked once.
  b.tap('cmo-talk-end');
  await settle(20);
  ok(
    'hanging up a second time changed the answer, when there was nothing left to end',
    /hung up/i.test(b.text('cmo-talk-state')) && b.allStopped(),
  );

  /*
   * The bar, while a line is open.
   *
   * The sheet is dismissed by tapping beside it, so this button is the only control
   * that outlives it — and on a phone it is the one that will be found. It has to hang
   * up rather than open the status sheet, and it has to look like a Stop.
   */
  await b.openStatus();
  b.tap('cmo-talk');
  await settle(60);
  const second = b.peers[1];
  ok('a second conversation could not be started after the first was hung up', second);
  const bar = b.doc.querySelector('#cmo-fab #cmo-status');
  ok(
    `the bar does not offer a way to end the call: ${JSON.stringify(bar?.getAttribute('aria-label'))}`,
    /hang up/i.test(bar?.getAttribute('aria-label') ?? '') &&
      bar?.classList.contains('cmo-speaking'),
  );
  b.tap('cmo-status');
  await settle(40);
  ok('the bar did not end the call', second?.closed > 0);
  /*
   * And it ended it *as* the tap, rather than by opening something else that happens to
   * hang up on its way in. The difference is what is on screen afterwards: the
   * transcript you were reading, or a fresh status sheet drawn over it — which is a
   * second thing the tap did that nobody asked for, and a fetch with it.
   */
  ok(
    'the bar drew the status sheet over the call instead of simply ending it, taking the ' +
      'transcript with it',
    b.doc.getElementById('cmo-talk-state') && !b.doc.getElementById('cmo-status-said'),
  );
  ok('the bar hung up without stopping the microphone', b.allStopped());
  ok(
    `the bar still says there is a call to end: ${JSON.stringify(bar?.getAttribute('aria-label'))}`,
    !/hang up/i.test(bar?.getAttribute('aria-label') ?? '') &&
      !bar?.classList.contains('cmo-speaking'),
  );

  /*
   * Closing the sheet, and every other sheet drawn over it.
   *
   * A hidden sheet over a live session is a pocket call: there is no green bar across
   * the top of a webview to find it by, and the sheet that holds the clock has gone.
   */
  await b.openStatus();
  b.tap('cmo-talk');
  await settle(60);
  const third = b.peers[2];
  ok(
    'no conversation could be started for the Close case — the one before it is probably still live, which is itself the failure',
    third,
  );
  b.tap('cmo-talk-close');
  await settle(20);
  ok('Close left the line open behind a dismissed sheet', third?.closed > 0);
  ok('Close left the microphone live', b.allStopped());
  ok(
    'Close left the sheet on screen',
    !b.doc.getElementById('cmo-sheet').classList.contains('cmo-open'),
  );

  await b.openStatus();
  b.tap('cmo-talk');
  await settle(60);
  const fourth = b.peers[3];
  ok(
    'no conversation could be started for the a tap beside the sheet case — the one before it is probably still live, which is itself the failure',
    fourth,
  );
  // A tap beside the sheet, which is how a sheet is usually dismissed on a phone.
  b.doc.getElementById('cmo-sheet').dispatchEvent(new b.win.MouseEvent('click', { bubbles: true }));
  await settle(20);
  ok('a tap beside the sheet left the line open', fourth?.closed > 0);
  ok('a tap beside the sheet left the microphone live', b.allStopped());

  await b.openStatus();
  b.tap('cmo-talk');
  await settle(60);
  const fifth = b.peers[4];
  ok(
    'no conversation could be started for the another sheet case — the one before it is probably still live, which is itself the failure',
    fifth,
  );
  // Another sheet, drawn over the one holding the only Hang up button there is.
  b.tap('cmo-layout');
  await settle(20);
  ok('a sheet drawn over the call left it running behind that sheet', fifth?.closed > 0);
  ok('a sheet drawn over the call left the microphone live', b.allStopped());
  b.tap('cmo-layout-close');
  await settle(20);

  // A dropped line, which is what a phone leaving a lift does.
  await b.openStatus();
  b.tap('cmo-talk');
  await settle(60);
  const sixth = b.peers[5];
  ok(
    'no conversation could be started for the a dropped line case — the one before it is probably still live, which is itself the failure',
    sixth,
  );
  sixth?.drop();
  await settle(20);
  ok(
    'a dropped line was not closed on this end — the session is still open as far as ' +
      'OpenAI is concerned, and the minutes are still being counted',
    sixth?.closed > 0,
  );
  ok('a dropped line left the microphone live', b.allStopped());
  ok(
    `a dropped line was not reported: ${JSON.stringify(b.text('cmo-talk-state'))}`,
    /dropped/i.test(b.text('cmo-talk-state')),
  );

  // The workbench reloading itself, which happens on this surface every time the phone
  // is switched away from and back. Nothing left alive could end the call afterwards.
  await b.openStatus();
  b.tap('cmo-talk');
  await settle(60);
  const seventh = b.peers[6];
  ok(
    'no conversation could be started for the the page going away case — the one before it is probably still live, which is itself the failure',
    seventh,
  );
  b.win.dispatchEvent(new b.win.Event('pagehide'));
  await settle(20);
  ok('the page going away left a WebRTC session and a microphone behind it', seventh?.closed > 0);
  ok('the page going away left the microphone live', b.allStopped());

  // --------------------------------------------------------------- refusals
  {
    // The microphone, refused by the person. Nothing may be minted: a session reserved
    // against the day's count and then abandoned is one spent on nothing.
    const denied = bootTalk({ state: { micDenied: true } });
    await settle(60);
    await denied.openStatus();
    denied.tap('cmo-talk');
    await settle(60);
    ok(
      `a refused microphone still minted a credential: ${JSON.stringify(denied.order)}`,
      denied.order.join(',') === 'mic',
    );
    ok('a refused microphone still opened a connection', denied.peers.length === 0);
    ok(
      `a refused microphone was not explained: ${JSON.stringify(denied.text('cmo-talk-state'))}`,
      /microphone was not allowed/.test(denied.text('cmo-talk-state')),
    );
  }
  {
    // The day's allowance, which is the guard that keeps this from being a bill.
    const spent = bootTalk({ state: { mintStatus: 429 } });
    await settle(60);
    await spent.openStatus();
    spent.tap('cmo-talk');
    await settle(60);
    ok(
      `the server's own sentence was replaced with a generic one: ${JSON.stringify(
        spent.text('cmo-talk-state'),
      )}`,
      /40 conversations today/.test(spent.text('cmo-talk-state')),
    );
    ok('a refused mint left the microphone live', spent.allStopped());
    ok('a refused mint still opened a connection', spent.peers.length === 0);
  }
  {
    // OpenAI refusing the offer: an expired credential, a model that is not enabled.
    const refused = bootTalk({ state: { sdpStatus: 403 } });
    await settle(60);
    await refused.openStatus();
    refused.tap('cmo-talk');
    await settle(60);
    ok(
      `an SDP refusal was not reported: ${JSON.stringify(refused.text('cmo-talk-state'))}`,
      /403/.test(refused.text('cmo-talk-state')),
    );
    ok('an SDP refusal left the microphone live', refused.allStopped());
    ok('an SDP refusal left the connection open', refused.peers[0]?.closed > 0);
  }
  {
    /*
     * Hanging up while the offer is still in flight.
     *
     * The credential has two minutes on it and the answer is about to arrive, so this is
     * the one moment where a line can be opened seconds after it was ended — the
     * generation check in `connectTalk` is the only thing that stops it.
     */
    const impatient = bootTalk({ state: { holdSdp: true } });
    await settle(60);
    await impatient.openStatus();
    impatient.tap('cmo-talk');
    await settle(60);
    const held = impatient.peers[0];
    ok('the connection was not made before the offer was sent', held);
    impatient.tap('cmo-talk-end');
    await settle(20);
    impatient.state.releaseSdp?.();
    await settle(40);
    ok(
      'an answer that arrived after Hang up was applied anyway, which opens a line ' +
        'nobody is on',
      held?.remote === null,
    );
    ok('hanging up mid-connect left the microphone live', impatient.allStopped());
    ok(
      `the sheet says the line is up after it was hung up mid-connect: ${JSON.stringify(
        impatient.text('cmo-talk-state'),
      )}`,
      /hung up/i.test(impatient.text('cmo-talk-state')),
    );
  }
  {
    // Dictation, which is the other thing on this phone that wants the microphone — and
    // which would type this conversation into Claude's composer, the one thing the sheet
    // promises cannot happen.
    const dictating = bootTalk();
    await settle(60);
    await dictating.openStatus();
    dictating.doc.getElementById('cmo-mic').classList.add('cmo-rec');
    dictating.tap('cmo-talk');
    await settle(60);
    ok(
      `a conversation started over live dictation: ${JSON.stringify(dictating.order)}`,
      dictating.order.length === 0 && dictating.peers.length === 0,
    );
    ok(
      `the refusal was not explained on the sheet: ${JSON.stringify(
        dictating.text('cmo-status-detail'),
      )}`,
      /microphone is live/.test(dictating.text('cmo-status-detail')),
    );
  }
  {
    /*
     * The line closing by itself, which is the guard that matters most: a phone in a
     * pocket with a paid microphone open is exactly what this must not become. The
     * server's own limit is ten minutes; this one is handed a second of it.
     */
    const brief = bootTalk({ state: { maxMinutes: 1 / 60 } });
    await settle(60);
    await brief.openStatus();
    brief.tap('cmo-talk');
    await settle(60);
    ok('no line to close', brief.peers[0]);
    await settle(2300);
    ok('the line did not close itself after its minutes ran out', brief.peers[0].closed > 0);
    ok('a line closed by the clock left the microphone live', brief.allStopped());
    ok(
      `the sheet does not say why it ended: ${JSON.stringify(brief.text('cmo-talk-state'))}`,
      /closed/i.test(brief.text('cmo-talk-state')),
    );
  }

  // ----------------------------------------------- whose realtime API it is
  /*
   * The vendor is the box's decision and the overlay must not hold an opinion.
   *
   * This box can hold the conversation on an Azure deployment — billed to sponsorship
   * credits, which have no card behind them — or on an OpenAI key, and it says which
   * by handing a `callUrl` back with the credential. An overlay that keeps its own
   * copy of `api.openai.com` sends the offer, and the ephemeral secret with it, to a
   * vendor that never minted it: a 401 that reads on a phone as "voice is broken".
   *
   * The no-`callUrl` case is checked as well, and it is not decoration — the file is
   * cached under a build number, so a tab loaded before this change is still live
   * somewhere and will be handed a mint it does not recognise.
   */
  {
    const AZURE = 'https://claudeweb-realtime-6f2a9c.openai.azure.com/openai/v1/realtime/calls';
    const b = bootTalk({ state: { callUrl: AZURE } });
    await settle(60);
    await b.openStatus();
    b.tap('cmo-talk');
    await settle(80);

    const call = b.sdp();
    ok('no offer was sent anywhere', Boolean(call));
    ok(
      `the offer went to ${call?.url} rather than the URL the box minted for it`,
      call?.url === AZURE,
    );
    ok(
      'the overlay added a ?model= query of its own, which Azure does not read',
      !String(call?.url || '').includes('?'),
    );
    ok(
      'the credential went to a vendor other than the one that minted it',
      call?.init?.headers?.Authorization === `Bearer ${SECRET}`,
    );
    ok('the conversation did not come up against Azure', b.peers[0]?.remote);
    ok(
      `a request went to our own box that should not have: ${JSON.stringify(b.ours())}`,
      b.ours().includes('/api/realtime/token')
        && b.ours().every((path) => ALLOWED.includes(path)),
    );
    b.tap('cmo-talk-end');
    await settle(40);
    ok('hanging up on an Azure line left the microphone live', b.allStopped());
  }

  {
    const b = bootTalk();
    await settle(60);
    await b.openStatus();
    b.tap('cmo-talk');
    await settle(80);
    ok(
      `a mint with no callUrl sent the offer to ${b.sdp()?.url}`,
      String(b.sdp()?.url || '').startsWith('https://api.openai.com/v1/realtime/calls?model='),
    );
    b.tap('cmo-talk-end');
    await settle(40);
    ok('and that path leaked a microphone', b.allStopped());
  }
}

// ------------------------------------- which app a project window belongs to
/*
 * The address decides, not the query — and the pages that could not tell used to
 * hand a project's identity to code-server.
 *
 * code-server links a manifest of its own in every page it serves, and that file
 * names no `id` and no `scope`, so a browser defaults both to the directory the link
 * resolves in. On /p/<name>/ that is precisely the identity this project's own
 * manifest asks for, under the name "code-server": accept that install once and the
 * project is unreachable from an installer forever after, because the icon on the
 * home screen already holds its name. So the overlay's job is to make sure nothing
 * else is ever the manifest on the page, and to be right about which project it is.
 *
 * `?folder=` was the only thing it read, and `?folder=` goes missing. code-server
 * answers a request with no password cookie of its own with `./login?folder=…&to=`,
 * and `to` comes back empty — so a phone whose editor session has lapsed lands back
 * on the project's path carrying no query at all. That window used to name no
 * project, remove nothing, and leave code-server's link in place: the one state where
 * the wrong install is on offer is the state a phone reaches by waiting a week.
 *
 * Its own documents, because the URL is the input and this window's location cannot
 * be changed after `w.eval`.
 */
{
  function bootAt(url, head = '<link rel="manifest" href="./manifest.json">') {
    const quiet = new VirtualConsole();
    // The install button navigates, which jsdom reports as an unimplemented
    // navigation rather than doing it. That is the thing under test, not a failure.
    quiet.on('jsdomError', () => {});
    quiet.on('error', (m) => fail(`console error in the install boot: ${m}`));
    const dom2 = new JSDOM(`<!doctype html><html><head>${head}</head><body></body></html>`, {
      runScripts: 'outside-only',
      url,
      virtualConsole: quiet,
    });
    const win = dom2.window;
    win.addEventListener('error', (e) => fail(`uncaught in the install boot: ${e.message}`));
    win.fetch = (target) => {
      if (String(target).includes('/api/projects')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              projects: [
                { name: 'demo', path: '/workspace/projects/demo' },
                { name: 'other', path: '/workspace/projects/other' },
              ],
            }),
        });
      }
      // Everything else a fresh page asks for is refused, which is what a lapsed
      // chat-service session answers and the state this section is about.
      return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
    };
    win.eval(overlayJs);
    return { win, doc: win.document };
  }
  const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const manifestsIn = (doc) =>
    [...doc.head.querySelectorAll('link[rel="manifest"]')].map((el) => el.getAttribute('href'));

  {
    const { doc } = bootAt('https://claude.example.com/p/demo/');
    ok(
      `a project window with no ?folder= links ${JSON.stringify(manifestsIn(doc))}, so the ` +
        'install on offer there is code-server’s own app wearing this project’s identity',
      manifestsIn(doc).length === 1 &&
        manifestsIn(doc)[0] === '/chat/manifest.webmanifest?project=demo',
    );
  }

  /*
   * And a page that belongs to no project takes code-server's link away with it
   * rather than leaving it to be installed. /editor/ is the case that matters: the
   * identity there is /editor/, which is the same for every project, so the first
   * project installed from it takes the identity and every project after collides
   * with it — "I installed the main app and now nothing else will install".
   *
   * nginx rewrites the tag as well (infra/userdata/bootstrap.sh, checked in
   * chat-service/manifest-test.js). Both, deliberately: the proxy's rule is a literal
   * string from someone else's HTML, and this is a script that cannot run before it
   * loads. Either alone has a hole the other covers.
   */
  {
    const { doc } = bootAt('https://claude.example.com/editor/');
    ok(
      `a window with no project left ${JSON.stringify(manifestsIn(doc))} linked, and an ` +
        'app installed from it holds an identity every project then collides with',
      manifestsIn(doc).length === 0,
    );
  }

  /*
   * The install offer itself, from the address it cannot be made at.
   *
   * A project's scope is /p/<name>/ and a browser only offers to install the app a
   * page links while the page is inside that app's scope, so at /editor/?folder=…
   * Chrome says nothing — which reads exactly like "already installed" and was
   * reported as it. The button now goes where the offer can be made instead of
   * naming a browser menu that cannot make it either.
   *
   * jsdom cannot navigate, so the observable is what the button says it is doing.
   */
  {
    const { win, doc } = bootAt(
      'https://claude.example.com/editor/?folder=%2Fworkspace%2Fprojects%2Fdemo',
    );
    doc.getElementById('cmo-projects').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await settle(20);
    doc.getElementById('cmo-install').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await settle(20);
    const said = doc.getElementById('cmo-install-status')?.textContent || '';
    ok(
      `outside the project's window the install button said ${JSON.stringify(said)} instead ` +
        'of opening the one address the offer can come from',
      /demo/.test(said) && /own window/.test(said),
    );
  }

  /*
   * And in the project's own window it does not bounce you anywhere: there is nothing
   * to navigate to, and a button that reloaded the workbench to arrive where it
   * already was would be the switcher's old bug in a new place. jsdom has no
   * `onbeforeinstallprompt`, which is what every iOS browser looks like, and there the
   * browser's own menu is the honest answer: Safari's has no per-origin opinion.
   */
  {
    const { win, doc } = bootAt(
      'https://claude.example.com/p/demo/?folder=%2Fworkspace%2Fprojects%2Fdemo',
    );
    doc.getElementById('cmo-projects').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await settle(20);
    doc.getElementById('cmo-install').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await settle(20);
    const said = doc.getElementById('cmo-install-status')?.textContent || '';
    ok(
      `in the project's own window the install button said ${JSON.stringify(said)} — it is ` +
        'sending a window that can already install somewhere else',
      /browser menu/.test(said),
    );
  }

  /*
   * The button has to be *there*, which is where this regressed.
   *
   * The switcher drew the install row only when `?folder=` named a project, and
   * /p/<name>/ with no query is the page a phone lands on after signing in to
   * code-server again — the one page whose scope an install can be offered from. No
   * query, no button; and the only route left is Chrome's own menu, which for a second
   * app on one origin answers "already installed" and then fails to open anything.
   */
  {
    const { win, doc } = bootAt('https://claude.example.com/p/demo/');
    doc.getElementById('cmo-projects').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await settle(20);
    ok(
      'a project window with no ?folder= offered no install button, on the one page the ' +
        'install can come from',
      /demo/.test(doc.getElementById('cmo-install')?.textContent ?? ''),
    );
  }

  /*
   * And from there an offer is used, rather than the project being named from a query
   * that is not there.
   */
  {
    const { win, doc } = bootAt('https://claude.example.com/p/demo/');
    let prompts = 0;
    const offer = new win.Event('beforeinstallprompt', { cancelable: true });
    offer.prompt = () => {
      prompts += 1;
      return Promise.resolve();
    };
    offer.userChoice = Promise.resolve({ outcome: 'accepted' });
    win.dispatchEvent(offer);
    doc.getElementById('cmo-projects').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await settle(20);
    doc.getElementById('cmo-install').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await settle(20);
    const said = doc.getElementById('cmo-install-status')?.textContent || '';
    ok(
      `an offer in a query-less project window prompted ${prompts} times and said ` +
        `${JSON.stringify(said)}`,
      prompts === 1 && /demo/.test(said) && /home screen/i.test(said),
    );
  }

  /*
   * A browser that has the event but has not fired it yet — Chrome on a cold workbench
   * load, which is every first tap on a phone. The old answer named the browser's menu,
   * and on Android that menu is the one place this cannot be done: Chrome's
   * isAppInstalledForUrl is hasAtLeastOneWebApkForOrigin, so with the chat app
   * installed it calls every page on the host "already installed" and offers an open
   * that finds no app for /p/<name>/. Pointing someone at it is what the report was.
   */
  {
    const { win, doc } = bootAt('https://claude.example.com/p/demo/');
    win.onbeforeinstallprompt = null; // what Chrome looks like before the offer lands
    doc.getElementById('cmo-projects').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await settle(20);
    doc.getElementById('cmo-install').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await settle(60);
    ok(
      'the wait for an offer was not visible, so the button looks dead for the seconds ' +
        'Chrome spends reading the manifest',
      /Waiting/i.test(doc.getElementById('cmo-install-status')?.textContent ?? ''),
    );
    await settle(1400);
    const said = doc.getElementById('cmo-install-status')?.textContent || '';
    ok(
      `with no offer this browser was told ${JSON.stringify(said)} — naming the browser ` +
        'menu here is naming the one route that answers "already installed"',
      !/browser menu/i.test(said) && /already installed/i.test(said),
    );

    // And when it does arrive, the next tap is all that is needed — said here rather
    // than prompted, because `prompt()` needs the activation of a tap and the tap that
    // started this is long expired.
    const offer = new win.Event('beforeinstallprompt', { cancelable: true });
    offer.prompt = () => Promise.resolve();
    offer.userChoice = Promise.resolve({ outcome: 'accepted' });
    win.dispatchEvent(offer);
    await settle(20);
    ok(
      'a late offer changed nothing on screen, so the wait it announced never ends',
      /again/i.test(doc.getElementById('cmo-install-status')?.textContent ?? ''),
    );
  }

  /*
   * And the link nginx already got right is left where it is. Removing it to append an
   * identical one restarts Chrome's installability check, which is exactly the offer
   * the button is waiting for.
   */
  {
    const { doc } = bootAt(
      'https://claude.example.com/p/demo/',
      '<link id="from-nginx" rel="manifest" href="/chat/manifest.webmanifest?project=demo">',
    );
    ok(
      'the correct manifest link was replaced with a copy of itself, restarting the ' +
        'install check for nothing',
      manifestsIn(doc).length === 1 && !!doc.getElementById('from-nginx'),
    );
  }
}

// ------------------------------------------------------------------- results
if (failures.length) {
  console.error(`\noverlay test: ${failures.length} failure(s) of ${checks} checks\n`);
  for (const f of failures) console.error(`  FAIL  ${f}`);
  process.exit(1);
}
console.log(`overlay test: ${checks}/${checks} checks passed`);
process.exit(0);
