/**
 * The voice that reads a message out loud, checked without spending anything.
 *
 * Two things here are worth more than the rest.
 *
 * **The segmenting.** It decides where the voice takes a breath and what gets
 * billed, and it is the one part of this that a listener can hear: a piece ending
 * mid-clause is audible as a stumble, and a first piece that grew past its limit is
 * heard as a long silence after the tap. So the checks are about the boundaries —
 * that the first piece is short, that the later ones are not, that no piece is
 * oversized, and that nothing said is lost or repeated between them.
 *
 * **The refusals.** Every one of them is a path a real phone reaches: a message
 * that aged out while the phone was in a pocket, a segment that does not exist, the
 * daily budget, a Polly call that fails. The overlay's answer to all of them is to
 * fall back to the browser's own voice, so a refusal that arrives as a hang, or as
 * a 500 with no sentence in it, is a read that goes quiet for no stated reason.
 *
 * **Which of the two voices reads it.** There are two synthesisers now, because
 * Polly cannot say a word of Hebrew — it skips the characters rather than reading
 * them badly, so a Hebrew message sent to the wrong one is read with holes in it and
 * nothing anywhere says so. The choice is therefore checked the way the refusals are:
 * the share that triggers it, the override, the 409 on a box with no key, and the
 * separate budget that keeps a third party's bill from being spent by a loop.
 *
 * `VoiceCache` takes its synthesiser as an argument for exactly this reason, and
 * `chooseVoice` and `speechStatus` take the voice list and the key as arguments too,
 * so everything below runs against fakes that count characters instead of Polly and
 * OpenAI, which charge for them: no credentials, no network, no bill. The two
 * synthesiser calls themselves are the part that cannot be checked here —
 * `/api/voice-status` is what reports whether they work on the box.
 *
 * Run: node chat-service/speak-test.js
 */
import { execFileSync } from 'child_process';
import { AZURE_VOICES } from './azure-speech.js';
import {
  VoiceCache,
  SpeakError,
  splitSegments,
  messageId,
  prepare,
  speechStatus,
  chooseVoice,
  preferredVoice,
  hebrewShare,
  hasHebrew,
  needsMultilingualVoice,
  readsHebrew,
  speaksHebrew,
  codeAloud,
  CODE_LINES,
  FALLBACK_VOICES,
  OPENAI_VOICES,
  HEBREW_SHARE,
  FIRST_SEGMENT_CHARS,
  SEGMENT_CHARS,
  SILENT_WAV,
} from './speak.js';

let checks = 0;
let failures = 0;
const ok = (condition, name, detail = '') => {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const section = (name) => console.log(`\n${name}`);

/**
 * A stand-in for either synthesiser: says what it was asked to, in fake bytes, for
 * free. Records the provider as well, because that is the argument the real
 * `synthesize` dispatches on — a message prepared for OpenAI and then handed to
 * Polly would be silently wrong rather than an error.
 */
const fakeVoice = () => {
  const calls = [];
  return {
    calls,
    synthesize: async (text, voice, engine, provider) => {
      calls.push({ text, voice, engine, provider });
      return Buffer.from(`mp3:${voice}:${text}`);
    },
    get chars() {
      return calls.reduce((n, c) => n + c.text.length, 0);
    },
  };
};

const words = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).join(' ');

// A message shaped like the ones this reads: a summary with short sentences, long
// sentences, decimals, filenames and line ranges in it.
const MESSAGE = [
  'Done. The auth gap is closed.',
  'The check now runs in auth.js, lines 42 to 51, inside the application process rather than in nginx, which is where the previous version claimed it was while the proxy config had no such rule at all.',
  'I also bumped the timeout from 1.5 to 3.5 seconds, because the first Bedrock call of a process resolves credentials and was timing out on a cold start.',
  'Tests pass: 106 checks. Do you want me to push it?',
].join(' ');

