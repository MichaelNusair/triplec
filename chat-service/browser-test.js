/**
 * Tests for the Browser pane: the box's Chrome, shown through noVNC.
 *
 * Needs no X server, no VNC server and no Chrome — each is faked at the boundary the
 * chat service actually talks across, so this runs the same on the deploy box:
 *
 *   1. The socket bridge: bytes both ways between a WebSocket and Xvnc's unix
 *      socket, untouched; a hang-up on either side ends the other; and a browser
 *      that is not running is a distinct close code the page can explain.
 *   2. Sizing: what screen a viewer of a given size gets, and that a resize asks
 *      xrandr (a fake that records its arguments) and DevTools (a fake that answers
 *      the four methods used) for exactly that.
 *   3. The address box: what it will open, and what it refuses.
 *   4. noVNC's files: the two directories it needs, and not a byte else of
 *      node_modules.
 *   5. The mux: the Browser link opens one pane, never two, and a reload keeps it.
 *   6. The video stream (browser-video.js), against a fake ffmpeg that writes a
 *      known H.264 stream: split into frames at the delimiters, starting at a
 *      keyframe, restarted at the new size on a resize, capped at three viewers, and
 *      the encoder gone when the page is.
 *
 * The login gate on all of it is auth-test.js's: every route is in its `guarded`
 * list, and /ws/browser is refused at the handshake there.
 *
 * Run: node chat-service/browser-test.js
 */
import { createServer as createNetServer } from 'net';
import { createServer as createHttpServer } from 'http';
import { mkdtemp, writeFile, readFile, rm, chmod, realpath } from 'fs/promises';
import { readFileSync } from 'fs';
import { once } from 'events';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';
import WebSocket, { WebSocketServer } from 'ws';

const here = dirname(fileURLToPath(import.meta.url));

let passed = 0;
const failures = [];
function check(label, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = await realpath(await mkdtemp(join(tmpdir(), 'triplec-browser-')));
const xrandrLog = join(root, 'xrandr.log');
const fakeXrandr = join(root, 'xrandr');
// Records its arguments and the X environment it was given; fails only when told to.
await writeFile(fakeXrandr, `#!/bin/sh
printf '%s|%s|%s\\n' "$DISPLAY" "$XAUTHORITY" "$*" >> "${xrandrLog}"
# Asked with no arguments, it describes the screen the way Xvnc's does.
[ $# -eq 0 ] && { echo "Screen 0: minimum 32 x 32, current 2400 x 1500, maximum 32768 x 32768"; echo "VNC-0 connected 2400x1500+0+0 0mm x 0mm"; }
[ -n "$FAKE_XRANDR_FAIL" ] && case "$*" in --output*) echo "cannot set mode" >&2; exit 1;; esac
exit 0
`);
await chmod(fakeXrandr, 0o755);

// A fake DevTools endpoint: /json/version, and a browser socket that answers the
// methods browser.js uses. Records every call.
const devtoolsCalls = [];
const devtoolsHttp = createHttpServer((req, res) => {
  if (req.url === '/json/version') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ Browser: 'Chrome/fake', webSocketDebuggerUrl: `ws://127.0.0.1:${devtoolsHttp.address().port}/devtools/browser/x` }));
    return;
  }
  res.writeHead(404);
  res.end();
});
const devtoolsWss = new WebSocketServer({ server: devtoolsHttp });
devtoolsWss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    const { id, method, params } = JSON.parse(raw);
    devtoolsCalls.push({ method, params });
    const result = {
      'Target.getTargets': { targetInfos: [
        { targetId: 'A', type: 'page', url: 'https://a.example/' },
        { targetId: 'B', type: 'page', url: 'https://b.example/' },
        { targetId: 'W', type: 'service_worker', url: 'https://a.example/sw.js' },
      ] },
      // Two tabs in one window, so the window must be resized once, not twice.
      'Browser.getWindowForTarget': { windowId: 7 },
      'Browser.setWindowBounds': {},
      'Target.createTarget': { targetId: 'NEW' },
      'Target.activateTarget': {},
    }[method];
    ws.send(JSON.stringify(result ? { id, result } : { id, error: { message: `unknown ${method}` } }));
  });
});
devtoolsHttp.listen(0, '127.0.0.1');
await once(devtoolsHttp, 'listening');

