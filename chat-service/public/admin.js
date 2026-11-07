/*
 * The operations page: what is running on this box, and how to stop one of it.
 *
 * Dependency-free and separate from app.js on purpose. This is the page you open
 * when the chat is misbehaving, so it must not share a bundle with the chat — a
 * load-time error in one would otherwise take the other with it, and this is the
 * surface you would be using to find out why.
 *
 * Everything it shows comes from GET /api/admin/overview. See chat-service/admin.js
 * for where the numbers come from and why the broker is inspected from outside.
 */

const $ = (sel) => document.querySelector(sel);

// A deliberate copy of app.js's helper rather than a shared module: these pages
// load as plain scripts, and any session can expire while this one is polling. The
// failure it prevents — a dashboard showing stale rows forever after the cookie
// died — is the same one, so the handling is the same.
let redirecting = false;
async function api(url, options) {
  const res = await fetch(url, options);
  if (res.status === 401 && !redirecting) {
    redirecting = true;
    location.replace(`/login?next=${encodeURIComponent(location.pathname)}`);
    throw new Error('not signed in');
  }
  return res;
}

function toast(message, ms = 3600) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add('hidden'), ms);
}

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Both of these take kilobytes, which is what /proc, `df` and os.totalmem() all
// deal in. The thresholds are in kilobytes too: comparing against 1024 read as "a
// megabyte" and printed this box's 7.7 GB of memory as "7715 GB".
const mb = (kb) => (kb == null
  ? '—'
  : kb >= 1024 * 1024
    ? `${(kb / (1024 * 1024)).toFixed(kb >= 10 * 1024 * 1024 ? 0 : 1)} GB`
    : `${Math.round(kb / 1024)} MB`);
const rss = (kb) => (kb == null ? '—' : `${Math.round(kb / 1024)} MB`);

function duration(seconds) {
  if (seconds == null) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

/** Rendered into the same `.row` shape the chat list uses, so it reads as one app. */
function row({ title, sub, badges = [], action = null }) {
  const el = document.createElement('div');
  el.className = 'row admin-row';
  el.innerHTML = `
    <div class="row-main">
      <div class="row-title">${escapeHtml(title)}</div>
      <div class="row-sub">${sub}</div>
    </div>
    <div class="row-badges">${badges.join('')}</div>`;
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'kill-btn';
    btn.textContent = action.label;
    btn.addEventListener('click', action.onClick);
    el.appendChild(btn);
  }
  return el;
}

const badge = (text, kind = '') => `<span class="pill ${kind}">${escapeHtml(text)}</span>`;

/**
 * What a session is grouped and titled by. One expression, used by the rows, the
 * headings and the bulk stop, because a group whose name does not match the rows
 * under it would stop the wrong set.
 */
const groupKey = (s) =>
  s.project || s.cwd || (s.pid ? `pid ${s.pid}` : s.name) || 'unknown';

/**
 * Sessions banded by project, biggest band first.
 *
 * This is how the box actually gets into the state worth acting on: one project's
 * panel left open across a day, eight sessions deep, interleaved with another's.
 * Grouping them is what makes "stop that project's sessions" one tap.
 *
 * Biggest first, so the bands that get a heading come before the projects with a
 * single session — which are left as bare rows, because a heading over one row
 * only repeats the project name the row already carries.
 */
function byProject(sessions) {
  const groups = new Map();
  for (const s of sessions) {
    const key = groupKey(s);
    groups.set(key, [...(groups.get(key) || []), s]);
  }
  return [...groups].sort((a, b) => b[1].length - a[1].length);
}

/**
 * A project's heading inside a surface. Quieter than a row on purpose: it is a
 * place to act on the group, not another session.
 *
 * The button appears only from two sessions up. With one, the row's own Stop does
 * the same thing, and two buttons for one outcome is how you tap the wrong one.
 */