// --------------------------------------------------------------------------
section('Cutting a message into pieces:');
{
  const segments = splitSegments(MESSAGE);
  const sizes = segments.map((s) => s.length).join(', ');
  ok(segments.length >= 3, 'a summary becomes several pieces', `${MESSAGE.length} characters became ${segments.length}: ${sizes}`);
  ok(
    segments[0].length <= FIRST_SEGMENT_CHARS,
    'the first piece is short, so the voice starts within a couple of seconds',
    `it is ${segments[0].length} characters, over ${FIRST_SEGMENT_CHARS}`,
  );
  ok(
    segments.slice(1).every((s) => s.length <= SEGMENT_CHARS),
    'no piece is oversized',
    `sizes were ${sizes}`,
  );
  // The later pieces have to be long, or the read becomes dozens of round trips.
  ok(segments[1].length > FIRST_SEGMENT_CHARS, 'the pieces after the first are long', `the second is ${segments[1].length}`);

  ok(
    words(segments.join(' ')) === words(MESSAGE),
    'the pieces together say exactly what the message said',
    'words were lost, added or repeated across the seams',
  );

  const seams = segments.slice(0, -1);
  ok(
    seams.every((s) => /[.!?]["')\]]?$/.test(s)),
    'every seam falls at the end of a sentence, where a reader would pause anyway',
    `seams end: ${JSON.stringify(seams.map((s) => s.slice(-20)))}`,
  );
  ok(
    !seams.some((s) => /\d\.\d?$|\.js$/.test(s.slice(-8))),
    'a decimal or a filename is not mistaken for the end of a sentence',
    `seams end: ${JSON.stringify(seams.map((s) => s.slice(-10)))}`,
  );
}

{
  // Prose with no full stop in it still has to be said, so an over-long sentence
  // is split on words rather than left to grow into one huge piece.
  const long = `Right, ${'and then '.repeat(140)}done.`;
  const segments = splitSegments(long);
  ok(
    segments.every((s) => s.length <= SEGMENT_CHARS),
    'a sentence longer than a whole piece is split anyway',
    `${long.length} characters produced a piece of ${Math.max(...segments.map((s) => s.length))}`,
  );
  ok(segments.every((s) => !/\s$/.test(s)) , 'the split lands between words, not inside one');
  ok(words(segments.join(' ')) === words(long), 'nothing is lost splitting a long sentence');
}

{
  ok(splitSegments('').length === 0, 'there is nothing to synthesise for empty text');
  ok(splitSegments('   \n\t ').length === 0, 'there is nothing to synthesise for whitespace');
  ok(splitSegments('Yes.').length === 1, 'a four-character message is one piece');
  ok(
    splitSegments('Line one.\n\nLine two.')[0] === 'Line one. Line two.',
    'newlines are normalised out of the spoken text',
    `got ${JSON.stringify(splitSegments('Line one.\n\nLine two.'))}`,
  );
}

// --------------------------------------------------------------------------
section('Preparing a message costs nothing:');
{
  const voice = fakeVoice();
  const cache = new VoiceCache({ synthesize: voice.synthesize });
  const prepared = cache.prepare(MESSAGE, 'Ruth', 'generative');

  ok(voice.calls.length === 0, 'nothing is synthesised, so opening a message is never billed');
  ok(
    prepared.segments >= 3 && prepared.chars === MESSAGE.length,
    'it answers with how many pieces and how many characters',
    JSON.stringify(prepared),
  );
  ok(prepared.voice === 'Ruth' && prepared.engine === 'generative', 'it reports the voice and engine it will use');
  ok(/^[0-9a-f]{32}$/.test(prepared.id), 'the id is a hash of what will be said', `got ${prepared.id}`);

  // Content-addressed, so re-reading a message — or reading it on a second
  // device — is the same id, and therefore free.
  ok(
    cache.prepare(MESSAGE, 'Ruth', 'generative').id === prepared.id,
    'the same text gets the same id, so audio is reused instead of rebought',
  );
  ok(
    cache.prepare(MESSAGE, 'Matthew', 'generative').id !== prepared.id,
    'a different voice gets a different id, so it cannot play in the wrong voice',
  );
  ok(
    messageId(MESSAGE, 'Ruth', 'neural') !== messageId(MESSAGE, 'Ruth', 'generative'),
    'a different engine gets a different id',
  );
}

// --------------------------------------------------------------------------
section('Reading it:');
{
  const voice = fakeVoice();
  const cache = new VoiceCache({ synthesize: voice.synthesize });
  const { id, segments } = cache.prepare(MESSAGE, 'Ruth', 'generative');

  const first = await cache.audio(id, 0);
  ok(first.audio.length > 0 && !first.cached, 'the first piece comes back as fresh audio');
  ok(voice.calls.length === 1, 'asking for one piece synthesises one piece', `it made ${voice.calls.length} calls`);
  ok(voice.calls[0].voice === 'Ruth' && voice.calls[0].engine === 'generative', 'in the voice and engine that were prepared');
  ok(voice.calls[0].text.length <= FIRST_SEGMENT_CHARS, 'and it is the short piece that gets synthesised first');

  // Stopping after the first sentence is the usual case — you have heard enough —
  // and it must cost the first sentence rather than the whole message.
  ok(
    voice.chars < MESSAGE.length / 2,
    'stopping early leaves the rest of the message unsynthesised and unbilled',
    `${voice.chars} of ${MESSAGE.length} characters were submitted`,
  );

  const again = await cache.audio(id, 0);
  ok(again.cached && again.audio.equals(first.audio), 'a re-read replays the same audio instead of buying it again');
  ok(voice.calls.length === 1, 'a cached piece does not call the voice at all');

  for (let i = 1; i < segments; i += 1) await cache.audio(id, i);
  ok(voice.calls.length === segments, 'a whole message is one call per piece', `${segments} pieces took ${voice.calls.length}`);
  ok(
    voice.chars === splitSegments(MESSAGE).join('').length,
    'and the characters billed add up to the message that was read',
    `${voice.chars} submitted`,
  );
}

// --------------------------------------------------------------------------
section('Refusing, with a reason and a status:');
{
  const voice = fakeVoice();
  const cache = new VoiceCache({ synthesize: voice.synthesize, maxChars: 500 });

  const refuses = async (name, status, fn) => {
    try {
      await fn();
      ok(false, name, 'nothing was refused');
    } catch (err) {
      ok(
        err instanceof SpeakError && err.status === status && /\S/.test(err.message),
        name,
        `got ${err?.name} ${err?.status}: ${err?.message}`,
      );
    }
  };

  await refuses('nothing to read is a 400', 400, () => cache.prepare('   ', 'Ruth', 'generative'));
  await refuses('a message too long to read aloud is a 413', 413, () => cache.prepare('x. '.repeat(400), 'Ruth', 'generative'));

  /*
   * The default cap, which is the one a deployment actually runs with, and which is
   * a guard against a pasted file rather than against a long answer. It used to be
   * 4000 — "the 2400 the overlay cut at, with room to spare" — so when the overlay
   * stopped cutting, this was the limit that would have refused every long message
   * with a 413 the chat app reports as "nothing was read". A full-length final
   * message is 10-15k characters; it has to prepare.
   */
  {
    const wide = fakeVoice();
    const long = 'Every sentence here is a real sentence with a full stop at the end. '.repeat(200);
    let refused = null;
    try {
      new VoiceCache({ synthesize: wide.synthesize }).prepare(long, 'Ruth', 'generative');
    } catch (err) {
      refused = err;
    }
    ok(
      refused === null,
      'the default cap reads a full-length message rather than refusing it',
      `${long.length} characters: ${refused ? `${refused.status} ${refused.message}` : 'prepared'}`,
    );
  }
  await refuses('an id nobody prepared is a 404', 404, () => cache.audio('deadbeef', 0));

  const { id, segments } = cache.prepare(MESSAGE.slice(0, 300), 'Ruth', 'generative');
  await refuses('a piece past the end is a 404', 404, () => cache.audio(id, segments));
  await refuses('a negative piece is a 404', 404, () => cache.audio(id, -1));
  await refuses('a piece that is not a number is a 404', 404, () => cache.audio(id, 'first'));
  ok(voice.calls.length === 0, 'and none of those refusals reached the voice, so none of them were billed');

  // A synthesiser that fails has to surface as a refusal rather than as silence:
  // the client can only fall back to the browser's voice if it is told.
  const broken = new VoiceCache({ synthesize: async () => { throw new SpeakError('Polly is throttling this account', 503); } });
  const b = broken.prepare('Try it.', 'Ruth', 'generative');
  await refuses("a voice that fails keeps the voice's own status", 503, () => broken.audio(b.id, 0));

  const empty = new VoiceCache({ synthesize: async () => Buffer.alloc(0) });
  const e = empty.prepare('Try it.', 'Ruth', 'generative');
  await refuses('a voice that returns no audio is a 502, not an empty file to play', 502, () => empty.audio(e.id, 0));
}

// --------------------------------------------------------------------------
section('The daily budget:');
{
  const voice = fakeVoice();
  let now = Date.parse('2026-09-18T22:00:00Z');
  const cache = new VoiceCache({ synthesize: voice.synthesize, dailyChars: 200, now: () => now });

  const { id } = cache.prepare(MESSAGE, 'Ruth', 'generative');
  await cache.audio(id, 0);
  ok(
    cache.budget().chars > 0 && cache.budget().chars <= 200,
    'a read is counted against the day',
    JSON.stringify(cache.budget()),
  );

  let refused = null;
  try {
    for (let i = 1; i < 8; i += 1) await cache.audio(id, i);
  } catch (err) {
    refused = err;
  }
  ok(refused?.status === 429, 'reading past the budget is refused', `got ${refused?.status}: ${refused?.message}`);
  ok(/limit|budget|today/i.test(refused?.message || ''), 'and the refusal says why', `got: ${refused?.message}`);
  ok(cache.budget().chars <= 200, 'the budget is never overspent before refusing', `${cache.budget().chars} of 200`);

  // Audio already synthesised is already paid for, so the read in progress must
  // still finish once the budget is gone.
  ok((await cache.audio(id, 0)).cached, 'a piece already paid for still plays after the budget runs out');

  // Midnight UTC. A phone that comes back the next day re-prepares the text —
  // which is free — because the audio itself has long since aged out.
  now = Date.parse('2026-09-19T00:30:00Z');
  ok(
    cache.budget().chars === 0 && cache.budget().day === '2026-09-19',
    'the budget resets overnight',
    JSON.stringify(cache.budget()),
  );
  const tomorrow = cache.prepare(MESSAGE, 'Ruth', 'generative');
  ok((await cache.audio(tomorrow.id, 1)).audio.length > 0, 'and reading resumes the next day');
}

// --------------------------------------------------------------------------
section('Not holding audio forever:');
{
  const voice = fakeVoice();
  let now = 1_000_000;
  const cache = new VoiceCache({ synthesize: voice.synthesize, ttlMs: 60_000, maxMessages: 2, now: () => now });

  const first = cache.prepare('First message.', 'Ruth', 'generative');
  await cache.audio(first.id, 0);
  now += 61_000;
  let expired = null;
  try {
    await cache.audio(first.id, 0);
  } catch (err) {
    expired = err;
  }
  ok(expired?.status === 404, 'audio is dropped once nobody is listening to it', `got ${expired?.status}`);
  ok(cache.messages.size === 0, 'and the message goes with it', `${cache.messages.size} still held`);

  // A cap on messages too, so a long session cannot grow without bound.
  const ids = [];
  for (const text of ['One here.', 'Two here.', 'Three here.', 'Four here.']) {
    ids.push(cache.prepare(text, 'Ruth', 'generative').id);
    now += 10;
  }
  ok(cache.messages.size <= 2, 'only so many messages are held at once', `${cache.messages.size} with a limit of 2`);
  ok(cache.messages.has(ids[3]), 'and the newest is not the one evicted');

  // Re-preparing is what a phone does when it returns to a message, so it has to
  // make that message the one that survives rather than the next one to go.
  const kept = cache.prepare('Three here.', 'Ruth', 'generative').id;
  now += 10;
  cache.prepare('Five here.', 'Ruth', 'generative');
  ok(cache.messages.has(kept), 'a message asked for again is kept over an older one');
}

// --------------------------------------------------------------------------
section('What the phone is told:');
{
  // The voice picker is built from this, so a voice that cannot be used has to be
  // reported as unavailable rather than offered and then failing on the tap.
  const working = await speechStatus({
    hasAzure: async () => false,
    describe: async () => ({
      voices: [
        { id: 'Lupe', gender: 'Female', language: 'es-US' },
        { id: 'Ruth', gender: 'Female', language: 'en-US' },
      ],
      reason: null,
    }),
  });
  ok(working.configured === true, 'a box that can synthesise says so');
  ok(working.voices[0].id === 'Ruth', "the phone's own language comes first in the picker", `got ${working.voices.map((v) => v.id).join(', ')}`);
  ok(working.voices.length === 2, 'without hiding the other languages');
  ok(typeof working.voice === 'string' && working.voice.length > 0, 'the default voice is named');
  ok(working.budget && typeof working.budget.limit === 'number', 'the budget is reported, so the sheet can show what is left');
  ok(working.firstSegmentChars === FIRST_SEGMENT_CHARS, 'and how long the first piece is');

  const denied = await speechStatus({
    hasAzure: async () => false,
    describe: async () => ({ voices: [], reason: "this instance's role cannot call polly:SynthesizeSpeech" }),
  });
  ok(denied.configured === false, 'a box with no Polly access says it cannot speak');
  ok(/polly/i.test(denied.reason || ''), 'and says why, rather than leaving an operator guessing', `got: ${denied.reason}`);

  // A phone that remembers a voice this deployment no longer offers must still be
  // read to, in the default voice, and told which one it got. Through the module's
  // own `prepare`, since that is where a caller-supplied name is checked; it
  // synthesises nothing, so this costs nothing even against the real cache.
  const asked = await prepare('Read this.', { voice: 'Matthew' });
  ok(asked.voice === 'Matthew', 'a voice this deployment offers is the one used', `got ${asked.voice}`);
  const unknown = await prepare('Read this too.', { voice: 'Clippy; DROP TABLE' });
  /*
   * Which voice that lands on depends on the box — an Azure English voice where there
   * are credentials for one, Polly where there are not, and that is the point of
   * `preferredVoice` below. What must hold on every box is that it is a voice this
   * deployment actually has, rather than the caller's string handed to an API.
   */
  const offered = (id) => [...FALLBACK_VOICES, ...AZURE_VOICES, ...OPENAI_VOICES].some((v) => v.id === id);
  ok(
    offered(unknown.voice),
    'an unknown voice falls back to a real one instead of being passed through',
    `got ${unknown.voice}`,
  );
  ok((await prepare('And this.', {})).voice === unknown.voice, 'and so does no voice at all');
  ok(FALLBACK_VOICES.some((v) => v.id === 'Ruth'), "Ruth, Polly's default, is in the fallback list");
  ok(
    FALLBACK_VOICES.every((v) => v.id && v.gender && v.language),
    'every fallback voice has the gender and language the picker shows',
  );
}

// --------------------------------------------------------------------------
/*
 * Hebrew, which Polly cannot say a word of.
 *
 * The failure this guards against is inaudible, which is what makes it worth the
 * checks: Polly does not read Hebrew with an accent, it skips the characters, so a
 * message sent to the wrong voice is read with holes in it and a listener has no way
 * to tell that anything was missed. Everything downstream — the choice of provider,
 * the 409, the sheet's "your own device will read this" — hangs off this one share.
 *
 * The fixtures are runs of letters rather than sentences, because that is all the
 * share counter looks at: which Unicode block a letter is in. They are built from
 * code points for the reason `speak.js` writes its ranges as escapes — a
 * right-to-left literal in a left-to-right file displays in an order that is not its
 * byte order, and an editor that helpfully reorders one has changed a fixture.
 */
section('Hebrew, which Polly cannot say:');
{
  /** `n` letters from the Hebrew block, starting at aleph. */
  const heb = (n) => Array.from({ length: n }, (_, i) => String.fromCodePoint(0x05d0 + (i % 27))).join('');

  ok(hebrewShare('') === 0 && hebrewShare(null) === 0, 'nothing has no Hebrew in it, rather than throwing');
  ok(hebrewShare(MESSAGE) === 0, 'an English summary has none', `got ${hebrewShare(MESSAGE)}`);
  ok(hebrewShare(heb(12)) === 1, 'Hebrew text is all Hebrew', `got ${hebrewShare(heb(12))}`);
  ok(
    !needsMultilingualVoice(MESSAGE) && needsMultilingualVoice(heb(12)),
    'and that is what decides which synthesiser reads it',
  );

  // The normal case for this box: a reply written in Hebrew that names files,
  // constants and numbers in Latin letters. It has to come out as Hebrew.
  const mixed = `${heb(40)} auth.js ${heb(30)} SPEAK_DAILY_CHARS, 1.5 -> 3.5, 106 ${heb(20)}.`;
  ok(
    needsMultilingualVoice(mixed),
    'a Hebrew reply full of English filenames still needs the Hebrew voice',
    `share was ${hebrewShare(mixed).toFixed(2)}`,
  );
  ok(
    hebrewShare(`${heb(10)} 1.5 3.5 106 (,.;)`) === 1,
    'digits and punctuation do not dilute the share, only letters count',
  );

  // And the other direction: one Hebrew word quoted in an English answer is not a
  // reason to move the whole message onto a paid voice with an English accent.
  const quoted = `The string in the config is ${heb(4)}, which is why the header renders right to left. ${MESSAGE}`;
  ok(
    !needsMultilingualVoice(quoted),
    'one Hebrew word quoted in an English reply is not read in a Hebrew voice',
    `share was ${hebrewShare(quoted).toFixed(3)}`,
  );
  ok(HEBREW_SHARE > 0 && HEBREW_SHARE < 1, 'the threshold is a share, not a count', `got ${HEBREW_SHARE}`);

  /*
   * The two questions, which this file conflated until 2026-09-24 and which the bug
   * lived in. "Is this a Hebrew message?" is a share; "is there Hebrew in it at all?"
   * is not, and it is the second one that decides whether a provider may be given the
   * message — because Polly does not say a Hebrew word it cannot pronounce, it says
   * nothing at all, and four letters in a paragraph are nowhere near ten per cent.
   */
  ok(hasHebrew(quoted), 'but there is Hebrew in it, which is a different question');
  ok(!hasHebrew(MESSAGE) && !hasHebrew('') && !hasHebrew(null), 'and an English message has none');
  ok(
    hasHebrew(heb(1)) && !needsMultilingualVoice(`${heb(1)}${'a'.repeat(200)}`),
    'one letter is enough for the first question and not for the second',
  );

  // U+FB1D upwards: the pointed and ligature forms that copied Hebrew carries.
  ok(hebrewShare(String.fromCodePoint(0xfb2a, 0xfb4b, 0xfb1d)) === 1, 'the presentation forms count as Hebrew too');
}

// --------------------------------------------------------------------------
/*
 * Which voice ends up reading it.
 *
 * `chooseVoice` is a pure function over a list of voices for this section's sake: it
 * is where the Hebrew rule lives, it is the part that can get a message read in
 * silence if it is wrong, and it would otherwise need a key, an AWS account and a
 * network to check.
 */
section('Which voice ends up reading it:');
{
  const polly = FALLBACK_VOICES.map((v) => ({ ...v, provider: 'polly', engine: 'generative' }));
  const both = [...polly, ...OPENAI_VOICES.map((v) => ({ ...v, engine: 'gpt-4o-mini-tts' }))];
  const hebrew = Array.from({ length: 20 }, (_, i) => String.fromCodePoint(0x05d0 + i)).join('');

  const chosen = (requested, text, known = both) => chooseVoice(requested, text, known);

  ok(chosen('Matthew', MESSAGE).id === 'Matthew', 'an English message goes to the voice that was asked for');
  ok(chosen('Matthew', MESSAGE).provider === 'polly', 'on Polly, which costs nothing to have');
  ok(chosen('', MESSAGE).id === 'Ruth', 'no request means the default voice', `got ${chosen('', MESSAGE).id}`);
  ok(chosen('Clippy; DROP TABLE', MESSAGE).id === 'Ruth', 'and so does a voice that does not exist');

  // Asking for an OpenAI voice on an English message is allowed — it is the whole
  // point of offering them in the picker — and it must carry the model as its engine,
  // because that is what the id is hashed over and what the synthesiser dispatches on.
  const marin = chosen('marin', MESSAGE);
  ok(marin.id === 'marin' && marin.provider === 'openai', 'an OpenAI voice asked for by name is used as asked');
  ok(marin.engine === 'gpt-4o-mini-tts', 'with the model as its engine', `got ${marin.engine}`);

  // The override. A phone that remembers Matthew and is then read a Hebrew message
  // must not be answered in Matthew, whatever it asked for.
  const overridden = chosen('Matthew', hebrew);
  ok(overridden.provider === 'openai', 'Hebrew overrides the voice the phone asked for', `got ${overridden.id}`);
  ok(overridden.id === 'marin', 'and lands on the configured multilingual voice', `got ${overridden.id}`);
  ok(chosen('cedar', hebrew).id === 'cedar', 'an OpenAI voice already asked for is left alone');
  ok(chosen('Matthew', MESSAGE).id === 'Matthew', 'and an English message is not moved off Polly');

  // No key. A refusal, because a refusal is what gets the message read: every client
  // falls back to `speechSynthesis`, which does speak Hebrew on both phone platforms.
  let refused = null;
  try {
    chooseVoice('Matthew', hebrew, polly);
  } catch (err) {
    refused = err;
  }
  ok(refused?.status === 409, 'Hebrew with no OpenAI key is refused rather than read with holes in it', `got ${refused?.status}`);
  ok(/hebrew/i.test(refused?.message || ''), 'and the refusal names Hebrew as the reason', `got: ${refused?.message}`);
  ok(
    /own voice|openaiApiKey/.test(refused?.message || ''),
    'and says both what happens instead and how to fix it',
    `got: ${refused?.message}`,
  );

  let empty = null;
  try {
    chooseVoice('Ruth', MESSAGE, []);
  } catch (err) {
    empty = err;
  }
  ok(empty?.status === 503, 'a box with no voices at all says so rather than returning nothing', `got ${empty?.status}`);

  /*
   * The invariant the ids depend on: a voice id is bare — `marin`, `Ruth` — because a
   * phone has one in localStorage from before there were two providers, and it is
   * resolved by name against this list. Two providers claiming one name would make
   * the remembered value ambiguous.
   */
  const ids = both.map((v) => v.id.toLowerCase());
  ok(new Set(ids).size === ids.length, 'no two voices share a name across the providers', ids.join(', '));
  ok(
    OPENAI_VOICES.every((v) => v.id && v.gender && v.language === 'multi' && v.provider === 'openai'),
    'every OpenAI voice is described the way the picker needs',
  );
}

// --------------------------------------------------------------------------
/*
 * The bilingual reply, which is the shape a real message here has and the one that was
 * read with a hole in it until 2026-09-24.
 *
 * An English paragraph with a Hebrew word or two in it — a filename, a column heading,
 * `אש"ל` in an expenses answer — is under ten per cent Hebrew, so the share said "not a
 * Hebrew message" and the message went to whichever voice was asked for. On Polly that
 * is silence where the word was, with nothing in the response saying so. The fix is a
 * second, lower question: not *which language* to read it in, but *which providers may
 * be given it at all*. So the two moves are asserted separately and against each other,
 * because collapsing them back into one is the edit that reintroduces the bug — in
 * either direction. One way drops the word; the other reads an English paragraph in a
 * Hebrew accent because four letters of it were Hebrew.
 */
section('A quoted Hebrew word moves the provider, not the language:');
{
  const polly = FALLBACK_VOICES.map((v) => ({ ...v, provider: 'polly', engine: 'generative' }));
  const azure = AZURE_VOICES.map((v) => ({ ...v, engine: v.name }));
  const openai = OPENAI_VOICES.map((v) => ({ ...v, engine: 'gpt-4o-mini-tts' }));
  const both = [...polly, ...azure];
  const heb = (n) => Array.from({ length: n }, (_, i) => String.fromCodePoint(0x05d0 + (i % 27))).join('');

  const ava = azure.find((v) => v.id === 'Ava');
  const hila = azure.find((v) => v.id === 'Hila');
  ok(readsHebrew(ava) && readsHebrew(hila), 'every Azure voice will say a Hebrew word');
  ok(readsHebrew(openai[0]), 'and so will an OpenAI one');
  ok(
    !polly.some(readsHebrew),
    'no Polly voice will, in any engine — which is the reason this rule exists',
  );
  ok(
    readsHebrew(ava) && !speaksHebrew(ava),
    'Ava will say one without being a Hebrew voice: the distinction the two predicates keep',
  );

  const quoted = `The field in the config is ${heb(4)}, which is why that header renders right to left. ${MESSAGE}`;
  const mostly = `${heb(60)} auth.js ${heb(40)}.`;

  const moved = chooseVoice('Ruth', quoted, both);
  ok(moved.id === 'Ava', 'a Polly voice asked for on a message with a Hebrew word in it moves', moved.id);
  ok(moved.provider === 'azure', 'to Azure, which reads the Hebrew run in Hila and the rest in Ava');
  ok(
    moved.engine === 'en-US-AvaMultilingualNeural',
    'carrying the full Azure name, which is what the wire and the cache key want',
    String(moved.engine),
  );
  ok(
    moved.id !== 'Hila',
    'and not to Hila — the message is English, and four Hebrew letters do not change that',
  );
  ok(
    chooseVoice('Hila', quoted, both).id === 'Hila',
    'someone who asked for Hila by name is still read in Hila',
  );
  ok(
    chooseVoice('Andrew', quoted, both).id === 'Andrew',
    'and an Azure English voice is already able to say the word, so it is left alone',
  );
  ok(
    chooseVoice('Ruth', mostly, both).id === 'Hila',
    'a message that is mostly Hebrew still goes all the way to the native Hebrew voice',
    chooseVoice('Ruth', mostly, both).id,
  );
  ok(
    chooseVoice('Ruth', MESSAGE, both).id === 'Ruth',
    'while an English message with no Hebrew in it stays on the voice that was asked for',
  );

  // The box this repo clones as: Polly and nothing else. A refusal gets the message
  // read, because every client falls back to the phone's own voice, which does speak
  // Hebrew. Reading it anyway would not.
  let refused = null;
  try {
    chooseVoice('Ruth', quoted, polly);
  } catch (err) {
    refused = err;
  }
  ok(refused?.status === 409, 'a Polly-only box refuses the message rather than dropping the word', `got ${refused?.status}`);
  ok(
    /Hebrew/.test(refused?.message || '') && /own voice/.test(refused?.message || ''),
    'saying what is missing and what will read it instead',
    `got: ${refused?.message}`,
  );
  ok(
    chooseVoice('Ruth', MESSAGE, polly).id === 'Ruth',
    'and the same box reads an English message exactly as it always did',
  );
  ok(
    chooseVoice('Ruth', quoted, [...polly, ...openai]).provider === 'openai',
    'a box with an OpenAI key and no Azure moves there instead',
  );
}

// --------------------------------------------------------------------------
/*
 * Which voice a caller who asked for nothing gets, which is the one that decides what
 * read-aloud costs.
 *
 * Almost every read is this case: a phone stores a voice only when someone picks one
 * in the sheet, so an empty `voice` is the normal request and whatever this resolves to
 * is what the feature is billed at. Three of the four providers here are metered — Polly
 * at $30 per million characters, OpenAI near $17 — and one is not: Azure's F0 tier
 * answers 429 when the month's half-million characters are gone rather than charging
 * anyone. The standing instruction for this deployment is credits only, never a card,
 * so the default has to lean on the free one, and it has to keep doing so after someone
 * edits this file for an unrelated reason. Hence a section rather than one check.
 *
 * `preferredVoice` is a pure function over the list for that reason: this is checkable
 * with no credentials, no network and nothing spent, while the same question asked
 * through `prepare` would answer differently on a box with Azure credentials than on
 * one without — which is exactly the behaviour, and exactly why it cannot be the test.
 */
section('The default voice is the free one:');
{
  const polly = FALLBACK_VOICES.map((v) => ({ ...v, provider: 'polly', engine: 'generative' }));
  const azure = AZURE_VOICES.map((v) => ({ ...v, engine: v.name }));
  const openai = OPENAI_VOICES.map((v) => ({ ...v, engine: 'gpt-4o-mini-tts' }));
  const hebrew = Array.from({ length: 20 }, (_, i) => String.fromCodePoint(0x05d0 + i)).join('');

  ok(preferredVoice(polly).id === 'Ruth', 'a box with only Polly reads in Ruth, as it always did');
  ok(preferredVoice(openai)?.id === 'marin',
    'a box with only an OpenAI key reads in marin, not in a Polly voice it does not have');

  const free = preferredVoice([...polly, ...azure, ...openai]);
  ok(
    free.provider === 'azure',
    'a box with Azure credentials reads in the free voice instead',
    `got ${free.id}/${free.provider}`,
  );
  ok(free.id === 'Ava', 'which is Ava — the name the picker shows as the default', free.id);
  ok(
    /^en/i.test(String(free.language)),
    'an English voice, so an English message is not read in a Hebrew accent',
    String(free.language),
  );
  ok(
    free.engine === 'en-US-AvaMultilingualNeural',
    'carrying the full Azure name as its engine, which is what the wire wants',
    String(free.engine),
  );
  ok(
    preferredVoice([...polly, ...openai]).provider === 'polly',
    'an OpenAI key alone does not move the default — that provider is metered too',
  );

  // A deployment with Hebrew Azure voices and no English ones: the preference must not
  // reach for Hila, whose English is accented, while Polly is in the list.
  const hebrewOnlyAzure = [...polly, ...azure.filter((v) => v.language === 'he-IL')];
  ok(
    preferredVoice(hebrewOnlyAzure).id === 'Ruth',
    'an Azure resource with only Hebrew voices leaves English on Polly',
    preferredVoice(hebrewOnlyAzure).id,
  );
  ok(preferredVoice(azure).id === 'Ava', 'a box with no Polly at all still has a default');
  ok(
    preferredVoice([]) === undefined,
    'and a box with no voices answers nothing rather than inventing one',
  );

  // `chooseVoice` is what actually routes a message, so it has to reach the same
  // conclusion — and the Hebrew rule has to survive the new default.
  const both = [...polly, ...azure];
  ok(chooseVoice('', MESSAGE, both).id === 'Ava', 'a message with no voice asked for is read free');
  ok(
    chooseVoice('Ruth', MESSAGE, both).id === 'Ruth',
    'and Polly is still one tap away for anyone who asks for it by name',
  );
  ok(
    chooseVoice('', hebrew, both).id === 'Hila',
    'a Hebrew message still goes to the native Hebrew voice, not to the English default',
    chooseVoice('', hebrew, both).id,
  );
  ok(
    chooseVoice('', hebrew, both).provider === 'azure',
    'which is free as well, so neither language is the expensive one',
  );

  /*
   * And the operator's override, which can only be checked in another process: it is
   * read from the environment at import time, because it is a deployment setting rather
   * than something a request carries.
   */
  const pinned = (value) =>
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { preferredVoice, FALLBACK_VOICES } from './speak.js';" +
          "import { AZURE_VOICES } from './azure-speech.js';" +
          "const known = [...FALLBACK_VOICES.map((v) => ({ ...v, provider: 'polly' })), ...AZURE_VOICES];" +
          "process.stdout.write(preferredVoice(known)?.id || '');",
      ],
      {
        cwd: new URL('.', import.meta.url).pathname,
        env: { ...process.env, SPEAK_VOICE: value },
        encoding: 'utf8',
      },
    ).trim();

  ok(pinned('Matthew') === 'Matthew', "an operator's SPEAK_VOICE outranks the free default", pinned('Matthew'));
  ok(pinned('') === 'Ava', 'an unset SPEAK_VOICE means the free voice, not Ruth');
  ok(
    pinned('Clippy') === 'Ava',
    'and a SPEAK_VOICE this box does not have falls through to it rather than failing',
    pinned('Clippy'),
  );
}

