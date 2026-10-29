/**
 * Several projects open at once, on one phone.
 *
 * **A tab is a project, not a conversation.** That is the model these tests exist
 * to hold in place, and it is worth stating because the opposite was built first:
 * a tab per chat, which on a box with 17 projects and 32 conversations gives you a
 * strip of chips you have to remember the meaning of. You move between projects;
 * the conversation is where you are inside one.
 *
 * A second window is only worth having because the first one keeps working while
 * you are not looking at it — which is exactly the part no browser can show you,
 * since everything interesting happens in a thread that is off screen. So the pane
 * model is driven directly here: fake sockets that can be accepted, answered and
 * dropped on demand, and a fake `/api/live` for the tabs that have no socket.
 *
 * The assertions that matter most are about what is *not* done:
 *  - closing a tab must never stop a conversation. The process keeps running, the
 *    transcript is on disk, and the box is still spending money on it, so closing
 *    a tab and ending a turn cannot be the same gesture.
 *  - changing which conversation a window shows must not stop the one it was
 *    showing either. It goes on running on the box; it just is not being watched.
 *  - the live cap must never cool a project that is working. A cooled tab goes
 *    quiet; doing that to a working one hides the very thing tabs exist to report.
 *  - one project is one tab. Two tabs on one directory would be two windows racing
 *    to own the same project's conversation, and a draft could surface under
 *    either.
 *
 * Run: node chat-service/pane-test.js
 */
import { readFileSync } from 'fs';
import { dirname, join as joinPath } from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';
import { APP_NAME, applyDeploymentName } from './manifest.js';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = joinPath(here, 'public');
const html = readFileSync(joinPath(publicDir, 'index.html'), 'utf8');
const js = readFileSync(joinPath(publicDir, 'app.js'), 'utf8');
// Read for one thing only: whether a sheet that outgrows the window can be
// scrolled. jsdom lays nothing out, so the rules are the only thing to assert —
// and the sheet full of a project's conversations is the one that outgrows it.
const css = readFileSync(joinPath(publicDir, 'style.css'), 'utf8');

/**
 * The shell as a named deployment serves it — through the real rewrite, not a
 * hand-written copy of what it is assumed to produce. The client reads the name out
 * of the document, so the two halves only agree if they are tested joined up.
 */
function namedShell(name) {
  const had = Object.hasOwn(process.env, 'PWA_NAME');
  const before = process.env.PWA_NAME;
  process.env.PWA_NAME = name;
  try {
    return applyDeploymentName(html);
  } finally {
    if (had) process.env.PWA_NAME = before;
    else delete process.env.PWA_NAME;
  }
}

const failures = [];
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(name);
  }
}

const DEMO = '/workspace/projects/demo';
const API = '/workspace/projects/api';
// One tab per project means the live cap can only be reached with four *projects*,
// so the fake box has more than two of them.
const WEB = '/workspace/projects/web';
const INFRA = '/workspace/projects/infra';
const DOCS = '/workspace/projects/docs';
/*
 * A conversation that has moved into a worktree: the same project, a directory of
 * its own. Its transcript is recorded there and only there, so it has to be resumed
 * there — see projectPlaces in session-manager.js. The server reports the directory
 * on the row; the client's job is to send it back.
 */
const DOCS_TREE = `${DOCS}/.claude/worktrees/a-branch`;
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * Let the in-flight fetches land before the window goes away.
 *
 * A closed jsdom window has no `document`, so a list refresh still in flight
 * would throw inside the *test*, from a realm nothing can catch it in. Closing at
 * all is only to stop the client's repeating timers.
 */
const finish = async (h) => {
  await settle();
  h.dom.window.close();
};

/*
 * What the box answers on /api/models: the models it offers, and the one a chat
 * gets when the client asks for none. `default` is the deployment's own
 * `defaultModel`, so these tests are written against an upgraded box — one whose
 * default is no longer the model this client used to hard-code.
 */
const DEPLOYMENT_MODELS = {
  default: 'us.anthropic.claude-opus-5-5',
  models: [
    { id: 'us.anthropic.claude-opus-5-5', label: 'Opus 5.5' },
    { id: 'us.anthropic.claude-opus-5', label: 'Opus 5' },
    { id: 'us.anthropic.claude-haiku-4-5', label: 'Haiku 4.5' },
  ],
};

/**
 * What the box has on disk. `live`/`busy` come from `/api/projects` itself, which
 * is how the list looks right on its first paint instead of a poll interval later.
 */
function projectsPayload() {
  const now = Date.now();
  return {
    projects: [
      {
        name: 'demo',
        path: DEMO,
        sessions: [
          { sessionId: 'aaa', mtime: now, title: 'the one still running', live: true, busy: true },
          { sessionId: 'bbb', mtime: now - 60_000, title: 'a finished task' },
          { sessionId: 'ddd', mtime: now - 90_000, title: 'a fourth chat' },
        ],
      },
      {
        name: 'api',
        path: API,
        sessions: [
          { sessionId: 'ccc', mtime: now - 120_000, title: 'an api chat' },
          { sessionId: 'eee', mtime: now - 180_000, title: 'a fifth chat' },
        ],
      },
      { name: 'web', path: WEB, sessions: [{ sessionId: 'fff', mtime: now - 200_000, title: 'a web chat' }] },
      { name: 'infra', path: INFRA, sessions: [{ sessionId: 'ggg', mtime: now - 210_000, title: 'an infra chat' }] },
      {
        name: 'docs',
        path: DOCS,
        sessions: [
          { sessionId: 'hhh', mtime: now - 220_000, title: 'a docs chat', cwd: DOCS, worktree: null },
          // The one in a worktree. Deliberately the only row in this payload with a
          // `worktree`, and deliberately beside rows that carry no `cwd` at all:
          // those are what an older server answers with, and they must go on keying
          // and opening against the project exactly as they did.
          {
            sessionId: 'iii',
            mtime: now - 230_000,
            title: 'a chat in a worktree',
            cwd: DOCS_TREE,
            worktree: 'a-branch',
          },
        ],
      },
    ],
  };
}

/**
 * Boot the client into its own DOM.
 *
 * `saved` is written to localStorage *before* the script runs, because that is the
 * only way to test the case that matters most for a phone's memory: a cold PWA
 * launch with several tabs already open.
 *
 * `shell` is the HTML the server sent, which is not always the file on disk: a named
 * deployment has its titles rewritten on the way out (see namedShell below).
 *
 * `settings` is the same for the settings object — a device that has chosen a model,
 * or one carrying a choice it made before this deployment's default moved. `models`
 * is what the box answers on /api/models, which is where that default comes from.
 */
