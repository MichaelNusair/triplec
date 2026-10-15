/**
 * Hearing a message in the chat app, rather than reading it.
 *
 * Dictation was the whole of voice in this app for a long time, which is half a
 * conversation: you can talk to Claude from a phone and then have to read the
 * answer. This covers the other half — the control on each of Claude's messages,
 * and the one under each code block in it.
 *
 * Everything interesting about it is invisible from a desktop browser and
 * inaudible from a test, so it is driven directly:
 *
 *  - **What a block button sends.** A code block is read by the server
 *    (`kind: 'code'`, which becomes "indent two" and "arrow" and a line number
 *    every few lines) and never locally, because a browser voice reads code as a
 *    minute of punctuation names. The block, the fence's language, and no
 *    surrounding prose.
 *  - **That the nth button reads the nth block.** The renderer and the reader
 *    split fences with one shared regex; a button that reads the wrong block is
 *    worse than no button, and two independent parsers agreeing today is not a
 *    guarantee about tomorrow.
 *  - **That nothing is offered when the server cannot read.** No Polly
 *    permission, no Azure or OpenAI key, an older server with no such route: all
 *    of them mean no controls at all rather than buttons that explain a 401.
 *  - **How fast it reads.** The rate goes on the element as both `playbackRate`
 *    and `defaultPlaybackRate`, because a new source resets the first to the
 *    second — set one of them once and the first piece of a message is fast and
 *    the rest is not, which sounds like the setting half working.
 *  - **Hebrew.** An unset voice means "whichever fits the message", decided per
 *    message on the server — which is the only arrangement where a Hebrew answer
 *    is read in Hebrew on a phone nobody configured.
 *
 * Run: node chat-service/read-test.js
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { JSDOM, VirtualConsole } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, 'public');
const html = readFileSync(join(publicDir, 'index.html'), 'utf8');
const js = readFileSync(join(publicDir, 'app.js'), 'utf8');
const css = readFileSync(join(publicDir, 'style.css'), 'utf8');

const failures = [];
let checks = 0;
function check(name, ok, detail = '') {
  checks++;
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(name);
  }
}

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

/*
 * Rejections nobody handled, collected for the whole run.
 *
 * Read-aloud is a chain of promises outliving the read that started them, and the
 * way that goes wrong is not a thrown error on screen — it is a read that abandons
 * itself halfway and leaves the controls saying Stop forever. So a stray rejection
 * is a failure here, not noise.
 */
const rejections = [];
process.on('unhandledRejection', (err) => rejections.push(String(err?.message || err)));

/** What the server says it can read with, shaped like speechStatus's answer. */
const SPEECH = {
  configured: true,
  // `voice` is the server's default, which is the free one where there is one — see
  // `preferredVoice` in speak.js. The picker shows it selected for a phone that has
  // never chosen, and Polly is listed beside it rather than replaced by it.
  voice: 'Ava',
  voices: [
    { id: 'Ava', gender: 'Female', language: 'en-US', provider: 'azure' },
    { id: 'Ruth', gender: 'Female', language: 'en-US', provider: 'polly' },
    { id: 'Hila', gender: 'Female', language: 'he-IL', provider: 'azure' },
    { id: 'marin', gender: 'Female', language: 'multi', provider: 'openai' },
  ],
};

const CWD = '/workspace/projects/demo';

/**
 * Boot the client with the speech routes answered.
 *
 * `speech: null` is every way of not being able to read aloud — they are one case
 * on screen, and it is the case the controls must not appear in.
 */