// --------------------------------------------------------------------------
/*
 * Two providers, two budgets.
 *
 * Separate allowances because they are separately priced and separately risky: Polly
 * is on the instance role and bills the same account as everything else, while the
 * OpenAI key is a third party that a runaway read would spend real credit at. An
 * exhausted OpenAI budget must not take English read-aloud down with it, and an
 * exhausted Polly one must not be what stops a Hebrew message from being read.
 */
section('Two providers, two budgets:');
{
  const SHORT = 'Say this out loud.';
  const OTHER = 'Say this too, please.';
  const voice = fakeVoice();
  const cache = new VoiceCache({ synthesize: voice.synthesize, dailyChars: { polly: 1000, openai: 30 } });

  const p = cache.prepare(SHORT, 'Ruth', 'generative', 'polly');
  const o = cache.prepare(SHORT, 'marin', 'gpt-4o-mini-tts', 'openai');
  ok(p.id !== o.id, 'the same words in two providers are two different recordings');
  ok(
    messageId(SHORT, 'marin', 'gpt-4o-mini-tts', 'openai') !== messageId(SHORT, 'marin', 'gpt-4o-mini-tts', 'polly'),
    'because the provider is part of the id, so one cannot serve the other',
  );
  ok(o.provider === 'openai', 'and the answer says which provider will read it', JSON.stringify(o));

  await cache.audio(p.id, 0);
  ok(voice.calls[0].provider === 'polly', 'the synthesiser is told which provider to use', `got ${voice.calls[0].provider}`);
  ok(
    cache.budget('polly').chars === SHORT.length && cache.budget('openai').chars === 0,
    'a Polly read is charged to Polly and to nothing else',
    JSON.stringify([cache.budget('polly'), cache.budget('openai')]),
  );

  await cache.audio(o.id, 0);
  ok(voice.calls[1].provider === 'openai', 'and an OpenAI read says OpenAI');
  ok(
    cache.budget('openai').chars === SHORT.length && cache.budget('polly').chars === SHORT.length,
    'each provider counts only its own characters',
    JSON.stringify([cache.budget('polly'), cache.budget('openai')]),
  );
  ok(cache.budget('openai').limit === 30 && cache.budget('polly').limit === 1000, 'and each has its own limit');

  const o2 = cache.prepare(OTHER, 'marin', 'gpt-4o-mini-tts', 'openai');
  let spent = null;
  try {
    await cache.audio(o2.id, 0);
  } catch (err) {
    spent = err;
  }
  ok(spent?.status === 429, 'reading past the OpenAI budget is refused', `got ${spent?.status}: ${spent?.message}`);
  ok(
    /SPEAK_OPENAI_DAILY_CHARS/.test(spent?.message || ''),
    'and the refusal names the knob for that provider, not the other one',
    `got: ${spent?.message}`,
  );

  /*
   * Azure's refusal names Azure's knob, and says the one thing the other two cannot:
   * that there is somewhere to go besides waiting for midnight. It is the provider
   * most likely to hit its limit now that English reads through it, and the operator
   * sent to `SPEAK_DAILY_CHARS` — which is Polly's — would raise a number that changes
   * nothing and conclude the box is broken.
   */
  const rationed = new VoiceCache({ synthesize: voice.synthesize, dailyChars: { azure: 5 } });
  const a = rationed.prepare(SHORT, 'Ava', 'en-US-AvaMultilingualNeural', 'azure');
  let out = null;
  try {
    await rationed.audio(a.id, 0);
  } catch (err) {
    out = err;
  }
  ok(out?.status === 429, "reading past Azure's daily ration is refused too", `got ${out?.status}`);
  ok(
    /SPEAK_AZURE_DAILY_CHARS/.test(out?.message || ''),
    'and names Azure’s knob rather than Polly’s',
    `got: ${out?.message}`,
  );
  ok(
    /Polly/.test(out?.message || ''),
    'and says a paid voice is a tap away, since this limit is a ration of a free month',
    `got: ${out?.message}`,
  );

  // The point of separating them.
  const p2 = cache.prepare(OTHER, 'Ruth', 'generative', 'polly');
  ok((await cache.audio(p2.id, 0)).audio.length > 0, 'an exhausted OpenAI budget does not stop Polly reading');

  // A provider with no allowance configured gets none, rather than an unlimited one:
  // a missing number must not be the way a third-party bill runs away.
  const pollyOnly = new VoiceCache({ synthesize: voice.synthesize, dailyChars: { polly: 1000 } });
  const none = pollyOnly.prepare(SHORT, 'marin', 'gpt-4o-mini-tts', 'openai');
  let unbudgeted = null;
  try {
    await pollyOnly.audio(none.id, 0);
  } catch (err) {
    unbudgeted = err;
  }
  ok(unbudgeted?.status === 429, 'a provider with no budget configured reads nothing', `got ${unbudgeted?.status}`);

  // And the old single-number form still means what it always meant, because that is
  // what a deployment setting SPEAK_DAILY_CHARS is doing.
  const one = new VoiceCache({ synthesize: voice.synthesize, dailyChars: 200 });
  ok(
    one.budget('polly').limit === 200 && one.budget('openai').limit === 200,
    'one number is still every provider’s allowance',
  );
  ok(one.budget().provider === 'polly', 'and asking about no provider in particular means Polly');
}