function bootClient({ saved = null, settings = null, models = null, live = [], shell = html } = {}) {
  const dom = new JSDOM(shell, { runScripts: 'outside-only', url: 'https://claude.example.com/' });
  const w = dom.window;
  if (saved) w.localStorage.setItem('claude-chat-panes', JSON.stringify(saved));
  if (settings) w.localStorage.setItem('claude-chat', JSON.stringify(settings));

  const sockets = [];
  const calls = [];
  // Mutable so a test can change what the box is doing between polls.
  const box = { live };

  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.readyState = FakeSocket.CONNECTING;
      this.sent = [];
      this.closedByClient = false;
      this.handlers = new Map();
      sockets.push(this);
    }

    addEventListener(type, fn) {
      const list = this.handlers.get(type) || [];
      list.push(fn);
      this.handlers.set(type, list);
    }

    send(frame) {
      this.sent.push(JSON.parse(frame));
    }

    close() {
      this.closedByClient = true;
      this.readyState = FakeSocket.CLOSED;
      this.emit('close', {});
    }

    emit(type, event) {
      for (const fn of [...(this.handlers.get(type) || [])]) fn(event);
    }

    /** The server accepted the upgrade. */
    accept() {
      this.readyState = FakeSocket.OPEN;
      this.emit('open', {});
    }

    deliver(msg) {
      this.emit('message', { data: JSON.stringify(msg) });
    }
  }
  FakeSocket.CONNECTING = 0;
  FakeSocket.OPEN = 1;
  FakeSocket.CLOSING = 2;
  FakeSocket.CLOSED = 3;

  w.WebSocket = FakeSocket;
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  // jsdom reports 'prerender', and the client treats anything but 'visible' as a
  // phone in a pocket: no polling, no reconnecting. Made settable because that
  // rule is one of the things worth asserting.
  let visibility = 'visible';
  Object.defineProperty(w.document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
  const json = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  w.fetch = (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/api/live')) return json({ sessions: box.live, at: Date.now() });
    if (u.includes('/api/projects')) return json(projectsPayload());
    if (u.includes('/api/auth-check')) return json({ ok: true });
    return json(models || DEPLOYMENT_MODELS);
  };

  const thrown = [];
  w.addEventListener('error', (e) => thrown.push(e.message));
  try {
    w.eval(js);
  } catch (err) {
    console.error(`FAIL: app.js threw on load — ${err.constructor.name}: ${err.message}`);
    console.error(err.stack?.split('\n').slice(0, 5).join('\n'));
    process.exit(1);
  }

  const $ = (sel) => w.document.querySelector(sel);
  return {
    dom, w, sockets, calls, box, thrown, $,
    setVisibility(value) {
      visibility = value;
      w.document.dispatchEvent(new w.Event('visibilitychange'));
    },
    hooks: w.__panesForTest,
    drafts: w.__draftForTest,
    chips: () => [...w.document.querySelectorAll('#tabs .chip')],
    chipNames: () => [...w.document.querySelectorAll('#tabs .chip-name')].map((c) => c.textContent),
    threads: () => [...w.document.querySelectorAll('#threads .thread')],
    livePanes: () => [...w.__panesForTest.panes.values()].filter((p) => !p.cold),
    toast: () => $('#toast').textContent,
    rows: () => [...w.document.querySelectorAll('#list-body .row')],
    // The line under the tabs: which conversation this project's window is showing.
    convName: () => $('#conv-name').textContent,
    convHidden: () => $('#conv-bar').classList.contains('hidden'),
    sheetRows: () => [...w.document.querySelectorAll('#chats-sheet .sheet-row')],
    sheetHidden: () => $('#chats-sheet').classList.contains('hidden'),
  };
}

/** Everything the server says between an accepted upgrade and a usable chat. */
function joinConversation(sock, { sessionId = null, busy = false, cwd = DEMO } = {}) {
  sock.accept();
  sock.deliver({ type: 'ready' });
  if (sessionId) sock.deliver({ type: 'history', messages: [], truncated: 0 });
  sock.deliver({
    type: 'attached',
    conversationId: `conv-${sessionId || 'new'}`,
    cwd,
    busy,
    sessionId,
  });
  if (busy) sock.deliver({ type: 'joined', busy: true });
}

// --- 1. A cold launch --------------------------------------------------------
console.log('\nComes back to every project without opening every socket:');
{
  // Deliberately in the *old* per-conversation shape, with two demo chats in it:
  // this is what a phone that already had the previous build has on disk, and the
  // upgrade has to produce one demo tab rather than two.
  const saved = {
    panes: [
      { cwd: DEMO, project: 'demo', title: 'a finished task', sessionId: 'bbb' },
      { cwd: DEMO, project: 'demo', title: 'the one still running', sessionId: 'aaa' },
      { cwd: API, project: 'api', title: 'an api chat', sessionId: 'ccc' },
    ],
    activeKey: null,
  };
  const h = bootClient({ saved });
  await settle();

  check('restores one tab per project', h.chipNames().length === 2, h.chipNames().join(', '));
  check('names the tabs after the projects', h.chipNames().join(',') === 'demo,api', h.chipNames().join(','));
  check(
    'a project saved twice becomes one tab, showing the later chat',
    h.hooks.panes.get(DEMO)?.sessionId === 'aaa',
    h.hooks.panes.get(DEMO)?.sessionId,
  );
  check(
    'opens no socket for a project nobody is looking at',
    h.sockets.length === 0,
    `${h.sockets.length} sockets`,
  );
  check('builds no thread for one either', h.threads().length === 0);
  check('every restored tab is cold', [...h.hooks.panes.values()].every((p) => p.cold));
  check('lands on the list when no tab was on screen', h.$('#screen-list').classList.contains('active'));
  check('shows the tab strip', !h.$('#tabs').classList.contains('hidden'));
  check('offers a way to open another project', Boolean(h.$('#tabs .chip-add')));

  // Looking at one is what connects it — and only it.
  const pane = h.hooks.panes.get(h.hooks.paneKey(API));
  h.hooks.activatePane(pane);
  check('activating a cold tab connects exactly one socket', h.sockets.length === 1);
  h.sockets[0].accept();
  const start = h.sockets[0].sent[0];
  check(
    'joins the conversation it was showing rather than starting a new one',
    start?.type === 'start' && start.resumeSessionId === 'ccc' && start.cwd === API,
    JSON.stringify(start),
  );
  check('builds the thread it is about to render into', h.threads().length === 1);
  check('the reheated tab is no longer cold', !pane.cold && !pane.chip.classList.contains('cold'));
  check('the other tabs stay cold', h.livePanes().length === 1);
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  await finish(h);
}

