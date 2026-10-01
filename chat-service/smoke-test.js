/**
 * Boot the client in a real DOM and assert it renders.
 *
 * `node --check` only parses — it cannot catch a runtime ReferenceError like
 * using a `const` before its declaration, which kills the whole script and
 * leaves the page stuck on "Loading…". That exact bug shipped once; this test
 * exists so it can't again.
 *
 * Run: node chat-service/smoke-test.js
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, 'public');

const html = readFileSync(join(publicDir, 'index.html'), 'utf8');
const js = readFileSync(join(publicDir, 'app.js'), 'utf8');

const dom = new JSDOM(html, {
  runScripts: 'outside-only',
  // Any HTTPS origin works; the client only reads location.protocol and .host to
  // build the WebSocket URL. Kept deliberately generic so this test is not tied
  // to one deployment's hostname.
  url: 'https://claude.example.com/',
});
const w = dom.window;

const calls = [];
// Transcripts the fake server hands back, in order, one per /api/transcribe.
const transcripts = [];
// What the fake cleanup pass returns, and what it was asked to clean. `null`
// means "hand it back untouched", which is also what the real route does when
// Bedrock is unreachable — so the default here is the failure path.
let polishReply = null;
const polished = [];
w.fetch = (url, options = {}) => {
  calls.push(String(url));
  if (String(url).includes('/api/polish')) {
    const asked = JSON.parse(options.body || '{}').text;
    polished.push(asked);
    const text = polishReply ?? asked;
    // Deliberately not immediate: the composer is live during this, and the
    // window between asking and answering is where this feature can do damage.
    return new Promise((resolve) =>
      setTimeout(() => resolve({
        ok: true,
        json: () => Promise.resolve({ text, changed: text !== asked }),
      }), 40));
  }
  if (String(url).includes('/api/transcribe')) {
    const text = transcripts.shift() ?? '';
    // Deliberately answer earlier phrases *slower* than later ones. If phrases
    // were transcribed concurrently they would finish in reverse and the
    // transcript would come out scrambled, so this is what makes the ordering
    // assertion below prove something rather than pass by luck.
    const delay = Math.max(0, 60 - 20 * calls.filter((u) => u.includes('/api/transcribe')).length);
    return new Promise((resolve) =>
      setTimeout(() => resolve({ ok: true, json: () => Promise.resolve({ text }) }), delay));
  }
  // Polled every few seconds for the tab dots and the list badges. Answered
  // properly rather than left to the fallback below, because a boot that throws
  // in the poller is exactly the kind of break this file exists to catch.
  if (String(url).includes('/api/live')) {
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ sessions: [] }) });
  }
  const body = String(url).includes('/api/projects')
    ? {
        projects: [
          {
            name: 'demo',
            path: '/workspace/projects/demo',
            sessions: [{ sessionId: 'abc123', mtime: Date.now(), title: 'a past chat' }],
          },
        ],
      }
    : { models: [{ id: 'us.anthropic.claude-opus-5', label: 'Opus 5' }] };
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
};

// Minimal WebSocket stand-in: the list screen must render without a live socket.
w.WebSocket = function () {
  this.addEventListener = () => {};
  this.send = () => {};
  this.close = () => {};
  this.readyState = 0;
};
w.WebSocket.CONNECTING = 0;
w.WebSocket.OPEN = 1;
w.matchMedia = () => ({ matches: false, addEventListener() {} });

const failures = [];
w.addEventListener('error', (e) => failures.push(`uncaught: ${e.message}`));

try {
  w.eval(js);
} catch (err) {
  console.error(`FAIL: app.js threw on load — ${err.constructor.name}: ${err.message}`);
  console.error(err.stack?.split('\n').slice(0, 5).join('\n'));
  process.exit(1);
}

// Give the boot-time fetches a tick to settle.
await new Promise((resolve) => setTimeout(resolve, 300));

const listBody = w.document.querySelector('#list-body')?.innerHTML ?? '';

if (!calls.some((u) => u.includes('/api/projects'))) {
  failures.push('never fetched /api/projects');
}
if (listBody.includes('Loading')) {
  failures.push('list still shows "Loading…" after boot');
}
if (!listBody.includes('class="row"')) {
  failures.push('no conversation rows rendered');
}
if (!listBody.includes('a past chat')) {
  failures.push('session title missing from the rendered list');
}

// A resumed conversation arrives as one `history` frame. Assert the client can
// render it — this path is what a phone hits when opening an existing chat.
// Everything that renders now belongs to a pane, so one has to be open first;
// pane-test.js covers what happens with several of them.
const handler = w.__handleEventForTest;
const panesHooks = w.__panesForTest;
let chat = null;
if (typeof handler === 'function' && panesHooks) {
  try {
    chat = panesHooks.openConversation({
      cwd: '/workspace/projects/demo',
      project: 'demo',
      sessionId: 'abc123',
      title: 'a past chat',
    });
    handler({
      type: 'history',
      truncated: 340,
      messages: [
        { type: 'user_message', text: 'a question' },
        { type: 'assistant_text', text: 'an **answer** with `code`' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a/b.txt' } },
      ],
    }, chat);
    const thread = chat.thread?.innerHTML ?? '';
    if (!thread.includes('a question')) failures.push('history: user message not rendered');
    if (!thread.includes('answer')) failures.push('history: assistant message not rendered');
    if (!thread.includes('class="tool"')) failures.push('history: tool card not rendered');
    if (!thread.includes('340 earlier')) failures.push('history: truncation notice missing');
    // The thread is the pane's own element, not a fixed one in index.html.
    if (chat.thread?.parentElement?.id !== 'threads') {
      failures.push("history: the pane's thread is not inside #threads");
    }
  } catch (err) {
    failures.push(`history render threw: ${err.message}`);
  }
} else {
  failures.push('client did not expose handleEvent and the pane hooks for testing');
}

// Dictation that stops on its own must never do so quietly: the bug this guards
// against is a phone whose screen slept mid-sentence, where the only evidence
// was a mic button the user could no longer see.
{
  const hooks = w.__voiceForTest;
  if (!hooks) {
    failures.push('client did not expose the voice hooks for testing');
  } else {
    const box = w.document.querySelector('#input');
    box.value = 'a half-finished sentence';
    hooks.voice.active = true;
    hooks.voice.startedAt = Date.now();
    hooks.stopVoice({ reason: 'the app went to the background' });

    const bar = w.document.querySelector('#dictation-bar');
    if (bar.classList.contains('hidden')) {
      failures.push('interrupted dictation left no visible notice');
    }
    if (!/stopped/i.test(bar.textContent)) {
      failures.push('dictation notice does not say dictation stopped');
    }
    if (w.document.querySelector('#btn-dictation-resume').classList.contains('hidden')) {
      failures.push('interrupted dictation offers no way to resume');
    }
    if (box.value !== 'a half-finished sentence') {
      failures.push('interrupted dictation discarded the text already dictated');
    }

    // Resume must continue where the interruption left off. The composer is
    // deliberately left unfocused behind the banner, and an unfocused textarea
    // reports selectionStart 0 — which put resumed words at the front of the box
    // and shunted the earlier dictation behind them, reading as a doubled phrase.
    hooks.voice.anchor = 4;
    hooks.voice.committed = ' dictated words';
    hooks.voice.active = true;
    hooks.stopVoice({ reason: 'the screen turned off' });
    box.setSelectionRange(0, 0);
    if (hooks.nextDictationAnchor() !== 4 + ' dictated words'.length) {
      failures.push('resuming dictation did not continue where it stopped');
    }

    // A stop the user asked for is not an alarm.
    hooks.voice.active = true;
    hooks.stopVoice();
    if (!w.document.querySelector('#dictation-bar').classList.contains('hidden')) {
      failures.push('a deliberate stop still showed the interruption notice');
    }
    // ...and it hands the anchor back to the caret rather than pinning it.
    box.value = 'typed';
    box.setSelectionRange(2, 2);
    if (hooks.nextDictationAnchor() !== 2) {
      failures.push('a deliberate stop still pinned the next dictation anchor');
    }

    // Two taps on the mic must not open two recorders: both would capture the
    // same speech into one upload and it would come back transcribed twice.
    let micOpens = 0;
    Object.defineProperty(w.navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: () => { micOpens++; return new Promise(() => {}); } },
    });
    hooks.voice.mode = 'record';
    hooks.voice.active = false;
    hooks.startVoice();
    hooks.startVoice();
    if (micOpens !== 1) {
      failures.push(`overlapping mic taps opened the microphone ${micOpens} times, expected 1`);
    }

    // Whisper narrates non-speech in brackets and, on near-silence, sometimes
    // emits a stock phrase. Chunked dictation feeds it many short quiet
    // segments, so any of this reaching the composer would be constant.
    const junk = [['[BLANK_AUDIO]', ''], ['(wind blowing)', ''], ['Thank you.', ''],
                  ['  Hello   there. ', 'Hello there.'], ['[MUSIC] real words', 'real words']];
    for (const [raw, want] of junk) {
      const got = hooks.cleanTranscript(raw);
      if (got !== want) failures.push(`cleanTranscript(${JSON.stringify(raw)}) = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
    if (hooks.joinPhrases('First one.', 'Second one.') !== 'First one. Second one.') {
      failures.push('joinPhrases did not space two phrases correctly');
    }
  }
}

// Where the audio gets cut is the whole feature: cuts must land in silence so no
// word is split across two transcription requests. Driven with synthetic frames
// because a real ScriptProcessor callback cannot be exercised here.
{
  const hooks = w.__voiceForTest;
  if (hooks) {
    const RATE = 16000;
    const FRAME = 512;                       // 32ms at 16 kHz
    const frames = (ms, rms) => {
      const out = [];
      for (let n = 0; n < Math.round((ms / 1000) * RATE / FRAME); n++) {
        const f = new Float32Array(FRAME);
        // A constant magnitude gives exactly this RMS.
        for (let i = 0; i < FRAME; i++) f[i] = i % 2 ? rms : -rms;
        out.push(f);
      }
      return out;
    };
    const LOUD = hooks.VAD.speech * 3;
    const QUIET = hooks.VAD.silence / 3;

    const run = (script) => {
      const cuts = [];
      const cutter = hooks.createPhraseCutter(RATE, (s) => cuts.push(s.length / RATE));
      for (const f of script) cutter.push(f);
      cutter.flush();
      return cuts;
    };

    // Two sentences with a clear pause between them: two phrases.
    const two = run([
      ...frames(1200, LOUD),
      ...frames(hooks.VAD.hangoverMs + 200, QUIET),
      ...frames(1000, LOUD),
    ]);
    if (two.length !== 2) {
      failures.push(`speech-pause-speech produced ${two.length} phrases, expected 2`);
    }

    // A short pause *within* a sentence must not cut: that is what split words
    // mid-phrase and made the old path need overlap-guessing to recover.
    const one = run([
      ...frames(900, LOUD),
      ...frames(Math.max(60, hooks.VAD.hangoverMs - 300), QUIET),
      ...frames(900, LOUD),
    ]);
    if (one.length !== 1) {
      failures.push(`a brief pause mid-sentence produced ${one.length} phrases, expected 1`);
    }

    // Silence alone is never a phrase.
    if (run(frames(3000, QUIET)).length !== 0) {
      failures.push('silence alone produced a phrase');
    }

    // One long unbroken sentence must still be cut, or nothing is transcribed
    // until the user stops talking.
    const long = run(frames(hooks.VAD.maxPhraseMs + 3000, LOUD));
    if (long.length < 2) {
      failures.push(`${(hooks.VAD.maxPhraseMs + 3000) / 1000}s of unbroken speech produced ${long.length} phrases, expected a forced cut`);
    }
    if (long.some((d) => d * 1000 > hooks.VAD.maxPhraseMs + hooks.VAD.frameMs * 4)) {
      failures.push(`a forced cut exceeded maxPhraseMs: ${JSON.stringify(long)}`);
    }
  }
}

// The streaming path replaced a word-overlap heuristic that stitched fragments
// from the browser recognizer — the thing that produced doubled words. What
// matters now is that separately-transcribed phrases land in the order spoken,
// exactly once each, with the junk dropped.
{
  const hooks = w.__voiceForTest;
  if (hooks) {
    const box = w.document.querySelector('#input');
    box.value = '';
    box.setSelectionRange(0, 0);
    hooks.voice.resumeFromEnd = false;
    hooks.voice.anchor = 0;
    hooks.voice.committed = '';
    hooks.voice.finalText = '';
    hooks.voice.queue = [];
    hooks.voice.pumping = false;
    hooks.voice.active = false;
    hooks.voice.sampleRate = 16000;

    transcripts.length = 0;
    transcripts.push('Let me know when it is deployed', '[BLANK_AUDIO]', 'so I can test it.');

    // Long enough to clear the minimum-phrase gate; contents are irrelevant
    // because the fake server does not look at the audio.
    const phrase = () => new Float32Array(Math.ceil(0.6 * 16000));
    hooks.enqueuePhrase(phrase());
    hooks.enqueuePhrase(phrase());
    hooks.enqueuePhrase(phrase());
    // A phrase too short to be speech must never be sent at all.
    hooks.enqueuePhrase(new Float32Array(64));

    await new Promise((resolve) => {
      const wait = () => (hooks.voice.pumping || hooks.voice.queue.length
        ? setTimeout(wait, 10)
        : resolve());
      wait();
    });

    const want = 'Let me know when it is deployed so I can test it.';
    if (box.value !== want) {
      failures.push(`streamed phrases assembled as ${JSON.stringify(box.value)}, want ${JSON.stringify(want)}`);
    }
    const sent = calls.filter((u) => u.includes('/api/transcribe')).length;
    if (sent !== 3) {
      failures.push(`sent ${sent} phrases for transcription, expected 3 (the 64-sample one is noise)`);
    }
  }
}

// Punctuating a finished dictation. The reason this is worth testing is not the
// happy path — it is that the pass answers a second or two after the words land,
// while the composer is live, and it rewrites text in place. Overwriting what
// somebody typed in that window, or pasting a stale sentence over a fresh
// dictation, would be far worse than the missing full stops it fixes.
{
  const hooks = w.__voiceForTest;
  if (typeof hooks?.polishDictation !== 'function') {
    failures.push('client did not expose the dictation cleanup for testing');
  } else {
    const box = w.document.querySelector('#input');
    const RAW = 'compared to Georgia PT and Germany apps for consumers';
    const CLEAN = 'compared to ChatGPT and Gemini apps for consumers.';

    // An earlier block leaves a start pending on a getUserMedia that never
    // resolves; the cleanup pass correctly refuses to touch the box while
    // dictation is starting, so that has to be cleared first.
    const idle = () => {
      hooks.voice.active = false;
      hooks.voice.starting = false;
      hooks.voice.polishing = null;
    };

    // The ordinary case: the dictated span is replaced, and text typed around it
    // is left exactly where it was.
    idle();
    box.value = `before ${RAW} after`;
    hooks.voice.anchor = 'before '.length;
    hooks.voice.committed = RAW;
    polishReply = CLEAN;
    polished.length = 0;
    await hooks.polishDictation();
    if (box.value !== `before ${CLEAN} after`) {
      failures.push(`cleanup produced ${JSON.stringify(box.value)}, want ${JSON.stringify(`before ${CLEAN} after`)}`);
    }
    if (polished[0] !== RAW) {
      failures.push(`cleanup sent ${JSON.stringify(polished[0])} to the server, want the dictated text`);
    }

    // Carrying on typing while the pass is in flight. What was typed must survive
    // untouched, the dictation must still get punctuated, and the caret must end
    // up where the typing left it rather than back at the end of the dictation.
    idle();
    box.value = RAW;
    hooks.voice.anchor = 0;
    hooks.voice.committed = RAW;
    polishReply = CLEAN;
    const inFlight = hooks.polishDictation();
    box.value = `${RAW} and one more thought`;
    box.setSelectionRange(box.value.length, box.value.length);
    await inFlight;
    if (box.value !== `${CLEAN} and one more thought`) {
      failures.push(`cleanup mishandled text typed while it was in flight: ${JSON.stringify(box.value)}`);
    }
    if (box.selectionStart !== box.value.length) {
      failures.push(`cleanup left the caret at ${box.selectionStart}, want the end of what was typed (${box.value.length})`);
    }

    // Editing the dictated words themselves is different: the reply describes the
    // sentence that was there before, so applying it would undo the correction.
    idle();
    box.value = RAW;
    hooks.voice.anchor = 0;
    hooks.voice.committed = RAW;
    polishReply = CLEAN;
    const edited = hooks.polishDictation();
    box.value = RAW.replace('Georgia PT', 'ChatGPT');
    await edited;
    if (box.value !== RAW.replace('Georgia PT', 'ChatGPT')) {
      failures.push(`cleanup undid an edit to the dictated words: ${JSON.stringify(box.value)}`);
    }

    // Starting a new dictation is the same problem with a worse outcome: the
    // reply describes the previous utterance.
    idle();
    box.value = RAW;
    hooks.voice.anchor = 0;
    hooks.voice.committed = RAW;
    polishReply = CLEAN;
    const stale = hooks.polishDictation();
    hooks.voice.active = true;
    await stale;
    if (box.value !== RAW) {
      failures.push(`cleanup rewrote the box under a new dictation: ${JSON.stringify(box.value)}`);
    }

    // Off means no request at all, not a request whose answer is discarded: it
    // costs tokens and it is somebody's dictation leaving the box.
    idle();
    hooks.setPolishDictation(false);
    box.value = RAW;
    hooks.voice.anchor = 0;
    hooks.voice.committed = RAW;
    polished.length = 0;
    await hooks.polishDictation();
    if (polished.length !== 0) {
      failures.push('cleanup called the server with the setting turned off');
    }
    hooks.setPolishDictation(true);

    // Sending immediately after speaking is the normal way to use dictation, so a
    // send must not race the pass and ship the unpunctuated version.
    idle();
    const sent = [];
    // The socket belongs to the pane the composer is pointing at, which is the
    // one opened above.
    if (chat) chat.ws = { readyState: 1, send: (frame) => sent.push(JSON.parse(frame)) };
    box.value = RAW;
    hooks.voice.anchor = 0;
    hooks.voice.committed = RAW;
    polishReply = CLEAN;
    hooks.polishDictation();
    await hooks.sendMessage();
    if (sent[0]?.text !== CLEAN) {
      failures.push(`sending mid-cleanup sent ${JSON.stringify(sent[0]?.text)}, want the punctuated text`);
    }
    if (chat) chat.ws = null;
    polishReply = null;
  }
}

/*
 * Starting dictation over from nothing.
 *
 * The bug this button answers is dictation that remembers: text from an earlier
 * utterance reappearing under the next one, where emptying the composer by hand
 * does not help because none of what puts it back is in the composer. So what has
 * to be proved is not that the fields were assigned — it is the three things that
 * survive an assignment: a draft on disk, a phrase already uploaded, and a
 * microphone granted after the user gave up on it.
 */
{
  const hooks = w.__voiceForTest;
  const drafts = w.__draftForTest;
  if (typeof hooks?.resetDictation !== 'function') {
    failures.push('client did not expose the dictation reset for testing');
  } else {
    const box = w.document.querySelector('#input');
    const bar = w.document.querySelector('#dictation-bar');
    const undoBtn = w.document.querySelector('#btn-dictation-undo');
    const TEXT = 'the words already dictated';

    // A dictation holding every kind of state at once: a live recognizer, an open
    // microphone, a phrase queued, an interruption waiting to be resumed, a
    // transcript in the box and a copy of it on disk.
    let aborted = 0;
    let tracksStopped = 0;
    hooks.voice.recognition = { abort: () => { aborted += 1; } };
    hooks.voice.stream = { getTracks: () => [{ stop: () => { tracksStopped += 1; } }] };
    hooks.voice.active = true;
    hooks.voice.starting = false;
    hooks.voice.committed = TEXT;
    hooks.voice.finalText = TEXT;
    hooks.voice.anchor = 0;
    hooks.voice.queue = [new Float32Array(16000)];
    hooks.voice.pumping = true;
    hooks.voice.resumeFromEnd = true;
    hooks.voice.dropped = 2;
    hooks.voice.pendingReason = 'the screen turned off';
    hooks.voice.polishing = Promise.resolve();
    box.value = TEXT;
    drafts.saveDraft({ now: true });
    const draftKey = drafts.draftKeyFor(w.__panesForTest.activePane());
    if (!w.localStorage.getItem(draftKey)) {
      failures.push('reset test could not put a draft on disk to clear');
    }

    hooks.resetDictation();

    if (box.value !== '') failures.push(`reset left ${JSON.stringify(box.value)} in the composer`);
    if (w.localStorage.getItem(draftKey)) {
      failures.push('reset left the saved draft on disk, so the text comes back on reload');
    }
    if (aborted !== 1) failures.push('reset did not abort the recognizer');
    if (tracksStopped !== 1) failures.push('reset did not release the microphone');
    for (const [field, want] of [
      ['active', false], ['starting', false], ['recognition', null], ['recorder', null],
      ['stream', null], ['committed', ''], ['finalText', ''], ['anchor', 0],
      ['pumping', false], ['resumeFromEnd', false], ['dropped', 0],
      ['pendingReason', null], ['polishing', null],
    ]) {
      if (hooks.voice[field] !== want) {
        failures.push(`reset left voice.${field} as ${JSON.stringify(hooks.voice[field])}, want ${JSON.stringify(want)}`);
      }
    }
    if (hooks.voice.queue.length) failures.push('reset left phrases queued for transcription');
    if (bar.classList.contains('hidden') || !/reset/i.test(bar.textContent)) {
      failures.push(`reset said nothing about what it did: ${JSON.stringify(bar.textContent)}`);
    }
    if (undoBtn.classList.contains('hidden')) {
      failures.push('reset offered no way back for the text it cleared');
    }

    // Undo is about the text only: the state the reset released stays released.
    undoBtn.click();
    if (box.value !== TEXT) {
      failures.push(`Undo restored ${JSON.stringify(box.value)}, want the text the reset cleared`);
    }
    if (hooks.voice.committed !== '' || hooks.voice.resumeFromEnd) {
      failures.push('Undo put the dictation state back as well as the text');
    }
    if (!undoBtn.classList.contains('hidden')) {
      failures.push('Undo stayed on offer after it was taken');
    }

    // A phrase already uploaded cannot be recalled, so its answer has to be dropped
    // on arrival. Before this it landed in the composer a second after the reset,
    // which is the ghost text the whole button exists for.
    box.value = '';
    hooks.voice.active = false;
    hooks.voice.committed = '';
    hooks.voice.finalText = '';
    hooks.voice.anchor = 0;
    hooks.voice.queue = [];
    hooks.voice.pumping = false;
    hooks.voice.sampleRate = 16000;
    transcripts.length = 0;
    transcripts.push('a sentence from the dictation that was thrown away');
    hooks.enqueuePhrase(new Float32Array(Math.ceil(0.6 * 16000)));
    hooks.resetDictation();
    await new Promise((resolve) => setTimeout(resolve, 120));
    if (box.value !== '') {
      failures.push(`a phrase in flight across a reset still landed in the composer: ${JSON.stringify(box.value)}`);
    }
    if (hooks.voice.pumping) failures.push('an orphaned transcription left the pump flagged as running');

    // Reset while the permission prompt is up. The microphone is granted to a
    // dictation that no longer exists: keeping it leaves the recording indicator
    // lit, and using it starts the dictation the user just cancelled.
    let granted = 0;
    let grant = null;
    Object.defineProperty(w.navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: () => new Promise((resolve) => { grant = resolve; }) },
    });
    hooks.voice.mode = 'record';
    hooks.voice.active = false;
    hooks.voice.starting = false;
    const starting = hooks.startVoice().catch((err) => {
      failures.push(`a reset during the mic prompt threw: ${err.message}`);
    });
    hooks.resetDictation();
    if (hooks.voice.starting) failures.push('reset left a start pending');
    grant({ getTracks: () => [{ stop: () => { granted += 1; } }] });
    await starting;
    if (granted !== 1) {
      failures.push('a microphone granted after a reset was not handed back');
    }
    if (hooks.voice.recorder || hooks.voice.stream) {
      failures.push('a microphone granted after a reset still started a recording');
    }

    // Leave nothing of this behind for the blocks that follow: Undo wrote the text
    // back to disk on its way through.
    box.value = '';
    drafts.writeDraft();
  }
}

