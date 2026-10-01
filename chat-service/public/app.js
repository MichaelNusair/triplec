/* Chat client. Deliberately dependency-free — it has to boot fast on a phone. */

// Report load failures to the server. A script error on a phone is otherwise
// invisible — the page just sits on "Loading…" with no way to see why — and
// device-specific parse errors can't be reproduced from a desktop.
window.addEventListener('error', (e) => {
  try {
    navigator.sendBeacon?.(
      '/api/client-error',
      JSON.stringify({
        message: e.message,
        source: e.filename,
        line: e.lineno,
        column: e.colno,
        stack: e.error?.stack?.slice(0, 800),
        ua: navigator.userAgent,
      }),
    );
  } catch {
    /* reporting must never itself break the page */
  }
});

window.addEventListener('unhandledrejection', (e) => {
  try {
    navigator.sendBeacon?.(
      '/api/client-error',
      JSON.stringify({
        message: `unhandled rejection: ${e.reason?.message || e.reason}`,
        stack: e.reason?.stack?.slice(0, 800),
        ua: navigator.userAgent,
      }),
    );
  } catch {
    /* ignore */
  }
});

const $ = (sel) => document.querySelector(sel);

// --- authentication ---------------------------------------------------------

/**
 * Sessions outlive a phone in a pocket but not forever, so any request can come
 * back 401. Send the user to the login page, remembering where they were so
 * they land back in the same conversation afterwards.
 */
let redirecting = false;
function redirectToLogin() {
  if (redirecting) return; // Several in-flight requests can 401 at once.
  redirecting = true;
  const next = encodeURIComponent(location.pathname + location.search);
  location.replace(`/login?next=${next}`);
}

/**
 * Every call to the API goes through this. A bare `fetch` that forgets the 401
 * case shows the user a generic "couldn't load" error and no way forward, which
 * is indistinguishable from the server being broken.
 */
async function api(url, options) {
  const res = await fetch(url, options);
  if (res.status === 401) {
    redirectToLogin();
    throw new Error('not signed in');
  }
  return res;
}

// Declared before `state`, which calls loadSettings() during initialisation.
// `const` is not hoisted, so defining this later puts it in a temporal dead
// zone and throws a ReferenceError that kills the whole script at parse time.
const DEFAULTS = {
  model: 'us.anthropic.claude-opus-5',
  permissionMode: 'bypassPermissions',
  effort: 'max',
  // Empty means "whichever voice fits the message", which the server decides per
  // message — a Hebrew answer read by a Hebrew voice with nothing set. A named
  // voice here is an override of that. See paintVoicePicker.
  voice: '',
};

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('claude-chat') || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

/*
 * Which projects this device has open, and which one it was looking at.
 *
 * Persisted so a refresh, an app-switch on iOS, or reopening the PWA comes back
 * to the same set of projects instead of dropping to the list and starting over.
 * Each entry carries the conversation that project's window was showing: that
 * session id is the durable, cross-device name for a conversation. A window with
 * no conversation yet is still saved — the tab is the project, and the project
 * exists whether or not anything has been said in it.
 */
const OPEN_PANES_KEY = 'claude-chat-panes';
// The single-chat key this replaced. Read once at boot so upgrading does not drop
// the conversation the user had open, and never written again.
const LEGACY_OPEN_CHAT_KEY = 'claude-chat-open';
// More tabs than this is a scrolling strip nobody reads. The oldest fall off the
// end; nothing in them stops, and they are all still in the list.
const MAX_TABS = 6;

function saveOpenPanes() {
  try {
    const open = [...panes.values()]
      .filter((p) => !p.closed)
      .slice(-MAX_TABS)
      .map((p) => ({
        cwd: p.cwd,
        project: p.project,
        sessionId: p.sessionId,
        title: p.title,
        named: Boolean(p.named),
      }));
    if (!open.length) {
      localStorage.removeItem(OPEN_PANES_KEY);
      return;
    }
    localStorage.setItem(
      OPEN_PANES_KEY,
      JSON.stringify({ panes: open, activeKey: state.activeKey }),
    );
  } catch {
    /* private mode; device-switching still works via the session id */
  }
}

/*
 * The saved tabs, collapsed to one per project.
 *
 * The collapse is also what upgrades a device that saved tabs under the old
 * per-conversation model: two TripleC chats become one TripleC tab showing
 * the later of them. Nothing is lost that mattered — the other conversation is
 * still running on the box and still in the list — and the alternative is a strip
 * with the same project on it twice, which is the thing this replaced.
 */
function loadOpenPanes() {
  const collapse = (list) => {
    const byCwd = new Map();
    for (const entry of list) {
      if (!entry?.cwd) continue;
      // Later entries win, key by key, so a project saved twice keeps the newer
      // conversation without losing a name the older entry alone carried.
      byCwd.set(entry.cwd, { ...byCwd.get(entry.cwd), ...entry });
    }
    return [...byCwd.values()].slice(-MAX_TABS);
  };
  try {
    const saved = JSON.parse(localStorage.getItem(OPEN_PANES_KEY) || 'null');
    if (saved?.panes?.length) {
      const list = collapse(saved.panes);
      // The saved active key may be a new-style `cwd`, an old `cwd|sessionId`, or
      // an old `cwd|new:1` that never meant anything to anybody but the page that
      // wrote it. In all three the directory in front of the pipe is the tab to
      // land on.
      const activeCwd = String(saved.activeKey || '').split('|')[0];
      const active = list.some((p) => p.cwd === activeCwd) ? paneKey(activeCwd) : null;
      return { panes: list, activeKey: active };
    }
    const legacy = JSON.parse(localStorage.getItem(LEGACY_OPEN_CHAT_KEY) || 'null');
    if (legacy?.cwd && legacy?.sessionId) {
      return { panes: collapse([legacy]), activeKey: paneKey(legacy.cwd) };
    }
  } catch {
    /* fall through to a cold start, which is always safe */
  }
  return { panes: [], activeKey: null };
}

const state = {
  projects: [],
  settings: loadSettings(),
  // Which pane is on screen — a pane's key is its project's directory. Everything
  // else about a window lives in the pane itself — see the panes section — because
  // a conversation now keeps running, and keeps rendering, while you are looking
  // at a different project.
  activeKey: null,
};
function saveSettings() {
  localStorage.setItem('claude-chat', JSON.stringify(state.settings));
}

// --- what the tab says ------------------------------------------------------

/**
 * This deployment's own name, and the title the shell arrived with.
 *
 * One account can run this app twice, and then a browser with both open is two
 * tabs called the same thing. The server writes the name into the shell — the meta
 * tag and the title itself — so both are read from the document rather than
 * fetched: a tab has to be right before the first request finishes, and an unnamed
 * deployment must look exactly as it always did.
 */
const DEPLOYMENT = $('meta[name="deployment"]')?.content.trim() || '';
const BASE_TITLE = document.title;

/**
 * The build that served this page, read once at load.
 *
 * Read from the document rather than fetched for the reason it has to be: this is
 * the value /api/version is later compared against, and a fetched one would be the
 * server's current build — which is what we are trying to tell it apart from. A
 * page held open on a phone for a week and a page loaded a second ago ask that
 * endpoint the same question and must get different answers.
 *
 * Empty on a server too old to stamp it (or a shell opened from disk), which
 * paintBuild treats as "cannot say", never as "out of date".
 */
const PAGE_BUILD = $('meta[name="build"]')?.content.trim() || '';

/**
 * Title the tab after the project on screen, or after the deployment when none is.
 *
 * "<name>: <project>" is the same label the project's own installed icon carries
 * (short_name in chat-service/manifest.js), so the tab and the home screen agree
 * about what a window is. Without a deployment name the project stands alone, which
 * is what one deployment wants: it has nothing to be told apart from.
 */
function setTabTitle(project) {
  if (!project) {
    document.title = BASE_TITLE;
    return;
  }
  document.title = DEPLOYMENT ? `${DEPLOYMENT}: ${project}` : project;
}

// --- navigation -------------------------------------------------------------
const screens = ['list', 'new', 'chat'];
const navStack = ['list'];

function show(name) {
  for (const s of screens) $(`#screen-${s}`).classList.toggle('active', s === name);
  if (navStack[navStack.length - 1] !== name) navStack.push(name);
}
function back() {
  // Leaving the chat: release the mic. The screen wake lock is deliberately not
  // released — it belongs to the app being open, not to this screen. Safe to
  // reach `voice` from here — this only ever runs from a click, long after the
  // script is evaluated — but never call back() during initialisation.
  if (voice.active) stopVoice();
  else hideDictationBar();
  navStack.pop();
  const target = navStack[navStack.length - 1] || 'list';
  for (const s of screens) $(`#screen-${s}`).classList.toggle('active', s === target);
  if (target === 'list') {
    // Deliberately looking away from every project, so the next launch lands on
    // the list. The tabs stay open and their sockets stay up — that is how a chat
    // left working still announces itself — but none of them is on screen now.
    saveDraft({ now: true });
    state.activeKey = null;
    // No project on screen, so the tab goes back to naming the deployment.
    setTabTitle(null);
    renderConvBar(null);
    saveOpenPanes();
    refreshList();
  }
}
document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', back));

function toast(message, ms = 3200) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add('hidden'), ms);
}

// --- conversation list ------------------------------------------------------
async function refreshList() {
  const body = $('#list-body');
  try {
    // Bound the request: on a flaky mobile connection a hung fetch would
    // otherwise leave the list stuck on "Loading…" forever.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await api('/api/projects', { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`server returned ${res.status}`);
    const data = await res.json();
    state.projects = data.projects || [];
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'the server timed out' : err.message;
    body.innerHTML =
      `<div class="empty">Couldn't load chats — ${escapeHtml(reason)}.` +
      `<br><br><button class="wide" id="btn-retry">Retry</button></div>`;
    $('#btn-retry')?.addEventListener('click', refreshList);
    return;
  }

  const rows = [];
  for (const project of state.projects) {
    for (const session of project.sessions) {
      rows.push({ project, session });
    }
  }
  rows.sort((a, b) => b.session.mtime - a.session.mtime);

  if (!rows.length) {
    body.innerHTML =
      '<div class="empty">No chats yet.<br><br>Tap + to start one.</div>';
    return;
  }

  body.innerHTML = '';
  for (const { project, session } of rows) {
    const row = document.createElement('button');
    row.className = 'row';
    // The conversation key /api/live uses, so the badges below can be kept honest
    // by polling without re-reading every transcript to redraw a list.
    row.dataset.key = convKey(project.path, session.sessionId);
    // The tab this row would open, and the chat it would put in it — what
    // `paintRowBadges` needs to say whether it is already on screen.
    row.dataset.cwd = project.path;
    row.dataset.session = session.sessionId;
    // A chat that is still live on the server is labelled, so it's clear that
    // opening it joins the running session — including one left working on
    // another device.
    row.innerHTML = `
      <div class="avatar">${escapeHtml(project.name.slice(0, 2).toUpperCase())}</div>
      <div class="row-main">
        <div class="row-title">${escapeHtml(session.title)}</div>
        <div class="row-sub">${escapeHtml(project.name)} · ${relTime(session.mtime)}
          <span class="row-live hidden"></span><span class="row-open hidden">open</span>
        </div>
      </div>`;
    row.addEventListener('click', () =>
      openConversation({
        cwd: project.path,
        project: project.name,
        sessionId: session.sessionId,
        title: session.title,
      }),
    );
    body.appendChild(row);
  }
  paintRowBadges(liveByKey(rows));
}

/**
 * What the server said about each session, keyed the way the rows are.
 *
 * `/api/projects` already carries `live` and `busy`, so the first paint after a
 * list load uses that rather than waiting up to a poll interval to look right.
 */
function liveByKey(rows) {
  const map = new Map();
  for (const { project, session } of rows) {
    if (!session.live && !session.busy) continue;
    map.set(convKey(project.path, session.sessionId), { busy: Boolean(session.busy) });
  }
  return map;
}

/**
 * Update the list's badges in place.
 *
 * In place, rather than by redrawing the list, because redrawing means
 * `/api/projects` — which stats and reads every transcript to build titles. This
 * runs every few seconds; that route cannot.
 */
function paintRowBadges(byKey) {
  for (const row of document.querySelectorAll('#list-body .row[data-key]')) {
    const live = byKey.get(row.dataset.key);
    const badge = row.querySelector('.row-live');
    const open = row.querySelector('.row-open');
    if (badge) {
      const text = live?.busy ? 'working…' : live ? 'live' : '';
      badge.textContent = text;
      badge.classList.toggle('hidden', !text);
      badge.classList.toggle('busy', Boolean(live?.busy));
    }
    // Already on screen in its project's window: tapping the row switches to that
    // tab rather than opening the same conversation twice. A row in a project that
    // has a tab showing a *different* chat is not "open" — tapping it will move
    // that window, which is a change, not a no-op.
    if (open) {
      const pane = panes.get(paneKey(row.dataset.cwd));
      open.classList.toggle('hidden', !pane || pane.sessionId !== row.dataset.session);
    }
  }
}

// --- new chat / open a project ------------------------------------------------
/*
 * The picker screen serves two intents, and the difference only shows when the
 * project already has a tab. "New chat" means start one; "+" on the tab strip
 * means put that project on screen. Getting this backwards would either replace a
 * conversation the user was in the middle of, or refuse to start the new chat they
 * just asked for.
 */
let pickerWantsNewChat = true;

async function showPicker({ newChat }) {
  pickerWantsNewChat = newChat;
  await refreshList();
  renderProjectPicker();
  $('#repo-picker').innerHTML = '';
  $('#clone-status').textContent = '';
  show('new');
}

$('#btn-new').addEventListener('click', () => showPicker({ newChat: true }));

function renderProjectPicker() {
  const picker = $('#project-picker');
  picker.innerHTML = '';

  if (!state.projects.length) {
    picker.innerHTML = '<div class="empty">No projects yet. Clone one, or create one below.</div>';
    return;
  }
  for (const project of state.projects) {
    const wrap = document.createElement('div');
    wrap.className = 'row-wrap';

    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'row';
    row.innerHTML = `
      <div class="avatar">${escapeHtml(project.name.slice(0, 2).toUpperCase())}</div>
      <div class="row-main">
        <div class="row-title">${escapeHtml(project.name)}</div>
        <div class="row-sub">${project.sessions.length} chat${project.sessions.length === 1 ? '' : 's'}</div>
      </div>`;
    row.addEventListener('click', () =>
      openProject({ cwd: project.path, project: project.name, fresh: pickerWantsNewChat }),
    );

    const manage = document.createElement('button');
    manage.type = 'button';
    manage.className = 'icon-btn';
    manage.setAttribute('aria-label', `Manage ${project.name}`);
    manage.innerHTML =
      '<svg viewBox="0 0 24 24"><path d="M12 8a2 2 0 1 1 0-4 2 2 0 0 1 0 4m0 6a2 2 0 1 1 0-4' +
      ' 2 2 0 0 1 0 4m0 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4"/></svg>';
    manage.addEventListener('click', () => openProjectSheet(project));

    wrap.append(row, manage);
    picker.appendChild(wrap);
  }
}

// --- cloning an existing GitHub repo ----------------------------------------
$('#form-clone').addEventListener('submit', (e) => {
  e.preventDefault();
  cloneRepo($('#input-clone').value.trim());
});

/**
 * Deliberately not wrapped in an AbortController, unlike the list fetch: a real
 * repository can take minutes to clone on a small instance, and a client-side
 * timeout would abandon a clone that is still running server-side, leaving a
 * half-finished directory nobody is watching. The server's own git timeout is
 * the bound.
 */
async function cloneRepo(repo) {
  if (!repo) return;
  const status = $('#clone-status');
  status.textContent = `Cloning ${repo}… a large repository can take a few minutes.`;

  try {
    const res = await api('/api/projects/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'clone failed');

    status.textContent = '';
    $('#input-clone').value = '';
    $('#repo-picker').innerHTML = '';
    await refreshList();
    renderProjectPicker();
    openProject({ cwd: data.project.path, project: data.project.name });
  } catch (err) {
    status.textContent = err.message;
  }
}

$('#btn-browse-repos').addEventListener('click', async () => {
  const picker = $('#repo-picker');
  picker.innerHTML = '<div class="empty">Loading your repositories…</div>';

  try {
    const res = await api('/api/github/repos');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'could not list repositories');
    if (!data.repos.length) {
      picker.innerHTML = '<div class="empty">No repositories visible to this workspace token.</div>';
      return;
    }

    picker.innerHTML = '';
    for (const repo of data.repos) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'row repo-row';
      const tags =
        (repo.private ? '<span class="repo-tag">private</span>' : '') +
        (repo.present ? '<span class="repo-tag">already here</span>' : '');
      row.innerHTML = `
        <div class="row-main">
          <div class="row-title">${escapeHtml(repo.slug)}${tags}</div>
          <div class="row-sub">${escapeHtml(repo.description || 'No description')}</div>
        </div>`;
      row.addEventListener('click', () => {
        // Cloning over an existing directory is refused server-side; saying so
        // here saves the round trip and explains the label.
        if (repo.present) {
          toast(`"${repo.name}" is already in the workspace.`);
          return;
        }
        $('#input-clone').value = repo.slug;
        cloneRepo(repo.slug);
      });
      picker.appendChild(row);
    }
  } catch (err) {
    picker.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
  }
});

// --- managing and removing a project ----------------------------------------
/**
 * Deleting a project deletes a directory tree, so the sheet's job is to show
 * what is in it *before* offering the button — and the server checks the same
 * things again for itself. Anything the client shows here is a courtesy; the
 * refusal that matters happens server-side.
 */
const projectSheet = $('#project-sheet');
let sheetProject = null;

function closeProjectSheet() {
  projectSheet.classList.add('hidden');
  sheetProject = null;
}
document
  .querySelectorAll('[data-close-project]')
  .forEach((el) => el.addEventListener('click', closeProjectSheet));