// The tab that was on screen is the one exception: a launch that lands you back
// in a project has to have that project's conversation live.
{
  const h = bootClient({
    saved: {
      panes: [
        { cwd: DEMO, project: 'demo', title: 'the one still running', sessionId: 'aaa' },
        { cwd: API, project: 'api', title: 'an api chat', sessionId: 'ccc' },
      ],
      // The old key shape, which is what a phone upgrading from the previous build
      // actually has. The directory in front of the pipe is the tab to land on.
      activeKey: `${API}|ccc`,
    },
  });
  await settle();
  check('lands back in the project that was on screen', h.$('#screen-chat').classList.contains('active'));
  check('with one socket, for that project only', h.sockets.length === 1);
  h.sockets[0].accept();
  check('resuming the conversation it was showing', h.sockets[0].sent[0]?.resumeSessionId === 'ccc');
  check('the header names the project', h.$('#chat-title').textContent === 'api', h.$('#chat-title').textContent);
  check('and the line under the tabs names the chat', h.convName() === 'an api chat', h.convName());
  check('which is a control, not decoration', !h.convHidden());
  await finish(h);
}

// A project whose name was never saved still gets one, from its directory.
{
  const h = bootClient({
    saved: { panes: [{ cwd: '/workspace/projects/legacy-thing', sessionId: 'qqq' }], activeKey: null },
  });
  await settle();
  check('falls back to the directory name', h.chipNames()[0] === 'legacy-thing', h.chipNames().join(','));
  await finish(h);
}

// --- 2. A conversation nobody is watching -----------------------------------
console.log('\nKeeps a background project rendering, and says when it lands:');
{
  const h = bootClient();
  await settle();
  const a = h.hooks.openConversation({ cwd: DEMO, project: 'demo', sessionId: 'aaa', title: 'the one still running' });
  const sa = h.sockets[0];
  joinConversation(sa, { sessionId: 'aaa', busy: true });
  const b = h.hooks.openConversation({ cwd: API, project: 'api', sessionId: 'ccc', title: 'an api chat' });
  const sb = h.sockets[1];
  joinConversation(sb, { sessionId: 'ccc', cwd: API });

  check('two projects are two tabs', h.chips().length === 2 && h.threads().length === 2);
  check('the second one is on screen', b.thread.classList.contains('active'));
  check('the first one is not', !a.thread.classList.contains('active'));
  check('the tab of a working project says so', a.chip.classList.contains('busy'));

  // The whole point: this arrives while the user is reading something else.
  sa.deliver({ type: 'user_message', text: 'run the tests' });
  sa.deliver({ type: 'delta', text: 'Running ' });
  sa.deliver({ type: 'delta', text: 'them now' });
  check('a background turn renders into its own thread', a.thread.textContent.includes('Running them now'));
  check('and not into the one on screen', !b.thread.textContent.includes('Running'));
  check('the background thread stays off screen while it renders', !a.thread.classList.contains('active'));

  sa.deliver({ type: 'assistant_text', text: 'Running them now — all green.' });
  sa.deliver({ type: 'turn_complete', costUsd: 0.0123 });
  check(
    'announces a background project that finished',
    // Named after the project, to match the chip that just lit up: what the toast
    // has to answer is "which tab do I tap".
    /finished/.test(h.toast()) && h.toast().startsWith('demo'),
    h.toast(),
  );
  check('marks that tab unread', a.chip.classList.contains('unread'));
  check('and stops showing it as working', !a.chip.classList.contains('busy'));
  check('the final text replaced the streamed one exactly once',
    a.thread.textContent.split('all green').length === 2, a.thread.textContent);

  // The chat you are looking at does not announce itself: that would be a toast
  // over the reply you are already reading.
  h.$('#toast').textContent = '';
  sb.deliver({ type: 'turn_complete' });
  check('the chat on screen announces nothing', h.toast() === '', h.toast());
  check('and is never marked unread', !b.chip.classList.contains('unread'));

  h.hooks.activatePane(a);
  check('switching to it clears the unread mark', !a.chip.classList.contains('unread'));
  check('its thread is the one displayed now', a.thread.classList.contains('active') && !b.thread.classList.contains('active'));
  check('the header follows the switch', h.$('#chat-title').textContent === 'demo', h.$('#chat-title').textContent);
  check('and so does the chat name under the tabs', h.convName() === 'the one still running', h.convName());
  check('and the cost it reported is on screen', h.$('#chat-sub').textContent.includes('0.012'));

  // An error is the other thing worth interrupting for: a chat that died in the
  // background looks identical to one still thinking.
  h.hooks.activatePane(b);
  h.$('#toast').textContent = '';
  sa.deliver({ type: 'error', message: 'the session ended' });
  check('announces a background failure too', h.toast().includes('the session ended'), h.toast());
  sa.deliver({ type: 'exit' });
  check('a project whose process is gone is marked on its tab', a.chip.classList.contains('trouble'));
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  await finish(h);
}

// --- 3. One composer, several chats -----------------------------------------
console.log('\nCarries the composer between tabs without mixing two chats up:');
{
  const h = bootClient();
  await settle();
  const input = h.$('#input');
  const a = h.hooks.openConversation({ cwd: DEMO, project: 'demo', sessionId: 'aaa', title: 'the one still running' });
  joinConversation(h.sockets[0], { sessionId: 'aaa' });
  const b = h.hooks.openConversation({ cwd: API, project: 'api', sessionId: 'ccc', title: 'an api chat' });
  joinConversation(h.sockets[1], { sessionId: 'ccc', cwd: API });

  input.value = 'half a sentence about the api';
  h.drafts.saveDraft({ now: true });
  h.hooks.activatePane(a);
  check('switching tabs takes the other project\'s text out of the composer', input.value === '', input.value);

  input.value = 'a different half-sentence';
  h.hooks.activatePane(b);
  check('switching back brings that project\'s text back', input.value === 'half a sentence about the api', input.value);
  h.hooks.activatePane(a);
  check('and the tab left behind keeps its own', input.value === 'a different half-sentence', input.value);

  const savedFor = (pane) => JSON.parse(h.w.localStorage.getItem(h.drafts.draftKeyFor(pane)) || 'null');
  check('each draft is stored under its own conversation', savedFor(b)?.text === 'half a sentence about the api');
  check('...and the other under its own', savedFor(a)?.text === 'a different half-sentence');
  check('a draft records the chat it was typed in', savedFor(b)?.sessionId === 'ccc' && savedFor(b)?.cwd === API);

  // Sending belongs to the chat on screen and to no other. Getting this wrong
  // sends someone's message into a conversation they were not looking at.
  input.value = 'only for this one';
  await h.w.__voiceForTest.sendMessage();
  const framesOf = (sock) => sock.sent.filter((f) => f.type === 'message');
  check('the message went to the project on screen', framesOf(h.sockets[0])[0]?.text === 'only for this one');
  check('and to no other', framesOf(h.sockets[1]).length === 0);
  check('the send cleared the composer', input.value === '');
  check('and cleared its draft with it', !h.w.localStorage.getItem(h.drafts.draftKeyFor(a)));
  check('the echo went into the right thread',
    a.thread.textContent.includes('only for this one') && !b.thread.textContent.includes('only for this one'));
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  await finish(h);
}

