/**
 * The voice that reads a message out loud.
 *
 * Read aloud used to be the browser's own `speechSynthesis`, which is the voice
 * the platform gives away: on Android it is flat, it mispronounces every
 * identifier, and it breathes in the wrong places, so a summary read out of it is
 * something you decode rather than listen to. The point of that button is to hear
 * the answer while walking, driving or waiting — and a voice you have to
 * concentrate on defeats it.
 *
 * So the audio is synthesised on the box now, and the browser only plays it.
 * Amazon Polly, because this instance already has an AWS role and already talks to
 * Bedrock: nothing new to sign up for, no API key to keep, and no third party in
 * the path of a private conversation. Its *generative* engine, because that is the
 * tier that sounds like a person rather than an announcement — it pauses where the
 * sentence pauses, puts the stress on the right word, and reads "auth.js, line 42
 * to 51" as a phrase instead of a list of tokens.
 *
 * Measured from this instance against us-east-1 on 2026-09-18, Ruth/generative:
 *
 *     chars   first byte   synthesis   audio it makes   synthesis/audio
 *       160        204ms        1.9s            9.4s            0.20x
 *       240        143ms        2.7s           13.7s            0.20x
 *       450        134ms        4.7s           25.7s            0.18x
 *       850        148ms        9.3s           48.5s            0.19x
 *      1600        149ms       16.8s           90.7s            0.18x
 *
 * Two of those numbers decide the whole design.
 *
 * **Synthesis takes about a fifth of the time its own audio takes to play.** So a
 * message is cut into pieces and each piece is built while the previous one is
 * still playing, with a five-fold margin. Nothing has to be waited for after the
 * first piece, and a listener hears one continuous message.
 *
 * **The wait for that first piece is proportional to its length.** Hence
 * `FIRST_SEGMENT_CHARS`: the opening piece is one or two sentences, so the voice
 * starts in about two seconds instead of the twenty-three a whole message takes.
 * Everything after it is `SEGMENT_CHARS`, which is long enough that the boundaries
 * are rare and always fall where a sentence already ended.
 *
 * Pieces are also what makes stopping cheap. Polly bills per character submitted,
 * so a message abandoned after the first sentence costs one segment rather than
 * all of it — which matters because the *reason* to stop is usually that you have
 * heard enough.
 *
 * What this refuses, and why each refusal exists:
 *
 *  - **A daily character budget** (`SPEAK_DAILY_CHARS`). Generative Polly is $30
 *    per million characters, so a full 3000-character read is about 9 cents and a
 *    loop that re-reads a message every few seconds is real money. A caller that
 *    reaches the budget gets 429 with a sentence saying so, and the client falls
 *    back to the browser voice rather than going quiet.
 *  - **A cap on the text** (`SPEAK_MAX_CHARS`). A guard against a pasted file or a
 *    whole transcript, not against a long answer — nothing the client sends
 *    approaches it. See the constant for why the number is what it is.
 *  - **An allowlist of voices.** A caller-supplied string is never passed through
 *    to the API: an unknown voice falls back to the default and the answer says
 *    which voice was actually used, so a stale phone with an old name in
 *    localStorage still gets audio.
 *
 * And what it caches: audio is keyed by (engine, voice, text), which is exact,
 * because Polly is deterministic — the same request twice returned byte-identical
 * audio when this was measured. So re-reading a message, or the same message on a
 * second device, is free and instant.
 *
 * ---------------------------------------------------------------------------
 *
 * **There are two synthesisers now, and Hebrew is the reason.**
 *
 * Polly cannot say Hebrew. `polly:DescribeVoices` on this account answers with 40
 * languages and `he-IL` is not one of them — there is no voice, no engine and no
 * region that adds it, so this is not a quality problem to tune but a synthesiser
 * that does not do the job. OpenAI's speech models do (57 languages, tracking
 * Whisper's list), so they are the second provider here, and a message with Hebrew
 * in it is routed to them regardless of which voice the phone remembers. See
 * `pickVoice`.
 *
 * Everything the two providers disagree about is held in the voice registry rather
 * than in the code paths: a voice record carries its `provider`, the `engine` (which
 * for OpenAI is the model name) and its language, and the rest of this file asks the
 * record instead of asking which provider it is dealing with. Two consequences worth
 * knowing:
 *
 *  - **Voice ids stay bare** — `Ruth`, `marin` — rather than being namespaced by
 *    provider. Phones remember the id in `localStorage` (`cmo-voice`), and a
 *    rename would silently drop every device back to the default. The names do not
 *    collide today (Polly's are capitalised, OpenAI's are not) and `knownVoices()`
 *    enforces that they never do, so a Polly voice arriving one day with a name
 *    OpenAI already uses is dropped from the list rather than making the id
 *    ambiguous. `speak-test.js` holds that invariant.
 *  - **The daily budget is per provider**, because the two are not priced alike:
 *    generative Polly is $30 per million characters and `gpt-4o-mini-tts` works out
 *    near $17, so one shared allowance would either starve the cheap one or
 *    overspend on the expensive one.
 *
 * ---------------------------------------------------------------------------
 *
 * **And the default voice is the free one, which is a third provider.**
 *
 * Azure came in for Hebrew and turned out to be the answer to a different question.
 * Its Speech resource is on the `F0` tier: half a million characters of neural TTS a
 * month, and when that is gone it answers 429 rather than charging anyone. Polly's
 * generative engine is $30 per million — about seven cents for a full-length message,
 * which is not much and is also not nothing, and the standing instruction for this
 * deployment is credits only, never a card.
 *
 * So a client that asks for no voice in particular now gets `Ava`, an Azure neural
 * voice, rather than `Ruth` on Polly. Polly is not gone and is not a fallback of last
 * resort: it is still in the picker, still the better-sounding of the two to some ears,
 * and still what a box with no Azure credentials reads with. `SPEAK_VOICE` pins a name
 * for an operator who wants one. What changed is only which way the default leans when
 * nobody has said — towards the provider that cannot produce an invoice. The order
 * lives in `preferredVoice`, and nothing else in this file knows about it.
 *
 * ---------------------------------------------------------------------------
 *
 * One property the cache relies on is weaker for the second provider: OpenAI does
 * not promise byte-identical audio for an identical request. It does not matter
 * here, because an id is only ever resolved against the bytes this process already
 * synthesised for it — a re-read inside the TTL is the same audio, and after that
 * the entry is gone and there is nothing to be inconsistent with.
 */
import { createHash } from 'crypto';
import {
  PollyClient,
  SynthesizeSpeechCommand,
  DescribeVoicesCommand,
} from '@aws-sdk/client-polly';
import { openAiKey, openAiRefusal, resetOpenAi } from './openai.js';
import {
  AZURE_VOICES,
  azureSpeechConfigured,
  resetAzureSpeech,
  speakAzure,
} from './azure-speech.js';

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
// `generative` is the point of this file. `neural` ($16/M) and `standard` ($4/M)
// are here as an escape hatch for a region without generative voices, or for an
// operator who would rather pay less — both still beat the browser's voice.
const ENGINE = process.env.SPEAK_ENGINE || 'generative';
/**
 * The voice an operator has pinned, if any — and Polly's default for a box that has
 * nothing free to read with.
 *
 * These used to be one constant, `SPEAK_VOICE || 'Ruth'`, because there was one
 * provider and its cheapest option was still metered. Now there is a free one, and
 * "the default voice" is no longer a name that can be written down here: it depends on
 * what the box has. `preferredVoice` decides; this is only what it starts from.
 */