// --------------------------------------------------------------------------
section('What the phone is told about the second voice:');
{
  const describe = async () => ({
    voices: [
      { id: 'Ruth', gender: 'Female', language: 'en-US' },
      { id: 'Lupe', gender: 'Female', language: 'es-US' },
    ],
    reason: null,
  });

  const withKey = await speechStatus({ lang: 'en', describe, hasOpenAi: async () => true, hasAzure: async () => false });
  ok(
    withKey.voices.some((v) => v.id === 'marin' && v.provider === 'openai'),
    'a box with a key offers the OpenAI voices too',
    withKey.voices.map((v) => v.id).join(', '),
  );
  ok(withKey.voices[0].id === 'Ruth', "an English phone still gets its own language first", withKey.voices.map((v) => v.id).join(', '));
  ok(withKey.hebrew.available === true && withKey.hebrew.voice === 'marin', 'and it says Hebrew can be read, and by which voice', JSON.stringify(withKey.hebrew));
  ok(
    withKey.budgets?.polly?.provider === 'polly' && withKey.budgets?.openai?.provider === 'openai',
    'both budgets are reported, so a sheet can show which voice has room left',
  );
  ok(withKey.budget?.provider === 'polly', "and `budget` still means Polly's, for clients that only know that field");

  // A phone set to Hebrew: the voices that can actually read to it come first.
  const hebPhone = await speechStatus({ lang: 'he-IL', describe, hasOpenAi: async () => true, hasAzure: async () => false });
  ok(
    hebPhone.voices[0].provider === 'openai',
    'a Hebrew phone is offered the voices that can read Hebrew first',
    hebPhone.voices.map((v) => `${v.id}/${v.provider}`).join(', '),
  );
  ok(hebPhone.voices.some((v) => v.id === 'Ruth'), 'without hiding the English ones');

  // The case this deployment is in until a key is put in the secret.
  const noKey = await speechStatus({ lang: 'en', describe, hasOpenAi: async () => false, hasAzure: async () => false });
  ok(
    !noKey.voices.some((v) => v.provider === 'openai'),
    'a box with no key offers no voice that would fail on the tap',
    noKey.voices.map((v) => v.id).join(', '),
  );
  ok(noKey.configured === true, 'and is still configured — English read-aloud works exactly as before');
  ok(noKey.hebrew.available === false, 'but says Hebrew is not available here');
  ok(
    /own voice/i.test(noKey.hebrew.reason || ''),
    "and that the device's own voice is what reads it instead, rather than nothing",
    `got: ${noKey.hebrew.reason}`,
  );

  /*
   * A box with the Azure credentials this deployment has: what the sheet is told is
   * the default, which is what a phone that has never chosen will be read in.
   */
  const withAzure = await speechStatus({
    lang: 'en',
    describe,
    hasOpenAi: async () => false,
    hasAzure: async () => true,
  });
  ok(withAzure.voice === 'Ava', 'the reported default is the free voice', String(withAzure.voice));
  ok(
    withAzure.voices.some((v) => v.id === 'Ava' && v.provider === 'azure'),
    'which is in the list the picker is built from',
    withAzure.voices.map((v) => `${v.id}/${v.provider}`).join(', '),
  );
  ok(
    withAzure.voices.some((v) => v.id === 'Ruth' && v.provider === 'polly'),
    'and Polly is still offered alongside it rather than replaced',
  );
  ok(
    withAzure.voices.findIndex((v) => v.id === 'Ava') <
      withAzure.voices.findIndex((v) => v.id === 'Hila'),
    'an English phone is offered the English Azure voice before the Hebrew ones',
    withAzure.voices.map((v) => v.id).join(', '),
  );
  ok(
    withAzure.hebrew.available === true && withAzure.hebrew.voice === 'Hila',
    'Hebrew is still read by the native Hebrew voice, not by the English default',
    JSON.stringify(withAzure.hebrew),
  );
  ok(
    withAzure.budgets?.azure?.provider === 'azure',
    'and the free provider’s allowance is reported, because it is the one that runs out',
  );

  // The collision the id scheme cannot survive, resolved in favour of the provider a
  // deployment has without signing up for anything.
  const clash = await speechStatus({
    describe: async () => ({ voices: [{ id: 'marin', gender: 'Female', language: 'en-US' }], reason: null }),
    hasOpenAi: async () => true,
    hasAzure: async () => false,
  });
  const marins = clash.voices.filter((v) => v.id.toLowerCase() === 'marin');
  ok(marins.length === 1 && marins[0].provider === 'polly', 'a name claimed by both providers is listed once, as Polly’s', JSON.stringify(marins));
  const listed = clash.voices.map((v) => v.id.toLowerCase());
  ok(new Set(listed).size === listed.length, 'so the picker never shows one name twice');
}

