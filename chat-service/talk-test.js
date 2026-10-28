/**
 * Talking a message over, out loud, with something that cannot act on it.
 *
 * This is the side of voice that is not dictation and not read-aloud: a spoken
 * conversation about one finished message — *go back to the part about the timeout*
 * — asked while walking. The audio goes straight from the browser to OpenAI, so
 * almost none of this is visible from the server, and none of it from a screenshot.
 *
 * What it holds down, in the order the damage matters:
 *
 *  - **It cannot reach Claude.** That is the whole design constraint, and the check
 *    for it is that the socket to our own box receives nothing at all for the life
 *    of a conversation. The instructions say so too (`realtime.js` asserts on the
 *    string), but an instruction is a request and a missing code path is a fact.
 *  - **The microphone stops.** A dropped `MediaStream` whose tracks were never
 *    stopped leaves the recording indicator on and the mic live after "Hang up" —
 *    on a phone, indefinitely. So: every track, every exit, including hanging up
 *    while still connecting.
 *  - **It is somebody's credit.** The mic is asked for before the credential is
 *    minted (the server counts a session when it reserves, not when it succeeds, so
 *    a refused mic must cost nothing), a session cannot be opened twice from one
 *    button, and closing the panel hangs up rather than leaving a pocket call.
 *  - **The credential is a bearer token for a paid API.** It goes to OpenAI and
 *    nowhere else — not to storage, not into the DOM.
 *  - **What was said is on screen.** A voice channel with no transcript is the one
 *    place a misheard sentence goes unnoticed, and a partial line must be visibly
 *    partial.
 *
 * Run: node chat-service/talk-test.js
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { JSDOM, VirtualConsole } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, 'public');
const html = readFileSync(join(publicDir, 'index.html'), 'utf8');
const js = readFileSync(join(publicDir, 'app.js'), 'utf8');

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

const rejections = [];
process.on('unhandledRejection', (err) => rejections.push(String(err?.message || err)));

/** What the server says about holding a conversation, shaped like realtimeStatus(). */
const REALTIME = {
  configured: true,
  model: 'gpt-realtime',
  voice: 'marin',
  voices: ['marin', 'cedar'],
  maxMinutes: 10,
  budget: { day: '2026-09-21', sessions: 2, limit: 40 },
  reason: null,
};

/** And what a mint returns. The value is the only secret the browser ever holds. */
const MINTED = {
  value: 'ek_test_secret_do_not_log',
  expiresAt: 1790000000,
  model: 'gpt-realtime',
  voice: 'marin',
  sessionId: 'sess_1',
  maxMinutes: 10,
  budget: { day: '2026-09-21', sessions: 3, limit: 40 },
};

const CWD = '/workspace/projects/demo';
const MESSAGE = 'Fixed the timeout.\n\n```js\nconst t = 1500;\n```\n\nDeployed.';

