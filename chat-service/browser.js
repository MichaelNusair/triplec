/**
 * The Browser pane: a real Google Chrome running on this box, shown in the page.
 *
 * Chrome runs under triplec-browser.service (scripts/triplec-browser.sh) on a
 * virtual X screen, and x11vnc serves that screen as RFB on a unix socket in a 0700
 * directory. There is no TCP port for it: this module is the only way in, and it is
 * reached through /ws/browser, which server.js upgrades only after auth.js has said
 * yes — the same gate, in the same place, as the terminal's socket. A browser on the
 * box is a session on the box: whatever is signed in there, and DevTools, and the
 * downloads folder. So it is gated exactly as hard as a shell.
 *
 * What this module owns:
 *   - the socket: bytes between the page's noVNC and x11vnc, untouched both ways.
 *   - the size: the page says how big it is, and the screen becomes that size
 *     (RandR on Xvfb) with Chrome's windows filling it (DevTools' setWindowBounds),
 *     so a phone gets a phone-shaped browser and a wide pane a wide one, drawn at
 *     SCALE (2×) so a high-DPI display shows it sharp.
 *   - opening a URL in a new tab (POST /api/browser/open), also over DevTools.
 *   - noVNC itself, served from its npm package: two directories of ES modules and
 *     nothing else of node_modules.
 *
 * DevTools listens on 127.0.0.1 only. That is what lets a Claude on this box drive
 * the same browser the person is watching (`--cdp-endpoint http://127.0.0.1:9222`
 * for Playwright's MCP server, `--browser-url` for Chrome's). It is reachable by
 * anything already running as this account on the box, which is already a shell.
 */
import { execFile } from 'child_process';
import { createConnection } from 'net';
import { readFile, stat } from 'fs/promises';
import { dirname, join, normalize, sep } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import WebSocket from 'ws';
import { HOST_MODE } from './host.js';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

// Where triplec-browser.service keeps its socket and X cookie, and how to reach it.
// Overridable for browser-test.js, which runs without an X server or a Chrome.
export const BROWSER_DIR = process.env.TRIPLEC_BROWSER_DIR || '/run/triplec-browser';
const DISPLAY = process.env.TRIPLEC_BROWSER_DISPLAY || ':91';
export const DEBUG_PORT = Number(process.env.TRIPLEC_BROWSER_DEBUG_PORT) || 9222;
const XRANDR = process.env.TRIPLEC_XRANDR || 'xrandr';
const socketPath = () => join(BROWSER_DIR, 'vnc.sock');

// Chrome will not make a window narrower than 500 pixels, and Xvfb was started at
// most this big (BROWSER_MAX in the unit). Outside those, the page scales.
// Chrome draws at SCALE device pixels per CSS pixel (--force-device-scale-factor, set
// by the launcher from the same default), and the screen is sized in device pixels:
// a pane W CSS pixels wide gets a screen W × SCALE wide, which noVNC shows at W — so a
// 2× display gets every pixel it has, instead of a 1× picture blown up and blurred.
// The 500 is Chrome's narrowest window, in its own scaled pixels.
export const SCALE = [1, 2, 3].includes(Number(process.env.TRIPLEC_BROWSER_SCALE))
  ? Number(process.env.TRIPLEC_BROWSER_SCALE) : 2;
export const MIN_WIDTH = 500 * SCALE;
export const MAX_SIZE = { width: 5120, height: 3200 };

/**
 * Whether the browser is up: its socket exists and something is listening on it.
 * And whether this install has one at all: a host install lists the feature only when
 * its installer set up triplec-browser.service, while the AWS deployment has every
 * feature by default and no such service — so there, the mux offers no link to one.
 */
