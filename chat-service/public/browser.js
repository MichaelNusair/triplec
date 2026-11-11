/*
 * The Browser page: the box's Chrome, through noVNC.
 *
 * The screen on the box is sized to this page (POST /api/browser/size), so the
 * browser is drawn at 1:1 wherever it fits and scaled only where Chrome cannot be
 * made that small — a phone. Whoever is looking claims the size: on load, on a
 * resize, and when the page comes back into view, so a laptop and a phone sharing
 * it each get their own shape when they look.
 *
 * There is no bar: Chrome's own tabs and address bar are the controls. Keys go
 * straight to the screen from a physical keyboard (noVNC's own handling), with two
 * changes: on a Mac ⌘ is sent as Ctrl, because the browser on the box is Linux Chrome
 * and ⌘C there is nothing; and a paste first carries this device's clipboard across,
 * so ⌘V / Ctrl+V pastes what you copied here. What is copied there comes back onto
 * this device's clipboard. A phone types through a hidden text field, opened by the
 * one floating button (⌨), which is what its keyboard needs to open over.
 */
import RFB from '/chat/vendor/novnc/core/rfb.js';
import keysyms from '/chat/vendor/novnc/core/input/keysymdef.js';

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);
const EMBED = params.get('embed') === '1' && window.parent !== window;
if (EMBED) document.documentElement.classList.add('embed');
const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const XK = {
  BackSpace: 0xff08, Tab: 0xff09, Return: 0xff0d, Escape: 0xff1b, Delete: 0xffff,
  Left: 0xff51, Up: 0xff52, Right: 0xff53, Down: 0xff54, Home: 0xff50, End: 0xff57,
  Control_L: 0xffe3,
};

const screenEl = $('#br-screen');
const statusEl = $('#br-status');
let rfb = null;
let wanted = null;          // the size last asked for, so a resize that changes nothing asks nothing
let retryTimer = null;
let retries = 0;
let remoteClip = '';

// Said only while something is wrong or pending; a live browser has nothing over it.
function status(text, trouble = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('trouble', trouble);
  statusEl.classList.toggle('hidden', text === 'live');
}

let toastTimer = null;
function toast(text, ms = 3000) {
  const el = $('#br-toast');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

async function api(url, options) {
  const res = await fetch(url, { credentials: 'same-origin', ...options });
  if (res.status === 401) {
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    throw new Error('signed out');
  }
  return res;
}

function showDown(html) {
  $('#br-down-text').innerHTML = html;
  $('#br-down').classList.remove('hidden');
}

// --- the size ---------------------------------------------------------------
async function fit(force = false) {
  const width = Math.round(screenEl.clientWidth);
  const height = Math.round(screenEl.clientHeight);
  if (width < 100 || height < 100) return;
  if (!force && wanted && Math.abs(wanted.width - width) < 8 && Math.abs(wanted.height - height) < 8) return;
  wanted = { width, height };
  try {
    const res = await api('/api/browser/size', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ width, height }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `server returned ${res.status}`);
  } catch (err) {
    // Not fatal: the picture is scaled to fit whatever size the screen is.
    if (err.message !== 'signed out') console.warn('browser resize:', err.message);
  }
}

let fitTimer = null;
const fitSoon = () => {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(() => fit(), 350);
};
new ResizeObserver(fitSoon).observe(screenEl);
// Coming back to the page: this device is the one looking now, so it gets its shape back.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') fit(true);
});
window.addEventListener('focus', () => fit(true));

// --- the connection ---------------------------------------------------------
async function start() {
  clearTimeout(retryTimer);
  $('#br-down').classList.add('hidden');
  status('connecting…');
  let state;
  try {
    const res = await api('/api/browser/status');
    if (res.status === 404) {
      showDown('The browser is not part of this install. Turn on <code>features.browser</code> in its config and run the installer again.');
      status('off', true);
      return;
    }
    state = await res.json();
  } catch (err) {
    if (err.message === 'signed out') return;
    state = { running: false };
  }
  if (!state.running) {
    showDown('The browser isn\'t running on this box. It starts with <code>sudo systemctl start triplec-browser</code>.');
    status('not running', true);
    return;
  }
  await fit(true);
  connect();
}