function groupHeading(kind, name, sessions) {
  const el = document.createElement('div');
  el.className = 'group-head';
  const stoppable = SURFACES[kind].targets(sessions).length;
  const totalKb = sessions.reduce((sum, s) => sum + (s.rssKb || 0), 0);
  el.innerHTML =
    `<span class="group-name">${escapeHtml(name)}</span>`
    + `<span class="group-note">${sessions.length} · ${mb(totalKb)}</span>`;
  if (stoppable > 1) {
    const btn = document.createElement('button');
    btn.className = 'kill-btn group-btn';
    btn.textContent = `${SURFACES[kind].verb} all ${stoppable}`;
    btn.addEventListener('click', () => stopAll(kind, name));
    el.appendChild(btn);
  }
  return el;
}

function empty(text) {
  const el = document.createElement('div');
  el.className = 'empty small';
  el.textContent = text;
  return el;
}

/**
 * Stop something.
 *
 * The two-step is the point, not friction to be smoothed away: the server refuses
 * anything that might hold a turn in flight and says why, and that reason becomes
 * the question. `force` is only ever sent as the answer to a refusal the user has
 * actually read.
 */
async function kill(kind, target, label) {
  const send = async (force) => {
    const res = await api('/api/admin/kill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, target, force }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  try {
    const first = await send(false);
    if (first.status === 200) {
      toast(`Stopped ${label}.`);
      refresh();
      return;
    }
    if (first.status !== 409) {
      toast(first.body.error || `Server returned ${first.status}`);
      return;
    }
    // The refusal, verbatim, as the question. It names what would be lost, which
    // is the only thing that makes the answer meaningful.
    if (!confirm(`${first.body.error}\n\nStop it anyway?`)) return;
    const forced = await send(true);
    if (forced.status === 200) {
      toast(`Stopped ${label}.`);
      refresh();
    } else {
      toast(forced.body.error || `Server returned ${forced.status}`);
    }
  } catch (err) {
    if (!redirecting) toast(err.message);
  }
}

/**
 * The three surfaces, as the bulk stop needs to see them: what one of these is
 * called, which group it belongs to, and what the server would refuse it for.
 *
 * That last field is the one that earns this table. A bulk stop cannot ask per row
 * — asking fifteen times is the thing it exists to avoid — so it aggregates the
 * same facts the fifteen refusals would have carried and puts them in the single
 * question it does ask. These reasons therefore mirror the rules in
 * `chat-service/admin.js`'s `kill()`, and must not drift from them: the server
 * still enforces them, and still refuses anything this page gets wrong.
 */
const SURFACES = {
  chat: {
    noun: 'chat conversation',
    verb: 'Stop',
    risk: 'a turn in flight cannot be recovered',
    targets: (list) => list.map((s) => ({
      target: s.id,
      group: groupKey(s),
      live: s.busy ? 'working right now' : null,
    })),
  },
  broker: {
    noun: 'editor panel session',
    verb: 'Stop',
    risk: 'a turn in flight cannot be recovered',
    targets: (list) => list.map((s) => ({
      target: s.pid,
      group: groupKey(s),
      // A probe has no reason at all, which is why a page full of them asks the
      // short question. `working` is null when the broker could not be asked, and
      // null is not a reason to claim anything.
      //
      // Waiting on an answer is named first and separately, because it is the one
      // reason the confirmation can talk you out of: "working right now" is a
      // machine you would be interrupting, "waiting for you" is a machine that
      // would still be there when you get back to it.
      live: s.awaiting
        ? 'waiting for an answer from you'
        : s.working ? 'working right now' : s.clients ? 'open on a device' : null,
    })),
  },
  tmux: {
    noun: 'terminal session',
    verb: 'End',
    risk: 'scrollback cannot come back',
    // Only what `cc` started, matching the row buttons: the server refuses the
    // rest, and a bulk action must not quietly try things that cannot work.
    targets: (list) => list.filter((s) => s.isClaudeSession).map((s) => ({
      target: s.name,
      group: groupKey(s),
      live: s.attachedClients ? 'open on a device' : 'holding its scrollback',
    })),
  },
};

/** "2 working right now, 1 open on a device" — the refusals, counted. */
function liveSummary(targets) {
  const counts = new Map();
  for (const t of targets) if (t.live) counts.set(t.live, (counts.get(t.live) || 0) + 1);
  return [...counts].map(([reason, n]) => `${n} ${reason}`).join(', ');
}

let stopping = false;

/**
 * Stop a whole surface, or one project's sessions on it.
 *
 * The list comes from a fresh `overview()` rather than from the rows on screen.
 * Polling stops while the tab is hidden, so what is rendered can be minutes old,
 * and this is the one place where acting on a stale list means killing a turn that
 * started after it was drawn.
 *
 * Then it is the ordinary per-item kill, N times, with `force` — the answer the
 * user just gave to the aggregate question. No new route: `kill()` re-reads the
 * process table and re-checks parentage for every pid it signals, and a bulk stop
 * is not a reason to give up the one check that keeps a pid from the client from
 * becoming a signal to an arbitrary process.
 */
async function stopAll(kind, group = null) {
  const surface = SURFACES[kind];
  if (!surface || stopping) return;
  try {
    const res = await api('/api/admin/overview');
    if (!res.ok) throw new Error(`server returned ${res.status}`);
    const data = await res.json();
    const targets = surface.targets(data.surfaces[kind] || [])
      .filter((t) => group === null || t.group === group);
    if (!targets.length) {
      toast('Nothing left to stop.');
      refresh();
      return;
    }

    const plural = targets.length === 1 ? '' : 's';
    const summary = liveSummary(targets);
    const question =
      `${surface.verb} all ${targets.length} ${group ? `${group} ` : ''}${surface.noun}${plural}?`
      + (summary ? `\n\n${summary} — ${surface.risk}.` : '');
    if (!confirm(question)) return;

    stopping = true;
    toast(`Stopping ${targets.length} ${surface.noun}${plural}…`, 60_000);
    let stopped = 0;
    let lastError = null;
    for (const t of targets) {
      const one = await api('/api/admin/kill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, target: t.target, force: true }),
      });
      if (one.status === 200) stopped += 1;
      else lastError = (await one.json().catch(() => ({}))).error || `server returned ${one.status}`;
    }
    // Partial is the normal outcome, not an error: something on this list can exit
    // on its own between the overview and its turn in the loop.
    toast(stopped === targets.length
      ? `Stopped ${stopped} ${surface.noun}${plural}.`
      : `Stopped ${stopped} of ${targets.length} — ${lastError}`);
    refresh();
  } catch (err) {
    if (!redirecting) toast(err.message);
  } finally {
    stopping = false;
  }
}