function boot({ speech = SPEECH, settings = null } = {}) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: 'https://claude.example.com/',
    virtualConsole,
  });
  const w = dom.window;

  const sockets = [];
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this.handlers = new Map();
      sockets.push(this);
    }
    addEventListener(type, fn) {
      this.handlers.set(type, [...(this.handlers.get(type) || []), fn]);
    }
    send(frame) { this.sent.push(JSON.parse(frame)); }
    close() { this.readyState = 3; }
    emit(type, event) { for (const fn of [...(this.handlers.get(type) || [])]) fn(event); }
    accept() { this.readyState = 1; this.emit('open', {}); }
    deliver(msg) { this.emit('message', { data: JSON.stringify(msg) }); }
  }
  FakeSocket.CONNECTING = 0;
  FakeSocket.OPEN = 1;
  FakeSocket.CLOSING = 2;
  FakeSocket.CLOSED = 3;
  w.WebSocket = FakeSocket;
  w.matchMedia = () => ({ matches: false, addEventListener() {} });

  /*
   * The audio element, which jsdom will not play.
   *
   * Recorded rather than faked away: which URLs reach the element is the whole
   * question on this path — the silence that unlocks it must be first, the
   * segments must arrive in order, and nothing else may ever be handed to it.
   */
  const played = [];
  /* The rate each of those sources was playing at — see section 9. */
  const rates = [];
  const audio = { el: null, built: 0 };
  class FakeAudio {
    constructor() {
      this.onended = null;
      this.onerror = null;
      /*
       * Both rates, because the browser has both and the difference is the bug: a
       * new `src` resets `playbackRate` to `defaultPlaybackRate`, so a reader that
       * sets only the first reads the first piece of a message fast and the rest at
       * normal speed.
       */
      this.defaultPlaybackRate = 1;
      this.playbackRate = 1;
      audio.built += 1;
      audio.el = this;
    }
    set src(value) {
      this._src = value;
      // The load the assignment starts, as far as this matters here.
      this.playbackRate = this.defaultPlaybackRate;
      played.push(value);
    }
    get src() { return this._src; }
    removeAttribute() { this._src = undefined; }
    load() {}
    pause() {}
    play() {
      rates.push(this.playbackRate);
      return Promise.resolve();
    }
    /** The piece finished, which is what chains the next one. */
    finish() { this.onended?.(); }
    /** The browser refused the source. */
    fail() { this.onerror?.(); }
  }
  w.Audio = FakeAudio;

  const prepareCalls = [];
  const segmentFetches = [];
  const state = {
    prepareStatus: 0,
    prepareError: 'the voice has read 300000 characters today',
    segments: 2,
    holdSegments: false,
    release: [],
  };

  const json = (body, ok = true, status = 200) =>
    Promise.resolve({ ok, status, json: () => Promise.resolve(body), blob: () => Promise.resolve({}) });

  w.fetch = (url, options = {}) => {
    const u = String(url);
    if (u.includes('/api/voice-status')) {
      // Shaped like the real route: transcription's answer with the voice's nested
      // inside it, because they are two halves of one question.
      return json({ configured: true, backend: 'local', speech });
    }
    if (u.includes('/api/speak/prepare')) {
      prepareCalls.push(JSON.parse(options.body || '{}'));
      if (state.prepareStatus) return json({ error: state.prepareError }, false, state.prepareStatus);
      return json({ id: 'read1', voice: 'Ruth', engine: 'generative', segments: state.segments });
    }
    if (u.includes('/api/speak?')) {
      segmentFetches.push(u);
      // Held open on request, so a test can press Stop while a piece is still in
      // flight — which is the whole reason there is a generation counter.
      if (state.holdSegments) {
        return new Promise((resolve) => {
          state.release.push(() => resolve({ ok: true, status: 200, blob: () => Promise.resolve({}) }));
        });
      }
      return json({});
    }
    if (u.includes('/api/live')) return json({ sessions: [], at: Date.now() });
    if (u.includes('/api/projects')) {
      return json({
        projects: [{
          name: 'demo',
          path: CWD,
          sessions: [{ sessionId: 'aaa', mtime: Date.now(), title: 'a chat' }],
        }],
      });
    }
    return json({ models: [{ id: 'us.anthropic.claude-opus-5', label: 'Opus 5' }] });
  };

  const thrown = [];
  w.addEventListener('error', (e) => thrown.push(e.message));
  // What a previous launch left in storage, seeded before the script reads it:
  // every JSDOM gets its own localStorage, so this is the only way to be a device
  // that has settings already.
  if (settings) w.localStorage.setItem('claude-chat', JSON.stringify(settings));
  try {
    w.eval(js);
  } catch (err) {
    console.error(`FAIL: app.js threw on load — ${err.constructor.name}: ${err.message}`);
    console.error(err.stack?.split('\n').slice(0, 5).join('\n'));
    process.exit(1);
  }

  const doc = w.document;
  return {
    dom, w, doc, sockets, prepareCalls, segmentFetches, played, rates, audio, state, thrown,
    $: (sel) => doc.querySelector(sel),
    hooks: w.__panesForTest,
    speechHooks: w.__speechForTest,
    /** Open a project, accept its socket, and be ready to deliver messages. */
    open() {
      w.__panesForTest.openProject({ name: 'demo', path: CWD });
      const sock = sockets[sockets.length - 1];
      sock.accept();
      sock.deliver({ type: 'ready' });
      sock.deliver({ type: 'attached', conversationId: 'conv-1', cwd: CWD, busy: false, sessionId: 'aaa' });
      return sock;
    },
    bubbles: () => [...doc.querySelectorAll('.msg.claude')],
    readBtns: (el) => [...(el || doc).querySelectorAll('[data-read]')],
    close: () => w.close(),
  };
}