function boot({ realtime = REALTIME, speech = null, webrtc = true, minted = MINTED } = {}) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  const logged = [];
  for (const level of ['log', 'warn', 'error', 'info']) {
    virtualConsole.on(level, (...args) => logged.push(args.join(' ')));
  }
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
  FakeSocket.CONNECTING = 0; FakeSocket.OPEN = 1; FakeSocket.CLOSING = 2; FakeSocket.CLOSED = 3;
  w.WebSocket = FakeSocket;
  w.matchMedia = () => ({ matches: false, addEventListener() {} });

  /* The microphone. Tracks are objects with a stop() that records being called,
   * because "was the mic released" is the question a test can answer and a person
   * cannot. */
  const tracks = [];
  const mic = { denied: false, streams: 0 };
  const makeTrack = (kind = 'audio') => {
    const track = { kind, stopped: false, enabled: true, stop() { this.stopped = true; } };
    tracks.push(track);
    return track;
  };
  w.navigator.mediaDevices = {
    getUserMedia: async (constraints) => {
      mic.constraints = constraints;
      order.push('mic');
      if (mic.denied) {
        const err = new Error('Permission denied');
        err.name = 'NotAllowedError';
        throw err;
      }
      mic.streams += 1;
      const stream = { getTracks: () => stream.tracks, tracks: [makeTrack()] };
      return stream;
    },
  };

  /* The peer connection. Records what it was asked to do and lets the test drive
   * the events a real one would fire. */
  const peers = [];
  class FakePeer {
    constructor() {
      this.state = 'new';
      this.added = [];
      this.channels = [];
      this.local = null;
      this.remote = null;
      this.closed = false;
      this.ontrack = null;
      this.onconnectionstatechange = null;
      peers.push(this);
    }
    get connectionState() { return this.state; }
    addTrack(track, stream) { this.added.push({ track, stream }); }
    createDataChannel(label) {
      const channel = { label, onmessage: null, closed: false, close() { this.closed = true; } };
      this.channels.push(channel);
      return channel;
    }
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\no=- offer\r\n' }; }
    async setLocalDescription(desc) { this.local = desc; }
    async setRemoteDescription(desc) { this.remote = desc; }
    close() { this.closed = true; }
    /** Pretend the far end connected, with a stream of its own. */
    connect(stream = { id: 'remote' }) {
      this.state = 'connected';
      this.ontrack?.({ streams: [stream] });
      this.onconnectionstatechange?.();
    }
    drop() {
      this.state = 'failed';
      this.onconnectionstatechange?.();
    }
    /** Deliver one event on the data channel, as JSON, like OpenAI does. */
    event(msg) {
      for (const channel of this.channels) channel.onmessage?.({ data: JSON.stringify(msg) });
    }
  }
  if (webrtc) w.RTCPeerConnection = FakePeer;

  const audios = [];
  class FakeAudio {
    constructor() { this._src = null; this.srcObject = null; audios.push(this); }
    set src(v) { this._src = v; }
    get src() { return this._src; }
    removeAttribute() {}
    setAttribute() {}
    load() {}
    pause() {}
    play() { return Promise.resolve(); }
  }
  w.Audio = FakeAudio;

  // What happened in which order, because the order is the property: a refused
  // microphone must not have cost a session first.
  const order = [];
  const calls = { mint: [], sdp: [], status: 0, order };
  const state = { mintStatus: 0, mintError: 'that is 40 spoken conversations today', sdpOk: true };
  const json = (body, ok = true, status = 200) =>
    Promise.resolve({ ok, status, json: () => Promise.resolve(body), text: () => Promise.resolve('') });

  w.fetch = (url, options = {}) => {
    const u = String(url);
    if (u.includes('/api/voice-status')) {
      calls.status += 1;
      return json({ configured: true, backend: 'local', speech, realtime });
    }
    if (u.includes('/api/realtime/token')) {
      order.push('mint');
      calls.mint.push({ ...options, body: JSON.parse(options.body || '{}') });
      if (state.mintStatus) return json({ error: state.mintError }, false, state.mintStatus);
      return json(minted);
    }
    // Matched on the path, not the host: the box decides which vendor holds the
    // conversation, so a test that only knows about api.openai.com would report a
    // silent no-op as a pass the day it is Azure.
    if (u.includes('/v1/realtime/calls')) {
      calls.sdp.push({ url: u, body: options.body, headers: options.headers });
      if (!state.sdpOk) return Promise.resolve({ ok: false, status: 403, text: () => Promise.resolve('no') });
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('v=0\r\no=- answer\r\n') });
    }
    if (u.includes('/api/live')) return json({ sessions: [], at: Date.now() });
    if (u.includes('/api/projects')) {
      return json({
        projects: [{ name: 'demo', path: CWD, sessions: [{ sessionId: 'aaa', mtime: Date.now(), title: 'a chat' }] }],
      });
    }
    return json({
      default: 'us.anthropic.claude-opus-5-5',
      models: [{ id: 'us.anthropic.claude-opus-5-5', label: 'Opus 5.5' }],
    });
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

  const doc = w.document;
  return {
    w, doc, sockets, calls, state, mic, tracks, peers, audios, logged, thrown,
    $: (sel) => doc.querySelector(sel),
    talk: w.__talkForTest,
    voice: w.__voiceForTest,
    peer: () => peers[peers.length - 1],
    open() {
      w.__panesForTest.openProject({ name: 'demo', path: CWD });
      const sock = sockets[sockets.length - 1];
      sock.accept();
      sock.deliver({ type: 'ready' });
      sock.deliver({ type: 'attached', conversationId: 'conv-1', cwd: CWD, busy: false, sessionId: 'aaa' });
      return sock;
    },
    bubble: () => [...doc.querySelectorAll('.msg.claude')].pop(),
    talkBtn: () => doc.querySelector('[data-talk]'),
    close: () => w.close(),
  };
}