export function browserStatus() {
  return new Promise((resolve) => {
    const sock = createConnection(socketPath());
    const done = (running) => {
      sock.destroy();
      resolve({
        running, installed: HOST_MODE || running, debugPort: DEBUG_PORT, debugUrl: `http://127.0.0.1:${DEBUG_PORT}`,
      });
    };
    sock.setTimeout(1000, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/**
 * Serve one /ws/browser socket: noVNC on one side, x11vnc on the other.
 *
 * Bytes only, in both directions — RFB is x11vnc's to speak and noVNC's to read, and
 * nothing here needs to understand it. Back-pressure each way, because a full-screen
 * repaint is megabytes and a phone on a train drains slowly.
 */
export function serveBrowser(ws) {
  const vnc = createConnection(socketPath());
  let open = false;
  const HIGH_WATER = 4 * 1024 * 1024;

  vnc.on('connect', () => { open = true; });
  vnc.on('data', (chunk) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(chunk, { binary: true });
    if (ws.bufferedAmount > HIGH_WATER) {
      vnc.pause();
      const drain = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount < HIGH_WATER / 4) {
          clearInterval(drain);
          vnc.resume();
        }
      }, 20);
    }
  });
  vnc.on('error', (err) => {
    // 4404: the page tells "not running" from a dropped connection by this code.
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(open ? 1011 : 4404, open ? 'browser connection lost' : `browser not running (${err.code || err.message})`);
    }
  });
  vnc.on('close', () => {
    if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'browser closed');
  });

  ws.on('message', (data) => {
    if (vnc.destroyed) return;
    if (!vnc.write(data)) {
      ws.pause();
      vnc.once('drain', () => ws.resume());
    }
  });
  ws.on('close', () => vnc.destroy());
  ws.on('error', () => vnc.destroy());
}

/**
 * The screen size, in device pixels, for a viewer of `width` × `height` CSS pixels.
 *
 * SCALE device pixels per CSS pixel where possible. Narrower than Chrome's minimum,
 * the screen keeps the viewer's shape at that minimum and the page scales it down to
 * fit, which on a phone is a little under 0.8 — readable, and the alternative is
 * half a browser.
 */
export function screenSizeFor(width, height) {
  let w = Math.round(Number(width));
  let h = Math.round(Number(height));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 100 || h < 100) {
    throw Object.assign(new Error('width and height must be numbers of pixels, at least 100'), { status: 400 });
  }
  w *= SCALE;
  h *= SCALE;
  if (w < MIN_WIDTH) {
    h = Math.round((h * MIN_WIDTH) / w);
    w = MIN_WIDTH;
  }
  const shrink = Math.min(1, MAX_SIZE.width / w, MAX_SIZE.height / h);
  w = Math.max(MIN_WIDTH, Math.floor(w * shrink));
  h = Math.max(200 * SCALE, Math.floor(h * shrink));
  // Even sizes: some encoders and every video path prefer them, and nobody can see
  // the pixel.
  return { width: w - (w % 2), height: h - (h % 2) };
}

function xEnv() {
  return { ...process.env, DISPLAY, XAUTHORITY: join(BROWSER_DIR, 'Xauthority') };
}

async function xrandr(args) {
  try {
    const { stdout } = await execFileAsync(XRANDR, args, { env: xEnv(), timeout: 5000 });
    return { ok: true, out: stdout };
  } catch (err) {
    return { ok: false, out: '', err: String(err.stderr || err.message || '').trim() };
  }
}

/**
 * Make the screen exactly `size`. Xvfb has no modes but the one it started with, so
 * each size is added as a mode first; adding one that exists already fails, harmlessly.
 */
async function resizeScreen({ width, height }) {
  const mode = `${width}x${height}`;
  await xrandr(['--newmode', mode, '0', String(width), '0', '0', '0', String(height), '0', '0', '0']);
  await xrandr(['--addmode', 'screen', mode]);
  const set = await xrandr(['--output', 'screen', '--mode', mode]);
  if (!set.ok) throw Object.assign(new Error(`could not resize the screen: ${set.err}`), { status: 502 });
}

/**
 * A short DevTools session with the browser: `fn` gets `call(method, params)`.
 * Opened per request and closed after, so nothing here holds the browser open or
 * competes with a Claude that is driving it.
 */