// --------------------------------------------------------------------------
/*
 * The silence the tap unlocks the audio element with.
 *
 * Small enough to look unimportant, and it is the whole feature on iOS: an element
 * that was not played inside the gesture may not be played from a callback
 * afterwards, so if this will not play there is no server voice on a phone at all —
 * only the robotic one, with nothing reported anywhere. Checked as audio rather
 * than as a length, because a truncated header is the way it would break.
 */
{
  const riff = SILENT_WAV.subarray(0, 4).toString('ascii');
  const wave = SILENT_WAV.subarray(8, 12).toString('ascii');
  ok(riff === 'RIFF' && wave === 'WAVE', 'the unlock file is a WAV', `got ${riff}/${wave}`);
  ok(
    SILENT_WAV.readUInt32LE(4) === SILENT_WAV.length - 8,
    'its declared size matches its actual size, so no player has to guess',
  );
  ok(
    SILENT_WAV.subarray(36, 40).toString('ascii') === 'data' && SILENT_WAV.readUInt32LE(40) === 0,
    'and it is silence: a data chunk with no samples in it',
  );
}

// --------------------------------------------------------------------------
/*
 * Reading the code block instead of saying "Code block".
 *
 * Most of what is checked here is one thing: a synthesiser is silent on
 * punctuation, so `if (!ok) return` read literally is "if ok return" — the
 * opposite of the code, in a confident voice, with nothing to hear that anything
 * was lost. Every operator that changes what a line *means* has to become a word,
 * and the ones that only group it have to not.
 */