/** A project, a question of yours, and an answer of Claude's to talk about. */
async function conversation(opts) {
  const h = boot(opts);
  const sock = h.open();
  await settle(120);
  sock.deliver({ type: 'user_message', text: 'why is it timing out?' });
  sock.deliver({ type: 'assistant_text', text: MESSAGE });
  await settle();
  return { h, sock };
}

// --- 1. the control, and where it comes from --------------------------------
console.log('\nA finished message offers a conversation about itself:');
{
  const { h } = await conversation();
  const btn = h.talkBtn();
  check('the message has no Talk control', Boolean(btn));
  check(
    `the control does not say what it does: ${JSON.stringify(btn?.textContent)}`,
    /talk it over/i.test(btn?.textContent || ''),
  );
  check(
    'the control is offered on your own messages too, which have nothing to discuss',
    h.doc.querySelectorAll('[data-talk]').length === 1,
  );
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  h.close();
}

console.log('\nA box with no OpenAI key offers nothing, and neither does a browser with no WebRTC:');
{
  const { h } = await conversation({ realtime: { configured: false, reason: 'no key on this box' } });
  check('a box that cannot hold a conversation offered one anyway', !h.talkBtn());
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  h.close();
}
{
  const { h } = await conversation({ webrtc: false });
  check(
    'a browser with no RTCPeerConnection was offered a conversation it cannot open',
    !h.talkBtn(),
  );
  h.close();
}

