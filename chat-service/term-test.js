/**
 * Tests for the mux's terminal panes, from `cc` to the page.
 *
 * A terminal pane is a shell on this box, so the parts that can go wrong quietly are
 * the ones tested hardest:
 *
 *   1. Which tmux session `cc` opens. Slots made the bare-name prefix match in tmux
 *      a live hazard — `cc demo` joining `claude-demo/slot-3` — so every target is
 *      checked to be exact, against a fake tmux that records what it was asked.
 *   2. The pty relay, on a real pty: sizes, keystrokes, hanging up, exit status.
 *   3. The socket, through the real server: refused without a session, refused for a
 *      name that is a path, refused with no tmux server to own the session, and an
 *      end-to-end round trip through a fake `cc`.
 *   4. The two pages, in jsdom: the terminal reports to the mux, and the mux rings
 *      for a terminal the way it does for a chat.
 *
 * Needs python3 and bash, which every box this deploys to has. Needs no tmux and no
 * `cc`: both are faked, so this runs the same on the deploy box as here.
 *
 * Run: node chat-service/term-test.js
 */
import { spawn, execFile } from 'child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, realpath, stat } from 'fs/promises';
import { readFileSync } from 'fs';
import { once } from 'events';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { JSDOM } from 'jsdom';
import WebSocket from 'ws';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');

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

const root = await realpath(await mkdtemp(join(tmpdir(), 'triplec-term-')));
const projects = join(root, 'projects');
const bin = join(root, 'bin');
await mkdir(projects, { recursive: true });
await mkdir(bin, { recursive: true });
const tmuxLog = join(root, 'tmux.log');

/*
 * A tmux that records its arguments, one call per line. `has-session` answers yes
 * only for the exact targets listed in $FAKE_TMUX_HAS (as `=name`), which is what
 * makes a prefix target visible as a miss rather than a silent join.
 */
await writeFile(join(bin, 'tmux'), `#!/bin/bash
printf '%s\\n' "$*" >> "${tmuxLog}"
case "$1" in
  has-session) for t in $FAKE_TMUX_HAS; do [ "$3" = "$t" ] && exit 0; done; exit 1 ;;
  display-message) [ -e "${root}/no-server" ] && exit 1; echo 4242 ;;
  list-sessions) [ -e "${root}/no-server" ] && exit 1; printf 'claude-demo/slot-2\\nshell\\n' ;;
  *) exit 0 ;;
esac
`);
await chmod(join(bin, 'tmux'), 0o755);

// A `cc` that says what it was asked for and echoes what is typed, so a round trip
// through the socket, the relay and a pty can be seen end to end.
await writeFile(join(bin, 'cc'), `#!/bin/bash
stty -echo 2>/dev/null
echo "FAKE-CC:$1 IN:$(pwd)"
stty size
while IFS= read -r line; do echo "TYPED:$line"; stty size; done
`);
await chmod(join(bin, 'cc'), 0o755);

const runCc = async (args, env = {}) => {
  await writeFile(tmuxLog, '');
  try {
    const { stdout, stderr } = await execFileAsync('bash', [join(repo, 'scripts', 'cc-session.sh'), ...args], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PROJECTS_ROOT: projects, ...env },
    });
    return { ok: true, out: stdout + stderr, log: await readFile(tmuxLog, 'utf8') };
  } catch (err) {
    return { ok: false, out: `${err.stdout || ''}${err.stderr || ''}`, log: await readFile(tmuxLog, 'utf8') };
  }
};