section('Reading a code block out loud:');
{
  const heard = codeAloud('```js\nif (!ok) return;\nconst id = messageId(text, voice);\n```');

  ok(/^JavaScript code, 2 lines\./.test(heard), 'it says what it is about to read, and how much', heard.slice(0, 40));
  ok(/not ok/.test(heard), 'a negation becomes a word, because the character is read as nothing', heard);
  ok(!heard.includes('!'), 'and the character itself does not survive to be silent');
  ok(!/[{}();]/.test(heard), 'the punctuation that only groups a line is dropped rather than named', heard);
  ok(/messageId/.test(heard) && /voice/.test(heard), 'identifiers survive: they are the words');
  ok(/\bequals\b/.test(heard), 'and an assignment is spoken, not skipped');
}

{
  const heard = codeAloud('a === b\nc !== d\nx <= y\np && q\nr || s\nv ?? w\nn => n + 1', { lang: 'js' });
  ok(/strictly equals/.test(heard), 'three equals signs are not the same as two', heard);
  ok(/strictly not equals/.test(heard), 'and neither is the negated form');
  ok(/less than or equal to/.test(heard), 'a comparison is read as one');
  ok(/ and /.test(heard) && / or /.test(heard), 'and so are the boolean operators');
  ok(/or else/.test(heard), 'including the nullish one, which is not "or"');
  ok(/arrow/.test(heard), 'a function arrow is named, since a line of code without it is a different line');
  ok(/plus/.test(heard), 'and spaced arithmetic is spoken');
}