const SPEAK_VOICE = (process.env.SPEAK_VOICE || '').trim();
const POLLY_VOICE = 'Ruth';

/*
 * The second provider.
 *
 * `gpt-4o-mini-tts` rather than `tts-1`: it is the one that takes `instructions`,
 * which is the whole reason to prefer it here — a Claude reply read as prose comes
 * out smoother than a reply read as an announcement, and `SPEAK_INSTRUCTIONS` below
 * is what asks for that. It is also the cheaper of the two ($12 per million audio
 * tokens, near $17 per million characters of input, against $15 for `tts-1` and $30
 * for `tts-1-hd`). `tts-1` is still a valid value for the override; the instructions
 * are dropped when the model is not one that accepts them, because sending them to
 * `tts-1` is a 400 rather than a voice that ignores them.
 */
const OPENAI_MODEL = process.env.SPEAK_OPENAI_MODEL || 'gpt-4o-mini-tts';
const OPENAI_VOICE = process.env.SPEAK_OPENAI_VOICE || 'marin';
/** Which of Azure's two Hebrew voices reads by default. Both are neural. */
const AZURE_VOICE = process.env.SPEAK_AZURE_VOICE || 'Hila';
const OPENAI_URL = 'https://api.openai.com/v1/audio/speech';

/**
 * How the voice should read, which only `gpt-4o-mini-tts` and its successors accept.
 *
 * Aimed at the one kind of text this ever reads: a summary of work just done, full
 * of identifiers, paths and numbers that a voice reading for flow will smooth into
 * mush. The reduction in `speakable()` has already turned `auth.js:42-51` into
 * "auth.js, line 42 to 51", so what is left to ask for is pace and precision rather
 * than pronunciation rules.
 */
const OPENAI_INSTRUCTIONS =
  process.env.SPEAK_INSTRUCTIONS ||
  'Read this the way a colleague would tell you what they just did: calm, ' +
    'unhurried, and clear. It is a summary of software work, so say file names, ' +
    'identifiers and numbers precisely instead of smoothing them out, and pause at ' +
    'the ends of sentences. Do not add anything that is not in the text.';

// Measured above: ~1.9s of waiting before the first word, against ~9.4s of audio
// to cover the next piece being built.
export const FIRST_SEGMENT_CHARS = Number(process.env.SPEAK_FIRST_CHARS || 160);
// ~7.7s to build, ~40s of audio. The margin is what keeps the message continuous.
export const SEGMENT_CHARS = Number(process.env.SPEAK_SEGMENT_CHARS || 700);

/*
 * The longest message this will read, and no longer a mirror of a client cap.
 *
 * It used to be 4000, which was "the 2400 characters the overlay cut at, with room
 * for a lead-in". The overlay no longer cuts — a listener with the phone in a pocket
 * cannot act on "the rest is on screen" — so this is the only limit left, and it has
 * to stand on its own reasons rather than on someone else's number:
 *
 *   40,000 characters is about three quarters of an hour of speech, and longer than
 *   anything this app writes: a very long final message is 10-15k. So it is a guard
 *   against a mistake — a pasted file, a whole transcript — and not against a long
 *   answer, which is the thing it was accidentally refusing before.
 *   It also bounds the audio one message can hold: mp3 runs ~0.35KB per character,
 *   so a fully played 40k read is ~13MB and `MAX_MESSAGES` of them ~80MB, which is
 *   the real reason not to make this number much larger.
 *
 * Past it the answer is a 413 with a sentence, and the overlay reads the whole
 * message with the browser's own voice instead — slower and worse, never silent.
 */
const MAX_CHARS = Number(process.env.SPEAK_MAX_CHARS || 40_000);
// A 700-character segment takes ~7.7s. This is for a bad day, not a normal one.
const SYNTH_TIMEOUT_MS = Number(process.env.SPEAK_TIMEOUT_MS || 30_000);
// ~$9/day at generative rates: enough for about 125 full reads, low enough that a
// runaway client is a refusal rather than an invoice.
const DAILY_CHARS = Number(process.env.SPEAK_DAILY_CHARS || 300_000);
// The same 300k against `gpt-4o-mini-tts` is nearer $5, because it is the cheaper
// of the two. Kept a separate allowance rather than a shared pool so that a day
// spent reading Hebrew cannot exhaust the English voice, and so that the number
// can be reasoned about per provider when either price moves.
const OPENAI_DAILY_CHARS = Number(process.env.SPEAK_OPENAI_DAILY_CHARS || 300_000);
/*
 * Azure's allowance is not about money — the F0 tier is free and answers 429 rather
 * than billing — it is about not spending the whole month in an afternoon. 0.5M
 * characters a month over 31 days is 16,129, so 16,000 a day keeps the free voice
 * working on the 28th. Going over is not a charge and this is not protecting anyone
 * from one; it is rationing a free thing so it lasts.
 *
 * It matters more now than when only Hebrew came through here, because English is the
 * default and English is most of what gets read — and more again since the client
 * stopped cutting at 2400 characters, because a full-length message is now read to the
 * end: call it five or six long ones a day rather than a dozen part-ones. What happens
 * at the limit is a 429 and the client's usual answer
 * to one — the overlay reads with the browser's voice, the chat app says it cannot —
 * and *not* a silent move onto Polly, which would turn a rationed free thing into an
 * unasked-for bill. Anyone who would rather pay than wait for midnight can pick a
 * Polly voice in the picker, which is the sentence the refusal ends with.
 */
const AZURE_DAILY_CHARS = Number(process.env.SPEAK_AZURE_DAILY_CHARS || 16_000);

/** Which knob raises each provider's allowance, for a refusal to name the right one. */
const DAILY_KNOBS = {
  polly: 'SPEAK_DAILY_CHARS',
  openai: 'SPEAK_OPENAI_DAILY_CHARS',
  azure: 'SPEAK_AZURE_DAILY_CHARS',
};
// Long enough to finish reading a message and to read it again; short enough that
// a phone left on the sheet is not holding megabytes of audio for the afternoon.
const TTL_MS = Number(process.env.SPEAK_TTL_MS || 10 * 60 * 1000);
// A full message is ~800KB of mp3, so six of them is ~5MB — the cost of a
// conversation switched between a few times while listening.
const MAX_MESSAGES = Number(process.env.SPEAK_MAX_MESSAGES || 6);

/**
 * The generative voices in us-east-1, from `aws polly describe-voices --engine
 * generative` on 2026-09-18.
 *
 * Only a fallback: `speechStatus()` asks Polly itself, and that answer is what the
 * picker on the phone is built from. This list is what validates a voice name when
 * the account cannot call DescribeVoices, so a deployment with a narrower policy
 * than ours still gets audio instead of an error.
 */
export const FALLBACK_VOICES = [
  { id: 'Ruth', gender: 'Female', language: 'en-US', provider: 'polly' },
  { id: 'Matthew', gender: 'Male', language: 'en-US', provider: 'polly' },
  { id: 'Danielle', gender: 'Female', language: 'en-US', provider: 'polly' },
  { id: 'Stephen', gender: 'Male', language: 'en-US', provider: 'polly' },
  { id: 'Joanna', gender: 'Female', language: 'en-US', provider: 'polly' },
  { id: 'Salli', gender: 'Female', language: 'en-US', provider: 'polly' },
  { id: 'Tiffany', gender: 'Female', language: 'en-US', provider: 'polly' },
];

