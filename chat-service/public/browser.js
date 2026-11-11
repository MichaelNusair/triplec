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
 *
 * The picture comes as H.264 video where it can (/ws/browser-video, decoded by
 * WebCodecs — see chat-service/browser-video.js for why), and the VNC connection is
 * then asked for one pixel instead of the screen: it carries the keys, the pointer
 * and the clipboard, and its canvas, transparent, stays on top to take the mouse.
 * Anything that stops the video — no WebCodecs, a decoder error, a screen too big —
 * falls back to VNC's own picture for the rest of the page's life. ?vnc forces that.
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
// noVNC's own canvas, inside the box it makes in #br-screen — not the video's, which
// sits beside that box.
const vncCanvas = () => screenEl.querySelector(':scope > div canvas');
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
  await chooseVideo(state);
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
  rfb.resizeSession = false;    // sizing is /api/browser/size's: the screen is twice the page
  // In video mode noVNC's own box must not cover the video behind it.
  rfb.background = videoMode ? 'transparent' : '#000';
  rfb.qualityLevel = 7;
  rfb.compressionLevel = 2;
  watchCursor();
  rfb.addEventListener('connect', () => {
    retries = 0;
    status('live');
    if (!EMBED || document.hasFocus()) rfb.focus();
    connectVideo();
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

// --- the picture, as video ---------------------------------------------------
const ORIGINAL = {
  fbUpdateRequest: RFB.messages.fbUpdateRequest,
  enableContinuousUpdates: RFB.messages.enableContinuousUpdates,
};
let videoMode = false;
let videoBroken = false;       // once it has failed, VNC's picture for the rest of this page
let video = null;              // { ws, decoder, waitKey, n, fps, shown }
let videoFailures = 0;
const videoCanvas = document.createElement('canvas');
videoCanvas.id = 'br-video';
screenEl.prepend(videoCanvas);
const videoCtx = videoCanvas.getContext('2d');

/**
 * Video mode on or off. On, noVNC's update requests are narrowed to one pixel — the
 * same messages, for a 1x1 region — so the VNC server encodes nothing while the
 * video carries the picture. Set before noVNC connects, and undone by reconnecting.
 */
function setVideoMode(on) {
  videoMode = on;
  RFB.messages.fbUpdateRequest = on
    ? (sock, incremental) => ORIGINAL.fbUpdateRequest(sock, incremental, 0, 0, 1, 1)
    : ORIGINAL.fbUpdateRequest;
  RFB.messages.enableContinuousUpdates = on
    ? (sock, enable) => ORIGINAL.enableContinuousUpdates(sock, enable, 0, 0, 1, 1)
    : ORIGINAL.enableContinuousUpdates;
  document.documentElement.classList.toggle('br-video', on);
}

async function chooseVideo(state) {
  if (videoBroken || params.has('vnc') || !state.video || typeof VideoDecoder === 'undefined') {
    setVideoMode(false);
    return;
  }
  try {
    const { supported } = await VideoDecoder.isConfigSupported({ codec: 'avc1.42E033', codedWidth: 1920, codedHeight: 1080 });
    setVideoMode(Boolean(supported));
  } catch {
    setVideoMode(false);
  }
}

/** Give up on video for this page: VNC's own picture, by reconnecting without the narrowing. */
function failVideo(reason) {
  console.warn('browser video: falling back to VNC —', reason);
  videoBroken = true;
  closeVideo();
  setVideoMode(false);
  if (rfb) rfb.disconnect();   // its disconnect handler reconnects, now with the whole screen
}

function closeVideo() {
  const v = video;
  video = null;
  if (!v) return;
  try { v.ws.close(); } catch { /* already closed */ }
  try { if (v.decoder && v.decoder.state !== 'closed') v.decoder.close(); } catch { /* already closed */ }
}

/** Whether an access unit holds an IDR slice (NAL type 5). */
function isKeyframe(data) {
  for (let i = 0; i + 3 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      if ((data[i + 3] & 0x1f) === 5) return true;
      i += 2;
    }
  }
  return false;
}

/** Lay the video exactly under noVNC's canvas, so a click lands where it is drawn. */
function placeVideo() {
  const c = vncCanvas();
  if (!c) return;
  const a = c.getBoundingClientRect();
  const b = screenEl.getBoundingClientRect();
  Object.assign(videoCanvas.style, {
    left: `${a.left - b.left}px`, top: `${a.top - b.top}px`, width: `${a.width}px`, height: `${a.height}px`,
  });
}
new ResizeObserver(placeVideo).observe(screenEl);

function connectVideo() {
  if (!videoMode || video || !rfb || document.visibilityState !== 'visible') return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws/browser-video`);
  ws.binaryType = 'arraybuffer';
  const v = { ws, decoder: null, waitKey: true, n: 0, fps: 30, shown: false };
  video = v;

  const configure = (msg) => {
    if (v.decoder && v.decoder.state !== 'closed') v.decoder.close();
    v.fps = msg.fps || 30;
    v.waitKey = true;
    videoCanvas.width = msg.width;
    videoCanvas.height = msg.height;
    v.decoder = new VideoDecoder({
      output: (frame) => {
        videoCtx.drawImage(frame, 0, 0, videoCanvas.width, videoCanvas.height);
        frame.close();
        if (!v.shown) {
          v.shown = true;
          videoFailures = 0;
          placeVideo();
        }
      },
      error: (err) => {
        if (video === v) failVideo(`decoder: ${err.message}`);
      },
    });
    v.decoder.configure({ codec: msg.codec, codedWidth: msg.width, codedHeight: msg.height, optimizeForLatency: true });
    placeVideo();
  };

  ws.addEventListener('message', (e) => {
    if (video !== v) return;
    if (typeof e.data === 'string') {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'size') {
        try {
          configure(msg);
        } catch (err) {
          failVideo(`configure: ${err.message}`);
        }
      }
      return;
    }
    const d = v.decoder;
    if (!d || d.state !== 'configured') return;
    const data = new Uint8Array(e.data);
    const key = isKeyframe(data);
    // Behind: never queue up late frames — wait for the next keyframe instead.
    if (!key && (v.waitKey || d.decodeQueueSize > 3)) {
      v.waitKey = true;
      return;
    }
    v.waitKey = false;
    d.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: Math.round((v.n++ * 1e6) / v.fps), data }));
  });
  ws.addEventListener('close', (e) => {
    if (video !== v) return;
    closeVideo();
    // Refusals that will not change by asking again: too big, too many viewers.
    if (e.code === 4413 || e.code === 4429) {
      failVideo(e.reason || `closed ${e.code}`);
      return;
    }
    videoFailures += v.shown ? 0 : 1;
    if (videoFailures >= 3) {
      failVideo(`could not start (${e.code} ${e.reason || ''})`);
      return;
    }
    setTimeout(connectVideo, 1000);
  });
}

// A page out of sight streams nothing: the box stops its encoder.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') connectVideo();
  else closeVideo();
});

/*
 * The pointer, at its proper size. Chrome on the box draws its cursors at 2× like
 * everything else, and noVNC hands that image to the page at its full pixel size —
 * so Chrome's pointer came out twice the size it should. Each image is restated as a
 * high-resolution cursor (`image-set(… Nx)`), N chosen so the pointer is about the
 * height of an ordinary one: never more than the screen's own scale, and never below
 * 1, because not every cursor is drawn at 2× (X's plain arrow is not). Where noVNC
 * draws the pointer itself instead (touch devices), that drawing is scaled the same.
 */
const POINTER_HEIGHT = 22;
let rawCursor = '';
const cursorSizes = new Map();      // data URL -> natural height
const screenScale = () => {
  const c = vncCanvas();
  return c && c.clientWidth ? c.width / c.clientWidth : 1;
};
const factorFor = (imageHeight) => Math.max(1, Math.min(screenScale(), imageHeight / POINTER_HEIGHT));
function applyCursor() {
  const canvas = vncCanvas();
  const m = rawCursor.match(/^url\("?([^")]+)"?\)\s*(\d+)\s+(\d+)/);
  if (canvas && m) {
    const height = cursorSizes.get(m[1]);
    if (height === undefined) {
      const img = new Image();
      img.onload = () => {
        cursorSizes.set(m[1], img.naturalHeight);
        applyCursor();
      };
      img.src = m[1];
    } else {
      const n = factorFor(height);
      canvas.style.cursor = n <= 1.05
        ? rawCursor
        : `image-set(url("${m[1]}") ${n.toFixed(3)}x) ${Math.round(m[2] / n)} ${Math.round(m[3] / n)}, default`;
    }
  }
  // noVNC's own drawn pointer: a fixed canvas on the body, positioned so its hotspot
  // is under the finger. Scaled about that hotspot, so it stays there.
  const drawn = [...document.body.children].find((el) => el.tagName === 'CANVAS' && el.style.position === 'fixed');
  if (drawn) {
    const n = factorFor(drawn.height);
    const hot = rfb?._cursor?._hotSpot || { x: 0, y: 0 };
    drawn.style.transformOrigin = `${hot.x}px ${hot.y}px`;
    drawn.style.transform = n > 1.05 ? `scale(${(1 / n).toFixed(4)})` : '';
  }
}
function watchCursor() {
  const canvas = vncCanvas();
  if (!canvas) return;
  new MutationObserver(() => {
    const cur = canvas.style.cursor;
    // Only noVNC's own setting, never the one written here: an image-set this browser
    // will not take leaves the old value in place, and that must not loop.
    if (cur.startsWith('url(') && cur !== rawCursor) {
      rawCursor = cur;
      applyCursor();
    } else if (!cur.startsWith('url(') && !cur.includes('image-set')) {
      rawCursor = '';
    }
  }).observe(canvas, { attributes: true, attributeFilter: ['style'] });
  // The first cursor usually arrives before the first frame has given the picture a
  // size, when the scale still reads 1; and the scale changes with every resize.
  new ResizeObserver(applyCursor).observe(canvas);
  // The drawn pointer, on touch devices, changes by being redrawn at a new size.
  const drawn = [...document.body.children].find((el) => el.tagName === 'CANVAS' && el.style.position === 'fixed');
  if (drawn) new MutationObserver(applyCursor).observe(drawn, { attributes: true, attributeFilter: ['width', 'height'] });
}
new ResizeObserver(() => applyCursor()).observe(screenEl);

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
  // Give Xvnc a moment to own the selection before Chrome asks for it.
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