{
  const heard = codeAloud('const SPEAK_DAILY_CHARS = 300000;', { lang: 'js' });
  ok(/SPEAK DAILY CHARS/.test(heard), 'an upper-snake constant is three words, not one unsayable token', heard);
}

/*
 * The guard against over-eagerness. `<` and `/` mean comparison and division only
 * when they are spaced like operators; in a tag, a path or a flag they are neither,
 * and a voice that says "less than div" or "auth divided by js" is worse than one
 * that says nothing.
 */
{
  const heard = codeAloud('<div className="x">\nimport x from "./a/b/c.js";\nrun(--force);', { lang: 'jsx' });
  ok(!/less than/.test(heard), 'a tag is not a comparison', heard);
  ok(!/divided by/.test(heard), 'and a path is not a division');
  ok(/run --force\./.test(heard), 'and a command-line flag is read as one, not as two minuses', heard);
}

{
  const heard = codeAloud('```bash\nnpm test && git push origin main\n```');
  ok(/^shell code, one line\./.test(heard), 'a one-line block says "one line", not "1 lines"', heard);
  ok(/npm test and git push origin main/.test(heard), 'and a shell chain reads as a sentence', heard);
}

/*
 * A diff. The first column is the entire message: read without it, the line that
 * was deleted and the line that replaced it are the same sentence twice, and the
 * change — the only thing the block was showing — is gone without a trace.
 */
{
  const heard = codeAloud(
    '```diff\n--- a/auth.js\n+++ b/auth.js\n@@ -41,3 +41,3 @@\n-  return true;\n+  return false;\n```',
  );
  ok(/removed, return true/.test(heard), 'a deleted line says it was deleted', heard);
  ok(/added, return false/.test(heard), 'and an added line says it was added');
  ok(!/@@/.test(heard) && !heard.includes('+++'), 'the hunk headers are not read out as noise');
}

