/**
 * When a turn ending becomes a notification, and — mostly — when it does not.
 *
 * The failure everyone has met is not a missing notification, it is a phone that
 * buzzes for nothing: twice for one answer, once for something said an hour ago,
 * once per conversation the moment a service restarts, or for the message you are
 * already reading in the app. Each of those is a separate rule in turn-watcher.js
 * and each has a section here, because the only way to find out otherwise is to
 * carry the phone around for a day.
 *
 * Everything runs against real transcript files in a temporary CLAUDE_HOME, with
 * push and the session manager passed in as fakes. `scan()` is called directly, so
 * nothing here waits on the poll interval except the one check that the loop runs
 * at all.
 *
 * Run: node chat-service/turn-watcher-test.js
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-watcher-test-'));
const PROJECTS = path.join(TMP, 'projects');
const CLAUDE_HOME = path.join(TMP, 'claude');
const mangle = (p) => p.replace(/[/.]/g, '-');

// Two projects, plus a conversation whose cwd is not a project at all.
const DEMO = path.join(PROJECTS, 'demo');
const OTHER = path.join(PROJECTS, 'other');
const ELSEWHERE = path.join(TMP, 'somewhere-else');
const dirFor = (cwd) => path.join(CLAUDE_HOME, 'projects', mangle(cwd));
for (const cwd of [DEMO, OTHER, ELSEWHERE]) {
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(dirFor(cwd), { recursive: true });
}

// Read at import time by session-manager.js and push.js.
process.env.PROJECTS_ROOT = PROJECTS;
process.env.CLAUDE_HOME = CLAUDE_HOME;
process.env.CW_PUSH_DIR = path.join(TMP, 'push');
/*
 * A named deployment, because that name is the first word of every title now and the
 * unnamed case would quietly test a shorter string than anyone runs. Two deployments
 * of this repository can point at the same phone (see deploymentName in manifest.js),
 * which is the whole reason the word is there.
 */
process.env.PWA_NAME = 'personal';

const { createTurnWatcher, notificationTitle, preview, questionBody } = await import('./turn-watcher.js');
const { topicFor } = await import('./push.js');

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}`);
  }
};
const section = (name) => console.log(`\n${name}`);

const assistant = (text, { stop = 'end_turn', at = new Date() } = {}) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date(at).toISOString(),
    message: { role: 'assistant', stop_reason: stop, content: [{ type: 'text', text }] },
  });
const userText = (text) =>
  JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: text } });
/** An `AskUserQuestion` call, as Claude Code writes one: the tool_use block alone. */
const ask = (id, questions, { at = new Date() } = {}) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date(at).toISOString(),
    message: {
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions } }],
    },
  });
/** Its answer: a tool_result, and the chosen labels alongside it. */
const answerTo = (id, answers) =>
  JSON.stringify({
    type: 'user',
    timestamp: new Date().toISOString(),
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: 'Your questions have been answered.' }],
    },
    toolUseResult: { answers },
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Write a transcript, and move its mtime on by a visible amount.
 *
 * The watcher skips a file whose mtime has not changed, which is the whole reason it
 * is cheap enough to run every five seconds. Two writes inside one filesystem tick —
 * about 10ms here — share an mtime, so the second would be invisible. That is an
 * artefact of a test that writes faster than anyone talks, not a bug: real turns are
 * seconds apart. Stamping each write rather than sleeping keeps it deterministic.
 */
let stamp = Date.now();
async function write(cwd, session, ...lines) {
  const file = path.join(dirFor(cwd), `${session}.jsonl`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  stamp += 20;
  fs.utimesSync(file, new Date(stamp), new Date(stamp));
}

/** A watcher wired to fakes: one subscribed device, and a notify that just records. */
function watcherWith({ live = [], devices = 1, notify } = {}) {
  const sent = [];
  const watcher = createTurnWatcher({
    liveSessions: () => live,
    subscriptions: async () => Array.from({ length: devices }, (_, i) => ({ endpoint: `https://push.example/${i}` })),
    notify: notify || (async (payload, opts) => { sent.push({ payload, opts }); }),
    log: () => {},
  });
  return { watcher, sent };
}