// --- 4. The live cap --------------------------------------------------------
console.log('\nHolds three projects live, and cools the one nobody is using:');
{
  const h = bootClient();
  await settle();
  check('three is the cap', h.hooks.MAX_LIVE === 3);

  const p1 = h.hooks.openConversation({ cwd: DEMO, project: 'demo', sessionId: 'aaa', title: 'the one still running' });
  joinConversation(h.sockets[0], { sessionId: 'aaa' });
  const p2 = h.hooks.openConversation({ cwd: API, project: 'api', sessionId: 'ccc', title: 'an api chat' });
  joinConversation(h.sockets[1], { sessionId: 'ccc', cwd: API });
  const p3 = h.hooks.openConversation({ cwd: WEB, project: 'web', sessionId: 'fff', title: 'a web chat' });
  joinConversation(h.sockets[2], { sessionId: 'fff', cwd: WEB });
  // jsdom gets through all three inside one millisecond, so the order they were
  // last looked at is stated rather than left to the clock.
  p1.touchedAt = Date.now() - 3000;
  p2.touchedAt = Date.now() - 2000;
  p3.touchedAt = Date.now() - 1000;

  const p4 = h.hooks.openConversation({ cwd: INFRA, project: 'infra', sessionId: 'ggg', title: 'an infra chat' });
  check('a fourth project cools the least recently used one', p1.cold, `cold: ${[p1, p2, p3, p4].map((p) => p.cold).join(',')}`);
  check('and only that one', !p2.cold && !p3.cold && !p4.cold);
  check('cooling drops the socket', h.sockets[0].closedByClient);
  check('cooling drops the thread', p1.thread === null && h.threads().length === 3);
  check('cooling tells the server nothing', !h.sockets[0].sent.some((f) => f.type === 'interrupt'));
  check('a cooled project is still a tab', h.chips().length === 4 && p1.chip.classList.contains('cold'));
  check('a cooled tab is still listed as open', JSON.parse(h.w.localStorage.getItem('claude-chat-panes')).panes.length === 4);

  // Everything live is working now. Cooling one of these would be a lie: the tab
  // would go quiet while the box was still spending on it.
  h.sockets[1].deliver({ type: 'joined', busy: true });
  h.sockets[2].deliver({ type: 'joined', busy: true });
  h.sockets[3].deliver({ type: 'joined', busy: true });
  check('all three live projects are working', [p2, p3, p4].every((p) => p.busy));
  h.$('#toast').textContent = '';
  const p5 = h.hooks.openConversation({ cwd: DOCS, project: 'docs', sessionId: 'hhh', title: 'a docs chat' });
  check('never cools a project that is working', !p2.cold && !p3.cold && !p4.cold);
  check('exceeds the cap instead', h.livePanes().length === 4);
  check('and says so rather than doing it quietly', /already working/.test(h.toast()), h.toast());
  check('the fifth project is live and on screen', !p5.cold && p5.thread.classList.contains('active'));

  // Coming back to a cooled tab is the same join another device would do.
  const before = h.sockets.length;
  h.hooks.activatePane(p1);
  check('reheating a cooled tab opens one socket', h.sockets.length === before + 1);
  h.sockets[before].accept();
  check(
    'and rejoins by session id, not by the process handle it had',
    h.sockets[before].sent[0]?.type === 'start' && h.sockets[before].sent[0].resumeSessionId === 'aaa',
    JSON.stringify(h.sockets[before].sent[0]),
  );
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  await finish(h);
}

// --- 5. Closing a tab -------------------------------------------------------
console.log('\nCloses a tab without stopping the conversation behind it:');
{
  const h = bootClient();
  await settle();
  const a = h.hooks.openConversation({ cwd: DEMO, project: 'demo', sessionId: 'aaa', title: 'the one still running' });
  const sa = h.sockets[0];
  joinConversation(sa, { sessionId: 'aaa', busy: true });
  const b = h.hooks.openConversation({ cwd: API, project: 'api', sessionId: 'ccc', title: 'an api chat' });
  joinConversation(h.sockets[1], { sessionId: 'ccc', cwd: API });

  const framesBefore = sa.sent.length;
  h.hooks.closePane(a);
  check('closing a tab sends nothing at all', sa.sent.length === framesBefore, JSON.stringify(sa.sent.slice(framesBefore)));
  check('in particular, it does not interrupt the turn', !sa.sent.some((f) => f.type === 'interrupt'));
  check('the tab is gone', !h.hooks.panes.has(a.key) && h.chips().length === 1);
  check('its thread is gone with it', h.threads().length === 1);
  check('the socket is dropped, because nobody is showing it', sa.closedByClient);
  check('and it says the conversation keeps working', /keeps working/.test(h.toast()), h.toast());
  check('the project that is left is the one on screen', h.hooks.activePane() === b);

  // The conversation is still on the box, so it is still in the list and can be
  // reopened — the tab was a view of it, not the thing itself.
  await h.hooks.pollLive();
  const reopened = h.hooks.openConversation({ cwd: DEMO, project: 'demo', sessionId: 'aaa', title: 'the one still running' });
  check('reopening it is a fresh join of the same conversation', reopened !== a && reopened.sessionId === 'aaa');

  h.hooks.closePane(reopened);
  h.hooks.closePane(b);
  check('closing the last tab goes back to the list', h.$('#screen-list').classList.contains('active'));
  check('the tab strip disappears with the last tab', h.$('#tabs').classList.contains('hidden'));
  check('and nothing is listed as open any more', !h.w.localStorage.getItem('claude-chat-panes'));
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  await finish(h);
}