async function reap() {
  try {
    const res = await api('/api/admin/reap', { method: 'POST' });
    const { stopped, freedKb } = await res.json();
    toast(stopped ? `Stopped ${stopped} probe${stopped === 1 ? '' : 's'}, freed ${rss(freedKb)}.` : 'No probes to stop.');
    refresh();
  } catch (err) {
    if (!redirecting) toast(err.message);
  }
}

function renderFindings(findings) {
  const host = $('#findings');
  host.innerHTML = '';
  for (const f of findings) {
    const el = document.createElement('div');
    el.className = `finding ${f.level}`;
    el.innerHTML =
      `<div class="finding-text">${escapeHtml(f.text)}</div>` +
      (f.detail ? `<div class="finding-detail">${escapeHtml(f.detail)}</div>` : '');
    if (f.action === 'reap') {
      const btn = document.createElement('button');
      btn.className = 'kill-btn';
      btn.textContent = 'Reap';
      btn.addEventListener('click', reap);
      el.appendChild(btn);
    }
    host.appendChild(el);
  }
}

function renderHost(host) {
  const el = $('#host');
  const memPct = host.memory.percent ?? 0;
  const diskPct = host.disk?.percent ?? 0;
  el.innerHTML = `
    <div class="card">
      <div class="card-label">Memory</div>
      <div class="card-value">${memPct}%</div>
      <div class="meter"><span style="width:${Math.min(memPct, 100)}%" class="${memPct >= 85 ? 'hot' : ''}"></span></div>
      <div class="card-note">${mb(host.memory.totalKb - host.memory.freeKb)} of ${mb(host.memory.totalKb)}</div>
    </div>
    <div class="card">
      <div class="card-label">Disk</div>
      <div class="card-value">${host.disk ? `${diskPct}%` : '—'}</div>
      <div class="meter"><span style="width:${Math.min(diskPct, 100)}%" class="${diskPct >= 85 ? 'hot' : ''}"></span></div>
      <div class="card-note">${host.disk ? `${mb(host.disk.usedKb)} of ${mb(host.disk.totalKb)}` : 'unknown'}</div>
    </div>
    <div class="card">
      <div class="card-label">Load</div>
      <div class="card-value">${host.load[0]}</div>
      <div class="card-note">1m · 5m ${host.load[1]} · 15m ${host.load[2]}</div>
    </div>
    <div class="card">
      <div class="card-label">Uptime</div>
      <div class="card-value">${duration(host.uptimeSeconds)}</div>
      <div class="card-note">${escapeHtml(host.hostname)}</div>
    </div>
    ${buildCard(host.build)}`;
}