// --- 2. what starting one does, and in what order ---------------------------
console.log('\nStarting one asks for the microphone first, then mints a credential:');
{
  const { h, sock } = await conversation();
  const framesBefore = sock.sent.length;
  h.talkBtn().dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  await settle();

  check('the microphone was never asked for', h.mic.streams === 1);
  check(
    `the credential was minted before the microphone was asked for: ${h.calls.order.join(' then ')}`
      + ' — the server counts a session the moment it reserves one, so asking second '
      + 'means a refusal at the prompt has already been paid for',
    h.calls.order.join(',') === 'mic,mint',
  );
  check(
    'the mic was asked for without echo cancellation, which is how a voice hears '
      + 'itself and answers itself',
    h.mic.constraints?.audio?.echoCancellation === true,
    JSON.stringify(h.mic.constraints),
  );
  const mint = h.calls.mint[0];
  check('no credential was minted', Boolean(mint));
  check(
    'the message was not sent as the thing to talk about',
    mint?.body?.text?.includes('const t = 1500'),
  );
  check(
    'the fences were stripped on the way, so the far end cannot tell code from prose '
      + '— it is reading the block, not saying it aloud',
    mint?.body?.text?.includes('```js'),
    JSON.stringify(mint?.body?.text),
  );
  check(
    `what was asked of Claude did not travel with it: ${JSON.stringify(mint?.body?.prompt)}`,
    mint?.body?.prompt === 'why is it timing out?',
  );
  check(
    'the client asked for a model, a voice or a length — every one of those is the '
      + "server's to decide, because every one of them is money",
    !('model' in (mint?.body || {})) && !('instructions' in (mint?.body || {}))
      && !('maxMinutes' in (mint?.body || {})),
    JSON.stringify(Object.keys(mint?.body || {})),
  );

  const sdp = h.calls.sdp[0];
  check('no offer reached OpenAI', Boolean(sdp));
  check(
    `the offer went somewhere other than the calls endpoint: ${sdp?.url}`,
    sdp?.url.startsWith('https://api.openai.com/v1/realtime/calls'),
  );
  check(
    'the offer carried no ephemeral secret, or carried something else',
    sdp?.headers?.Authorization === `Bearer ${MINTED.value}`,
    JSON.stringify(sdp?.headers),
  );
  check('the offer was not an SDP offer', /^v=0/.test(String(sdp?.body || '')));
  check(
    'the model was not named on the call, which is what OpenAI routes on',
    sdp?.url.includes('model=gpt-realtime'),
  );
  check(
    'the microphone track was never added to the connection, so the far end hears '
      + 'nothing and waits forever',
    h.peer().added.length === 1,
  );
  check(
    `the event channel was not opened, or under the wrong name: `
      + `${JSON.stringify(h.peer().channels.map((c) => c.label))}`,
    h.peer().channels.length === 1 && h.peer().channels[0].label === 'oai-events',
  );
  check('the answer was not applied to the connection', /answer/.test(h.peer().remote?.sdp || ''));

  /*
   * The point of the whole feature: this conversation is a dead end. Not one frame
   * to our own box while it is up — no session, no transcript, nothing for Claude
   * to act on, because there is no code path that could.
   */
  h.peer().connect();
  h.peer().event({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'push that for me' });
  h.peer().event({ type: 'response.output_audio_transcript.done', transcript: 'I cannot — say it to Claude in the app.' });
  await settle();
  check(
    `the conversation sent ${sock.sent.length - framesBefore} frame(s) to our own box — `
      + 'it is meant to be a dead end: nothing said out loud reaches Claude',
    sock.sent.length === framesBefore,
    JSON.stringify(sock.sent.slice(framesBefore)),
  );
  check(
    'the panel does not say that this cannot reach Claude, which is the one thing a '
      + 'listener has to know about it',
    /cannot run anything|cannot.*change a file/i.test(h.$('.talk-warning')?.textContent || ''),
  );
  check(
    `the status does not say it is listening: ${JSON.stringify(h.$('#talk-status').textContent)}`,
    /listening/i.test(h.$('#talk-status').textContent),
  );
  check(
    `the panel does not say what it costs or when it ends: ${JSON.stringify(h.$('#talk-note').textContent)}`,
    /3 of 40/.test(h.$('#talk-note').textContent) && /10 minutes/.test(h.$('#talk-note').textContent),
  );

  // The credential is a bearer token for a paid API: it goes to OpenAI and nowhere
  // else. Not to storage, not into the page, not into a log.
  check(
    'the ephemeral secret was written to localStorage',
    !JSON.stringify(h.w.localStorage).includes(MINTED.value),
  );
  check(
    'the ephemeral secret was rendered into the page',
    !h.doc.body.innerHTML.includes(MINTED.value),
  );
  check(
    'the ephemeral secret was logged',
    !h.logged.join(' ').includes(MINTED.value),
    h.logged.join(' | '),
  );
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  h.close();
}