// Keeping the display awake for as long as the app is open. None of this is
// observable from a desktop browser — whether a screen sleeps is invisible to the
// page — so the reconciler is driven against a fake wakeLock. What the fake
// models is the part that actually bites: the browser drops the lock on every
// hide and never takes it back, and the OS revokes it whenever it likes, so
// anything that acquires once is awake for one screen-off and asleep after.
{
  const screen = w.__screenForTest;
  const vhooks = w.__voiceForTest;
  if (!screen) {
    failures.push('client did not expose the screen hooks for testing');
  } else {
    let requests = 0;
    let released = 0;
    let lastLock = null;
    let visibility = 'visible';
    let refuse = false;

    Object.defineProperty(w.document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });
    Object.defineProperty(w.navigator, 'wakeLock', {
      configurable: true,
      value: {
        request: () => {
          requests++;
          if (refuse) return Promise.reject(new Error('refused by the OS'));
          const listeners = [];
          lastLock = {
            addEventListener: (_type, fn) => listeners.push(fn),
            release: () => { released++; listeners.forEach((fn) => fn()); },
          };
          return Promise.resolve(lastLock);
        },
      },
    });

    // The reconciler resolves through a promise, and setKeepAwake deliberately
    // does not await it, so assertions read state one tick later.
    const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

    screen.setKeepAwake(true);
    await settle();
    if (!screen.wakeLockHeld()) {
      failures.push('no wake lock taken while the app was open and visible');
    }

    // Idempotent: this runs on a timer and on every visibility change, so a
    // second call must not stack up a second lock.
    const beforeRepeat = requests;
    await screen.syncWakeLock();
    if (requests !== beforeRepeat) {
      failures.push('syncWakeLock re-requested a lock it was already holding');
    }

    // Hidden: the browser has already released it, and requesting would reject.
    visibility = 'hidden';
    await screen.syncWakeLock();
    await settle();
    if (screen.wakeLockHeld()) {
      failures.push('claimed to hold the wake lock while the page was hidden');
    }

    // Back in the foreground it must be taken again. This is the whole point:
    // nothing re-acquires it for us.
    visibility = 'visible';
    await screen.syncWakeLock();
    await settle();
    if (!screen.wakeLockHeld()) {
      failures.push('wake lock not re-acquired when the app returned to the foreground');
    }

    // The OS revokes it at will — battery saver, low battery. The handle is dead
    // and the next sync has to ask again rather than trust it.
    lastLock.release();
    if (screen.wakeLockHeld()) {
      failures.push('kept a wake lock handle the OS had already revoked');
    }
    const beforeRetry = requests;
    await screen.syncWakeLock();
    await settle();
    if (requests <= beforeRetry || !screen.wakeLockHeld()) {
      failures.push('did not re-request the wake lock after the OS revoked it');
    }

    // Turning it off must actually let go, or the switch is decorative.
    const beforeOff = released;
    screen.setKeepAwake(false);
    await settle();
    if (screen.wakeLockHeld() || released <= beforeOff) {
      failures.push('turning the setting off did not release the wake lock');
    }

    // Dictation overrides the setting: off means "don't burn battery while I
    // read", not "cut me off mid-sentence".
    vhooks.voice.active = true;
    if (!screen.wantsScreenAwake()) {
      failures.push('dictation did not override the setting being off');
    }
    await screen.syncWakeLock();
    await settle();
    if (!screen.wakeLockHeld()) {
      failures.push('dictation ran without holding the screen awake');
    }
    vhooks.voice.active = false;
    screen.setKeepAwake(false);
    await settle();

    // A refusal must not be reported as success: that boolean is what the status
    // bar's "screen may sleep and cut this off" warning reads.
    refuse = true;
    screen.setKeepAwake(true);
    await settle();
    if (screen.wakeLockHeld()) {
      failures.push('a refused wake lock was reported as held');
    }
    refuse = false;
  }
}

