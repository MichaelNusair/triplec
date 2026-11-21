/**
 * Which model hears you, checked without speaking to any of them.
 *
 * One branch in this file matters more than everything else in it: a request that
 * says it is not English must never reach the local model. `ggml-base.en.bin` given
 * Hebrew speech does not fail — it returns a fluent English sentence that nobody
 * said, and that sentence then lands in the box where a prompt is typed. There is no
 * status code, no warning and nothing in the logs. A refusal is strictly better, and
 * the only way to know a refusal is still there is to ask for one.
 *
 * The mirror of it matters nearly as much and is easier to break by accident: English
 * must keep going to the free local model. Dictation on this box has been free since
 * it was built, and "add a hosted backend" is one careless line away from routing
 * every existing English recording through a metered third party, which nobody would
 * notice until a bill or a privacy conversation.
 *
 * There is now a third thing to keep true, and it is the reason the passes multiplied:
 * **the free backend has to be the one that answers.** Azure AI Speech hears Hebrew on
 * a tier that cannot bill, and OpenAI hears it for money, so an order that looks
 * arbitrary in the code is the difference between a feature that costs nothing and one
 * that costs per minute. It is asserted as "OpenAI was not called at all", because any
 * weaker assertion passes when both are called and only one is used.
 *
 * It runs in four passes, in four processes, because which backends exist is decided
 * when the module is imported and a key cannot be un-imported: a box with nothing on
 * it, a box with OpenAI, a box with both (this deployment), and a box with only the
 * free recognizer — which is the one that has to refuse a webm recording by talking
 * about the recording rather than about a key someone would have to buy. Each is
 * spawned from here with `fetch` replaced. No whisper is run, no network is touched,
 * and no audio is transcribed by anyone.
 *
 * Run: node chat-service/transcribe-test.js
 */
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

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
 * Four boxes, four processes, because every backend's availability is decided once at
 * import and no amount of arranging inside one process can undo that.
 *
 *   `local`      — nothing installed at all. Refusals.
 *   `hosted`     — an OpenAI key and nothing else.
 *   `speech`     — Azure Speech *and* an OpenAI key, which is this deployment. The
 *                  interesting one: the free backend has to win.
 *   `speechonly` — Azure Speech and no key, where a recording it cannot take has to
 *                  produce a sentence about the recording rather than about money.
 */
const MODES = ['hosted', 'speech', 'speechonly'];
const MODE = MODES.includes(process.argv[2]) ? process.argv[2] : 'local';
const HAS_SPEECH = MODE === 'speech' || MODE === 'speechonly';

// Arranged before the import, because the paths and the secret ARN are read once at
// module load: no local binary, no Azure secret. The model's *name* is still the real
// one, because the refusal quotes it and the `.en` in it is the entire reason this
// routing exists — and in the hosted pass it is what English must still fall back to.
process.env.WHISPER_BIN = '/nonexistent/whisper-cli';
process.env.WHISPER_MODEL = '/nonexistent/models/ggml-base.en.bin';
delete process.env.WHISPER_SECRET_ARN;
delete process.env.OPENAI_SECRET_ARN;
if (MODE === 'local' || MODE === 'speechonly') delete process.env.OPENAI_API_KEY;

const FAKE_KEY = 'sk-test-not-a-real-key';

/**
 * OpenAI's transcription endpoint, without OpenAI. Records the form it was handed,
 * which is where the `language` field either is or is not.
 */
const api = { calls: [], reply: { status: 200, text: '  a sentence someone said \n' } };
const lastCall = () => api.calls[api.calls.length - 1];

/**
 * Azure AI Speech's recognizer, also without Azure. Answers on its own host so that
 * "which backend heard this" is a question about the recorded URL rather than about
 * the order the code happens to be written in.
 */
const azure = {
  calls: [],
  reply: { status: 200, body: { RecognitionStatus: 'Success', DisplayText: 'שלום עולם' } },
};
const speechCalls = () => api.calls.filter((c) => /stt\.speech\.microsoft\.com/.test(c.url));
const openAiCalls = () => api.calls.filter((c) => /api\.openai\.com/.test(c.url));