/**
 * The OpenAI voices, which are the only ones here that can read Hebrew.
 *
 * Hard-coded rather than probed, because there is no endpoint that lists them —
 * they are documented, not discoverable — so this list is the registry and a name
 * OpenAI retires becomes a 400 that `pickVoice` never had the chance to catch. That
 * is the trade, and it is the same one the `FALLBACK_VOICES` list above makes.
 *
 * `language: 'multi'` is not a language code and is not meant to look like one.
 * These voices are one voice each reading whatever script they are given, so they
 * match every phone in the picker's ordering rather than sorting under one locale.
 * They are, as OpenAI says, "optimized for English" — a Hebrew reading has an accent
 * to it. It is still the difference between a message that can be listened to and
 * one that cannot be said at all.
 *
 * `marin` and `cedar` are the two OpenAI recommends for quality and are listed
 * first, which is also the order the picker shows.
 */
export const OPENAI_VOICES = [
  { id: 'marin', gender: 'Female', language: 'multi', provider: 'openai' },
  { id: 'cedar', gender: 'Male', language: 'multi', provider: 'openai' },
  { id: 'alloy', gender: 'Neutral', language: 'multi', provider: 'openai' },
  { id: 'ash', gender: 'Male', language: 'multi', provider: 'openai' },
  { id: 'ballad', gender: 'Male', language: 'multi', provider: 'openai' },
  { id: 'coral', gender: 'Female', language: 'multi', provider: 'openai' },
  { id: 'echo', gender: 'Male', language: 'multi', provider: 'openai' },
  { id: 'nova', gender: 'Female', language: 'multi', provider: 'openai' },
  { id: 'onyx', gender: 'Male', language: 'multi', provider: 'openai' },
  { id: 'sage', gender: 'Female', language: 'multi', provider: 'openai' },
  { id: 'shimmer', gender: 'Female', language: 'multi', provider: 'openai' },
  { id: 'verse', gender: 'Male', language: 'multi', provider: 'openai' },
];

/**
 * How much of this message is Hebrew, and the two different questions asked of it.
 *
 * A share rather than a flag, because the mixed case is the normal one: a reply
 * written in Hebrew still names `auth.js` and `SPEAK_DAILY_CHARS` in Latin letters,
 * and an English reply may quote one Hebrew string. Counted over letters only, so
 * the punctuation and the digits that a code-heavy message is full of do not drag
 * the share down.
 *
 * `HEBREW_SHARE` is **not** the threshold for "may this be read at all" — that is
 * `hasHebrew`, which is any Hebrew whatsoever. It is the narrower question of whether
 * the message is Hebrew enough to be *read in a Hebrew voice*, whose English is
 * accented: at ten per cent and up this is a Hebrew message that quotes some code, and
 * Hila reading it out is right; below that it is an English message quoting a word or
 * two, which should be read by an English voice that hands those words to Hila. Both
 * decisions are made in `chooseVoice`.
 */
export const HEBREW_SHARE = Number(process.env.SPEAK_HEBREW_SHARE || 0.1);

export function hebrewShare(text) {
  const letters = String(text ?? '').match(/\p{L}/gu);
  if (!letters || !letters.length) return 0;
  // U+0590–U+05FF is the Hebrew block; U+FB1D–U+FB4F is the presentation block
  // that holds the pointed forms and the ligatures some copied text carries. Written
  // as escapes rather than as the characters themselves, so that the range stays
  // readable in a left-to-right file and survives an editor that reorders a
  // right-to-left literal.
  const hebrew = letters.filter((c) => /[\u0590-\u05FF\uFB1D-\uFB4F]/.test(c)).length;
  return hebrew / letters.length;
}

/**
 * Is there any Hebrew in here at all?
 *
 * The question that decides whether the voice may be Polly, and the one this file
 * asked wrongly until 2026-09-24: it asked `needsMultilingualVoice`, which is a
 * *share*, so a mostly-English message quoting one Hebrew word was left with Polly and
 * the word was dropped in silence — the exact failure every comment here is about, at
 * the one share where nobody was looking. A single Hebrew letter is enough to rule out
 * a synthesiser that has no Hebrew at all.
 */
export function hasHebrew(text) {
  return hebrewShare(text) > 0;
}

/**
 * Is this message Hebrew enough to be read *in* a Hebrew voice?
 *
 * Still a share, and still ten per cent: at that point this is a Hebrew message that
 * quotes some code, and Hila reading the whole thing is right. Below it, it is an
 * English message quoting a word or two, and the right answer is an English voice that
 * hands those words to Hila — which is what `ssmlFor` in azure-speech.js does.
 *
 * `realtime.js` asks this too, for a different reason and with the same threshold: it
 * decides whether to tell a spoken conversation to be held in Hebrew, and one quoted
 * word is not a reason to conduct the whole conversation in it.
 */
export function needsMultilingualVoice(text) {
  return hebrewShare(text) >= HEBREW_SHARE;
}

/**
 * How many lines of a block are read before the voice stops and says how many are
 * left. A 300-line file pasted into a message is not something anyone listens to,
 * and it is billed per character.
 */
export const CODE_LINES = Number(process.env.SPEAK_CODE_LINES || 40);

/** Tags people actually write on a fence, spoken as the language's name. */
const CODE_LANGUAGES = {
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  javascript: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript', typescript: 'TypeScript',
  py: 'Python', python: 'Python', rb: 'Ruby', go: 'Go', rs: 'Rust', java: 'Java',
  c: 'C', h: 'C', cpp: 'C plus plus', cs: 'C sharp', php: 'PHP', swift: 'Swift',
  kt: 'Kotlin', sh: 'shell', bash: 'shell', zsh: 'shell', console: 'shell',
  shell: 'shell', json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML',
  html: 'HTML', css: 'CSS', scss: 'CSS', sql: 'SQL', md: 'markdown',
  markdown: 'markdown', diff: 'diff', patch: 'diff', xml: 'XML', ini: 'config',
  env: 'config', dockerfile: 'Dockerfile', text: '', txt: '', '': '',
};

/**
 * Operators, in words, longest first.
 *
 * This list is the reason this function exists. A synthesiser does not mispronounce
 * punctuation — it says nothing at all for it — so `if (!ok) return` read literally
 * is "if ok return", which is the opposite of the code, and `a !== b` is "a b".
 * That is the same failure as Polly and Hebrew: not a wrong noise, a silent change
 * of meaning. The ones that alter what a line *does* are spoken; the ones that only
 * group it (braces, parens, semicolons) are left to become pauses, because "open
 * brace" on every line is how a listener stops listening.
 *
 * The single-character operators are only spoken when they are spaced, which is how
 * they are written in an expression and is not how they appear in `<div>`, `a/b/c`
 * or `-flag`. Sequential replacement is safe: every replacement is made of letters,
 * so no later pattern can match what an earlier one produced.
 */
