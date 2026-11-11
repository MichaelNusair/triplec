/**
 * Tests for the mux surface and the worktree slots under it.
 *
 * Three layers, because each can fail on its own and quietly:
 *
 *   1. slots.js, against real repositories in a temp directory. A slot is a git
 *      worktree, and the promise is that preparing one never loses work — a fast-
 *      forward or nothing. That is only proved by real commits and real edits.
 *   2. session-manager's use of it: projects arrive with eight slots, and removing a
 *      project refuses while a slot holds uncommitted work, since the delete takes
 *      the slots with it and nothing commits them.
 *   3. The two pages, in jsdom: the mux, and the chat embedded in its panes. What
 *      has to hold is that a pane is a frame on the chat (so the phone sees the same
 *      conversation), that a turn ending unwatched lights the ring, that closing a
 *      pane stops nothing, and that an embedded chat leaves the device's own tabs
 *      alone.
 *
 * Run: node chat-service/mux-test.js
 */
import { execFile } from 'child_process';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, realpath } from 'fs/promises';
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { JSDOM } from 'jsdom';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

const root = await realpath(await mkdtemp(join(tmpdir(), 'triplec-mux-')));
const remotes = await realpath(await mkdtemp(join(tmpdir(), 'triplec-mux-remotes-')));

// session-manager reads these at import time, so they are set before it loads.
process.env.PROJECTS_ROOT = root;
process.env.CLAUDE_HOME = join(root, '.claude-home');
process.env.GIT_AUTHOR_NAME = 'Test';
process.env.GIT_AUTHOR_EMAIL = 'test@example.com';
process.env.GIT_COMMITTER_NAME = 'Test';
process.env.GIT_COMMITTER_EMAIL = 'test@example.com';

const slots = await import('./slots.js');
const { SessionManager } = await import('./session-manager.js');

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