/**
 * Which payload this box is running, as the last card in the Host row.
 *
 * Here because the two questions are the same one: half of "why is this box
 * behaving oddly" is "is it even running what I think it is", and the answer used
 * to require an SSM shell. A deploy that reported success while shipping a stale
 * tree looks exactly like a feature that does not work.
 *
 * Tolerant of a `build` that is not there at all: this page polls a server that a
 * deploy is in the middle of restarting, and an older one does not send this
 * field. A missing card beats a dashboard that throws in its first render.
 */
function buildCard(build) {
  if (!build) return '';
  const id = build.commit ? `${build.commit}${build.dirty ? '+' : ''}` : 'unstamped';
  const note = [
    build.version ? `v${build.version}` : '',
    build.builtAt ? `deployed ${duration((Date.now() - build.builtAt) / 1000)} ago` : '',
    build.dirty ? 'from a tree with uncommitted changes' : '',
    build.subject,
  ]
    .filter(Boolean)
    .join(' · ');
  return `
    <div class="card full">
      <div class="card-label">Build</div>
      <div class="card-value">${escapeHtml(id)}</div>
      <div class="card-note">${escapeHtml(note)}</div>
    </div>`;
}

/**
 * The `autoUpdate` setting and what it has done, from the updater's own
 * `status --json` (scripts/triplec-update.mjs, via chat-service/admin.js).
 *
 * Read-only on purpose. The setting lives in the deployment's config file, which
 * outranks the box: a value changed here would be overwritten by the next deploy,
 * so this page says where to change it rather than pretending it can.
 */
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const when = (ms) => {
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString()
    ? clock(ms)
    : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${clock(ms)}`;
};
const ago = (ms) => `${duration((Date.now() - ms) / 1000)} ago`;
const repoName = (url) => String(url || '').replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
const MODE_NOTE = {
  off: 'updates are by hand',
  notify: 'pushes a notification when one is ready; never installs',
  install: 'installs by itself, tests first, rolls back on failure',
};

function updatesCards(u) {
  if (u.error) {
    return `
    <div class="card full">
      <div class="card-label">Auto-update</div>
      <div class="card-value">unknown</div>
      <div class="card-note">${escapeHtml(u.error)}</div>
    </div>`;
  }
  const s = u.settings || {};
  const on = s.mode !== 'off';
  const card = (label, value, note = '') => `
    <div class="card">
      <div class="card-label">${escapeHtml(label)}</div>
      <div class="card-value">${escapeHtml(value)}</div>
      <div class="card-note">${escapeHtml(note)}</div>
    </div>`;

  // Where things stand, in one line: the question this section exists to answer.
  const installed = u.installed ? `${u.installed.commit}${u.installed.dirty ? '+' : ''}` : 'unknown';
  let state;
  let stateNote;
  if (u.current) {
    state = `up to date at ${installed}`;
    stateNote = u.tip?.seenAt ? `${s.branch} tip, seen ${ago(u.tip.seenAt)}` : '';
  } else if (u.tip) {
    state = `${installed} → ${u.tip.sha.slice(0, 7)}`;
    stateNote = u.soakingUntil
      ? `soaking until ${when(u.soakingUntil)}`
      : u.last?.outcome === 'waiting' || u.last?.outcome === 'ready' ? u.last.detail : `${s.branch} has moved on`;
  } else {
    state = installed;
    stateNote = 'the branch has not been checked yet';
  }
  const last = u.last
    ? `last run ${ago(u.last.at)}: ${u.last.outcome}${u.last.outcome === 'installed' ? ` ${u.last.detail}` : ''}`
    : 'no update has run on this box';

  return `
    <div class="card full">
      <div class="card-label">Auto-update</div>
      <div class="card-value">${escapeHtml(s.mode)}</div>
      <div class="card-note">${escapeHtml([
        MODE_NOTE[s.mode],
        `follows ${s.branch} of ${repoName(s.repo)}`,
        on && u.nextCheckAt ? `next check ${clock(u.nextCheckAt)}` : '',
      ].filter(Boolean).join(' · '))}</div>
    </div>
    <div class="card full">
      <div class="card-label">Status</div>
      <div class="card-value">${escapeHtml(state)}</div>
      <div class="card-note">${escapeHtml([stateNote, last].filter(Boolean).join(' · '))}</div>
    </div>
    ${card('Checks', `${s.checkMinutes} min`, on ? `timer ${u.timer?.active ? 'running' : u.timer?.state || 'unknown'}` : 'while mode is on')}
    ${card('Soak', `${s.soakHours} h`, s.soakHours ? 'on the branch before it is taken' : 'takes the tip')}
    ${card('Window', s.window || 'any time', s.window ? (u.platform === 'aws' ? 'UTC' : 'local time') : 'installs whenever ready')}
    ${card('Idle wait', `${s.idleMinutes} min`, s.idleMinutes ? 'with no conversation writing' : 'does not wait')}
    <div class="card full">
      <div class="card-label">Change</div>
      <div class="card-note">${escapeHtml(u.platform === 'aws'
        ? 'autoUpdate in the deploying checkout’s triplec.config.json, then ./deploy.sh --app-only. '
        : 'autoUpdate in ~/.config/triplec/config.json, then deploy/host/install.sh. ')}Update now: <code>${escapeHtml(u.command)}</code> · push ${s.push ? 'on' : 'off'}</div>
    </div>`;
}

function renderUpdates(updates) {
  const el = $('#updates');
  const show = Boolean(updates);
  el.classList.toggle('hidden', !show);
  $('#updates-label').classList.toggle('hidden', !show);
  el.innerHTML = show ? updatesCards(updates) : '';
}

function renderUnits(units) {
  const el = $('#units');
  el.innerHTML = units
    .map(
      (u) => `
      <div class="unit ${u.active ? '' : 'down'}">
        <span class="dot"></span>
        <span class="unit-name">${escapeHtml(u.name)}</span>
        <span class="unit-state">${escapeHtml(u.active ? u.sub || 'active' : u.state)}</span>
        <span class="unit-mem">${u.memoryBytes ? rss(u.memoryBytes / 1024) : ''}</span>
      </div>`,
    )
    .join('');
}

function renderChat(sessions) {
  const el = $('#surface-chat');
  el.innerHTML = '';
  if (!sessions.length) {
    el.appendChild(empty('No chat conversations running.'));
    return;
  }
  for (const [name, group] of byProject(sessions)) {
    if (group.length > 1) el.appendChild(groupHeading('chat', name, group));
    for (const s of group) el.appendChild(chatRow(s));
  }
}

function chatRow(s) {
  const badges = [];
  if (s.busy) badges.push(badge('working', 'hot'));
  if (!s.alive) badges.push(badge('process gone', 'warn'));
  return row({
    title: groupKey(s),
    sub:
      `${escapeHtml(s.sessionId ? `${s.sessionId.slice(0, 8)}…` : 'starting')} · ` +
      `${rss(s.rssKb)} · ${duration(s.ageSeconds)} · ${escapeHtml(s.permissionMode)}`,
    badges,
    action: { label: 'Stop', onClick: () => kill('chat', s.id, `the ${s.project} chat`) },
  });
}

function renderBroker(sessions) {
  const el = $('#surface-broker');
  el.innerHTML = '';
  if (!sessions.length) {
    el.appendChild(empty('No editor conversations running.'));
    return;
  }
  for (const [name, group] of byProject(sessions)) {
    if (group.length > 1) el.appendChild(groupHeading('broker', name, group));
    // Probes last, within the project: they are noise until you want to reap them,
    // and a live conversation is what you came here to look at.
    const sorted = [...group].sort((a, b) => Number(a.probe) - Number(b.probe));
    for (const s of sorted) el.appendChild(brokerRow(s));
  }
}

/**
 * What the wait is about, in the words the person answering it will recognise.
 *
 * A permission prompt is best named by its tool — "needs you · Bash" is the whole
 * story. A question is not: the broker names it `AskUserQuestion` because that is
 * what the tool is called, which tells a reader nothing they want, so it is spelled
 * out instead. Never the request's input, here or in the API: this page is visible
 * to anyone who can reach it, and a tool's arguments are the conversation's content.
 */
function askedAbout(s) {
  if (s.awaiting === 'question') return 'a question';
  return s.awaitingName || 'a tool';
}

function brokerRow(s) {
  const badges = [];
  if (s.probe) badges.push(badge('idle probe', 'warn'));
  // Only the broker can say any of these, and only about a process it still holds.
  // They are absent rather than false when it could not be asked.
  //
  // `awaiting` replaces `working` rather than sitting beside it. Both are true — a
  // conversation stopped at a permission prompt is mid-turn, and the broker is right
  // to keep saying so — but a row badged "working" and "needs you" at once makes the
  // reader pick which one to believe, and the answer they came for is the second.
  if (s.awaiting) badges.push(badge(`needs you · ${askedAbout(s)}`, 'ask'));
  else if (s.working) badges.push(badge('working', 'hot'));
  if (s.clients) badges.push(badge(`${s.clients} attached`));
  return row({
    title: groupKey(s),
    sub:
      `${escapeHtml(s.sessionId ? `${s.sessionId.slice(0, 8)}…` : 'no session')} · ` +
      `pid ${s.pid} · ${rss(s.rssKb)} · ${duration(s.ageSeconds)}` +
      // How long it has been stuck, next to how long it has been alive: an hour-old
      // session waiting ten seconds is fine, a ten-minute wait is someone's tab.
      (s.awaiting ? ` · waiting ${duration(s.awaitingMs == null ? null : s.awaitingMs / 1000)}` : ''),
    badges,
    action: {
      label: 'Stop',
      onClick: () => kill('broker', s.pid, s.probe ? 'the probe' : `the ${s.project} panel session`),
    },
  });
}

function renderTmux(sessions) {
  const el = $('#surface-tmux');
  el.innerHTML = '';
  if (!sessions.length) {
    el.appendChild(empty('No tmux sessions.'));
    return;
  }
  for (const s of sessions) {
    const badges = [];
    if (s.attachedClients) badges.push(badge(`${s.attachedClients} attached`, 'hot'));
    if (s.hasClaude) badges.push(badge('claude'));
    if (s.serverInOwnUnit === false) badges.push(badge('wrong cgroup', 'warn'));
    el.appendChild(
      row({
        title: s.project || s.name,
        sub: `${rss(s.rssKb)} · ${s.createdAt ? duration((Date.now() - s.createdAt) / 1000) : '—'} old`,
        badges,
        // Only what `cc` started. Someone's own shell on this server is shown
        // because memory is memory, but the server refuses to kill it and there is
        // no reason to offer a button that cannot work.
        action: s.isClaudeSession
          ? { label: 'End', onClick: () => kill('tmux', s.name, `the ${s.project} session`) }
          : null,
      }),
    );
  }
}

/**
 * The whole-surface button, in that surface's label.
 *
 * Shown only for two or more sessions spread across two or more projects. With one
 * session the row's own button is the same action; with one project the band
 * heading's is — and two buttons that do the same thing, a thumb-width apart, is
 * how you stop the wrong set.
 */
function setStopAll(kind, sessions) {
  const btn = $(`#stop-all-${kind}`);
  const targets = SURFACES[kind].targets(sessions);
  const projects = new Set(targets.map((t) => t.group));
  btn.classList.toggle('hidden', targets.length < 2 || projects.size < 2);
  btn.textContent = `${SURFACES[kind].verb} all ${targets.length}`;
}