if (MODE !== 'local') {
  globalThis.fetch = async (url, init) => {
    const call = { url: String(url), init, form: init?.body };
    api.calls.push(call);
    if (/stt\.speech\.microsoft\.com/.test(call.url)) {
      azure.calls.push(call);
      const { status, body } = azure.reply;
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      };
    }
    return {
      ok: api.reply.status >= 200 && api.reply.status < 300,
      status: api.reply.status,
      text: async () => api.reply.text,
    };
  };
}

if (HAS_SPEECH) {
  process.env.AZURE_SPEECH_KEY = 'azure-test-not-a-real-key';
  process.env.AZURE_SPEECH_REGION = 'eastus';
} else {
  delete process.env.AZURE_SPEECH_KEY;
  delete process.env.AZURE_SPEECH_REGION;
}

const { transcribe, spokenLanguage, voiceStatus, audioFile } = await import('./transcribe.js');

/** A multipart body shaped like the one the mic button sends. */
const upload = (audio = Buffer.from('not really audio')) => {
  const boundary = '----triplectest';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="a.wav"\r\n` +
      'Content-Type: audio/wav\r\n\r\n',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    body: Buffer.concat([head, audio, tail]),
    type: `multipart/form-data; boundary=${boundary}`,
    bytes: audio.length,
  };
};

/**
 * A WAV whose header says how long it is. The routing reads these bytes, not the
 * filename in the multipart headers — which is the point: a client can call a webm
 * `recording.wav` and Azure will still answer 400.
 */
const wav = (seconds, byteRate = 1000) => {
  const data = Buffer.alloc(Math.round(seconds * byteRate));
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(byteRate / 2, 24);
  head.writeUInt32LE(byteRate, 28);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
};

/** What the chat PWA and the voice extension send when they cannot convert. */
const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2000)]);

const rejects = async (name, matching, fn) => {
  try {
    const got = await fn();
    ok(false, name, `nothing was refused; got ${JSON.stringify(got).slice(0, 120)}`);
  } catch (err) {
    ok(matching.test(err?.message || ''), name, `got: ${err?.message}`);
  }
};

if (MODE === 'local') {
  console.log('A box with no dictation backend installed:');

  // ------------------------------------------------------------------------
  section('What language a request is asking for:');
  {
    ok(
      spokenLanguage('').english && spokenLanguage('').code === 'en',
      'nothing means English, which is what every existing client sends',
    );
    ok(spokenLanguage(null).english, 'and so does a missing value');
    ok(spokenLanguage('en').english && spokenLanguage('en-US').english, 'en and en-US are English');
    ok(spokenLanguage('EN-GB').english, 'and the case it arrives in does not matter');

    const he = spokenLanguage('he-IL');
    ok(!he.english && he.code === 'he', 'he-IL is Hebrew, reduced to the two letters a model wants', JSON.stringify(he));
    ok(spokenLanguage('he').code === 'he', 'and so is a bare he');
    ok(
      !spokenLanguage('ru').english && !spokenLanguage('ar').english,
      'Hebrew is not special-cased: any other language routes the same way',
    );

    // A phone sending junk must not become a `language=` parameter that OpenAI 400s
    // on, and must not become a non-English route on a box that only has English.
    ok(spokenLanguage('; DROP TABLE').english, 'something that is not a language code is treated as English');
    ok(spokenLanguage('1234').english, 'and so is a number');
    ok(spokenLanguage('hebrew').code === 'he', 'a long name is cut to its prefix rather than rejected');
  }

  // ------------------------------------------------------------------------
  section('Hebrew is never given to the English-only model:');
  {
    const { body, type } = upload();

    await rejects('a Hebrew dictation with no hosted backend is refused', /hosted model/i, () =>
      transcribe(body, type, { lang: 'he-IL' }));
    await rejects('and the refusal names the model that would have lied to you', /ggml-base\.en\.bin/, () =>
      transcribe(body, type, { lang: 'he' }));
    await rejects('and says what it would have done: English nonsense, not an error', /English nonsense/i, () =>
      transcribe(body, type, { lang: 'he' }));
    await rejects('and says how to fix it', /openaiApiKey/, () => transcribe(body, type, { lang: 'he' }));
    await rejects('any other language is refused the same way', /hosted model/i, () =>
      transcribe(body, type, { lang: 'ru' }));

    await rejects('English gets the refusal it always got', /local whisper is not installed/, () =>
      transcribe(body, type, { lang: 'en' }));
    await rejects('and so does a request that names no language at all', /local whisper is not installed/, () =>
      transcribe(body, type));
  }

  {
    const { body } = upload();
    await rejects('a body that is not multipart is refused before any backend is chosen', /boundary/i, () =>
      transcribe(body, 'application/json', { lang: 'he' }));
    const noAudio = Buffer.from('--x\r\nContent-Disposition: form-data; name="notaudio"\r\n\r\nx\r\n--x--\r\n');
    await rejects('and so is one with no audio part in it', /no "audio" part/, () =>
      transcribe(noAudio, 'multipart/form-data; boundary=x', { lang: 'he' }));
  }

  // ------------------------------------------------------------------------
  section('What the phone is told before it offers a Hebrew mic:');
  {
    const status = await voiceStatus();

    ok(status.languages.english === false, 'a box with nothing installed cannot hear English either', JSON.stringify(status.languages));
    ok(status.languages.other === false, 'and certainly not another language');
    ok(status.languages.via === null, 'with no backend named');
    ok(/English-only/.test(status.languages.reason || ''), 'and a reason that says why', `got: ${status.languages.reason}`);
    ok(/ggml-base\.en\.bin/.test(status.languages.reason || ''), 'naming the model, so an operator can see it for themselves');
    ok(status.local.englishOnly === true, 'the local model is reported as English-only, read from its own filename');
    ok(status.openai.configured === false, 'and no OpenAI backend is claimed without a key');
    ok(
      status.backend === 'none' && status.configured === false,
      'the existing fields still say what they always said',
      JSON.stringify({ backend: status.backend, configured: status.configured }),
    );
  }
}

// Named rather than `else`, now that there is more than one box with a key: as an
// `else` this section also ran in the Azure passes, where its eight OpenAI calls and
// its 1 MB day are somebody else's arrangements.
if (MODE === 'hosted') {
  console.log('The same box, with an OpenAI key in the voice secret:');

  // ------------------------------------------------------------------------
  section('Hebrew, on a box that can hear it:');
  {
    const { body, type, bytes } = upload();
    const heard = await transcribe(body, type, { lang: 'he-IL' });
    ok(heard === 'a sentence someone said', 'what OpenAI heard comes back, trimmed', JSON.stringify(heard));

    const call = lastCall();
    ok(call.url === 'https://api.openai.com/v1/audio/transcriptions', 'sent to the transcription endpoint', call.url);
    ok(call.init.headers.Authorization === `Bearer ${FAKE_KEY}`, 'with the key, from the server, never the browser');
    ok(
      call.form.get('language') === 'he',
      'and told which language to expect, rather than left to detect it',
      String(call.form.get('language')),
    );
    ok(call.form.get('model') === 'gpt-transcribe', 'on a model that hears Hebrew', String(call.form.get('model')));
    ok(call.form.get('response_format') === 'text', 'asking for plain text, since that is all this is for');
    ok(call.form.get('file')?.size === bytes, 'with the audio attached whole', `${call.form.get('file')?.size} of ${bytes}`);
  }

  /*
   * OpenAI believes the filename: a WAV uploaded as `audio.webm` is a 400, "Audio file
   * might be corrupted or unsupported". That was every Hebrew dictation from the editor
   * overlay, which converts to WAV, once Azure Speech was not there to take it first.
   */
  section('Each upload goes out under the name its bytes call for:');
  {
    for (const [label, audio, name, type] of [
      ['a WAV, which is what the editor overlay sends', wav(2), 'audio.wav', 'audio/wav'],
      ['a webm, which is what an unconverted recording is', webm, 'audio.webm', 'audio/webm'],
    ]) {
      const { body, type: contentType } = upload(audio);
      await transcribe(body, contentType, { lang: 'he' });
      const file = lastCall().form.get('file');
      ok(file?.name === name && file?.type === type, label, `${file?.name} ${file?.type}`);
    }
    // Read from the bytes, not from the multipart filename, which says `a.wav` for both.
    ok(audioFile(Buffer.from('OggS\0\0\0\0\0\0\0\0')).name === 'audio.ogg', 'an Ogg recording is called one');
    ok(
      audioFile(Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A ')])).type === 'audio/mp4',
      "and Safari's MP4 is sent as MP4",
    );
    ok(audioFile(Buffer.from('ID3\x04\0\0\0\0\0\0\0\0', 'latin1')).name === 'audio.mp3', 'and an MP3 as an MP3');
    ok(audioFile(Buffer.from('not really audio')).name === 'audio.webm', 'and anything unrecognised as webm, as before');
  }

  /*
   * The expensive regression. English dictation worked on this box before any of this
   * existed, for free, without leaving it. A key being present must not change that.
   */
  section('English on the same box does not quietly start costing money:');
  {
    const { body, type } = upload();
    api.calls.length = 0;

    await rejects('English falls back to local, and refuses when local is missing', /local whisper is not installed/, () =>
      transcribe(body, type, { lang: 'en' }));
    await rejects('and so does a request with no language on it', /local whisper is not installed/, () =>
      transcribe(body, type));
    ok(api.calls.length === 0, 'and neither one was sent to OpenAI', `${api.calls.length} calls made`);
  }

  // ------------------------------------------------------------------------
  section('When OpenAI refuses:');
  {
    const { body, type } = upload();

    api.reply = { status: 401, text: JSON.stringify({ error: { message: 'Incorrect API key provided' } }) };
    await rejects('a rejected key names the field to fix and how to reload it', /openaiApiKey/, () =>
      transcribe(body, type, { lang: 'he' }));
    await rejects('and passes on what OpenAI actually said', /Incorrect API key/, () =>
      transcribe(body, type, { lang: 'he' }));

    api.reply = { status: 429, text: '{}' };
    await rejects('throttling or an empty account says which', /rate limiting|out of credit/i, () =>
      transcribe(body, type, { lang: 'he' }));

    api.reply = { status: 500, text: '{}' };
    await rejects('OpenAI failing says to try again', /try again/i, () => transcribe(body, type, { lang: 'he' }));

    // A blank transcript reaching the prompt box as a blank prompt is worse than an
    // error, because it looks like the microphone worked.
    api.reply = { status: 200, text: '   \n' };
    await rejects('silence is not an empty transcript', /no speech detected/, () =>
      transcribe(body, type, { lang: 'he' }));

    api.reply = { status: 200, text: 'ok' };
  }

  // ------------------------------------------------------------------------
  section('A day of uploaded audio:');
  {
    // The pass runs with TRANSCRIBE_OPENAI_DAILY_MB=1, so two of these cross it.
    const big = upload(Buffer.alloc(700_000, 7));
    ok((await transcribe(big.body, big.type, { lang: 'he' })) === 'ok', 'a long recording goes through');

    const before = api.calls.length;
    await rejects('the next one crosses the day’s megabytes', /TRANSCRIBE_OPENAI_DAILY_MB/, () =>
      transcribe(big.body, big.type, { lang: 'he' }));
    await rejects('and the refusal says when it resets', /midnight/i, () =>
      transcribe(big.body, big.type, { lang: 'he' }));
    ok(api.calls.length === before, 'refused before the upload, not after paying for it', `${api.calls.length - before} extra calls`);
  }

  // ------------------------------------------------------------------------
  section('What the phone is told when there is a key:');
  {
    const status = await voiceStatus();

    ok(status.languages.other === true, 'this box can hear a language other than English', JSON.stringify(status.languages));
    ok(status.languages.via === 'openai', 'and says which backend does it');
    ok(status.languages.reason === null, 'with nothing to apologise for');
    ok(status.openai.configured === true, 'the OpenAI backend is reported as configured');
    ok(status.openai.budget.limitMb === 1, 'along with the day’s allowance', JSON.stringify(status.openai.budget));
    ok(status.openai.budget.mb > 0, 'and what has been spent of it', JSON.stringify(status.openai.budget));
    ok(status.local.englishOnly === true, 'and the local model is still English-only, key or no key');

    // The status route is unauthenticated-adjacent and gets logged; the key is the
    // one thing in this module that must never appear in it.
    ok(!JSON.stringify(status).includes(FAKE_KEY), 'and the key itself is nowhere in the answer');
    ok(!JSON.stringify(status).includes('sk-'), 'not even a fragment of it');
  }
}

if (MODE === 'speech') {
  console.log('A box with the free Hebrew recognizer *and* a metered key — this deployment:');

  // ------------------------------------------------------------------------
  section('The free backend wins, which is the whole reason it is first:');
  {
    const { body, type } = upload(wav(3));
    const heard = await transcribe(body, type, { lang: 'he-IL' });

    ok(heard === 'שלום עולם', 'Hebrew comes back transcribed', JSON.stringify(heard));
    ok(speechCalls().length === 1, 'Azure Speech was asked');
    ok(
      openAiCalls().length === 0,
      'and OpenAI was not asked at all — the free one answered, so nothing was metered',
      JSON.stringify(api.calls.map((c) => c.url)),
    );
    ok(
      /language=he-IL/.test(speechCalls()[0].url),
      'the two letters were expanded to the locale Azure requires',
      speechCalls()[0].url,
    );
    ok(
      speechCalls()[0].init.headers['Ocp-Apim-Subscription-Key'] === 'azure-test-not-a-real-key',
      'with the Speech key, which is not the OpenAI key',
    );
  }

  // ------------------------------------------------------------------------
  section('English is still free and still local, key or no key:');
  {
    api.calls.length = 0;
    const { body, type } = upload(wav(3));

    await rejects(
      'English still refuses rather than reaching for a hosted backend',
      /local whisper is not installed/,
      () => transcribe(body, type, { lang: 'en' }),
    );
    ok(
      api.calls.length === 0,
      'and nothing was sent anywhere — not to Azure, not to OpenAI',
      JSON.stringify(api.calls.map((c) => c.url)),
    );
  }

  // ------------------------------------------------------------------------
  section('A recording the free one cannot take falls through, rather than failing:');
  {
    api.calls.length = 0;
    const raw = upload(webm);
    ok(
      (await transcribe(raw.body, raw.type, { lang: 'he' })) === 'a sentence someone said',
      'a webm recording is transcribed by OpenAI instead',
    );
    ok(
      speechCalls().length === 0,
      'Azure was not handed bytes it would have answered 400 to',
      JSON.stringify(api.calls.map((c) => c.url)),
    );
    ok(openAiCalls().length === 1, 'exactly one metered call, and only because it was needed');

    api.calls.length = 0;
    const long = upload(wav(80));
    await transcribe(long.body, long.type, { lang: 'he' });
    ok(
      speechCalls().length === 0 && openAiCalls().length === 1,
      'and so is a recording longer than the recognizer takes',
      JSON.stringify(api.calls.map((c) => c.url)),
    );
  }

  // ------------------------------------------------------------------------
  section("The free tier's month running out is not the end of dictation:");
  {
    api.calls.length = 0;
    azure.reply = { status: 429, body: 'quota' };
    const { body, type } = upload(wav(3));

    ok(
      (await transcribe(body, type, { lang: 'he' })) === 'a sentence someone said',
      'a 429 from Azure falls back to OpenAI rather than refusing',
    );
    ok(speechCalls().length === 1 && openAiCalls().length === 1, 'one of each, in that order');

    api.calls.length = 0;
    azure.reply = { status: 200, body: { RecognitionStatus: 'NoMatch' } };
    ok(
      (await transcribe(body, type, { lang: 'he' })) === 'a sentence someone said',
      'and so does silence, because a second opinion is cheap and being wrong is not',
    );

    azure.reply = { status: 200, body: { RecognitionStatus: 'Success', DisplayText: 'שלום עולם' } };
  }

  // ------------------------------------------------------------------------
  section('What the phone is told:');
  {
    const status = await voiceStatus();
    ok(status.languages.other === true, 'this box can hear another language');
    ok(
      status.languages.via === 'azure-speech',
      'and says the free backend is the one that will do it',
      JSON.stringify(status.languages),
    );
    ok(status.speech.configured === true, 'the Speech backend is reported separately');
    ok(/free/.test(status.speech.tier), 'with its tier, because that is the interesting part');
    ok(/WAV/.test(status.speech.wants), 'and what it will take, which is the other refusal');
    ok(
      !JSON.stringify(status).includes('azure-test-not-a-real-key'),
      'and neither key is anywhere in the answer',
    );
    ok(!JSON.stringify(status).includes(FAKE_KEY), 'including the OpenAI one');
  }
}

if (MODE === 'speechonly') {
  console.log('A box with the free Hebrew recognizer and no metered key at all:');

  // ------------------------------------------------------------------------
  section('Hebrew works, for free, with nothing else configured:');
  {
    const { body, type } = upload(wav(2));
    ok((await transcribe(body, type, { lang: 'he' })) === 'שלום עולם', 'Hebrew is transcribed');
    ok(speechCalls().length === 1 && openAiCalls().length === 0, 'by the free backend, alone');
  }

  // ------------------------------------------------------------------------
  section('And when it cannot, the refusal is about the recording, not about money:');
  {
    const raw = upload(webm);
    await rejects(
      'a webm recording says the format is the problem',
      /only from a WAV recording/,
      () => transcribe(raw.body, raw.type, { lang: 'he' }),
    );
    await rejects(
      'and names the surface that converts before uploading',
      /editor overlay/,
      () => transcribe(raw.body, raw.type, { lang: 'he' }),
    );
    /*
     * The one that would be easy to get wrong: with credentials present and working,
     * telling someone to go and buy an OpenAI key would be both wrong and expensive.
     * It may be *mentioned* as the way to lift the limitation; it must not be the
     * headline.
     */
    await rejects(
      'the credentials are not blamed — they are fine',
      /^(?!.*needs a hosted model).*$/s,
      () => transcribe(raw.body, raw.type, { lang: 'he' }),
    );

    const long = upload(wav(90));
    await rejects(
      'a recording past the ceiling says how long it was',
      /90 seconds/,
      () => transcribe(long.body, long.type, { lang: 'he' }),
    );
    await rejects('and what to do about it', /shorter go/, () =>
      transcribe(long.body, long.type, { lang: 'he' }));
  }

  // ------------------------------------------------------------------------
  section('And English is untouched by any of it:');
  {
    const { body, type } = upload(wav(2));
    await rejects('English still goes to the local model', /local whisper is not installed/, () =>
      transcribe(body, type, { lang: 'en' }));

    const status = await voiceStatus();
    ok(status.languages.via === 'azure-speech', 'the status names the free backend');
    ok(status.openai.configured === false, 'and reports no OpenAI key, because there is none');
    ok(status.configured === true, 'the box counts as configured on the strength of Azure alone');
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`);

if (MODE === 'local') {
  /*
   * The other three passes. Spawned rather than imported: `openai.js` and
   * `azure-speech.js` each read the environment once, and a box with a key is a
   * different box. Every one of them has to be green, so the statuses are combined
   * rather than the last one winning.
   */
  const failed = MODES.filter((mode) => {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), mode], {
      stdio: 'inherit',
      env: {
        ...process.env,
        // The metered key exists in every pass but `speechonly`, which deletes it.
        OPENAI_API_KEY: FAKE_KEY,
        // A 1 MB day, so the budget refusal is reachable in the `hosted` pass. It has
        // to be generous enough that the `speech` pass's fall-throughs still fit.
        TRANSCRIBE_OPENAI_DAILY_MB: mode === 'hosted' ? '1' : '200',
      },
    });
    return child.status !== 0;
  });
  if (failed.length) console.error(`\nfailing passes: ${failed.join(', ')}`);
  process.exit(failures || failed.length ? 1 : 0);
}

process.exit(failures ? 1 : 0);