// The module reads its settings when it loads, so they are set first.
process.env.TRIPLEC_BROWSER_DIR = root;
process.env.TRIPLEC_BROWSER_DISPLAY = ':55';
process.env.TRIPLEC_BROWSER_DEBUG_PORT = String(devtoolsHttp.address().port);
// At 2, so the sizing below shows the multiplication; 1 is the default.
process.env.TRIPLEC_BROWSER_SCALE = '2';
process.env.TRIPLEC_XRANDR = fakeXrandr;
const browser = await import('./browser.js');

// A fake ffmpeg: answers -version, records each run, then writes four access units —
// a keyframe (with its SPS) and two others, each after a delimiter — and stays up,
// the way an encoder does, until it is killed.
const ffmpegLog = join(root, 'ffmpeg.log');
const fakeFfmpeg = join(root, 'ffmpeg');
await writeFile(fakeFfmpeg, `#!/bin/sh
[ "$2" = "-version" ] && exit 0
echo "$$ $*" >> "${ffmpegLog}"
printf '\\000\\000\\000\\001\\011\\360\\000\\000\\000\\001\\147\\102\\000\\000\\000\\001\\145\\210'
printf '\\000\\000\\000\\001\\011\\360\\000\\000\\000\\001\\101\\232'
printf '\\000\\000\\000\\001\\011\\360\\000\\000\\000\\001\\101\\233'
printf '\\000\\000\\000\\001\\011\\360'
exec sleep 60
`);
await chmod(fakeFfmpeg, 0o755);
process.env.TRIPLEC_FFMPEG = fakeFfmpeg;
const video = await import('./browser-video.js');

// A fake Xvnc: says the RFB greeting, then echoes everything back reversed, so a
// test can tell what came from where.
const vncSock = join(root, 'vnc.sock');
let vncConns = [];
function startVnc() {
  const srv = createNetServer((conn) => {
    vncConns.push(conn);
    conn.write('RFB 003.008\n');
    conn.on('data', (d) => conn.write(Buffer.from([...d].reverse())));
    conn.on('error', () => {});
  });
  srv.listen(vncSock);
  return once(srv, 'listening').then(() => srv);
}

// The bridge, behind a bare WebSocket server: the gate in front of it is auth-test's.
const bridge = createHttpServer();
const bridgeWss = new WebSocketServer({ server: bridge });
bridgeWss.on('connection', (ws) => browser.serveBrowser(ws));
bridge.listen(0, '127.0.0.1');
await once(bridge, 'listening');
const bridgeUrl = `ws://127.0.0.1:${bridge.address().port}/`;

function connect() {
  const ws = new WebSocket(bridgeUrl);
  const got = [];
  const closed = new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: String(reason) })));
  ws.on('message', (d) => got.push(Buffer.from(d)));
  return { ws, got, closed, opened: once(ws, 'open') };
}