// A half-typed message must survive the page being taken away. The reload is not
// this app's decision — iOS discards a backgrounded tab, the editor surface
// reloads itself — and the report this guards against was minutes of dictation
// destroyed "without any backup". jsdom cannot reload, so the save and the
// restore are driven directly, which is also the only way to assert the scoping.
{
  const drafts = w.__draftForTest;
  if (!drafts || !chat) {
    failures.push('client did not expose the draft hooks for testing');
  } else {
    const box = drafts.input;
    // Typing happens with a chat open, and which chat is what the draft records.
    // The pane opened above is the one on screen, so it is the one the composer
    // and every draft written below belong to.
    panesHooks.activatePane(chat);
    const key = drafts.draftKeyFor(chat);

    box.value = 'a paragraph of dictated code';
    drafts.saveDraft({ now: true });
    if (!w.localStorage.getItem(key)) {
      failures.push('typing left no draft behind to recover');
    }

    // What a reload looks like from here: the box is empty again, and the chat
    // being reopened is the one the draft was typed in.
    box.value = '';
    if (!drafts.restoreDraft(chat)) {
      failures.push('reopening the same chat did not restore the draft');
    }
    if (box.value !== 'a paragraph of dictated code') {
      failures.push('restored draft does not match what was typed');
    }

    // A draft belongs to one conversation. Restoring it under a different one
    // would put the user's words into a chat they were not written for.
    box.value = '';
    if (drafts.restoreDraft({ cwd: '/workspace/projects/other', sessionId: 'abc123' })) {
      failures.push('draft leaked into a different project');
    }
    if (drafts.restoreDraft({ cwd: chat.cwd, sessionId: 'zzz999' })) {
      failures.push('draft leaked into a different session in the same project');
    }
    if (box.value !== '') {
      failures.push('a rejected draft still wrote into the composer');
    }

    // Text already in the box is more current than anything saved earlier.
    box.value = 'something newer';
    if (drafts.restoreDraft(chat)) {
      failures.push('restoring overwrote text already in the composer');
    }
    if (box.value !== 'something newer') {
      failures.push('restore clobbered the composer it was told to leave alone');
    }

    // Sending clears the box, and that has to clear the draft too — otherwise the
    // next reload puts an already-sent message back.
    box.value = '';
    drafts.saveDraft({ now: true });
    if (w.localStorage.getItem(key)) {
      failures.push('an emptied composer left a stale draft behind');
    }
  }
}