const CODE_OPERATORS = [
  [/=>/g, ' arrow '],
  [/===/g, ' strictly equals '],
  [/!==/g, ' strictly not equals '],
  [/==/g, ' equals '],
  [/!=/g, ' not equals '],
  [/<=/g, ' less than or equal to '],
  [/>=/g, ' greater than or equal to '],
  [/&&/g, ' and '],
  [/\|\|/g, ' or '],
  [/\?\?/g, ' or else '],
  [/\+\+/g, ' plus plus '],
  [/--(?=\s|$)/g, ' minus minus '],
  [/\.\.\./g, ' spread '],
  [/->/g, ' arrow '],
  // `!ok`, `!isReady` — a negation directly on a word or a bracket.
  [/!(?=[A-Za-z_$(])/g, ' not '],
  [/ = /g, ' equals '],
  [/ < /g, ' less than '],
  [/ > /g, ' greater than '],
  [/ \+ /g, ' plus '],
  [/ \* /g, ' times '],
  [/ % /g, ' modulo '],
  [/ \| /g, ' piped to '],
];

/** One line of code, as words. */
function lineAloud(line, { diff = false } = {}) {
  let text = String(line).replace(/\t/g, '  ');

  /*
   * A diff's first column is the whole message. Read without it, "return null" and
   * "return null" are the same sentence and the change has vanished — so it is said
   * in words, and said first, before anything else reorders the line.
   */
  let prefix = '';
  if (diff && /^[+-]/.test(text) && !/^(\+\+\+|---)/.test(text)) {
    prefix = text.startsWith('+') ? 'added, ' : 'removed, ';
    text = text.slice(1);
  } else if (diff && /^(\+\+\+|---|@@)/.test(text)) {
    // File headers and hunk markers are noise to a listener; the file name is
    // already in the message around the block.
    return '';
  }

  // Underscores join words that are meant to be heard as words: SPEAK_DAILY_CHARS
  // is three of them, not one unpronounceable token.
  text = text.replace(/([A-Za-z0-9])_(?=[A-Za-z0-9])/g, '$1 ');

  for (const [pattern, word] of CODE_OPERATORS) text = text.replace(pattern, word);

  // Quotes are silent anyway, and what is inside them is usually the readable part
  // of the line. Structural punctuation becomes space, which becomes a pause.
  text = text.replace(/[`"']/g, ' ');
  text = text.replace(/[{}[\]();]/g, ' ');

  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return prefix + text;
}

/**
 * A code block, as something that can be listened to.
 *
 * The alternative, and what both surfaces do today, is to say "Code block." and move
 * on — which is right for a summary being heard on a walk, and wrong in the one case
 * the person asked for: when the code *is* the message and they want to hear it
 * rather than stop and read it. So this is a mode, not a replacement.
 *
 * What it does not try to be is dictation of source: nobody can reconstruct a file
 * from hearing it, and a voice that says "open brace close paren semicolon" makes
 * that failure louder rather than fixing it. It aims at the thing a listener can
 * actually use — which identifiers, which calls, what is compared with what, and
 * which way round a negation goes — and says how many lines it did not read.
 */
export function codeAloud(code, { lang = '', maxLines = CODE_LINES } = {}) {
  const raw = String(code == null ? '' : code);

  // The caller may hand over the whole fenced block, fence and language tag and all,
  // because that is what it has: the text of the element the button is attached to.
  let language = String(lang || '').trim();
  const fenced = /^\s*(?:```|~~~)([^\n]*)\n([\s\S]*?)(?:```|~~~)\s*$/.exec(raw);
  const open = /^\s*(?:```|~~~)([^\n]*)\n([\s\S]*)$/.exec(raw);
  const match = fenced || open;
  let body = raw;
  if (match) {
    language = language || match[1].trim().split(/\s+/)[0];
    body = match[2];
  }

  const lines = body.split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length) return 'That code block is empty.';

  const tag = language.toLowerCase().replace(/^\./, '');
  const name = tag in CODE_LANGUAGES ? CODE_LANGUAGES[tag] : /^[a-z+#]{1,12}$/.test(tag) ? tag : '';
  const diff = name === 'diff';

  const shown = lines.slice(0, Math.max(1, maxLines));
  const spoken = [];
  for (const line of shown) {
    const said = lineAloud(line, { diff });
    if (!said) continue;
    /*
     * A line that ends where an expression does gets a full stop; one that is
     * plainly continued gets a comma. Both are pacing — the stop is what keeps two
     * statements from running together into a sentence that says neither.
     */
    const open_ = /[,(+\-=&|?:]$|\b(and|or|equals|arrow|plus|times)$/.test(said);
    spoken.push(/[.!?]$/.test(said) ? said : `${said}${open_ ? ',' : '.'}`);
  }

  const count = lines.length;
  const header = `${name ? `${name} ` : ''}code, ${count === 1 ? 'one line' : `${count} lines`}.`;
  const rest = count - shown.length;
  const tail = rest > 0
    ? ` That is the first ${shown.length} lines; the other ${rest} are on screen.`
    : '';

  // Every line being unreadable — a block of nothing but braces — is still worth an
  // honest answer rather than a header followed by silence.
  if (!spoken.length) return `${header} There is nothing in it that can be read aloud.`;

  return `${header} ${spoken.join(' ')}${tail}`.replace(/\s+/g, ' ').trim();
}

/**
 * A silent WAV, served from this origin, for the tap to unlock the audio element
 * with. 44 bytes: a header describing zero samples.
 *
 * It has to come from the server rather than from a `data:` URL in the overlay,
 * which is what it was at first. The overlay runs inside code-server's workbench,
 * and that page carries code-server's own Content-Security-Policy — which says
 * `media-src 'self'`. A `data:` URL is not `'self'`, so the unlock was blocked and
 * the silent play never happened; on iOS that is the whole feature, because an
 * element that was not played inside the gesture may not be played afterwards.
 *
 * The same rule is why segment audio is played from `/api/speak` directly instead
 * of from a `blob:` URL. See the audio section of pwa/mobile-overlay.js.
 */
export const SILENT_WAV = Buffer.from(
  'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=',
  'base64',
);

/** A refusal with an HTTP status on it, so the route can answer honestly. */
export class SpeakError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'SpeakError';
    this.status = status;
  }
}

/**
 * Sentences, by scanning.
 *
 * A deliberate twin of `splitSentences` in `pwa/mobile-overlay.js` rather than a
 * shared module: that file is injected raw into code-server's HTML and imports
 * nothing, so there is no module either end could hold in common. The two also
 * answer different questions — that one sizes utterances for a synthesiser in the
 * page, this one decides what gets billed and where the voice may take a breath.
 */
function splitSentences(text) {
  const out = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if ('.!?'.indexOf(text[i]) === -1) continue;
    let end = i;
    // Take a run of terminators together ("Really?!"), and only break where
    // whitespace follows — "3.5" and "auth.js" are not sentence ends.
    while (end + 1 < text.length && '.!?'.indexOf(text[end + 1]) !== -1) end += 1;
    if (end + 1 < text.length && !/\s/.test(text[end + 1])) {
      i = end;
      continue;
    }
    out.push(text.slice(start, end + 1));
    start = end + 1;
    i = end;
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/**
 * Cut a message into the pieces that get synthesised, first one short.
 *
 * Boundaries land at sentence ends wherever possible, because that is where a
 * reader would pause anyway — a piece that ends mid-clause is audible as a
 * stumble, and the seam is the one thing a listener can hear about this design. A
 * single sentence longer than the limit is split on words rather than left to grow,
 * since a 900-character "sentence" is usually a line of prose with no full stop in
 * it and still has to be said.
 */
export function splitSegments(text) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];

  const segments = [];
  let current = '';
  // The first piece is the one someone is waiting on; the rest are being built
  // while the previous piece plays, so they can be long.
  const limit = () => (segments.length === 0 ? FIRST_SEGMENT_CHARS : SEGMENT_CHARS);
  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) segments.push(trimmed);
    current = '';
  };

  for (const sentence of splitSentences(clean).map((s) => s.trim()).filter(Boolean)) {
    if (sentence.length > limit()) {
      flush();
      for (const word of sentence.split(' ')) {
        if (current && current.length + word.length + 1 > limit()) flush();
        current += (current ? ' ' : '') + word;
      }
      flush();
      continue;
    }
    if (current && current.length + sentence.length + 1 > limit()) flush();
    current += (current ? ' ' : '') + sentence;
  }
  flush();
  return segments;
}