// --- 6. A brand-new chat getting its name ------------------------------------
console.log('\nGives a new chat its durable name without losing what was typed:');
{
  const h = bootClient();
  await settle();
  const input = h.$('#input');
  const pane = h.hooks.openProject({ cwd: DEMO, project: 'demo' });
  const sock = h.sockets[0];
  sock.accept();
  check('starts a chat rather than resuming one', sock.sent[0]?.type === 'start' && !sock.sent[0].resumeSessionId);
  check('the tab is keyed by project from the start', pane.key === DEMO && pane.sessionId === null, pane.key);
  check('the chip names the project, not the chat', h.chipNames()[0] === 'demo', h.chipNames().join(','));
  check('and the line under the tabs admits there is no chat yet', h.convName() === 'New chat', h.convName());
  check(
    'the tab is written down even with nothing said in it, because the project exists',
    JSON.parse(h.w.localStorage.getItem('claude-chat-panes') || 'null')?.panes[0]?.cwd === DEMO,
  );

  // Typed before the first reply, which is the normal way a new chat starts and
  // the one case where the draft's key is about to change underneath it.
  input.value = 'the first thing I typed';
  h.drafts.saveDraft({ now: true });
  const beforeKey = h.drafts.draftKeyFor(pane);
  check('the draft is on disk', JSON.parse(h.w.localStorage.getItem(beforeKey) || 'null')?.text === 'the first thing I typed');

  sock.deliver({ type: 'attached', conversationId: 'conv-new', cwd: DEMO, busy: false, sessionId: null });
  sock.deliver({ type: 'session', sessionId: 'zzz999' });
  check('the conversation gains a name', pane.sessionId === 'zzz999');
  check('the tab does not change its key with it', pane.key === DEMO, pane.key);
  check('the pane map still has exactly one tab', h.hooks.panes.get(DEMO) === pane && h.hooks.panes.size === 1);
  check('the tab on screen is still the tab on screen', h.hooks.activePane() === pane);
  check('the chat is now written down, so a refresh comes back to it',
    JSON.parse(h.w.localStorage.getItem('claude-chat-panes')).panes[0].sessionId === 'zzz999');

  const afterKey = h.drafts.draftKeyFor(pane);
  check('the draft followed the conversation being named', JSON.parse(h.w.localStorage.getItem(afterKey) || 'null')?.text === 'the first thing I typed');
  check('and left nothing behind under the old name', !h.w.localStorage.getItem(beforeKey) || beforeKey === afterKey);
  // The reload this is all for: the box is empty, the chat is reopened, the words
  // are still there.
  input.value = '';
  check('so a reload still restores it', h.drafts.restoreDraft(pane) && input.value === 'the first thing I typed');

  // A chat called "New chat" forever gives a project with two of them nothing to
  // tell them apart by, so the first message names it — which is what the list
  // will call it once the transcript exists.
  input.value = 'name this conversation after me';
  await h.w.__voiceForTest.sendMessage();
  check('the first message names the conversation', pane.title === 'name this conversation after me', pane.title);
  check('and the line under the tabs shows it', h.convName() === 'name this conversation after me', h.convName());
  check('the chip still names the project', h.chipNames()[0] === 'demo', h.chipNames().join(','));
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  await finish(h);
}

// --- 7. One tab per project --------------------------------------------------
console.log('\nKeeps one tab per project, and switches conversation inside it:');
{
  const h = bootClient();
  await settle();
  const input = h.$('#input');
  const first = h.hooks.openConversation({ cwd: DEMO, project: 'demo', sessionId: 'aaa', title: 'the one still running' });
  const sa = h.sockets[0];
  joinConversation(sa, { sessionId: 'aaa', busy: true });
  const again = h.hooks.openConversation({ cwd: DEMO, project: 'demo', sessionId: 'aaa', title: 'the one still running' });
  check('the same chat opened twice is one tab', again === first && h.hooks.panes.size === 1 && h.chips().length === 1);
  check('and one socket', h.sockets.length === 1);

  // The move this whole model is for: another conversation in the *same* project.
  // It must not be a second tab, and it must not stop the one being left.
  input.value = 'unsent words in the first chat';
  h.drafts.saveDraft({ now: true });
  const framesBefore = sa.sent.length;
  h.$('#toast').textContent = '';
  const second = h.hooks.showConversation(first, { sessionId: 'bbb', title: 'a finished task' });

  check('switching conversation is the same tab', second === first && h.hooks.panes.size === 1 && h.chips().length === 1);
  check('the chip still names the project', h.chipNames().join(',') === 'demo', h.chipNames().join(','));
  check('the line under the tabs names the new chat', h.convName() === 'a finished task', h.convName());
  check('the window is showing the new conversation', first.sessionId === 'bbb');
  check('nothing was sent to the conversation being left', sa.sent.length === framesBefore, JSON.stringify(sa.sent.slice(framesBefore)));
  check('in particular it was not interrupted', !sa.sent.some((f) => f.type === 'interrupt'));
  check('its socket was dropped, because nobody is showing it', sa.closedByClient);
  check('and it says the chat left behind keeps working', /keeps working/.test(h.toast()), h.toast());
  check('one thread, for the conversation on screen', h.threads().length === 1);

  const sb = h.sockets[1];
  check('a socket was opened for the conversation arriving', Boolean(sb));
  sb.accept();
  check(
    'joining it by session id, which is what another device would do',
    sb.sent[0]?.type === 'start' && sb.sent[0].resumeSessionId === 'bbb' && sb.sent[0].cwd === DEMO,
    JSON.stringify(sb.sent[0]),
  );
  check('the composer is empty for the conversation arriving', input.value === '', input.value);
  check(
    'the draft stayed with the conversation it was typed in',
    JSON.parse(h.w.localStorage.getItem(h.drafts.draftKeyFor({ cwd: DEMO, sessionId: 'aaa' })) || 'null')?.text
      === 'unsent words in the first chat',
  );

  // And back again, which is where a draft would surface in the wrong chat if the
  // composer belonged to the tab rather than to the conversation.
  input.value = 'words in the second chat';
  h.drafts.saveDraft({ now: true });
  h.hooks.showConversation(first, { sessionId: 'aaa', title: 'the one still running' });
  h.sockets[2].accept();
  check('going back is still one tab', h.hooks.panes.size === 1 && h.chips().length === 1);
  check('and rejoins the first conversation', h.sockets[2].sent[0]?.resumeSessionId === 'aaa');
  input.value = '';
  check(
    'its own draft comes back',
    h.drafts.restoreDraft(first) && input.value === 'unsent words in the first chat',
    input.value,
  );

  // "New chat in this project" empties the window without touching the box.
  const beforeSockets = h.sockets.length;
  h.hooks.showConversation(first, { sessionId: null });
  check('a new chat in the project is still one tab', h.hooks.panes.size === 1 && h.chips().length === 1);
  check('with no session to resume', first.sessionId === null);
  check('and it opened a socket to start one', h.sockets.length === beforeSockets + 1);
  h.sockets[beforeSockets].accept();
  check('starting rather than resuming', !h.sockets[beforeSockets].sent[0]?.resumeSessionId);
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  await finish(h);
}

// Opening a project that is already open must not throw away the conversation in
// it. "+" on the tab strip means "put this project on screen"; only an explicit
// new chat empties the window.
{
  const h = bootClient();
  await settle();
  const pane = h.hooks.openConversation({ cwd: DEMO, project: 'demo', sessionId: 'aaa', title: 'the one still running' });
  joinConversation(h.sockets[0], { sessionId: 'aaa', busy: true });
  h.hooks.openProject({ cwd: API, project: 'api' });

  const sockets = h.sockets.length;
  h.hooks.openProject({ cwd: DEMO, project: 'demo', fresh: false });
  check('reopening an open project keeps the conversation it was showing', pane.sessionId === 'aaa');
  check('and opens no socket for it', h.sockets.length === sockets, `${h.sockets.length - sockets} new`);
  check('it is simply on screen again', h.hooks.activePane() === pane);
  check('still two tabs', h.hooks.panes.size === 2);

  h.hooks.openProject({ cwd: DEMO, project: 'demo', fresh: true });
  check('asking for a new chat in it empties the window', pane.sessionId === null);
  check('without opening a second tab', h.hooks.panes.size === 2 && h.chips().length === 2);
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  await finish(h);
}