{
  // A file pasted into a message is neither listenable nor free.
  const many = Array.from({ length: CODE_LINES + 15 }, (_, i) => `line${i} = ${i};`).join('\n');
  const heard = codeAloud(many);
  ok(new RegExp(`code, ${CODE_LINES + 15} lines`).test(heard), 'the count is the whole block, not the part read', heard.slice(0, 40));
  ok(/the other 15 are on screen/.test(heard), 'and it says how many it stopped short of');
  ok(!heard.includes(`line${CODE_LINES + 5} `), 'having genuinely stopped, rather than reading and claiming otherwise');
  ok(codeAloud(many, { maxLines: 3 }).length < heard.length, 'and the cap is a knob');
}

{
  ok(/empty/.test(codeAloud('```js\n\n```')), 'an empty block says so rather than being played as silence');
  ok(
    /nothing in it that can be read/.test(codeAloud('```\n{\n}\n```')),
    'and a block of nothing but punctuation says that, instead of a header and silence',
    codeAloud('```\n{\n}\n```'),
  );
  ok(/code, 3 lines/.test(codeAloud('a\nb\nc')), 'a block with no fence and no language is still read');
  ok(codeAloud(null) === 'That code block is empty.', 'and nothing at all is not a crash');
}

{
  /*
   * Why the voice is chosen from the reduction and not from the message: a Hebrew
   * comment inside a code block is still Hebrew, and Polly does not mispronounce
   * Hebrew — it skips it. Choosing the voice before reducing would read the code in
   * a voice that silently omits the sentence explaining it.
   */
  const hebrew = Array.from({ length: 40 }, (_, i) => String.fromCodePoint(0x05d0 + (i % 27))).join('');
  const block = `\`\`\`js\n// ${hebrew}\nconst x = 1;\n\`\`\``;
  ok(needsMultilingualVoice(codeAloud(block)), 'a Hebrew comment survives the reduction and asks for the other voice');
}

{
  // The route: the reduction happens on the server, so the editor overlay and the
  // chat app cannot drift into hearing two different things.
  const block = '```js\nif (!ok) return;\n```';
  const asCode = await prepare(block, { kind: 'code' });
  const asWords = await prepare(codeAloud(block), {});
  ok(asCode.id === asWords.id, 'preparing a block as code is preparing its spoken form', `${asCode.id} vs ${asWords.id}`);
  const asProse = await prepare(block, {});
  ok(asProse.id !== asCode.id, 'and the default is still what every existing client sends');
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