async function openProjectSheet(project) {
  sheetProject = project;
  $('#project-sheet-title').textContent = project.name;
  $('#project-sheet-body').textContent = 'Checking the repository…';
  const btn = $('#btn-project-remove');
  btn.classList.add('hidden');
  btn.disabled = false;
  projectSheet.classList.remove('hidden');

  try {
    const res = await api(`/api/project-status?name=${encodeURIComponent(project.name)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'could not read the project');
    // The sheet may have been closed, or opened on a different project, while
    // this was in flight — writing into it then would mislabel the facts.
    if (sheetProject?.name !== project.name) return;
    renderProjectFacts(data.status);
  } catch (err) {
    if (sheetProject?.name === project.name) $('#project-sheet-body').textContent = err.message;
  }
}

function factList(facts) {
  return `<ul class="fact-list">${facts
    .map(
      (f) =>
        `<li class="${f.atRisk ? 'at-risk' : ''}"><span>${escapeHtml(f.label)}</span>` +
        `<span>${escapeHtml(f.value)}</span></li>`,
    )
    .join('')}</ul>`;
}

/** What one repository holds, in the order that matters if the folder disappears. */
function repoFacts(repo) {
  const facts = [];
  const add = (label, value, atRisk = false) => facts.push({ label, value, atRisk });

  add('Branch', repo.hasCommits ? repo.branch || 'unknown' : 'no commits yet');
  add(
    'Remote',
    repo.remote ? repo.remote.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '') : 'none',
    !repo.remote,
  );
  add('Uncommitted changes', repo.dirty ? `${repo.dirty} (will be committed)` : 'none');
  add('Unpushed commits', repo.unpushed ? `${repo.unpushed} (will be pushed)` : 'none');
  if (repo.stashes) add('Stashes', `${repo.stashes} — not pushed by anything`, true);
  if (repo.ignored.length) add('Not in git', repo.ignored.join(', '), true);
  return facts;
}

/**
 * A project is a directory, so it can hold one repository, several, or none —
 * the same shape as a VS Code workspace. Each one is pushed and verified
 * separately before the folder is deleted, so each one gets its own block of
 * facts. One repo at the root is still the common case, and still reads as the
 * single flat list it always did.
 */
function renderProjectFacts(status) {
  const repos = status.repos || [];
  let body = '';

  if (!repos.length) {
    body += factList([{ label: 'Git', value: 'not a repository', atRisk: true }]);
  } else if (repos.length === 1 && !repos[0].dir) {
    body += factList(repoFacts(repos[0]));
  } else {
    for (const repo of repos) {
      body +=
        `<h3 class="repo-heading">${escapeHtml(repo.dir || 'project root')}</h3>` +
        factList(repoFacts(repo));
    }
  }

  const tail = [];
  if (status.live.length) {
    const busy = status.live.filter((c) => c.busy).length;
    tail.push({
      label: 'Open chats',
      value: busy ? `${status.live.length} (${busy} working)` : String(status.live.length),
      atRisk: Boolean(busy),
    });
  }
  tail.push({ label: 'Chat history', value: `${status.transcripts} kept after deleting` });
  body += factList(tail);

  body +=
    `<p class="hint" style="margin-top:14px">Commits and pushes ${
      repos.length > 1 ? 'every repository above, checks each remote' : 'everything, checks the remote'
    } really has it, then deletes the folder from this machine. Chat history stays.</p>` +
    // Cloning a second repository in is what makes this a workspace rather than
    // a single checkout, and this sheet is already where a project is managed.
    '<h3 class="repo-heading">Add a repository</h3>' +
    '<form id="form-add-repo" class="inline-form">' +
    '<input id="input-add-repo" type="text" placeholder="owner/repo" autocomplete="off" ' +
    'autocapitalize="none" autocorrect="off" spellcheck="false" required>' +
    '<button type="submit">Clone in</button></form>' +
    '<p class="hint" id="add-repo-status">Clones it into this project, beside what is already here.</p>';

  $('#project-sheet-body').innerHTML = body;
  $('#form-add-repo').addEventListener('submit', addRepoToProject);

  const btn = $('#btn-project-remove');
  btn.textContent = 'Push & delete from this machine';
  btn.onclick = () => removeProjectFromMachine(false);
  btn.classList.remove('hidden');
}

/**
 * Clone another repository into the project this sheet is open on.
 *
 * Slow enough to need its own progress line — a large repository on this
 * instance is minutes — and the sheet is re-read afterwards so the new repo
 * appears in the facts above, which is the confirmation that it landed.
 */
async function addRepoToProject(e) {
  e.preventDefault();
  const project = sheetProject;
  const input = $('#input-add-repo');
  const status = $('#add-repo-status');
  const repo = input.value.trim();
  if (!project || !repo) return;

  input.disabled = true;
  status.textContent = `Cloning ${repo} into ${project.name}… this can take a few minutes.`;

  try {
    const res = await api('/api/projects/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo, into: project.name }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'could not clone that repository');
    toast(`Cloned ${repo} into "${project.name}".`);
    await refreshList();
    // Re-reads the project, which redraws this sheet with the new repository in it.
    if (sheetProject?.name === project.name) await openProjectSheet(project);
  } catch (err) {
    input.disabled = false;
    status.textContent = err.message;
  }
}

async function removeProjectFromMachine(force) {
  const project = sheetProject;
  if (!project) return;
  const btn = $('#btn-project-remove');
  const body = $('#project-sheet-body');
  const previous = btn.textContent;

  btn.disabled = true;
  btn.textContent = force ? 'Deleting…' : 'Committing, pushing, verifying…';

  try {
    const res = await api('/api/projects/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: project.name, force }),
    });
    const data = await res.json();

    // 409 is a refusal, not a failure: the server found something that only
    // exists on this machine. Say what, and make overriding a separate,
    // deliberate second tap rather than a retry of the same button.
    if (res.status === 409) {
      body.innerHTML =
        `<p style="color:var(--accent);margin:0 0 12px">${escapeHtml(data.error)}</p>` +
        '<p class="hint" style="margin:0">Deleting now would lose that. Fix it from a chat in ' +
        'this project, or override — the folder goes away either way.</p>';
      btn.disabled = false;
      btn.textContent = 'Delete anyway, losing that work';
      btn.onclick = () => removeProjectFromMachine(true);
      return;
    }
    if (!res.ok) throw new Error(data.error || 'could not remove the project');

    closeProjectSheet();
    toast(
      force
        ? `Deleted "${project.name}" — forced, so check GitHub before relying on it.`
        : `Pushed and deleted "${project.name}".`,
      5000,
    );
    // Any open chat may have been in the project that just went away. Its
    // directory no longer exists, so the tab cannot be reconnected or resumed.
    for (const pane of [...panes.values()]) {
      if (pane.cwd === project.path) closePane(pane, { quiet: true });
    }
    await refreshList();
    renderProjectPicker();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = previous;
    toast(err.message, 5000);
  }
}

$('#form-project').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#input-project');
  const status = $('#new-project-status');
  const name = input.value.trim();
  if (!name) return;

  const wantsGithub = $('#opt-github')?.checked ?? false;
  status.textContent = wantsGithub
    ? 'Creating folder, git repo and GitHub remote…'
    : 'Creating…';

  try {
    const res = await api('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        github: wantsGithub,
        private: $('#opt-private')?.checked ?? true,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'could not create project');

    // Report per-step outcomes: a local repo whose remote failed is a different
    // result from a fully wired project, and opening the chat would hide that.
    const failed = (data.project.steps || []).filter((s) => !s.ok);
    if (failed.length) {
      status.textContent =
        `Created "${name}", but ` +
        failed.map((s) => `${s.step} failed: ${s.error || 'unknown'}`).join('; ');
      return;
    }

    const repo = (data.project.steps || []).find((s) => s.step === 'github' && s.ok);
    status.textContent = repo?.url ? `Pushed to ${repo.url}` : '';
    input.value = '';
    openProject({ cwd: data.project.path, project: data.project.name });
  } catch (err) {
    status.textContent = '';
    toast(err.message);
  }
});

// --- panes ------------------------------------------------------------------
/*
 * Several projects open at once, on a phone.
 *
 * **A tab is a project, not a conversation.** That is the whole design, and it is
 * worth being explicit about because the obvious alternative — a tab per chat —
 * was built first and was wrong. There are 17 projects on this box and 32
 * conversations in them: a strip of chips named after conversations is a list of
 * things you have to remember the meaning of, while a strip named after projects
 * is the thing you actually move between. You work on a project; the conversation
 * is just where you are in it.
 *
 * So a pane is one project's window, and it holds:
 *   - `cwd`, its identity — a project is a directory, so the directory is the key
 *   - `project`, the name on the chip
 *   - `sessionId`, *which* conversation is in the window right now, and mutable:
 *     switching conversation swaps the socket and the thread inside one tab
 * plus everything that draws it — its socket, its thread element, the bubble being
 * streamed into, the tool cards still waiting for results. A window's conversation
 * keeps working while you are looking at another project, so events have to land in
 * a thread that is off screen, which cannot happen while there is exactly one of
 * everything.
 *
 * Tabs, not tiles. Two 190px columns on a 390px phone make both projects
 * unreadable; what a second window is actually for here is switching without
 * losing state and knowing what the other one is doing, and a strip of chips with
 * a status dot gives both for no width at all.
 *
 * Only MAX_LIVE panes hold a socket and a thread. Past that the least recently
 * used *idle* pane is cooled: socket closed, thread dropped, tab kept. Nothing is
 * lost — the process keeps running on the box and the transcript is on disk, so
 * coming back is the same join another device would do — and it is what stops six
 * open tabs from being six threads of several hundred bubbles in a phone's
 * memory. A working pane is never cooled: being told when it lands is the point.
 *
 * The one thing this model gives up: two conversations in the *same* project
 * cannot both be on screen, because that project has one tab. Switching between
 * them inside the window leaves the other running on the box — nothing is stopped
 * — but only the one in the window is watched. Cross-project is the case this is
 * for, and it is the case that happens.
 */
const MAX_LIVE = 3;
const panes = new Map();

/**
 * A tab's key. A tab is a project, so the project's directory *is* the key —
 * which is what makes "open this project" idempotent no matter where it is
 * called from: the list, the picker, a restored tab, or another conversation in
 * the same project.
 */
function paneKey(cwd) {
  return cwd;
}

/**
 * A conversation's durable, cross-device name.
 *
 * Deliberately still `cwd|sessionId`, and deliberately no longer the pane key:
 * drafts, the list rows and `/api/live` are all about a *conversation*, and they
 * agree with the server, which keys its conversations this way too. A draft
 * belongs to the chat it was typed in, not to the window that happened to be
 * showing it.
 */
function convKey(cwd, sessionId) {
  return `${cwd}|${sessionId || ''}`;
}

function activePane() {
  return panes.get(state.activeKey) || null;
}

function makePane({ cwd, project, title, sessionId }) {
  const pane = {
    // Stable for the life of the tab: a project does not become another project,
    // and the conversation inside it changing is not a re-key. This is the part
    // the per-conversation model got wrong — every new chat's first reply used to
    // rename its own tab out from under everything holding a reference to it.
    key: paneKey(cwd),
    cwd,
    project: project || basename(cwd),
    // The conversation currently in the window, for the switcher line under the
    // tabs. Not the chip's label — the chip is the project.
    title: title || 'New chat',
    // Whether that title came from a transcript. A chat opened from the list is
    // already named; a new one names itself from its first message.
    named: Boolean(title),
    // The CLI's own session id: the durable, cross-device name for this chat.
    // `conversationId` only identifies the process to this browser, so it is
    // useless after a refresh and meaningless on another device.
    sessionId: sessionId || null,
    conversationId: null,
    ws: null,
    thread: null,          // created on activation; null while cold
    chip: null,
    cold: true,            // no socket, no thread: a tab and a session id
    closed: false,         // the tab is gone; never reconnect
    trouble: false,        // socket could not be established or the session ended
    busy: false,
    sub: 'connecting…',
    unread: false,
    touchedAt: Date.now(),
    streamingEl: null,     // the assistant bubble currently being appended to
    typingEl: null,
    toolEls: new Map(),    // tool_use id -> card element, so results can attach
    echoedMessages: new Set(), // locally-rendered sends, to drop the server echo
    reconnectDelay: 500,
    draft: '',
  };
  panes.set(pane.key, pane);
  return pane;
}

/** The project name to fall back on when a caller only knows the directory. */
function basename(cwd) {
  return String(cwd || '').replace(/\/+$/, '').split('/').pop() || 'project';
}

/**
 * Open a project's window.
 *
 * One tab per project, always — so this is find-or-create, and tapping a project
 * you already have open is a switch rather than a second tab. With no conversation
 * named, an existing window keeps the one it is showing (which is what "go to
 * TripleC" means) and a new window starts a new chat.
 */
function openProject({ cwd, project, sessionId, title, fresh = false }) {
  const existing = panes.get(paneKey(cwd));
  const pane = existing || makePane({ cwd, project, sessionId, title });
  // Keep the name fresh: a tab restored from localStorage knows only what was
  // saved, and the list is authoritative about what a project is called.
  if (project) pane.project = project;
  if (existing) {
    // A named conversation moves the window to it; an explicit "new chat" empties
    // it. Neither stops what was there.
    if (sessionId && sessionId !== pane.sessionId) {
      showConversation(pane, { sessionId, title });
      return pane;
    }
    if (fresh && pane.sessionId) {
      showConversation(pane, { sessionId: null, title: null });
      return pane;
    }
  }
  activatePane(pane);
  return pane;
}

/**
 * Open a specific conversation, in its project's window.
 *
 * This is what a row in the list does. The project is the tab; the conversation is
 * what the tab is showing. Tapping a chat in a project that is already open moves
 * that window to it rather than opening a seventh tab.
 */
function openConversation({ cwd, project, sessionId, title }) {
  return openProject({ cwd, project, sessionId, title });
}

/**
 * Change which conversation a window is showing.
 *
 * The socket and the thread belong to the conversation, not to the tab, so both
 * are torn down and rebuilt — the same teardown `coolPane` does, then the same
 * join a cold tab does. Deliberately *not* a stop: the conversation being left
 * keeps running on the box, so this says so when it was working, because a chat
 * disappearing from the window while it is still spending money is exactly the
 * thing the user has to be able to trust.
 */
function showConversation(pane, { sessionId = null, title } = {}) {
  if (pane.closed) return pane;
  const sameChat = (sessionId || null) === (pane.sessionId || null);
  if (sameChat && !pane.cold) {
    activatePane(pane);
    return pane;
  }

  // The composer belongs to the conversation being left, not to the tab. Flush it
  // to disk under *that* conversation's key first, then clear it — in that order,
  // and `pane.draft` last of all, because `writeDraft` stashes the text on the pane
  // on its way out and `activatePane` restores from there. Clearing before the save
  // loses the draft; not clearing at all pastes it into the conversation arriving,
  // which is somebody's words in a chat they were not written for.
  if (pane === activePane()) {
    saveDraft({ now: true });
    input.value = '';
  }
  pane.draft = '';

  const leaving = pane.busy ? pane.title : null;
  teardownPane(pane);
  pane.sessionId = sessionId || null;
  pane.title = title || (sessionId ? 'Chat' : 'New chat');
  pane.named = Boolean(title);
  pane.busy = false;
  pane.trouble = false;
  pane.unread = false;
  pane.sub = 'connecting…';
  activatePane(pane);
  if (leaving) toast(`${leaving} keeps working — it's still in the list.`);
  return pane;
}

/** Put a pane on screen. The composer, the header and the draft follow it. */
function activatePane(pane) {
  if (!pane || pane.closed) return;
  const previous = activePane();
  if (previous && previous !== pane) {
    // The composer belongs to whichever pane is on screen, so what is in it goes
    // back to the pane being left — including a dictation in progress, which is
    // why the mic stops here rather than following the switch. Safe to reach
    // `voice` for the same reason `back()` can: this only runs from a tap or from
    // boot(), never during initialisation.
    if (voice.active) stopVoice();
    else hideDictationBar();
    saveDraft({ now: true });
    previous.draft = input.value;
  }

  state.activeKey = pane.key;
  pane.unread = false;
  pane.touchedAt = Date.now();

  // Belt and braces rather than relying on `previous`: with no pane active (after
  // going back to the list) there is nobody to take the class off.
  for (const el of document.querySelectorAll('#threads .thread.active')) {
    el.classList.remove('active');
  }
  if (!pane.thread) {
    pane.thread = document.createElement('div');
    pane.thread.className = 'thread';
    pane.thread.dataset.key = pane.key;
    $('#threads').appendChild(pane.thread);
  }
  pane.thread.classList.add('active');

  // The project is what the header names, because the project is what the tab is.
  // Which conversation you are in goes on its own line below the tabs, where it is
  // also the control for changing it.
  $('#chat-title').textContent = pane.project;
  // The tab says the same thing as the header, plus which deployment it belongs to.
  setTabTitle(pane.project);
  renderConvBar(pane);
  setSub(pane, pane.sub);
  setBusy(pane, pane.busy);
  input.value = pane.draft || '';
  autosize();
  // Whatever was typed here and not sent before the page last went away.
  restoreDraft(pane);
  renderTabs();
  show('chat');
  saveOpenPanes();
  if (pane.cold) reheat(pane);
  scrollDown(pane, true);
}

/**
 * Give a cold tab a socket again.
 *
 * Exactly what another device joining would do: connect, adopt the running
 * process if there is one, rebuild the thread from the server's history. That
 * path is the one this app has always used for a refresh, so a cooled tab is not
 * a new kind of state to get wrong.
 */
function reheat(pane) {
  if (!makeRoomFor(pane)) {
    toast(`${MAX_LIVE} chats are already working — this one makes ${MAX_LIVE + 1}.`);
  }
  pane.cold = false;
  pane.conversationId = null;
  pane.reconnectDelay = 500;
  connect(pane);
  renderTabs();
}

/**
 * Cool a pane down to a tab.
 *
 * Deliberately not a stop: the conversation keeps running on the box, which is
 * why coming back to it costs nothing but a reconnect. Killing it would be a
 * choice for /chat/admin to offer, not something a tab limit does quietly.
 */
function coolPane(pane) {
  teardownPane(pane);
  renderTabs();
}

/**
 * Drop everything that belongs to the conversation, keeping the tab.
 *
 * Shared by cooling (the tab stays, the conversation stays), closing (the tab
 * goes) and switching conversation inside a window (the tab stays, a different
 * conversation arrives). None of the three stops anything on the box.
 */
function teardownPane(pane) {
  pane.cold = true;
  pane.conversationId = null;
  const ws = pane.ws;
  pane.ws = null;
  try {
    ws?.close();
  } catch {
    /* already gone, which is the outcome anyway */
  }
  pane.thread?.remove();
  pane.thread = null;
  pane.toolEls.clear();
  pane.echoedMessages.clear();
  pane.streamingEl = null;
  pane.typingEl = null;
}

/**
 * Make room under the live cap, cooling the least recently used idle pane.
 *
 * Returns false when every other live pane is working. Cooling one of those would
 * be a lie — the tab would go quiet while the box was still spending on it — so
 * the cap is exceeded instead and the caller says so.
 */
function makeRoomFor(pane) {
  const live = () => [...panes.values()].filter((p) => !p.cold && !p.closed && p !== pane);
  while (live().length >= MAX_LIVE) {
    const idle = live()
      .filter((p) => !p.busy)
      .sort((a, b) => a.touchedAt - b.touchedAt)[0];
    if (!idle) return false;
    coolPane(idle);
  }
  return true;
}

/**
 * Close a tab.
 *
 * The conversation is not stopped: it stays in the list, stays on /chat/admin, and
 * keeps working if it was working. Nothing here can lose a turn, so nothing here
 * asks — the one thing worth saying is that closing was not stopping.
 */
function closePane(pane, { quiet = false } = {}) {
  const wasBusy = pane.busy;
  pane.closed = true;
  coolPane(pane);
  panes.delete(pane.key);
  if (wasBusy && !quiet) toast(`${pane.title} keeps working — reopen it from the list.`);
  closeChatsSheet();

  if (state.activeKey === pane.key) {
    state.activeKey = null;
    const next = [...panes.values()].pop();
    if (next) {
      activatePane(next);
      return;
    }
    renderTabs();
    renderConvBar(null);
    saveOpenPanes();
    if ($('#screen-chat').classList.contains('active')) back();
    return;
  }
  renderTabs();
  saveOpenPanes();
}

// --- tab strip ---------------------------------------------------------------
/*
 * Rebuilt only when the set of tabs changes. A conversation streaming tokens
 * updates its own chip through `paintChip`, because rebuilding this strip on every
 * delta would be a DOM teardown per word.
 */
function renderTabs() {
  const bar = $('#tabs');
  bar.innerHTML = '';
  const open = [...panes.values()];
  bar.classList.toggle('hidden', open.length === 0);

  for (const pane of open) {
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.dataset.key = pane.key;

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'chip-main';
    main.innerHTML = '<span class="chip-dot"></span><span class="chip-name"></span>';
    main.querySelector('.chip-name').textContent = pane.project;
    main.addEventListener('click', () => activatePane(pane));

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'chip-x';
    close.setAttribute('aria-label', `Close ${pane.project}`);
    close.textContent = '✕';
    close.addEventListener('click', () => closePane(pane));

    chip.append(main, close);
    bar.appendChild(chip);
    pane.chip = chip;
    paintChip(pane);
  }

  // The only way to open a second project from inside the first. Without it the
  // feature is reachable only by going back to the list, which is the flow tabs
  // exist to replace.
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'chip-add';
  add.setAttribute('aria-label', 'Open another project');
  add.textContent = '+';
  // `newChat: false` — this is "put another project on screen". A project already
  // open keeps the conversation it is showing rather than being emptied.
  add.addEventListener('click', () => showPicker({ newChat: false }));
  bar.appendChild(add);
}

/** One chip's state: which tab you are on, and what the others are doing. */
function paintChip(pane) {
  const chip = pane.chip;
  if (!chip) return;
  chip.classList.toggle('active', pane.key === state.activeKey);
  chip.classList.toggle('busy', pane.busy);
  chip.classList.toggle('cold', pane.cold);
  chip.classList.toggle('unread', pane.unread && pane.key !== state.activeKey);
  chip.classList.toggle('trouble', pane.trouble);
  chip.querySelector('.chip-name').textContent = pane.project;
}

// --- which conversation, inside a project's window ---------------------------
/*
 * One tab per project means changing conversation is a move *within* a tab, so it
 * needs a control of its own. This is it: a line under the tabs naming the chat on
 * screen, which opens the project's other chats.
 */
function renderConvBar(pane) {
  const bar = $('#conv-bar');
  if (!bar) return;
  bar.classList.toggle('hidden', !pane);
  if (!pane) return;
  $('#conv-name').textContent = pane.title;
  bar.setAttribute('aria-label', `Chat: ${pane.title}. Switch chats in ${pane.project}.`);
}

const chatsSheet = $('#chats-sheet');

function closeChatsSheet() {
  chatsSheet?.classList.add('hidden');
}
document
  .querySelectorAll('[data-close-chats]')
  .forEach((el) => el.addEventListener('click', closeChatsSheet));

$('#conv-bar')?.addEventListener('click', () => openChatsSheet());

$('#btn-new-in-project')?.addEventListener('click', () => {
  const pane = activePane();
  closeChatsSheet();
  // No title, deliberately: a title here would count as a name, and the first
  // message would then never replace it — leaving "New chat" on the switcher line
  // beside the project's other chats for the rest of the session.
  if (pane) showConversation(pane, { sessionId: null });
});

/**
 * The chats in the project on screen.
 *
 * Reads `/api/projects` on open, which is the one thing that may never be polled —
 * but this is a tap, and the point of the sheet is to be right about what exists.
 */
async function openChatsSheet() {
  const pane = activePane();
  if (!pane) return;
  $('#chats-sheet-title').textContent = pane.project;
  $('#chats-sheet-body').textContent = 'Loading…';
  chatsSheet.classList.remove('hidden');
  await refreshList();
  // Still the same window? A tap on a tab while this was in flight means the
  // answer below is about a project the user has already left.
  if (activePane() !== pane || chatsSheet.classList.contains('hidden')) return;

  const project = state.projects.find((p) => p.path === pane.cwd);
  const sessions = project?.sessions ?? [];
  const body = $('#chats-sheet-body');
  body.innerHTML = '';
  if (!sessions.length) {
    body.innerHTML = '<div class="empty">No past chats in this project yet.</div>';
    return;
  }

  for (const session of sessions) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'sheet-row';
    const current = session.sessionId === pane.sessionId;
    row.classList.toggle('current', current);
    const badge = session.busy ? 'working…' : session.live ? 'live' : '';
    row.innerHTML = `
      <div class="sheet-row-main">
        <div class="sheet-row-title">${escapeHtml(session.title)}</div>
        <div class="sheet-row-sub">${relTime(session.mtime)}
          ${badge ? `<span class="row-live${session.busy ? ' busy' : ''}">${badge}</span>` : ''}
          ${current ? '<span class="row-open">on screen</span>' : ''}
        </div>
      </div>`;
    row.addEventListener('click', () => {
      closeChatsSheet();
      if (!current) {
        showConversation(pane, { sessionId: session.sessionId, title: session.title });
      }
    });
    body.appendChild(row);
  }
}

/**
 * A background conversation reached the end of a turn.
 *
 * This is the payoff for having tabs at all: send a task in one chat, read
 * another, and find out when the first lands without going to look. Deliberately
 * a toast and a buzz rather than a web notification, even now that this app can
 * send those: a conversation in a tab of the app you are looking at does not need
 * the lock screen, and turn-watcher.js excludes these sessions for the same
 * reason. Notifications are for the sessions nobody is watching.
 */
function announce(pane, text) {
  pane.unread = true;
  paintChip(pane);
  // Named after the project, to match the chip that just lit up. The chat's own
  // title is on the switcher line once you get there; what this has to answer is
  // "which tab do I tap".
  toast(`${pane.project}: ${text}`);
  try {
    navigator.vibrate?.(120);
  } catch {
    /* iOS has no vibrate; the toast is the fallback */
  }
}

// --- chat -------------------------------------------------------------------
function connect(pane) {
  setSub(pane, 'connecting…');
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  pane.ws = ws;
  // Every handler below asks this first. A cooled or closed pane's socket is
  // still in flight for a moment, and a reconnect from it would be a second
  // process handle for a conversation this device is no longer showing.
  const stale = () => pane.ws !== ws || pane.closed;

  ws.addEventListener('open', () => {
    if (stale()) return;
    pane.reconnectDelay = 500;
    pane.trouble = false;
    paintChip(pane);
    if (pane.conversationId) {
      // Same page, same socket generation: the fast path.
      ws.send(JSON.stringify({ type: 'reattach', conversationId: pane.conversationId }));
    } else {
      // No process handle — a refresh, a cooled tab, or another device. `start`
      // with a session id adopts the running process if there is one, so this is
      // a join, not a restart. The thread is rebuilt from scratch, so clear it to
      // avoid duplicating what is already on screen.
      if (pane.sessionId) {
        if (pane.thread) pane.thread.innerHTML = '';
        pane.toolEls.clear();
        pane.streamingEl = null;
        pane.typingEl = null;
      }
      ws.send(JSON.stringify({
        type: 'start',
        cwd: pane.cwd,
        resumeSessionId: pane.sessionId,
        model: state.settings.model,
        permissionMode: state.settings.permissionMode,
        effort: state.settings.effort,
      }));
    }
  });

  ws.addEventListener('message', (e) => {
    if (stale()) return;
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    handleEvent(msg, pane);
  });

  // If the socket neither opens nor errors (captive portal, dead cell data),
  // give up rather than spin forever.
  const openTimer = setTimeout(() => {
    if (stale()) return;
    if (ws.readyState === WebSocket.CONNECTING) {
      setSub(pane, 'connection failed');
      pane.trouble = true;
      paintChip(pane);
      // Only the chat being looked at gets to interrupt. A background tab says it
      // on its own dot instead of talking over the conversation in front of you.
      if (pane === activePane()) toast("Couldn't reach the server — check your connection.");
      ws.close();
    }
  }, 15000);
  ws.addEventListener('open', () => clearTimeout(openTimer));

  ws.addEventListener('error', () => {
    if (!stale()) setSub(pane, 'connection error');
  });

  ws.addEventListener('close', () => {
    clearTimeout(openTimer);
    if (stale()) return;
    setSub(pane, 'reconnecting…');
    // The server keeps the claude process alive, so reattaching resumes the same
    // conversation — important when a phone locks mid-task.
    setTimeout(async () => {
      if (stale() || pane.cold) return;
      // Deliberately not gated on the chat screen being active: a background tab
      // has to stay connected, because being told when it finishes is the whole
      // reason it is still open. Gated on the page being visible instead — a
      // phone in a pocket must not retry in a loop — and `visibilitychange`
      // reconnects every live pane on the way back.
      if (document.visibilityState !== 'visible') return;
      // A rejected upgrade closes the socket with the same code as a dropped
      // network, so ask an authenticated route which one it was. Without this an
      // expired session shows "reconnecting…" forever with no way to sign in.
      try {
        const res = await fetch('/api/auth-check');
        if (res.status === 401) {
          redirectToLogin();
          return;
        }
      } catch {
        /* offline: fall through and retry, which is the right move */
      }
      connect(pane);
    }, pane.reconnectDelay);
    pane.reconnectDelay = Math.min(pane.reconnectDelay * 2, 8000);
  });
}

/**
 * Record the durable session id and make this device able to rejoin later.
 *
 * The tab is not re-keyed here, and that is the point of keying tabs by project:
 * a brand-new chat getting its name from the CLI used to rename its own pane,
 * which meant re-keying the map, the thread, the chip, the active key and the
 * draft, all in the moment the first reply arrived. Now only the *conversation*
 * gains a name, so the one thing that still has to move is the draft.
 */
function rememberSession(pane, sessionId) {
  if (!sessionId || sessionId === pane.sessionId) return;
  const previous = pane.sessionId;
  pane.sessionId = sessionId;
  // A draft is keyed by the conversation it was typed in, and a chat with no
  // session id yet has no name but its directory — so that is where the draft is.
  // A message typed before the first reply is the common case for a brand-new
  // chat, and getting this wrong orphans exactly that one.
  if (!previous) moveDraft(convKey(pane.cwd, null), convKey(pane.cwd, sessionId));
  saveOpenPanes();
}

function handleEvent(msg, pane) {
  switch (msg.type) {
    case 'ready':
      // Server acknowledged the socket; the start/reattach we sent on open is
      // in flight. Nothing to do but stop looking stalled.
      setSub(pane, 'starting…');
      return;

    case 'history':
      renderHistory(pane, msg.messages, msg.truncated);
      return;

    case 'attached':
      pane.conversationId = msg.conversationId;
      if (msg.sessionId) rememberSession(pane, msg.sessionId);
      setBusy(pane, msg.busy);
      if (!msg.busy) setSub(pane, 'ready');
      return;

    case 'session':
      // A new session's id arrives here; persist it so this chat is now
      // reachable from any other device and survives a refresh.
      rememberSession(pane, msg.sessionId);
      setSub(pane, pane.busy ? 'working…' : 'ready');
      return;

    case 'joined':
      // Attached to a process that was already running, possibly started on
      // another device. Reflect its real state rather than assuming idle.
      setBusy(pane, msg.busy);
      setSub(pane, msg.busy ? 'working…' : 'ready');
      return;

    case 'user_message':
      // Skip the server's echo of a message we already rendered locally.
      if (pane.echoedMessages.delete(msg.text)) return;
      addBubble(pane, 'user', msg.text);
      return;

    case 'delta':
      appendStream(pane, msg.text);
      return;

    case 'assistant_text':
      // The final text for a block; replaces whatever the deltas built so the
      // bubble matches the authoritative content exactly.
      finalizeStream(pane, msg.text);
      return;

    case 'tool_use':
      addToolCard(pane, msg);
      return;

    case 'tool_result':
      attachToolResult(pane, msg);
      return;

    case 'turn_complete':
      setBusy(pane, false);
      pane.streamingEl = null;
      setSub(pane, msg.costUsd ? `ready · $${msg.costUsd.toFixed(3)}` : 'ready');
      if (pane !== activePane()) announce(pane, 'finished');
      return;

    case 'interrupted':
      setBusy(pane, false);
      addBubble(pane, 'system', 'Stopped.');
      return;

    case 'error':
      setBusy(pane, false);
      addBubble(pane, 'error', msg.message);
      if (pane !== activePane()) announce(pane, msg.message);
      return;

    case 'exit':
      setBusy(pane, false);
      setSub(pane, 'session ended');
      pane.trouble = true;
      paintChip(pane);
      return;
  }
}

// --- rendering --------------------------------------------------------------
/*
 * Everything here takes the pane it draws into. Not a convenience: a background
 * conversation streams tokens into a thread that is not on screen, so "the
 * thread" and "the streaming bubble" cannot be things the module looks up.
 *
 * A pane being cooled has no thread at all, and its socket can still deliver a
 * frame or two before it closes, so each of these tolerates a missing one rather
 * than throwing inside a socket handler where nothing would catch it.
 */
function atBottom(pane) {
  const t = pane.thread;
  if (!t) return true;
  return t.scrollHeight - t.scrollTop - t.clientHeight < 120;
}
function scrollDown(pane, force) {
  const t = pane.thread;
  // Scroll position is meaningless for a thread nobody is looking at, and reading
  // scrollHeight on a display:none element is a layout for nothing.
  if (!t || pane.key !== state.activeKey) return;
  if (force || atBottom(pane)) t.scrollTop = t.scrollHeight;
}

/**
 * Render a resumed conversation in one pass.
 *
 * Built into a DocumentFragment and appended once: appending 400 bubbles
 * individually forces a layout per node, which locks up a phone long enough
 * that the UI looks broken and later messages never paint.
 */
function renderHistory(pane, messages, truncated) {
  if (!pane.thread) return;
  const frag = document.createDocumentFragment();

  if (truncated > 0) {
    const note = document.createElement('div');
    note.className = 'msg system';
    note.textContent = `${truncated} earlier message${truncated === 1 ? '' : 's'} not shown — Claude still has the full context`;
    frag.appendChild(note);
  }

  for (const m of messages) {
    if (m.type === 'user_message') {
      frag.appendChild(makeBubble('user', m.text));
    } else if (m.type === 'assistant_text') {
      frag.appendChild(makeBubble('claude', m.text));
    } else if (m.type === 'tool_use') {
      frag.appendChild(makeToolCard(pane, m, false));
    }
  }

  pane.thread.appendChild(frag);
  scrollDown(pane, true);
}

/** Build a bubble without touching the DOM tree. */
function makeBubble(kind, text) {
  const el = document.createElement('div');
  el.className = `msg ${kind}`;
  if (kind === 'claude') {
    el.innerHTML = renderMarkdown(text);
    // The controls for hearing it, and the raw markdown they read from — the
    // rendered HTML has lost the fences. See decorateSpoken.
    decorateSpoken(el, text);
  } else {
    el.textContent = text;
  }
  return el;
}

function addBubble(pane, kind, text) {
  if (!pane.thread) return null;
  const stick = atBottom(pane);
  const el = makeBubble(kind, text);
  pane.thread.appendChild(el);
  scrollDown(pane, stick);
  return el;
}

function appendStream(pane, text) {
  hideTyping(pane);
  if (!pane.thread) return;
  const stick = atBottom(pane);
  if (!pane.streamingEl) {
    pane.streamingEl = document.createElement('div');
    pane.streamingEl.className = 'msg claude';
    pane.streamingEl.dataset.raw = '';
    pane.thread.appendChild(pane.streamingEl);
  }
  pane.streamingEl.dataset.raw += text;
  pane.streamingEl.innerHTML = renderMarkdown(pane.streamingEl.dataset.raw);
  scrollDown(pane, stick);
}

function finalizeStream(pane, text) {
  hideTyping(pane);
  if (pane.streamingEl) {
    pane.streamingEl.innerHTML = renderMarkdown(text);
    // Only now, on the final text: the controls would be rebuilt on every delta
    // otherwise, and a block button on a half-written fence reads half a block.
    decorateSpoken(pane.streamingEl, text);
    pane.streamingEl = null;
  } else {
    addBubble(pane, 'claude', text);
  }
  scrollDown(pane, false);
}

const TOOL_ICONS = {
  Read: '📖', Write: '✏️', Edit: '✏️', Bash: '❯', Glob: '🔍', Grep: '🔍',
  WebFetch: '🌐', WebSearch: '🌐', Task: '🤖', TodoWrite: '☑️', NotebookEdit: '📓',
};

function toolSummary(name, input) {
  if (!input) return '';
  if (input.file_path) return input.file_path.replace(/^\/workspace\/projects\/[^/]+\//, '');
  if (input.command) return input.command;
  if (input.pattern) return input.pattern;
  if (input.url) return input.url;
  if (input.query) return input.query;
  if (input.description) return input.description;
  return '';
}

/** Build a tool card. `track` registers it so a later result can attach. */
function makeToolCard(pane, { id, name, input }, track = true) {
  const card = document.createElement('div');
  card.className = 'tool';
  card.innerHTML = `
    <div class="tool-head">
      <span class="tool-icon">${TOOL_ICONS[name] || '🔧'}</span>
      <span class="tool-name">${escapeHtml(name)}</span>
      <span class="tool-arg">${escapeHtml(toolSummary(name, input))}</span>
      <span class="tool-chev">›</span>
    </div>
    <div class="tool-body">
      <pre>${escapeHtml(JSON.stringify(input, null, 2))}</pre>
    </div>`;
  card.querySelector('.tool-head').addEventListener('click', () => card.classList.toggle('open'));
  if (track && id) pane.toolEls.set(id, card);
  return card;
}

function addToolCard(pane, msg) {
  hideTyping(pane);
  // A tool call ends the current text block.
  pane.streamingEl = null;
  if (!pane.thread) return;

  const stick = atBottom(pane);
  pane.thread.appendChild(makeToolCard(pane, msg));
  scrollDown(pane, stick);
}

function attachToolResult(pane, { toolUseId, content, isError }) {
  const card = pane.toolEls.get(toolUseId);
  if (!card) return;
  if (isError) card.classList.add('failed');
  const body = card.querySelector('.tool-body');
  const pre = document.createElement('pre');
  pre.textContent = content || '(no output)';
  body.appendChild(pre);
  if (isError) card.classList.add('open');
}

function showTyping(pane) {
  if (pane.typingEl || !pane.thread) return;
  pane.typingEl = document.createElement('div');
  pane.typingEl.className = 'typing';
  pane.typingEl.innerHTML = '<span></span><span></span><span></span>';
  pane.thread.appendChild(pane.typingEl);
  scrollDown(pane, true);
}
function hideTyping(pane) {
  pane.typingEl?.remove();
  pane.typingEl = null;
}

/**
 * Whether this conversation is working, which is now two different UIs: the
 * send/stop button for the pane on screen, and a dot on the tab for the ones that
 * are not. The pane's own flag is what both read, and what the tab strip and the
 * cooling policy consult later.
 */
function setBusy(pane, busy) {
  pane.busy = busy;
  paintChip(pane);
  if (pane.key === state.activeKey) {
    $('#btn-send').classList.toggle('hidden', busy);
    $('#btn-stop').classList.toggle('hidden', !busy);
  }
  if (busy) {
    setSub(pane, 'working…');
    showTyping(pane);
  } else {
    hideTyping(pane);
  }
}

/**
 * The line under the title. Remembered on the pane whether or not it is on
 * screen, so switching back shows this conversation's state rather than the last
 * thing any conversation said.
 */
function setSub(pane, text) {
  pane.sub = text;
  if (pane.key !== state.activeKey) return;
  const el = $('#chat-sub');
  el.textContent = text;
  el.classList.toggle('busy', text === 'working…');
}

/*
 * A message, split into prose and fenced code in the order it was written.
 *
 * One scanner with one result, shared by the renderer and by the read-aloud
 * controls, because the nth `<pre>` on screen has to be the block the nth button
 * reads. Two parsers that agree today are not a promise about tomorrow — and the
 * obvious shortcut here is wrong in a way that looks right: splitting on a fence
 * regex with a capture group yields [prose, lang, code, '', prose, …], because the
 * *closing* fence captures too, so stepping in threes reads a language tag as code
 * from the second block onwards.
 *
 * A fence that is never closed is a message still arriving, which is the normal
 * state of a transcript being watched while it is written: it is code to the end of
 * what has come so far.
 */
const FENCE_OPEN = /^[ \t]{0,3}```/;
const FENCE_CLOSE = /^[ \t]{0,3}```[ \t]*$/;

function splitFences(text) {
  const src = String(text ?? '');
  const lines = src.split('\n');
  const parts = [];
  let i = 0;
  let offset = 0;     // where lines[i] begins in src
  let prose = 0;      // where the prose being collected begins
  const advance = () => { offset += lines[i].length + 1; i += 1; };
  while (i < lines.length) {
    if (!FENCE_OPEN.test(lines[i])) { advance(); continue; }
    // The prose ends at the fence line, so the newline that ended the line before it
    // stays with the prose — this is `pre-wrap` text and those newlines are layout.
    if (offset > prose) parts.push({ type: 'prose', text: src.slice(prose, offset) });
    const lang = lines[i].replace(FENCE_OPEN, '').trim().replace(/[^\w+#.-]/g, '').slice(0, 20);
    advance();
    const start = offset;
    while (i < lines.length && !FENCE_CLOSE.test(lines[i])) advance();
    // `offset - 1` drops the newline that ends the last line of the body; an
    // unterminated block runs to the end of what has arrived.
    const end = i < lines.length ? Math.max(start, offset - 1) : src.length;
    parts.push({ type: 'code', lang, text: src.slice(start, end) });
    if (i < lines.length) advance();                                // the closing fence
    prose = offset;
  }
  if (prose < src.length) parts.push({ type: 'prose', text: src.slice(prose) });
  return parts;
}

/** Tiny markdown subset: fenced code, inline code, bold. Enough for chat. */
function renderMarkdown(text) {
  return splitFences(text)
    .map((part) => {
      if (part.type === 'code') return `<pre><code>${escapeHtml(part.text)}</code></pre>`;
      return escapeHtml(part.text)
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    })
    .join('');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function relTime(ms) {
  const secs = Math.floor((Date.now() - ms) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 604800) return `${Math.floor(secs / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}

// --- composer ---------------------------------------------------------------
const input = $('#input');

function autosize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
}

/*
 * Drafts survive the page going away, because the page going away is not this
 * app's decision. iOS discards a backgrounded tab and reloads it on return, the
 * editor surface reloads itself, and a phone browser can be killed for memory at
 * any time — and what was in the box was often several minutes of dictation or a
 * paragraph of code. None of that is recoverable afterwards, so it is written
 * down as it is typed.
 *
 * Scoped to the chat it was typed in, so a draft cannot reappear underneath a
 * different conversation, and dropped after a day so a forgotten one does not
 * ambush a chat months later.
 */
const DRAFT_PREFIX = 'claude-chat-draft:';
// The single-draft key this replaced. One composer served one chat, so there was
// one draft; now there is one per tab. Read once per pane so an upgrade
// mid-sentence does not drop what was in the box.
const LEGACY_DRAFT_KEY = 'claude-chat-draft';
const DRAFT_MAX_AGE = 24 * 60 * 60 * 1000;
let draftTimer = null;

// Keyed by conversation, not by tab: a draft belongs to the chat it was typed in,
// and one window shows several chats over its life.
function draftKeyFor(chat) {
  return `${DRAFT_PREFIX}${convKey(chat.cwd, chat.sessionId)}`;
}

function writeDraft() {
  clearTimeout(draftTimer);
  draftTimer = null;
  const pane = activePane();
  if (!pane) return;
  // Held on the pane as well as on disk: switching tabs is not a page load, and
  // the in-memory copy is what makes coming back instant.
  pane.draft = input.value;
  try {
    const key = draftKeyFor(pane);
    if (!input.value.trim()) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, JSON.stringify({
      cwd: pane.cwd,
      sessionId: pane.sessionId,
      text: input.value,
      at: Date.now(),
    }));
  } catch {
    /* private mode: a draft is a safety net, not a reason to break the composer */
  }
}

/** Follow a pane that has just been given its real session id. */
function moveDraft(fromKey, toKey) {
  try {
    const saved = localStorage.getItem(DRAFT_PREFIX + fromKey);
    localStorage.removeItem(DRAFT_PREFIX + fromKey);
    if (saved) localStorage.setItem(DRAFT_PREFIX + toKey, saved);
  } catch {
    /* private mode */
  }
}

function readDraft(chat) {
  try {
    const own = JSON.parse(localStorage.getItem(draftKeyFor(chat)) || 'null');
    if (own) return own;
    // A legacy draft has no pane to belong to, so it is claimed by directory and
    // then removed — it can only ever be adopted once.
    const legacy = JSON.parse(localStorage.getItem(LEGACY_DRAFT_KEY) || 'null');
    if (legacy?.cwd === chat.cwd) {
      localStorage.removeItem(LEGACY_DRAFT_KEY);
      return legacy;
    }
  } catch {
    return null;
  }
  return null;
}

// Debounced while typing — localStorage is synchronous and this is a phone — and
// flushed on the events that come immediately before the page is taken away.
function saveDraft({ now = false } = {}) {
  if (now) writeDraft();
  else if (!draftTimer) draftTimer = setTimeout(writeDraft, 400);
}

function restoreDraft({ cwd, sessionId }) {
  // Never overwrite something already in the box: switching tabs, or back and
  // into another chat, keeps what is in the composer, and that text is more
  // current than anything on disk.
  if (input.value) return false;
  const draft = readDraft({ cwd, sessionId });
  // The per-pane key already scopes this, so the checks below only bite for a
  // draft adopted from the single-draft era — but that one was written by a
  // different version of this file, so it is checked rather than trusted.
  if (!draft?.text?.trim() || draft.cwd !== cwd) return false;
  if (Date.now() - (draft.at || 0) > DRAFT_MAX_AGE) return false;
  // A draft saved before the CLI had assigned a session id belongs to whichever
  // chat this directory opens next, so only a *known* mismatch is grounds to drop
  // it — otherwise the case this exists for (typed, never sent, page reloaded
  // before the first reply) is the one case it would miss.
  if (draft.sessionId && sessionId && draft.sessionId !== sessionId) return false;
  input.value = draft.text;
  autosize();
  toast('Restored the message you had not sent yet');
  return true;
}

input.addEventListener('input', () => {
  autosize();
  saveDraft();
});
// Both fire before an iOS app-switch or discard; `pagehide` also covers a
// reload, which is what the editor surface does to itself.
window.addEventListener('pagehide', () => saveDraft({ now: true }));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') saveDraft({ now: true });
});

input.addEventListener('keydown', (e) => {
  // Enter sends on desktop; Shift+Enter makes a newline. On phones the
  // on-screen keyboard's return key inserts a newline as usual.
  if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(min-width: 760px)').matches) {
    e.preventDefault();
    sendMessage();
  }
});

// How long a send will wait for a dictation still being punctuated. Long enough
// for the pass to land (~1-2s), short enough that a tap never looks ignored.
const POLISH_WAIT_MS = 3000;
let sending = false;

async function sendMessage() {
  if (!input.value.trim() || sending) return;
  // Sending is an explicit end to dictation, so this is a normal stop: no alarm.
  if (voice.active) stopVoice();

  // A dictation still being punctuated is worth a moment: the point of that pass
  // is that what gets sent is readable, and someone who dictates a message taps
  // send the instant they stop talking. Capped, because a slow model must never
  // hold a message the user has already decided to send — and never fatal: the
  // raw transcript is in the box either way.
  if (voice.polishing) {
    sending = true;
    try {
      await Promise.race([
        voice.polishing,
        new Promise((resolve) => setTimeout(resolve, POLISH_WAIT_MS)),
      ]);
    } finally {
      sending = false;
    }
  }

  const text = input.value.trim();
  if (!text) return;
  // The composer always belongs to the pane on screen. There is one of it, and
  // this is the only place that decides which conversation a message goes to.
  const pane = activePane();
  if (!pane) return;
  hideDictationBar();
  if (pane.ws?.readyState !== WebSocket.OPEN) {
    toast('Still connecting — try again in a second.');
    return;
  }
  pane.ws.send(JSON.stringify({ type: 'message', text }));
  // Name the conversation after its first message, which is what the list will
  // call it once the transcript exists. Without this the switcher line above says
  // "New chat" for the rest of the session, and a project with two chats in it
  // gives the user nothing to tell them apart by.
  if (!pane.named) {
    pane.named = true;
    pane.title = text.length > 60 ? `${text.slice(0, 57)}…` : text;
    renderConvBar(pane);
    saveOpenPanes();
  }
  // Echo immediately. The server also echoes it back, but waiting for that
  // round trip makes a slow connection look like the tap did nothing.
  addBubble(pane, 'user', text);
  pane.echoedMessages.add(text);
  input.value = '';
  autosize();
  // It is on its way to the server now, so the draft has done its job. Written
  // through immediately rather than debounced: a reload a moment later must not
  // put a sent message back in the box.
  saveDraft({ now: true });
  setBusy(pane, true);
}

$('#btn-send').addEventListener('click', sendMessage);
$('#btn-stop').addEventListener('click', () => {
  activePane()?.ws?.send(JSON.stringify({ type: 'interrupt' }));
});

// --- voice ------------------------------------------------------------------
/**
 * Live dictation, Cursor-style: words appear in the box while you speak.
 *
 * Primary path is the browser's own streaming recognizer (SpeechRecognition),
 * which is what Cursor and ChatGPT use — it emits interim results mid-utterance,
 * so there's no wait and no server round trip.
 *
 * Where that isn't available (or it errors), fall back to recording audio and
 * transcribing on the server with whisper.cpp. That path can't be live — you get
 * the text when you stop — but it always works.
 *
 * Both paths insert at the cursor and leave the caret after the inserted text,
 * so you can dictate into the middle of a message and keep going.
 */
const micBtn = $('#btn-mic');
const micResetBtn = $('#btn-mic-reset');
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

/**
 * Which dictation engine to use.
 *
 * `stream` is the good one — audio cut at silence and transcribed phrase by
 * phrase on the box (see startStreamingDictation). It needs WebAudio and a
 * microphone, which is everything this app runs on, so the others are genuine
 * fallbacks rather than alternatives: `live` is the browser's own recognizer,
 * kept because it needs no server at all, and `record` transcribes only on stop.
 */
function pickDictationMode() {
  const hasAudio = Boolean(
    navigator.mediaDevices?.getUserMedia &&
    (window.AudioContext || window.webkitAudioContext),
  );
  if (hasAudio) return 'stream';
  return SpeechRecognition ? 'live' : 'record';
}

const voice = {
  mode: pickDictationMode(),
  active: false,
  recognition: null,
  recorder: null,
  chunks: [],
  stream: null,
  // Where the dictated text is being written, so interim results can be
  // rewritten in place as the recognizer revises them.
  anchor: 0,
  committed: '',
  startedAt: 0,
  // Set to true from the moment a start is requested until the recognizer or
  // recorder is actually running. `active` alone cannot guard the mic button:
  // starting is async (getUserMedia prompts), so a second tap in that window
  // used to open a second recorder feeding the same chunk list — which is heard
  // as the sentence being dictated twice.
  starting: false,
  // Set when dictation was taken away, so Resume continues from where it
  // stopped writing rather than from the caret. `input.selectionStart` cannot
  // answer this: it is always a number, never null, so the `??` fallback below
  // never fires, and an unfocused textarea happily reports 0 — which put resumed
  // text at the *start* of the box and pushed the earlier dictation behind it.
  // Deliberately a flag and not a position: the position is read when Resume is
  // tapped, which on the streaming path can be after further phrases have
  // landed, so a number banked at stop time would already be stale.
  resumeFromEnd: false,

  // --- streaming path (see startStreamingDictation) ---
  audioCtx: null,
  nodes: null,
  sampleRate: 16000,
  // Phrases captured but not yet transcribed, and whether the pump is running.
  queue: [],
  pumping: false,
  // The transcript so far: a concatenation of completed phrases. Unlike the
  // browser recognizer's output this is never revised, only appended to.
  finalText: '',
  // Cuts the phrase currently being captured. Set while the graph is live.
  cutPhrase: null,
  dropped: 0,
  // An interruption is announced only after the queue drains, so the banner
  // does not claim dictation ended while text is still arriving.
  pendingReason: null,
  // The cleanup pass over the finished dictation, while it is in flight. Kept on
  // `voice` rather than in a closure because sending has to wait for it: the
  // whole point is that the message goes out punctuated.
  polishing: null,

  // Which dictation the state above belongs to. Bumped by `resetDictation`, and
  // read by everything that resumes after an `await` — a phrase being
  // transcribed, a cleanup pass, a `getUserMedia` still sitting on a permission
  // prompt. None of those can be cancelled, so a reset that only cleared the
  // fields would be quietly undone a second later when one of them landed and
  // wrote its result into a dictation that no longer exists.
  generation: 0,
};

function setMicState(state) {
  micBtn.classList.toggle('recording', state === 'recording');
  micBtn.classList.toggle('working', state === 'working');
  $('#composer').classList.toggle('listening', state === 'recording');
}

// --- keeping the screen awake ------------------------------------------------
/**
 * The phone's display sleeps on its idle timer, and this app is used in long
 * stretches where nobody is touching the screen: dictating a paragraph, watching
 * a task run for two minutes, reading a long answer. When the display sleeps the
 * page is hidden, and hiding the page suspends the recognizer and freezes the
 * socket — so the idle timer is not a cosmetic annoyance, it ends whatever was in
 * flight. Dictation was the loudest symptom; it was never the only one.
 *
 * So the lock is held for as long as the app is open and in front, not just while
 * dictating. Three properties of the Screen Wake Lock API drive the shape of this:
 *
 *  - It needs a *visible* document. Requesting while hidden rejects.
 *  - The browser releases it automatically the moment the page is hidden, and
 *    never re-acquires it. Every return to the foreground must re-request.
 *  - The OS revokes it whenever it likes — battery saver, a low battery, policy —
 *    and there is no event that says "you may have it back". The only way to
 *    notice is to keep asking.
 *
 * Hence one `syncWakeLock()` that reconciles held against wanted, called from
 * every event that can change either, plus a slow timer for the revocation case.
 *
 * What no web API can do: keep the display on once the user leaves the app or
 * presses the power button. That is the OS's decision and the page is not
 * consulted. `alertDictationStopped()` exists for exactly that residue.
 */
const KEEP_AWAKE_KEY = 'claude-keep-awake';
// Checked on use rather than cached at load: it is one property lookup, and a
// cached answer is wrong in exactly the case that matters — a document where the
// API arrives late, which is also how the tests can reach this code at all.
const keepAwakeSupported = () => 'wakeLock' in navigator && Boolean(navigator.wakeLock);
// Deliberately its own localStorage key rather than a field in the settings blob:
// the editor overlay is the same origin and reads this too, so one switch covers
// both surfaces, and neither writer can clobber the other's keys.
let keepAwakeWanted = (() => {
  try {
    return localStorage.getItem(KEEP_AWAKE_KEY) !== '0';
  } catch {
    return true;
  }
})();

let wakeLock = null;
let wakeLockPending = false;
let wakeLockTicker = null;

function wakeLockHeld() {
  return Boolean(wakeLock);
}

/**
 * Dictation holds the screen even when the setting is off. Turning the setting
 * off means "don't burn my battery while I read", not "cut me off mid-sentence".
 */
function wantsScreenAwake() {
  return keepAwakeWanted || voice.active;
}

async function syncWakeLock() {
  if (!wantsScreenAwake() || document.visibilityState !== 'visible') {
    releaseWakeLock();
    return false;
  }
  if (wakeLock) return true;
  if (!keepAwakeSupported() || wakeLockPending) return false;

  wakeLockPending = true;
  try {
    const lock = await navigator.wakeLock.request('screen');
    // The await is not free: the page can be hidden, or the setting switched off,
    // between asking and being granted. Don't keep a lock nobody wants any more.
    if (!wantsScreenAwake() || document.visibilityState !== 'visible') {
      try { lock.release?.(); } catch { /* nothing to undo */ }
      return false;
    }
    wakeLock = lock;
    // Fires for the OS revoking it as well as for our own release. Drop the
    // handle either way, so the next sync re-requests instead of trusting a
    // dead one — and repaint, because the status bar promises the screen is held.
    lock.addEventListener?.('release', () => {
      if (wakeLock === lock) wakeLock = null;
      if (voice.active) renderListening();
    });
    if (voice.active) renderListening();
    return true;
  } catch {
    // Hidden, unsupported for this document, or refused by the OS. The periodic
    // sync will try again; a refusal now is not a refusal forever.
    return false;
  } finally {
    wakeLockPending = false;
  }
}

function releaseWakeLock() {
  const held = wakeLock;
  wakeLock = null;
  try {
    held?.release?.();
  } catch {
    /* already released */
  }
}

function setKeepAwake(on) {
  keepAwakeWanted = Boolean(on);
  try {
    localStorage.setItem(KEEP_AWAKE_KEY, keepAwakeWanted ? '1' : '0');
  } catch {
    /* private mode: the choice holds for this page's lifetime */
  }
  syncWakeLock();
}

/**
 * Re-request on everything that could plausibly restore eligibility. These are
 * cheap — `syncWakeLock` is a no-op when the lock is already held — and between
 * them they cover the cases a single hook misses: coming back to the foreground,
 * a bfcache restore, and an OS revocation that has since been lifted.
 */
function startKeepAwake() {
  document.addEventListener('visibilitychange', syncWakeLock);
  window.addEventListener('pageshow', syncWakeLock);
  window.addEventListener('focus', syncWakeLock);
  clearInterval(wakeLockTicker);
  wakeLockTicker = setInterval(syncWakeLock, 30_000);
  syncWakeLock();
}

/**
 * An AudioContext created during the mic tap — a user gesture — can still play
 * sound later without one. That is what lets the "dictation stopped" beep be
 * audible at the exact moment the user is not touching the phone.
 */
let alertCtx = null;
function primeAlertSound() {
  try {
    alertCtx = alertCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (alertCtx.state === 'suspended') alertCtx.resume();
  } catch {
    alertCtx = null;
  }
}

/** Beep and buzz: with the display off, these are the only channels left. */
function alertDictationStopped() {
  try {
    navigator.vibrate?.([140, 90, 140]);
  } catch {
    /* not supported; the beep and the banner still are */
  }
  if (!alertCtx || alertCtx.state !== 'running') return;
  try {
    const now = alertCtx.currentTime;
    const osc = alertCtx.createOscillator();
    const gain = alertCtx.createGain();
    osc.frequency.value = 660;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.3, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);
    osc.connect(gain).connect(alertCtx.destination);
    osc.start(now);
    osc.stop(now + 0.45);
  } catch {
    /* audio is a nicety, not the notification of record */
  }
}

const dictationBar = $('#dictation-bar');
const dictationText = $('#dictation-text');
const dictationUndo = $('#btn-dictation-undo');
const dictationResume = $('#btn-dictation-resume');
const dictationDismiss = $('#btn-dictation-dismiss');
let listeningTicker = null;

// What a reset cleared out of the composer, while Undo is still on offer, and the
// timer that withdraws it. One slot only: a second reset means the first was not
// the mistake.
let resetUndo = null;
let resetUndoTimer = null;
// Long enough to read the bar and change your mind, short enough that the offer is
// not still standing over a dictation done since.
const RESET_UNDO_MS = 15000;

/** Withdraw the Undo offer, because the bar is about to say something else. */
function clearResetOffer() {
  clearTimeout(resetUndoTimer);
  resetUndoTimer = null;
  resetUndo = null;
  dictationUndo.classList.add('hidden');
}

function renderListening() {
  if (!voice.active) return;
  const secs = Math.max(0, Math.floor((Date.now() - voice.startedAt) / 1000));
  const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  // Phrases waiting on the transcriber. Shown because text arriving a beat after
  // the words are spoken is the one surprise of this dictation path, and a
  // visible backlog explains the delay instead of looking like a stall.
  const behind = voice.queue.length + (voice.pumping ? 1 : 0);
  const lag = behind ? ` · transcribing ${behind}` : '';
  // The elapsed clock is the liveness proof: a frozen number means a dead
  // recognizer, which is readable at a glance in a way a static label is not.
  dictationText.textContent = wakeLockHeld()
    ? `Listening… ${clock}${lag}`
    : `Listening… ${clock}${lag} · screen may sleep and cut this off`;
}

/**
 * Dictation has ended but its last phrases are still being transcribed. Held
 * separate from the stopped banner so the bar never claims dictation is over
 * while words are still landing in the box.
 */
function showDictationDraining(reason) {
  clearInterval(listeningTicker);
  clearResetOffer();
  dictationBar.className = `dictation-bar ${reason ? 'stopped' : 'listening'}`;
  dictationResume.classList.add('hidden');
  dictationDismiss.classList.add('hidden');
  dictationText.textContent = reason
    ? `Dictation stopped — ${reason}. Transcribing what was captured…`
    : 'Transcribing the last of it…';
}

function showListening() {
  clearResetOffer();
  dictationBar.className = 'dictation-bar listening';
  dictationResume.classList.add('hidden');
  dictationDismiss.classList.add('hidden');
  renderListening();
  clearInterval(listeningTicker);
  listeningTicker = setInterval(renderListening, 1000);
}

/** The banner the user finds when they pick the phone back up. */
function showDictationStopped(reason) {
  clearInterval(listeningTicker);
  clearResetOffer();
  dictationBar.className = 'dictation-bar stopped';
  dictationText.textContent = `Dictation stopped — ${reason}. What you said so far is kept.`;
  dictationResume.classList.remove('hidden');
  dictationDismiss.classList.remove('hidden');
}

function hideDictationBar() {
  clearInterval(listeningTicker);
  clearResetOffer();
  dictationBar.className = 'dictation-bar hidden';
  dictationResume.classList.add('hidden');
  dictationDismiss.classList.add('hidden');
}

/**
 * What a reset did, and the way back from it.
 *
 * No modifier class on the bar: this is an acknowledgement rather than a state, so
 * it gets neither the blinking dot that means a live microphone nor the red tint
 * that means something was taken away.
 */
function showDictationReset(wiped) {
  clearInterval(listeningTicker);
  clearResetOffer();
  dictationBar.className = 'dictation-bar';
  dictationResume.classList.add('hidden');
  dictationDismiss.classList.remove('hidden');
  dictationText.textContent = wiped.trim()
    ? 'Dictation reset — mic released, transcript forgotten, box cleared.'
    : 'Dictation reset — mic released, transcript forgotten.';
  if (wiped.trim()) {
    resetUndo = wiped;
    dictationUndo.classList.remove('hidden');
  }
  // Clears the offer with it, so the text is not restorable once the bar is gone.
  resetUndoTimer = setTimeout(hideDictationBar, wiped.trim() ? RESET_UNDO_MS : 4000);
}

/**
 * Append a recognizer phrase to `acc`, dropping any leading words that repeat
 * what `acc` already ends with.
 *
 * Two separate things go wrong with the raw transcripts on mobile Safari, and
 * both look like duplication. Chunks carry no guaranteed separator, so
 * "sounds" followed by "sounds" concatenates to "soundssounds"; and the
 * recognizer re-delivers phrases it has already finalised, sometimes as an
 * extra entry in the same results list, sometimes at the start of the next
 * session. Rebuilding from `results` fixes the second only when the repeat
 * lands in the list we re-read — it can't help when the repeat spans a session
 * boundary.
 *
 * Comparing the incoming words against the tail already accumulated catches
 * every variant, whatever produced it, and joining on a space fixes the
 * gluing. Deliberate immediate repetition ("very very") is the cost: a real
 * doubled word gets collapsed. That trades a rare, easily retyped loss for a
 * bug that made dictation unusable.
 */
function appendPhrase(acc, phrase) {
  const head = acc.trim().split(/\s+/).filter(Boolean);
  const tail = phrase.trim().split(/\s+/).filter(Boolean);
  if (!tail.length) return head.join(' ');

  // Longest word-aligned overlap wins, so a repeat of several words collapses
  // in one step rather than leaving a partial echo behind.
  for (let n = Math.min(head.length, tail.length); n > 0; n--) {
    const end = head.slice(head.length - n).join(' ').toLowerCase();
    const start = tail.slice(0, n).join(' ').toLowerCase();
    if (end === start) {
      tail.splice(0, n);
      break;
    }
  }
  return [...head, ...tail].join(' ');
}

/**
 * Where the next dictation should be written.
 *
 * Normally the caret, so dictation lands where you were typing. After an
 * interruption it is where that dictation stopped: the banner deliberately does
 * not focus the composer (the keyboard would cover it), so by the time Resume is
 * tapped the caret is not a trustworthy answer.
 */
function nextDictationAnchor() {
  const end = input.value.length;
  if (voice.resumeFromEnd) {
    voice.resumeFromEnd = false;
    return Math.min(voice.anchor + voice.committed.length, end);
  }
  return Math.min(input.selectionStart ?? end, end);
}

/** Replace the interim span with `text`, keeping the caret after it. */
function writeDictation(text) {
  const before = input.value.slice(0, voice.anchor);
  const after = input.value.slice(voice.anchor + voice.committed.length);
  const needsSpaceBefore = before && !/\s$/.test(before);
  const body = (needsSpaceBefore ? ' ' : '') + text;

  input.value = before + body + after;
  voice.committed = body;

  const caret = voice.anchor + body.length;
  input.setSelectionRange(caret, caret);
  input.dispatchEvent(new Event('input'));
}

async function startLiveDictation() {
  const rec = new SpeechRecognition();
  rec.continuous = true;
  rec.interimResults = true;   // this is what makes text appear while speaking
  rec.lang = navigator.language || 'en-US';

  voice.anchor = nextDictationAnchor();
  voice.committed = '';

  /*
   * Rebuild from `event.results` every event instead of accumulating.
   *
   * This used to do `finalText += chunk` from `event.resultIndex`. On mobile
   * Safari the recognizer re-delivers phrases it has already finalised, with
   * resultIndex back at the start, so each event appended the whole transcript
   * so far again — "okay", then "okay let's", then "okay let's test", giving
   * `okayokay let'sokay let's test`. The growing-prefix shape and the missing
   * separators are both signatures of that append.
   *
   * `results` is authoritative for the current session, so read it whole.
   * Finals from earlier sessions live in `priorSessions`, which only grows in
   * onend — before the restart wipes the list.
   */
  let priorSessions = '';
  let sessionFinal = '';
  // Restart timestamps. A recognizer that ends the instant it starts will do so
  // forever, which reads as "dictation is on" while nothing is being heard, and
  // quietly drains the battery. Counting the restarts is how that is caught.
  let restarts = [];

  rec.onresult = (event) => {
    // A recognizer that has been replaced or reset still delivers one last result;
    // writing it would put the old dictation's words back into the box.
    if (voice.recognition !== rec) return;
    let finals = '';
    let interim = '';
    for (let i = 0; i < event.results.length; i++) {
      const chunk = event.results[i][0].transcript;
      if (event.results[i].isFinal) finals = appendPhrase(finals, chunk);
      else interim = appendPhrase(interim, chunk);
    }
    sessionFinal = finals;
    const joined = appendPhrase(appendPhrase(priorSessions, finals), interim);
    writeDictation(joined.replace(/\s+/g, ' ').trimStart());
  };

  rec.onerror = (event) => {
    if (voice.recognition !== rec) return;
    // no-speech and aborted are normal; anything else means fall back.
    if (event.error === 'no-speech' || event.error === 'aborted') return;
    console.warn('speech recognition error:', event.error);
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      toast('Microphone permission denied.');
      stopVoice({ reason: 'the microphone was blocked' });
      return;
    }
    // network / language-not-supported: use the server instead, this attempt on.
    toast('Live dictation unavailable — using server transcription.');
    voice.mode = 'record';
    stopVoice({ reason: `the recognizer failed (${event.error})` });
  };

  rec.onend = () => {
    // Not `voice.active` alone: a reset leaves this recognizer's own `abort` to
    // fire, and restarting here would put the microphone straight back on.
    if (voice.recognition === rec && voice.active) {
      // Mobile Safari ends the session on brief pauses; restart to keep going.
      // Commit this session's finals first — the new session starts with an
      // empty `results` list, so anything not banked here is lost.
      if (sessionFinal.trim()) {
        priorSessions = appendPhrase(priorSessions, sessionFinal);
        sessionFinal = '';
      }
      const now = Date.now();
      restarts = [...restarts, now].filter((t) => now - t < 20_000);
      if (restarts.length > 10) {
        stopVoice({ reason: 'the recognizer would not stay running' });
        return;
      }
      try {
        rec.start();
      } catch {
        stopVoice({ reason: 'the recognizer would not restart' });
      }
    }
  };

  voice.recognition = rec;
  voice.active = true;
  voice.startedAt = Date.now();
  setMicState('recording');
  rec.start();
  // After start(), so a rejected lock does not stop dictation — it only changes
  // what the status bar promises about the screen. Usually already held, since
  // the app holds it whenever it is in front; this covers the setting being off.
  await syncWakeLock();
  if (voice.active) showListening();
}

async function startRecordingDictation() {
  const gen = voice.generation;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch (err) {
    toast(`Microphone blocked: ${err.message}`);
    return;
  }
  // Reset while the permission prompt was up: the mic was granted to a dictation
  // that no longer exists, so hand it straight back.
  if (gen !== voice.generation) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  voice.stream = stream;

  voice.anchor = nextDictationAnchor();
  voice.committed = '';

  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  const recorder = new MediaRecorder(voice.stream, mimeType ? { mimeType } : undefined);
  // Its own array, handed to `voice` rather than appended to a shared one: a
  // recorder that outlives its turn then fills a list nobody reads, instead of
  // interleaving a second copy of the same speech into the audio being uploaded.
  const chunks = [];
  voice.chunks = chunks;
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  recorder.onstop = transcribeRecording;
  recorder.start();

  voice.recorder = recorder;
  voice.active = true;
  voice.startedAt = Date.now();
  setMicState('recording');
  await syncWakeLock();
  if (voice.active) showListening();
}

/**
 * Stop dictating.
 *
 * `reason` is the difference between the user tapping the mic and dictation
 * being taken away from them. Without one this is a normal stop and the status
 * bar just disappears; with one, the stop gets announced — beep, buzz, and a
 * banner that stays put until it is acknowledged. Either way the dictated text
 * stays in the composer, because the recording is the only copy of it.
 */
function stopVoice({ reason = null } = {}) {
  const wasActive = voice.active;
  voice.active = false;
  // Reconcile rather than release outright: with "keep the screen awake" on, the
  // end of dictation is not a reason to let the display sleep.
  syncWakeLock();

  // Streaming: bank the phrase being spoken right now before dismantling the
  // audio graph, so the words up to an interruption are transcribed instead of
  // discarded — the same reason the recorder path stops by transcribing.
  if (voice.cutPhrase) {
    try {
      voice.cutPhrase();
    } catch {
      /* graph already gone */
    }
    teardownAudioGraph();
  }

  if (voice.recognition) {
    try {
      voice.recognition.stop();
    } catch {
      /* already stopped */
    }
    voice.recognition = null;
    // Don't pull focus on an unexpected stop: focusing the box raises the
    // keyboard, which on a phone can hide the banner explaining what happened.
    if (!reason) input.focus();
  }

  if (voice.recorder && voice.recorder.state !== 'inactive') {
    setMicState('working');
    // Stopping the recorder transcribes what it captured, so an interrupted
    // recording still yields the words spoken before the interruption.
    voice.recorder.stop();
  }

  // Phrases already captured are still being transcribed, so the mic stays in
  // its working state and the banner waits: saying "dictation stopped" while
  // words are still appearing would be its own kind of lie.
  const draining = voice.pumping || voice.queue.length > 0;
  setMicState(draining ? 'working' : 'idle');

  if (reason && wasActive) {
    // Resume should continue where this dictation stopped writing, because the
    // banner deliberately leaves the composer unfocused.
    voice.resumeFromEnd = true;
    alertDictationStopped();
    if (draining) {
      voice.pendingReason = reason;
      showDictationDraining(reason);
    } else {
      showDictationStopped(reason);
    }
  } else if (!reason) {
    voice.resumeFromEnd = false;
    if (draining) showDictationDraining(null);
    else hideDictationBar();
  }

  // Punctuate what was said, now that it is all here. Two cases are deliberately
  // not this one: phrases still in flight wait for `finishDictation`, so the pass
  // sees the whole message rather than everything up to the last sentence, and an
  // interrupted dictation is left alone because Resume continues it.
  if (wasActive && !reason && !draining) polishDictation();
}

/**
 * Release everything dictation holds, and forget everything it heard.
 *
 * Stopping dictation deliberately *keeps* state: the transcript is in the box, the
 * anchor says where it was written, a phrase may still be being transcribed, an
 * interruption may be waiting to be resumed. That is right nearly always — all of
 * it is text the user spoke and wants.
 *
 * It is wrong when a piece of it outlives the dictation it belonged to, because
 * then it reappears underneath the next one, and clearing the composer by hand
 * does not help: none of the state that puts it back is in the composer. This is
 * the escape hatch for that, and it is deliberately total rather than clever —
 * hardware released, engines dismantled, every field back to where it starts, the
 * composer and its saved draft cleared, and everything already in flight orphaned
 * by way of `voice.generation`, which is the half a reset cannot do by assignment.
 *
 * The text it clears is offered back as Undo, because several minutes of speech is
 * what tends to be in there and this button sits next to the mic.
 */
function resetDictation() {
  // Before anything else: from here on, every continuation still holding the old
  // generation knows its dictation is gone and writes nothing.
  voice.generation += 1;

  voice.active = false;
  // A start that is still awaiting the permission prompt is now orphaned rather
  // than merely un-flagged, so clearing this cannot let it through.
  voice.starting = false;

  if (voice.recognition) {
    try {
      // abort, not stop: stop delivers one last result, which is exactly the text
      // being thrown away here.
      if (voice.recognition.abort) voice.recognition.abort();
      else voice.recognition.stop();
    } catch {
      /* already stopped */
    }
    voice.recognition = null;
  }

  if (voice.recorder) {
    try {
      if (voice.recorder.state !== 'inactive') voice.recorder.stop();
    } catch {
      /* already stopped */
    }
    // Dropped before `onstop` runs, so the recording is discarded rather than
    // transcribed: transcribing it is what the user just asked not to happen.
    voice.recorder = null;
  }

  // Both the graph and the bare recorder path hold a microphone stream, and the
  // indicator in the phone's status bar stays lit until the tracks are stopped.
  teardownAudioGraph();
  voice.stream?.getTracks().forEach((t) => t.stop());
  voice.stream = null;

  voice.chunks = [];
  voice.queue = [];
  voice.pumping = false;
  voice.finalText = '';
  voice.committed = '';
  voice.anchor = 0;
  voice.dropped = 0;
  voice.pendingReason = null;
  voice.resumeFromEnd = false;
  voice.polishing = null;
  voice.startedAt = 0;
  // The engine choice is remade too: a fallback that was forced by one failed
  // recognizer should not outlive the dictation that hit it.
  voice.mode = pickDictationMode();

  setMicState('idle');

  const wiped = input.value;
  input.value = '';
  autosize();
  // Written through rather than debounced, and this is the half that makes the
  // reset survive a reload: a draft left on disk comes back on the next visit to
  // this chat, which is the haunting the button exists to end.
  writeDraft();
  // The mic is no longer a reason to hold the screen. The app being open still may
  // be, so reconcile rather than release.
  syncWakeLock();
  showDictationReset(wiped);
}

async function transcribeRecording() {
  const gen = voice.generation;
  voice.stream?.getTracks().forEach((t) => t.stop());
  voice.stream = null;

  const raw = new Blob(voice.chunks, { type: voice.recorder?.mimeType || 'audio/webm' });
  voice.recorder = null;

  try {
    let blob;
    try {
      blob = await toWav(raw);
    } catch (err) {
      // If decoding fails, send the original and let the server try.
      console.warn('wav conversion failed, uploading original:', err);
      blob = raw;
    }

    const form = new FormData();
    form.append('audio', blob, blob.type === 'audio/wav' ? 'recording.wav' : 'recording.webm');
    const res = await api('/api/transcribe', { method: 'POST', body: form });
    const data = await res.json();
    // Reset while this was uploading: the recording belongs to a dictation that has
    // been thrown away, so the transcript goes nowhere.
    if (gen !== voice.generation) return;
    if (!res.ok) throw new Error(data.error || 'transcription failed');

    writeDictation(cleanTranscript(data.text || ''));
    input.focus();
    // This path has the whole recording in one transcript, so the cleanup pass
    // can start the moment it lands.
    polishDictation();
  } catch (err) {
    toast(err.message);
  } finally {
    // The cleanup pass, if one started, owns the mic state until it finishes.
    if (!voice.polishing) setMicState('idle');
  }
}

/**
 * Decode whatever the browser recorded and re-encode as 16 kHz mono WAV.
 *
 * Browsers record webm/opus by default, and the on-server transcriber decodes
 * WAV/MP3/FLAC/Vorbis but not Opus. Rather than ship a codec server-side, let
 * the browser — which already has an Opus decoder — do the conversion. 16 kHz
 * mono is also exactly what Whisper wants, so this shrinks the upload too.
 */
async function toWav(blob) {
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const decoded = await audioCtx.decodeAudioData(await blob.arrayBuffer());

    const targetRate = 16000;
    const frames = Math.ceil(decoded.duration * targetRate);
    const offline = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(
      1, frames, targetRate,
    );
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const resampled = await offline.startRendering();
    return wavFromSamples(resampled.getChannelData(0), targetRate);
  } finally {
    audioCtx.close();
  }
}

/**
 * 16-bit PCM mono WAV from raw samples.
 *
 * Shared by the recorder path (which decodes a container first) and the
 * streaming path (which already holds raw samples), so there is one WAV writer
 * to get right rather than two.
 */
function wavFromSamples(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);            // PCM header size
  view.setUint16(20, 1, true);             // format: PCM
  view.setUint16(22, 1, true);             // channels
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);             // block align
  view.setUint16(34, 16, true);            // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

// --- streaming dictation: cut at silence, transcribe each phrase -------------
/**
 * The default dictation path, and the reason it exists.
 *
 * The browser's own recognizer (`SpeechRecognition`, still available below as a
 * fallback) ends its session on every natural pause and re-delivers phrases it
 * has already finalised. Keeping a running transcript therefore meant stitching
 * fragments together with a word-overlap heuristic, and every seam was a chance
 * to double or drop a word — which is what made dictation feel unreliable, and
 * what produced "let me let me" in real use. It also emits no punctuation.
 *
 * So do what a real dictation feature does: one decoder over the whole phrase.
 * Capture raw audio, watch its level, and cut only where the speaker paused.
 * Because every cut lands in silence, no word is ever split across two requests
 * and there are no seams to reconcile — the transcript is a concatenation of
 * independently-correct phrases rather than a reconstruction. Whisper also
 * punctuates and capitalises, which the browser recognizer never did.
 *
 * Cutting on silence rather than on a fixed timer is the whole trick. A 10s
 * timer would slice mid-word roughly whenever someone speaks in long sentences.
 */
const VAD = {
  // Speech/silence thresholds on frame RMS. Two levels, deliberately: rising
  // above `speech` starts a phrase, and only falling below `silence` ends one,
  // so a voice hovering at the boundary does not chop into fragments.
  speech: 0.012,
  silence: 0.006,
  // How much quiet ends a phrase. Long enough to sit through the pause between
  // words and a breath; short enough that text keeps up with the speaker.
  hangoverMs: 650,
  // Cut anyway past this, at the quietest point found, so one long unbroken
  // sentence still produces text instead of buffering to the end.
  maxPhraseMs: 14_000,
  // Below this, a "phrase" is a cough or a door. Whisper will happily invent
  // words for such things, so they are never sent.
  minPhraseMs: 320,
  frameMs: 32,
};

/** Append a transcribed phrase to the running text, spacing it sensibly. */
function joinPhrases(acc, phrase) {
  const next = phrase.trim();
  if (!next) return acc;
  if (!acc) return next;
  return `${acc.replace(/\s+$/, '')} ${next}`;
}

/**
 * Transcribe queued phrases one at a time.
 *
 * Single-flight on purpose. It bounds the load on a 2-vCPU box, and it makes
 * ordering free: phrases are appended in the order they were spoken because only
 * one request is ever outstanding. Transcription runs ~7x faster than realtime
 * here, so the queue drains while the next phrase is still being spoken.
 */
async function pumpDictationQueue() {
  if (voice.pumping) return;
  // The dictation these phrases belong to. A reset cannot cancel a request already
  // sent, so the answer to it has to be dropped on arrival instead — otherwise a
  // phrase from the dictation just thrown away lands in the composer a second
  // later, which is the thing the reset was for.
  const gen = voice.generation;
  voice.pumping = true;
  try {
    while (voice.queue.length) {
      const samples = voice.queue.shift();
      renderListening();
      try {
        const form = new FormData();
        form.append('audio', wavFromSamples(samples, voice.sampleRate), 'phrase.wav');
        const res = await api('/api/transcribe', { method: 'POST', body: form });
        if (gen !== voice.generation) return;
        const data = await res.json().catch(() => ({}));
        if (gen !== voice.generation) return;
        if (!res.ok) throw new Error(data.error || 'transcription failed');
        const phrase = cleanTranscript(data.text || '');
        if (phrase) {
          voice.finalText = joinPhrases(voice.finalText, phrase);
          writeDictation(voice.finalText);
        }
      } catch (err) {
        // A phrase the transcriber heard nothing in is not a failure: chunked
        // dictation sends it far more marginal audio than one long recording
        // does, and counting those would nag about every throat-clear.
        if (/no speech/i.test(err.message || '')) continue;
        // A real failure must not discard the rest of the dictation, and must
        // not be silent either — a gap in the text with no explanation is the
        // failure mode this whole feature exists to avoid.
        console.warn('phrase transcription failed:', err);
        voice.dropped += 1;
      }
      renderListening();
    }
  } finally {
    // Only if this pump is still the current one. A reset already cleared the flag
    // and may have started a fresh dictation with a pump of its own, and clearing
    // it from under that one would let a second pump run beside it.
    if (gen === voice.generation) {
      voice.pumping = false;
      if (!voice.active) finishDictation();
    }
  }
}

/**
 * Whisper narrates non-speech in brackets ("[BLANK_AUDIO]", "(wind blowing)")
 * and, given near-silence, sometimes emits a stock phrase outright. Chunked
 * dictation hands it far more short and quiet segments than one long recording
 * does, so these have to be dropped here or they land in the message.
 */
function cleanTranscript(text) {
  const stripped = text
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return '';
  if (/^(you|thank you|thanks|bye|okay)[.!]?$/i.test(stripped)) return '';
  return stripped;
}

// --- making a finished dictation readable ------------------------------------
/**
 * What a consumer dictation app does that this did not.
 *
 * Everything above produces the right *words*. What it cannot produce is the
 * punctuation and the proper nouns, and those are most of what makes dictated
 * text feel finished. Neither engine here can: the browser recognizer emits no
 * punctuation at all, and whisper `base.en` sees one pause-delimited phrase at a
 * time — a few seconds of audio with no idea what the sentence or the subject
 * is. Measured against a real dictation of this app's own name: "compared to
 * ChatGPT and Gemini apps" came back as "compared to Georgia PT and Germany
 * apps", lowercase and unpunctuated throughout.
 *
 * Sentence boundaries and names need the whole utterance, so they are fixed once
 * the whole utterance exists — one bounded pass over the finished text (see
 * polish.js server-side). Three rules keep it from becoming a liability:
 *
 *  - It runs only after dictation has ended and the queue has drained, so the
 *    model sees the whole message and the user is not waiting mid-sentence.
 *  - It touches nothing if the composer changed underneath it. The request takes
 *    a second or two, and typing during that window is normal.
 *  - It never blocks or discards: the raw transcript is already in the box, and
 *    every failure path simply leaves it there.
 */
const POLISH_KEY = 'claude-polish-dictation';
// Its own localStorage key, like the wake lock, so the editor overlay — same
// origin, different surface — reads the one switch instead of a second copy.
let polishWanted = (() => {
  try {
    return localStorage.getItem(POLISH_KEY) !== '0';
  } catch {
    return true;
  }
})();

function setPolishDictation(on) {
  polishWanted = on;
  try {
    localStorage.setItem(POLISH_KEY, on ? '1' : '0');
  } catch {
    /* private mode: on for this session only */
  }
}

function showDictationPolishing() {
  clearInterval(listeningTicker);
  dictationBar.className = 'dictation-bar listening';
  dictationResume.classList.add('hidden');
  dictationDismiss.classList.add('hidden');
  dictationText.textContent = 'Punctuating what you said…';
}

/**
 * Start the cleanup pass, and publish it on `voice.polishing` so a send can wait
 * for it. Returns immediately; the promise is the only handle on it.
 */
function polishDictation() {
  const pass = runPolish();
  voice.polishing = pass;
  pass.finally(() => {
    if (voice.polishing === pass) voice.polishing = null;
  });
  return pass;
}

async function runPolish() {
  const gen = voice.generation;
  const raw = voice.committed;
  // Two words cannot be mispunctuated into anything worth a round trip.
  if (!polishWanted || raw.trim().split(/\s+/).filter(Boolean).length < 3) return;

  // The dictated span, and proof it is still the span we are about to rewrite.
  const end = voice.anchor + voice.committed.length;
  const before = input.value.slice(0, end);
  // An announced stop owns the status bar: it is the only thing telling the user
  // dictation was taken away, and it must survive this.
  const announced = dictationBar.classList.contains('stopped');

  if (!announced) showDictationPolishing();
  setMicState('working');
  try {
    const res = await api('/api/polish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: raw.trim() }),
    });
    const data = await res.json();
    // A new dictation now owns the composer, or the dictated words themselves
    // have been edited: either way the polished version is of something that is
    // no longer there. Only the span up to `end` is checked, so carrying on
    // typing after a dictation — the common case — still gets punctuated.
    if (gen !== voice.generation) return;
    if (voice.active || voice.starting) return;
    if (input.value.slice(0, end) !== before) return;
    if (res.ok && data.changed && data.text) {
      // Where the caret is relative to anything typed after the dictation. The
      // rewrite changes the length of the span in front of it, and leaving the
      // caret behind would drop the next keystroke mid-word.
      const caret = input.selectionStart ?? end;
      const tail = caret >= end ? caret - end : null;
      writeDictation(data.text);
      if (tail !== null) {
        const moved = voice.anchor + voice.committed.length + tail;
        input.setSelectionRange(moved, moved);
      }
      // Written through rather than debounced: this text arrived without anyone
      // touching the keyboard, so there may be no keystroke coming to save it.
      saveDraft({ now: true });
    }
  } catch (err) {
    // Includes the route being unreachable. The words are already in the box.
    console.warn('could not tidy up the dictation:', err);
  } finally {
    // The generation check is what keeps a pass that outlived its dictation from
    // tidying up after a reset — which would take the reset's own bar, and the
    // Undo it is offering, off the screen.
    if (gen === voice.generation && !voice.active && !voice.starting) {
      setMicState('idle');
      if (!announced) hideDictationBar();
    }
  }
}

/**
 * Decides where one spoken phrase ends and the next begins.
 *
 * Kept as a plain state machine, separate from the audio graph, because this is
 * the part that has to be right and the part that is impossible to eyeball: it
 * can be driven with synthetic frames in a test, which a ScriptProcessor
 * callback cannot. `push` takes a frame of samples, `flush` ends the phrase in
 * progress (used when dictation stops), and `onPhrase` receives each cut.
 *
 * Cuts land in silence, never on a timer, so no word is ever split across two
 * transcription requests — which is what removes the seams that the old
 * fragment-stitching had to guess at.
 */
function createPhraseCutter(sampleRate, onPhrase) {
  let frames = [];       // frames of the phrase being captured
  let samples = 0;
  let speaking = false;
  let quietMs = 0;
  let quietestRms = Infinity;
  let quietestAt = 0;    // frame index of the best place to cut, if forced
  const leadIn = 0.3 * sampleRate;

  function reset(rest) {
    frames = rest;
    samples = rest.reduce((n, f) => n + f.length, 0);
    speaking = false;
    quietMs = 0;
    quietestRms = Infinity;
    quietestAt = 0;
  }

  function cut(upTo) {
    const take = upTo === undefined ? frames : frames.slice(0, upTo);
    const rest = upTo === undefined ? [] : frames.slice(upTo);
    const total = take.reduce((n, f) => n + f.length, 0);
    const out = new Float32Array(total);
    let at = 0;
    for (const f of take) { out.set(f, at); at += f.length; }
    reset(rest);
    if (total) onPhrase(out);
  }

  return {
    push(frame) {
      let sum = 0;
      for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
      const rms = Math.sqrt(sum / frame.length);
      const frameMs = (frame.length / sampleRate) * 1000;

      frames.push(frame);
      samples += frame.length;
      // Before speech starts, keep only a short run-up, so a phrase never opens
      // clipped on its first consonant but silence is not buffered forever.
      if (!speaking && samples > leadIn && rms < VAD.speech) {
        samples -= frames.shift().length;
      }

      if (rms >= VAD.speech) {
        speaking = true;
        quietMs = 0;
      } else if (speaking && rms < VAD.silence) {
        quietMs += frameMs;
        if (quietMs >= VAD.hangoverMs) {
          cut();
          return;
        }
      } else if (speaking) {
        quietMs = 0;
      }

      if (!speaking) return;
      if (rms < quietestRms) { quietestRms = rms; quietestAt = frames.length; }
      if ((samples / sampleRate) * 1000 >= VAD.maxPhraseMs) {
        // Forced cut for one long unbroken sentence: use the quietest frame seen
        // rather than the current one, which is very likely mid-word.
        cut(quietestAt > 4 ? quietestAt : undefined);
      }
    },
    // Only a phrase that actually contains speech is worth transcribing. The
    // buffer is rarely empty — a short run-up of silence is kept deliberately —
    // so `samples > 0` is not the question; `speaking` is.
    flush() {
      if (speaking) cut();
    },
  };
}

/** Hand a captured phrase to the transcriber, unless it was too short to be one. */
function enqueuePhrase(samples) {
  if (samples.length < (VAD.minPhraseMs / 1000) * voice.sampleRate) return;
  voice.queue.push(samples);
  pumpDictationQueue();
}

async function startStreamingDictation() {
  const gen = voice.generation;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
  } catch (err) {
    toast(`Microphone blocked: ${err.message}`);
    return;
  }
  // Reset while the permission prompt was up: the mic belongs to a dictation that
  // no longer exists, so hand it straight back rather than building a graph on it.
  if (gen !== voice.generation) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  voice.stream = stream;

  // Ask the context for 16 kHz directly, which is what Whisper wants: the
  // browser resamples on the way in and no conversion is needed per phrase.
  // Not every browser honours the hint, so the real rate is read back.
  let ctx;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  } catch {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  // Reset while the context was starting. Nothing above is on `voice` yet, so this
  // is the last point where the teardown has to be done by hand.
  if (gen !== voice.generation) {
    stream.getTracks().forEach((t) => t.stop());
    if (voice.stream === stream) voice.stream = null;
    try {
      ctx.close();
    } catch {
      /* never opened */
    }
    return;
  }

  voice.audioCtx = ctx;
  voice.sampleRate = ctx.sampleRate;
  voice.anchor = nextDictationAnchor();
  voice.committed = '';
  voice.finalText = '';
  voice.queue = [];
  voice.dropped = 0;

  const source = ctx.createMediaStreamSource(voice.stream);
  const frameSize = Math.max(256, 2 ** Math.round(Math.log2((VAD.frameMs / 1000) * ctx.sampleRate)));
  // ScriptProcessor is deprecated but is the only node available in every
  // browser this has to run in, and it is the *renderer* that is deprecated for
  // — reading levels off it is exactly what it is still good at.
  const node = ctx.createScriptProcessor(frameSize, 1, 1);
  const cutter = createPhraseCutter(voice.sampleRate, enqueuePhrase);

  node.onaudioprocess = (e) => {
    if (!voice.active) return;
    // Copy: the node reuses this buffer on the next callback.
    cutter.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };

  source.connect(node);
  // ScriptProcessor only runs while connected to the destination. A zero gain
  // keeps it running without playing the microphone back into the room.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(ctx.destination);

  voice.nodes = { source, node, mute };
  voice.cutPhrase = () => cutter.flush();

  voice.active = true;
  voice.startedAt = Date.now();
  setMicState('recording');
  await syncWakeLock();
  if (voice.active) showListening();
}

/** Tear down the audio graph. Safe to call twice. */
function teardownAudioGraph() {
  const nodes = voice.nodes;
  voice.nodes = null;
  voice.cutPhrase = null;
  try {
    if (nodes) {
      nodes.node.onaudioprocess = null;
      nodes.source.disconnect();
      nodes.node.disconnect();
      nodes.mute.disconnect();
    }
  } catch {
    /* already torn down */
  }
  voice.stream?.getTracks().forEach((t) => t.stop());
  voice.stream = null;
  const ctx = voice.audioCtx;
  voice.audioCtx = null;
  try {
    ctx?.close();
  } catch {
    /* already closed */
  }
}

/** Called once the queue has drained after a stop, to settle the UI. */
function finishDictation() {
  if (voice.active || voice.pumping) return;
  setMicState('idle');
  if (voice.dropped) {
    toast(`${voice.dropped} phrase${voice.dropped > 1 ? 's' : ''} could not be transcribed`);
    voice.dropped = 0;
  }
  if (voice.pendingReason) {
    const reason = voice.pendingReason;
    voice.pendingReason = null;
    showDictationStopped(reason);
    // No cleanup after an interruption: Resume continues this same dictation, and
    // repunctuating a sentence that is about to be continued mid-clause makes the
    // seam worse rather than better.
  } else {
    hideDictationBar();
    input.focus();
    polishDictation();
  }
}

/**
 * Begin dictating.
 *
 * Guarded against overlapping starts. Starting is asynchronous — the recording
 * path awaits `getUserMedia`, which can sit on a permission prompt — and
 * `voice.active` is only true once something is running, so a second tap in that
 * window used to start a second recorder. Both then captured the same speech
 * into the same upload, which came back transcribed twice.
 */
async function startVoice() {
  if (voice.active || voice.starting) return;
  voice.starting = true;
  hideDictationBar();
  // Must happen inside the tap: an AudioContext created from a user gesture is
  // the one that is still allowed to make a sound minutes later.
  primeAlertSound();
  try {
    if (voice.mode === 'stream') await startStreamingDictation();
    else if (voice.mode === 'live') await startLiveDictation();
    else await startRecordingDictation();
  } finally {
    voice.starting = false;
  }
}

micBtn.addEventListener('click', () => {
  if (voice.active) {
    stopVoice();
    return;
  }
  startVoice();
});

micResetBtn.addEventListener('click', resetDictation);

// The way back from a reset: the words go back in the box, while everything the
// reset released stays released — the point was the state, not the text.
dictationUndo.addEventListener('click', () => {
  const text = resetUndo;
  hideDictationBar();
  if (!text) return;
  input.value = text;
  autosize();
  // Written through: this text arrived without a keystroke, so there may be no
  // keystroke coming to save it.
  saveDraft({ now: true });
  input.focus();
  toast('Put the text back. Dictation is still reset.');
});

// Picks up where the interruption left off, appending at the caret, which is
// exactly where the previous session stopped writing.
dictationResume.addEventListener('click', startVoice);
// Dismissing the banner drops the interruption entirely, so the next dictation
// goes back to following the caret rather than resuming where that one stopped.
dictationDismiss.addEventListener('click', () => {
  voice.resumeFromEnd = false;
  hideDictationBar();
});
/* --- push notifications -----------------------------------------------------
 *
 * For the sessions this app is *not* running: the editor panel, and anything under
 * tmux. Those are the ones you start and walk away from. What arrives is a title
 * and the first line or so of what Claude said, built by turn-watcher.js on the
 * box; tapping it dismisses it and nothing else.
 *
 * Three things have to be true at once for this to work, and each fails
 * differently, which is why the hint under the switch is generated rather than
 * written: the browser needs a service worker and a PushManager (an iPhone only has
 * them once the app is on the home screen), the OS needs to have granted
 * permission (a refusal is permanent until the user clears it in browser settings,
 * so the switch cannot ask twice), and the server needs the subscription.
 *
 * The subscription itself is the state. Nothing about "notifications are on" is
 * kept in localStorage: a stored flag can disagree with the browser, and when it
 * does the switch lies. `pushManager.getSubscription()` cannot.
 */
const PUSH_SW = '/chat/sw.js';
const PUSH_SCOPE = '/chat/';
const pushSupported = () =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/**
 * Register the worker, once — and only when something is actually being turned on.
 *
 * Scoped to /chat/ because that is where the script lives, while this page is at /.
 * A page outside a worker's scope can still register it and still receive its
 * notifications; the worker has no `fetch` handler, so controlling pages would buy
 * nothing anyway.
 */
let pushRegistration = null;
async function pushWorker() {
  if (!pushSupported()) return null;
  if (!pushRegistration) pushRegistration = await navigator.serviceWorker.register(PUSH_SW);
  return pushRegistration;
}

/**
 * The worker if it is already there, without installing one.
 *
 * Everything that only *reads* the state goes through this — painting the switch,
 * the check at boot — so opening the app on a device that has never enabled
 * notifications registers nothing at all.
 */
async function pushWorkerIfAny() {
  if (!pushSupported()) return null;
  if (pushRegistration) return pushRegistration;
  const found = await navigator.serviceWorker.getRegistration(PUSH_SCOPE).catch(() => null);
  if (found) pushRegistration = found;
  return found || null;
}

/** base64url → bytes. `applicationServerKey` takes nothing else. */
function pushKeyBytes(base64url) {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

const pushKeyOf = (subscription) => {
  const key = subscription?.options?.applicationServerKey;
  if (!key) return null;
  let out = '';
  for (const byte of new Uint8Array(key)) out += String.fromCharCode(byte);
  return btoa(out).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** Whether this device is subscribed, without asking or installing anything. */
async function pushSubscription() {
  const reg = await pushWorkerIfAny().catch(() => null);
  if (!reg) return null;
  return reg.pushManager.getSubscription().catch(() => null);
}

/**
 * Subscribe this device and tell the server.
 *
 * `Notification.requestPermission()` is called by the caller, not here, and before
 * anything is awaited: the prompt needs the user's tap to still be the most recent
 * thing that happened, and one `await` of a network round trip is enough to lose
 * that on mobile Chrome.
 */
async function pushSubscribe({ fresh = false } = {}) {
  const reg = await pushWorker();
  const { key } = await api('/api/push/key').then((r) => r.json());

  let subscription = await reg.pushManager.getSubscription();
  // A subscription is bound to the key it was made with. If the server's keypair
  // has changed — a lost volume, a rebuilt box — the old subscription still looks
  // healthy here and every notification sent to it fails at the push service, so
  // the mismatch has to be repaired rather than reported.
  //
  // `fresh` is the same repair for the failure this side cannot see at all: the push
  // service has forgotten the endpoint, while the browser goes on handing out a
  // subscription carrying the right key. Only the server hears that, so it is passed
  // in rather than worked out here.
  if (subscription && (fresh || pushKeyOf(subscription) !== key)) {
    await subscription.unsubscribe().catch(() => {});
    subscription = null;
  }
  if (!subscription) {
    subscription = await reg.pushManager.subscribe({
      // Required by Chrome, and honest: every push this app sends shows a
      // notification. Silent pushes are what the flag exists to forbid.
      userVisibleOnly: true,
      applicationServerKey: pushKeyBytes(key),
    });
  }

  const answer = await api('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(subscription),
  }).then((r) => r.json());
  /*
   * The server has been told by the push service that this endpoint is dead, so what
   * is in hand is worthless however healthy it looks. Replace it here, during a load
   * nobody had to ask for — this exact loop, a phone re-offering an endpoint the push
   * service had forgotten, is how notifications stopped for a day with no error on
   * either side. Once only, so a server that kept answering `gone` cannot spin.
   */
  if (answer?.gone && !fresh) return pushSubscribe({ fresh: true });
  return subscription;
}

/** Stop this device, at both ends. */
async function pushUnsubscribe() {
  const subscription = await pushSubscription();
  if (!subscription) return;
  // Server first: the endpoint is what identifies the device there, and once the
  // browser has dropped the subscription that string is gone.
  await api('/api/push/unsubscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  }).catch(() => {});
  await subscription.unsubscribe().catch(() => {});
}

/**
 * Keep an existing subscription honest, at every load. Never prompts.
 *
 * Three silent failures this repairs, all of which look like "notifications just
 * stopped working" from the phone: the server losing its device list (it lives on
 * disk, and a restore or a fresh volume drops it), a rotated VAPID keypair leaving a
 * subscription that can no longer be sent to, and — the one that actually happened —
 * an endpoint the push service has forgotten, which pushSubscribe replaces as soon as
 * the server says so.
 */
async function pushSync() {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  const existing = await pushSubscription();
  if (!existing) return;
  await pushSubscribe().catch(() => {});
}

/**
 * Whether the box agrees this device is subscribed. `null` when it could not be asked.
 *
 * The browser's own answer is not enough and never was: `getSubscription()` hands back
 * a subscription that looks healthy long after the push service has forgotten its
 * endpoint, so "the browser has one" and "the box can reach this phone" are different
 * facts and only the second one matters. See /api/push/status in server.js.
 */
const pushStatus = (subscription) =>
  api('/api/push/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  }).then((r) => r.json());

async function pushKnown(subscription) {
  if (!subscription) return false;
  try {
    return Boolean((await pushStatus(subscription))?.known);
  } catch {
    // Offline, or the route is older than this script. Not knowing is not the same as
    // knowing it is broken, so the switch says nothing rather than crying wolf.
    return null;
  }
}

/*
 * Wait for this device to say what happened to the notification just sent to it.
 *
 * The receipt comes from the service worker — it shows the notification, counts what
 * the registration is holding and posts both — so it arrives at the box about a second
 * after the push service accepted the message, by a path this page is not on. Polling
 * is the whole mechanism: there is no channel from the worker to a page that may not
 * have been open when the push landed, and the page only needs one answer, once,
 * seconds after a tap.
 *
 * Why bother: "the push service accepted it" and "your phone put it on screen" are the
 * same HTTP 201, and reporting the first as the second is how a switch said
 * "sent a test one to this device" to someone who had never seen a notification from
 * this app. `null` means no receipt arrived, which is itself the loudest answer
 * available — the message never reached the worker.
 */
const PUSH_RECEIPT_WAIT_MS = 6000;
async function pushReceipt(subscription, { since = 0, waitMs = PUSH_RECEIPT_WAIT_MS } = {}) {
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    try {
      const receipt = (await pushStatus(subscription))?.receipt;
      // Older than the test it is being asked about: a previous notification's receipt
      // answering for this one would be worse than no answer at all.
      if (receipt && receipt.at >= since) return receipt;
    } catch {
      /* Keep waiting: one failed poll is not an answer. */
    }
  }
  return null;
}

/*
 * The same repair whenever the app comes back to the front, not only at boot.
 *
 * A boot-only repair cannot reach the failure it exists for. An endpoint dies while
 * nobody is looking — the push service forgets it between one visit and the next — and
 * an installed app that is never cold-started never runs the boot path again, so the
 * phone stays unreachable for as long as it is left alone. Here that was two days.
 * Coming back to the front is the one moment the person is present and nothing has been
 * asked of them, so the check happens there too.
 *
 * Throttled, because switching tabs is something people do dozens of times an hour and
 * this is a network round trip plus, on a bad day, a resubscribe.
 */
const PUSH_SYNC_EVERY_MS = 5 * 60 * 1000;
let pushSyncedAt = 0;
function pushSyncSoon({ force = false } = {}) {
  if (!force && Date.now() - pushSyncedAt < PUSH_SYNC_EVERY_MS) return;
  pushSyncedAt = Date.now();
  pushSync().then(() => paintPushToggle()).catch(() => {});
}

/** Ask the server to send one to *this* device, and say which one that is. */
const pushTest = (subscription) =>
  api('/api/push/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  }).then((r) => r.json());

/**
 * What to say about a test notification, from this device's own result.
 *
 * `sent` counts every subscribed device, so a desktop that received the test made
 * this toast say "sent a test one" on a phone whose own message had just been refused
 * — the switch looked right, nothing arrived, and no log disagreed for a day. `mine`
 * is the answer to the question the tap was asking.
 */
function pushTestToast(result) {
  if (!result.mine) {
    return result.sent
      ? 'Notifications on — a test was sent, but maybe not to this device'
      : 'Subscribed, but the test notification could not be sent';
  }
  if (result.mine.gone) return 'Subscribed, but the push service keeps forgetting this device';
  if (!result.mine.ok) return `Subscribed, but the push service refused the test (${result.mine.status})`;
  return 'Notifications on — sent a test one to this device';
}

// --- reading aloud ----------------------------------------------------------
/*
 * Hearing a message instead of reading it.
 *
 * Dictation has been the whole of voice in this app until now, which is half a
 * conversation: you can talk to Claude from a phone and then have to read the
 * answer. This is the other half — a button on each of Claude's messages, and one
 * on each code block inside it.
 *
 * Three decisions worth stating, because each of them is the opposite of the
 * obvious one.
 *
 *   **The server does the synthesis, and there is no `speechSynthesis` fallback
 *   here.** The editor overlay has one, and it earns it: it can be running on a
 *   deployment with no Polly permission, and a robotic voice reading a summary
 *   beats silence. This surface is the one asked to read Hebrew and to read code,
 *   and the local voice can do neither — every browser voice on an English phone
 *   skips Hebrew characters outright, and code read verbatim is a minute of
 *   punctuation names. So a control appears only when the server can actually
 *   read, and never as a button that would disappoint.
 *
 *   **Which voice is the server's decision, not this file's.** `chooseVoice` in
 *   speak.js looks at the text: Hebrew goes to an Azure Hebrew voice (free tier)
 *   or an OpenAI one, English to Polly. A phone that has never picked a voice
 *   sends `voice: ''` and gets the right one for the message it is reading, which
 *   is the behaviour that matters most here — nobody wants to choose a voice per
 *   language before pressing play.
 *
 *   **A code block is sent as code, not as prose.** `kind: 'code'` is what turns
 *   indentation into "indent two" and `=>` into "arrow" and puts a line number in
 *   every few lines. Doing that here would mean two surfaces disagreeing about
 *   what a block sounds like, and a phone with a cached copy of this file
 *   disagreeing with the server it is talking to.
 */
const SPEAK_SILENCE = '/api/speak/silence';

const speech = {
  /** The server's answer, or null until it has been asked or if it cannot read. */
  voices: null,
  /** Its own default voice, which is what an unset preference means. */
  voice: '',
  /** The one element, unlocked by a tap and then kept: see unlockSpeech. */
  audio: null,
  /** The read in progress: { id, total, kind, fetching }. */
  read: null,
  /** Bumped by every start and every stop, so late arrivals can tell. */
  generation: 0,
  reading: false,
  /** The control that started this read, which is the one that says Stop. */
  control: null,
};

const speechReady = () => Boolean(speech.voices?.length) && typeof Audio === 'function';

/**
 * Ask once what this box can do with a voice: read a message aloud, and hold a
 * spoken conversation about one. Two capabilities, one round trip, because they are
 * one question from the client's side — what belongs on a message.
 *
 * Failure is silent and total: no controls anywhere, rather than buttons that
 * explain a 401. Every reason this can fail — a deployment with no Polly
 * permission, no Azure or OpenAI key, an older server with no such route — has the
 * same answer on screen, which is nothing where a speaker icon would have been.
 */
async function loadVoices() {
  try {
    const res = await api('/api/voice-status', { headers: { Accept: 'application/json' } });
    if (!res.ok) return;
    const body = await res.json();
    talk.status = body?.realtime?.configured ? body.realtime : null;
    if (body?.speech?.configured) {
      speech.voices = body.speech.voices || [];
      speech.voice = body.speech.voice || '';
      if (!speech.voices.length) speech.voices = null;
    }
    paintVoicePicker();
    if (!speechReady() && !talkReady()) return;
    // Messages already on screen were rendered before the answer arrived — which is
    // the normal order, because the transcript is drawn from cache in the first
    // frame and this is a round trip.
    for (const el of document.querySelectorAll('.msg.claude')) {
      if (el.dataset.raw) decorateSpoken(el, el.dataset.raw);
    }
  } catch {
    /* no voice on this device; nothing on screen claims otherwise */
  }
}

/** The voice this device asked for, or '' to let the server choose per message. */
function chosenVoice() {
  const wanted = state.settings.voice || '';
  return (speech.voices || []).some((v) => v.id === wanted) ? wanted : '';
}

/*
 * iOS plays audio that a gesture asked for, and grants the permission to *an
 * element* rather than to the page. The audio being read does not exist when the
 * button is pressed — it is synthesised after a round trip — so the element is
 * unlocked inside the tap with a silent WAV and then reused for the life of the
 * page. A new element would be locked again, and the read after it silent.
 */
function unlockSpeech() {
  if (typeof Audio !== 'function') return false;
  if (!speech.audio) {
    speech.audio = new Audio();
    speech.audio.preload = 'auto';
  }
  try {
    speech.audio.onended = null;
    speech.audio.onerror = null;
    speech.audio.src = SPEAK_SILENCE;
    const played = speech.audio.play();
    // Older browsers return undefined rather than a promise, and a rejection here
    // means this was not a gesture — which the read that follows will report if it
    // turns out to matter.
    if (played?.catch) played.catch(() => {});
  } catch {
    /* as above */
  }
  return true;
}

/** Forget the read in progress, keeping the element and its unlock. */
function stopSpeaking() {
  speech.generation += 1;
  speech.read = null;
  speech.reading = false;
  speech.control = null;
  if (speech.audio) {
    speech.audio.onended = null;
    speech.audio.onerror = null;
    try {
      speech.audio.pause();
      // Removed rather than set to '': an empty src is a request for the page's own
      // URL, which some browsers will go and fetch.
      speech.audio.removeAttribute('src');
      speech.audio.load?.();
    } catch {
      /* the unlock survives either way, which is the part that matters */
    }
  }
  paintReadControls();
}

/**
 * Every read control says what it does now: its own label, or Stop.
 *
 * The one that opened a conversation says Hang up instead, and is the only place to
 * end it from besides the panel — a call you cannot find the end of is the whole
 * reason phones show a green bar at the top.
 */
function paintReadControls() {
  for (const btn of document.querySelectorAll('[data-read]')) {
    const mine = btn.dataset.talk
      ? talking() && btn === talk.control
      : speech.reading && btn === speech.control;
    const stop = btn.dataset.talk ? '■ Hang up' : '■ Stop';
    btn.textContent = mine ? stop : btn.dataset.readLabel || '🔊 Read';
    btn.classList.toggle(btn.dataset.talk ? 'talking' : 'reading', mine);
  }
}

/** The sentence the server sent with a refusal, or the status on its own. */
async function speakRefusal(res) {
  try {
    const body = await res.json();
    if (body?.error) return String(body.error);
  } catch {
    /* not JSON: the status is all there is to go on */
  }
  return `the server answered ${res.status}`;
}

/**
 * One piece of audio as a URL that can be played, fetched once and shared.
 *
 * Fetched here and then played from the same URL rather than handed to the element
 * unseen, because the element cannot report *why* a source failed — it fires
 * `error` and says nothing — while the server's refusals are sentences worth
 * repeating. The response is cacheable, so the element's own request for the same
 * URL is served from the browser cache rather than synthesised again.
 */
function speechSegment(index, generation) {
  const read = speech.read;
  if (!read || index < 0 || index >= read.total) return null;
  const already = read.fetching.get(index);
  if (already) return already;
  const url = `/api/speak?id=${encodeURIComponent(read.id)}&segment=${index}`;
  const pending = fetch(url).then(async (res) => {
    if (!res.ok) throw new Error(await speakRefusal(res));
    // Drain it, so it lands in the cache the element is about to read from.
    await res.blob();
    if (generation !== speech.generation || !speech.read) return null;
    return url;
  });
  read.fetching.set(index, pending);
  return pending;
}

/** Play piece `index`, then the one after it, until Stop or the end. */
async function playSpeech(index, generation) {
  let url = null;
  try {
    url = await speechSegment(index, generation);
  } catch (err) {
    if (generation === speech.generation) {
      stopSpeaking();
      toast(`Stopped reading: ${err.message}`);
    }
    return;
  }
  if (generation !== speech.generation || !speech.read || !url) return;

  // One ahead, while this one plays: synthesis takes about a fifth of the time the
  // audio takes to play, so one is enough to make a message continuous, and two
  // would pay for audio that Stop is about to discard.
  if (index + 1 < speech.read.total) speechSegment(index + 1, generation)?.catch(() => {});

  speech.audio.onended = () => {
    if (generation !== speech.generation) return;
    if (speech.read && index + 1 < speech.read.total) {
      playSpeech(index + 1, generation);
      return;
    }
    stopSpeaking();
  };
  speech.audio.onerror = () => {
    if (generation !== speech.generation) return;
    stopSpeaking();
    toast('Stopped reading: the audio would not play');
  };
  try {
    speech.audio.src = url;
    speech.audio.play()?.catch?.((err) => {
      if (generation !== speech.generation) return;
      stopSpeaking();
      toast(`Nothing was read: ${err?.message || 'the browser refused to play it'}`);
    });
  } catch (err) {
    stopSpeaking();
    toast(`Nothing was read: ${err?.message || 'the browser refused to play it'}`);
  }
}

/**
 * Start reading. Everything up to the first network call happens inside the tap,
 * because that is the only place iOS will let audio begin.
 */
function startSpeaking(text, { kind = 'prose', lang = '', control = null } = {}) {
  stopSpeaking();
  if (!speechReady() || !String(text || '').trim()) return;
  if (!unlockSpeech()) return;
  // Never over a live microphone: the recognizer would hear this and dictate
  // Claude's own words back into the composer.
  if (voice.active) {
    toast('Not while the microphone is listening');
    return;
  }
  speech.generation += 1;
  const generation = speech.generation;
  speech.reading = true;
  speech.control = control;
  paintReadControls();

  api('/api/speak/prepare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice: chosenVoice(), kind, lang }),
  })
    .then(async (res) => {
      if (!res.ok) throw new Error(await speakRefusal(res));
      return res.json();
    })
    .then((prepared) => {
      if (generation !== speech.generation) return;
      if (!prepared?.id || !prepared.segments) throw new Error('the server prepared nothing to play');
      speech.read = { id: prepared.id, total: prepared.segments, kind, fetching: new Map() };
      playSpeech(0, generation);
    })
    .catch((err) => {
      if (generation !== speech.generation) return;
      stopSpeaking();
      toast(`Nothing was read: ${err?.message || 'the server voice is unavailable'}`);
    });
}

/**
 * The fenced blocks of a message, in the order `renderMarkdown` turns them into
 * `<pre>` elements — so the nth block and the nth `<pre>` are the same block.
 *
 * Deliberately the same split as the renderer, from the same source, rather than a
 * second fence parser that agrees with it today: a block button that reads the
 * wrong block is worse than no button.
 */
function fencedBlocks(text) {
  const blocks = [];
  // `pre` counts every block the renderer emits, including the empty one an
  // unterminated fence leaves behind — it is a `<pre>` on screen either way, and
  // counting only the readable ones would shift every button after it by one.
  let pre = -1;
  for (const part of splitFences(text)) {
    if (part.type !== 'code') continue;
    pre += 1;
    const code = part.text.replace(/\n+$/, '');
    if (!code.trim()) continue;
    blocks.push({ lang: part.lang, code, lines: code.split('\n').length, pre });
  }
  return blocks;
}

/**
 * Give one of Claude's messages the controls for hearing it.
 *
 * Called again after every re-render of the same bubble — streaming replaces the
 * innerHTML on the way to the final text — so it clears its own work first and can
 * be called as often as the bubble changes. The raw markdown is kept on the element
 * because that is what gets read: the rendered HTML has lost the fences, and the
 * server wants the block, not the DOM.
 */
function decorateSpoken(el, text) {
  if (!el) return;
  el.dataset.raw = text ?? '';
  for (const old of el.querySelectorAll('.read-row')) old.remove();
  // Two separate capabilities: reading aloud needs a speech voice, talking it over
  // needs an OpenAI key. A box can have either, and a message gets whichever
  // controls are actually backed by something.
  if (!speechReady() && !talkReady()) return;

  const blocks = speechReady() ? fencedBlocks(el.dataset.raw) : [];
  const pres = [...el.querySelectorAll('pre')];

  /* A block's own button goes under the block, where the code it reads is. */
  for (const block of blocks) {
    const pre = pres[block.pre];
    if (!pre) continue;
    const row = document.createElement('div');
    row.className = 'read-row code';
    const label = ['🔊 Read this code', block.lang, `${block.lines} line${block.lines === 1 ? '' : 's'}`]
      .filter(Boolean)
      .join(' · ');
    row.appendChild(readButton(label, () =>
      startSpeaking(block.code, { kind: 'code', lang: block.lang, control: row.firstChild })));
    pre.after(row);
  }

  // And the message's own, at the end of it. Last rather than first: it is the
  // thing you reach for after reading the start of an answer and deciding to
  // listen to the rest, and a row of controls above the text pushes the text down.
  const row = document.createElement('div');
  row.className = 'read-row';
  if (speechReady()) {
    const spoken = speakableText(el.dataset.raw, blocks.length);
    row.appendChild(readButton('🔊 Read aloud', () =>
      startSpeaking(spoken, { control: row.firstChild })));
  }
  /*
   * And the conversation about it, beside the read. Next to each other because they
   * are the same impulse a second apart — hear this, then ask about what I heard —
   * and this one carries the raw markdown rather than the spoken reduction: the
   * far end is reading code, not saying it, so the fences are what it wants.
   */
  if (talkReady()) {
    const btn = readButton('💬 Talk it over', () =>
      startTalking(el.dataset.raw, { prompt: promptBefore(el), control: btn }));
    btn.dataset.talk = '1';
    row.appendChild(btn);
  }
  el.appendChild(row);
}

function readButton(label, onTap) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'read-btn';
  btn.dataset.read = '1';
  btn.dataset.readLabel = label;
  btn.textContent = label;
  btn.addEventListener('click', () => {
    // Its own Stop while it is the one reading; a tap on another control switches
    // to that one rather than stopping, which is what startSpeaking does by
    // stopping first.
    if (speech.reading && speech.control === btn) {
      stopSpeaking();
      return;
    }
    onTap();
  });
  return btn;
}

/**
 * A message as something worth listening to.
 *
 * Far less than the editor overlay's reduction, on purpose: this app renders a
 * deliberately tiny markdown subset (fenced code, inline code, bold), so those are
 * the only markers that are ever on screen here and the only ones worth removing.
 * Code is replaced by the fact that it was there — numbered when there is more than
 * one, so what a listener hears maps onto the buttons under the blocks.
 */
function speakableText(markdown, blockCount = 0) {
  let out = '';
  let block = 0;
  for (const part of splitFences(markdown)) {
    if (part.type !== 'code') { out += part.text; continue; }
    if (!part.text.trim()) continue;            // a fence with nothing in it yet
    block += 1;
    out += blockCount > 1 ? ` Code block ${block}. ` : ' Code block. ';
  }
  return out.replace(/`+([^`]*)`+/g, '$1').replace(/\*\*([^*\n]+)\*\*/g, '$1').trim();
}

/** The voice picker in Settings, which only exists if the server can read. */
function paintVoicePicker() {
  const row = $('#voice-row');
  const select = $('#select-voice');
  if (!row || !select) return;
  if (!speechReady()) {
    row.classList.add('hidden');
    return;
  }
  row.classList.remove('hidden');
  select.textContent = '';
  const add = (value, label) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  };
  /*
   * "Whichever fits the message" first, and it is the default for a reason: the
   * server picks per message, so a Hebrew answer is read by a Hebrew voice and an
   * English one by Polly with nothing to set. Choosing a named voice is choosing to
   * override that, which is worth doing for how a voice sounds and not much else —
   * so the ones that cannot read Hebrew say so here rather than after the fact.
   */
  add('', 'Whichever fits the message (default)');
  for (const v of speech.voices || []) {
    const language = String(v.language || '').toLowerCase() === 'multi' ? 'any language' : v.language;
    add(v.id, `${v.id} · ${language}${v.gender ? ` · ${v.gender}` : ''}`);
  }
  select.value = (speech.voices || []).some((v) => v.id === state.settings.voice)
    ? state.settings.voice
    : '';
  paintVoiceHint();
}

function paintVoiceHint() {
  const hint = $('#voice-hint');
  if (!hint) return;
  const chosen = (speech.voices || []).find((v) => v.id === state.settings.voice);
  if (!chosen) {
    hint.textContent =
      'Hebrew is read by a Hebrew voice, English by an English one, chosen per message on the server. Code blocks get their own button under the block.';
    return;
  }
  const language = String(chosen.language || '').toLowerCase();
  hint.textContent =
    chosen.provider === 'azure'
      ? // Both languages come from one free resource and share one monthly allowance,
        // so what differs between an Azure voice and an Azure voice is only which
        // language it is good at. The English pair are the default for everyone who has
        // not chosen, which is why this says what happens when the month runs out.
        `${language.startsWith('he') ? 'A Hebrew neural voice' : 'An English neural voice'} on Azure’s free tier — nothing is charged past the monthly allowance; it stops until the 1st and a Polly voice keeps working. ${language.startsWith('he') ? 'Hebrew only, so an English message will be read by it badly.' : 'English: a mostly-Hebrew message is moved to the Hebrew voice on its own.'}`
      : language === 'multi'
        ? 'One voice for every language, so it reads a message with Hebrew and English in it. Slower to start, and metered by the character.'
        : 'An English voice. It cannot read Hebrew — Polly has no Hebrew voice at all — so a Hebrew message will come back refused rather than mispronounced.';
}

/* ---------------------------------------------------------------------------
 * A spoken conversation about one message
 * ---------------------------------------------------------------------------
 *
 * Read-aloud answers "say this to me". This answers what you want a second later —
 * *wait, go back to the part about the timeout* — out loud, while walking, without
 * typing and without waiting for a turn.
 *
 * Three things about it that are design and not accident:
 *
 * **It cannot reach Claude.** The server mints a session with no tools and an
 * instruction saying so (`realtime.js`), and this side adds nothing: there is no
 * code here that could send what was said to a session, and the panel says so where
 * it cannot be missed. A voice channel with no transcript is the last place a
 * command should be issued from — a misheard sentence there is a force-push nobody
 * typed and nobody saw.
 *
 * **The audio does not pass through our box.** The browser holds a two-minute
 * credential and opens WebRTC straight to OpenAI. Latency is the whole feature, and
 * a relay on an instance that is also running a compiler is latency.
 *
 * **It is metered, so it ends by itself.** The server counts sessions per day; this
 * end hangs up on its own timer and shows the clock while it runs, because the
 * failure mode of a voice call is a pocket that is still connected.
 */
const talk = {
  status: null,       // what /api/voice-status said about realtime, or null
  pc: null,           // RTCPeerConnection
  channel: null,      // the `oai-events` data channel
  mic: null,          // MediaStream, so its tracks can actually be stopped
  audio: null,        // the element playing the far end
  control: null,      // the button that opened it, which is also its Stop
  /*
   * Muted, which is not a way out: the microphone stays open and the minute is still
   * billed, the far end is just sent silence. See `setTalkMute`.
   */
  muted: false,
  started: 0,
  timer: null,
  generation: 0,
  lines: [],          // { who: 'you' | 'voice', text, partial }
};

function talkReady() {
  return Boolean(talk.status?.configured && typeof RTCPeerConnection === 'function');
}

/** Whether a conversation is up, or on its way up. */
function talking() {
  return Boolean(talk.pc);
}

/**
 * Mute, which is not the same thing as stopping the microphone.
 *
 * `enabled = false` keeps the track and the session and sends silence in place of the
 * room; stopping it would close the microphone with no way back into this conversation,
 * and a second one costs another session against the day's count. So while muted the
 * recording indicator stays lit, correctly, and the minute is still billed — hanging up
 * is the only thing that closes the line.
 *
 * Worth a button because of how the session is minted: turn detection is semantic with
 * `interrupt_response` on (chat-service/realtime.js), so anything the microphone hears
 * cuts the explanation off mid-word. This is how a long answer gets heard out in a room
 * with other people in it.
 */
function setTalkMute(muted) {
  talk.muted = Boolean(muted);
  for (const track of talk.mic?.getTracks?.() || []) track.enabled = !talk.muted;
  paintTalkMute();
  // Only with a line up: before that, the status line is reporting the connection,
  // which is the more useful of the two things it could say.
  if (talking()) paintTalkStatus(talkStateText());
}

/**
 * What the status line says while a line is up — "Listening" is a lie when muted.
 *
 * And that the line is still open, in the same breath: the mistake this button makes
 * possible is muting instead of hanging up and then walking away from it.
 */
const talkStateText = () =>
  talk.muted ? 'Muted — it cannot hear you, and the line is still open' : 'Listening';

/** The mute control, enabled exactly while there is a microphone to mute. */
function paintTalkMute() {
  const btn = $('#btn-talk-mute');
  if (!btn) return;
  btn.disabled = !talk.mic;
  btn.textContent = talk.muted ? 'Unmute' : 'Mute';
  // A toggle, so it says so to a screen reader rather than only changing its label.
  btn.setAttribute('aria-pressed', talk.muted ? 'true' : 'false');
}

/**
 * Start one. The credential is minted here and spent in the browser; `text` is the
 * message being discussed and `prompt` is what was asked to produce it.
 */
async function startTalking(text, { prompt = '', control = null } = {}) {
  if (talking()) {
    endTalking();
    return;
  }
  if (!talkReady() || !String(text || '').trim()) return;
  if (voice.active) {
    toast('Not while the microphone is listening');
    return;
  }
  stopSpeaking();                       // one voice at a time, and this one answers back

  const generation = ++talk.generation;
  talk.control = control;
  talk.lines = [];
  /*
   * Never inherited from the last conversation: one that opens muted is one you talk
   * into for ten seconds before finding out. `endTalking` clears it first — this is the
   * second line of defence, and the one that matters, because a stale `true` would
   * label the button "Unmute" over a microphone that is live: the mute was applied to a
   * stream that has been stopped since.
   */
  talk.muted = false;
  openTalkSheet();
  paintTalkStatus('Asking for a line…');
  paintTalkTranscript();
  paintReadControls();

  try {
    /*
     * The microphone first, before the credential: it is the one step that can be
     * refused by the person rather than by a server, and asking for it first means a
     * refusal costs nothing. A session minted and then abandoned is counted against
     * the day either way — the server reserves before it calls OpenAI, deliberately.
     */
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (generation !== talk.generation) {
      for (const track of mic.getTracks()) track.stop();
      return;
    }
    talk.mic = mic;
    // Mutable from here, which is before the line is up: the room is already being heard
    // while the credential is being minted.
    paintTalkMute();

    const res = await api('/api/realtime/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, prompt }),
    });
    if (!res.ok) throw new Error(await speakRefusal(res));
    const minted = await res.json();
    if (generation !== talk.generation) return;
    if (!minted?.value) throw new Error('the server minted nothing to connect with');

    await connectTalk(minted, generation);
  } catch (err) {
    if (generation !== talk.generation) return;
    endTalking();
    const why = err?.name === 'NotAllowedError'
      ? 'the microphone was not allowed'
      : err?.message || 'the connection failed';
    paintTalkStatus(`Not connected: ${why}`);
    toast(`No conversation: ${why}`);
  }
}

/**
 * Open the WebRTC session with the minted credential.
 *
 * Nothing about the session is configured from here — the model, the voice, the
 * instructions, the turn detection and the absence of tools are all baked into the
 * credential by the server, so a tampered client gets a session shaped exactly the
 * same way. This end sends an offer and plays what comes back.
 */
async function connectTalk(minted, generation) {
  const pc = new RTCPeerConnection();
  talk.pc = pc;
  // From here on there is something to hang up, so the button that opened it says so
  // — before the SDP round trip, not after: that is where a connection can stall.
  paintReadControls();

  if (!talk.audio) {
    talk.audio = new Audio();
    talk.audio.autoplay = true;
    // iOS plays a stream inline rather than taking over the screen with it. Set on
    // both, because the attribute is what older WebKit reads.
    talk.audio.playsInline = true;
    talk.audio.setAttribute?.('playsinline', '');
  }
  pc.ontrack = (event) => {
    if (generation !== talk.generation) return;
    talk.audio.srcObject = event.streams?.[0] || null;
    talk.audio.play?.()?.catch?.(() => {
      // The tap that opened this is the gesture, so this is nearly impossible —
      // and silent audio with a connected session is worth a sentence either way.
      paintTalkStatus('Connected, but this browser will not play the audio');
    });
  };
  pc.onconnectionstatechange = () => {
    if (generation !== talk.generation) return;
    if (pc.connectionState === 'connected') paintTalkStatus(talkStateText());
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      endTalking();
      paintTalkStatus('The line dropped');
    }
  };

  for (const track of talk.mic.getTracks()) pc.addTrack(track, talk.mic);

  // The event channel carries the transcripts of both halves, which is what makes
  // this auditable at all: you can see what it heard you say.
  const channel = pc.createDataChannel('oai-events');
  talk.channel = channel;
  channel.onmessage = (event) => onTalkEvent(event, generation);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  // The server says where: this box may hold an Azure deployment or an OpenAI key,
  // and a client that hardcodes one talks to the wrong vendor the day it changes.
  // The fallback keeps an old tab working against a newer service.
  const callUrl =
    minted.callUrl ||
    `https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(minted.model || '')}`;
  const answer = await fetch(callUrl, {
    method: 'POST',
    body: offer.sdp,
    headers: { Authorization: `Bearer ${minted.value}`, 'Content-Type': 'application/sdp' },
  });
  if (!answer.ok) throw new Error(`the voice service refused the connection (${answer.status})`);
  const sdp = await answer.text();
  if (generation !== talk.generation) return;
  await pc.setRemoteDescription({ type: 'answer', sdp });

  talk.started = Date.now();
  const minutes = Number(minted.maxMinutes) || 10;
  talk.timer = setInterval(() => {
    paintTalkClock();
    if (Date.now() - talk.started >= minutes * 60_000) {
      endTalking();
      paintTalkStatus(`The line closed after ${minutes} minutes`);
    }
  }, 1000);

  paintTalkStatus(talkStateText());
  paintTalkClock();
  const spent = minted.budget;
  $('#talk-note').textContent = [
    `${minted.voice || 'a voice'} on ${minted.model || 'OpenAI'}, billed by the minute.`,
    spent ? `${spent.sessions} of ${spent.limit} conversations today.` : '',
    `The line closes by itself after ${minutes} minutes.`,
  ].filter(Boolean).join(' ');
}

/**
 * What the far end says about itself.
 *
 * Only the transcripts and the errors are read. Deltas rather than the completed
 * events alone, so a sentence appears while it is being said — dimmed until it is
 * final, because a half-heard line displayed as finished is how you end up certain
 * it said something it did not.
 */
function onTalkEvent(event, generation) {
  if (generation !== talk.generation) return;
  let msg;
  try {
    msg = JSON.parse(event.data);
  } catch {
    return;                             // not ours to understand
  }
  const type = String(msg?.type || '');

  // What it is saying. The event was renamed across API versions and both names are
  // still in the wild, so match on the shape of it rather than one spelling.
  if (/^response\.(output_)?audio_transcript\.delta$/.test(type)) {
    addTalkText('voice', msg.delta || '', true);
    return;
  }
  if (/^response\.(output_)?audio_transcript\.done$/.test(type)) {
    finishTalkLine('voice', msg.transcript);
    return;
  }

  // What it heard you say.
  if (type === 'conversation.item.input_audio_transcription.delta') {
    addTalkText('you', msg.delta || '', true);
    return;
  }
  if (type === 'conversation.item.input_audio_transcription.completed') {
    finishTalkLine('you', msg.transcript);
    return;
  }

  if (type === 'error') {
    const why = msg.error?.message || 'the far end reported an error';
    paintTalkStatus(`Trouble: ${why}`);
  }
}

/** Append to the open line for `who`, starting one if the last line was the other. */
function addTalkText(who, text, partial) {
  if (!text) return;
  const last = talk.lines[talk.lines.length - 1];
  if (last && last.who === who && last.partial) last.text += text;
  else talk.lines.push({ who, text, partial });
  paintTalkTranscript();
}

/** Close the open line, preferring the final transcript over the deltas. */
function finishTalkLine(who, transcript) {
  const last = talk.lines[talk.lines.length - 1];
  const final = String(transcript || '').trim();
  if (last && last.who === who && last.partial) {
    if (final) last.text = final;
    last.partial = false;
  } else if (final) {
    talk.lines.push({ who, text: final, partial: false });
  }
  paintTalkTranscript();
}

/** Hang up, and leave the panel open so the transcript can still be read. */
function endTalking() {
  talk.generation += 1;
  if (talk.timer) clearInterval(talk.timer);
  talk.timer = null;
  try {
    talk.channel?.close?.();
  } catch { /* already gone */ }
  try {
    talk.pc?.close?.();
  } catch { /* already gone */ }
  // The tracks, not just the stream: a MediaStream that is dropped without stopping
  // its tracks leaves the recording indicator on and the microphone live.
  for (const track of talk.mic?.getTracks?.() || []) {
    try {
      track.stop();
    } catch { /* already stopped */ }
  }
  if (talk.audio) talk.audio.srcObject = null;
  talk.pc = null;
  talk.channel = null;
  talk.mic = null;
  talk.control = null;
  talk.muted = false;
  talk.started = 0;
  paintTalkStatus('Hung up');
  paintTalkClock();
  paintTalkMute();
  paintReadControls();
}

function openTalkSheet() {
  $('#talk-sheet')?.classList.remove('hidden');
}

function paintTalkStatus(text) {
  const el = $('#talk-status');
  if (el) el.textContent = text;
}

function paintTalkClock() {
  const el = $('#talk-clock');
  if (!el) return;
  if (!talk.started) {
    el.textContent = '';
    return;
  }
  const secs = Math.floor((Date.now() - talk.started) / 1000);
  el.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

function paintTalkTranscript() {
  const box = $('#talk-transcript');
  if (!box) return;
  box.textContent = '';
  for (const line of talk.lines) {
    const el = document.createElement('p');
    el.className = `talk-line${line.partial ? ' partial' : ''}`;
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = line.who === 'you' ? 'you' : 'the voice';
    el.appendChild(who);
    el.appendChild(document.createTextNode(line.text));
    box.appendChild(el);
  }
  box.scrollTop = box.scrollHeight;
}

/**
 * What was asked to produce this message, for the conversation's context.
 *
 * The bubble before it, and only if it is one of yours: a thread that starts with
 * Claude's own message (a resumed session, a hook, a subagent) has no prompt to give,
 * and inventing one from the message above would put a stranger's words in the
 * prompt. The server treats an empty one as "not provided".
 */
function promptBefore(el) {
  for (let node = el?.previousElementSibling; node; node = node.previousElementSibling) {
    if (node.classList?.contains('msg')) {
      return node.classList.contains('user') ? node.textContent || '' : '';
    }
  }
  return '';
}

$('#btn-talk-mute')?.addEventListener('click', () => setTalkMute(!talk.muted));
$('#btn-talk-end')?.addEventListener('click', () => endTalking());
/*
 * Closing the panel hangs up too. A hidden panel over a live session is a pocket
 * call on someone else's credit: there is no green bar at the top of a web app to
 * find it by, and the only other end of it is the button on a message that has
 * probably scrolled away by then.
 */
document.querySelectorAll('[data-close-talk]').forEach((el) =>
  el.addEventListener('click', () => {
    if (talking()) endTalking();
    $('#talk-sheet').classList.add('hidden');
  }),
);

// --- settings ---------------------------------------------------------------
/*
 * Which build is running, and whether this tab is still it.
 *
 * The question this answers is the one that follows every deploy: is what I am
 * looking at what was just shipped. Two halves, and the second is the one that
 * cannot be skipped — a phone keeps this app open for days, so the tab is often
 * *not* the build on the box, and a version line that reported the server's build
 * while the page ran older code would answer the question wrongly rather than not
 * at all. PAGE_BUILD is what the shell was stamped with; /api/version is what the
 * server is now. They are the same string when there is nothing to do.
 *
 * Asked on every open of the sheet rather than polled: it costs one small request
 * at the moment somebody is looking, and a phone in a pocket has no use for the
 * answer. The elements are guarded because a browser holding a stale index.html
 * has none of them, and the whole point of this is to be readable from exactly
 * that tab.
 */
const buildLine = $('#build-line');
const buildNote = $('#build-note');
const buildReload = $('#btn-build-reload');

/** "v3.0.0 · 33d370b · deployed 2h ago", out of whatever parts are known. */
function buildSummary(build) {
  const parts = [];
  if (build.version) parts.push(`v${build.version}`);
  // The `+` is the id's own marker for a payload that was not exactly a commit —
  // see idFor in chat-service/build.js — and the note below spells it out.
  if (build.commit) parts.push(build.dirty ? `${build.commit}+` : build.commit);
  else parts.push('unstamped build');
  if (build.builtAt) parts.push(`deployed ${relTime(build.builtAt)}`);
  return parts.join(' · ') || 'version unknown';
}

/** The second line: what that build actually contains, or why it cannot be named. */
function buildDetail(build) {
  const notes = [];
  if (build.subject) notes.push(`“${build.subject}”`);
  else if (!build.commit) notes.push('No commit in this payload, so only its date is known.');
  if (build.dirty) notes.push('Shipped from a working tree with uncommitted changes.');
  return notes.join(' ');
}

async function paintBuild() {
  if (!buildLine || !buildNote || !buildReload) return;
  let build;
  try {
    const res = await api('/api/version');
    if (!res.ok) throw new Error(`server returned ${res.status}`);
    build = await res.json();
  } catch {
    // Nothing to say about the server, but the tab can still say what it is —
    // which is the more useful half when the network is the thing that is wrong.
    buildLine.classList.remove('stale');
    buildLine.textContent = PAGE_BUILD
      ? `Couldn't ask the server which version it is running. This tab is on ${PAGE_BUILD}.`
      : "Couldn't ask the server which version it is running.";
    buildNote.textContent = '';
    buildReload.classList.add('hidden');
    return;
  }

  // Only a *difference* is staleness. An unstamped page or an unidentifiable
  // build means the comparison cannot be made, and saying "out of date" then
  // would send somebody reloading after every deploy they had already got.
  const stale = Boolean(PAGE_BUILD) && Boolean(build.id) && build.id !== PAGE_BUILD;
  buildLine.classList.toggle('stale', stale);
  buildLine.textContent = stale
    ? `${buildSummary(build)} — this tab is still on ${PAGE_BUILD}`
    : buildSummary(build);
  buildNote.textContent = buildDetail(build);
  buildReload.classList.toggle('hidden', !stale);
}

buildReload?.addEventListener('click', () => {
  // A plain reload. The shell and app.js are both served with revalidation and the
  // asset URLs carry the build's mtime, so there is nothing here to bust by hand —
  // and a reload is the one action that cannot leave the page half-updated.
  location.reload();
});

$('#btn-settings').addEventListener('click', () => {
  $('#sheet').classList.remove('hidden');
  paintBuild();
});
document.querySelectorAll('[data-close-sheet]').forEach((el) =>
  el.addEventListener('click', () => $('#sheet').classList.add('hidden')),
);

$('#select-permission').value = state.settings.permissionMode;
$('#select-permission').addEventListener('change', (e) => {
  state.settings.permissionMode = e.target.value;
  saveSettings();
  toast('Applies to new chats');
});

/*
 * The voice, when there is one to choose. The row is hidden until
 * `paintVoicePicker` has an answer, so a deployment that cannot read aloud has no
 * dead control in its settings.
 */
$('#select-voice').addEventListener('change', (e) => {
  state.settings.voice = e.target.value;
  saveSettings();
  // Whatever is playing is in the old voice, and hearing the rest of a message in
  // that voice after choosing another one reads as the setting not working.
  stopSpeaking();
  paintVoiceHint();
});

$('#select-effort').value = state.settings.effort;
$('#select-effort').addEventListener('change', (e) => {
  state.settings.effort = e.target.value;
  saveSettings();
  toast('Applies to new chats');
});

// Keeping the display on costs battery, and on a browser without the API it
// cannot be done at all. Both facts belong next to the switch rather than in a
// document nobody reads on a phone.
// Guarded, not assumed: a browser holding a stale index.html would otherwise
// throw here and take the whole script down with it, which looks like the app
// failing to boot rather than one missing checkbox. The lock itself does not
// depend on the UI existing.
const keepAwakeToggle = $('#opt-keep-awake');
const keepAwakeHint = $('#keep-awake-hint');
if (keepAwakeToggle) {
  keepAwakeToggle.checked = keepAwakeWanted;
  keepAwakeToggle.disabled = !keepAwakeSupported();
  keepAwakeToggle.addEventListener('change', (e) => {
    setKeepAwake(e.target.checked);
    toast(e.target.checked ? 'Screen will stay awake' : 'Screen may sleep when idle');
  });
}
if (keepAwakeHint) {
  keepAwakeHint.textContent = keepAwakeSupported()
    ? 'Stops the display sleeping mid-dictation or mid-task. Costs battery, and '
      + 'Android may drop it in battery saver. Also applies to the editor.'
    : 'This browser has no screen wake lock. Raise the screen timeout in Android '
      + 'Settings › Display, or turn on Developer options › Stay awake while charging.';
}

// Same guarded pattern, and the same reason for being its own switch rather than
// a settings-blob field: the editor overlay reads this key too.
const polishToggle = $('#opt-polish');
const polishHint = $('#polish-hint');
if (polishToggle) {
  polishToggle.checked = polishWanted;
  polishToggle.addEventListener('change', (e) => {
    setPolishDictation(e.target.checked);
    toast(e.target.checked ? 'Dictation will be punctuated' : 'Dictation left as transcribed');
  });
}
if (polishHint) {
  polishHint.textContent =
    'Adds punctuation and capitals and fixes misheard names once you stop talking, '
    + 'using Claude Haiku on Bedrock — a second or two, and a few tokens per '
    + 'dictation. Your words are never rewritten, and a failure leaves the '
    + 'transcript exactly as it was. Also applies to the editor.';
}

/*
 * Notifications. Same guarded pattern as the two switches above, with one
 * difference that matters: this one asks the OS for something, and the OS only
 * answers once. A refused prompt cannot be re-asked from here at all, so the switch
 * has to explain where the setting now lives instead of silently doing nothing.
 *
 * The switch also sends a test notification when it goes on. Everything can be
 * correct on the server and still produce nothing on the phone — permission granted
 * to the browser but revoked for the site, a battery optimiser holding the worker
 * down, the app uninstalled from the home screen — and the alternative to a test is
 * finding out hours later that the thing you turned on does nothing.
 */
const pushToggle = $('#opt-push');
const pushHint = $('#push-hint');

function paintPushHint(state) {
  if (!pushHint) return;
  const text = {
    unsupported:
      'This browser cannot show notifications. On an iPhone, add the app to the home '
      + 'screen first; notifications only work from there.',
    blocked:
      'Notifications are blocked for this site, and only the browser can undo that: '
      + 'Chrome → the ⋮ menu → Site settings → Notifications. Android may also list '
      + 'this app separately under Settings › Apps.',
    off:
      'Buzzes when a session outside this app finishes a turn — the editor panel, or '
      + 'anything under tmux. Conversations in this app are not included: they already '
      + 'announce themselves on screen. Shows the project and the first line or so of '
      + "the answer; tapping it just dismisses it. You'll be asked for permission once.",
    on:
      'On for this device. You get one notification per conversation, replaced rather '
      + 'than stacked when the same session answers again, and nothing at all for '
      + 'anything older than ten minutes. Turn it off here to stop them.',
    stale:
      'On in this browser, but the box has no subscription for this device — the push '
      + 'service forgot it, which is how notifications stop without anything looking '
      + 'wrong. Reopening the app repairs it on its own; if this stays, turn the switch '
      + 'off and on again.',
  }[state];
  pushHint.textContent = text || '';
}

async function paintPushToggle() {
  if (!pushToggle) return;
  if (!pushSupported()) {
    pushToggle.checked = false;
    pushToggle.disabled = true;
    paintPushHint('unsupported');
    return;
  }
  if (Notification.permission === 'denied') {
    pushToggle.checked = false;
    pushToggle.disabled = true;
    paintPushHint('blocked');
    return;
  }
  const subscription = await pushSubscription();
  pushToggle.checked = Boolean(subscription);
  pushToggle.disabled = false;
  if (!subscription) {
    paintPushHint('off');
    return;
  }
  // The browser is subscribed; whether the *box* is reachable from here is a separate
  // question, and the only one the notification depends on.
  paintPushHint((await pushKnown(subscription)) === false ? 'stale' : 'on');
}

if (pushToggle) {
  paintPushToggle();
  pushToggle.addEventListener('change', async (e) => {
    const wanted = e.target.checked;
    if (!wanted) {
      pushToggle.disabled = true;
      await pushUnsubscribe();
      pushToggle.disabled = false;
      await paintPushToggle();
      toast('Notifications off');
      return;
    }

    // First, before any await: the prompt needs the tap that got here to still
    // count as user activation.
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      await paintPushToggle();
      toast(permission === 'denied' ? 'Notifications blocked in the browser' : 'Notifications not enabled');
      return;
    }

    pushToggle.disabled = true;
    try {
      let subscription = await pushSubscribe();
      let result = await pushTest(subscription);
      if (result.mine?.gone) {
        // The refusal is the discovery: nothing on this side can tell that the push
        // service has dropped an endpoint it still hands out. Replace it and retry
        // once, so the switch fixes this instead of reporting it.
        subscription = await pushSubscribe({ fresh: true });
        result = await pushTest(subscription);
      }
      toast(pushTestToast(result));
    } catch (err) {
      toast(`Could not turn on notifications: ${err.message}`);
    } finally {
      pushToggle.disabled = false;
      await paintPushToggle();
    }
  });
}

(async function initModels() {
  try {
    const res = await api('/api/models');
    const { models } = await res.json();
    const select = $('#select-model');
    select.innerHTML = models
      .map((m) => `<option value="${m.id}">${escapeHtml(m.label)}</option>`)
      .join('');
    select.value = state.settings.model;
    select.addEventListener('change', (e) => {
      state.settings.model = e.target.value;
      saveSettings();
      toast('Applies to new chats');
    });
  } catch {
    /* model list is cosmetic */
  }
})();

// --- ambient state ----------------------------------------------------------
/*
 * What every conversation on the box is doing, whether or not this device is
 * showing it.
 *
 * A pane with a socket hears about its own turns; this is for the ones without —
 * a cooled tab, and every row in the list. It is `/api/live` rather than
 * `/api/projects` because that route stats and reads every transcript to build
 * titles, which is fine once per screen and ruinous every few seconds.
 *
 * Only while the page is visible. A phone in a pocket with this app open must not
 * keep waking the box.
 */
const LIVE_POLL_MS = 6000;

async function pollLive() {
  if (document.visibilityState !== 'visible' || redirecting) return;
  let sessions;
  try {
    const res = await api('/api/live');
    if (!res.ok) return;
    ({ sessions } = await res.json());
  } catch {
    // A failed poll is a badge that is a few seconds stale. Nothing to say.
    return;
  }

  const byKey = new Map((sessions || []).map((s) => [convKey(s.cwd, s.sessionId), s]));
  for (const pane of panes.values()) {
    if (!pane.cold) continue;
    // A window with no conversation in it has nothing to be busy about, and no key
    // to look up — `convKey(cwd, null)` would match nothing and mark it in trouble.
    if (!pane.sessionId) continue;
    const live = byKey.get(convKey(pane.cwd, pane.sessionId));
    const wasBusy = pane.busy;
    pane.busy = Boolean(live?.busy);
    // A cooled tab whose process has gone can still be reopened — the transcript
    // is on disk — but it will be a fresh process, so the dot says so.
    pane.trouble = !live;
    if (wasBusy && !pane.busy) announce(pane, 'finished');
    paintChip(pane);
  }
  paintRowBadges(byKey);
}

// --- boot -------------------------------------------------------------------
/*
 * There is exactly one worker this app will tolerate: the push-only one at
 * /chat/sw.js, which has no `fetch` handler and therefore cannot wedge a
 * navigation. Anything else registered against this origin is from an older
 * version — including the caching worker that wedged the app once — and is torn
 * down here rather than left to control page loads.
 *
 * Nothing is registered at boot and no permission is asked for: the switch in
 * settings does that, on a tap. What runs here only repairs a subscription that
 * already exists. See the push section above.
 */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .getRegistrations()
    .then((regs) => regs.filter((r) => !r.scope.endsWith('/chat/')).forEach((r) => r.unregister()))
    .catch(() => {});
  if (window.caches) {
    caches.keys().then((keys) => keys.forEach((k) => caches.delete(k))).catch(() => {});
  }
  pushSyncSoon({ force: true });
  // And every time the app is looked at again. See pushSyncSoon: the subscription dies
  // while nobody is here, so a repair that only runs at boot never runs on the device
  // that needs it most — an installed app that is opened and backgrounded, never
  // started cold.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') pushSyncSoon();
  });
}