// The switcher itself: the sheet lists the project's chats and nothing else's.
console.log('\nLists the project\'s own conversations in the switcher:');
{
  const h = bootClient();
  await settle();
  const pane = h.hooks.openConversation({ cwd: DEMO, project: 'demo', sessionId: 'aaa', title: 'the one still running' });
  joinConversation(h.sockets[0], { sessionId: 'aaa' });

  check('the switcher starts closed', h.sheetHidden());
  h.$('#conv-bar').dispatchEvent(new h.w.Event('click'));
  await settle();
  check('tapping the line under the tabs opens it', !h.sheetHidden());
  check('titled after the project', h.$('#chats-sheet-title').textContent === 'demo');
  const titles = h.sheetRows().map((r) => r.querySelector('.sheet-row-title').textContent);
  check('lists every chat in this project', titles.join('|') === 'the one still running|a finished task|a fourth chat', titles.join('|'));
  check('and no chat from another project', !titles.includes('an api chat'));
  check('marking the one on screen', h.sheetRows()[0].classList.contains('current'));

  // Tapping another one is the switch, from the UI rather than the hook.
  h.sheetRows()[1].dispatchEvent(new h.w.Event('click'));
  check('tapping a row switches the window to it', pane.sessionId === 'bbb', pane.sessionId);
  check('closes the sheet', h.sheetHidden());
  check('and still one tab', h.hooks.panes.size === 1 && h.chips().length === 1);

  // The other button in the sheet. A chat started this way must still be *unnamed*:
  // if "New chat" counted as its name, the first message would not replace it and
  // the project would end up with two chats called the same thing.
  h.$('#btn-new-in-project').dispatchEvent(new h.w.Event('click'));
  check('starting a new chat in the project empties the window', pane.sessionId === null);
  check('the switcher line says there is no chat yet', h.convName() === 'New chat', h.convName());
  h.sockets[h.sockets.length - 1].accept();
  h.$('#input').value = 'the first thing said in it';
  await h.w.__voiceForTest.sendMessage();
  check('and its first message names it', pane.title === 'the first thing said in it', pane.title);
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  await finish(h);
}

// The directory a conversation runs in is not always the project's own.
console.log('\nOpens a chat that is in a worktree where that chat actually is:');
{
  const h = bootClient();
  await settle();

  const row = h.rows().find((r) => r.dataset.session === 'iii');
  check('a chat in a worktree is in the list', Boolean(row));
  check(
    'the row says which worktree, because the project alone no longer places it',
    /a-branch/.test(row?.textContent || ''),
    row?.querySelector('.row-sub')?.textContent.trim(),
  );
  check(
    'and is keyed for /api/live by the directory it runs in',
    row?.dataset.key === `${DOCS_TREE}|iii`,
    row?.dataset.key,
  );

  row.dispatchEvent(new h.w.Event('click'));
  const pane = h.hooks.panes.get(h.hooks.paneKey(DOCS));
  check('opening it opens its project\'s tab, not a tab of its own',
    h.hooks.panes.size === 1 && pane?.sessionId === 'iii', `${h.hooks.panes.size} tabs`);
  check('the tab is still named after the project', h.chipNames().join(',') === 'docs', h.chipNames().join(','));

  h.sockets[0].accept();
  const start = h.sockets[0].sent[0];
  check(
    'and it is resumed in the worktree, which is the only place its transcript is',
    start?.type === 'start' && start.cwd === DOCS_TREE && start.resumeSessionId === 'iii',
    JSON.stringify(start),
  );
  joinConversation(h.sockets[0], { sessionId: 'iii', cwd: DOCS_TREE });

  // A cooled tab reads `/api/live`, which reports the conversation's own directory.
  // Keying that by the project would leave this tab permanently "not running".
  h.hooks.coolPane(pane);
  h.box.live = [{ cwd: DOCS_TREE, sessionId: 'iii', busy: true, lastActivity: Date.now() }];
  await h.hooks.pollLive();
  check('a cooled worktree chat is still matched to its process',
    pane.busy && !pane.trouble, `busy=${pane.busy} trouble=${pane.trouble}`);

  // And the way back out: a new chat in this project starts in the project, not in
  // whichever worktree the last conversation happened to be in.
  h.hooks.activatePane(pane);
  h.$('#conv-bar').dispatchEvent(new h.w.Event('click'));
  await settle();
  h.$('#btn-new-in-project').dispatchEvent(new h.w.Event('click'));
  const fresh = h.sockets[h.sockets.length - 1];
  fresh.accept();
  check(
    'a new chat in the project starts in the project',
    fresh.sent[0]?.cwd === DOCS && fresh.sent[0]?.resumeSessionId === null,
    JSON.stringify(fresh.sent[0]),
  );
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  await finish(h);
}

// Where the sheet listing those chats can run out of room.
console.log('\nKeeps the chat switcher reachable when a project has many chats:');
{
  /*
   * The bug, reported with a screenshot: a project with fourteen conversations drew
   * a sheet taller than the window, and because a sheet is anchored to the bottom
   * the overflow went off the *top* — oldest rows and the heading unreachable, and
   * nothing scrolled, since an absolutely positioned box is not a scroller.
   *
   * Asserted in CSS rather than in layout because jsdom does not lay anything out.
   * The three rules are what make the list the scroller and the sheet the frame; the
   * last of them is the one that is easy to leave out and silently does nothing.
   */
  const rule = (selector) => {
    const at = css.indexOf(selector);
    return at === -1 ? '' : css.slice(at, css.indexOf('}', at));
  };
  const sheet = rule('.sheet-body {');
  check('every sheet is bounded by the window', /max-height:\s*86vh/.test(sheet), sheet);
  check('and scrolls rather than growing past it', /overflow-y:\s*auto/.test(sheet), sheet);
  const frame = rule('#chats-sheet .sheet-body {');
  check('the chats sheet is a column', /display:\s*flex/.test(frame) && /flex-direction:\s*column/.test(frame), frame);
  const list = rule('#chats-sheet-body {');
  check('with the list itself scrolling', /overflow-y:\s*auto/.test(list), list);
  check(
    'and able to shrink, which is what makes it scroll instead of pushing the buttons out',
    /min-height:\s*0/.test(list),
    list,
  );
  const parts = rule('#chats-sheet .sheet-body > button {');
  check('while the buttons under it keep their height', /flex:\s*0 0 auto/.test(parts), parts);
}