console.log('the socket');
{
  const down = connect();
  const { code, reason } = await down.closed;
  check('no browser running: the socket closes with 4404, which the page explains', code === 4404, `${code} ${reason}`);
  const status = await browser.browserStatus();
  check('…and the status says it is not running', status.running === false);

  const vnc = await startVnc();
  check('outside host mode, a browser that is not running is not one this install has', status.installed === false);
  check('with Xvnc listening, the status says running, and where DevTools is',
    (await browser.browserStatus()).running === true
      && (await browser.browserStatus()).debugUrl === `http://127.0.0.1:${devtoolsHttp.address().port}`);

  const c = connect();
  await c.opened;
  await sleep(50);
  check("Xvnc's bytes reach the page unchanged", Buffer.concat(c.got).toString() === 'RFB 003.008\n',
    JSON.stringify(Buffer.concat(c.got).toString()));
  c.got.length = 0;
  c.ws.send(Buffer.from([1, 2, 3, 250]));
  await sleep(50);
  check("the page's bytes reach Xvnc unchanged (and come back through the fake)",
    Buffer.concat(c.got).equals(Buffer.from([250, 3, 2, 1])), Buffer.concat(c.got).toString('hex'));

  const big = Buffer.alloc(3 * 1024 * 1024, 7);
  let received = 0;
  c.ws.on('message', (d) => { received += d.length; });
  vncConns.at(-1).write(big);
  for (let i = 0; i < 100 && received < big.length; i++) await sleep(20);
  check('a multi-megabyte frame arrives whole', received === big.length, `${received} of ${big.length}`);

  const conn = vncConns.at(-1);
  const connClosed = once(conn, 'close');
  c.ws.close();
  await Promise.race([connClosed, sleep(1000)]);
  check('the page hanging up hangs up Xvnc', conn.destroyed);

  const d = connect();
  await d.opened;
  await sleep(30);
  vncConns.at(-1).end();
  const ended = await Promise.race([d.closed, sleep(1000).then(() => null)]);
  check('Xvnc hanging up closes the page\'s socket', ended !== null, JSON.stringify(ended));

  vnc.close();
  for (const s of vncConns) s.destroy();
  vncConns = [];
}

console.log('sizing');
{
  const size = browser.screenSizeFor;
  check('Chrome draws at the scale the config gives it', browser.SCALE === 2);
  check('a laptop pane gets two screen pixels per CSS pixel, so a 2× display is sharp',
    JSON.stringify(size(1200, 760)) === JSON.stringify({ width: 2400, height: 1520 }), JSON.stringify(size(1200, 760)));
  const phone = size(390, 760);
  check("a phone keeps its shape at Chrome's narrowest window (500, at 2×)",
    phone.width === 1000 && phone.height === 1948, JSON.stringify(phone));
  const huge = size(5000, 3000);
  check('nothing bigger than the largest screen worth encoding',
    huge.width <= browser.MAX_SIZE.width && huge.height <= browser.MAX_SIZE.height, JSON.stringify(huge));
  check('odd sizes are evened', size(333, 700).height % 2 === 0 && size(333, 700).width === 1000, JSON.stringify(size(333, 700)));
  let threw = null;
  try {
    size('wide', 10);
  } catch (err) {
    threw = err;
  }
  check('nonsense is a 400, not a screen of NaN', threw?.status === 400);

  await writeFile(xrandrLog, '');
  devtoolsCalls.length = 0;
  const result = await browser.resizeBrowser(1000, 700);
  const lines = (await readFile(xrandrLog, 'utf8')).trim().split('\n');
  check('a resize answers the size it chose, in screen pixels', result.width === 2000 && result.height === 1400, JSON.stringify(result));
  check('xrandr is run against the browser\'s own display and X cookie',
    lines.every((l) => l.startsWith(`:55|${join(root, 'Xauthority')}|`)), lines[0]);
  check('…making a mode of exactly that size and switching the screen to it',
    lines.some((l) => l.endsWith('|--newmode 2000x1400 0 2000 0 0 0 1400 0 0 0'))
      && lines.some((l) => l.endsWith('|--addmode VNC-0 2000x1400'))
      && lines.at(-1).endsWith('|--output VNC-0 --mode 2000x1400'), lines.join(' / '));
  check("…on the output the server names, asked rather than assumed",
    lines.filter((l) => l.endsWith('|')).length <= 2, lines.join(' / '));

  // The fake screen says it is 2400x1500 already: asking for that again is nothing to
  // do, and above all not a resize event, which would restart the video encoder.
  await writeFile(xrandrLog, '');
  const callsBefore = devtoolsCalls.length;
  let events = 0;
  browser.screenEvents.once('resize', () => { events += 1; });
  await browser.resizeBrowser(1200, 750);
  const again = (await readFile(xrandrLog, 'utf8')).trim().split('\n');
  check('asking for the size the screen already is changes nothing, and announces nothing',
    events === 0 && !again.some((l) => /--output|--newmode/.test(l)), again.join(' / '));
  devtoolsCalls.length = callsBefore;
  const bounds = devtoolsCalls.filter((c) => c.method === 'Browser.setWindowBounds');
  check("every Chrome window is set to fill it, in Chrome's own 2× pixels — once per window, not once per tab",
    bounds.length === 2 && bounds[0].params.bounds.windowState === 'normal'
      && JSON.stringify(bounds[1].params) === JSON.stringify({ windowId: 7, bounds: { left: 0, top: 0, width: 1000, height: 700 } }),
    JSON.stringify(bounds));
  check('…asking only about pages, not service workers',
    !devtoolsCalls.some((c) => c.method === 'Browser.getWindowForTarget' && c.params.targetId === 'W'));

  process.env.FAKE_XRANDR_FAIL = '1';
  let failed = null;
  try {
    await browser.resizeBrowser(800, 600);
  } catch (err) {
    failed = err;
  }
  delete process.env.FAKE_XRANDR_FAIL;
  check('a screen that will not resize is a 502 that says so', failed?.status === 502 && /cannot set mode/.test(failed.message),
    failed?.message);
}