const git = async (cwd, ...args) =>
  (await execFileAsync('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
const exists = async (path) => Boolean(await stat(path).catch(() => null));

/** A project with one commit, pushed to a bare remote so `origin/main` exists. */
async function makeProject(name, { remote = true } = {}) {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  await git(path, 'init', '-q', '-b', 'main');
  await writeFile(join(path, 'README.md'), `# ${name}\n`);
  await git(path, 'add', '-A');
  await git(path, 'commit', '-q', '-m', 'first');
  if (remote) {
    const bare = join(remotes, `${name}.git`);
    await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    await git(path, 'remote', 'add', 'origin', bare);
    await git(path, 'push', '-q', '-u', 'origin', 'main');
    await git(path, 'remote', 'set-head', 'origin', 'main');
  }
  return path;
}

console.log('slots.js');
{
  check('parseSlot accepts 1..10 only',
    slots.parseSlot(1) === 1 && slots.parseSlot('10') === 10 && slots.parseSlot(0) === null
      && slots.parseSlot(11) === null && slots.parseSlot('1; rm -rf') === null && slots.parseSlot(2.5) === null);

  const plain = join(root, 'not-a-repo');
  await mkdir(plain, { recursive: true });
  const none = await slots.ensureSlots(plain);
  check('a directory with no repository gets no slots, and no error', none.skipped === true && !(await exists(join(plain, '.claude'))));

  const empty = join(root, 'empty-repo');
  await mkdir(empty, { recursive: true });
  await git(empty, 'init', '-q', '-b', 'main');
  check('a repository with no commit gets no slots', (await slots.ensureSlots(empty)).skipped === true);

  const p = await makeProject('alpha');
  const made = await slots.ensureSlots(p);
  check('ten slots are created', made.ok && made.created === 10, JSON.stringify(made));
  const branches = (await git(p, 'branch', '--format=%(refname:short)')).split('\n').sort();
  check('each slot is on its own branch', ['main', ...Array.from({ length: 10 }, (_, i) => `slot-${i + 1}`)]
    .sort().every((b) => branches.includes(b)), branches.join(','));
  check('the slots are where projectPlaces looks for worktrees',
    await exists(join(p, '.claude', 'worktrees', 'slot-3', 'README.md')));
  check("the main checkout's status is clean — the slots are excluded, not untracked",
    (await git(p, 'status', '--porcelain')) === '');
  check('the exclusion is in .git/info/exclude, not in the repository',
    (await readFile(join(p, '.git', 'info', 'exclude'), 'utf8')).includes('/.claude/worktrees/')
      && !(await exists(join(p, '.gitignore'))));
  check('a second call creates nothing', (await slots.ensureSlots(p)).created === 0);

  // A slot whose worktree was removed but whose branch kept a commit.
  const s2 = slots.slotPath(p, 2);
  await writeFile(join(s2, 'work.txt'), 'from slot 2\n');
  await git(s2, 'add', '-A');
  await git(s2, 'commit', '-q', '-m', 'slot 2 work');
  await git(p, 'worktree', 'remove', s2);
  const again = await slots.ensureSlot(p, 2);
  check('a removed slot comes back on its old branch, with its commit',
    again.ok && again.created && (await exists(join(s2, 'work.txt'))), JSON.stringify(again));

  // Main moves on; a clean slot follows it, a dirty one and one with its own commit do not.
  const upstream = join(root, 'alpha-other-clone');
  await execFileAsync('git', ['clone', '-q', join(remotes, 'alpha.git'), upstream]);
  await writeFile(join(upstream, 'new.txt'), 'upstream\n');
  await git(upstream, 'add', '-A');
  await git(upstream, 'commit', '-q', '-m', 'upstream moved');
  await git(upstream, 'push', '-q', 'origin', 'main');

  const fresh = await slots.prepareSlot(p, 1);
  check('a clean slot is fetched and fast-forwarded to origin/main',
    fresh.ok && fresh.fetched && fresh.refreshed && !fresh.kept && (await exists(join(slots.slotPath(p, 1), 'new.txt'))),
    JSON.stringify(fresh));

  const s3 = slots.slotPath(p, 3);
  await writeFile(join(s3, 'README.md'), '# half-written\n');
  const dirty = await slots.prepareSlot(p, 3);
  check('a slot with uncommitted edits is left exactly as it is',
    dirty.ok && !dirty.refreshed && /uncommitted/.test(dirty.kept || '')
      && (await readFile(join(s3, 'README.md'), 'utf8')) === '# half-written\n'
      && !(await exists(join(s3, 'new.txt'))), JSON.stringify(dirty));

  const own = await slots.prepareSlot(p, 2);
  check('a slot with a commit of its own is not moved',
    own.ok && !own.refreshed && /commit/.test(own.kept || '') && (await exists(join(s2, 'work.txt'))),
    JSON.stringify(own));

  const local = await makeProject('no-remote', { remote: false });
  await slots.ensureSlots(local);
  await writeFile(join(local, 'later.txt'), 'later\n');
  await git(local, 'add', '-A');
  await git(local, 'commit', '-q', '-m', 'later');
  const offline = await slots.prepareSlot(local, 1);
  check('a project with no remote refreshes to its own branch',
    offline.ok && offline.refreshed && !offline.fetched && (await exists(join(slots.slotPath(local, 1), 'later.txt'))),
    JSON.stringify(offline));

  const listed = await slots.listSlots(p, {
    live: [{ cwd: slots.slotPath(p, 4), sessionId: 's4', busy: true }],
    others: [{ pid: 1, cwd: join(slots.slotPath(p, 5), 'src') }],
  });
  const at = (n) => listed.slots.find((s) => s.n === n);
  check('listSlots reports all ten', listed.enabled && listed.slots.length === 10);
  check('a slot with one of our chats mid-turn is busy and held', at(4).busy && at(4).held && at(4).sessions[0].sessionId === 's4');
  check('a slot with a process from another surface is held, and says where', at(5).held && at(5).elsewhere === 1 && !at(5).busy);
  check('a free slot is neither', !at(6).held && !at(6).busy);
  check('a dirty slot says how much is in it', at(3).dirty === 1);

  // `/exit` in a slot's terminal resets it: refreshed as prepareSlot would, and
  // marked with the time, outside the checkout.
  const reset = await slots.resetSlot(p, 7, { fetch: false });
  check('resetSlot refreshes the slot and says when', reset.ok && Number.isFinite(reset.resetAt), JSON.stringify(reset));
  const afterReset = await slots.listSlots(p);
  check('listSlots reports when a slot was reset', afterReset.slots.find((s) => s.n === 7).resetAt === reset.resetAt
    && afterReset.slots.find((s) => s.n === 6).resetAt === null);
  check("the reset mark is not in the slot's git status",
    (await git(slots.slotPath(p, 7), 'status', '--porcelain')) === '');

  const cwds = await slots.claudeCwds({ proc: join(root, 'no-proc-here') });
  check('the process scan survives a /proc it cannot read', Array.isArray(cwds) && cwds.length === 0);
}

console.log('session-manager');
{
  const manager = new SessionManager();
  const created = await manager.createProject('fresh-one');
  const step = created.steps.find((s) => s.step === 'slots');
  check('a new project arrives with its ten slots', step?.ok && step.created === 10, JSON.stringify(created.steps));

  const status = await manager.slots('alpha');
  check('the slots route reports a project\'s slots', status.enabled && status.slots.length === 10);

  const prepared = await manager.prepareSlot('alpha', 6);
  check('prepareSlot through the manager answers with the directory to start in',
    prepared.ok && prepared.cwd === slots.slotPath(join(root, 'alpha'), 6));
  let refused = null;
  try {
    await manager.prepareSlot('alpha', 12);
  } catch (err) {
    refused = err;
  }
  check('an out-of-range slot is refused', /slot must be/.test(refused?.message || ''));
  refused = null;
  try {
    await manager.prepareSlot('../etc', 1);
  } catch (err) {
    refused = err;
  }
  check('a project name that is a path is refused', Boolean(refused));

  // alpha's slot-3 still holds the uncommitted README edit from above.
  const before = await manager.projectStatus('alpha');
  check('project status names a slot with uncommitted work',
    before.worktrees.some((w) => w.name === 'slot-3' && w.dirty === 1), JSON.stringify(before.worktrees));
  let blocked = null;
  try {
    await manager.removeProject('alpha');
  } catch (err) {
    blocked = err;
  }
  check('removing a project refuses while a slot holds uncommitted work',
    blocked?.blocked && /slot-3/.test(blocked.message), blocked?.message);
  check('…and the project is still there', await exists(join(root, 'alpha', '.claude', 'worktrees', 'slot-3', 'README.md')));
  clearInterval(manager.reaper);
}

console.log('mux page');
{
  const html = readFileSync(join(here, 'public', 'mux.html'), 'utf8');
  const js = readFileSync(join(here, 'public', 'mux.js'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://claude.example.com/chat/mux' });
  const w = dom.window;
  const calls = [];
  const projectPath = '/workspace/projects/demo';
  const slotCwd = (n) => `${projectPath}/.claude/worktrees/slot-${n}`;
  w.fetch = (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body });
    const reply = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
    if (String(url).startsWith('/api/projects')) {
      return reply({ projects: [{ name: 'demo', path: projectPath, sessions: [
        { sessionId: 'old-2', cwd: slotCwd(2), worktree: 'slot-2', title: 'slot two chat', mtime: 5 },
      ] }] });
    }
    if (String(url).startsWith('/api/slots/prepare')) {
      const { slot } = JSON.parse(options.body);
      return reply({ ok: true, cwd: slotCwd(slot), base: 'origin/main', fetched: true, refreshed: true, kept: null, branch: `slot-${slot}` });
    }
    if (String(url).startsWith('/api/slots')) {
      return reply({ name: 'demo', path: projectPath, enabled: true, slots: Array.from({ length: 8 }, (_, i) => ({
        n: i + 1, name: `slot-${i + 1}`, cwd: slotCwd(i + 1), created: true, branch: `slot-${i + 1}`,
        dirty: i === 0 ? 2 : 0, unpushed: 0, sessions: [], busy: false, held: i === 1, elsewhere: 0,
      })) });
    }
    if (String(url).startsWith('/api/live')) return reply({ sessions: [] });
    return reply({});
  };
  w.Notification = undefined;
  const errors = [];
  w.addEventListener('error', (e) => errors.push(e.message));
  w.localStorage.setItem('triplec-mux', JSON.stringify({ layout: 2, expanded: ['demo'] }));
  w.eval(js);
  await new Promise((r) => setTimeout(r, 100));
  const mux = w.__muxForTest;
  const doc = w.document;

  check('the mux boots without an error', errors.length === 0 && Boolean(mux), errors.join('; '));
  check('two empty panes for the two-pane layout', doc.querySelectorAll('.mux-pane').length === 2
    && doc.querySelectorAll('.mux-placeholder').length === 2);
  check('the sidebar lists the main checkout and eight slots',
    doc.querySelectorAll('.mux-project[data-project="demo"] .mux-slot').length === 9);
  check("a slot's last conversation is what its row says",
    doc.querySelector(`.mux-slot[data-cwd="${slotCwd(2)}"] .mux-slot-title`)?.textContent === 'slot two chat');

  // "+" on the project: a free slot, preferring a clean one. Slot 1 is dirty and slot
  // 2 is held, so slot 3 it is.
  await mux.newChatInFreeSlot('demo');
  await new Promise((r) => setTimeout(r, 20));
  const prep = calls.find((c) => c.url === '/api/slots/prepare');
  check('a new chat prepares the first free, clean slot', prep && JSON.parse(prep.body).slot === 3, prep?.body);
  const frame = doc.querySelector('.mux-pane iframe');
  const src = new URL(frame?.src || 'x:', 'https://claude.example.com');
  check('the pane is the chat app, embedded, in that slot',
    src.pathname === '/chat/' && src.searchParams.get('embed') === '1' && src.searchParams.get('cwd') === slotCwd(3)
      && !src.searchParams.has('session'), frame?.src);
  check('the frame may use the microphone, for dictation', /microphone/.test(frame?.allow || ''));

  // The frame names its conversation once the server has attached it.
  const post = (data, source) => w.dispatchEvent(new w.MessageEvent('message', {
    data: { source: 'triplec-chat', type: 'pane-state', ...data }, origin: 'https://claude.example.com', source,
  }));
  const pane0 = mux.state.panes[0];
  post({ cwd: slotCwd(3), sessionId: 'new-3', busy: false, sub: 'ready', title: '' }, pane0.frame.contentWindow);
  const stored = JSON.parse(w.localStorage.getItem('triplec-mux'));
  check('the session id the frame reports is what the layout saves', stored.panes[0].sessionId === 'new-3');

  // Open slot 2's chat in pane 2, then finish a turn in pane 1 while pane 2 has focus.
  mux.openIn(1, { project: 'demo', slot: 2, cwd: slotCwd(2), sessionId: 'old-2', title: 'slot two chat' });
  const second = new URL(mux.state.panes[1].frame.src);
  check('an existing chat opens joined by its session id', second.searchParams.get('session') === 'old-2');
  check('opening an existing chat does not refresh its slot', calls.filter((c) => c.url === '/api/slots/prepare').length === 1);
  post({ cwd: slotCwd(3), sessionId: 'new-3', busy: true, sub: 'working…' }, pane0.frame.contentWindow);
  post({ cwd: slotCwd(3), sessionId: 'new-3', busy: false, sub: 'ready', title: 'fix the build' }, pane0.frame.contentWindow);
  check('a turn that ends in an unfocused pane lights its ring', pane0.attention && pane0.el.classList.contains('attention'));
  check('…and the slot row in the sidebar', doc.querySelector(`.mux-slot[data-cwd="${slotCwd(3)}"]`)?.classList.contains('is-attention'));
  check('…and the tab title counts it', /^\(1\) /.test(doc.title), doc.title);
  check('the pane takes the title the chat named itself', pane0.el.querySelector('.mux-pane-title').textContent === 'fix the build');

  // The voice button: the editor overlay's sheet, aimed at this pane's slot and chat.
  check('the mux declares itself to the overlay before it loads', w.cmoHost?.name === 'mux');
  check('mux.html loads the overlay from /chat/, after mux.js',
    /<script src="\/chat\/mux\.js"><\/script>[\s\S]*<script src="\/chat\/mobile-overlay\.js" defer><\/script>/.test(html));
  const opened = [];
  w.cmoHost.open = (target) => { opened.push(target); return Promise.resolve(); };
  pane0.el.querySelector('[data-act="listen"]').click();
  check('a chat pane\'s voice button opens the sheet on its slot and its conversation',
    opened.at(-1)?.cwd === slotCwd(3) && opened.at(-1)?.sessionId === 'new-3', JSON.stringify(opened));
  mux.openIn(1, { kind: 'terminal', project: 'demo', slot: 4, cwd: slotCwd(4) });
  mux.state.panes[1].el.querySelector('[data-act="listen"]').click();
  check('a terminal pane\'s asks about its slot, pinning no conversation',
    opened.at(-1)?.cwd === slotCwd(4) && opened.at(-1)?.sessionId === null, JSON.stringify(opened));
  mux.openIn(1, { project: 'demo', slot: 2, cwd: slotCwd(2), sessionId: 'old-2', title: 'slot two chat' });

  // A message from some other frame or origin is ignored.
  w.dispatchEvent(new w.MessageEvent('message', {
    data: { source: 'triplec-chat', type: 'pane-state', busy: true }, origin: 'https://evil.example', source: pane0.frame.contentWindow,
  }));
  check('a message from another origin is ignored', !pane0.busy);

  // Clicking into the pane, which the frame reports, is looking at it.
  w.dispatchEvent(new w.MessageEvent('message', {
    data: { source: 'triplec-chat', type: 'pane-focus' }, origin: 'https://claude.example.com', source: pane0.frame.contentWindow,
  }));
  check('focusing the pane clears the ring and the count', !pane0.attention && !/^\(\d+\) /.test(doc.title)
    && mux.state.focus === 0);

  // Work happens in the slots. The main checkout is for looking at, and for
  // read-only work with an agent: a terminal starts there, a chat does not.
  const rootRow = doc.querySelector(`.mux-slot[data-cwd="${projectPath}"]`);
  check('the main checkout row is marked for read-only work, with a + that opens a terminal',
    rootRow?.classList.contains('view-only') && /terminal/i.test(rootRow.querySelector('.mux-add')?.title || '')
      && /read-only work/.test(rootRow.querySelector('.mux-slot-name').textContent), rootRow?.innerHTML);
  const prepares = calls.filter((c) => c.url === '/api/slots/prepare').length;
  await mux.startIn(1, 'demo', { n: 0, cwd: projectPath, created: true, sessions: [] }, 'chat');
  check('no chat starts in the main checkout',
    calls.filter((c) => c.url === '/api/slots/prepare').length === prepares && mux.state.panes[1].cwd === slotCwd(2));
  await mux.startIn(1, 'demo', { n: 0, cwd: projectPath, created: true, sessions: [] }, 'terminal');
  const mainPane = mux.state.panes[1];
  check('a terminal does, with nothing to prepare',
    calls.filter((c) => c.url === '/api/slots/prepare').length === prepares
      && mainPane.kind === 'terminal' && mainPane.cwd === projectPath && mainPane.slot === 0, JSON.stringify({ kind: mainPane.kind, cwd: mainPane.cwd }));
  check('and its pane says the main checkout is for reading, not building',
    /for reading and questions/.test(mainPane.el.querySelector('.mux-pane-note').textContent)
      && !mainPane.el.querySelector('.mux-pane-note').classList.contains('hidden'));
  check('its frame is the project\'s own terminal session', /[?&]slot=0(&|$)/.test(mainPane.frame?.src || ''), mainPane.frame?.src);
  check('a terminal pane carries no deprecation line', mainPane.el.querySelector('.mux-pane-deprecated').classList.contains('hidden'));
  const chatWarn = pane0.el.querySelector('.mux-pane-deprecated');
  check('a chat pane says chats are deprecated, with the way to a terminal',
    !chatWarn.classList.contains('hidden') && /deprecated/.test(chatWarn.textContent)
      && Boolean(chatWarn.querySelector('[data-act="to-terminal"]')), chatWarn.outerHTML);
  check('and so does the Chat choice for new panes', /deprecated/.test(doc.querySelector('[data-kind="chat"]').textContent));
  mux.openIn(1, { project: 'demo', slot: 2, cwd: slotCwd(2), sessionId: 'old-2', title: 'slot two chat' });
  check('the terminal is what a + opens, unless chosen otherwise', mux.state.newKind === 'terminal');

  // A slot reset after its last conversation is not called by that conversation.
  mux.state.slots.get('demo').slots[1].resetAt = 10;
  mux.closePane(1);
  mux.renderSidebar();
  check("a reset slot's row forgets the conversation that ended",
    doc.querySelector(`.mux-slot[data-cwd="${slotCwd(2)}"] .mux-slot-title`)?.textContent === 'Nothing yet');
  mux.state.slots.get('demo').slots[1].resetAt = null;
  mux.openIn(1, { project: 'demo', slot: 2, cwd: slotCwd(2), sessionId: 'old-2', title: 'slot two chat' });

  // Closing and shrinking stop nothing.
  const before = calls.length;
  mux.closePane(1);
  w.document.querySelector('[data-layout="1"]').click();
  check('closing a pane and shrinking the layout call nothing on the server',
    calls.slice(before).every((c) => c.method === 'GET'), JSON.stringify(calls.slice(before)));
  const kept = JSON.parse(w.localStorage.getItem('triplec-mux'));
  check('a pane off screen keeps its place in the layout', kept.layout === 1 && kept.panes[0].sessionId === 'new-3');
  check('one pane on screen in the one-pane layout', doc.querySelectorAll('.mux-pane').length === 1);
  w.close();
}

console.log('mux: managing projects');
{
  // Adding, inspecting and removing projects moved here from the deprecated chat.
  const html = readFileSync(join(here, 'public', 'mux.html'), 'utf8');
  const js = readFileSync(join(here, 'public', 'mux.js'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://claude.example.com/chat/mux' });
  const w = dom.window;
  const calls = [];
  let projects = [{ name: 'demo', path: '/workspace/projects/demo', sessions: [] }];
  let removeAnswer = { status: 409, body: { error: 'demo has 1 stash' } };
  w.fetch = (url, options = {}) => {
    const u = String(url);
    calls.push({ url: u, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    const reply = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
    if (u === '/api/projects/clone') {
      const { repo, into } = JSON.parse(options.body);
      if (into) return reply({ project: { name: into, path: `/workspace/projects/${into}` } });
      const name = repo.split('/').pop();
      projects = [...projects, { name, path: `/workspace/projects/${name}`, sessions: [] }];
      return reply({ project: { name, path: `/workspace/projects/${name}` } });
    }
    if (u === '/api/projects/remove') {
      const answer = removeAnswer;
      if (answer.status === 200) projects = projects.filter((p) => p.name !== 'demo');
      return reply(answer.body, answer.status);
    }
    if (u === '/api/projects' && options.method === 'POST') {
      const { name } = JSON.parse(options.body);
      projects = [...projects, { name, path: `/workspace/projects/${name}`, sessions: [] }];
      return reply({ project: { name, path: `/workspace/projects/${name}`, steps: [{ step: 'git', ok: true }, { step: 'github', ok: false, error: 'no token' }] } });
    }
    if (u.startsWith('/api/projects')) return reply({ projects });
    if (u.startsWith('/api/github/repos')) {
      return reply({ repos: [
        { slug: 'me/demo', name: 'demo', present: true, private: true, description: '' },
        { slug: 'me/<b>new</b>', name: 'new', present: false, private: false, description: '<img src=x>' },
      ] });
    }
    if (u.startsWith('/api/project-status')) {
      return reply({ status: { repos: [{ dir: '', hasCommits: true, branch: 'main', remote: 'https://github.com/me/demo.git', dirty: 0, unpushed: 0, stashes: 1, ignored: [] }], live: [], transcripts: 3 } });
    }
    if (u.startsWith('/api/slots/prepare')) return reply({ ok: true, cwd: '/x', base: 'main', fetched: true, refreshed: true });
    if (u.startsWith('/api/slots')) return reply({ name: 'x', path: '/x', enabled: false, slots: [] });
    if (u.startsWith('/api/live')) return reply({ sessions: [] });
    return reply({});
  };
  w.Notification = undefined;
  const errors = [];
  w.addEventListener('error', (e) => errors.push(e.message));
  w.eval(js);
  await new Promise((r) => setTimeout(r, 50));
  const mux = w.__muxForTest;
  const doc = w.document;
  const tick = () => new Promise((r) => setTimeout(r, 20));

  check('the sidebar has an add-project button', Boolean(doc.querySelector('#mux-new-project')));
  check('each project has a manage button', Boolean(doc.querySelector('.mux-project[data-project="demo"] .mux-manage')));

  doc.querySelector('#mux-new-project').click();
  check('the add button opens the add-project dialog', !doc.querySelector('#mux-add-sheet').classList.contains('hidden'));
  doc.querySelector('#mux-browse-repos').click();
  await tick();
  const rows = doc.querySelectorAll('#mux-repo-picker .repo-row');
  check('browsing lists the token\'s repositories', rows.length === 2);
  check('repository names and descriptions are escaped',
    !doc.querySelector('#mux-repo-picker b') && !doc.querySelector('#mux-repo-picker img'));
  rows[0].click();
  check('a repository already here is not cloned again', !calls.some((c) => c.url === '/api/projects/clone'));

  doc.querySelector('#mux-input-clone').value = 'me/fresh';
  doc.querySelector('#mux-form-clone').dispatchEvent(new w.Event('submit', { cancelable: true }));
  await tick();
  await tick();
  const clone = calls.find((c) => c.url === '/api/projects/clone');
  check('cloning posts the repository', clone?.method === 'POST' && clone.body.repo === 'me/fresh', JSON.stringify(clone));
  check('the cloned project appears in the sidebar, and the dialog closes',
    Boolean(doc.querySelector('.mux-project[data-project="fresh"]')) && doc.querySelector('#mux-add-sheet').classList.contains('hidden'));

  mux.openAddSheet();
  doc.querySelector('#mux-input-project').value = 'brand-new';
  doc.querySelector('#mux-form-project').dispatchEvent(new w.Event('submit', { cancelable: true }));
  await tick();
  const create = calls.find((c) => c.url === '/api/projects' && c.method === 'POST');
  check('creating posts the name and the GitHub choices',
    create?.body.name === 'brand-new' && create.body.github === true && create.body.private === true, JSON.stringify(create));
  check('a step that failed is said, not hidden behind a new pane',
    /github failed: no token/.test(doc.querySelector('#mux-project-status').textContent)
      && !doc.querySelector('#mux-add-sheet').classList.contains('hidden'));
  doc.querySelector('[data-close-add]').click();

  doc.querySelector('.mux-project[data-project="demo"] .mux-manage').click();
  await tick();
  const body = doc.querySelector('#mux-project-body').textContent;
  check('the project sheet shows what the project still holds',
    /me\/demo/.test(body) && /Stashes/.test(body) && /3 kept/.test(body), body);
  const remove = doc.querySelector('#mux-project-remove');
  check('and offers removal', !remove.classList.contains('hidden'));

  mux.openIn(0, { kind: 'terminal', project: 'demo', slot: 0, cwd: '/workspace/projects/demo' });
  remove.click();
  await tick();
  const first = calls.filter((c) => c.url === '/api/projects/remove');
  check('a refusal is shown, and the override is a separate press',
    first.length === 1 && first[0].body.force === false && /stash/.test(doc.querySelector('#mux-project-body').textContent)
      && /anyway/.test(remove.textContent));
  removeAnswer = { status: 200, body: { ok: true } };
  remove.click();
  await tick();
  await tick();
  const second = calls.filter((c) => c.url === '/api/projects/remove');
  check('the override forces it', second.length === 2 && second[1].body.force === true);
  check('the removed project leaves the sidebar, and its panes close',
    !doc.querySelector('.mux-project[data-project="demo"]') && !mux.state.panes[0].cwd);
  check('no page errors while managing projects', errors.length === 0, errors.join('; '));
  w.close();
}

console.log('mux, on a phone');
{
  const html = readFileSync(join(here, 'public', 'mux.html'), 'utf8');
  const js = readFileSync(join(here, 'public', 'mux.js'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://claude.example.com/chat/mux' });
  const w = dom.window;
  const path = '/workspace/projects/demo';
  const cwd = (n) => `${path}/.claude/worktrees/slot-${n}`;
  w.fetch = (url) => {
    const reply = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    if (String(url).startsWith('/api/projects')) return reply({ projects: [{ name: 'demo', path, sessions: [] }] });
    if (String(url).startsWith('/api/slots/prepare')) return reply({ ok: true, cwd: cwd(5), base: 'main', fetched: true, refreshed: true });
    if (String(url).startsWith('/api/slots')) {
      return reply({ name: 'demo', path, enabled: true, slots: Array.from({ length: 8 }, (_, i) => ({
        n: i + 1, cwd: cwd(i + 1), created: true, branch: `slot-${i + 1}`, dirty: 0, unpushed: 0, sessions: [], busy: false, held: false, elsewhere: 0,
      })) });
    }
    return reply({ sessions: [] });
  };
  w.matchMedia = (q) => ({ matches: /max-width/.test(q), addEventListener() {} });
  w.Notification = undefined;
  w.localStorage.setItem('triplec-mux', JSON.stringify({ layout: 2, expanded: ['demo'] }));
  const errors = [];
  w.addEventListener('error', (e) => errors.push(e.message));
  w.eval(js);
  await new Promise((r) => setTimeout(r, 100));
  const mux = w.__muxForTest;
  const doc = w.document;

  check('the mux boots on a phone', errors.length === 0, errors.join('; '));
  check('with nothing open, it opens on the drawer', doc.body.classList.contains('side-open'));
  check('a tab per pane', doc.querySelectorAll('#mux-tabs .mux-tab').length === 2);
  doc.querySelector(`.mux-slot[data-cwd="${cwd(5)}"] .mux-slot-main`).click();
  await new Promise((r) => setTimeout(r, 20));
  check('picking a slot closes the drawer and opens it in the pane', !doc.body.classList.contains('side-open')
    && mux.state.panes[0].cwd === cwd(5));
  check("the pane's tab says where it is", /demo · slot 5/.test(doc.querySelectorAll('.mux-tab')[0].textContent));
  doc.querySelectorAll('.mux-tab')[1].click();
  check('a tab focuses its pane, which is the one on screen', mux.state.focus === 1
    && mux.state.panes[1].el.classList.contains('focused') && !mux.state.panes[0].el.classList.contains('focused'));
  check("…and the empty one offers the drawer", Boolean(mux.state.panes[1].el.querySelector('.mux-placeholder-open')));
  mux.state.panes[1].el.querySelector('.mux-placeholder-open').click();
  check('which opens it', doc.body.classList.contains('side-open'));
  doc.querySelector('#mux-scrim').click();
  check('and a tap beside it closes it', !doc.body.classList.contains('side-open'));
  w.close();
}

console.log('mux, arriving from a notification');
{
  /*
   * A device that chose the mux lands on `/chat/mux?project=&slot=` (pwa/sw.js), or an
   * open mux is sent that address in a message. It joins what is running and starts
   * nothing: a tap is not a request for a second Claude in a checkout.
   */
  const html = readFileSync(join(here, 'public', 'mux.html'), 'utf8');
  const js = readFileSync(join(here, 'public', 'mux.js'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://claude.example.com/chat/mux?project=demo&slot=3&session=S3' });
  const w = dom.window;
  const path = '/workspace/projects/demo';
  const cwd = (n) => `${path}/.claude/worktrees/slot-${n}`;
  const calls = [];
  w.fetch = (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET' });
    const reply = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    if (String(url).startsWith('/api/projects')) return reply({ projects: [{ name: 'demo', path, sessions: [] }] });
    if (String(url).startsWith('/api/slots')) {
      return reply({ name: 'demo', path, enabled: true, rootTerminal: false, slots: Array.from({ length: 8 }, (_, i) => ({
        n: i + 1, cwd: cwd(i + 1), created: true, branch: `slot-${i + 1}`, dirty: 0, unpushed: 0, sessions: [],
        busy: false, held: false, elsewhere: 0, terminal: i + 1 === 3,
      })) });
    }
    return reply({ sessions: [] });
  };
  w.Notification = undefined;
  const worker = new w.EventTarget();
  Object.defineProperty(w.navigator, 'serviceWorker', { value: worker, configurable: true });
  // The one store the worker reads at the moment of a tap.
  const store = new Map();
  w.caches = {
    open: async (name) => ({
      match: async (key) => (store.has(`${name}|${key}`) ? { text: async () => store.get(`${name}|${key}`) } : undefined),
      put: async (key, res) => { store.set(`${name}|${key}`, await res.text()); },
    }),
  };
  w.Response = Response;
  w.localStorage.setItem('triplec-mux', JSON.stringify({ layout: 2 }));
  const errors = [];
  w.addEventListener('error', (e) => errors.push(e.message));
  w.eval(js);
  await new Promise((r) => setTimeout(r, 100));
  const mux = w.__muxForTest;
  const doc = w.document;

  check('the mux boots from a notification', errors.length === 0, errors.join('; '));
  const pane = mux.state.panes[0];
  check("it opens the slot's running terminal in a free pane",
    pane.kind === 'terminal' && pane.cwd === cwd(3) && pane.slot === 3, JSON.stringify({ kind: pane.kind, cwd: pane.cwd }));
  check('without preparing the slot or starting anything', !calls.some((c) => c.method !== 'GET'), JSON.stringify(calls));
  check('and drops the address, so a reload is not a second arrival', w.location.search === '', w.location.search);

  const tapped = (url) => worker.dispatchEvent(new w.MessageEvent('message', { data: { type: 'cw-notification-click', url } }));
  mux.focusPane(1);
  tapped('/chat/mux?project=demo&slot=3&session=S3');
  await new Promise((r) => setTimeout(r, 30));
  check('a second tap on the same slot focuses its pane instead of opening another',
    mux.state.focus === 0 && mux.state.panes[1].cwd === null);

  tapped('/chat/mux?project=demo&slot=5&session=S5');
  await new Promise((r) => setTimeout(r, 30));
  check('a slot with no terminal to join opens nothing',
    mux.state.panes.every((p) => p.cwd !== cwd(5)) && !calls.some((c) => c.method !== 'GET'));
  check('and says where the conversation is instead', /no terminal to join/.test(doc.querySelector('#toast').textContent),
    doc.querySelector('#toast').textContent);

  tapped('//elsewhere.example/chat/mux?project=demo&slot=5');
  tapped('/p/demo/?folder=x&session=S1');
  await new Promise((r) => setTimeout(r, 30));
  check('an address that is not this mux is ignored', mux.state.panes.every((p) => p.cwd !== cwd(5)));
  check('the address parser keeps the main checkout as slot 0 and drops a non-slot',
    mux.arrivalFrom('?project=demo&slot=0').slot === 0 && mux.arrivalFrom('?project=demo').slot === null
      && mux.arrivalFrom('?slot=2') === null);

  // The choice itself, in the footer.
  const button = doc.querySelector('#mux-opens');
  check('the footer says where notifications open, the editor by default',
    !button.hidden && /the editor/.test(button.textContent), button.textContent);
  button.click();
  await new Promise((r) => setTimeout(r, 30));
  check('one click sends them to the mux, stored where the worker reads it',
    store.get('triplec-prefs|/chat/prefs/notification-opens') === 'mux' && /the Mux/.test(button.textContent),
    `${JSON.stringify([...store])} ${button.textContent}`);
  button.click();
  await new Promise((r) => setTimeout(r, 30));
  check('and another puts them back', store.get('triplec-prefs|/chat/prefs/notification-opens') === 'editor');
  w.close();
}

console.log('chat, embedded');
{
  const html = readFileSync(join(here, 'public', 'index.html'), 'utf8');
  const js = readFileSync(join(here, 'public', 'app.js'), 'utf8');
  const cwd = '/workspace/projects/demo/.claude/worktrees/slot-3';
  const q = new URLSearchParams({ embed: '1', cwd, project: 'demo', session: 'abc' });
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: `https://claude.example.com/chat/?${q}` });
  const w = dom.window;
  const calls = [];
  w.fetch = (url) => {
    calls.push(String(url));
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ sessions: [], projects: [], models: [] }) });
  };
  const sent = [];
  w.WebSocket = function () {
    this.addEventListener = () => {};
    this.send = (m) => sent.push(JSON.parse(m));
    this.close = () => {};
    this.readyState = 0;
  };
  w.WebSocket.CONNECTING = 0;
  w.WebSocket.OPEN = 1;
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  const posted = [];
  const parent = { postMessage: (m) => posted.push(m) };
  Object.defineProperty(w, 'parent', { get: () => parent });
  w.localStorage.setItem('claude-chat-panes', JSON.stringify({ panes: [{ cwd: '/workspace/projects/other', project: 'other' }], activeKey: '/workspace/projects/other' }));
  const errors = [];
  w.addEventListener('error', (e) => errors.push(e.message));
  w.eval(js);
  await new Promise((r) => setTimeout(r, 100));
  const hooks = w.__panesForTest;

  check('the embedded chat boots without an error', errors.length === 0, errors.join('; '));
  check('it is marked embedded, which hides the navigation', w.document.documentElement.classList.contains('embed'));
  check('it opens exactly the conversation it was given', hooks.panes.size === 1
    && [...hooks.panes.values()][0].sessionId === 'abc' && [...hooks.panes.values()][0].sessionCwd === cwd);
  check("it leaves this device's own tabs alone",
    JSON.parse(w.localStorage.getItem('claude-chat-panes')).panes[0].cwd === '/workspace/projects/other');
  check('it loads no list and polls nothing', !calls.some((u) => u.includes('/api/projects') || u.includes('/api/live')), calls.join(','));
  check('it tells the mux what its conversation is doing',
    posted.some((m) => m.source === 'triplec-chat' && m.type === 'pane-state' && m.sessionId === 'abc' && m.cwd === cwd));
  const pane = [...hooks.panes.values()][0];
  w.__handleEventForTest({ type: 'attached', conversationId: 'c1', sessionId: 'abc', busy: true }, pane);
  w.__handleEventForTest({ type: 'turn_complete' }, pane);
  const states = posted.filter((m) => m.type === 'pane-state').map((m) => m.busy);
  check('a turn starting and ending both reach the mux', states.includes(true) && states.at(-1) === false);
  w.document.querySelector('#input').dispatchEvent(new w.Event('pointerdown', { bubbles: true }));
  check('a click inside the frame is reported to the mux', posted.some((m) => m.type === 'pane-focus'));
  w.close();
}

console.log('chat, deep link');
{
  const html = readFileSync(join(here, 'public', 'index.html'), 'utf8');
  const js = readFileSync(join(here, 'public', 'app.js'), 'utf8');
  const q = new URLSearchParams({
    cwd: '/workspace/projects/demo', sessionCwd: '/workspace/projects/demo/.claude/worktrees/slot-3', session: 'abc', project: 'demo',
  });
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: `https://claude.example.com/chat/?${q}` });
  const w = dom.window;
  w.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ sessions: [], projects: [], models: [] }) });
  w.WebSocket = function () {
    this.addEventListener = () => {};
    this.send = () => {};
    this.close = () => {};
    this.readyState = 0;
  };
  w.WebSocket.CONNECTING = 0;
  w.WebSocket.OPEN = 1;
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  w.eval(js);
  await new Promise((r) => setTimeout(r, 50));
  const pane = w.__panesForTest.activePane();
  check('a link from the mux opens that chat in its project\'s tab, in its slot',
    pane?.cwd === '/workspace/projects/demo' && pane.sessionId === 'abc'
      && pane.sessionCwd === '/workspace/projects/demo/.claude/worktrees/slot-3');
  check('…and drops its query for ?chat=1, so a refresh is an ordinary launch of the chat rather than the mux a bare /chat/ now opens', w.location.search === '?chat=1', w.location.search);
  check('…and is saved as one of the device\'s tabs', JSON.parse(w.localStorage.getItem('claude-chat-panes') || '{}').panes?.[0]?.sessionId === 'abc');
  w.close();
}

await rm(root, { recursive: true, force: true });
await rm(remotes, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