// This jsdom has no service worker, no PushManager and no Notification — which is
// also a real browser: desktop Safari, and any iPhone where the app has not been
// added to the home screen. The switch has to say so rather than sit there looking
// available and doing nothing when tapped.
{
  const toggle = w.document.querySelector('#opt-push');
  const hint = w.document.querySelector('#push-hint');
  if (!toggle || !hint) {
    failures.push('settings has no notification switch');
  } else {
    if (!toggle.disabled) failures.push('notification switch is offerable in a browser that cannot do it');
    if (toggle.checked) failures.push('notification switch shows on where notifications are impossible');
    if (!/home screen/i.test(hint.textContent)) {
      failures.push(`unsupported hint does not say what to do: ${JSON.stringify(hint.textContent)}`);
    }
  }
}

// --- notifications, in a browser that has them ------------------------------
/*
 * A second DOM, because the three pieces this needs are absent from the first one
 * and `'PushManager' in window` is read at boot. Everything below is the part of
 * the feature that can only fail on a phone: whether the switch's state comes from
 * the browser rather than from a stored flag, whether permission is asked for
 * before anything is awaited, whether the key survives base64url → bytes, and
 * whether turning it off reaches the server while the endpoint still exists.
 */
{
  const dom2 = new JSDOM(html, { runScripts: 'outside-only', url: 'https://claude.example.com/' });
  const w2 = dom2.window;

  // The real key from a real keypair, so the decode below is checked against
  // something with the shape a P-256 public key actually has.
  const KEY = 'BOe1x_hUOKzZBnbTz5xLNlOaqZ3Ah3ll7SzKfHRSfrnRHkTKuNJlvBQCLGnJJKKUpUKzIxq2xR2oyF6qkkeGaAo';
  // Ordered log of everything the client did, so "asked permission first" can be
  // asserted rather than assumed.
  const acts = [];
  let subscription = null;
  let registerCalls = 0;
  let unsubscribeCalls = 0;
  const subscribeOpts = [];
  const posted = {};

  const ENDPOINT = 'https://push.example.test/send/abc123';
  /*
   * What the two POSTs answer, one entry per call, the last one reused.
   *
   * Both carry the one fact this side cannot work out: whether the push service still
   * knows the endpoint the browser keeps handing over. `mine` is this device's own
   * result, not a total over every device — reading success out of the total is how a
   * phone came to report a test notification as sent one second after its own was
   * refused, and the desktop's success covered for it for a day.
   */
  const answers = {
    subscribe: [{ devices: 1 }],
    test: [{ sent: 1, failed: 0, devices: 1, mine: { ok: true, status: 201, gone: false } }],
  };
  const nextAnswer = (which) => (answers[which].length > 1 ? answers[which].shift() : answers[which][0]);

  let endpointSeq = 0;
  /*
   * Whether the box still has this device in its list. Flipped by hand below to stage
   * the outage that cannot be staged any other way: the push service forgets an
   * endpoint, the box prunes it, and the browser carries on handing out a subscription
   * that looks exactly as healthy as it did the day it worked.
   */
  let serverKnows = true;
  const makeSubscription = (key) => ({
    endpoint: endpointSeq <= 1 ? ENDPOINT : `${ENDPOINT}-${endpointSeq}`,
    // The browser reports back the key it was created with; the client compares
    // it to the server's, and that comparison is the only thing standing between
    // a rotated keypair and a phone that goes quiet with nothing in any log.
    options: { applicationServerKey: key },
    toJSON() {
      return { endpoint: this.endpoint, keys: { p256dh: 'p256dh-value', auth: 'auth-value' } };
    },
    unsubscribe() {
      acts.push('browser-unsubscribe');
      unsubscribeCalls += 1;
      subscription = null;
      return Promise.resolve(true);
    },
  });

  const registration = {
    scope: 'https://claude.example.com/chat/',
    pushManager: {
      getSubscription: () => Promise.resolve(subscription),
      subscribe: (opts) => {
        acts.push('subscribe');
        subscribeOpts.push(opts);
        // Each replacement gets its own endpoint, because that is what a replacement
        // is — with one fixed string, "the server was told about the new subscription"
        // would also be true of code that never made one.
        endpointSeq += 1;
        subscription = makeSubscription(opts.applicationServerKey);
        return Promise.resolve(subscription);
      },
    },
    unregister: () => Promise.resolve(true),
  };
  let registered = false;

  Object.defineProperty(w2.navigator, 'serviceWorker', {
    configurable: true,
    value: {
      register: (url) => {
        registerCalls += 1;
        acts.push(`register:${url}`);
        registered = true;
        return Promise.resolve(registration);
      },
      getRegistration: () => Promise.resolve(registered ? registration : undefined),
      getRegistrations: () => Promise.resolve(registered ? [registration] : []),
    },
  });
  w2.PushManager = function PushManager() {};
  w2.Notification = function Notification() {};
  w2.Notification.permission = 'default';
  w2.Notification.requestPermission = () => {
    acts.push('permission');
    w2.Notification.permission = 'granted';
    return Promise.resolve('granted');
  };

  w2.fetch = (url, options = {}) => {
    const path = String(url);
    acts.push(`fetch:${path}`);
    if (options.body) posted[path.replace(/\?.*/, '')] = JSON.parse(options.body);
    if (path.includes('/api/push/key')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ key: KEY, devices: 0 }) });
    }
    if (path.includes('/api/push/subscribe')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(nextAnswer('subscribe')) });
    }
    if (path.includes('/api/push/unsubscribe')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ devices: 1 }) });
    }
    /*
     * Whether the box agrees this device is subscribed — the one fact the browser
     * cannot supply, because a subscription whose endpoint has been pruned is handed
     * back looking perfectly healthy, key and all.
     */
    if (path.includes('/api/push/status')) {
      const asked = options.body ? JSON.parse(options.body).endpoint : null;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          devices: serverKnows ? 1 : 0,
          known: Boolean(serverKnows && asked && asked === subscription?.endpoint),
        }),
      });
    }
    if (path.includes('/api/push/test')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(nextAnswer('test')) });
    }
    if (path.includes('/api/live')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ sessions: [] }) });
    }
    if (path.includes('/api/projects')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ projects: [] }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ models: [] }) });
  };
  w2.WebSocket = function () {
    this.addEventListener = () => {};
    this.send = () => {};
    this.close = () => {};
    this.readyState = 0;
  };
  w2.WebSocket.CONNECTING = 0;
  w2.WebSocket.OPEN = 1;
  w2.matchMedia = () => ({ matches: false, addEventListener() {} });
  w2.addEventListener('error', (e) => failures.push(`uncaught (push dom): ${e.message}`));

  const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

  try {
    w2.eval(js);
    await settle(200);

    const toggle = w2.document.querySelector('#opt-push');
    const hint = w2.document.querySelector('#push-hint');
    const hooks = w2.__pushForTest;
    if (!hooks) failures.push('client did not expose the push hooks for testing');

    // Nothing has been turned on, so nothing may have been installed. A worker
    // registered merely by opening settings is a worker on every device that has
    // never asked for notifications, and this app had one of those wedge it once.
    if (registerCalls !== 0) failures.push('opening the app registered the push worker uninvited');
    if (acts.some((a) => a.includes('/api/push/'))) failures.push('boot talked to the push API unasked');
    if (toggle.disabled) failures.push('notification switch is disabled in a browser that supports them');
    if (toggle.checked) failures.push('notification switch shows on before anything was subscribed');
    if (!/asked for permission once/i.test(hint.textContent)) {
      failures.push(`off hint does not warn about the prompt: ${JSON.stringify(hint.textContent)}`);
    }

    // Turning it on.
    acts.length = 0;
    toggle.checked = true;
    toggle.dispatchEvent(new w2.Event('change'));
    await settle(200);

    if (acts[0] !== 'permission') {
      // Anything awaited before the prompt spends the tap that authorises it, and
      // mobile Chrome then refuses to show it at all.
      failures.push(`permission was not asked for first: ${JSON.stringify(acts.slice(0, 2))}`);
    }
    if (registerCalls !== 1) failures.push(`worker registered ${registerCalls} times on enable`);
    if (!acts.some((a) => a === 'register:/chat/sw.js')) {
      failures.push('registered a worker other than the push-only /chat/sw.js');
    }
    if (subscribeOpts.length !== 1) failures.push(`subscribed ${subscribeOpts.length} times`);
    if (subscribeOpts[0]?.userVisibleOnly !== true) {
      failures.push('subscribed without userVisibleOnly, which Chrome refuses');
    }
    const sentKey = subscribeOpts[0]?.applicationServerKey;
    if (!(sentKey instanceof w2.Uint8Array) && !(sentKey instanceof Uint8Array)) {
      failures.push('applicationServerKey was not raw bytes');
    } else if (sentKey.length !== 65 || sentKey[0] !== 4) {
      // A broken base64url decode still produces *a* Uint8Array, and the failure
      // then happens inside the browser on a phone with no console attached.
      failures.push(`applicationServerKey is not an uncompressed P-256 point: ${sentKey.length} bytes, first ${sentKey[0]}`);
    }
    if (posted['/api/push/subscribe']?.endpoint !== 'https://push.example.test/send/abc123') {
      failures.push(`server was not told the endpoint: ${JSON.stringify(posted['/api/push/subscribe'])}`);
    }
    if (!posted['/api/push/subscribe']?.keys?.p256dh) {
      failures.push('subscription was posted without its keys, so nothing can be encrypted to it');
    }
    const keyAt = acts.indexOf('fetch:/api/push/key');
    const subAt = acts.findIndex((a) => a === 'fetch:/api/push/subscribe');
    const testAt = acts.findIndex((a) => a === 'fetch:/api/push/test');
    if (!(keyAt >= 0 && keyAt < subAt && subAt < testAt)) {
      failures.push(`enable did not go key → subscribe → test: ${JSON.stringify(acts)}`);
    }
    if (!toggle.checked) failures.push('switch fell back to off after a successful subscribe');
    if (!/On for this device/i.test(hint.textContent)) {
      failures.push(`on hint is wrong: ${JSON.stringify(hint.textContent)}`);
    }
    if (posted['/api/push/status']?.endpoint !== subscription.endpoint) {
      // Without naming the endpoint the answer is a fleet total again, which is the
      // mistake /api/push/test already had to be fixed for.
      failures.push(`the switch asked about the fleet, not this device: ${JSON.stringify(posted['/api/push/status'])}`);
    }

    /*
     * The switch over a device the box cannot reach.
     *
     * This read "On for this device" for two days while the box had nothing subscribed
     * at all, because it was painted from `getSubscription()` alone and that call has no
     * opinion about whether the endpoint behind it still exists. The browser being
     * subscribed and the phone being reachable are different facts; only the second one
     * puts a notification on a lock screen.
     */
    serverKnows = false;
    await hooks.paintPushToggle();
    if (!toggle.checked) failures.push('a pruned device unticked the switch, which the browser cannot know');
    if (/^On for this device/i.test(hint.textContent)) {
      failures.push(`the switch claims notifications work over a device the box has dropped: ${JSON.stringify(hint.textContent)}`);
    }
    if (!/push service forgot it/i.test(hint.textContent)) {
      failures.push(`the stale hint does not say what went wrong: ${JSON.stringify(hint.textContent)}`);
    }
    // And a box that cannot be asked at all is not evidence of anything: offline must
    // not be reported as broken.
    serverKnows = true;
    const realFetch = w2.fetch;
    w2.fetch = () => Promise.reject(new Error('offline'));
    await hooks.paintPushToggle();
    if (!/^On for this device/i.test(hint.textContent)) {
      failures.push(`an unreachable server was reported as a dropped device: ${JSON.stringify(hint.textContent)}`);
    }
    w2.fetch = realFetch;
    await hooks.paintPushToggle();

    /*
     * Repairing on the way back in, and only now and then.
     *
     * The endpoint dies while nobody is here, so a repair that only runs at boot never
     * runs on the device it is for: an installed app that is opened and backgrounded is
     * never cold-started again. Coming back to the front is therefore a trigger too —
     * but it is one that happens dozens of times an hour, so the second check in a
     * minute has to cost nothing.
     */
    acts.length = 0;
    const syncs = () => acts.filter((a) => a === 'fetch:/api/push/subscribe').length;
    hooks.pushSyncSoon({ force: true });
    await settle(120);
    if (syncs() !== 1) failures.push(`coming back to the app repaired ${syncs()} times instead of once`);
    hooks.pushSyncSoon();
    hooks.pushSyncSoon();
    await settle(120);
    if (syncs() !== 1) failures.push(`every glance at the app costs a resubscribe: ${syncs()} in a row`);
    const toastText = w2.document.querySelector('#toast')?.textContent ?? '';
    if (!/test/i.test(toastText)) failures.push(`no confirmation that a test was sent: ${JSON.stringify(toastText)}`);
    if (posted['/api/push/test']?.endpoint !== ENDPOINT) {
      // Without this the server can only answer with a fleet total, and a desktop that
      // received the test makes the phone next to it claim success.
      failures.push(`the test did not say which device asked: ${JSON.stringify(posted['/api/push/test'])}`);
    }

    /*
     * What the toast says has to come from this device's own result. Each of these was
     * reported as "Notifications on — sent a test one" before, including the one where
     * the push service had just refused this very device.
     */
    const toastFor = (result) => hooks.pushTestToast(result);
    if (!/this device/.test(toastFor({ sent: 1, mine: { ok: true, status: 201 } }))) {
      failures.push('a successful test is not reported as having reached this device');
    }
    if (/^Notifications on/.test(toastFor({ sent: 1, mine: { ok: false, status: 410, gone: true } }))) {
      failures.push('a device the push service has forgotten is told notifications are on');
    }
    if (!/429/.test(toastFor({ sent: 1, mine: { ok: false, status: 429, gone: false } }))) {
      failures.push('a refused test does not say what the push service answered');
    }
    if (!/not to this device/.test(toastFor({ sent: 1, devices: 2 }))) {
      failures.push('a total with no per-device result is reported as success for this device');
    }


    // A rotated keypair on the server: the subscription still looks healthy to the
    // browser, and every notification sent to it fails somewhere the phone cannot
    // see. Every load repairs it, without prompting.
    acts.length = 0;
    subscription.options.applicationServerKey = new Uint8Array(65).fill(9);
    await hooks.pushSync();
    if (unsubscribeCalls !== 1) failures.push('a subscription bound to a dead key was kept');
    if (subscribeOpts.length !== 2) failures.push('did not re-subscribe after the key changed');
    if (!acts.some((a) => a === 'fetch:/api/push/subscribe')) {
      failures.push('re-subscribed without telling the server');
    }
    if (acts.includes('permission')) failures.push('the silent repair prompted the user');
    if (posted['/api/push/subscribe']?.endpoint !== subscription.endpoint) {
      failures.push(`the repair did not tell the server the new endpoint: ${JSON.stringify(posted['/api/push/subscribe'])}`);
    }

    // Turning it off. The endpoint identifies the device on the server, and the
    // browser forgets it the moment it unsubscribes — so the server has to hear
    // about it first, and it has to hear the endpoint. Whichever endpoint it is
    // holding now: the repair above replaced the one it started with.
    acts.length = 0;
    const endpointBeforeOff = subscription.endpoint;
    delete posted['/api/push/unsubscribe'];
    toggle.checked = false;
    toggle.dispatchEvent(new w2.Event('change'));
    await settle(150);

    if (posted['/api/push/unsubscribe']?.endpoint !== endpointBeforeOff) {
      failures.push(`unsubscribe did not name the device: ${JSON.stringify(posted['/api/push/unsubscribe'])}`);
    }
    const offAt = acts.indexOf('fetch:/api/push/unsubscribe');
    if (offAt < 0) failures.push('turning it off never reached the server');
    if (!(offAt >= 0 && offAt < acts.indexOf('browser-unsubscribe'))) {
      failures.push(`browser dropped the subscription before the server was told: ${JSON.stringify(acts)}`);
    }
    if (unsubscribeCalls !== 2) failures.push('turning it off left the browser subscribed');
    if (toggle.checked) failures.push('switch still shows on after unsubscribing');
    if (!/asked for permission once/i.test(hint.textContent)) {
      failures.push('hint did not go back to explaining what the switch does');
    }

    // Refused permission. It cannot be asked for a second time from a page, so a
    // switch that silently does nothing is the one outcome this must not produce.
    w2.Notification.permission = 'denied';
    await hooks.paintPushToggle();
    if (!toggle.disabled) failures.push('switch stays tappable after notifications were blocked');
    if (!/Site settings/i.test(hint.textContent)) {
      failures.push(`blocked hint does not say where the setting now lives: ${JSON.stringify(hint.textContent)}`);
    }

    /*
     * The failure this was all built for: the push service has forgotten the endpoint
     * while the browser goes on handing out the same subscription, key and all. Only
     * the server hears the refusal, so `{ gone: true }` from subscribe is the signal,
     * and the client has to replace the subscription rather than re-offer it forever.
     */
    acts.length = 0;
    const subscribesBefore = subscribeOpts.length;
    const unsubscribesBefore = unsubscribeCalls;
    answers.subscribe = [{ gone: true }, { devices: 1 }];
    const replaced = await hooks.pushSubscribe();
    if (subscribeOpts.length - subscribesBefore !== 2) {
      failures.push(`the server said the endpoint is gone and the client kept it: ${JSON.stringify(acts)}`);
    }
    if (unsubscribeCalls - unsubscribesBefore !== 1) {
      failures.push('the dead subscription was not dropped at the browser, so the replacement is the same endpoint');
    }
    if (replaced?.endpoint !== `${ENDPOINT}-${endpointSeq}` || posted['/api/push/subscribe']?.endpoint !== replaced.endpoint) {
      failures.push(`the server was not given the replacement: ${JSON.stringify(posted['/api/push/subscribe'])}`);
    }
    if (acts.filter((a) => a === 'fetch:/api/push/subscribe').length !== 2) {
      failures.push(`a server answering "gone" twice loops: ${JSON.stringify(acts)}`);
    }
    if (acts.includes('permission')) failures.push('replacing a dead subscription prompted the user');
  } catch (err) {
    failures.push(`push section threw — ${err.constructor.name}: ${err.message}`);
  } finally {
    w2.close();
  }
}

if (failures.length) {
  console.error('FAIL:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

// Stops jsdom's timers — the client now holds a repeating one for the wake lock.
dom.window.close();

console.log(
  'PASS: client boots, lists conversations, renders resumed history, ' +
  'announces interrupted dictation, holds the screen awake, keeps an ' +
  'unsent message across a reload, punctuates dictation without ' +
  'overwriting what was typed, and turns notifications on and off honestly',
);