let failures = 0;

async function refresh() {
  try {
    const res = await api('/api/admin/overview');
    if (!res.ok) throw new Error(`server returned ${res.status}`);
    const data = await res.json();
    failures = 0;

    renderFindings(data.findings);
    renderHost(data.host);
    renderUpdates(data.updates);
    renderUnits(data.units);
    renderChat(data.surfaces.chat);
    renderBroker(data.surfaces.broker);
    renderTmux(data.surfaces.tmux);
    for (const kind of Object.keys(SURFACES)) setStopAll(kind, data.surfaces[kind]);

    const total =
      data.surfaces.chat.length + data.surfaces.broker.length + data.surfaces.tmux.length;
    $('#admin-sub').textContent = `${total} session${total === 1 ? '' : 's'} · updated ${new Date(data.generatedAt).toLocaleTimeString()}`;
    $('#admin-footer').textContent =
      'Stopping a conversation here does not delete its transcript, so it can be '
      + 'resumed from the chat list afterwards. A deploy restarts claude-chat, which '
      + 'ends every chat conversation on this page — the editor and terminal '
      + 'surfaces survive it.';
  } catch (err) {
    if (redirecting) return;
    failures += 1;
    $('#admin-sub').textContent = `couldn't load — ${err.message}`;
    // One failed poll on a phone is a tunnel, not an outage. Say so quietly, and
    // only shout once it is clearly not coming back.
    if (failures === 3) toast("Can't reach the server.");
  }
}

$('#btn-refresh').addEventListener('click', refresh);
for (const kind of Object.keys(SURFACES)) {
  $(`#stop-all-${kind}`).addEventListener('click', () => stopAll(kind));
}

// Polled rather than pushed. The numbers here are cheap (one `ps`, one `df`, five
// `systemctl show`) but they are not free, so this only runs while the page is
// actually being looked at — a phone in a pocket with this tab open must not keep
// waking the box.
const POLL_MS = 5000;
let timer = null;
function startPolling() {
  stopPolling();
  timer = setInterval(() => {
    if (document.visibilityState === 'visible') refresh();
  }, POLL_MS);
}
function stopPolling() {
  if (timer) clearInterval(timer);
  timer = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    refresh();
    startPolling();
  } else {
    stopPolling();
  }
});

// Exposed for admin-test.js, which boots this file in jsdom for the same reason
// smoke-test.js boots app.js: a runtime error at load leaves a page that looks
// like the server is down, and this is the page you would be checking.
window.__adminForTest = { refresh, kill, stopAll, reap, renderFindings, buildCard, updatesCards, duration, rss };

refresh();
startPolling();