/**
 * Which audio this is, exactly: same provider, engine, voice and words means the
 * same bytes.
 *
 * The provider is in the hash even though no two engine names currently collide
 * across the two of them, because the id is what `/api/speak` is asked for by
 * number and the one thing it must never do is hand back audio in a voice the
 * caller did not ask for.
 */
export function messageId(text, voice, engine, provider = 'polly') {
  return createHash('sha256')
    .update(`${provider}\n${engine}\n${voice}\n${text}`)
    .digest('hex')
    .slice(0, 32);
}

/** UTC, so the budget resets at a time that does not depend on the box's zone. */
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Prepared messages, their audio, and what the day has cost so far.
 *
 * Takes its synthesiser as an argument so the refusals — the budget, an unknown
 * id, a segment that does not exist, a synthesiser that fails — can be tested
 * without an AWS account and without spending anything. `speak-test.js` does
 * exactly that; the Polly wiring below is the only part that needs credentials.
 */
export class VoiceCache {
  constructor({
    synthesize,
    dailyChars = DAILY_CHARS,
    ttlMs = TTL_MS,
    maxMessages = MAX_MESSAGES,
    maxChars = MAX_CHARS,
    now = Date.now,
  } = {}) {
    this.synthesize = synthesize;
    // A number is every provider's allowance; an object is one each. The number
    // form is what the tests use and what a single-provider deployment wants, and
    // it must keep meaning what it always meant.
    this.dailyChars = dailyChars;
    this.ttlMs = ttlMs;
    this.maxMessages = maxMessages;
    this.maxChars = maxChars;
    this.now = now;
    this.messages = new Map();
    // Per provider, because they are priced differently — see OPENAI_DAILY_CHARS.
    this.spent = { day: dayOf(now()), chars: {} };
  }

  /** What one provider is allowed to spend in a day. */
  limitFor(provider) {
    if (typeof this.dailyChars === 'number') return this.dailyChars;
    const found = this.dailyChars?.[provider];
    return typeof found === 'number' ? found : 0;
  }

  /** Drop what nobody is listening to any more. */
  sweep() {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, entry] of this.messages) {
      if (entry.at < cutoff) this.messages.delete(id);
    }
    // Oldest first: the Map keeps insertion order, and `prepare` re-stamps an
    // entry it finds again, so the one evicted is the one least recently asked for.
    while (this.messages.size > this.maxMessages) {
      const oldest = [...this.messages.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!oldest) break;
      this.messages.delete(oldest[0]);
    }
  }

  /**
   * Register a message and say how many pieces it is. Synthesises nothing, so it
   * costs nothing — the client can do this the moment a message appears on screen,
   * long before anybody taps Read aloud.
   */
  prepare(text, voice, engine, provider = 'polly') {
    const body = String(text ?? '').trim();
    if (!body) throw new SpeakError('there is nothing to read', 400);
    if (body.length > this.maxChars) {
      throw new SpeakError(
        `that is ${body.length} characters; ${this.maxChars} is the most this will read aloud`,
        413,
      );
    }

    const id = messageId(body, voice, engine, provider);
    const found = this.messages.get(id);
    if (found) {
      // Asked for again, so it is the one to keep when something has to go.
      found.at = this.now();
      this.sweep();
      return {
        id, voice, engine, provider, segments: found.segments.length, chars: body.length,
      };
    }

    const segments = splitSegments(body);
    if (!segments.length) throw new SpeakError('there is nothing to read', 400);
    this.messages.set(id, {
      id, voice, engine, provider, segments, audio: new Map(), at: this.now(),
    });
    this.sweep();
    return { id, voice, engine, provider, segments: segments.length, chars: body.length };
  }

  /**
   * What today has cost one provider, and what it is allowed to cost.
   *
   * Defaults to Polly because that is the voice a deployment has without signing up
   * for anything, so it is the budget a caller asking no particular question means.
   */
  budget(provider = 'polly') {
    if (this.spent.day !== dayOf(this.now())) this.spent = { day: dayOf(this.now()), chars: {} };
    return {
      provider,
      day: this.spent.day,
      chars: this.spent.chars[provider] || 0,
      limit: this.limitFor(provider),
    };
  }

  /**
   * The audio for one piece, synthesising it if this is the first ask.
   *
   * A 404 here is a normal thing for a client to meet — the service restarts, or
   * the message aged out while a phone was in a pocket — so it is worth being
   * specific about: the caller's answer is to prepare the same text again, which
   * costs nothing, and read on.
   */
  async audio(id, index) {
    this.sweep();
    const entry = this.messages.get(id);
    if (!entry) throw new SpeakError('that message is no longer prepared', 404);
    const position = Number(index);
    if (!Number.isInteger(position) || position < 0 || position >= entry.segments.length) {
      throw new SpeakError(`this message has ${entry.segments.length} pieces, not ${index}`, 404);
    }

    const already = entry.audio.get(position);
    entry.at = this.now();
    if (already) return { audio: already, cached: true, chars: 0 };

    const text = entry.segments[position];
    const provider = entry.provider || 'polly';
    const budget = this.budget(provider);
    if (budget.chars + text.length > budget.limit) {
      throw new SpeakError(
        `the ${provider} voice has read ${budget.chars} characters today and the daily ` +
          `limit is ${budget.limit} — it resets at midnight UTC, or raise ` +
          `${DAILY_KNOBS[provider] || DAILY_KNOBS.polly}` +
          // Only the free provider has somewhere to go that is not "wait": Azure's
          // ration is of a free month, and Polly is a tap away in the picker.
          (provider === 'azure' ? ', or pick a Polly voice in the picker' : ''),
        429,
      );
    }

    const audio = await this.synthesize(text, entry.voice, entry.engine, provider);
    if (!audio || !audio.length) throw new SpeakError('the voice returned no audio', 502);
    // Counted after the fact: a failed call is not billed, so it must not be
    // charged against the budget either.
    this.spent.chars[provider] = budget.chars + text.length;
    entry.audio.set(position, audio);
    return { audio, cached: false, chars: text.length, provider };
  }
}

// --------------------------------------------------------------------- Polly
let polly = null;
const client = () => {
  if (!polly) polly = new PollyClient({ region: REGION });
  return polly;
};

/**
 * One piece of audio, as mp3 bytes.
 *
 * The stream is collected rather than piped to the response, deliberately. Piping
 * would put the first word in the listener's ear ~150ms after the tap instead of
 * ~2s, and it is the first thing to reach for — but a response with no
 * Content-Length is exactly what iOS Safari is unreliable about playing, and this
 * feature exists for a phone. A complete piece is an ordinary media file that any
 * browser will play, and the short first segment is what buys back most of the
 * latency. If this is ever revisited, revisit it with an iPhone in hand.
 */