const S1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const S2 = 'bbbbbbbb-0000-4000-8000-000000000002';
const S3 = 'cccccccc-0000-4000-8000-000000000003';

// --------------------------------------------------------------------------
section('A restart announces nothing:');
{
  await write(DEMO, S1, userText('do the thing'), assistant('The thing is done.'));
  const { watcher, sent } = watcherWith();

  const first = await watcher.scan();
  ok(sent.length === 0, 'the first scan notified, so every deploy buzzes once per conversation');
  ok(first.scanned > 0, 'the first scan read nothing, so it has not learned the current state');
  ok(watcher.stats().seeded, 'the watcher did not mark itself seeded');

  await watcher.scan();
  ok(sent.length === 0, 'a scan with nothing new notified anyway');
}

section('A turn that was killed says so, instead of claiming it finished:');
{
  /*
   * The bug this was written after, reported from a phone: "I get a 'Claude
   * finished' message". The turn had been killed, and Claude Code marks that by
   * writing an assistant entry reading "No response requested." with a terminal
   * stop_reason — so it read as a finished turn, and the body quoted the artifact
   * as though it were the answer.
   *
   * The second assertion is the one with a trap in it. Skipping the artifact means
   * the last thing really *said* is the message before it, which is usually one
   * already announced — so a watcher that decides "new" on the text alone would see
   * a repeat and stay silent, swallowing the one notification that matters: the turn
   * you are waiting on has stopped and will not resume by itself.
   */
  const { watcher, sent } = watcherWith();
  await write(DEMO, S3, userText('ship it'), assistant('Deployed. 144/144 checks passed.'));
  await watcher.scan(); // seed: this answer is already known and already announced

  await write(
    DEMO,
    S3,
    userText('ship it'),
    assistant('Deployed. 144/144 checks passed.'),
    assistant('No response requested.', { stop: 'stop_sequence' }),
  );
  await watcher.scan();

  ok(sent.length === 1, `${sent.length} notifications for a killed turn — a repeat digest swallowed it`);
  const { payload } = sent[0] || { payload: {} };
  ok(payload.title === 'personal: demo', `the title is ${JSON.stringify(payload.title)}`);
  ok(
    payload.body.startsWith('Stopped'),
    `a cut-off turn has to say so in the first words of the body, now that the title is ` +
      `spent on naming the conversation: ${JSON.stringify(payload.body)}`,
  );
  ok(payload.cutOff === 'interrupted', 'the payload does not say why it stopped');
  ok(
    /needs a nudge/.test(payload.body || ''),
    `the body does not say what to do about it: ${JSON.stringify(payload.body)}`,
  );
  ok(
    !/No response requested/.test(payload.body || ''),
    'the harness artifact is read out as though Claude had said it',
  );
  ok(
    /Deployed\. 144/.test(payload.body || ''),
    'the body does not say what it was in the middle of, which is what makes it recognisable',
  );

  // And once, not once per poll: a lock screen that repeats itself is one people turn off.
  await watcher.scan();
  ok(sent.length === 1, 'the same cut-off turn notified twice');

  await write(
    DEMO,
    S3,
    userText('ship it'),
    assistant('Deployed. 144/144 checks passed.'),
    assistant('No response requested.', { stop: 'stop_sequence' }),
    userText('continue'),
  );
  await watcher.scan();
  ok(sent.length === 1, 'a cut-off turn that was picked up again notified again');
}