// Exposed so smoke-test.js can exercise event rendering without a live socket.
// Defaults to the pane on screen, which is what a caller without a pane means.
window.__handleEventForTest = (msg, pane) => handleEvent(msg, pane || activePane());
// Several projects open at once cannot be driven from a desktop browser either:
// what has to be proved is that a background window keeps rendering into its own
// thread, that switching carries the composer with it, that the tab cap cools an
// idle project rather than a working one, and that changing conversation inside a
// window neither stops the old one nor opens a second tab.
window.__panesForTest = {
  panes, state, openProject, openConversation, showConversation,
  activatePane, closePane, coolPane, makeRoomFor,
  renderTabs, paintChip, pollLive, paneKey, convKey, activePane, MAX_LIVE,
};
// The silent-dictation failure can't be reproduced from a desktop browser, so
// the test drives the interruption path directly instead.
window.__voiceForTest = {
  voice, stopVoice, startVoice, resetDictation, nextDictationAnchor,
  cleanTranscript, joinPhrases, enqueuePhrase, VAD, createPhraseCutter,
  // The cleanup pass and its switch: what has to be proved here is that it
  // rewrites the dictated span and nothing else, and that it gives up quietly
  // rather than pasting a stale sentence over something newly typed.
  polishDictation, setPolishDictation, sendMessage,
};
// The wake lock cannot be observed from a desktop browser either: whether the
// display sleeps is invisible to the page. The tests drive the reconciler.
// Losing a draft needs a page that goes away, which jsdom cannot do, so the test
// drives the save/restore pair directly instead.
// `draftKeyFor` comes along because which chat a draft belongs to is the half of
// this that can go wrong quietly — one key per pane, and a draft that surfaces
// under the wrong one puts somebody's words into a conversation they were not
// written for.
window.__draftForTest = {
  saveDraft, restoreDraft, writeDraft, draftKeyFor, moveDraft, LEGACY_DRAFT_KEY, input,
};
window.__screenForTest = {
  syncWakeLock, setKeepAwake, wakeLockHeld, wantsScreenAwake,
  get wanted() { return keepAwakeWanted; },
};
// Notifications are the one feature here whose failures are all silent and all on
// a phone: a switch that says "on" over a subscription the server never received,
// a subscription bound to a keypair that no longer exists, a hint that tells an
// Android user to look in iOS settings. None of it can be seen from a desktop
// browser, so the test stubs the three browser pieces and drives these.
window.__pushForTest = {
  paintPushToggle, pushSync, pushSubscription, pushSubscribe, pushUnsubscribe, pushKeyOf,
  pushTest, pushTestToast, pushKnown, pushSyncSoon,
};
// Reading aloud is server-side synthesis played through one unlocked element, and
// every interesting part of it — what a block button sends, what a refusal does, the
// fact that the nth button reads the nth block — is invisible from a desktop browser
// and inaudible from a test. So the pieces are driven directly.
window.__speechForTest = {
  loadVoices, decorateSpoken, fencedBlocks, speakableText, stopSpeaking, paintVoicePicker,
  speech, renderMarkdown, splitFences,
};
// The spoken conversation, for the same reason and more of it: this one holds a
// credential for a paid service, a live microphone and a peer connection, none of
// which a test can see from the outside.
window.__talkForTest = { talk, startTalking, endTalking, promptBefore, onTalkEvent };
// The version line, whose interesting state is the one a test can create and a
// browser cannot: a tab whose page was served by a build the server has since
// replaced. PAGE_BUILD comes along so the test can see what the shell was stamped
// with rather than infer it.
window.__buildForTest = { paintBuild, buildSummary, buildDetail, PAGE_BUILD };