async function pollySynthesize(text, voice, engine) {
  try {
    const out = await client().send(
      new SynthesizeSpeechCommand({
        Engine: engine,
        VoiceId: voice,
        OutputFormat: 'mp3',
        Text: text,
        TextType: 'text',
      }),
      { abortSignal: AbortSignal.timeout(SYNTH_TIMEOUT_MS) },
    );
    const chunks = [];
    for await (const chunk of out.AudioStream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  } catch (err) {
    throw pollyRefusal(err, voice, engine);
  }
}

/**
 * Say what went wrong in a sentence an operator can act on.
 *
 * Every one of these has been made to happen at least once while building this,
 * and the raw SDK message for the first two says nothing about what to do.
 */
function pollyRefusal(err, voice, engine) {
  const text = `${err?.name || ''} ${err?.message || ''}`;
  if (/AccessDenied|not authorized|UnrecognizedClient|CredentialsProviderError/i.test(text)) {
    return new SpeakError(
      "this instance's role cannot call polly:SynthesizeSpeech — add it to the " +
        'instance role in infra/lib/stack.js and deploy the stack',
      403,
    );
  }
  if (/ValidationException|InvalidParameter|EngineNotSupported/i.test(text)) {
    return new SpeakError(
      `Polly refused ${voice} on the ${engine} engine in ${REGION} ` +
        `(${err?.message || 'no reason given'}) — try SPEAK_ENGINE=neural`,
      400,
    );
  }
  if (/Throttling|TooManyRequests|LimitExceeded/i.test(text)) {
    return new SpeakError('Polly is throttling this account — try again in a moment', 503);
  }
  if (/Abort|TimeoutError|timed out/i.test(text)) {
    return new SpeakError(`the voice took longer than ${SYNTH_TIMEOUT_MS}ms to answer`, 504);
  }
  return new SpeakError(`the voice failed: ${err?.message || 'unknown error'}`, 502);
}

// -------------------------------------------------------------------- OpenAI
/**
 * One piece of audio from OpenAI, also as mp3 bytes.
 *
 * mp3 rather than the `wav` or `pcm` the docs recommend for latency, for the same
 * reason Polly's answer is collected rather than piped: what reaches the phone has
 * to be a complete file with a `Content-Length` on it, because that is what iOS
 * Safari will reliably play. Streaming the synthesis would save a fraction of a
 * second and cost the feature its only platform.
 *
 * `instructions` is sent only to the models that accept it. `tts-1` answers 400
 * rather than ignoring an unknown field, so a deployment that has set
 * `SPEAK_OPENAI_MODEL=tts-1` to save money would otherwise get no audio at all.
 */
async function openAiSynthesize(text, voice, model) {
  const key = await openAiKey();
  if (!key) {
    throw new SpeakError(
      'there is no OpenAI key on this box, so this voice cannot speak — put one in ' +
        'the `openaiApiKey` field of the voice secret and call ' +
        '/api/voice-status?refresh=1',
      503,
    );
  }

  const body = {
    model,
    voice,
    input: text,
    response_format: 'mp3',
  };
  // The steering parameter is what makes this model worth preferring; see
  // OPENAI_INSTRUCTIONS. Anything older than the `gpt-` speech models rejects it.
  if (/^gpt-/.test(model) && OPENAI_INSTRUCTIONS) body.instructions = OPENAI_INSTRUCTIONS;

  let res;
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SYNTH_TIMEOUT_MS),
    });
  } catch (err) {
    if (/abort|timeout/i.test(`${err?.name} ${err?.message}`)) {
      throw new SpeakError(`the voice took longer than ${SYNTH_TIMEOUT_MS}ms to answer`, 504);
    }
    throw new SpeakError(`could not reach OpenAI: ${err?.message || 'unknown error'}`, 502);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    // The status is remapped rather than passed through, because these travel to a
    // phone whose only decision is "fall back to the browser's voice or not", and
    // a 401 from OpenAI is not a 401 from this service — that would read as a
    // session that had expired and send the client to the login page.
    const status = res.status === 429 ? 429 : res.status >= 500 ? 502 : 403;
    throw new SpeakError(openAiRefusal(res.status, detail), status);
  }

  return Buffer.from(await res.arrayBuffer());
}

/**
 * The one synthesiser the cache is given, dispatching on the voice's provider.
 *
 * The cache itself knows nothing about either service — it holds pieces, counts
 * characters and refuses — which is what keeps `speak-test.js` able to check every
 * refusal against a fake that costs nothing.
 */
function synthesize(text, voice, engine, provider) {
  if (provider === 'openai') return openAiSynthesize(text, voice, engine);
  if (provider === 'azure') return azureSynthesize(text, engine);
  return pollySynthesize(text, voice, engine);
}

/**
 * Azure's half, with its refusals given the type the routes answer from.
 *
 * `engine` carries the full Azure voice name — `he-IL-HilaNeural` — because the bare
 * id is what a picker shows and what a phone remembers, and the long name is what the
 * wire wants. It is also part of the cache id, so a change of voice cannot be served
 * yesterday's audio.
 */
async function azureSynthesize(text, voiceName) {
  try {
    return await speakAzure(text, voiceName);
  } catch (err) {
    throw new SpeakError(err.message, err.status || 502);
  }
}

const cache = new VoiceCache({
  synthesize,
  dailyChars: { polly: DAILY_CHARS, openai: OPENAI_DAILY_CHARS, azure: AZURE_DAILY_CHARS },
});

/**
 * Which voices this account will actually give us, asked once.
 *
 * DescribeVoices is free and it is the only way to know whether the generative
 * engine exists in this region and whether this role may use it at all — which is
 * also why it doubles as the availability probe for `/api/voice-status`. Cached for
 * the life of the process, including the failure: a deployment without the
 * permission must not re-ask on every status poll.
 */
let probed = null;
async function describeVoices() {
  if (probed) return probed;
  try {
    const out = await client().send(new DescribeVoicesCommand({ Engine: ENGINE }), {
      abortSignal: AbortSignal.timeout(8000),
    });
    const voices = (out.Voices || []).map((v) => ({
      id: v.Id,
      gender: v.Gender,
      language: v.LanguageCode,
      name: v.Name,
    }));
    probed = { voices, reason: null };
  } catch (err) {
    probed = { voices: [], reason: pollyRefusal(err, POLLY_VOICE, ENGINE).message };
  }
  return probed;
}

/**
 * Every voice this deployment is willing to use, from both providers.
 *
 * The OpenAI half is offered only when there is a key, because a picker that lists
 * a voice which then fails on the tap is worse than one that lists fewer. Polly's
 * half is whatever `DescribeVoices` said, or the assumed list when this role may not
 * ask.
 *
 * The de-duplication is the invariant the header promises: ids are bare, so two
 * providers must never claim the same name. Polly wins where they would, because a
 * Polly voice is the one a deployment has without a key — losing an OpenAI voice to
 * a collision costs a choice, losing a Polly one could cost a deployment its only
 * voice. Nothing collides today; this is here so that the day one does, the id stays
 * unambiguous instead of resolving to whichever list was searched first.
 */