console.log('the address box');
{
  const u = browser.urlFor;
  const cases = [
    ['example.com', 'https://example.com/'],
    ['https://example.com/a?b=c', 'https://example.com/a?b=c'],
    ['http://intranet.local/', 'http://intranet.local/'],
    ['localhost:3000', 'http://localhost:3000/'],
    ['127.0.0.1:8080/x', 'http://127.0.0.1:8080/x'],
    ['how to bake bread', 'https://www.google.com/search?q=how%20to%20bake%20bread'],
  ];
  for (const [input, want] of cases) {
    let got;
    try {
      got = u(input);
    } catch (err) {
      got = `threw ${err.message}`;
    }
    check(`"${input}" opens ${want}`, got === want, got);
  }
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'chrome://settings', 'data:text/html,hi', '', '   ']) {
    let threw = null;
    try {
      u(bad);
    } catch (err) {
      threw = err;
    }
    check(`"${bad}" is refused`, threw?.status === 400, threw ? threw.message : 'opened');
  }
  devtoolsCalls.length = 0;
  const opened = await browser.openInBrowser('example.org');
  check('an address opens in a new tab, brought to the front',
    opened.url === 'https://example.org/'
      && devtoolsCalls[0]?.method === 'Target.createTarget' && devtoolsCalls[0].params.url === 'https://example.org/'
      && devtoolsCalls[1]?.method === 'Target.activateTarget' && devtoolsCalls[1].params.targetId === 'NEW',
    JSON.stringify(devtoolsCalls));
}

console.log("noVNC's files");
{
  const f = browser.novncFile;
  const rfb = await f('core/rfb.js');
  check('its client is served, as a module', rfb && /text\/javascript/.test(rfb.type) && /export default class RFB/.test(rfb.body.toString()));
  check('…and pako, which it imports from vendor/', Boolean(await f('vendor/pako/lib/zlib/inflate.js')));
  for (const bad of ['../package.json', 'core/../../ws/index.js', 'core/../package.json', 'docs/API.md',
    'core/rfb.js.map', 'core/', '/etc/passwd', 'core/nope.js', '..%2fpackage.json']) {
    check(`"${bad}" is not`, (await f(bad)) === null);
  }
}