console.log('cc, naming a slot');
{
  const slot3 = join(projects, 'demo', '.claude', 'worktrees', 'slot-3');
  await mkdir(join(slot3, 'src'), { recursive: true });

  const fresh = await runCc(['demo/slot-3']);
  check('`cc demo/slot-3` starts a session named for the project and the slot',
    fresh.ok && fresh.log.includes(`new-session -d -s claude-demo/slot-3 -c ${slot3} bash -lc claude`), fresh.log + fresh.out);
  check('…looked up by its exact name', fresh.log.includes('has-session -t =claude-demo/slot-3'));
  check('…and attached by its exact name', fresh.log.includes('attach-session -t =claude-demo/slot-3'));
  check('…with its options set on exactly it',
    fresh.log.includes('set-option -t =claude-demo/slot-3: window-size latest'), fresh.log);

  const byPath = await runCc([slot3]);
  check("the slot's path names the same session", byPath.log.includes('new-session -d -s claude-demo/slot-3 '), byPath.log);
  const deeper = await runCc([join(slot3, 'src')]);
  check('so does a folder inside it, opened in the editor',
    deeper.log.includes(`new-session -d -s claude-demo/slot-3 -c ${join(slot3, 'src')} `), deeper.log);

  await mkdir(join(projects, 'demo'), { recursive: true });
  const plain = await runCc(['demo']);
  check('`cc demo` is still `claude-demo`, matched exactly',
    plain.log.includes('has-session -t =claude-demo\n') && plain.log.includes('new-session -d -s claude-demo -c '), plain.log);

  const rejoin = await runCc(['demo/slot-3'], { FAKE_TMUX_HAS: '=claude-demo/slot-3' });
  check('a running slot session is rejoined, not restarted',
    /Rejoining/.test(rejoin.out) && !rejoin.log.includes('new-session'), rejoin.out + rejoin.log);

  for (const bad of ['demo/../etc', 'demo/.hidden', 'demo/a/b', '.demo/slot-1', 'demo/']) {
    const res = await runCc([bad]);
    check(`refuses ${JSON.stringify(bad)}`, !res.ok && !res.log.includes('new-session'), res.out + res.log);
  }
  const missing = await runCc(['demo/slot-7']);
  check('a slot that does not exist is refused, not created', !missing.ok && /No such project or slot/.test(missing.out));
}