section('A finished turn, on a session this app is not driving:');
{
  const { watcher, sent } = watcherWith();
  await watcher.scan(); // seed
  await write(DEMO, S1, userText('and now?'), assistant('All three features are in, and the suite is green.'));
  await watcher.scan();

  ok(sent.length === 1, `${sent.length} notifications for one finished turn`);
  const { payload, opts } = sent[0] || { payload: {}, opts: {} };
  ok(payload.title === 'personal: demo', `the title is ${JSON.stringify(payload.title)}`);
  ok(payload.body === 'All three features are in, and the suite is green.', `the body is ${JSON.stringify(payload.body)}`);
  ok(payload.sessionId === S1, 'the notification does not say which session it came from');
  // Where tapping it goes. Only this side can build it: the phone has a mangled
  // directory name, and `?folder=` needs the real path — see pwa/sw.js.
  ok(
    payload.url === `/p/demo/?folder=${encodeURIComponent(DEMO)}&session=${S1}`,
    `the notification does not say where to go when it is tapped: ${JSON.stringify(payload.url)}`,
  );
  ok(opts.topic === topicFor(`${mangle(DEMO)}|${S1}`), 'the Topic is not derived from the conversation');
  ok(payload.tag === `turn-${topicFor(`${mangle(DEMO)}|${S1}`)}`, 'the tag is not per conversation, so two answers stack up');

  // Same answer, transcript rewritten. Claude Code appends bookkeeping entries
  // after a turn ends, so this happens on its own within seconds of every reply.
  // The `ai-title` entry is spelled the way the CLI spells it — `aiTitle`, and not
  // the `title` this fixture invented until 2026-09-20, which quietly asserted
  // nothing.
  await write(
    DEMO,
    S1,
    userText('and now?'),
    assistant('All three features are in, and the suite is green.'),
    JSON.stringify({ type: 'ai-title', aiTitle: 'shipping three features', sessionId: S1 }),
  );
  await watcher.scan();
  ok(sent.length === 1, 'the same message was announced twice');

  // The conversation goes on, and the name written after the previous turn stays
  // where it was — behind the newest exchange, which is where a reader walking
  // backwards has to keep going to find it.
  await write(
    DEMO,
    S1,
    userText('and now?'),
    assistant('All three features are in, and the suite is green.'),
    JSON.stringify({ type: 'ai-title', aiTitle: 'shipping three features', sessionId: S1 }),
    userText('one more'),
    assistant('Done — pushed and deployed.'),
  );
  await watcher.scan();
  ok(sent.length === 2, 'a genuinely new answer in the same conversation was not announced');
  ok(sent[1].payload.body === 'Done — pushed and deployed.', 'the second notification carries the wrong text');
  // A notification names the conversation it is about, which is the whole of what
  // distinguishes two lock-screen entries from the same project.
  ok(sent[1].payload.conversation === 'shipping three features',
    `the notification does not say which conversation finished: ${JSON.stringify(sent[1].payload.conversation)}`);
  ok(sent[1].payload.title === 'personal: demo · shipping three features',
    `the title does not name the conversation: ${JSON.stringify(sent[1].payload.title)}`);
}

section('A turn that is still going says nothing:');
{
  const { watcher, sent } = watcherWith();
  await watcher.scan();

  await write(DEMO, S2, userText('go'), assistant('Let me look at the tests.', { stop: 'tool_use' }));
  await watcher.scan();
  ok(sent.length === 0, 'a turn that stopped to run a tool was announced as finished');

  await write(DEMO, S2, userText('go'), assistant('Let me look at the tests.', { stop: 'tool_use' }), userText('[tool result]'));
  await watcher.scan();
  ok(sent.length === 0, 'a tool result going back in was announced');

  await write(DEMO, S2, userText('go'), assistant('Let me look at the tests.', { stop: 'tool_use' }), userText('[tool result]'), assistant('Both suites pass.'));
  await watcher.scan();
  ok(sent.length === 1 && sent[0].payload.body === 'Both suites pass.', 'the turn ending after the tool was not announced');
}