function connect() {
  if (rfb) {
    rfb.disconnect();
    rfb = null;
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  rfb = new RFB(screenEl, `${proto}//${location.host}/ws/browser`, { shared: true });
  rfb.scaleViewport = true;     // fit, never scroll: the screen is already this size
  rfb.resizeSession = false;    // sizing is /api/browser/size's, which x11vnc cannot do
  rfb.background = '#000';
  rfb.qualityLevel = 7;
  rfb.compressionLevel = 2;
  rfb.addEventListener('connect', () => {
    retries = 0;
    status('live');
    if (!EMBED || document.hasFocus()) rfb.focus();
  });
  rfb.addEventListener('disconnect', (e) => {
    rfb = null;
    if (e.detail?.clean) {
      status('disconnected', true);
    } else {
      status('reconnecting…', true);
    }
    // The box restarted the browser, or the network blinked: try again, more slowly
    // each time, and say so once it has clearly gone.
    retries += 1;
    if (retries > 6) {
      showDown('Lost the browser. It may have stopped on the box: <code>systemctl status triplec-browser</code>.');
      return;
    }
    retryTimer = setTimeout(start, Math.min(8000, 500 * 2 ** retries));
  });
  rfb.addEventListener('clipboard', (e) => {
    remoteClip = e.detail?.text || '';
    // Straight onto this device's clipboard, which a focused page may do in Chrome.
    // Where it may not (Safari wants a tap), the next tap on the page does it.
    if (remoteClip && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(remoteClip).then(() => { remoteClip = ''; }).catch(() => {});
    }
  });
}

$('#br-retry').addEventListener('click', () => {
  retries = 0;
  start();
});

// --- keys -------------------------------------------------------------------
function tap(sym, code) {
  rfb?.sendKey(sym, code);
}
function chord(sym, code) {
  if (!rfb) return;
  rfb.sendKey(XK.Control_L, 'ControlLeft', true);
  rfb.sendKey(sym, code);
  rfb.sendKey(XK.Control_L, 'ControlLeft', false);
}
function typeChar(ch) {
  if (ch === '\n') return tap(XK.Return, 'Enter');
  if (ch === '\t') return tap(XK.Tab, 'Tab');
  const sym = keysyms.lookup(ch.codePointAt(0));
  if (sym) rfb?.sendKey(sym, null);
}

/** This device's clipboard onto the box's, then Ctrl+V there. */
async function pasteIntoRemote() {
  if (!rfb) return;
  let text = null;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    text = window.prompt('Paste here, and it goes to the browser:') ?? null;
  }
  if (text === null) return;
  rfb.clipboardPasteFrom(text);
  // Give x11vnc a moment to own the selection before Chrome asks for it.
  setTimeout(() => chord(0x76, 'KeyV'), 60);
}

const inField = (el) => el && el.closest?.('input, textarea, select, [contenteditable]') && el.id !== 'br-type';

// Capture phase, so these run before noVNC's own key handling on the screen.
document.addEventListener('keydown', (e) => {
  if (!rfb || inField(e.target) || e.target?.id === 'br-type') return;
  const accel = MAC ? e.metaKey : e.ctrlKey;
  if (accel && !e.altKey && e.key.toLowerCase() === 'v') {
    e.preventDefault();
    e.stopImmediatePropagation();
    pasteIntoRemote();
    return;
  }
  if (!MAC) return;
  // ⌘ itself is never sent — it would arrive on the box as Super — and ⌘<key> goes as
  // Ctrl+<key>, which is what the same keys mean in Chrome on Linux.
  if (e.key === 'Meta') {
    e.preventDefault();
    e.stopImmediatePropagation();
    return;
  }
  if (e.metaKey && !e.ctrlKey && e.key.length === 1) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const sym = keysyms.lookup(e.key.toLowerCase().codePointAt(0));
    if (sym) chord(sym, e.code);
  }
}, true);
document.addEventListener('keyup', (e) => {
  if (MAC && (e.key === 'Meta' || e.metaKey) && !inField(e.target)) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}, true);

// The phone's keyboard: a hidden field, diffed on every change, so autocorrect,
// swipe typing and dictation all arrive as what they finally wrote.
const typeEl = $('#br-type');
let typed = '';
typeEl.addEventListener('input', () => {
  const now = typeEl.value;
  let same = 0;
  while (same < typed.length && same < now.length && typed[same] === now[same]) same += 1;
  for (let i = typed.length; i > same; i -= 1) tap(XK.BackSpace, 'Backspace');
  for (const ch of now.slice(same)) typeChar(ch);
  typed = now;
  // After a line, start clean: nothing before it can be corrected any more.
  if (now.endsWith('\n') || now.length > 400) {
    typeEl.value = '';
    typed = '';
  }
});
typeEl.addEventListener('keydown', (e) => {
  const keys = {
    Backspace: XK.BackSpace, Escape: XK.Escape, Tab: XK.Tab, Delete: XK.Delete,
    ArrowLeft: XK.Left, ArrowRight: XK.Right, ArrowUp: XK.Up, ArrowDown: XK.Down,
  };
  // A backspace with nothing in the field changes nothing there, so no input event
  // would carry it; and the arrows never change the field at all.
  if (e.key === 'Backspace' && typeEl.value) return;
  if (keys[e.key]) {
    e.preventDefault();
    tap(keys[e.key], e.code || e.key);
  }
});
$('#br-keys').addEventListener('click', () => {
  if (document.activeElement === typeEl) {
    typeEl.blur();
    return;
  }
  typeEl.value = '';
  typed = '';
  typeEl.focus();
});
typeEl.addEventListener('focus', () => $('#br-keys').setAttribute('aria-pressed', 'true'));
typeEl.addEventListener('blur', () => $('#br-keys').setAttribute('aria-pressed', 'false'));

// A copy the clipboard refused without a gesture goes across on the next one.
document.addEventListener('pointerdown', () => {
  if (!remoteClip || !navigator.clipboard?.writeText) return;
  navigator.clipboard.writeText(remoteClip).then(() => {
    remoteClip = '';
    toast('Copied');
  }).catch(() => {});
}, true);

// The mux focuses its pane's frame by message; that means the screen, for keys.
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.source !== window.parent) return;
  if (e.data?.type === 'focus') {
    fit(true);
    rfb?.focus();
  }
});

start();