async function knownVoices() {
  /*
   * The assumed Polly list only where there is nothing else to read with.
   *
   * A box that has never had AWS — a host install on another cloud — fails the probe
   * for good, and assuming Polly anyway made `Ruth` the default there: every read
   * without a voice named, and every phone that still remembered Ruth, was sent to
   * Polly and refused with a 403, while a working OpenAI key sat unused beside it.
   * With another provider configured, a Polly the probe could not reach is a Polly
   * this box does not have. Alone, the assumed list stays, because its refusal names
   * the permission to grant, which is the useful answer on an AWS box.
   */
  const probe = await describeVoices();
  const others = (await azureSpeechConfigured()) || Boolean(await openAiKey());
  const pollyList = probe.voices.length ? probe.voices : (others ? [] : FALLBACK_VOICES);
  const polly = pollyList.map((v) => ({
    ...v,
    provider: 'polly',
    engine: ENGINE,
  }));
  const taken = new Set(polly.map((v) => v.id.toLowerCase()));
  const out = [...polly];

  // Azure before OpenAI, because its Hebrew is free and OpenAI's is not: when both
  // are configured and a message needs a Hebrew voice, the one picked below is the
  // first in this list that can speak it.
  if (await azureSpeechConfigured()) {
    for (const voice of AZURE_VOICES) {
      if (taken.has(voice.id.toLowerCase())) continue;
      taken.add(voice.id.toLowerCase());
      // The long Azure name travels as the engine; see azureSynthesize.
      out.push({ ...voice, engine: voice.name });
    }
  }

  if (await openAiKey()) {
    for (const voice of OPENAI_VOICES) {
      if (taken.has(voice.id.toLowerCase())) continue;
      taken.add(voice.id.toLowerCase());
      out.push({ ...voice, engine: OPENAI_MODEL });
    }
  }

  return out;
}

/**
 * Can this voice say a Hebrew sentence without dropping it?
 *
 * Two ways to qualify, and they are different in kind. An Azure `he-IL` voice is a
 * Hebrew voice — that is all it is. An OpenAI voice is multilingual and reads whatever
 * it is given, which is why its `language` is `multi` rather than a locale. Polly has
 * neither, in any voice, in any region, at any price.
 */
export function speaksHebrew(voice) {
  if (!voice) return false;
  if (voice.provider === 'openai') return true;
  return String(voice.language || '').toLowerCase().startsWith('he');
}

/**
 * Will this voice get the Hebrew *in* a message said, one way or another?
 *
 * A different question from `speaksHebrew`, and the distinction is the whole of the
 * 2026-09-24 fix. `Ava` is not a Hebrew voice — she reads Hebrew with an American
 * accent, and asked for a short Hebrew run on her own she returns silence — but a
 * segment handed to an Azure voice is cut into runs of script by `ssmlFor`, and the
 * Hebrew runs in it are read by `Hila`. So *any* Azure voice says the Hebrew in a
 * mixed message, whichever of the four it is; an OpenAI voice says it because it is
 * multilingual; and no Polly voice says it at all, at any price, in any region.
 *
 * This is what decides whether a message with one Hebrew word in it may be read by the
 * voice that was asked for, so it is deliberately a property of the *provider* rather
 * than of the locale on the record.
 */
export function readsHebrew(voice) {
  if (!voice) return false;
  return voice.provider === 'azure' || voice.provider === 'openai';
}

/**
 * The voice for a caller who asked for nothing, which is most of them.
 *
 * A pure function over the list for the same reason `chooseVoice` is one: this is
 * where "what does read-aloud cost by default" is decided, and it should be checkable
 * without an AWS account, a key or a network.
 *
 * The order, and why:
 *
 *  1. **`SPEAK_VOICE`, if it is set and the box has it.** An operator who names a
 *     voice has said something more specific than any rule here.
 *  2. **An Azure English voice.** Free until the month's half-million characters are
 *     gone, then a 429 — the only arrangement that cannot produce an invoice. English
 *     rather than any Azure voice, because Hila would read an English message with a
 *     Hebrew accent; a Hebrew message is moved by `chooseVoice` below, which is a
 *     separate decision made from the text.
 *  3. **Polly.** What this read with before there was anything free, what a box with
 *     no Azure credentials still reads with, and never worse than the device's own.
 *
 * A `SPEAK_VOICE` naming a voice this box does not have falls through rather than
 * failing: it is a preference, not an assertion, and the deployment it is most likely
 * to be wrong on is one where the credentials for its provider have been removed.
 */
export function preferredVoice(known) {
  const byName = (name) => known.find((v) => v.id.toLowerCase() === String(name).toLowerCase());
  const free = known.find(
    (v) => v.provider === 'azure' && /^en/i.test(String(v.language || '')),
  );
  return (SPEAK_VOICE ? byName(SPEAK_VOICE) : null) || free || byName(POLLY_VOICE) || byName(OPENAI_VOICE);
}

/**
 * The voice to use, as a whole record: which provider, which engine, which name.
 *
 * Three things happen here, and the order matters.
 *
 * An unknown name is not an error — a phone that remembers a voice this deployment
 * no longer offers, or an OpenAI voice on a box whose key has been removed, should
 * still be read to in the default voice and told which one it got.
 *
 * **Any Hebrew at all overrides the choice, and how far it moves depends on how much.**
 * Polly has no Hebrew voice and the failure mode is not a bad accent but silence: the
 * characters are skipped and a listener has no way to tell that a line of the message
 * never got said. So two separate moves, from two separate questions:
 *
 *  - **A Hebrew message** — ten per cent of its letters or more — is read *in* a Hebrew
 *    voice. That is `needsMultilingualVoice`, and it is unchanged.
 *  - **An English message with Hebrew in it** — one quoted word, a filename, a column
 *    heading — keeps an English voice, but it has to be one whose provider will say the
 *    quoted word rather than skip it: any Azure voice (`ssmlFor` reads the Hebrew runs
 *    of a segment in Hila) or any OpenAI one. This is the case that was silently broken
 *    until 2026-09-24, because the share decided *everything* and one Hebrew word is
 *    nowhere near ten per cent of a paragraph. It is also the common case: it is what a
 *    bilingual reply looks like.
 *
 * Either way the answer says which voice actually spoke, the same way an unknown name
 * does, and **if nothing on the box can say Hebrew it refuses** rather than reading the
 * message with the Hebrew missing. A refusal is the useful answer here: every client
 * falls back to `speechSynthesis`, and a phone's own voice *does* speak Hebrew — iOS and
 * Android both ship one — so refusing gets the message read, and pretending would not.
 */
export function chooseVoice(requested, text, known) {
  const wanted = String(requested || '').trim();
  const byName = (name) => known.find((v) => v.id.toLowerCase() === String(name).toLowerCase());

  let chosen = byName(wanted) || preferredVoice(known) || known[0];

  // Two thresholds, so the two moves stay separate: a Hebrew message needs a voice that
  // *is* Hebrew, and an English message with Hebrew in it needs one that will not drop
  // it. Collapsing them would send a Hebrew message to Ava, whose Hebrew is accented
  // where Hila's is native, and leave the routing this fix is about doing nothing.
  const inHebrew = needsMultilingualVoice(text);
  const wrongVoice = inHebrew
    ? !speaksHebrew(chosen)
    : hasHebrew(text) && !readsHebrew(chosen);

  if (wrongVoice) {
    // In order: the Hebrew voice this deployment prefers, any Hebrew voice, any
    // multilingual one. `known` is already ordered Azure before OpenAI, so a box with
    // both reads Hebrew on the free tier without being told to.
    const hebrew =
      known.find((v) => speaksHebrew(v) && v.id === AZURE_VOICE) ||
      known.find((v) => speaksHebrew(v) && v.provider === 'azure') ||
      byName(OPENAI_VOICE) ||
      known.find(speaksHebrew);
    // For a message that is mostly English, a Hebrew voice is the last resort rather
    // than the first: it would read the English half accented, and an Azure English
    // voice says both halves natively — the Hebrew runs in Hila, the rest in its own
    // voice. `preferredVoice` is asked rather than picking the first Azure record so
    // that an operator's `SPEAK_VOICE` still decides which English voice that is.
    const english = inHebrew
      ? null
      : [preferredVoice(known.filter(readsHebrew)), known.find(readsHebrew)].find(Boolean);
    const moved = english || hebrew;
    if (!moved) {
      throw new SpeakError(
        'there is Hebrew in this message and Polly has no Hebrew voice, so the box ' +
          'cannot read it — this device will use its own voice instead. To read ' +
          'Hebrew here, put `speechKey` and `speechRegion` for an Azure Speech ' +
          'resource (its free tier covers this) or an `openaiApiKey` in the voice ' +
          'secret, then call /api/voice-status?refresh=1',
        409,
      );
    }
    chosen = moved;
  }

  if (!chosen) {
    throw new SpeakError('this deployment has no voice configured to read with', 503);
  }
  return chosen;
}

