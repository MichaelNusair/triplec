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
  // A finger rather than a mouse: the keys, the compose line and tap-to-choose are
  // for this, and nothing here changes for a desktop.
  const COARSE = window.matchMedia('(pointer: coarse)').matches;
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
    fontSize: COARSE ? 12 : 13,
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

  /*
   * Links, and copying them.
   *
   * tmux draws the screen a row at a time, so a URL longer than the pane is broken
   * into rows the emulator has no way to know belong together — and Claude Code
   * indents the rest of it under its margin. So a run of rows is read back as one
   * line wherever a row ends in an unbroken token near the right edge and the next
   * carries on with one, and the URLs are found in that. The same joining is what a
   * copy uses, so a link copies as a link and not as three lines with a margin in.
   */
  const URL_RE = /https?:\/\/[^\s<>"'`│┃]+/g;
  const TOKEN = /^[\w\-.~:/?#[\]@!$&'()*+,;=%]+$/;
  const rowText = (y) => term.buffer.active.getLine(y)?.translateToString(true) || '';
  // Row y's last token runs on into row y+1, which then starts at the column returned.
  function carriesOn(y) {
    const line = rowText(y);
    if (line.length < term.cols - 4 || y + 1 >= term.buffer.active.length) return -1;
    const next = rowText(y + 1);
    const from = next.search(/\S/);
    if (from < 0) return -1;
    const tail = /\S+$/.exec(line)?.[0] || '';
    const head = /^\S+/.exec(next.slice(from))?.[0] || '';
    return TOKEN.test(tail) && TOKEN.test(head) ? from : -1;
  }
  // The joined rows around y: the text, and where each of its characters sits.
  function block(y) {
    let top = y;
    while (top > 0 && y - top < 8 && carriesOn(top - 1) >= 0) top--;
    let text = '';
    const at = [];
    for (let r = top, from = 0; ; ) {
      const line = rowText(r);
      for (let x = from; x < line.length; x++) {
        text += line[x];
        at.push({ x, y: r });
      }
      const next = r - top < 16 ? carriesOn(r) : -1;
      if (next < 0) break;
      r++;
      from = next;
    }
    return { text, at };
  }
  function linksIn(y) {
    const { text, at } = block(y);
    const links = [];
    for (const m of text.matchAll(URL_RE)) {
      let url = m[0].replace(/[.,;:!?'"]+$/, '');
      if (url.endsWith(')') && !url.includes('(')) url = url.slice(0, -1);
      const first = at[m.index];
      const last = at[m.index + url.length - 1];
      links.push({ url, first, last });
    }
    return links;
  }
  function openLink(url) {
    if (/^https?:\/\//.test(url)) window.open(url, '_blank', 'noopener');
  }
  term.registerLinkProvider({
    provideLinks(line, callback) {
      const y = line - 1;
      const found = linksIn(y).filter((l) => l.first.y <= y && l.last.y >= y);
      callback(found.length ? found.map((l) => ({
        range: { start: { x: l.first.x + 1, y: l.first.y + 1 }, end: { x: l.last.x + 1, y: l.last.y + 1 } },
        text: l.url,
        activate: () => {
          // A drag that ended on a link was a selection, not a click.
          if (!term.hasSelection()) openLink(l.url);
        },
      })) : undefined);
    },
  });
  function linkAt(clientX, clientY) {
    const cell = cellAt(clientX, clientY);
    if (!cell) return null;
    const y = term.buffer.active.viewportY + cell.row;
    return linksIn(y).find((l) => y >= l.first.y && y <= l.last.y
      && (y > l.first.y || cell.col >= l.first.x) && (y < l.last.y || cell.col <= l.last.x))?.url || null;
  }
  function cellAt(clientX, clientY) {
    const screen = term.element?.querySelector('.xterm-screen');
    if (!screen || !term.rows) return null;
    const rect = screen.getBoundingClientRect();
    if (!rect.height || clientY < rect.top || clientY >= rect.bottom) return null;
    return {
      row: Math.floor((clientY - rect.top) / (rect.height / term.rows)),
      col: Math.floor((clientX - rect.left) / (rect.width / term.cols)),
    };
  }

  // Rows y0..y1 as text, cut at x0 on the first and before x1 on the last, with a
  // URL broken across rows put back together.
  function textOf(y0, x0, y1, x1) {
    let out = '';
    let from = x0;
    for (let y = y0; y <= y1; y++) {
      out += rowText(y).slice(from, y === y1 ? x1 : undefined);
      if (y === y1) break;
      // Inside a URL, the next row carries on from the URL's own column, not its margin.
      const next = carriesOn(y);
      const inUrl = next >= 0 && linksIn(y).some((l) => l.first.y <= y && l.last.y > y);
      from = inUrl ? next : 0;
      if (!inUrl) out += '\n';
    }
    return out;
  }
  function selectionText() {
    // 0-based rows and columns, the end column exclusive — whatever the typings say,
    // this is the selection service's own position, unconverted (xterm 6.0).
    const pos = term.getSelectionPosition();
    if (!pos) return '';
    return textOf(pos.start.y, pos.start.x, pos.end.y, pos.end.x).replace(/\n+$/, '');
  }
  const screenText = () => {
    const top = term.buffer.active.viewportY;
    return textOf(top, 0, top + term.rows - 1, undefined).replace(/\n+$/, '');
  };

  async function writeClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // A frame without clipboard-write, or a page that is not focused: the old way.
      const area = document.createElement('textarea');
      area.value = text;
      area.style.cssText = 'position:fixed;opacity:0;left:0;top:0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    }
  }
  async function copySelection() {
    const text = selectionText();
    if (!text) return;
    term.clearSelection();
    toast(await writeClipboard(text) ? 'Copied' : 'Could not copy');
  }

  // Ctrl-C copies when something is selected and is ^C when nothing is — Claude's
  // interrupt stays where it was. Ctrl-Shift-C always copies. Ctrl-V and Ctrl-Shift-V
  // are the browser's paste, so an image can come with them: Claude Code's own Ctrl-V
  // reads the clipboard of this box, which is never the one you copied to.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !e.ctrlKey || e.altKey || e.metaKey) return true;
    const key = e.key.toLowerCase();
    if (key === 'c' && (e.shiftKey || term.hasSelection())) {
      e.preventDefault();
      copySelection();
      return false;
    }
    if (key === 'v') return false;
    return true;
  });
  // A copy the browser started — Cmd-C, or the context menu — gets the same text.
  $('#term').addEventListener('copy', (e) => {
    const text = selectionText();
    if (!text) return;
    e.preventDefault();
    e.stopPropagation();
    e.clipboardData.setData('text/plain', text);
  }, true);

  /*
   * Images. Pasted, dropped, or picked on a phone, an image is uploaded and its path
   * pasted in its place, which Claude Code attaches — see savePaste in terminal.js.
   */
  const imagesIn = (list) => [...(list || [])].filter((f) => f && /^image\//.test(f.type));
  async function pasteImages(files) {
    for (const file of files) {
      toast('Uploading image…', 0);
      try {
        const q = new URLSearchParams({ project, slot: String(slot) });
        const res = await fetch(`/api/term/paste?${q}`, {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': file.type }, body: file,
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.path) throw new Error(body.error || `upload failed (${res.status})`);
        term.paste(`${body.path} `);
        toast('Image attached');
      } catch (err) {
        toast(err.message || 'upload failed');
      }
    }
    if (!COARSE) term.focus();
  }
  $('#term').addEventListener('paste', (e) => {
    const files = imagesIn(e.clipboardData?.files);
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    pasteImages(files);
  }, true);
  $('#term').addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault();
  });
  $('#term').addEventListener('drop', (e) => {
    const files = imagesIn(e.dataTransfer?.files);
    if (!files.length) return;
    e.preventDefault();
    pasteImages(files);
  });
  $('#term-image').addEventListener('change', (e) => {
    const files = imagesIn(e.target.files);
    e.target.value = '';
    if (files.length) pasteImages(files);
  });

  let toastTimer = null;
  function toast(text, ms = 1600) {
    const el = $('#term-toast');
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    if (ms) toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
  }

  // A phone cannot drag a selection in a terminal, so Copy shows the screen as plain
  // text, where the phone's own selection works, with its links above it.
  function openCopySheet() {
    const sheet = $('#term-copy');
    $('#term-copy-text').value = screenText();
    const top = term.buffer.active.viewportY;
    const urls = [];
    for (let y = top; y < top + term.rows; y++) {
      for (const l of linksIn(y)) if (l.first.y === y && !urls.includes(l.url)) urls.push(l.url);
    }
    $('#term-copy-links').replaceChildren(...urls.map((url) => {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = url;
      return a;
    }));
    sheet.classList.remove('hidden');
  }
  $('#term-copy-all').addEventListener('click', async () => {
    toast(await writeClipboard($('#term-copy-text').value) ? 'Copied' : 'Could not copy');
  });
  $('#term-copy-close').addEventListener('click', () => $('#term-copy').classList.add('hidden'));

  // And so does a finger, on a phone. A tap that does not move is a tap: on one
  // of the numbered choices Claude Code draws, it chooses it — see chooseAt.
  let touchY = null;
  let touchStart = null;
  $('#term').addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    touchY = t?.clientY ?? null;
    touchStart = t && e.touches.length === 1 ? { x: t.clientX, y: t.clientY, at: Date.now() } : null;
  }, { passive: true });
  $('#term').addEventListener('touchmove', (e) => {
    if (touchY === null || state.status !== 'attached') return;
    const y = e.touches[0].clientY;
    if (touchStart && Math.hypot(e.touches[0].clientX - touchStart.x, y - touchStart.y) > 10) touchStart = null;
    const lines = Math.trunc((touchY - y) / 18);
    if (!lines) return;
    touchY = y;
    send({ type: 'scroll', lines });
  }, { passive: true });
  $('#term').addEventListener('touchend', (e) => {
    const start = touchStart;
    touchStart = null;
    if (!start || Date.now() - start.at > 600 || state.status !== 'attached') return;
    const url = linkAt(start.x, start.y);
    if (url) {
      e.preventDefault();
      openLink(url);
      return;
    }
    const choice = choiceAt(start.y);
    if (!choice) return;
    // Not a tap on the terminal as well: that would open the keyboard over the menu.
    e.preventDefault();
    send({ type: 'input', data: choice });
    flash(start.y);
  }, { passive: false });

  /*
   * The choice under a finger, if it is on one.
   *
   * Claude Code's menus — the permission prompt, /model, the plan approval — are
   * numbered lines with a ❯ on the selected one, and a number key picks that line.
   * They look like buttons and are not, because a terminal has no buttons. So a tap
   * on a numbered line is read as its number, but only when a ❯ marks a numbered
   * line of the same menu: a numbered list in Claude's prose is not a menu, and a
   * tap there typing a digit into the prompt would be a surprise.
   */
  const OPTION = /^[\s│┃|]*(?:[❯›>▶]\s*)?(\d{1,2})[.)]\s+\S/;
  const SELECTED = /^[\s│┃|]*[❯›▶]\s*\d{1,2}[.)]\s+\S/;
  function choiceAt(clientY) {
    const buffer = term.buffer?.active;
    const screen = term.element?.querySelector('.xterm-screen');
    if (!buffer || !screen || !term.rows) return null;
    const rect = screen.getBoundingClientRect();
    if (!rect.height || clientY < rect.top || clientY >= rect.bottom) return null;
    const row = Math.floor((clientY - rect.top) / (rect.height / term.rows));
    const text = (r) => buffer.getLine(buffer.viewportY + r)?.translateToString(true) || '';
    const match = OPTION.exec(text(row));
    if (!match) return null;
    // The same menu: the selected line's number is in the same column, and no blank
    // line comes between them.
    const column = (line) => line.search(/\d/);
    const at = column(text(row));
    for (const step of [-1, 1]) {
      for (let r = row; r >= 0 && r < term.rows && Math.abs(r - row) <= 12; r += step) {
        const line = text(r);
        if (!line.trim()) break;
        if (SELECTED.test(line) && column(line) === at) return match[1];
      }
    }
    return null;
  }

  // A tapped choice is acknowledged where the finger was, before the redraw lands.
  function flash(clientY) {
    const screen = term.element?.querySelector('.xterm-screen');
    if (!screen) return;
    const rect = screen.getBoundingClientRect();
    const h = rect.height / term.rows;
    const mark = document.createElement('div');
    mark.className = 'term-tap';
    mark.style.top = `${rect.top + Math.floor((clientY - rect.top) / h) * h}px`;
    mark.style.height = `${h}px`;
    document.body.appendChild(mark);
    setTimeout(() => mark.remove(), 350);
  }

  const KEYS = {
    esc: '\x1b', tab: '\t', stab: '\x1b[Z', up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C', ctrlc: '\x03',
    enter: '\r', bksp: '\x7f', d1: '1', d2: '2', d3: '3',
  };
  for (const button of document.querySelectorAll('#term-keys [data-key]')) {
    // pointerdown + preventDefault, so tapping a key leaves the focus where it was:
    // the phone's keyboard stays open if it was, and is not opened if it was not.
    button.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      send({ type: 'input', data: KEYS[button.dataset.key] });
    });
  }
  // Not keys: these open something, so they act on the click.
  $('#term-keys [data-act="copy"]').addEventListener('click', openCopySheet);
  $('#term-keys [data-act="image"]').addEventListener('click', () => $('#term-image').click());

  // The compose line: typed as text, with the phone's autocorrect and dictation,
  // then Enter. Sent apart, because the CLI takes a burst ending in a return as a
  // paste and puts a newline in its prompt instead of submitting it. Empty, it is
  // just Enter.
  $('#term-compose').addEventListener('submit', (e) => {
    e.preventDefault();
    const line = $('#term-line');
    const text = line.value;
    line.value = '';
    if (text) send({ type: 'input', data: text });
    setTimeout(() => send({ type: 'input', data: '\r' }), text ? 80 : 0);
  });

  // iOS keeps the layout viewport when its keyboard opens, so the keys and the
  // compose line would sit under it. The visible part is what the page fits to.
  if (COARSE && !EMBED && window.visualViewport) {
    const fitView = () => {
      document.documentElement.style.setProperty('--term-vh', `${window.visualViewport.height}px`);
      window.scrollTo(0, 0);
    };
    window.visualViewport.addEventListener('resize', fitView);
    fitView();
  }

  $('#term-restart').addEventListener('click', () => {
    term.reset();
    connect();
    if (!COARSE) term.focus();
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
    // Not on a phone: the keyboard would open over the screen before it is drawn.
    if (!COARSE) term.focus();
  }

  // For term-test.js and mux-test.js, which drive this in jsdom.
  window.__termForTest = { state, term, connect, send, choiceAt, linksIn, selectionText, screenText, pasteImages };
})();