// --- 3. the transcript ------------------------------------------------------
console.log('\nBoth halves of it are on screen, and a half-heard line looks like one:');
{
  const { h } = await conversation();
  h.talkBtn().dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  await settle();
  h.peer().connect();

  h.peer().event({ type: 'conversation.item.input_audio_transcription.delta', delta: 'why one point ' });
  h.peer().event({ type: 'conversation.item.input_audio_transcription.delta', delta: 'five seconds?' });
  await settle();
  const partial = h.doc.querySelector('.talk-line.partial');
  check(
    'a sentence still being heard is not marked as partial — a half-heard line shown '
      + 'as final is how you end up sure it said something it did not',
    Boolean(partial),
  );
  check(
    `the deltas were not joined into one line: ${JSON.stringify(partial?.textContent)}`,
    /why one point five seconds\?/.test(partial?.textContent || ''),
  );
  check('the line does not say who said it', /you/.test(partial?.querySelector('.who')?.textContent || ''));

  h.peer().event({
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: 'Why 1.5 seconds?',
  });
  await settle();
  check(
    'the final transcript did not replace the deltas, so the tidier version never '
      + 'appears and the numbers stay as words',
    /Why 1\.5 seconds\?/.test(h.$('#talk-transcript').textContent),
  );
  check('the line is still marked partial after it finished', !h.doc.querySelector('.talk-line.partial'));

  h.peer().event({ type: 'response.output_audio_transcript.delta', delta: 'Because the read ' });
  h.peer().event({ type: 'response.output_audio_transcript.done', transcript: 'Because the read timed out.' });
  await settle();
  const lines = [...h.doc.querySelectorAll('.talk-line')];
  check(`both halves are not on screen: ${lines.length} line(s)`, lines.length === 2);
  check(
    'the voice half is not attributed to the voice',
    /the voice/.test(lines[1]?.querySelector('.who')?.textContent || ''),
  );
  check(
    'the older spelling of the transcript event is ignored, which would be a silent '
      + 'empty panel against an API version still in the wild',
    (() => {
      h.peer().event({ type: 'response.audio_transcript.done', transcript: 'An older name.' });
      return /An older name\./.test(h.$('#talk-transcript').textContent);
    })(),
  );

  h.peer().event({ type: 'error', error: { message: 'the session expired' } });
  await settle();
  check(
    `an error from the far end was swallowed: ${JSON.stringify(h.$('#talk-status').textContent)}`,
    /session expired/.test(h.$('#talk-status').textContent),
  );
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  h.close();
}

// --- 4. hanging up ----------------------------------------------------------
console.log('\nHanging up releases the microphone, every way out:');
{
  const { h } = await conversation();
  const btn = h.talkBtn();
  btn.dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  await settle();
  h.peer().connect();
  check(
    `the control does not offer a way to end it: ${JSON.stringify(btn.textContent)}`,
    /hang up/i.test(btn.textContent),
  );
  check('the control that started it does not look live', btn.classList.contains('talking'));

  h.$('#btn-talk-end').dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  await settle();
  check('the connection was left open', h.peer().closed);
  check('the event channel was left open', h.peer().channels[0].closed);
  check(
    `the microphone was left live after hanging up — the tracks have to be stopped, `
      + 'not just the stream dropped, or the recording indicator stays on',
    h.tracks.every((t) => t.stopped),
    `${h.tracks.filter((t) => !t.stopped).length} track(s) still running`,
  );
  check('the far end’s audio is still attached', h.audios.every((a) => !a.srcObject));
  check(`the control still says Hang up: ${btn.textContent}`, /talk it over/i.test(btn.textContent));
  check(
    'the transcript was wiped on hang-up, so there is nothing left to read',
    Boolean(h.$('#talk-transcript')),
  );

  // A second tap starts a fresh one rather than a second one on top.
  btn.dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  await settle();
  check('a second conversation reused the first connection', h.peers.length === 2);
  check('the second one minted its own credential', h.calls.mint.length === 2);

  // And tapping the live control hangs up rather than opening a third.
  btn.dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  await settle();
  check(
    'tapping the live control opened another conversation instead of ending this one '
      + '— two sessions at once is two bills and two voices',
    h.peers.length === 2 && h.peers[1].closed,
  );
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  h.close();
}

console.log('\nClosing the panel hangs up, rather than hiding a live line:');
{
  const { h } = await conversation();
  h.talkBtn().dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  await settle();
  h.peer().connect();
  h.doc.querySelector('[data-close-talk]').dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  await settle();
  check(
    'closing the panel left the session running — there is no green bar at the top of '
      + 'a web app to find a forgotten call by',
    h.peer().closed && h.tracks.every((t) => t.stopped),
  );
  check('the panel stayed open', h.$('#talk-sheet').classList.contains('hidden'));
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  h.close();
}