/**
 * `chooseVoice` against the voices this box actually has.
 *
 * The two are split so that the choosing — which is where the Hebrew rule lives, and
 * the part that can get a message read in silence if it is wrong — is a pure
 * function over a list, checkable without a key, an AWS account or a network. What is
 * left here is only the lookup of the list itself.
 */
async function pickVoice(requested, text = '') {
  return chooseVoice(requested, text, await knownVoices());
}

/**
 * Register a message. Costs nothing; see `VoiceCache#prepare`.
 *
 * Asynchronous, unlike every other step of a read, because choosing the voice now
 * depends on whether this box has an OpenAI key — which lives in Secrets Manager.
 * It is read once and cached for the life of the process, so this is a real await
 * exactly once per restart.
 */
/**
 * A message, ready to be read, as pieces a phone can fetch.
 *
 * `kind: 'code'` is the per-block read: the text is one fenced block and it is turned
 * into listenable words here rather than replaced by "Code block". Doing it on the
 * server, not in the two clients, is what keeps the editor overlay and the chat app
 * saying the same thing — and the voice is chosen from the *spoken* text, which
 * matters because a Hebrew comment inside a code block is still Hebrew and Polly
 * would drop it without a sound.
 */
export async function prepare(text, { voice, kind = 'prose', lang = '' } = {}) {
  const spoken = kind === 'code' ? codeAloud(text, { lang }) : text;
  const chosen = await pickVoice(voice, spoken);
  return cache.prepare(spoken, chosen.id, chosen.engine, chosen.provider);
}

/** The audio for one piece of a prepared message. */
export function speakSegment(id, index) {
  return cache.audio(id, index);
}

/**
 * Can this box speak, in which voices, and what has it spent today.
 *
 * Answers `configured: false` with a reason rather than throwing, because the
 * client's response to every failure here is the same: keep the browser's voice.
 */
export async function speechStatus({
  lang = 'en',
  describe = describeVoices,
  hasOpenAi = async () => Boolean(await openAiKey()),
  hasAzure = azureSpeechConfigured,
} = {}) {
  const { voices, reason } = await describe();
  const openAiReady = await hasOpenAi();
  const azureReady = await hasAzure();

  const pollyVoices = voices.map((v) => ({ ...v, provider: 'polly', engine: ENGINE }));
  const taken = new Set(pollyVoices.map((v) => v.id.toLowerCase()));
  const azureVoices = azureReady
    ? AZURE_VOICES.filter((v) => !taken.has(v.id.toLowerCase())).map((v) => ({
        ...v,
        engine: v.name,
      }))
    : [];
  for (const v of azureVoices) taken.add(v.id.toLowerCase());
  const openAiVoices = openAiReady
    ? OPENAI_VOICES.filter((v) => !taken.has(v.id.toLowerCase())).map((v) => ({
        ...v,
        engine: OPENAI_MODEL,
      }))
    : [];
  // Azure ahead of OpenAI, matching `knownVoices`: both can read Hebrew and only one
  // of them is free, so the order is the preference.
  const all = [...pollyVoices, ...azureVoices, ...openAiVoices];
  const hebrewVoices = all.filter(speaksHebrew);

  const wanted = String(lang || 'en').slice(0, 5).toLowerCase();
  // Everything for this language, then everything else: a picker should offer the
  // voices that match the phone first without hiding the others. A multilingual
  // voice matches every language, which is what puts the OpenAI ones at the top for
  // a phone set to Hebrew and leaves them below the local ones for a phone set to
  // English.
  const matches = (v) => {
    const language = String(v.language || '').toLowerCase();
    return language === 'multi' || language.startsWith(wanted.slice(0, 2));
  };
  const ordered = [...all.filter(matches), ...all.filter((v) => !matches(v))];

  return {
    configured: ordered.length > 0,
    engine: ENGINE,
    /*
     * Which voice a phone that has never chosen will be read in — asked of the list
     * this answer is built from rather than of `knownVoices()`, so that what the
     * picker shows as the default is the default *for this answer*. The two lists can
     * differ: this one is injectable, which is what lets every ordering below be
     * checked without an AWS account or an Azure key.
     */
    voice: ordered.length ? (preferredVoice(ordered) || ordered[0]).id : null,
    voices: ordered,
    // `budget` is Polly's, unchanged, because that is what every existing client
    // reads. `budgets` is both, for a sheet that wants to show which voice has room
    // left — they are separate allowances (see OPENAI_DAILY_CHARS).
    budget: cache.budget('polly'),
    budgets: {
      polly: cache.budget('polly'),
      openai: cache.budget('openai'),
      azure: cache.budget('azure'),
    },
    firstSegmentChars: FIRST_SEGMENT_CHARS,
    /*
     * Whether this box can read Hebrew at all, stated separately from `configured`.
     *
     * A box with Polly and no OpenAI key is fully configured and still cannot say a
     * Hebrew word, so a client that only looked at `configured` would offer Read
     * aloud on a Hebrew message and get a 409. This is what lets it say why up front
     * instead — and the answer is not "unavailable" but "your own device will read
     * it", because `speechSynthesis` has a Hebrew voice on both phone platforms.
     */
    hebrew: {
      available: hebrewVoices.length > 0,
      // The same order `chooseVoice` uses, so what this advertises is what speaks.
      voice:
        hebrewVoices.find((v) => v.id === AZURE_VOICE)?.id ||
        hebrewVoices.find((v) => v.provider === 'azure')?.id ||
        hebrewVoices.find((v) => v.id === OPENAI_VOICE)?.id ||
        hebrewVoices[0]?.id ||
        null,
      via: hebrewVoices[0]?.provider || null,
      voices: hebrewVoices.map((v) => v.id),
      reason: hebrewVoices.length
        ? null
        : 'Polly has no Hebrew voice, and this box has neither Azure Speech ' +
          "credentials nor an OpenAI key — a Hebrew message is read by the device's " +
          'own voice instead',
    },
    reason: ordered.length ? null : reason,
  };
}

/**
 * Re-probe, and drop the cached audio.
 *
 * What `/api/voice-status?refresh=1` calls, so a newly granted Polly permission
 * takes effect without restarting the service. Deliberately does *not* reset the
 * day's spend: a caller who can reach that route could otherwise clear the budget
 * by polling it, which would leave the one guard against a runaway read
 * unenforceable.
 */
export function resetSpeech() {
  cache.messages.clear();
  probed = null;
  // The key too, so that putting one into the secret takes effect on the same
  // refresh that a newly granted Polly permission does. Without this the only way
  // to enable Hebrew would be to restart the service, which ends every live
  // conversation on the box.
  resetOpenAi();
}

export const speechEngine = ENGINE;