console.log('the mux');
{
  const html = readFileSync(join(here, 'public', 'mux.html'), 'utf8');
  const js = readFileSync(join(here, 'public', 'mux.js'), 'utf8');
  const boot = async (saved, { browserOn = true } = {}) => {
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://claude.example.com/chat/mux' });
    const w = dom.window;
    w.fetch = (url) => {
      const reply = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
      if (String(url).startsWith('/api/browser/status')) {
        if (browserOn === 'aws') return reply({ running: false, installed: false });
        return browserOn ? reply({ running: false, installed: true }) : reply({ error: 'not found' }, 404);
      }
      if (String(url).startsWith('/api/projects')) return reply({ projects: [] });
      return reply({ sessions: [] });
    };
    w.Notification = undefined;
    if (saved) w.localStorage.setItem('triplec-mux', JSON.stringify(saved));
    const errors = [];
    w.addEventListener('error', (e) => errors.push(e.message));
    w.eval(js);
    await sleep(80);
    return { w, doc: w.document, mux: w.__muxForTest, errors };
  };

  const { w, doc, mux, errors } = await boot({ layout: 2 });
  check('the mux boots with the Browser link', errors.length === 0 && !doc.querySelector('#mux-browser').hidden, errors.join('; '));
  doc.querySelector('#mux-browser').dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  await sleep(20);
  const pane = mux.state.panes[0];
  check('it opens the browser in the first empty pane', pane.kind === 'browser'
    && pane.frame?.getAttribute('src') === '/chat/browser?embed=1', pane.frame?.getAttribute('src'));
  check('…labelled as the browser, with only the phone link and close',
    /Browser/.test(pane.el.querySelector('.mux-pane-label').textContent)
      && [...pane.el.querySelectorAll('.mux-pane-btn')].filter((b) => !b.hidden).map((b) => b.dataset.act).join() === 'phone,close');
  check('…and a frame allowed the clipboard, for copy and paste', /clipboard-read/.test(pane.frame.allow));
  mux.focusPane(1);
  mux.openBrowser();
  check('a second click focuses the browser already on screen rather than opening another',
    mux.state.panes.filter((p) => p.kind === 'browser').length === 1 && mux.state.focus === 0);
  const saved = JSON.parse(w.localStorage.getItem('triplec-mux'));

  const again = await boot(saved);
  check('a reload keeps the browser pane where it was',
    again.errors.length === 0 && again.mux.state.panes[0].kind === 'browser'
      && again.mux.state.panes[0].frame?.getAttribute('src') === '/chat/browser?embed=1', again.errors.join('; '));

  const off = await boot({ layout: 2 }, { browserOn: false });
  check('an install without the browser shows no link to one', off.doc.querySelector('#mux-browser').hidden);
  const aws = await boot({ layout: 2 }, { browserOn: 'aws' });
  check('…nor does the AWS deployment, which has the route but no browser service',
    aws.doc.querySelector('#mux-browser').hidden);
}

