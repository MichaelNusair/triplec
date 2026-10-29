/*
 * The mux: TripleC's desktop surface.
 *
 * A laptop with a big screen wants what cmux gives a Mac — every agent down the
 * side with a light that says which one needs you, and several of them on screen at
 * once. This page is that, for this box, in a browser.
 *
 * A pane is one of two things, and both are frames on something that already
 * exists rather than a second implementation of it:
 *
 *   - a chat: the chat app (`/chat/?embed=1`), talking to claude-chat.service over
 *     the same socket the phone uses. Open the phone afterwards and the
 *     conversation is in its list, labelled with its slot, exactly where it was.
 *   - a terminal: the real Claude Code CLI (`/chat/term?embed=1`), in the tmux
 *     session `cc` keeps for that slot — claude-tmux.service's, not this tab's.
 *     `cc <project>/slot-N` from any other terminal is the same session.
 *
 * Either way the work belongs to the box. Shut the laptop mid-turn and the turn
 * finishes.
 *
 * Each runs in a worktree slot — `<project>/.claude/worktrees/slot-N`, see slots.js
 * — so eight agents on one project are eight checkouts rather than eight writers in
 * one. A slot is refreshed (fast-forwarded, never reset) when something new starts
 * in it, and only when nothing in it would be lost.
 *
 * Nothing here stops anything. Closing a pane, changing the layout to fewer panes,
 * or closing the tab all leave the work running; stopping one is /chat/admin's job,
 * where it asks first.
 */
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);

  const STORE_KEY = 'triplec-mux';
  const LAYOUTS = { 1: [1, 1], 2: [2, 1], 3: [3, 1], 4: [2, 2], 6: [3, 2], 8: [4, 2] };
  const KINDS = ['chat', 'terminal'];
  const LIVE_POLL_MS = 5000;
  const SLOTS_POLL_MS = 15000;
  const PROJECTS_POLL_MS = 60000;

  const state = {
    projects: [],              // /api/projects
    slots: new Map(),          // project name -> /api/slots answer
    live: new Map(),           // `${cwd}|${sessionId}` -> { busy }
    busyCwds: new Set(),       // directories with a chat turn in flight, from /api/live
    attention: new Set(),      // directories whose turn ended while nobody watched
    expanded: new Set(),
    filter: '',
    layout: 2,
    focus: 0,
    panes: [],                 // see emptyPane
    alerts: false,
    newKind: 'chat',           // what a + opens
  };

  function emptyPane() {
    return {
      kind: 'chat',    // 'chat' | 'terminal'
      project: null,   // project name, as /api/slots and /api/projects know it
      slot: null,      // 1-8, or 0 for the project's own checkout
      cwd: null,
      sessionId: null, // a chat's; a terminal is named by its slot
      title: '',
      busy: false,
      sub: '',
      trouble: false,
      attention: false,
      note: '',        // what preparing the slot said, when it kept something
      el: null,
      frame: null,
      src: '',
    };
  }

  // --- persistence ----------------------------------------------------------
  // This laptop's layout, and only that. Which conversations exist is the box's to
  // say; this remembers which of them were on screen where.
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        layout: state.layout,
        focus: state.focus,
        expanded: [...state.expanded],
        alerts: state.alerts,
        newKind: state.newKind,
        panes: state.panes.map((p) => ({
          kind: p.kind, project: p.project, slot: p.slot, cwd: p.cwd, sessionId: p.sessionId, title: p.title,
        })),
      }));
    } catch {
      /* private mode: the layout is lost on reload, the conversations are not */
    }
  }

  function load() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    } catch {
      saved = null;
    }
    state.layout = LAYOUTS[saved?.layout] ? Number(saved.layout) : 2;
    state.expanded = new Set(Array.isArray(saved?.expanded) ? saved.expanded : []);
    state.alerts = Boolean(saved?.alerts) && 'Notification' in window && Notification.permission === 'granted';
    state.newKind = KINDS.includes(saved?.newKind) ? saved.newKind : 'chat';
    const panes = Array.isArray(saved?.panes) ? saved.panes : [];
    state.panes = [];
    for (let i = 0; i < 8; i++) {
      const pane = emptyPane();
      const s = panes[i];
      if (s?.cwd && s?.project) Object.assign(pane, {
        // A layout saved before terminals existed has chats in it, and says nothing.
        kind: KINDS.includes(s.kind) ? s.kind : 'chat',
        project: s.project, slot: Number.isInteger(s.slot) ? s.slot : null,
        cwd: s.cwd, sessionId: s.sessionId || null, title: s.title || '',
      });
      state.panes.push(pane);
    }
    state.focus = Math.min(Number(saved?.focus) || 0, paneCount() - 1);
  }

  const paneCount = () => LAYOUTS[state.layout][0] * LAYOUTS[state.layout][1];

  // --- the network ----------------------------------------------------------
  async function api(url, options) {
    const res = await fetch(url, { credentials: 'same-origin', ...options });
    if (res.status === 401) {
      location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
      throw new Error('signed out');
    }
    return res;
  }

  async function loadProjects() {
    try {
      const res = await api('/api/projects');
      if (!res.ok) throw new Error(`server returned ${res.status}`);
      state.projects = (await res.json()).projects || [];
    } catch (err) {
      if (!state.projects.length) {
        $('#mux-projects').innerHTML = `<div class="mux-empty">Couldn't load projects — ${escapeHtml(err.message)}.</div>`;
      }
      return;
    }
    // Every project with a pane open is one the user is working in, so it is open
    // in the sidebar too.
    for (const pane of state.panes) if (pane.project) state.expanded.add(pane.project);
    renderSidebar();
    await Promise.all([...state.expanded].map(loadSlots));
  }

  async function loadSlots(name) {
    try {
      const res = await api(`/api/slots?project=${encodeURIComponent(name)}`);
      if (!res.ok) return;
      state.slots.set(name, await res.json());
      renderSidebar();
    } catch {
      /* a stale slot list is a few seconds old; the next poll repairs it */
    }
  }

  async function pollLive() {
    if (document.visibilityState !== 'visible') return;
    let sessions;
    try {
      const res = await api('/api/live');
      if (!res.ok) return;
      ({ sessions } = await res.json());
    } catch {
      return;
    }
    const busy = new Set();
    state.live = new Map();
    for (const s of sessions || []) {
      state.live.set(`${s.cwd}|${s.sessionId}`, s);
      if (s.busy) busy.add(s.cwd);
    }
    // A turn that ended in a directory no pane is showing: that slot wants you.
    // Panes say so for themselves, from the frame, and faster.
    for (const cwd of state.busyCwds) {
      if (!busy.has(cwd) && !visiblePanes().some((p) => p.cwd === cwd)) flag(cwd, null);
    }
    state.busyCwds = busy;
    renderSidebar();
    pollTerminals();
  }

  /*
   * Whether the Claude in each terminal pane is working.
   *
   * A chat pane is told by its frame; a terminal cannot be, because what runs in it
   * is the CLI itself and the page only sees its bytes. So it is asked the way the
   * editor's status button asks about a tmux session: /api/claude-status reads the
   * newest transcript in that directory. Only for panes on screen — that is where a
   * ring can be seen.
   */
  async function pollTerminals() {
    await Promise.all(visiblePanes().filter((p) => p.kind === 'terminal' && p.cwd).map(async (pane) => {
      let status;
      try {
        const res = await api(`/api/claude-status?cwd=${encodeURIComponent(pane.cwd)}`);
        if (!res.ok) return;
        status = await res.json();
      } catch {
        return;
      }
      // The project's own checkout reads every worktree's transcripts as its own; an
      // answer about a slot is not an answer about this terminal.
      if (pane.slot === 0 && status.worktree) return;
      const wasBusy = pane.busy;
      pane.busy = status.state === 'working';
      if (status.title) pane.title = status.title;
      const waiting = status.state === 'question';
      if ((wasBusy && !pane.busy) || (waiting && !pane.attention && wasBusy)) {
        if (!watched(pane)) flag(pane.cwd, pane);
      }
      paintPane(pane);
    }));
  }

  // --- attention ------------------------------------------------------------
  /*
   * The ring. Something whose turn ends while nobody is looking at it is the one
   * waiting for a person, which is the thing a screen of eight agents most needs to
   * say. Cleared by looking: focusing its pane, or opening its slot.
   */
  function flag(cwd, pane) {
    if (pane) pane.attention = true;
    state.attention.add(cwd);
    paintTitle();
    renderSidebar();
    if (pane) paintPane(pane);
    if (state.alerts && document.visibilityState !== 'visible') {
      const label = labelFor(cwd);
      try {
        const n = new Notification(`${label}: finished`, {
          body: pane?.title || 'Waiting for you',
          tag: `mux:${cwd}`,
        });
        n.onclick = () => {
          window.focus();
          const index = state.panes.findIndex((p) => p.cwd === cwd);
          if (index >= 0 && index < paneCount()) focusPane(index);
          n.close();
        };
      } catch {
        /* the ring and the title are still there */
      }
    }
  }

  function unflag(cwd) {
    if (!cwd) return;
    state.attention.delete(cwd);
    for (const pane of state.panes) if (pane.cwd === cwd) pane.attention = false;
    paintTitle();
  }

  /** Whether a pane is the one being looked at, right now. */
  function watched(pane) {
    return state.panes.indexOf(pane) === state.focus && document.visibilityState === 'visible' && document.hasFocus();
  }

  function paintTitle() {
    const n = state.attention.size;
    const base = document.title.replace(/^\(\d+\) /, '');
    document.title = n ? `(${n}) ${base}` : base;
  }

  function labelFor(cwd) {
    const pane = state.panes.find((p) => p.cwd === cwd);
    if (pane?.project) return `${pane.project} · ${slotLabel(pane.slot)}`;
    const m = /\/([^/]+)\/\.claude\/worktrees\/([^/]+)$/.exec(cwd || '');
    return m ? `${m[1]} · ${m[2]}` : String(cwd || '').split('/').pop();
  }

  const slotLabel = (n) => (n ? `slot ${n}` : 'main checkout');
  const kindLabel = (kind) => (kind === 'terminal' ? 'terminal' : 'chat');

  // --- the sidebar ----------------------------------------------------------
  function projectByName(name) {
    return state.projects.find((p) => p.name === name) || null;
  }

  /** The newest conversation recorded in a directory, from /api/projects. */
  function latestSession(project, cwd) {
    const sessions = (projectByName(project)?.sessions || [])
      .filter((s) => (s.cwd || projectByName(project).path) === cwd)
      .sort((a, b) => b.mtime - a.mtime);
    return sessions[0] || null;
  }

  function placesOf(name) {
    const project = projectByName(name);
    if (!project) return [];
    const slots = state.slots.get(name);
    const places = [{
      n: 0, cwd: project.path, created: true, dirty: 0, unpushed: 0, held: false, busy: false, elsewhere: 0,
      sessions: [], terminal: Boolean(slots?.rootTerminal),
    }];
    if (slots?.enabled) places.push(...slots.slots);
    return places;
  }

  /** Processes in a place that neither this service nor its own terminal explain. */
  const strangers = (place) => Math.max(0, (place.elsewhere || 0) - (place.terminal ? 1 : 0));

  function dotFor(place) {
    const busy = place.busy || state.busyCwds.has(place.cwd)
      || visiblePanes().some((p) => p.cwd === place.cwd && p.busy);
    if (state.attention.has(place.cwd)) return 'attention';
    if (busy) return 'working';
    if (strangers(place)) return 'elsewhere';
    const live = [...state.live.values()].some((s) => s.cwd === place.cwd);
    return live || place.held || place.terminal ? 'live' : 'idle';
  }

  function renderSidebar() {
    const body = $('#mux-projects');
    if (!state.projects.length) return;
    const filter = state.filter.toLowerCase();
    body.innerHTML = '';
    for (const project of state.projects) {
      if (filter && !project.name.toLowerCase().includes(filter)) continue;
      const open = state.expanded.has(project.name);
      const group = document.createElement('section');
      group.className = 'mux-project';
      group.dataset.project = project.name;

      const head = document.createElement('div');
      head.className = 'mux-project-head';
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'mux-project-name';
      toggle.setAttribute('aria-expanded', String(open));
      const working = placesOf(project.name).filter((p) => dotFor(p) === 'working').length;
      const waiting = placesOf(project.name).filter((p) => dotFor(p) === 'attention').length;
      toggle.innerHTML = `<span class="mux-caret">${open ? '▾' : '▸'}</span><span class="mux-pname"></span>`
        + (waiting ? `<span class="mux-count attention">${waiting}</span>` : '')
        + (working ? `<span class="mux-count working">${working}</span>` : '');
      $('.mux-pname', toggle).textContent = project.name;
      toggle.addEventListener('click', () => {
        if (state.expanded.has(project.name)) state.expanded.delete(project.name);
        else {
          state.expanded.add(project.name);
          loadSlots(project.name);
        }
        save();
        renderSidebar();
      });
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'mux-add';
      add.title = `New ${kindLabel(state.newKind)} in a free slot of ${project.name}`;
      add.setAttribute('aria-label', add.title);
      add.textContent = '+';
      add.addEventListener('click', () => newInFreeSlot(project.name));
      head.append(toggle, add);
      group.appendChild(head);

      if (open) {
        const slots = state.slots.get(project.name);
        if (!slots) {
          group.insertAdjacentHTML('beforeend', '<div class="mux-empty small">Loading slots…</div>');
        } else if (!slots.enabled) {
          group.insertAdjacentHTML('beforeend',
            '<div class="mux-empty small">No git repository at the root, so no slots — everything runs in the project itself.</div>');
        }
        for (const place of placesOf(project.name)) group.appendChild(slotRow(project, place));
      }
      body.appendChild(group);
    }
  }

  function slotRow(project, place) {
    const row = document.createElement('div');
    row.className = 'mux-slot';
    row.dataset.cwd = place.cwd;
    const dot = dotFor(place);
    row.classList.add(`is-${dot}`);
    const onScreen = visiblePanes().findIndex((p) => p.cwd === place.cwd);
    if (onScreen >= 0) row.classList.add('on-screen');

    const latest = latestSession(project.name, place.cwd);
    const pane = visiblePanes().find((p) => p.cwd === place.cwd);
    const title = pane?.title
      || (place.terminal ? 'Claude in a terminal' : '')
      || latest?.title
      || (place.created ? 'Nothing yet' : 'Not created yet');
    const facts = [];
    if (place.terminal) facts.push('terminal');
    if (place.n && place.branch && place.branch !== `slot-${place.n}`) facts.push(place.branch);
    if (place.dirty) facts.push(`${place.dirty} changed`);
    if (place.unpushed) facts.push(`${place.unpushed} unpushed`);
    if (strangers(place)) facts.push('open in the editor or another terminal');

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'mux-slot-main';
    // What a click opens: whatever is alive here — a terminal first, because its
    // session is running right now — then the last chat, then something new.
    const opens = place.terminal ? 'its terminal' : latest ? `"${title}"` : `a new ${kindLabel(state.newKind)}`;
    main.title = `Open ${opens} in the focused pane`;
    main.innerHTML = `<span class="mux-dot ${dot}"></span>
      <span class="mux-slot-text">
        <span class="mux-slot-name"></span>
        <span class="mux-slot-title"></span>
        <span class="mux-slot-facts"></span>
      </span>`;
    $('.mux-slot-name', main).textContent = slotLabel(place.n) + (onScreen >= 0 ? ` · pane ${onScreen + 1}` : '');
    $('.mux-slot-title', main).textContent = title;
    $('.mux-slot-facts', main).textContent = facts.join(' · ');
    main.addEventListener('click', () => {
      if (onScreen >= 0) {
        focusPane(onScreen);
        return;
      }
      if (place.terminal) openIn(state.focus, { kind: 'terminal', project: project.name, slot: place.n, cwd: place.cwd });
      else if (latest) openIn(state.focus, { kind: 'chat', project: project.name, slot: place.n, cwd: place.cwd, sessionId: latest.sessionId, title: latest.title });
      else startIn(state.focus, project.name, place);
    });

    const fresh = document.createElement('button');
    fresh.type = 'button';
    fresh.className = 'mux-add small';
    fresh.title = `New ${kindLabel(state.newKind)} in ${slotLabel(place.n)}`;
    fresh.setAttribute('aria-label', fresh.title);
    fresh.textContent = '+';
    fresh.addEventListener('click', () => startIn(state.focus, project.name, place));

    row.append(main, fresh);
    return row;
  }

  // --- opening things -------------------------------------------------------
  /**
   * Something new in a free slot: one nobody is in, preferring one that is clean, so
   * the agent starts from the default branch rather than from a predecessor's edits.
   */
  async function newInFreeSlot(name, kind = state.newKind) {
    if (!state.slots.has(name)) await loadSlots(name);
    const slots = state.slots.get(name);
    if (!slots?.enabled) {
      startIn(state.focus, name, placesOf(name)[0], kind);
      return;
    }
    const taken = (s) => s.held || s.terminal || visiblePanes().some((p) => p.cwd === s.cwd);
    const free = slots.slots.filter((s) => !taken(s));
    const pick = free.find((s) => !s.dirty && !s.unpushed) || free[0];
    if (!pick) {
      toast(`All 8 slots of ${name} have something in them. Open one, or start in one anyway with its +.`);
      return;
    }
    state.expanded.add(name);
    startIn(state.focus, name, pick, kind);
  }

  /**
   * Something new in one place, after getting the slot ready for it.
   *
   * A terminal whose session is already running is not new — it is joined, with no
   * question and no refresh, because joining is what a tmux session is for. Anything
   * else that would put a second agent into a checkout already holding one asks.
   */
  async function startIn(index, name, place, kind = state.newKind) {
    if (kind === 'terminal' && place.terminal) {
      openIn(index, { kind, project: name, slot: place.n, cwd: place.cwd });
      return;
    }
    const others = [];
    if (place.busy || (place.sessions || []).length) others.push('a chat');
    if (place.terminal) others.push('a terminal with Claude in it');
    if (strangers(place)) others.push('Claude from the editor or another terminal');
    if (place.n && others.length) {
      const ok = window.confirm(`${name} ${slotLabel(place.n)} already has ${others.join(' and ')} in it. `
        + `Two agents in one checkout is the collision slots exist to avoid. Start a ${kindLabel(kind)} there anyway?`);
      if (!ok) return;
    }
    let cwd = place.cwd;
    let note = '';
    if (place.n) {
      toast(`Getting ${name} ${slotLabel(place.n)} ready…`, 6000);
      try {
        const res = await api('/api/slots/prepare', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project: name, slot: place.n }),
        });
        const result = await res.json();
        if (!res.ok || !result.ok) throw new Error(result.error || `server returned ${res.status}`);
        cwd = result.cwd;
        // Said in the pane, because it is about what the new agent is starting from.
        if (result.kept) note = `Started on ${result.branch} as it was: ${result.kept}.`;
        else if (result.refreshed && !result.fetched) note = `Up to date with ${result.base} as this machine last fetched it.`;
      } catch (err) {
        toast(`Couldn't prepare ${slotLabel(place.n)}: ${err.message}`);
        return;
      }
      loadSlots(name);
    }
    hideToast();
    openIn(index, { kind, project: name, slot: place.n, cwd, sessionId: null, title: '', note });
  }

  function openIn(index, { kind = 'chat', project, slot, cwd, sessionId = null, title = '', note = '' }) {
    const pane = state.panes[index];
    const sameKind = pane.kind === kind;
    Object.assign(pane, {
      kind, project, slot, cwd, sessionId: kind === 'chat' ? sessionId || null : null, title: title || '',
      busy: false, sub: '', trouble: false, attention: false, note,
    });
    unflag(cwd);
    pane.src = frameSrc(pane);
    if (pane.frame) {
      // A chat frame and a terminal frame ask for different permissions, so a pane
      // changing kind gets a new frame rather than a new address in the old one.
      if (sameKind) pane.frame.src = pane.src;
      else {
        pane.frame.remove();
        pane.frame = null;
      }
    }
    save();
    renderGrid();
    focusPane(index);
  }

  function frameSrc(pane) {
    if (pane.kind === 'terminal') {
      const q = new URLSearchParams({ embed: '1', project: pane.project, slot: String(pane.slot || 0) });
      return `/chat/term?${q}`;
    }
    const q = new URLSearchParams({ embed: '1', cwd: pane.cwd, project: pane.project });
    if (pane.sessionId) q.set('session', pane.sessionId);
    if (pane.title) q.set('title', pane.title);
    return `/chat/?${q}`;
  }

  /**
   * Put the other kind of pane on the same place: the slot's terminal, or its chat.
   * Neither is stopped by the switch — the one left keeps running, and the sidebar
   * still has it.
   */
  function switchKind(pane) {
    const index = state.panes.indexOf(pane);
    const place = placesOf(pane.project).find((p) => p.cwd === pane.cwd) || { n: pane.slot || 0, cwd: pane.cwd };
    if (pane.kind === 'chat') {
      startIn(index, pane.project, place, 'terminal');
      return;
    }
    const latest = latestSession(pane.project, pane.cwd);
    if (latest) {
      openIn(index, { kind: 'chat', project: pane.project, slot: pane.slot, cwd: pane.cwd, sessionId: latest.sessionId, title: latest.title });
    } else {
      startIn(index, pane.project, place, 'chat');
    }
  }

  /** Take something off screen. It keeps running; that is the point. */
  function closePane(index) {
    const pane = state.panes[index];
    if (pane.busy) toast(`${pane.title || labelFor(pane.cwd)} keeps working — it's in the sidebar, and on the phone.`);
    state.panes[index] = emptyPane();
    pane.el?.remove();
    save();
    renderGrid();
    renderSidebar();
  }

  // --- the grid -------------------------------------------------------------
  const visiblePanes = () => state.panes.slice(0, paneCount());

  function focusPane(index, { input = true } = {}) {
    state.focus = Math.max(0, Math.min(index, paneCount() - 1));
    const pane = state.panes[state.focus];
    if (pane.cwd) unflag(pane.cwd);
    pane.attention = false;
    for (const p of visiblePanes()) paintPane(p);
    renderSidebar();
    save();
    if (!input) return;
    try {
      pane.frame?.contentWindow?.postMessage({ type: 'focus' }, location.origin);
    } catch {
      /* not loaded yet; it will be focused by the click that loads it */
    }
  }

  function buildPane(pane, index) {
    const el = document.createElement('section');
    el.className = 'mux-pane';
    el.innerHTML = `
      <header class="mux-pane-head">
        <span class="mux-dot"></span>
        <span class="mux-pane-label"></span>
        <span class="mux-pane-title"></span>
        <span class="mux-pane-sub"></span>
        <button type="button" class="mux-pane-btn mux-pane-kind" data-act="kind"></button>
        <button type="button" class="mux-pane-btn" data-act="new" title="New chat in this slot">+</button>
        <button type="button" class="mux-pane-btn" data-act="phone" title="Copy a link that opens this on the phone">⇱</button>
        <button type="button" class="mux-pane-btn" data-act="close" title="Close the pane — what is in it keeps running">✕</button>
      </header>
      <p class="mux-pane-note hidden"></p>
      <div class="mux-pane-body"></div>`;
    el.addEventListener('pointerdown', () => {
      if (state.focus !== state.panes.indexOf(pane)) focusPane(state.panes.indexOf(pane));
    }, true);
    el.querySelector('[data-act="close"]').addEventListener('click', (e) => {
      e.stopPropagation();
      closePane(state.panes.indexOf(pane));
    });
    el.querySelector('[data-act="kind"]').addEventListener('click', () => {
      if (pane.project) switchKind(pane);
    });
    el.querySelector('[data-act="new"]').addEventListener('click', () => {
      if (!pane.project) return;
      const place = placesOf(pane.project).find((p) => p.cwd === pane.cwd) || { n: pane.slot || 0, cwd: pane.cwd };
      // This chat is the one being replaced, so it is not a second agent in the slot.
      startIn(state.panes.indexOf(pane), pane.project, { ...place, busy: false, sessions: [], elsewhere: 0 }, 'chat');
    });
    el.querySelector('[data-act="phone"]').addEventListener('click', () => copyPhoneLink(pane));
    pane.el = el;
    void index;
    return el;
  }

  function placeholder(index) {
    const div = document.createElement('div');
    div.className = 'mux-placeholder';
    div.innerHTML = `<p>Pane ${index + 1}</p><p class="mux-hint">Pick a slot on the left, or press + next to a project to start in a free one.</p>`;
    return div;
  }

  function renderGrid() {
    const grid = $('#mux-grid');
    const [cols, rows] = LAYOUTS[state.layout];
    grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    grid.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
    for (const button of document.querySelectorAll('[data-layout]')) {
      button.classList.toggle('active', Number(button.dataset.layout) === state.layout);
    }
    for (const button of document.querySelectorAll('[data-kind]')) {
      button.classList.toggle('active', button.dataset.kind === state.newKind);
      button.setAttribute('aria-pressed', String(button.dataset.kind === state.newKind));
    }

    // Frames are moved, never rebuilt: rebuilding one reloads what is in it, which
    // for a chat costs a transcript replay and a half-typed message.
    const keep = new Set();
    visiblePanes().forEach((pane, index) => {
      if (!pane.el) buildPane(pane, index);
      keep.add(pane.el);
      const body = $('.mux-pane-body', pane.el);
      if (pane.cwd) {
        if (!pane.frame) {
          pane.frame = document.createElement('iframe');
          pane.frame.className = 'mux-frame';
          pane.frame.title = `Pane ${index + 1}: ${kindLabel(pane.kind)}`;
          // A chat dictates and reads aloud; a terminal pastes. A frame gets none of
          // it unless asked.
          pane.frame.allow = pane.kind === 'terminal'
            ? 'clipboard-read; clipboard-write'
            : 'microphone; autoplay; clipboard-write';
          pane.frame.src = pane.src || frameSrc(pane);
          pane.src = pane.frame.src;
          body.replaceChildren(pane.frame);
        }
      } else {
        pane.frame = null;
        body.replaceChildren(placeholder(index));
      }
      pane.el.style.order = String(index);
      if (pane.el.parentNode !== grid) grid.appendChild(pane.el);
      paintPane(pane);
    });
    for (const el of [...grid.children]) if (!keep.has(el)) el.remove();
  }

  function paintPane(pane) {
    const el = pane.el;
    if (!el) return;
    const index = state.panes.indexOf(pane);
    el.classList.toggle('focused', index === state.focus);
    el.classList.toggle('attention', pane.attention);
    el.classList.toggle('is-empty', !pane.cwd);
    el.dataset.kind = pane.kind;
    const dot = $('.mux-dot', el);
    dot.className = `mux-dot ${pane.attention ? 'attention' : pane.busy ? 'working' : pane.trouble ? 'trouble' : pane.cwd ? 'live' : 'idle'}`;
    $('.mux-pane-label', el).textContent = pane.project
      ? `${index + 1} · ${pane.project} · ${slotLabel(pane.slot)}${pane.kind === 'terminal' ? ' · ❯' : ''}`
      : `${index + 1}`;
    $('.mux-pane-title', el).textContent = pane.title || (pane.cwd ? (pane.kind === 'terminal' ? 'Claude in a terminal' : 'New chat') : '');
    $('.mux-pane-sub', el).textContent = pane.sub || '';
    for (const b of el.querySelectorAll('.mux-pane-btn')) b.hidden = !pane.cwd;
    // A terminal is one session per slot; "new" is a chat's.
    $('[data-act="new"]', el).hidden = !pane.cwd || pane.kind === 'terminal';
    const kind = $('[data-act="kind"]', el);
    kind.textContent = pane.kind === 'terminal' ? 'Chat' : 'Terminal';
    kind.title = pane.kind === 'terminal'
      ? 'Show this slot\'s chat here instead — the terminal keeps running'
      : 'Show this slot\'s terminal here instead — the chat keeps running';
    const note = $('.mux-pane-note', el);
    note.textContent = pane.note;
    note.classList.toggle('hidden', !pane.note);
  }

  /**
   * A link to this pane for another device. A chat opens in the ordinary chat — not
   * the mux — joined to the process already running it; a terminal opens as a page
   * of its own, on the same tmux session.
   */
  async function copyPhoneLink(pane) {
    let url;
    if (pane.kind === 'terminal') {
      const q = new URLSearchParams({ project: pane.project, slot: String(pane.slot || 0) });
      url = `${location.origin}/chat/term?${q}`;
    } else {
      if (!pane.sessionId) {
        toast('Send the first message, then the chat has a name another device can open.');
        return;
      }
      // The project is the phone's tab, and the slot is where the chat in it runs.
      const q = new URLSearchParams({
        cwd: projectByName(pane.project)?.path || pane.cwd,
        sessionCwd: pane.cwd,
        session: pane.sessionId,
        project: pane.project,
      });
      if (pane.title) q.set('title', pane.title);
      url = `${location.origin}/chat/?${q}`;
    }
    try {
      await navigator.clipboard.writeText(url);
      toast(pane.kind === 'terminal'
        ? `Link copied. From any terminal, \`cc ${pane.project}${pane.slot ? `/slot-${pane.slot}` : ''}\` is the same session.`
        : 'Link copied. On the phone it is also in the chat list, under the slot.');
    } catch {
      window.prompt('Open this on the other device:', url);
    }
  }

  // --- what the frames say --------------------------------------------------
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin) return;
    const msg = e.data;
    if (msg?.source !== 'triplec-chat' && msg?.source !== 'triplec-term') return;
    const pane = visiblePanes().find((p) => p.frame && p.frame.contentWindow === e.source);
    if (!pane) return;
    if (msg.type === 'pane-focus') {
      const index = state.panes.indexOf(pane);
      // Not handing the keyboard over: this click may be selecting text.
      if (index !== state.focus || pane.attention) focusPane(index, { input: false });
      return;
    }

    if (msg.source === 'triplec-term') {
      if (msg.type === 'term-state') {
        pane.sub = msg.text || '';
        pane.trouble = msg.status === 'error' || msg.status === 'reconnecting';
        paintPane(pane);
        // A terminal started or ended changes what its slot row says.
        if (msg.status === 'attached' || msg.status === 'ended') loadSlots(pane.project);
      } else if (msg.type === 'term-bell' && !watched(pane)) {
        // The CLI rings when it wants a person; so do most things run in a terminal.
        flag(pane.cwd, pane);
      }
      return;
    }

    if (msg.type !== 'pane-state') return;
    const wasBusy = pane.busy;
    pane.busy = Boolean(msg.busy);
    pane.sub = msg.sub || '';
    pane.trouble = Boolean(msg.trouble);
    if (msg.title) pane.title = msg.title;
    if (msg.sessionId && msg.sessionId !== pane.sessionId) {
      pane.sessionId = msg.sessionId;
      // What a reload has to put back: the frame's own URL still names the chat it
      // was opened on, which for a new one is none.
      pane.src = frameSrc(pane);
      save();
    } else if (msg.title) {
      save();
    }
    if (wasBusy && !pane.busy && !watched(pane)) flag(pane.cwd, pane);
    if (pane.busy) state.busyCwds.add(pane.cwd);
    paintPane(pane);
    renderSidebar();
  });

  // --- chrome ---------------------------------------------------------------
  function toast(message, ms = 3600) {
    const el = $('#toast');
    el.textContent = message;
    el.classList.remove('hidden');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.add('hidden'), ms);
  }
  function hideToast() {
    clearTimeout(toast.timer);
    $('#toast').classList.add('hidden');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function paintAlerts() {
    $('#mux-alerts').textContent = `Desktop alerts: ${state.alerts ? 'on' : 'off'}`;
  }

  for (const button of document.querySelectorAll('[data-layout]')) {
    button.addEventListener('click', () => {
      const before = paneCount();
      state.layout = Number(button.dataset.layout);
      // Panes that fall off the screen keep their place in the layout, so going
      // back to more panes brings them back. What was in them never stopped.
      const hidden = state.panes.slice(paneCount(), before).filter((p) => p.cwd).length;
      if (hidden) toast(`${hidden} pane${hidden === 1 ? '' : 's'} off screen — still running, and back when you choose more panes.`);
      for (const pane of state.panes.slice(paneCount())) pane.el?.remove();
      for (const pane of state.panes.slice(paneCount())) { pane.el = null; pane.frame = null; }
      if (state.focus >= paneCount()) state.focus = 0;
      save();
      renderGrid();
      renderSidebar();
    });
  }

  for (const button of document.querySelectorAll('[data-kind]')) {
    button.addEventListener('click', () => {
      state.newKind = KINDS.includes(button.dataset.kind) ? button.dataset.kind : 'chat';
      save();
      renderGrid();
      renderSidebar();
    });
  }

  $('#mux-filter').addEventListener('input', (e) => {
    state.filter = e.target.value.trim();
    renderSidebar();
  });

  $('#mux-alerts').addEventListener('click', async () => {
    if (!('Notification' in window)) {
      toast('This browser has no desktop notifications. The rings and the tab title still say who is waiting.');
      return;
    }
    if (!state.alerts && Notification.permission !== 'granted') {
      const answer = await Notification.requestPermission();
      if (answer !== 'granted') {
        toast('Notifications are blocked for this site — allow them in the browser to turn this on.');
        return;
      }
    }
    state.alerts = !state.alerts;
    paintAlerts();
    save();
  });

  // Alt+1…8 focuses a pane, from anywhere on this page. Inside a frame the chat or
  // the terminal has the keyboard, which is where it should be while typing.
  document.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const n = Number(e.key);
    if (n >= 1 && n <= paneCount()) {
      e.preventDefault();
      focusPane(n - 1);
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    pollLive();
    const pane = state.panes[state.focus];
    if (pane?.cwd && pane.attention) focusPane(state.focus);
  });

  // --- boot -----------------------------------------------------------------
  load();
  paintAlerts();
  renderGrid();
  loadProjects().then(pollLive);
  setInterval(pollLive, LIVE_POLL_MS);
  setInterval(() => {
    if (document.visibilityState === 'visible') for (const name of state.expanded) loadSlots(name);
  }, SLOTS_POLL_MS);
  setInterval(() => {
    if (document.visibilityState === 'visible') loadProjects();
  }, PROJECTS_POLL_MS);

  // For mux-test.js, which drives this in jsdom without a server behind it.
  window.__muxForTest = {
    state, openIn, closePane, focusPane, flag, renderGrid, renderSidebar, frameSrc, startIn, paneCount,
    newInFreeSlot, switchKind, pollTerminals,
    // The name the first tests knew it by: a new chat, in a free slot.
    newChatInFreeSlot: (name) => newInFreeSlot(name, 'chat'),
  };
})();