async function withDevtools(fn) {
  let version;
  try {
    const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`, { signal: AbortSignal.timeout(3000) });
    version = await res.json();
  } catch {
    throw Object.assign(new Error('the browser is not answering on its DevTools port'), { status: 503 });
  }
  const ws = new WebSocket(version.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const waiter = msg.id && pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(msg.error.message || 'DevTools error'));
    else waiter.resolve(msg.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
    setTimeout(() => {
      if (pending.delete(n)) reject(new Error(`${method} timed out`));
    }, 5000);
  });
  try {
    return await fn(call);
  } finally {
    ws.close();
  }
}

/** Every Chrome window, by id, from the page targets in it. */
async function windowIds(call) {
  const { targetInfos } = await call('Target.getTargets');
  const ids = new Set();
  for (const t of targetInfos.filter((x) => x.type === 'page')) {
    try {
      ids.add((await call('Browser.getWindowForTarget', { targetId: t.targetId })).windowId);
    } catch {
      /* a target that closed between the two calls */
    }
  }
  return [...ids];
}

/**
 * Fit the browser to a viewer: the screen becomes the viewer's size (see
 * screenSizeFor), and every Chrome window fills it. Answers the size it chose, which
 * is what the page will be sent a frame of.
 */
export async function resizeBrowser(width, height) {
  const size = screenSizeFor(width, height);
  await resizeScreen(size);
  // The windows, best effort: a Chrome restarting between the two still comes up at
  // the screen's size, because the launcher reads it.
  await withDevtools(async (call) => {
    for (const windowId of await windowIds(call)) {
      // Out of maximised or fullscreen first; a window in either ignores bounds.
      await call('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }).catch(() => {});
      // In Chrome's own pixels, which are SCALE screen pixels each.
      await call('Browser.setWindowBounds', {
        windowId,
        bounds: { left: 0, top: 0, width: Math.floor(size.width / SCALE), height: Math.floor(size.height / SCALE) },
      }).catch(() => {});
    }
  }).catch(() => {});
  return size;
}

/**
 * What the page's address box typed, as a URL Chrome should open. Something with no
 * scheme that looks like a host is https; anything else is a search, as the omnibox
 * would make it. Only http(s) — chrome://, file:// and javascript: are not this box's
 * to open from a text field, and Chrome's own omnibox is right there for them.
 */
export function urlFor(input) {
  const text = String(input || '').trim();
  if (!text) throw Object.assign(new Error('nothing to open'), { status: 400 });
  if (text.length > 4096) throw Object.assign(new Error('that address is too long'), { status: 400 });
  if (/^https?:\/\//i.test(text)) return new URL(text).href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^\s/:]+:\d+(\/|$)/.test(text)) {
    throw Object.assign(new Error('only http and https addresses open from here — use Chrome\'s own address bar'), { status: 400 });
  }
  if (!/\s/.test(text) && /^[^\s/]+\.[^\s/]+|^localhost(:\d+)?(\/|$)|^[^\s/]+:\d+(\/|$)/i.test(text)) {
    const local = /^(localhost|127\.|\[::1\])/i.test(text);
    return new URL(`${local ? 'http' : 'https'}://${text}`).href;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}

/**
 * Open a URL in a new tab, brought to the front. Always a new tab: which tab is "in
 * front" is not something DevTools reliably says, and navigating the wrong one would
 * throw away someone's page. Chrome's own address bar is there for the current tab.
 */
export async function openInBrowser(input) {
  const url = urlFor(input);
  return withDevtools(async (call) => {
    const { targetId } = await call('Target.createTarget', { url });
    await call('Target.activateTarget', { targetId }).catch(() => {});
    return { url, targetId };
  });
}

/*
 * noVNC, from its package: its `core/` and the `vendor/` it imports (pako), as
 * ES modules the page loads directly. A path is accepted only if it is a .js file
 * under one of those two directories once normalised — not a window onto the rest
 * of node_modules.
 */
const NOVNC_ROOT = join(here, 'node_modules', '@novnc', 'novnc');
export async function novncFile(rel) {
  const clean = normalize(String(rel || ''));
  if (!/^(core|vendor)\/[A-Za-z0-9_./-]+\.js$/.test(clean) || clean.split('/').includes('..')) return null;
  const path = join(NOVNC_ROOT, clean);
  if (!path.startsWith(NOVNC_ROOT + sep)) return null;
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return null;
  return {
    body: await readFile(path),
    type: 'text/javascript; charset=utf-8',
    etag: `"${info.size}-${Math.floor(info.mtimeMs)}"`,
  };
}