console.log('term-relay.py');
{
  const relay = (cols, rows, ...cmd) => spawn('python3', ['-I', join(here, 'term-relay.py'), String(cols), String(rows), ...cmd], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const frame = (kind, payload) => {
    const head = Buffer.alloc(5);
    head.write(kind, 0, 'latin1');
    head.writeUInt32BE(payload.length, 1);
    return Buffer.concat([head, payload]);
  };
  const until = async (proc, re, ms = 4000) => {
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    const end = Date.now() + ms;
    while (Date.now() < end && !re.test(out)) await sleep(20);
    return out;
  };

  const p = relay(91, 23, 'sh', '-c', 'stty -echo; stty size; read a; echo "got:$a"; stty size; read b');
  const sized = await until(p, /23 91/);
  check('the pty starts at the size asked for', /23 91/.test(sized), JSON.stringify(sized));
  const size = Buffer.alloc(4);
  size.writeUInt16BE(132, 0);
  size.writeUInt16BE(41, 2);
  p.stdin.write(frame('r', size));
  p.stdin.write(frame('d', Buffer.from('hello\r')));
  const later = await until(p, /41 132/);
  check('keystrokes arrive as typed', /got:hello/.test(later), JSON.stringify(later));
  check('a resize reaches the pty', /41 132/.test(later), JSON.stringify(later));
  // A frame split across writes is still one frame.
  const split = frame('d', Buffer.from('x\r'));
  p.stdin.write(split.subarray(0, 3));
  await sleep(30);
  p.stdin.write(split.subarray(3));
  const [code] = await once(p, 'exit');
  check('a frame split across writes still arrives, and the exit status is the command\'s', code === 0, `exit ${code}`);

  const hup = relay(80, 24, 'sleep', '30');
  await sleep(200);
  const started = Date.now();
  hup.stdin.end();
  const [hupCode] = await once(hup, 'exit');
  check('closing stdin hangs up the command — for `tmux attach`, a detach', hupCode === 129 && Date.now() - started < 3000,
    `exit ${hupCode} after ${Date.now() - started}ms`);

  const failing = relay(80, 24, 'sh', '-c', 'exit 3');
  const [failCode] = await once(failing, 'exit');
  check("a command's own failure is passed on", failCode === 3, `exit ${failCode}`);
}

console.log('the socket, through the server');
{
  // A project with slots, so the slot routes have something real to answer about.
  const demo = join(projects, 'demo');
  await rm(demo, { recursive: true, force: true });
  await mkdir(demo, { recursive: true });
  const git = (...args) => execFileAsync('git', args, { cwd: demo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' } });
  await git('init', '-q', '-b', 'main');
  await writeFile(join(demo, 'README.md'), '# demo\n');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'first');

  const PORT = 19950 + Math.floor(Math.random() * 40);
  const PASSWORD = 'term-test-password-long-enough-ok';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: here,
    env: {
      ...process.env,
      PORT: String(PORT),
      CW_INSECURE_COOKIES: '1',
      // Pinned, because this box's own shell says `oidc` and the child inherits it.
      CW_AUTH_MODE: 'password',
      AUTH_PASSWORD: PASSWORD,
      SESSION_SECRET: 'term-test-session-secret-0123456789abcdef0123456789',
      PROJECTS_ROOT: projects,
      CW_PUSH_DIR: join(root, 'push'),
      CC_SCRIPT: join(bin, 'cc'),
      TMUX_BIN: join(bin, 'tmux'),
      TERM_PASTE_DIR: join(root, 'pastes'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverErr = '';
  child.stderr.on('data', (d) => { serverErr += d.toString(); });
  const BASE = `http://127.0.0.1:${PORT}`;
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try {
      up = (await fetch(`${BASE}/healthz`)).ok;
    } catch {
      await sleep(100);
    }
  }
  check('the server starts', up, serverErr.slice(0, 300));

  const login = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }),
  });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  check('signed in', login.status === 204 && cookie.startsWith('cw_session='), `status ${login.status}`);

  /** Open a terminal socket and collect everything it says until it closes or `ms` passes. */
  const open = (query, { ms = 3000, auth = true, onOpen } = {}) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/term?${query}`, auth ? { headers: { Cookie: cookie } } : {});
    const got = { json: [], text: '', status: null, closed: false, ws };
    const done = () => {
      clearTimeout(timer);
      resolve(got);
    };
    const timer = setTimeout(() => { try { ws.terminate(); } catch { /* gone */ } done(); }, ms);
    ws.on('unexpected-response', (_req, res) => { got.status = res.statusCode; done(); });
    ws.on('error', () => done());
    ws.on('open', () => onOpen?.(ws, got));
    ws.on('message', (data, isBinary) => {
      if (isBinary) got.text += data.toString();
      else got.json.push(JSON.parse(data.toString()));
    });
    ws.on('close', () => { got.closed = true; done(); });
  });

  const anon = await open('project=demo&slot=3', { auth: false });
  check('no session, no terminal: 401 at the handshake', anon.status === 401, `status ${anon.status}`);

  const traversal = await open('project=..%2Fetc&slot=1');
  check('a project name that is a path is refused',
    traversal.json.some((m) => m.type === 'error') && !traversal.text, JSON.stringify(traversal.json));
  const nine = await open('project=demo&slot=9');
  check('slot 9 is refused', nine.json.some((m) => m.type === 'error' && /slot/.test(m.message)), JSON.stringify(nine.json));
  const nowhere = await open('project=nope&slot=0');
  check('a project that does not exist is refused', nowhere.json.some((m) => m.type === 'error' && /no project/.test(m.message)));

  await writeFile(join(root, 'no-server'), '');
  const orphan = await open('project=demo&slot=1');
  check('with no tmux server, nothing is started — it would die with this service',
    orphan.json.some((m) => m.type === 'error' && /tmux server/.test(m.message)) && !orphan.text, JSON.stringify(orphan.json));
  await rm(join(root, 'no-server'));

  await writeFile(tmuxLog, '');
  const live = await open('project=demo&slot=3&cols=90&rows=20', {
    ms: 5000,
    onOpen: (ws, got) => {
      const poll = setInterval(() => {
        if (!/FAKE-CC/.test(got.text)) return;
        clearInterval(poll);
        ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 33 }));
        setTimeout(() => {
          ws.send(JSON.stringify({ type: 'input', data: 'hi there\r' }));
          ws.send(JSON.stringify({ type: 'scroll', lines: -3 }));
        }, 150);
        setTimeout(() => ws.close(), 1500);
      }, 30);
    },
  });
  const attached = live.json.find((m) => m.type === 'attached');
  check('the pane is attached to the slot\'s session', attached?.session === 'claude-demo/slot-3' && attached.existed === false,
    JSON.stringify(live.json));
  check('`cc` is run for that slot, in that slot', live.text.includes(`FAKE-CC:demo/slot-3 IN:${join(demo, '.claude', 'worktrees', 'slot-3')}`),
    JSON.stringify(live.text.slice(0, 300)));
  check('the slot was created on first use', await stat(join(demo, '.claude', 'worktrees', 'slot-3', '.git')).then(() => true, () => false));
  check('the terminal starts at the size the page asked for', /20 90/.test(live.text), JSON.stringify(live.text.slice(0, 300)));
  check('typing reaches it, after a resize the pty saw', /TYPED:hi there/.test(live.text) && /33 120/.test(live.text),
    JSON.stringify(live.text.slice(0, 400)));
  const log = await readFile(tmuxLog, 'utf8');
  check('scrolling is tmux copy mode, on exactly that session',
    log.includes('copy-mode -e -t =claude-demo/slot-3:') && log.includes('send-keys -t =claude-demo/slot-3: -X -N 3 scroll-up'), log);

  const slotsRes = await fetch(`${BASE}/api/slots?project=demo`, { headers: { Cookie: cookie } });
  const slots = await slotsRes.json();
  check('/api/slots says which slot has a terminal session',
    slots.slots.find((s) => s.n === 2)?.terminal === true && slots.slots.find((s) => s.n === 3)?.terminal === false
      && slots.rootTerminal === false, JSON.stringify(slots.slots?.map((s) => [s.n, s.terminal])));

  const xterm = await fetch(`${BASE}/vendor/xterm.js`, { headers: { Cookie: cookie } });
  const body = await xterm.text();
  check('the emulator is served from its package', xterm.status === 200 && /javascript/.test(xterm.headers.get('content-type'))
    && body.length > 100000, `status ${xterm.status}`);
  const again = await fetch(`${BASE}/vendor/xterm.js`, { headers: { Cookie: cookie, 'If-None-Match': xterm.headers.get('etag') } });
  check('…and a second ask is a 304, not half a megabyte', again.status === 304, `status ${again.status}`);
  for (const path of ['/vendor/package.json', '/vendor/..%2Fpackage.json']) {
    const res = await fetch(`${BASE}${path}`, { headers: { Cookie: cookie } });
    check(`only named files: ${path} is not served`, res.status === 404, `status ${res.status}`);
  }
  // `%2e%2e` is normalised to `..` by the URL parser, so this one never reaches the
  // vendor route at all — it is `/server.js`, which is not in public/ and gets the app
  // shell like any unknown path. What matters is that it is not the source.
  const dotted = await (await fetch(`${BASE}/vendor/%2e%2e/server.js`, { headers: { Cookie: cookie } })).text();
  check('a dotted path does not reach the source', !dotted.includes('createServer') && !dotted.includes('import '), dotted.slice(0, 120));
  // An image pasted into a pane: kept for that session, and its path handed back.
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const paste = (query, type, body, auth = true) => fetch(`${BASE}/api/term/paste?${query}`, {
    method: 'POST', headers: { 'Content-Type': type, ...(auth ? { Cookie: cookie } : {}) }, body,
  });
  const pasted = await paste('project=demo&slot=3', 'image/png', png);
  const { path: pastedPath } = await pasted.json();
  check('a pasted image is saved, and its path answered', pasted.status === 200
    && pastedPath.startsWith(join(root, 'pastes', 'demo_slot-3') + '/') && pastedPath.endsWith('.png')
    && (await readFile(pastedPath)).equals(png), `${pasted.status} ${pastedPath}`);
  check('…readable by its owner only', ((await stat(pastedPath)).mode & 0o777) === 0o600);
  check('only an image is taken', (await paste('project=demo&slot=3', 'text/html', '<b>x</b>')).status === 415);
  check('not for a name that is a path', (await paste('project=..%2Fetc&slot=1', 'image/png', png)).status === 400);
  check('not without a session', (await paste('project=demo&slot=3', 'image/png', png, false)).status === 401);

  const page = await fetch(`${BASE}/term?project=demo&slot=3`, { headers: { Cookie: cookie } });
  check('the terminal page is served', page.status === 200 && (await page.text()).includes('term.js'));

  child.kill('SIGKILL');
  await once(child, 'exit').catch(() => {});
}

console.log('terminal page');
{
  const html = readFileSync(join(here, 'public', 'term.html'), 'utf8');
  const js = readFileSync(join(here, 'public', 'term.js'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://claude.example.com/chat/term?embed=1&project=demo&slot=3' });
  const w = dom.window;
  const posted = [];
  Object.defineProperty(w, 'parent', { get: () => ({ postMessage: (m) => posted.push(m) }) });
  // A stand-in for xterm.js: what the page asks of it, and a way to type into it.
  const fake = { written: [], handlers: {}, cols: 100, rows: 30, focused: 0, resets: 0 };
  w.Terminal = function Terminal() {
    Object.assign(this, {
      cols: fake.cols, rows: fake.rows,
      loadAddon() {}, open() {}, focus() { fake.focused++; }, reset() { fake.resets++; },
      write(d) { fake.written.push(d); },
      onData(f) { fake.handlers.data = f; }, onBinary(f) { fake.handlers.binary = f; },
      onBell(f) { fake.handlers.bell = f; }, onResize(f) { fake.handlers.resize = f; },
      registerLinkProvider() {}, attachCustomKeyEventHandler(f) { fake.handlers.key = f; },
      hasSelection: () => false,
    });
  };
  w.FitAddon = { FitAddon: function FitAddon() { this.fit = () => {}; } };
  w.ResizeObserver = function ResizeObserver() { this.observe = () => {}; };
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  const sockets = [];
  w.WebSocket = function FakeSocket(url) {
    this.url = url;
    this.readyState = 1;
    this.sent = [];
    this.listeners = {};
    this.addEventListener = (type, f) => { (this.listeners[type] ||= []).push(f); };
    this.send = (m) => this.sent.push(m);
    this.fire = (type, event = {}) => (this.listeners[type] || []).forEach((f) => f(event));
    sockets.push(this);
  };
  w.WebSocket.OPEN = 1;
  w.WebSocket.CLOSED = 3;
  w.WebSocket.CLOSING = 2;
  w.fetch = () => Promise.resolve({ status: 204 });
  const errors = [];
  w.addEventListener('error', (e) => errors.push(e.message));
  w.eval(js);

  const ws = sockets[0];
  check('the page boots without an error', errors.length === 0, errors.join('; '));
  const url = new URL(ws?.url || 'ws://x');
  check('it asks for that slot\'s terminal, at its own size',
    url.pathname === '/ws/term' && url.searchParams.get('project') === 'demo' && url.searchParams.get('slot') === '3'
      && url.searchParams.get('cols') === '100', ws?.url);
  check('inside the mux it has no bar of its own', w.document.documentElement.classList.contains('embed'));

  ws.fire('message', { data: JSON.stringify({ type: 'attached', session: 'claude-demo/slot-3', existed: true }) });
  check('the mux is told it is attached', posted.some((m) => m.source === 'triplec-term' && m.type === 'term-state' && m.status === 'attached'));
  ws.fire('message', { data: new Uint8Array([104, 105]).buffer });
  check('the terminal\'s bytes are drawn', fake.written.some((d) => d instanceof w.Uint8Array || d?.length === 2));
  fake.handlers.data('ls\r');
  check('typing is sent as input', ws.sent.some((m) => typeof m === 'string' && JSON.parse(m).type === 'input' && JSON.parse(m).data === 'ls\r'));
  fake.handlers.bell();
  check('the bell is passed to the mux', posted.some((m) => m.type === 'term-bell'));
  w.document.querySelector('#term').dispatchEvent(new w.Event('pointerdown', { bubbles: true }));
  check('a click inside it is reported', posted.some((m) => m.type === 'pane-focus'));

  ws.fire('message', { data: JSON.stringify({ type: 'exit', code: 0 }) });
  ws.fire('close');
  await sleep(20);
  check('a session that ended says so, and offers to start again',
    !w.document.querySelector('#term-ended').classList.contains('hidden') && sockets.length === 1);
  w.document.querySelector('#term-restart').click();
  check('starting again is a new socket, on a cleared terminal', sockets.length === 2 && fake.resets === 1);

  sockets[1].fire('message', { data: JSON.stringify({ type: 'error', message: 'no tmux server is running' }) });
  sockets[1].fire('close');
  await sleep(700);
  check('a refusal is not retried in a loop', sockets.length === 2);
  w.close();
}

console.log('terminal page, on a phone');
{
  const html = readFileSync(join(here, 'public', 'term.html'), 'utf8');
  const js = readFileSync(join(here, 'public', 'term.js'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://claude.example.com/chat/term?embed=1&project=demo&slot=3' });
  const w = dom.window;
  Object.defineProperty(w, 'parent', { get: () => ({ postMessage() {} }) });
  // What Claude Code draws for a permission prompt, as the buffer holds it.
  const screen = [
    'Claude wants to run: npm test',
    '',
    '│ Do you want to proceed?            │',
    '│ ❯ 1. Yes                           │',
    "│   2. Yes, and don't ask again      │",
    '│   3. No, and tell Claude what to do │',
    '',
    'Steps:',
    '1. First install the tools',
    '2. Then run them',
    // A URL longer than the pane, broken by the screen and indented under the margin.
    `  See https://example.com/${'a'.repeat(54)}`,
    `  ${'b'.repeat(40)}/end. Then go.`,
  ];
  const fake = { focused: 0 };
  w.Terminal = function Terminal() {
    Object.assign(this, {
      cols: 80, rows: 30,
      loadAddon() {}, open() {}, focus() { fake.focused++; }, reset() {}, write() {},
      onData() {}, onBinary() {}, onBell() {}, onResize() {},
      buffer: { active: { viewportY: 0, length: 30, getLine: (i) => (i < screen.length ? { translateToString: () => screen[i] } : undefined) } },
      element: { querySelector: () => ({ getBoundingClientRect: () => ({ top: 0, bottom: 300, height: 300, left: 0, width: 800 }) }) },
      registerLinkProvider() {}, attachCustomKeyEventHandler() {}, hasSelection: () => false, clearSelection() {},
      getSelectionPosition: () => fake.selection,
    });
  };
  w.FitAddon = { FitAddon: function FitAddon() { this.fit = () => {}; } };
  w.ResizeObserver = function ResizeObserver() { this.observe = () => {}; };
  w.matchMedia = (q) => ({ matches: /coarse/.test(q), addEventListener() {} });
  const sockets = [];
  w.WebSocket = function FakeSocket() {
    this.readyState = 1;
    this.sent = [];
    this.addEventListener = () => {};
    this.send = (m) => this.sent.push(m);
    sockets.push(this);
  };
  w.WebSocket.OPEN = 1;
  w.fetch = () => Promise.resolve({ status: 204 });
  const errors = [];
  w.addEventListener('error', (e) => errors.push(e.message));
  w.eval(js);
  const t = w.__termForTest;
  const inputs = () => sockets[0].sent.filter((m) => typeof m === 'string').map((m) => JSON.parse(m)).filter((m) => m.type === 'input').map((m) => m.data);

  check('the page boots without an error', errors.length === 0, errors.join('; '));
  check('it does not open the keyboard by itself', fake.focused === 0);
  // Rows are 10px tall: 300px over 30 rows.
  check("a tap on a menu's numbered line is that number", t.choiceAt(45) === '2' && t.choiceAt(35) === '1');
  check('a tap on a numbered list in prose is not', t.choiceAt(85) === null);
  check('a tap on any other line is not', t.choiceAt(5) === null);

  w.document.querySelector('[data-key="enter"]').dispatchEvent(new w.Event('pointerdown', { bubbles: true, cancelable: true }));
  check('the keys have an Enter', inputs().at(-1) === '\r');
  check('…and pressing one leaves the keyboard alone', fake.focused === 0);

  w.document.querySelector('#term-line').value = 'run the tests';
  w.document.querySelector('#term-compose').dispatchEvent(new w.Event('submit', { cancelable: true }));
  await sleep(150);
  check('the compose line is typed, then Enter, apart', inputs().slice(-2).join('|') === 'run the tests|\r', inputs().join('|'));
  check('…and is emptied', w.document.querySelector('#term-line').value === '');

  const url = `https://example.com/${'a'.repeat(54)}${'b'.repeat(40)}/end`;
  const links = t.linksIn(10);
  check('a URL broken across rows is one link, on both rows', links.length === 1 && links[0].url === url
    && links[0].first.y === 10 && links[0].last.y === 11 && t.linksIn(11)[0]?.url === url, JSON.stringify(links));
  check('…and the prose before it is not joined to anything', t.linksIn(9).length === 0);
  fake.selection = { start: { x: 2, y: 10 }, end: { x: 56, y: 11 } };
  check('a selection across it copies the URL whole, without the margin',
    t.selectionText() === `See ${url}. Then go.`, JSON.stringify(t.selectionText()));
  fake.selection = { start: { x: 0, y: 7 }, end: { x: 26, y: 8 } };
  check('…and ordinary rows keep their line breaks', t.selectionText() === 'Steps:\n1. First install the tools',
    JSON.stringify(t.selectionText()));
  w.close();
}