const MESSAGE = [
  'Two changes, and **both** are code.',
  '',
  'The guard first:',
  '',
  '```js',
  'const speaking = false; // 3 < 4 && "quoted"',
  'if (speaking) stopSpeech();',
  '```',
  '',
  'Then the limit, in `config.toml`:',
  '',
  '```toml',
  'max_seconds = 55',
  '```',
  '',
  'Both are deployed.',
].join('\n');

// --- 1. a control on the message, and one under each block -------------------
console.log('\nA message Claude finished can be heard, block by block:');
{
  const h = boot();
  const sock = h.open();
  await settle(120); // the voice status is a round trip; the controls wait for it
  sock.deliver({ type: 'assistant_text', text: MESSAGE });
  await settle();

  const bubble = h.bubbles()[0];
  check('the finished message is on screen at all', Boolean(bubble));
  check(
    'the message has no read control, so a phone can only read it with its eyes',
    h.readBtns(bubble).length === 3,
    `${h.readBtns(bubble).length} controls`,
  );
  const labels = h.readBtns(bubble).map((b) => b.dataset.readLabel);
  check(
    'a code block has no button of its own, which is the one thing "Code block." '
      + 'cannot give you',
    labels.filter((l) => /this code/.test(l)).length === 2,
    labels.join(' | '),
  );
  check(
    'the block button does not say which language it is, or how much of it there is',
    /· js · 2 lines/.test(labels[0]) && /· toml · 1 line/.test(labels[1]),
    labels.join(' | '),
  );
  check(
    'the message read is not offered last, under the text it reads',
    labels[2] === '🔊 Read aloud',
    labels.join(' | '),
  );
  check(
    'a block button is not under the block it reads — it has to be findable from '
      + 'the code, not from a list somewhere else',
    [...bubble.querySelectorAll('pre')].every((pre) =>
      pre.nextElementSibling?.classList.contains('read-row')),
  );
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  h.close();
}