// A device that wakes up may have been asleep for hours: iOS suspends timers
// and freezes sockets when the app is backgrounded, and the close event often
// never fires, so the client believes it is connected to a socket that is gone.
// On resume, verify the socket and rejoin if it died.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') {
    // The page is going away: locked screen, app switch, another tab. Speech
    // recognition and MediaRecorder are both suspended here, so dictation is
    // over whether or not we admit it. Admitting it is the whole point — the
    // alternative is the mic button still glowing over a recognizer that has
    // been deaf for ten minutes.
    if (voice.active) stopVoice({ reason: 'the app went to the background' });
    return;
  }

  // Every live pane, not just the one on screen: a background chat that lost its
  // socket while the phone was locked is exactly the one being waited on.
  for (const pane of panes.values()) {
    if (pane.cold || pane.closed) continue;
    const ws = pane.ws;
    const dead = !ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING;
    if (!dead) continue;
    // Drop the stale process handle: it may belong to a reaped conversation.
    // Rejoining by session id adopts whatever is actually running.
    pane.conversationId = null;
    pane.reconnectDelay = 500;
    connect(pane);
  }

  pollLive();
  if (!$('#screen-chat').classList.contains('active')) refreshList();
});

// Restore the projects this device had open, so a refresh or a cold PWA launch
// lands back in the same set of windows rather than on the list. Any conversation
// still running on the server — including work started from another device — is
// rejoined when its tab is looked at.
(function boot() {
  // Before anything else: the display should stop sleeping from the moment the
  // app is on screen, not from the moment a chat is open.
  startKeepAwake();

  const saved = loadOpenPanes();
  // Restored cold, every one of them: a project name, the conversation it was
  // showing and that chat's title, with no socket and no thread until the tab is
  // looked at. A launch that opened six sockets and rebuilt six transcripts would
  // be the slowest thing this app does, on the device least able to afford it —
  // and five of them would be for projects the user is not reading.
  for (const tab of saved.panes) {
    if (tab?.cwd) makePane(tab);
  }
  const active = saved.activeKey ? panes.get(saved.activeKey) : null;
  renderTabs();
  // Load the list behind the chat so going back is instant.
  refreshList();
  /*
   * Ask whether this box can read aloud, before anything is tapped.
   *
   * It has to be known in advance, not asked for on the tap: iOS will not let audio
   * begin after an await, so a read that had to check first would be a read that
   * never started. Nothing on screen waits for the answer — the controls appear on
   * the messages already rendered when it arrives.
   */
  loadVoices();
  if (active) activatePane(active);
  pollLive();
  setInterval(pollLive, LIVE_POLL_MS);
})();