section('A turn that stopped to ask you something is the one buzz worth having:');
{
  /*
   * The exception to everything above: a question has not finished, is not idle, and
   * carries no new text of its own — it fails every test that makes a turn news — and
   * it is the state where a person is the only thing that can move the conversation on.
   * Until this existed, a conversation blocked on a human looked exactly like one doing
   * work, for as long as it took someone to wander back to the panel: a median of three
   * minutes on this box, and once 5.9 hours.
   */
  const { watcher, sent } = watcherWith();
  const ASK = 'toolu_bdrk_01waiting';
  const DEPLOY_Q = 'The change is app payload only. How should it ship?';
  const DEPLOY_ASK = [
    {
      question: DEPLOY_Q,
      header: 'Deploy',
      options: [{ label: 'App only' }, { label: 'Full deploy' }],
      multiSelect: false,
    },
  ];
  await write(DEMO, S2, userText('ship it'), assistant('Looking at what changed.'));
  await watcher.scan(); // seed: that answer is already known

  await write(DEMO, S2, userText('ship it'), assistant('Looking at what changed.'), ask(ASK, DEPLOY_ASK));
  await watcher.scan();
  ok(sent.length === 1, `${sent.length} notifications for a question nobody has answered`);
  const { payload } = sent[0] || { payload: {} };
  ok(payload.title === 'personal: demo', `the title is ${JSON.stringify(payload.title)}`);
  ok(payload.question === true && payload.cutOff === null,
    'the payload does not say this one is a question rather than a finish');
  /*
   * The one thing that must survive however the wording is arranged: a question has to
   * be distinguishable from a finish on a lock screen. A finish can be ignored; a
   * question stops the conversation until someone answers it. The title no longer
   * carries the state, so the body's first words do.
   */
  ok(
    payload.body.startsWith('Waiting on you — '),
    `a question reads exactly like a finished answer: ${JSON.stringify(payload.body)}`,
  );
  ok(
    payload.body.includes('Deploy: ') && payload.body.includes(DEPLOY_Q),
    `the body does not carry the question itself: ${JSON.stringify(payload.body)}`,
  );
  ok(
    payload.body.includes('App only · Full deploy'),
    'the options are missing, and they are usually the whole of the decision',
  );
  // The digest is the ask's id, not its text — an ask has no text, so digesting text
  // would compare the preamble against itself and stay silent.
  await watcher.scan();
  ok(sent.length === 1, 'the same unanswered question buzzed again on the next poll');

  // A second question in the same conversation is a different id, so it is news.
  const ASK2 = 'toolu_bdrk_02waiting';
  await write(
    DEMO,
    S2,
    userText('ship it'),
    assistant('Looking at what changed.'),
    ask(ASK, DEPLOY_ASK),
    answerTo(ASK, { [DEPLOY_Q]: 'App only' }),
    ask(ASK2, [{ question: 'Push to main first?', header: 'Push', options: [{ label: 'Yes' }, { label: 'No' }] }]),
  );
  await watcher.scan();
  ok(sent.length === 2 && /Push: /.test(sent[1].payload.body), 'a second, different question was swallowed as a repeat');

  // And the turn finishing afterwards is still its own news, told the ordinary way.
  await write(
    DEMO,
    S2,
    userText('ship it'),
    assistant('Looking at what changed.'),
    ask(ASK, DEPLOY_ASK),
    answerTo(ASK, { [DEPLOY_Q]: 'App only' }),
    ask(ASK2, [{ question: 'Push to main first?', header: 'Push', options: [{ label: 'Yes' }, { label: 'No' }] }]),
    answerTo(ASK2, { 'Push to main first?': 'Yes' }),
    assistant('Pushed and deployed.'),
  );
  await watcher.scan();
  ok(sent.length === 3 && sent[2].payload.question === false
      && !sent[2].payload.body.startsWith('Waiting on you'),
    'the answer that came after the question was not announced as the finish it is');

  /*
   * A question's clock is its own. The last thing *said* before an ask is the preamble
   * to it, which can be a whole turn older — so measuring freshness from that would
   * drop a question asked a moment ago for the age of the sentence in front of it.
   */
  const ASK3 = 'toolu_bdrk_03waiting';
  await write(
    DEMO,
    S1,
    userText('go'),
    assistant('This took twenty minutes to work out.', { at: Date.now() - 20 * 60 * 1000 }),
    ask(ASK3, DEPLOY_ASK),
  );
  await watcher.scan();
  ok(sent.length === 4 && sent[3].payload.question === true,
    'a question asked just now was dropped for the age of the turn in front of it');

  // The other direction still holds: an ask nobody answered half an hour ago is not
  // news now, or a restored backup would buzz once per abandoned question.
  const ASK4 = 'toolu_bdrk_04waiting';
  await write(DEMO, S3, userText('go'), ask(ASK4, DEPLOY_ASK, { at: Date.now() - 30 * 60 * 1000 }));
  await watcher.scan();
  ok(sent.length === 4, 'a question left unanswered half an hour ago woke the phone now');
}