console.log('the video stream');
{
  const AUD = [0, 0, 0, 1, 9, 0xf0];
  const unit = (...nal) => Buffer.from([...AUD, 0, 0, 1, ...nal]);
  const stream = Buffer.concat([unit(0x67, 0x42), unit(0x65, 0x88), unit(0x41, 0x9a), Buffer.from(AUD)]);
  const split = video.accessUnitSplitter();
  const got = [];
  // A byte at a time: start codes and delimiters split across chunks must still be found.
  for (const b of stream) got.push(...split(Buffer.from([b])));
  check('a stream is cut into frames at each delimiter, even fed a byte at a time',
    got.length === 3 && got.every((u) => u[4] === 9 || u[3] === 9), got.map((u) => u.toString('hex')).join(' / '));
  check('a frame with an IDR slice is a keyframe, and one without is not',
    video.isKeyframe(unit(0x65, 0x88)) && !video.isKeyframe(unit(0x41, 0x9a)) && !video.isKeyframe(unit(0x67, 0x42)));
  check('a 1080p screen is level 4.1', video.codecFor(1920, 1080)?.codec === 'avc1.42E029');
  check("the owner's 2326x1274 is level 5.0", video.codecFor(2326, 1274)?.codec === 'avc1.42E032', video.codecFor(2326, 1274)?.codec);
  check('past level 5.1 there is no video, and the page keeps VNC', video.codecFor(5120, 3200) === null);
  const args = video.ffmpegArgs({ width: 1000, height: 700, display: ':55' });
  const after = (flag) => args[args.indexOf(flag) + 1];
  check('ffmpeg grabs exactly the screen, from its display, without drawing the pointer (noVNC does)',
    after('-video_size') === '1000x700' && after('-i') === ':55' && after('-draw_mouse') === '0' && after('-f') === 'x11grab');
  check('…and writes H.264 for latency: no B-frames, a delimiter per frame, headers per keyframe',
    after('-tune') === 'zerolatency' && after('-profile:v') === 'baseline' && /aud=1/.test(after('-x264-params'))
      && /repeat-headers=1/.test(after('-x264-params')) && args.at(-1) === 'pipe:1');
  check('the box says it can stream video when ffmpeg runs', (await video.videoAvailable()) === true);

  const vhttp = createHttpServer();
  const vwss = new WebSocketServer({ server: vhttp });
  vwss.on('connection', (ws) => video.serveVideo(ws));
  vhttp.listen(0, '127.0.0.1');
  await once(vhttp, 'listening');
  const vurl = `ws://127.0.0.1:${vhttp.address().port}/`;
  const open = () => {
    const ws = new WebSocket(vurl);
    const text = [];
    const bin = [];
    ws.on('message', (d, isBinary) => (isBinary ? bin : text).push(isBinary ? Buffer.from(d) : JSON.parse(d)));
    const closed = new Promise((r) => ws.on('close', (code, reason) => r({ code, reason: String(reason) })));
    return { ws, text, bin, closed, opened: once(ws, 'open') };
  };
  await writeFile(ffmpegLog, '');
  const v = open();
  await v.opened;
  for (let i = 0; i < 50 && v.bin.length < 3; i++) await sleep(20);
  check('a viewer is told the size and codec first', v.text[0]?.type === 'size' && v.text[0].width === 2400
    && v.text[0].height === 1500 && /^avc1\.42E0/.test(v.text[0].codec), JSON.stringify(v.text[0]));
  check('…then gets one message per frame, starting at the keyframe',
    v.bin.length === 3 && video.isKeyframe(v.bin[0]) && !video.isKeyframe(v.bin[1]), `${v.bin.length} frames`);
  const runs = () => readFile(ffmpegLog, 'utf8').then((t) => t.trim().split('\n').filter(Boolean));
  const first = (await runs())[0] || '';
  check('the encoder captures the screen at its current size', / -video_size 2400x1500 /.test(first), first);

  browser.screenEvents.emit('resize', { width: 1000, height: 700 });
  for (let i = 0; i < 50 && v.text.length < 2; i++) await sleep(20);
  const all = await runs();
  const firstPid = Number(first.split(' ')[0]);
  let oldAlive = true;
  try { process.kill(firstPid, 0); } catch { oldAlive = false; }
  check('a resize restarts the encoder at the new size, announced first',
    v.text[1]?.width === 1000 && all.length === 2 && / -video_size 1000x700 /.test(all[1]) && !oldAlive,
    `${JSON.stringify(v.text[1])} / ${all.join(' | ')} / old alive: ${oldAlive}`);

  const more = [open(), open()];
  await Promise.all(more.map((m) => m.opened));
  const fourth = open();
  const refused = await Promise.race([fourth.closed, sleep(2000).then(() => null)]);
  check(`past ${video.MAX_VIEWERS} viewers the next is refused with 4429, so it keeps VNC`, refused?.code === 4429, JSON.stringify(refused));

  const lastPid = Number((await runs()).at(-1).split(' ')[0]);
  for (const c of [v, ...more]) c.ws.close();
  for (let i = 0; i < 50 && video.videoViewers() > 0; i++) await sleep(20);
  await sleep(100);
  let alive = true;
  try { process.kill(lastPid, 0); } catch { alive = false; }
  check('a page that leaves takes its encoder with it', video.videoViewers() === 0 && !alive, `viewers ${video.videoViewers()}, alive ${alive}`);
  vhttp.close();
}

devtoolsHttp.close();
bridge.close();
await rm(root, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