console.log('terminal panes in the mux');
{
  const html = readFileSync(join(here, 'public', 'mux.html'), 'utf8');
  const js = readFileSync(join(here, 'public', 'mux.js'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://claude.example.com/chat/mux' });
  const w = dom.window;
  const path = '/workspace/projects/demo';
  const slotCwd = (n) => `${path}/.claude/worktrees/slot-${n}`;
  const calls = [];
  let status = { state: 'idle', worktree: null, title: null };
  w.fetch = (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET' });
    const reply = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    if (String(url).startsWith('/api/projects')) return reply({ projects: [{ name: 'demo', path, sessions: [] }] });
    if (String(url).startsWith('/api/slots/prepare')) {
      return reply({ ok: true, cwd: slotCwd(JSON.parse(options.body).slot), base: 'main', fetched: false, refreshed: true });
    }
    if (String(url).startsWith('/api/slots')) {
      return reply({ name: 'demo', path, enabled: true, rootTerminal: false, slots: Array.from({ length: 8 }, (_, i) => ({
        n: i + 1, cwd: slotCwd(i + 1), created: true, branch: `slot-${i + 1}`, dirty: 0, unpushed: 0,
        sessions: [], busy: false, held: i === 1, elsewhere: i === 1 ? 1 : 0, terminal: i === 1,
      })) });
    }
    if (String(url).startsWith('/api/claude-status')) return reply(status);
    return reply({ sessions: [] });
  };
  w.Notification = undefined;
  w.localStorage.setItem('triplec-mux', JSON.stringify({
    layout: 2, expanded: ['demo'],
    // Saved before terminals existed: no `kind` on the pane.
    panes: [{ project: 'demo', slot: 4, cwd: slotCwd(4), sessionId: 's4', title: 'old chat' }],
  }));
  const errors = [];
  w.addEventListener('error', (e) => errors.push(e.message));
  w.eval(js);
  await sleep(100);
  const mux = w.__muxForTest;
  const doc = w.document;

  check('the mux boots', errors.length === 0, errors.join('; '));
  check('a layout from before terminals loads as chats', mux.state.panes[0].kind === 'chat'
    && new URL(mux.state.panes[0].frame.src).pathname === '/chat/');
  const row2 = doc.querySelector(`.mux-slot[data-cwd="${slotCwd(2)}"]`);
  check('a slot with a terminal session says so, and is not "somewhere else"',
    /terminal/.test(row2?.querySelector('.mux-slot-facts')?.textContent || '')
      && !/another terminal/.test(row2?.querySelector('.mux-slot-facts')?.textContent || '') && row2.classList.contains('is-live'),
    row2?.outerHTML.slice(0, 400));

  // Clicking that row joins its terminal: no prepare, no question.
  w.confirm = () => { throw new Error('asked'); };
  row2.querySelector('.mux-slot-main').click();
  await sleep(20);
  const pane0 = mux.state.panes[0];
  const src = new URL(pane0.frame.src);
  check('a running terminal is joined, in a terminal frame',
    pane0.kind === 'terminal' && src.pathname === '/chat/term' && src.searchParams.get('slot') === '2' && src.searchParams.get('embed') === '1',
    pane0.frame.src);
  check('…without refreshing its slot', !calls.some((c) => c.url === '/api/slots/prepare'));
  check('a terminal frame gets no microphone', !/microphone/.test(pane0.frame.allow), pane0.frame.allow);

  // New panes as terminals, then + on the project: a free clean slot, prepared first.
  doc.querySelector('[data-kind="terminal"]').click();
  mux.focusPane(1);
  await mux.newInFreeSlot('demo');
  await sleep(20);
  const pane1 = mux.state.panes[1];
  check('with "New: Terminal", + prepares a free slot and opens its terminal',
    calls.some((c) => c.url === '/api/slots/prepare') && pane1.kind === 'terminal' && pane1.slot === 1, JSON.stringify({ kind: pane1.kind, slot: pane1.slot }));
  check('the choice is remembered', JSON.parse(w.localStorage.getItem('triplec-mux')).newKind === 'terminal');

  // The ring, from the bell and from the transcript.
  const fromTerm = (frameWin, data) => w.dispatchEvent(new w.MessageEvent('message', {
    data: { source: 'triplec-term', ...data }, origin: 'https://claude.example.com', source: frameWin,
  }));
  fromTerm(pane0.frame.contentWindow, { type: 'term-bell' });
  check('a bell in an unwatched terminal lights its ring', pane0.attention && /^\(1\) /.test(doc.title), doc.title);
  mux.focusPane(0);
  check('looking at it clears it', !pane0.attention);
  mux.focusPane(1);
  status = { state: 'working', worktree: null, title: 'fix the flaky test' };
  await mux.pollTerminals();
  check('a terminal whose Claude is working reads as working', pane0.busy && pane0.title === 'fix the flaky test');
  status = { state: 'idle', worktree: null, title: 'fix the flaky test' };
  await mux.pollTerminals();
  check('and when it stops, unwatched, its ring lights', !pane0.busy && pane0.attention);

  // Switching kinds keeps the place and stops nothing. Slot 2 has no chat yet, so the
  // chat would be a new agent beside the terminal's Claude — which is asked about.
  let asked = 0;
  w.confirm = () => { asked++; return true; };
  const before = calls.length;
  mux.switchKind(pane0);
  await sleep(20);
  check('a chat beside a running terminal is asked about first', asked === 1, `asked ${asked}`);
  check('the header switch puts the same slot\'s chat in the pane', pane0.kind === 'chat' && pane0.slot === 2
    && new URL(pane0.frame.src).pathname === '/chat/');
  check('…and stops nothing on the way', calls.slice(before).every((c) => c.method === 'GET' || c.url === '/api/slots/prepare'));
  check('the layout saves each pane\'s kind', JSON.parse(w.localStorage.getItem('triplec-mux')).panes[1].kind === 'terminal');
  w.close();
}

await rm(root, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