section('The conversations this app drives are the app\'s business, not the lock screen\'s:');
{
  const live = [{ cwd: OTHER, sessionId: S3, busy: false }];
  const { watcher, sent } = watcherWith({ live });
  await watcher.scan();

  await write(OTHER, S3, userText('hello'), assistant('Hello — this one is in the chat app.'));
  await watcher.scan();
  ok(sent.length === 0, 'a conversation held in the chat app was pushed to the phone as well');

  // The process has exited, so it is no longer live — but its final message is
  // still on screen in the app that ran it.
  live.length = 0;
  await write(OTHER, S3, userText('hello'), assistant('Hello — this one is in the chat app.'), assistant('And a last word.'));
  await watcher.scan();
  ok(sent.length === 0, 'a chat conversation that has just exited was announced after the fact');

  // A different session in the same project is not the app's, and must still work.
  await write(OTHER, S1, userText('from the panel'), assistant('Panel answer.'));
  await watcher.scan();
  ok(sent.length === 1 && sent[0].payload.title === 'personal: other', 'a panel session in a project the app is also using was suppressed');
}

section('Old news is not news:');
{
  const { watcher, sent } = watcherWith();
  await watcher.scan();

  await write(DEMO, S3, userText('yesterday'), assistant('This was said a while ago.', { at: Date.now() - 20 * 60 * 1000 }));
  await watcher.scan();
  ok(sent.length === 0, 'a message from twenty minutes ago woke the phone');

  // …and having been read once, it does not become news when it is read again.
  await write(DEMO, S3, userText('yesterday'), assistant('This was said a while ago.', { at: Date.now() - 20 * 60 * 1000 }), JSON.stringify({ type: 'mode', mode: 'default' }));
  await watcher.scan();
  ok(sent.length === 0, 'an old message was announced on a later pass');
}

section('With nothing subscribed, there is nothing to do:');
{
  const { watcher, sent } = watcherWith({ devices: 0 });
  const idle = await watcher.scan();
  ok(idle.scanned === 0, 'the disk was scanned with no device subscribed');
  ok(sent.length === 0, 'something was sent with no device subscribed');
  ok(!watcher.stats().seeded, 'the watcher considers itself seeded without having read anything');
}
{
  // A phone subscribes now. Whatever finished while nobody was listening stays
  // unannounced — the first scan after subscribing is a seed, not a backlog.
  let devices = 0;
  const sent = [];
  const watcher = createTurnWatcher({
    subscriptions: async () => Array.from({ length: devices }, () => ({ endpoint: 'https://push.example/1' })),
    notify: async (payload) => { sent.push(payload); },
    log: () => {},
  });
  await write(DEMO, S1, userText('while you were out'), assistant('Finished this an hour ago.'));
  await watcher.scan();
  devices = 1;
  await watcher.scan();
  ok(sent.length === 0, 'subscribing a phone replayed the conversations that finished before it');
  await write(DEMO, S1, userText('now'), assistant('And this one just now.'));
  await watcher.scan();
  ok(sent.length === 1 && sent[0].body === 'And this one just now.', 'the first turn after subscribing was not announced');
}

section('An empty device list says so, because it is indistinguishable from working:');
{
  /*
   * The two days this cost. With nothing subscribed the watcher returns before it reads
   * a transcript, so there is no device to fail, nothing to log, and a journal that
   * agrees all is well while the phone is unreachable. The switch on the phone reads
   * "on" throughout, because the browser still holds a subscription whose endpoint the
   * push service has forgotten. The only possible evidence is this line.
   */
  let devices = 0;
  const logged = [];
  const watcher = createTurnWatcher({
    subscriptions: async () => Array.from({ length: devices }, () => ({ endpoint: 'https://push.example/1' })),
    notify: async () => {},
    log: (message) => logged.push(message),
  });

  await watcher.scan();
  ok(logged.length === 1, `${logged.length} lines logged for a box with nothing subscribed`);
  ok(/nothing is subscribed/.test(logged[0] || ''), `the empty device list said nothing legible: ${JSON.stringify(logged)}`);

  // Once, not every five seconds forever: this runs on a timer and a real complaint
  // must not be buried under thousands of copies of itself.
  await watcher.scan();
  await watcher.scan();
  ok(logged.length === 1, `the complaint repeated ${logged.length} times, which fills the log instead of reporting`);

  // Coming back is worth a line too — "it is working again" is how you read the gap.
  devices = 1;
  await watcher.scan();
  ok(logged.length === 2 && /1 device/.test(logged[1]), `recovering from an empty list was silent: ${JSON.stringify(logged)}`);

  /*
   * And losing it again complains again. `complain` suppresses only a message identical
   * to the last one it said, so without clearing that record on recovery the second
   * outage would be swallowed by the memory of the first — and the second outage is the
   * one that proves this is a pattern rather than a bad day.
   */
  devices = 0;
  await watcher.scan();
  ok(logged.length === 3 && /nothing is subscribed/.test(logged[2]), `a second outage after a recovery was silent: ${JSON.stringify(logged)}`);
}