// --- 2. what a block read actually sends ------------------------------------
console.log('\nA block is read as code, by the server, and nothing else is sent:');
{
  const h = boot();
  const sock = h.open();
  await settle(120);
  sock.deliver({ type: 'assistant_text', text: MESSAGE });
  await settle();

  const bubble = h.bubbles()[0];
  h.readBtns(bubble)[0].dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  await settle();

  const sent = h.prepareCalls[0];
  check('pressing a block button asked the server for nothing', h.prepareCalls.length === 1);
  check(
    `the block was sent as prose, so nothing turns its punctuation into words: ${JSON.stringify(sent?.kind)}`,
    sent?.kind === 'code',
  );
  check(
    `the fence's language was not passed on: ${JSON.stringify(sent?.lang)}`,
    sent?.lang === 'js',
  );
  check(
    'the code was reduced or escaped on the way — the operators are exactly what '
      + 'the server needs in order to say them out loud',
    sent?.text.includes('&&') && sent.text.includes('const speaking'),
  );
  check(
    'the fence, or the prose around it, went with the block',
    !sent?.text.includes('```') && !sent?.text.includes('Two changes'),
  );
  check(
    'the second button reads the first block — the renderer and the reader have to '
      + 'agree about which <pre> is which',
    (() => {
      h.readBtns(bubble)[1].dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
      return true;
    })(),
  );
  await settle();
  check(
    `the second block button read something else: ${JSON.stringify(h.prepareCalls[1]?.text)}`,
    h.prepareCalls[1]?.text.includes('max_seconds') && h.prepareCalls[1]?.lang === 'toml',
  );

  // And the message itself: markup gone, code named rather than read out.
  h.readBtns(bubble)[2].dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  await settle();
  const prose = h.prepareCalls[2];
  check(`the message was not read as prose: ${JSON.stringify(prose?.kind)}`, prose?.kind !== 'code');
  check(
    'the code was read out as part of the message, bracket by bracket',
    !prose?.text.includes('&&') && !prose?.text.includes('max_seconds'),
  );
  check(
    `the blocks it skipped are not numbered, so what you hear does not map onto the `
      + `buttons: ${JSON.stringify(prose?.text)}`,
    /Code block 1\./.test(prose?.text || '') && /Code block 2\./.test(prose?.text || ''),
  );
  check(
    'the markdown went out as markdown: asterisks and backticks read aloud',
    !/[*`]/.test(prose?.text || 'x*'),
  );
  check(
    'a device that has never chosen a voice named one anyway — the choice per '
      + 'message belongs on the server, which is what reads Hebrew in Hebrew',
    h.prepareCalls.every((c) => c.voice === ''),
    JSON.stringify(h.prepareCalls.map((c) => c.voice)),
  );
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  h.close();
}

// --- 3. the audio, and Stop -------------------------------------------------
console.log('\nThe audio is unlocked by the tap, played in order, and stoppable:');
{
  const h = boot();
  const sock = h.open();
  await settle(120);
  sock.deliver({ type: 'assistant_text', text: MESSAGE });
  await settle();

  const bubble = h.bubbles()[0];
  const btn = h.readBtns(bubble)[2];
  btn.dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  check(
    'the element was not unlocked inside the tap — a silent file has to be played '
      + 'during the gesture, because the audio being read does not exist yet and iOS '
      + 'will not play what no gesture started',
    h.played[0] === '/api/speak/silence',
    h.played.join(', '),
  );
  check('the control does not offer Stop while it is reading', btn.textContent === '■ Stop');
  await settle();
  check(
    `the pieces were not fetched one ahead, so each one begins in silence: ${h.segmentFetches.join(', ')}`,
    h.segmentFetches.length === 2
      && h.segmentFetches[0].includes('segment=0')
      && h.segmentFetches[1].includes('segment=1'),
  );
  check(
    `the first piece was not played: ${h.played.join(', ')}`,
    h.played[h.played.length - 1].includes('segment=0'),
  );
  check(
    'a blob: URL reached the element, which is the one thing that must never happen '
      + 'here — same-origin only, so the same policy holds on both surfaces',
    h.played.every((u) => u.startsWith('/api/speak')),
    h.played.join(', '),
  );

  h.audio.el.finish();
  await settle();
  check(
    `the second piece did not follow the first: ${h.played.join(', ')}`,
    h.played[h.played.length - 1].includes('segment=1'),
  );
  h.audio.el.finish();
  await settle();
  check(
    'the end of the message left the control saying Stop for a voice that has finished',
    btn.textContent === '🔊 Read aloud',
  );

  // Stop, mid-message.
  btn.dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  await settle();
  check('a second read did not start', h.prepareCalls.length === 2);
  btn.dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  check('its own button does not stop it', btn.textContent === '🔊 Read aloud');
  const playedAtStop = h.played.length;
  h.audio.el.finish();
  await settle();
  check(
    'the piece that was playing carried on to the next one after Stop',
    h.played.length === playedAtStop,
  );

  /*
   * Stop while a piece is still in flight — the case the generation counter exists
   * for. Every read leaves a fetch behind it, and a fetch that resolves after Stop
   * must not start playing audio nobody asked for any more.
   */
  h.state.holdSegments = true;
  const fetchesBeforeHold = h.segmentFetches.length;
  btn.dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  await settle();
  check(
    'the held read never asked for a piece, so there is nothing in flight to race',
    h.segmentFetches.length === fetchesBeforeHold + 1,
  );
  const playedBeforeRelease = h.played.length;
  btn.dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));  // Stop, mid-fetch
  for (const release of h.state.release) release();
  await settle();
  check(
    'a piece that arrived after Stop was played anyway — a read is abandoned but its '
      + 'fetches outlive it, so something has to tell them they are stale',
    h.played.length === playedBeforeRelease,
    h.played.slice(playedBeforeRelease).join(', '),
  );
  check(
    'pressing Stop was reported as a failure, which makes Stop look broken',
    h.$('#toast').classList.contains('hidden'),
    h.$('#toast').textContent,
  );
  check(
    `four reads built ${h.audio.built} audio elements — iOS grants the permission to `
      + 'an element, not to the page, so a fresh one per read is locked again and the '
      + 'second message of the day is silent',
    h.audio.built === 1,
  );
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  h.close();
}

// --- 4. a refusal says so, and reads nothing --------------------------------
console.log('\nA refusal is a sentence, not silence and not the wrong voice:');
{
  const h = boot();
  const sock = h.open();
  await settle(120);
  sock.deliver({ type: 'assistant_text', text: MESSAGE });
  await settle();

  h.state.prepareStatus = 429;
  const bubble = h.bubbles()[0];
  const btn = h.readBtns(bubble)[0];
  btn.dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  await settle();
  check(
    `the refusal was swallowed: ${JSON.stringify(h.$('#toast').textContent)}`,
    /300000/.test(h.$('#toast').textContent || ''),
  );
  check('the toast stayed hidden, so nothing said why', !h.$('#toast').classList.contains('hidden'));
  check('the control was left saying Stop for a read that never began', btn.textContent !== '■ Stop');
  check(
    'a refused read still fetched audio for it',
    h.segmentFetches.length === 0,
    h.segmentFetches.join(', '),
  );

  // And a source the browser will not play, after a piece has been heard.
  h.state.prepareStatus = 0;
  btn.dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  await settle();
  h.audio.el.fail();
  await settle();
  check(
    `nothing said why the reading stopped: ${JSON.stringify(h.$('#toast').textContent)}`,
    /would not play/.test(h.$('#toast').textContent || ''),
  );
  check('a failed read left the control saying Stop', btn.textContent !== '■ Stop');
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  h.close();
}

// --- 5. a box that cannot read aloud offers nothing -------------------------
console.log('\nA deployment with no server voice offers no controls at all:');
{
  const h = boot({ speech: null });
  const sock = h.open();
  await settle(120);
  sock.deliver({ type: 'assistant_text', text: MESSAGE });
  await settle();

  const bubble = h.bubbles()[0];
  check('the message rendered', Boolean(bubble));
  check(
    'a read control was offered by a box that cannot synthesise — the browser voice '
      + 'can read neither Hebrew nor code, so the button would only disappoint',
    h.readBtns(bubble).length === 0,
  );
  check(
    'the settings sheet shows a voice picker with nothing behind it',
    h.$('#voice-row').classList.contains('hidden'),
  );
  check(
    'the settings sheet shows a speed picker on a box with nothing to read with',
    h.$('#speed-row').classList.contains('hidden'),
  );
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  h.close();
}

// --- 6. choosing a voice, and being told what it can read -------------------
console.log('\nThe voice is the server’s choice per message until someone overrides it:');
{
  const h = boot();
  await settle(120);
  const select = h.$('#select-voice');
  const options = [...select.options].map((o) => o.value);
  check('the picker is hidden on a box that can read', !h.$('#voice-row').classList.contains('hidden'));
  check(
    `the picker does not offer the server's voices: ${options.join(', ')}`,
    options.includes('Ruth') && options.includes('Hila') && options.includes('marin'),
  );
  check(
    'there is no way to leave the choice to the server, which is the only setting '
      + 'that reads Hebrew and English each in their own voice',
    options[0] === '' && select.value === '',
  );
  check(
    `'multi' was shown as if it were a language code: `
      + `${JSON.stringify([...select.options].find((o) => o.value === 'marin')?.textContent)}`,
    /any language/.test([...select.options].find((o) => o.value === 'marin')?.textContent || ''),
  );
  check(
    'the hint does not say that the language is chosen per message, or where the '
      + 'code button is',
    /per message/.test(h.$('#voice-hint').textContent) && /code/i.test(h.$('#voice-hint').textContent),
  );

  select.value = 'Hila';
  select.dispatchEvent(new h.w.Event('change'));
  check(
    'choosing the Hebrew voice does not admit that it is Hebrew-only, or that it is free',
    /free tier/.test(h.$('#voice-hint').textContent) && /Hebrew only/.test(h.$('#voice-hint').textContent),
  );

  check(
    'the choice was not remembered, so it has to be made again on every launch',
    JSON.parse(h.w.localStorage.getItem('claude-chat') || '{}').voice === 'Hila',
  );

  // The same resource, the same free allowance, a different language — and the note has
  // to stop saying "Hebrew only" when the voice is the English one everybody gets by
  // default, or the default voice reads as a mistake.
  select.value = 'Ava';
  select.dispatchEvent(new h.w.Event('change'));
  check(
    `the English Azure voice is described as Hebrew-only: ${JSON.stringify(h.$('#voice-hint').textContent)}`,
    /free tier/.test(h.$('#voice-hint').textContent) && !/Hebrew only/.test(h.$('#voice-hint').textContent),
  );

  select.value = 'Ruth';
  select.dispatchEvent(new h.w.Event('change'));
  check(
    'an English voice does not say that it cannot read Hebrew, which is the whole '
      + 'reason there is more than one voice here',
    /cannot read Hebrew/.test(h.$('#voice-hint').textContent),
  );

  const sock = h.open();
  sock.deliver({ type: 'assistant_text', text: 'A short answer.' });
  await settle();
  h.readBtns(h.bubbles()[0])[0].dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  await settle();
  check(
    `the chosen voice was not asked for: ${JSON.stringify(h.prepareCalls[0]?.voice)}`,
    h.prepareCalls[0]?.voice === 'Ruth',
  );
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  h.close();
}

// --- 7. the parts that decide what is read ---------------------------------
console.log('\nThe fence parser and the renderer agree, block for block:');
{
  const h = boot();
  await settle(120);
  const { fencedBlocks, speakableText, renderMarkdown } = h.speechHooks;

  const blocks = fencedBlocks(MESSAGE);
  check(`two fenced blocks were not found: ${blocks.length}`, blocks.length === 2);
  check('the languages were lost', blocks.map((b) => b.lang).join(',') === 'js,toml');
  check('a block was miscounted', blocks.map((b) => b.lines).join(',') === '2,1');
  check(
    'the block was mapped to the wrong <pre>',
    blocks.map((b) => b.pre).join(',') === '0,1',
  );

  /*
   * An unterminated fence is a message still being written, which is the normal
   * state of a transcript being read while it grows. The renderer emits a `<pre>`
   * for it, so the reader has to count it even though there is nothing to read —
   * otherwise every button after it reads the block before it.
   */
  const half = 'Before.\n\n```js\n\n```\n\nBetween.\n\n```py\nprint(1)\n```\n';
  const halfBlocks = fencedBlocks(half);
  const pres = (renderMarkdown(half).match(/<pre>/g) || []).length;
  check(
    `an empty block was offered a button: ${halfBlocks.length} for one readable block`,
    halfBlocks.length === 1,
  );
  check(
    `the readable block points at the wrong <pre>: ${halfBlocks[0]?.pre} of ${pres}`,
    halfBlocks[0]?.pre === 1 && pres === 2,
  );

  check(
    'the language tag was rendered as text above the code',
    !renderMarkdown('```js\nx\n```').includes('js'),
    renderMarkdown('```js\nx\n```'),
  );

  const heard = speakableText(MESSAGE, 2);
  check('bold markers survived into the speech', !heard.includes('**'));
  check('backticks survived into the speech', !heard.includes('`'));
  check('inline code lost its words', /config\.toml/.test(heard));
  check(
    `the blocks were not named where they were: ${JSON.stringify(heard)}`,
    /guard first: Code block 1\./.test(heard.replace(/\s+/g, ' ')),
  );
  check(
    'a lone block is numbered, which is a number that means nothing',
    speakableText('a\n```\nx\n```\n', 1).includes('Code block.'),
  );
  check(
    'a Hebrew message came back changed — nothing here should touch it, and the '
      + 'server is what decides the voice',
    speakableText('שלום, קוראים לי הילה.', 0) === 'שלום, קוראים לי הילה.',
  );
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  h.close();
}

// --- 8. how fast it reads ---------------------------------------------------
/*
 * The speed, which has one failure that is invisible and one that is merely
 * annoying.
 *
 * The invisible one: a message is a row of separate sources, and setting a new `src`
 * resets `playbackRate` to `defaultPlaybackRate`. A reader that sets only
 * `playbackRate` reads the first piece at 1.5x and everything after it at normal
 * speed, which sounds like the setting half working and is reported as "it doesn't
 * stick".
 *
 * The annoying one: this control is in Settings, two taps from the message. A change
 * that waits for the next message is a change nobody can hear themselves making.
 */
console.log('\nA message can be read faster, and the speed holds across the whole of it:');
{
  const h = boot();
  await settle(120);
  const select = h.$('#select-speed');
  check('there is no way to change the reading speed', Boolean(select));
  check(
    'the speed picker is hidden on a box that can read aloud',
    !h.$('#speed-row').classList.contains('hidden'),
  );
  check(
    `the speed does not start at normal: ${JSON.stringify(select?.value)}`,
    select.value === '1',
  );
  check(
    'normal speed is offered as a bare number, which is not obviously the one to ' +
      'come back to',
    /normal/.test([...select.options].find((o) => o.value === '1')?.textContent || ''),
  );
  check(
    `the ladder is not a media player's: ${[...select.options].map((o) => o.value).join(', ')}`,
    [...select.options].map((o) => o.value).join(',') === '0.5,0.75,1,1.25,1.5,1.75,2,2.5,3',
  );

  select.value = '1.5';
  select.dispatchEvent(new h.w.Event('change'));
  check(
    'the speed was not remembered, so it has to be set again on every launch',
    JSON.parse(h.w.localStorage.getItem('claude-chat') || '{}').speed === 1.5,
  );
  check(
    'nothing says what the number does, on a setting whose whole state is a number',
    /1\.5×/.test(h.$('#speed-hint').textContent || ''),
  );

  const sock = h.open();
  sock.deliver({ type: 'assistant_text', text: 'A short answer, in two pieces.' });
  await settle();
  h.readBtns(h.bubbles()[0])[0].dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  await settle();
  check(
    `the first piece was not played at the chosen speed: ${h.rates.join(', ')}`,
    h.rates[h.rates.length - 1] === 1.5,
  );
  h.audio.el.finish();
  await settle();
  check(
    `the message fell back to normal speed part-way through — a new source resets the `
      + `rate, so every piece has to be told: ${h.rates.join(', ')}`,
    h.played[h.played.length - 1].includes('segment=1')
      && h.rates.every((rate) => rate === 1.5),
  );

  // Mid-read, from the sheet: this is the case the setting exists for, since the
  // decision to speed up is made while listening to something too slow.
  const piecesBefore = h.played.length;
  select.value = '2';
  select.dispatchEvent(new h.w.Event('change'));
  check(
    `a speed change did not reach the audio that is playing: ${h.audio.el.playbackRate}`,
    h.audio.el.playbackRate === 2,
  );
  check(
    'the new speed was not made the element’s default — a source change resets the '
      + 'rate to that, so the rest of the message would be read at the old speed',
    h.audio.el.defaultPlaybackRate === 2,
  );
  check(
    'changing the speed restarted the message, so the part already heard is read again',
    h.played.length === piecesBefore,
  );
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  h.close();
}

// --- 9. a stored speed is not to be trusted ---------------------------------
/*
 * `playbackRate = 0` is an element that plays nothing and reports no error, which is
 * indistinguishable from a voice that is broken. The number comes out of
 * localStorage, so anything off the ladder is snapped back to normal rather than
 * handed to the element.
 */
console.log('\nA speed out of storage is checked before it reaches the element:');
{
  const zero = boot({ settings: { speed: 0 } });
  await settle(120);
  check(
    `a stored speed of zero was kept: ${JSON.stringify(zero.$('#select-speed').value)}`,
    zero.$('#select-speed').value === '1',
  );
  check('a zero speed reached the reader', zero.speechHooks.readSpeed() === 1);
  check('nothing threw', zero.thrown.length === 0, zero.thrown.join('; '));
  zero.close();

  const kept = boot({ settings: { speed: 1.75 } });
  await settle(120);
  check(
    'a speed set on an earlier launch was forgotten',
    kept.$('#select-speed').value === '1.75' && kept.speechHooks.readSpeed() === 1.75,
  );
  check('nothing threw', kept.thrown.length === 0, kept.thrown.join('; '));
  kept.close();
}

// --- 10. the styling exists, since the controls are nothing without it ------
console.log('\nThe controls are styled, and the rows do not break a pre-wrap bubble:');
{
  check('.read-btn has no rule, so the buttons are browser-default grey', /\.read-btn\s*\{/.test(css));
  check(
    'the reading control looks the same as the rest, so Stop is invisible',
    /\.read-btn\.reading\s*\{/.test(css),
  );
  check(
    'the row inherits the bubble’s pre-wrap, which turns its newlines into blank lines',
    /\.read-row\s*\{[^}]*white-space:\s*normal/.test(css),
  );
}

// --- results ---------------------------------------------------------------
// After a tick, so a rejection from the last section has somewhere to land.
await settle(60);
check(
  `a promise on the read-aloud path rejected with nobody watching: ${rejections.join('; ')}`,
  rejections.length === 0,
);

if (failures.length) {
  console.error(`\nFAIL: ${failures.length} of ${checks} check(s) failed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(
  `\nPASS: ${checks} checks — a finished message can be heard, each code block has its `
  + 'own button and is read as code by the server, the audio is unlocked inside the tap '
  + 'and played in order from same-origin URLs, Stop stops and a piece arriving after it '
  + 'is discarded, a refusal is a sentence rather than silence or the wrong voice, a box '
  + 'that cannot synthesise offers no controls at all, an unset voice leaves the '
  + 'choice per message to the server — which is what reads Hebrew in Hebrew — and '
  + 'the chosen speed holds across every piece of a message, reaches the audio '
  + 'already playing, and is snapped back to normal if storage hands it a rate that '
  + 'would play silently.',
);