// --- 5. every way it can refuse --------------------------------------------
console.log('\nA refusal is a sentence, and costs nothing:');
{
  const { h } = await conversation();
  h.mic.denied = true;
  h.talkBtn().dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  await settle();
  check(
    'a credential was minted for a conversation with no microphone — the server counts '
      + 'a session when it reserves one, so that is a paid-for session nobody can use',
    h.calls.mint.length === 0,
  );
  check(
    `the refusal does not say the microphone was the problem: ${JSON.stringify(h.$('#talk-status').textContent)}`,
    /microphone/.test(h.$('#talk-status').textContent),
  );
  check('no connection was attempted', h.peers.length === 0);
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  h.close();
}
{
  const { h } = await conversation();
  h.state.mintStatus = 429;
  h.talkBtn().dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  await settle();
  check(
    `the server's own sentence was lost: ${JSON.stringify(h.$('#talk-status').textContent)}`,
    /40 spoken conversations today/.test(h.$('#talk-status').textContent),
  );
  check('a connection was opened despite the refusal', h.peers.length === 0);
  check(
    'the microphone was left running after the refusal',
    h.tracks.every((t) => t.stopped),
  );
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  h.close();
}
{
  const { h } = await conversation();
  h.state.sdpOk = false;
  h.talkBtn().dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  await settle();
  check(
    `OpenAI refusing the connection said nothing: ${JSON.stringify(h.$('#talk-status').textContent)}`,
    /not connected/i.test(h.$('#talk-status').textContent),
  );
  check('the failed connection was left open', h.peer().closed);
  check('the microphone was left live after a failed connection', h.tracks.every((t) => t.stopped));
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  h.close();
}
{
  const { h } = await conversation();
  h.peers.length = 0;
  h.voice.voice.active = true;                    // dictation is listening
  h.talkBtn().dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  await settle();
  check(
    'a conversation started over live dictation — two things listening to one '
      + 'microphone, and the recognizer types what the voice says into the composer',
    h.calls.mint.length === 0 && h.peers.length === 0,
  );
  check(
    `nothing said why: ${JSON.stringify(h.$('#toast').textContent)}`,
    /microphone is listening/.test(h.$('#toast').textContent || ''),
  );
  h.voice.voice.active = false;
  h.close();
}
{
  // Hanging up while it is still connecting: the credential is spent, but the mic
  // must not be left live and the audio must not start.
  const { h } = await conversation();
  h.talkBtn().dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  h.talk.endTalking();                            // before any await has resolved
  await settle();
  check(
    'hanging up mid-connect left the microphone live, which is the worst version of '
      + 'this: no session on screen and a hot mic',
    h.tracks.every((t) => t.stopped),
    `${h.tracks.filter((t) => !t.stopped).length} track(s) still running`,
  );
  check(
    'the abandoned session still attached audio and started playing',
    h.audios.every((a) => !a.srcObject),
  );
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  h.close();
}

// --- 6. the prompt it is given ----------------------------------------------
console.log('\nThe context is this message and what was asked for it, and nothing else:');
{
  const { h } = await conversation();
  const { promptBefore } = h.talk;
  const bubble = h.bubble();
  check('the question before the answer was not found', promptBefore(bubble) === 'why is it timing out?');

  /*
   * A thread whose last message follows another of Claude's — a resumed session, a
   * hook, a subagent — has no prompt of its own to give. Reaching further back for
   * one would put a stranger's words in the prompt as though they were the question.
   */
  const second = h.doc.createElement('div');
  second.className = 'msg claude';
  bubble.after(second);
  check(
    'a message with no question before it borrowed one from further up the thread',
    promptBefore(second) === '',
  );
  const orphan = h.doc.createElement('div');
  orphan.className = 'msg claude';
  check('a message with nothing before it invented a prompt', promptBefore(orphan) === '');
  h.close();
}