// --- 8. Ambient state, for the tabs with no socket ---------------------------
console.log('\nTells a cooled tab what its conversation is doing:');
{
  const h = bootClient({
    saved: { panes: [{ cwd: DEMO, title: 'the one still running', sessionId: 'aaa' }], activeKey: null },
    live: [],
  });
  await settle();
  const pane = h.hooks.panes.get(DEMO);
  check('a restored tab starts cold', pane.cold && pane.chip.classList.contains('cold'));

  h.box.live = [{ cwd: DEMO, sessionId: 'aaa', busy: true, lastActivity: Date.now() }];
  await h.hooks.pollLive();
  check('a cooled tab shows work it cannot see itself', pane.busy && pane.chip.classList.contains('busy'));
  check('and is not flagged while its process is there', !pane.trouble);

  // The payoff: a task sent from one tab, read about in another, reported without
  // going to look.
  h.$('#toast').textContent = '';
  h.box.live = [{ cwd: DEMO, sessionId: 'aaa', busy: false, lastActivity: Date.now() }];
  await h.hooks.pollLive();
  // Named after the project, like every other announcement: the answer this has
  // to give is which chip to tap, and the chat's own title is on the switcher line
  // once you are there.
  check('announces a cooled project that finished', /finished/.test(h.toast()) && h.toast().startsWith('demo'), h.toast());
  check('and the tab stops showing as working', !pane.busy && !pane.chip.classList.contains('busy'));

  // Every six seconds, forever, is the failure mode here.
  h.$('#toast').textContent = '';
  await h.hooks.pollLive();
  check('a chat that was already idle announces nothing', h.toast() === '', h.toast());

  h.box.live = [];
  await h.hooks.pollLive();
  check('a cooled tab whose process has gone says so', pane.trouble && pane.chip.classList.contains('trouble'));

  // The list's badges, updated in place. Redrawing the list means /api/projects,
  // which stats and reads every transcript to build the titles — fine once per
  // screen, ruinous every few seconds.
  h.box.live = [{ cwd: DEMO, sessionId: 'bbb', busy: true, lastActivity: Date.now() }];
  await h.hooks.pollLive();
  const row = (key) => h.rows().find((r) => r.dataset.key === key);
  check('a working session is labelled in the list', row(`${DEMO}|bbb`)?.querySelector('.row-live').textContent === 'working…');
  check('a session with no process is not', row(`${DEMO}|aaa`)?.querySelector('.row-live').classList.contains('hidden'));
  check('the conversation a window is showing is marked open', !row(`${DEMO}|aaa`)?.querySelector('.row-open').classList.contains('hidden'));
  // A tab is the project, but "open" has to mean this chat: the same project's
  // other chats are reachable in one tap and none of them is on screen.
  check(
    'and its project\'s other chats are not, even though the project has a tab',
    row(`${DEMO}|bbb`)?.querySelector('.row-open').classList.contains('hidden')
      && row(`${DEMO}|ddd`)?.querySelector('.row-open').classList.contains('hidden'),
  );
  check(
    'polling never re-reads every transcript',
    h.calls.filter((u) => u.includes('/api/projects')).length === 1,
    `${h.calls.filter((u) => u.includes('/api/projects')).length} calls`,
  );

  // A phone in a pocket with this app open must not keep waking the box.
  h.setVisibility('hidden');
  const before = h.calls.length;
  await h.hooks.pollLive();
  check('a hidden page does not poll at all', h.calls.length === before, `${h.calls.length - before} calls`);
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  await finish(h);
}

// --- 9. Coming back to a phone that was asleep -------------------------------
console.log('\nRejoins every live conversation when the phone comes back:');
{
  const h = bootClient();
  await settle();
  const a = h.hooks.openConversation({ cwd: DEMO, project: 'demo', sessionId: 'aaa', title: 'the one still running' });
  joinConversation(h.sockets[0], { sessionId: 'aaa', busy: true });
  const b = h.hooks.openConversation({ cwd: API, project: 'api', sessionId: 'ccc', title: 'an api chat' });
  joinConversation(h.sockets[1], { sessionId: 'ccc', cwd: API });

  // iOS suspends a backgrounded tab and freezes its sockets, and the close event
  // usually never arrives — so both of these are dead without having said so.
  h.sockets[0].readyState = 3;
  h.sockets[1].readyState = 3;
  h.setVisibility('hidden');
  h.setVisibility('visible');
  await settle();

  check('reconnects both, not just the one on screen', h.sockets.length === 4, `${h.sockets.length} sockets`);
  h.sockets[2].accept();
  h.sockets[3].accept();
  const frames = [h.sockets[2].sent[0], h.sockets[3].sent[0]];
  check(
    'rejoins by session id rather than by the process handle it had',
    frames.every((f) => f?.type === 'start') && frames.map((f) => f.resumeSessionId).sort().join() === 'aaa,ccc',
    JSON.stringify(frames),
  );
  check('the background chat is still the background chat', h.hooks.activePane() === b && !a.thread.classList.contains('active'));

  // The reason a background tab is kept connected at all: it is the one being
  // waited on, and it has to be able to say so on the new socket.
  const rejoined = [h.sockets[2], h.sockets[3]].find((s) => s.sent[0]?.resumeSessionId === 'aaa');
  h.$('#toast').textContent = '';
  rejoined.deliver({ type: 'joined', busy: true });
  rejoined.deliver({ type: 'turn_complete' });
  check('and can still report a turn it finished while away', /finished/.test(h.toast()), h.toast());
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  await finish(h);
}

// --- 10. Which window is this ------------------------------------------------
/**
 * With two deployments of this app open in one browser, the tab strip is the only
 * place that says which is which — and a tab shows a title, not a hostname. So the
 * title has to name both the deployment and the project, and it has to be right at
 * the moment you glance at it, which is why it is set from the document rather than
 * from a request.
 */
console.log('\nSays which deployment and which project a tab is:');
{
  const h = bootClient();
  await settle();
  check('an unnamed deployment keeps the title it shipped with', h.w.document.title === APP_NAME, h.w.document.title);

  h.hooks.openConversation({ cwd: DEMO, project: 'demo', sessionId: 'aaa', title: 'the one still running' });
  joinConversation(h.sockets[0], { sessionId: 'aaa' });
  check(
    'the tab of a single deployment is named after the project alone',
    h.w.document.title === 'demo',
    h.w.document.title,
  );

  h.$('#screen-chat [data-back]').click();
  await settle();
  check('going back to the list restores the app’s own title', h.w.document.title === APP_NAME, h.w.document.title);
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  await finish(h);
}

{
  const h = bootClient({ shell: namedShell('work') });
  await settle();
  check(
    'a named deployment says so before any project is open',
    h.w.document.title === 'work',
    h.w.document.title,
  );

  const a = h.hooks.openConversation({ cwd: DEMO, project: 'demo', sessionId: 'aaa', title: 'the one still running' });
  joinConversation(h.sockets[0], { sessionId: 'aaa' });
  check(
    'the tab reads "<deployment>: <project>"',
    h.w.document.title === 'work: demo',
    h.w.document.title,
  );

  const b = h.hooks.openConversation({ cwd: API, project: 'api', sessionId: 'ccc', title: 'an api chat' });
  joinConversation(h.sockets[1], { sessionId: 'ccc', cwd: API });
  check('the title follows the tab you switch to', h.w.document.title === 'work: api', h.w.document.title);
  // Switching conversations inside a project must not touch it: the tab is the
  // project, and a chat's own name is already on screen under the tabs.
  h.hooks.showConversation(b, { sessionId: 'eee', title: 'a fifth chat' });
  await settle();
  check('and not the conversation inside it', h.w.document.title === 'work: api', h.w.document.title);

  h.hooks.activatePane(a);
  check('going back to the other tab retitles again', h.w.document.title === 'work: demo', h.w.document.title);

  h.$('#screen-chat [data-back]').click();
  await settle();
  check(
    'with no project on screen the title names the deployment, not the app',
    h.w.document.title === 'work',
    h.w.document.title,
  );
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  await finish(h);
}

