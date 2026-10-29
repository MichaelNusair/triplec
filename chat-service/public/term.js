/*
 * One terminal: the real Claude Code CLI, in the tmux session `cc` keeps for this
 * project or slot.
 *
 * The session lives in claude-tmux.service, so nothing here owns anything. This page
 * is a tmux client over a socket (/ws/term, see terminal.js): close it and the
 * session carries on; open it again — here, in another mux pane, on a phone, or with
 * `cc` in the editor — and tmux redraws the same screen.
 *
 * Inside a mux pane (`?embed=1`) it reports to the mux the way the embedded chat
 * does: its state, a click inside it, and the terminal bell. On its own it is a page
 * for a phone, with the keys a phone keyboard lacks.
 */
(() => {
  const $ = (sel) => document.querySelector(sel);
  const params = new URLSearchParams(location.search);
  const EMBED = params.get('embed') === '1' && window.parent !== window;
  const project = params.get('project') || '';
  const slot = Number(params.get('slot')) || 0;
  const place = slot ? `${project} · slot ${slot}` : project;
  if (EMBED) document.documentElement.classList.add('embed');
  document.title = `${place} · Terminal`;
  $('#term-title').textContent = place || 'Terminal';

  const state = {
    ws: null,
    status: 'connecting',   // connecting | attached | reconnecting | ended | error
    session: null,
    existed: null,
    ended: false,           // the session's own end, not a dropped socket
    fatal: false,           // refused by the server; retrying would only repeat it
    delay: 500,
  };

  // --- the emulator ---------------------------------------------------------
  const term = new window.Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", monospace',
    fontSize: matchMedia('(pointer: coarse)').matches ? 12 : 13,
    // tmux draws on the alternate screen, so the history is tmux's and scrolling is
    // asked of it — see onWheel. A scrollback here would only ever be empty.
    scrollback: 0,
    macOptionIsMeta: true,
    theme: {
      background: '#141413',
      foreground: '#f5f4ef',
      cursor: '#d97757',
      cursorAccent: '#141413',
      selectionBackground: 'rgba(217, 119, 87, 0.35)',
    },
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($('#term'));
  try {
    fit.fit();
  } catch {
    /* not laid out yet; the observer below fits it when it is */
  }

  // --- telling the mux --------------------------------------------------------
  function report(type, extra = {}) {
    if (!EMBED) return;
    try {
      window.parent.postMessage({ source: 'triplec-term', type, ...extra }, location.origin);
    } catch {
      /* no mux to tell */
    }
  }

  function setStatus(status, text = status) {
    state.status = status;
    const el = $('#term-status');
    el.textContent = text;
    el.classList.toggle('trouble', status === 'error' || status === 'reconnecting');
    report('term-state', { status, text, session: state.session, existed: state.existed });
  }

  // --- the socket -----------------------------------------------------------
  function send(msg) {
    if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  function connect() {
    state.ended = false;
    state.fatal = false;
    $('#term-ended').classList.add('hidden');
    setStatus('connecting', 'connecting…');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const q = new URLSearchParams({ project, slot: String(slot), cols: String(term.cols), rows: String(term.rows) });
    const ws = new WebSocket(`${proto}//${location.host}/ws/term?${q}`);
    ws.binaryType = 'arraybuffer';
    state.ws = ws;
    const stale = () => state.ws !== ws;

    ws.addEventListener('message', (e) => {
      if (stale()) return;
      // Text is always one of the JSON messages; anything else is the terminal's own
      // bytes. Asked as "not a string" rather than `instanceof ArrayBuffer`, which is
      // false for a buffer made in another realm.
      if (typeof e.data !== 'string') {
        term.write(new Uint8Array(e.data));
        return;
      }
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === 'attached') {
        state.session = msg.session;
        state.existed = Boolean(msg.existed);
        state.delay = 500;
        setStatus('attached', msg.existed ? 'rejoined' : 'started');
        // The size the server was told at the start may be stale by now.
        send({ type: 'resize', cols: term.cols, rows: term.rows });
      } else if (msg.type === 'exit') {
        state.ended = true;
      } else if (msg.type === 'error') {
        state.fatal = true;
        term.write(`\r\n\x1b[31m${String(msg.message || 'the terminal could not start')}\x1b[0m\r\n`);
        setStatus('error', 'could not start');
      }
    });

    ws.addEventListener('close', async () => {
      if (stale()) return;
      if (state.fatal) return;
      if (state.ended) {
        // `cc` exits when Claude does, and the session goes with it — on purpose, so
        // an empty shell never passes for a live Claude. Starting again is a choice.
        setStatus('ended', 'session ended');
        $('#term-ended').classList.remove('hidden');
        return;
      }
      setStatus('reconnecting', 'reconnecting…');
      // A refused upgrade looks the same as a dropped network from here, so ask a
      // route that answers 401 which one it was — or this retries forever, signed out.
      try {
        const res = await fetch('/api/auth-check', { credentials: 'same-origin' });
        if (res.status === 401) {
          (window.top || window).location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
          return;
        }
      } catch {
        /* offline: retrying is the right thing to do */
      }
      setTimeout(() => {
        // Not if something newer has connected since, and not from a pocket: the
        // way back to visible reconnects on its own, below.
        if (stale() || document.visibilityState !== 'visible') return;
        connect();
      }, state.delay);
      state.delay = Math.min(state.delay * 2, 8000);
    });
  }

  // --- keyboard, size, scrolling ---------------------------------------------
  term.onData((data) => send({ type: 'input', data }));
  // Mouse reports and the like: bytes, not text, so they go as a binary frame.
  term.onBinary((data) => {
    if (state.ws?.readyState !== WebSocket.OPEN) return;
    state.ws.send(Uint8Array.from(data, (c) => c.charCodeAt(0) & 0xff));
  });
  term.onBell(() => report('term-bell'));

  let resizeTimer = null;
  term.onResize(({ cols, rows }) => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => send({ type: 'resize', cols, rows }), 80);
  });
  new ResizeObserver(() => {
    try {
      fit.fit();
    } catch {
      /* hidden; refitted when shown */
    }
  }).observe($('#term'));

  // The wheel scrolls tmux's history, in its copy mode, a few lines per notch.
  let wheel = 0;
  $('#term').addEventListener('wheel', (e) => {
    if (state.status !== 'attached') return;
    e.preventDefault();
    e.stopPropagation();
    wheel += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    const lines = Math.trunc(wheel / 40);
    if (!lines) return;
    wheel -= lines * 40;
    send({ type: 'scroll', lines });
  }, { capture: true, passive: false });

  // And so does a finger, on a phone.
  let touchY = null;
  $('#term').addEventListener('touchstart', (e) => { touchY = e.touches[0]?.clientY ?? null; }, { passive: true });
  $('#term').addEventListener('touchmove', (e) => {
    if (touchY === null || state.status !== 'attached') return;
    const y = e.touches[0].clientY;
    const lines = Math.trunc((touchY - y) / 18);
    if (!lines) return;
    touchY = y;
    send({ type: 'scroll', lines });
  }, { passive: true });

  const KEYS = {
    esc: '\x1b', tab: '\t', stab: '\x1b[Z', up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C', ctrlc: '\x03',
  };
  for (const button of document.querySelectorAll('#term-keys [data-key]')) {
    // pointerdown + preventDefault, so tapping a key does not take the focus away
    // from the terminal and close the phone's keyboard.
    button.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      send({ type: 'input', data: KEYS[button.dataset.key] });
      term.focus();
    });
  }

  $('#term-restart').addEventListener('click', () => {
    term.reset();
    connect();
    term.focus();
  });

  // --- inside the mux --------------------------------------------------------
  if (EMBED) {
    const focused = () => report('pane-focus');
    document.addEventListener('pointerdown', focused, true);
    document.addEventListener('focusin', focused, true);
    window.addEventListener('message', (e) => {
      if (e.origin !== location.origin || e.source !== window.parent) return;
      if (e.data?.type === 'focus') term.focus();
    });
  }

  // A phone that slept has a dead socket it still believes in. Rejoin on the way back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const ws = state.ws;
    const dead = !ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING;
    if (dead && !state.ended && !state.fatal) connect();
  });

  if (!project) {
    state.fatal = true;
    term.write('\x1b[31mNo project was named in the address.\x1b[0m\r\n');
    setStatus('error', 'no project');
  } else {
    connect();
    term.focus();
  }

  // For term-test.js and mux-test.js, which drive this in jsdom.
  window.__termForTest = { state, term, connect, send };
})();