section('Every project, named the way a person names it:');
{
  const { watcher, sent } = watcherWith();
  await watcher.scan();

  await write(DEMO, S1, assistant('From demo.'));
  await write(OTHER, S2, assistant('From other.'));
  await write(ELSEWHERE, S3, assistant('From somewhere that is not a project.'));
  await watcher.scan();

  const titles = sent.map((s) => s.payload.title).sort();
  ok(sent.length === 3, `${sent.length} of three projects were announced`);
  ok(titles.includes('personal: demo') && titles.includes('personal: other'), `titles were ${titles.join(', ')}`);
  ok(
    titles.some((t) => t.includes(mangle(ELSEWHERE))),
    'a conversation outside the projects tree was given no name at all',
  );
  const topics = new Set(sent.map((s) => s.opts.topic));
  ok(topics.size === 3, 'two conversations share a Topic, so one notification replaces another');

  // …and that one has nowhere to go. There is no project window for a directory that
  // is not a project, so it carries no URL and the worker falls back to the chat app
  // rather than opening /p/<mangled-path>/, which is not a route.
  const stray = sent.find((s) => s.payload.title.includes(mangle(ELSEWHERE)));
  ok(stray?.payload.url === null,
    `a conversation outside the projects tree points at ${JSON.stringify(stray?.payload.url)}`);
  const inProject = sent.find((s) => s.payload.project === 'other');
  ok(inProject?.payload.url === `/p/other/?folder=${encodeURIComponent(OTHER)}&session=${S2}`,
    `the second project's URL is ${JSON.stringify(inProject?.payload.url)}`);
}

section('One push service failing does not lose the rest:');
{
  let calls = 0;
  const { watcher } = watcherWith({
    notify: async () => {
      calls += 1;
      throw new Error('push service is down');
    },
  });
  await watcher.scan();
  await write(DEMO, S1, assistant('One.'));
  await write(OTHER, S2, assistant('Two.'));
  const result = await watcher.scan();
  ok(calls === 2, `notify was called ${calls} times; a throw stopped the loop`);
  ok(result.sent.length === 0, 'a failed send was reported as sent');
}

section('A missing CLAUDE_HOME is survivable, because it happens on a fresh box:');
{
  const sent = [];
  const watcher = createTurnWatcher({
    subscriptions: async () => [{ endpoint: 'https://push.example/1' }],
    notify: async (p) => { sent.push(p); },
    log: () => {},
  });
  const home = path.join(CLAUDE_HOME, 'projects');
  const moved = `${home}-away`;
  fs.renameSync(home, moved);
  const result = await watcher.scan();
  ok(result.scanned === 0 && sent.length === 0, 'a missing transcript directory was not survived');
  fs.renameSync(moved, home);
  ok((await watcher.scan()).scanned > 0, 'the watcher did not recover once the directory came back');
}

section('The loop runs on its own:');
{
  const sent = [];
  const watcher = createTurnWatcher({
    subscriptions: async () => [{ endpoint: 'https://push.example/1' }],
    notify: async (p) => { sent.push(p); },
    pollMs: 15,
    log: () => {},
  });
  watcher.start();
  await sleep(60);
  await write(DEMO, S2, assistant('Said this while the timer was running.'));
  for (let i = 0; i < 40 && !sent.length; i += 1) await sleep(25);
  await watcher.stop();
  ok(sent.length === 1, `the polling loop sent ${sent.length} notifications for one new message`);

  const before = sent.length;
  await write(DEMO, S2, assistant('And this after it was stopped.'));
  await sleep(80);
  ok(sent.length === before, 'the watcher kept polling after stop()');
}