// --- 7. the line dropping on its own ---------------------------------------
console.log('\nA dropped line says so, and does not leave the mic on:');
{
  const { h } = await conversation();
  h.talkBtn().dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  await settle();
  h.peer().connect();
  h.peer().drop();
  await settle();
  check(
    `a dropped connection said nothing: ${JSON.stringify(h.$('#talk-status').textContent)}`,
    /dropped/i.test(h.$('#talk-status').textContent),
  );
  check('a dropped connection left the microphone live', h.tracks.every((t) => t.stopped));
  check(
    `the control still offers Hang up for a line that is gone: ${h.talkBtn().textContent}`,
    /talk it over/i.test(h.talkBtn().textContent),
  );
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  h.close();
}

// --- 8. whose realtime API it is ------------------------------------------
/*
 * The client does not choose the vendor, and must not know one.
 *
 * The box may be holding an Azure deployment (billed to sponsorship credits, which
 * cannot reach a card) or an OpenAI key, and it says which by handing back a
 * `callUrl` with the credential. A client that keeps its own copy of
 * `api.openai.com` sends the offer — and the ephemeral secret — to a vendor that
 * did not mint it, which fails as a 401 the user reads as "voice is broken".
 *
 * The fallback is tested too, and it is not decoration: an old tab that was loaded
 * before this change is still running somewhere, and it gets no `callUrl` at all.
 */
console.log('\nThe offer goes wherever the box says, not to a vendor baked into the client:');
{
  const AZURE_CALL = 'https://claudeweb-realtime-6f2a9c.openai.azure.com/openai/v1/realtime/calls';
  const { h } = await conversation({
    minted: { ...MINTED, callUrl: AZURE_CALL, provider: 'azure', model: 'gpt-realtime-mini' },
  });
  h.talkBtn().dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  await settle();
  const sdp = h.calls.sdp[0];
  check('no offer was sent at all', Boolean(sdp));
  check(
    `the offer ignored the URL the box minted for it and went to ${sdp?.url}`,
    sdp?.url === AZURE_CALL,
  );
  check(
    'the client appended a ?model= query Azure does not read',
    !String(sdp?.url || '').includes('?'),
  );
  check(
    'the ephemeral secret went to the vendor that minted it',
    sdp?.headers?.Authorization === `Bearer ${MINTED.value}`,
  );
  check('the connection did not come up', h.peer()?.remote?.sdp?.startsWith('v=0'));
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  h.close();
}

{
  // No callUrl: an older service, or an older tab against one. Still works.
  const { h } = await conversation({ minted: { ...MINTED } });
  h.talkBtn().dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  await settle();
  const sdp = h.calls.sdp[0];
  check(
    `a mint with no callUrl sent the offer to ${sdp?.url} instead of OpenAI`,
    String(sdp?.url || '').startsWith('https://api.openai.com/v1/realtime/calls?model='),
  );
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  h.close();
}

// --- 9. muting, without hanging up ------------------------------------------
/*
 * Mute exists because of how the session is minted: semantic turn detection with
 * `interrupt_response` on, so a cough or somebody else's sentence cuts off the
 * explanation mid-word — and hanging up and starting again spends another of the day's
 * forty. So it has to disable the track and keep everything else, and the failure worth
 * testing for is the one that looks identical for a second: stopping the track, which
 * ends the microphone and cannot be undone.
 */