// --- 11. Which model a new chat starts on ------------------------------------
/**
 * The deployment decides, unless this device has said otherwise.
 *
 * Settings are saved as one object, so a device that changed its voice wrote a
 * model down with it — and while the client held a default of its own, that froze
 * every phone onto the model the app shipped with. Raising a deployment's
 * `defaultModel` moved the CLI and the editor and silently missed the chat app,
 * which is the surface it is read from. So a device that never chose a model sends
 * none and follows the box; one that chose keeps its choice.
 */
console.log('\nStarts a new chat on the model the deployment is configured for:');
{
  const h = bootClient();
  await settle();
  h.hooks.openProject({ cwd: DEMO, project: 'demo' });
  h.sockets[0].accept();
  const start = h.sockets[0].sent[0];
  check(
    'a device that has never chosen a model names none',
    start?.type === 'start' && !('model' in start),
    JSON.stringify(start),
  );
  check(
    'and the picker shows the deployment default, not the top of the list',
    h.$('#select-model').value === DEPLOYMENT_MODELS.default,
    h.$('#select-model').value,
  );
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  await finish(h);
}
{
  // What every device that had opened the app was carrying: the default this client
  // used to hard-code, saved alongside a voice that *was* chosen. The model is not
  // a choice, so an upgraded deployment has to be free to move it — and the voice
  // beside it must survive that.
  const h = bootClient({
    settings: { model: 'us.anthropic.claude-opus-5', voice: 'he-IL-AvriNeural' },
  });
  await settle();
  h.hooks.openProject({ cwd: DEMO, project: 'demo' });
  h.sockets[0].accept();
  check(
    'a stored copy of the old hard-coded default does not pin a chat to it',
    !('model' in (h.sockets[0].sent[0] || {})),
    JSON.stringify(h.sockets[0].sent[0]),
  );
  check(
    'the picker follows the deployment too',
    h.$('#select-model').value === DEPLOYMENT_MODELS.default,
    h.$('#select-model').value,
  );
  check(
    'and nothing else that device had chosen is touched',
    h.hooks.state.settings.voice === 'he-IL-AvriNeural',
    h.hooks.state.settings.voice,
  );
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  await finish(h);
}
{
  // A deliberate choice, which is the case the migration above must not eat: a
  // cheaper model picked on purpose stays picked, on this device and no other.
  const h = bootClient({ settings: { model: 'us.anthropic.claude-haiku-4-5' } });
  await settle();
  h.hooks.openProject({ cwd: DEMO, project: 'demo' });
  h.sockets[0].accept();
  check(
    'a chosen model is what a new chat starts on',
    h.sockets[0].sent[0]?.model === 'us.anthropic.claude-haiku-4-5',
    JSON.stringify(h.sockets[0].sent[0]),
  );
  check(
    'and it is what the picker shows',
    h.$('#select-model').value === 'us.anthropic.claude-haiku-4-5',
    h.$('#select-model').value,
  );
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  await finish(h);
}

// --- results ----------------------------------------------------------------
console.log('\nAsks before a tool runs, and lets any device answer once:');
{
  const h = bootClient({ settings: { permissionMode: '' } });
  await settle();
  const a = h.hooks.openConversation({ cwd: DEMO, project: 'demo', sessionId: 'aaa', title: 'the one still running' });
  const sa = h.sockets[0];
  joinConversation(sa, { sessionId: 'aaa', busy: true });
  const start = sa.sent.find((m) => m.type === 'start');
  check('a device with no mode chosen sends none, so the machine\'s default applies',
    start && start.permissionMode === undefined, JSON.stringify(start));

  sa.deliver({
    type: 'permission_request', requestId: 'req-1', toolName: 'Bash',
    description: 'Create a file', input: { command: 'touch approved.txt' },
  });
  const card = a.thread.querySelector('.permission');
  check('a permission request is drawn as a card in the thread', Boolean(card) && /needs your approval/.test(card.textContent));
  check('showing what would run', card && card.textContent.includes('touch approved.txt'));
  sa.deliver({ type: 'permission_request', requestId: 'req-1', toolName: 'Bash', input: {} });
  check('the same request delivered twice is one card', a.thread.querySelectorAll('.permission').length === 1);

  card.querySelector('.permission-allow').click();
  const answer = sa.sent.find((m) => m.type === 'permission');
  check('approve sends the decision for that request', answer && answer.requestId === 'req-1' && answer.decision === 'allow', JSON.stringify(answer));
  check('and the buttons cannot be pressed twice', [...card.querySelectorAll('button')].every((b) => b.disabled));
  sa.deliver({ type: 'permission_resolved', requestId: 'req-1', decision: 'allow' });
  check('the card then says what was decided', /Approved/.test(card.querySelector('.permission-state').textContent));

  sa.deliver({ type: 'permission_request', requestId: 'req-2', toolName: 'Write', input: { file_path: `${DEMO}/notes.md` } });
  const second = [...a.thread.querySelectorAll('.permission')].pop();
  check('a file path is shown relative to the chat\'s directory', second.textContent.includes('notes.md') && !second.textContent.includes(DEMO));
  sa.deliver({ type: 'permission_resolved', requestId: 'req-2', decision: 'deny' });
  check('an answer from another device closes the card here too',
    /Denied/.test(second.querySelector('.permission-state').textContent) && [...second.querySelectorAll('button')].every((b) => b.disabled));

  sa.deliver({ type: 'ping', at: 1 });
  check('an application ping is answered', sa.sent.some((m) => m.type === 'pong'));
}

if (failures.length) {
  console.error(`\nFAIL: ${failures.length} check(s) failed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(
  '\nPASS: a tab is a project — a cold launch restores one per project (collapsing '
  + 'the old per-chat saves) and opens one socket; a background project renders into '
  + 'its own thread and announces itself when it lands; the composer follows the '
  + 'conversation on screen and sends nowhere else; the live cap cools an idle '
  + 'project and never a working one; closing a tab stops nothing, and neither does '
  + 'switching which conversation a tab shows; a new chat keeps its draft '
  + 'through being named; the browser tab says which deployment and which '
  + 'project you are looking at; and a new chat starts on the model the '
  + 'deployment is configured for unless this device chose another.',
);
// The client's socket watchdog is an interval, and jsdom keeps it alive; the run is over.
process.exit(0);