// --------------------------------------------------------------------------
section('The preview, which is all a lock screen shows:');
{
  ok(preview('Short and done.') === 'Short and done.', 'a short message was altered');
  ok(preview('two\n\nlines   here') === 'two lines here', 'newlines and runs of spaces are not collapsed');
  ok(preview('  padded  ') === 'padded', 'the preview is not trimmed');
  const long = `${'word '.repeat(60)}end`;
  const cut = preview(long);
  ok(cut.length <= 151, `the preview is ${cut.length} characters, which a lock screen truncates mid-word anyway`);
  ok(cut.endsWith('…'), 'a truncated preview does not say it was truncated');
  ok(!/ …$/.test(cut), 'the ellipsis is hung off a trailing space');
  ok(preview('here is code:\n```js\nconst x = 1;\n```\nand after') === 'here is code: and after', 'a code fence is read out into the preview');
  ok(preview(null) === '' && preview(undefined) === '', 'a missing message throws instead of previewing as empty');
  ok(preview('abcdef', 3) === 'abc…', 'a short limit is not honoured');
}

section('The title, which is one line and gets truncated from the end:');
{
  ok(
    notificationTitle('triplec', 'fixing the notification tap') === 'personal: triplec · fixing the notification tap',
    `the title reads ${JSON.stringify(notificationTitle('triplec', 'fixing the notification tap'))}`,
  );
  // A conversation with no name yet — Claude Code writes `ai-title` a turn or two in,
  // so the first notification of a conversation usually has none.
  ok(notificationTitle('demo', null) === 'personal: demo', 'a nameless conversation leaves a dangling separator');
  ok(notificationTitle('demo', '   ') === 'personal: demo', 'a blank name is treated as a name');
  // Truncated on a word boundary where there is one, and marked, because a title cut
  // by Android is cut silently and reads as the whole name.
  const long = notificationTitle('demo', 'a conversation with a name far longer than any lock screen will show');
  ok(long.length <= 64, `the title is ${long.length} characters, which is more than the line it gets`);
  ok(long.startsWith('personal: demo · ') && long.endsWith('…'), `a long name was not marked as cut: ${JSON.stringify(long)}`);
  /*
   * A project whose own name fills the line keeps the whole line. Half a conversation
   * name is worth less than the two words that say where the notification came from,
   * so the title stops rather than spending five characters on "a co…".
   */
  const wide = notificationTitle('a-project-with-a-very-long-directory-name-indeed', 'some conversation');
  ok(wide === 'personal: a-project-with-a-very-long-directory-name-indeed',
    `a project name that fills the line left room for a fragment: ${JSON.stringify(wide)}`);
}

section('A question on a lock screen, which has to be decidable from:');
{
  const one = (over = {}) => ({
    questions: [{ header: 'Deploy', question: 'How should it ship?', options: ['App only', 'Full deploy'], ...over }],
  });
  ok(
    questionBody(one()) === 'Deploy: How should it ship? — App only · Full deploy',
    `the body reads ${JSON.stringify(questionBody(one()))}`,
  );
  ok(
    questionBody(one({ header: null })) === 'How should it ship? — App only · Full deploy',
    'a question with no header carries a stray separator',
  );
  ok(questionBody(one({ options: [] })) === 'Deploy: How should it ship?',
    'a question with no options ends in an empty list');
  // Four long labels do not fit a lock screen, and half a list of options reads as a
  // shorter list rather than as a longer one. So they are counted instead.
  const many = one({ options: ['Credentials missing in env', 'Do not show the failed message', 'Filter out unconfigured accounts', 'Something else'] });
  ok(/— 4 options$/.test(questionBody(many)), `long options are listed anyway: ${JSON.stringify(questionBody(many))}`);
  ok(questionBody(null) === 'Claude is waiting for an answer.' && questionBody({}) === 'Claude is waiting for an answer.',
    'a question that arrived without its contents throws instead of saying the one thing it knows');
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