console.log('\nMute silences the microphone and keeps the line:');
{
  const { h } = await conversation();
  const click = (el) => el?.dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  click(h.talkBtn());
  await settle();
  h.peer().connect();
  await settle();

  const mute = () => h.$('#btn-talk-mute');
  check('a live line offers no way to mute the microphone', Boolean(mute()));
  check('the mute control is disabled while a line is up', !mute().disabled);
  check(
    'the microphone starts out muted, so the first thing said into it goes nowhere',
    h.tracks.length > 0 && h.tracks.every((t) => t.enabled === true),
  );

  click(mute());
  await settle();
  check(
    'muting left the microphone sending — everything the room says still reaches the far end',
    h.tracks.every((t) => t.enabled === false),
  );
  check(
    'muting stopped the track rather than disabling it, which closes the microphone: '
      + 'there is no unmuting after that, only another session against the day',
    h.tracks.every((t) => !t.stopped),
  );
  check('muting closed the connection, which is hanging up by another name', !h.peer().closed);
  check('muting closed the event channel, so the transcript stops where the mute did', !h.peer().channels[0].closed);
  check(
    'muting took the far end’s audio with it — being able to listen is the reason to '
      + 'mute rather than hang up',
    h.audios.some((a) => a.srcObject),
  );
  check(
    `the panel still claims to be listening while muted: ${JSON.stringify(h.$('#talk-status').textContent)}`,
    /^muted/i.test(h.$('#talk-status').textContent),
  );
  check(
    'the panel does not say the line is still open while muted — muting instead of '
      + 'hanging up and then walking away is the one mistake this button makes possible',
    /still open/i.test(h.$('#talk-status').textContent),
  );
  check(
    `the control does not say how to undo itself: ${JSON.stringify(mute().textContent)}`,
    mute().textContent === 'Unmute',
  );
  check('a screen reader is not told the toggle is on', mute().getAttribute('aria-pressed') === 'true');

  click(mute());
  await settle();
  check('unmuting did not give the microphone back, so mute is a one-way door', h.tracks.every((t) => t.enabled));
  check(
    `the panel still says muted after unmuting: ${JSON.stringify(h.$('#talk-status').textContent)}`,
    /^listening$/i.test(h.$('#talk-status').textContent),
  );
  check(
    `the control did not go back: ${JSON.stringify(mute().textContent)}`,
    mute().textContent === 'Mute' && mute().getAttribute('aria-pressed') === 'false',
  );

  // Hang up muted, then start another: a line that opens muted is one you talk into for
  // ten seconds before finding out, with the day's count already spent on it.
  click(mute());
  await settle();
  click(h.$('#btn-talk-end'));
  await settle();
  check('hanging up while muted left a track live', h.tracks.every((t) => t.stopped));
  check(
    `the control is still offered with no line to mute: ${JSON.stringify(mute().textContent)}`,
    mute().disabled && mute().textContent === 'Mute',
  );
  click(h.talkBtn());
  await settle();
  h.peer().connect();
  await settle();
  const fresh = h.tracks.filter((t) => !t.stopped);
  check('the second conversation never opened', fresh.length > 0);
  check('a new conversation inherited the last one’s mute', fresh.every((t) => t.enabled === true));
  check(
    `the new line says: ${JSON.stringify(h.$('#talk-status').textContent)}`,
    /^listening$/i.test(h.$('#talk-status').textContent),
  );
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  h.close();
}

// --- results ---------------------------------------------------------------
await settle(60);
check(
  `a promise on the conversation path rejected with nobody watching: ${rejections.join('; ')}`,
  rejections.length === 0,
);

if (failures.length) {
  console.error(`\nFAIL: ${failures.length} of ${checks} check(s) failed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(
  `\nPASS: ${checks} checks — a finished message offers a spoken conversation about `
  + 'itself when the box can hold one; it asks for the microphone before it mints '
  + 'anything, sends the raw message and the question that produced it, opens WebRTC '
  + 'straight to OpenAI with a secret that reaches nothing else, and sends not one '
  + 'frame to our own box for the life of it — it cannot reach Claude because there '
  + 'is no path to. Both halves of what is said are on screen, a partial line looks '
  + 'partial, and every way out — Hang up, closing the panel, a dropped line, a '
  + 'refusal, hanging up mid-connect — stops the microphone. Mute is the one thing '
  + 'that does not: it disables the track, says so, says the line is still open, and '
  + 'is never inherited by the next conversation.',
);
