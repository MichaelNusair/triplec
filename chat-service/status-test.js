/**
 * What a device is told when it opens a conversation, and where each part came from.
 *
 * This exists because the two halves of the answer have different failure modes and
 * only one of them is trustworthy. "Is Claude working" is knowledge held by
 * claude-broker, which owns the process; the transcript can only show the state a
 * conversation was *left* in, which reads as "working" forever once a process dies
 * mid-turn. Conflating those would put "Claude is working…" over the editor of a
 * conversation that will never answer.
 *
 * The reading itself is the other half: it must find the newest message without
 * reading the transcript, because reading the transcript is precisely what the
 * panel already does and precisely why there is a wait to fix.
 *
 * Run: node chat-service/status-test.js
 */
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
// For a process with a known start time, which is what separates a turn in flight
// from one abandoned by a process that no longer exists. See `startedAt`.
import { spawn } from 'child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
const PROJECTS = path.join(TMP, 'projects');
const CWD = path.join(PROJECTS, 'demo');
const CLAUDE_HOME = path.join(TMP, 'claude');
const SOCKET = path.join(TMP, 'broker.sock');
// The transcript directory name Claude Code derives from a path: separators and
// dots become dashes. Built the same way here rather than imported, so a change to
// that mangling shows up as a failure instead of agreeing with itself.
const PROJECT_DIR = path.join(CLAUDE_HOME, 'projects', CWD.replace(/[/.]/g, '-'));

fs.mkdirSync(CWD, { recursive: true });
fs.mkdirSync(PROJECT_DIR, { recursive: true });

// Read at import time by session-manager.js, so they have to be set before it
// loads — which is why this file imports dynamically below.
process.env.PROJECTS_ROOT = PROJECTS;
process.env.CLAUDE_HOME = CLAUDE_HOME;
process.env.CLAUDE_BROKER_SOCKET = SOCKET;

const { claudeStatus, firstPrompt, firstPromptFor, sessionOwner } = await import('./claude-status.js');

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

const SESSION = 'a1b2c3d4-0000-4000-8000-000000000000';
const TRANSCRIPT = path.join(PROJECT_DIR, `${SESSION}.jsonl`);

const assistant = (text, stop = 'end_turn') =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: { role: 'assistant', stop_reason: stop, content: [{ type: 'text', text }] },
  });
// The same entry, stamped as having been written a while ago. The timestamp is what
// dates the *state* of a transcript, where the file's mtime only dates the last thing
// written to it — a resume writes bookkeeping entries over a turn abandoned hours ago.
const assistantAgo = (text, stop, ms) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date(Date.now() - ms).toISOString(),
    message: { role: 'assistant', stop_reason: stop, content: [{ type: 'text', text }] },
  });
const userText = (text) =>
  JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: text } });
const toolResult = (size) =>
  JSON.stringify({
    type: 'user',
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: [{ type: 'tool_result', content: 'x'.repeat(size) }] },
  });

const write = (...lines) => fs.writeFileSync(TRANSCRIPT, `${lines.join('\n')}\n`);

/*
 * A broker whose answer this test chooses.
 *
 * `brokerReply` is what it says; 'silent' accepts the connection and never answers,
 * which is the wedged-broker case — the one where a status request must give up on
 * its own rather than holding an HTTP response open.
 */
let brokerReply = null;
const broker = net.createServer((sock) => {
  sock.on('error', () => {});
  sock.on('data', () => {
    if (brokerReply === 'silent') return;
    sock.write(`${JSON.stringify(brokerReply)}\n`);
    sock.end();
  });
});
await new Promise((resolve) => broker.listen(SOCKET, resolve));

const liveSession = (over = {}) => ({
  ok: true,
  v: 1,
  sessions: [{ cwd: CWD, sessionId: SESSION, working: false, clients: 1, idleMs: 20, pid: 1, ...over }],
});

section('The last thing Claude said, out of the end of the transcript:');
/*
 * Most entries in a transcript are not messages, and several of the kinds that are
 * not get written *after* the last assistant reply — `last-prompt`, `mode`,
 * `atis-latch`, `ai-title`. On the real transcripts here they outnumber the actual
 * turns four to one. So "the last line" is the wrong thing to read, and reading it
 * would answer this with nothing at all.
 */
write(
  assistant('an earlier answer nobody asked to see'),
  userText('and then a question'),
  assistant('the answer you came back for'),
  JSON.stringify({ type: 'last-prompt', prompt: 'and then a question' }),
  JSON.stringify({ type: 'mode', mode: 'default' }),
  JSON.stringify({ type: 'atis-latch' }),
);
brokerReply = { ok: false, why: 'bad handshake' };
let status = await claudeStatus(CWD);
ok(status.last?.text === 'the answer you came back for',
  'it reads the newest message, past the bookkeeping entries written after it');
ok(status.sessionId === SESSION, 'and names the conversation it came from');
ok(status.bytes === fs.statSync(TRANSCRIPT).size, 'it reports the size that explains the wait');

section('Which state the conversation was left in, when the broker cannot say:');
ok(status.source === 'transcript' && status.state === 'idle',
  'a finished turn (stop_reason end_turn) is your turn');

write(assistant('let me look', 'tool_use'));
status = await claudeStatus(CWD);
ok(status.state === 'working', 'a turn that stopped to run a tool is still working');

write(assistant('done'), userText('a follow-up with no reply yet'));
status = await claudeStatus(CWD);
ok(status.state === 'working', 'a typed message with no reply under it yet is working');
ok(status.last?.text === 'done', 'and the last thing said is still reported, not the message');

section('A turn that was killed is idle, and is not finished:');
/*
 * The distinction this section exists for, and the bug it was written after. When a
 * turn is cut off, Claude Code writes an assistant entry saying "No response
 * requested." with a terminal stop_reason — so it reads as a completed turn, and 91
 * of them across the transcripts on this box had each announced itself to a phone as
 * "Claude finished", over a body quoting that artifact as though Claude had said it.
 *
 * Both halves matter. The state is genuinely idle (nothing is running), so a sheet
 * saying "Claude is working" would be wrong too; what is wrong is calling it
 * finished, and reporting a harness artifact as the last thing said.
 */
write(assistant('half of an ans'), assistant('No response requested.', 'stop_sequence'));
status = await claudeStatus(CWD);
ok(status.state === 'idle', 'a killed turn is not left looking like a turn still running');
ok(status.cutOff === 'interrupted', 'a killed turn is indistinguishable from a finished one');
ok(
  status.last?.text === 'half of an ans',
  'the artifact is reported as the last thing Claude said, which it never said',
);

write(assistant('a real answer'), assistant('Prompt is too long', 'stop_sequence'));
status = await claudeStatus(CWD);
ok(status.cutOff === 'overflow', 'a turn that could not run at all is reported as interrupted');

write(assistant('half of an ans'), assistant('No response requested.', 'stop_sequence'), userText('continue'));
status = await claudeStatus(CWD);
ok(
  status.state === 'working' && status.cutOff === null,
  'a cut-off turn that was picked up again still says it stopped — the news is stale',
);

write(assistant('the whole answer'));
status = await claudeStatus(CWD);
ok(status.cutOff === null, 'an ordinary finished turn is reported as cut off');

/*
 * The stop button, which leaves the other kind of killed turn: a `user` entry whose
 * whole text is the marker, sitting under an assistant turn that had stopped to run a
 * tool. Every other trailing user entry owes an answer, so the naive reading is the
 * busiest state there is, and it is the one state where nothing at all is coming. 19
 * of these across this project's transcripts, 3 of them the last word in the file.
 *
 * It has to be recognised for the section below to be safe: there the test of a
 * mid-turn transcript is whether the live process wrote it, and the process that was
 * interrupted is exactly the process that wrote this.
 */
write(assistant('let me look', 'tool_use'), userText('[Request interrupted by user]'));
status = await claudeStatus(CWD);
ok(status.state === 'idle', 'a turn stopped by hand owes no answer, however mid-turn the file looks');

write(assistant('let me look', 'tool_use'), userText('[Request interrupted by user for tool use]'));
status = await claudeStatus(CWD);
ok(status.state === 'idle', 'including the variant written when the tool is what was stopped');

write(
  assistant('let me look', 'tool_use'),
  userText('[Request interrupted by user]'),
  userText('actually, do this instead'),
);
status = await claudeStatus(CWD);
ok(status.state === 'working', 'and a message typed after the interrupt is a turn again');

section('A question waiting on a person is a third state, neither working nor finished:');
/*
 * The state that did not exist, and why nothing else could stand in for it.
 * `AskUserQuestion` is written as an ordinary `tool_use` with `stop_reason:
 * 'tool_use'`, so reading the file says what it says about any other tool — working —
 * and the broker says the same, because the process really does have a turn in
 * flight. Both are true and neither is the thing a person needs to be told, which is
 * that nothing at all will happen until they go and answer it. Measured on the
 * transcripts on this box: 71 answered asks, median wait three minutes, longest 5.9
 * hours, every one of them reading as "Claude is working…" the whole time.
 *
 * The fixtures are the shapes on disk, field for field, taken off a real transcript:
 * the ask is an assistant entry whose content is the single `tool_use` block, and its
 * answer is a `user` entry carrying a `tool_result` *and* a top-level
 * `toolUseResult.answers` keyed by the full question text. Inventing either shape
 * would only prove the reader agrees with itself.
 */
const ASK_ID = 'toolu_bdrk_01L3beAxtUAYuan4U9bbQYsa';
const DEPLOY_Q = 'The change is app payload only. How should it ship?';
const ask = (id, questions) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: {
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions } }],
    },
  });
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
const DEPLOY_ASK = [
  {
    question: DEPLOY_Q,
    header: 'Deploy',
    options: [
      { label: 'App only', description: 'A paragraph per option, which is why these do not travel.' },
      { label: 'Full deploy', description: 'Another paragraph, and this one reboots the box.' },
    ],
    multiSelect: false,
  },
];

write(userText('ship it'), ask(ASK_ID, DEPLOY_ASK));
brokerReply = { ok: false, why: 'bad handshake' };
status = await claudeStatus(CWD);
ok(status.state === 'question', 'an unanswered ask at the end of a transcript is not reported as work in progress');
ok(status.question?.pending === true && status.question?.answered === false,
  'and is marked as the one being waited on, which is what a surface may offer to answer');
const asked1 = status.question?.questions?.[0];
ok(asked1?.question === DEPLOY_Q && asked1?.header === 'Deploy',
  'the question travels with its own short label, so a lock screen has something to say');
ok(JSON.stringify(asked1?.options) === JSON.stringify(['App only', 'Full deploy']),
  'along with the labels, which are usually the whole of the decision');
ok(!JSON.stringify(status.question).includes('paragraph'),
  'but not the descriptions: paragraphs each, on an answer polled every few seconds');

/*
 * Bug A, and the only handle on it there is. The panel re-renders every question in a
 * conversation as a fresh card when it reloads one, and a card gives no sign of having
 * been answered — so the risk is answering the same question twice. Nothing out here
 * can change what a webview draws; `answers` on the tool result is what makes
 * "you already picked this" a fact that can be shown beside it.
 */
write(userText('ship it'), ask(ASK_ID, DEPLOY_ASK), answerTo(ASK_ID, { [DEPLOY_Q]: 'App only' }), assistant('shipping it'));
status = await claudeStatus(CWD);
ok(status.state === 'idle', 'a question with a result under it is waiting for nothing');
ok(status.question?.answered === true && status.question?.pending === false,
  'the question is still reported after it was answered — the redrawn card needs explaining');
ok(status.question?.questions?.[0]?.answer === 'App only',
  'and names the option that was taken, in the same words the card shows');

// Two questions in one ask, one of them multi-select: each answer is matched to its
// own question by text, which is the only key `answers` has.
const PAIR_ID = 'toolu_bdrk_02pair';
const Q_ONE = 'Which surfaces should say it?';
const Q_TWO = 'When should the phone buzz?';
write(
  ask(PAIR_ID, [
    { question: Q_ONE, header: 'Surfaces', options: [{ label: 'Chip' }, { label: 'Sheet' }, { label: 'Push' }], multiSelect: true },
    { question: Q_TWO, header: 'Timing', options: [{ label: 'Immediately' }, { label: 'Never' }] },
  ]),
  answerTo(PAIR_ID, { [Q_ONE]: ['Chip', 'Push'], [Q_TWO]: 'Immediately' }),
);
status = await claudeStatus(CWD);
ok(status.question?.questions?.length === 2, 'a batched ask is reported as the several questions it is');
ok(status.question?.questions?.[0]?.answer === 'Chip, Push' && status.question?.questions?.[0]?.multiSelect === true,
  'a multi-select answer arrives as every label that was picked');
ok(status.question?.questions?.[1]?.answer === 'Immediately',
  'and each answer is matched to its own question rather than to the first one');

/*
 * The third thing an unanswered ask can be, found by counting: 2 of the 76 asks on
 * this box were dismissed, and the conversation carried on past them. There is no
 * result on disk and there never will be, so `answered: false` on its own cannot mean
 * "waiting" — `pending` is what separates them, and a client shows nothing at all for
 * this one.
 */
write(ask(ASK_ID, DEPLOY_ASK), assistant('never mind, I picked one myself'));
status = await claudeStatus(CWD);
ok(status.state === 'idle', 'a dismissed question the conversation walked past leaves it idle');
ok(status.question?.answered === false && status.question?.pending === false,
  'and is reported as neither answered nor waiting, so nothing offers to answer it');

write(userText('ship it'), ask(ASK_ID, DEPLOY_ASK));
brokerReply = liveSession({ working: true });
status = await claudeStatus(CWD);
ok(status.state === 'question' && status.source === 'transcript',
  'a live process whose turn is a question is reported as waiting, not as the work the broker sees');
ok(status.conversations?.find((c) => c.sessionId === SESSION)?.state === 'question',
  'and the row in the list says the same — the one row that will never move on its own');

/*
 * An abandoned ask: the transcript stops mid-question and no process exists to hear
 * an answer. That is your turn in the ordinary way, and offering to answer it would
 * be offering to talk to nothing — but the question still rides along so a client can
 * say what the conversation stopped in the middle of.
 */
brokerReply = { ok: true, v: 1, sessions: [] };
status = await claudeStatus(CWD);
ok(status.state === 'idle' && status.source === 'broker',
  'a question with nothing running it is your turn, not a question anybody is waiting on');
ok(status.question?.pending === true,
  'while still reporting that this is where the conversation stopped');

brokerReply = { ok: false, why: 'bad handshake' };

section('A big tool result does not hide the message behind it:');
/*
 * One 400KB tool result pushes the last real reply outside any small window. The
 * read widens rather than answering "nothing to show" about a conversation that
 * plainly has something to show — and it is still bounded, because reading the
 * whole file is the thing this exists to avoid.
 */
write(assistant('the answer, buried'), toolResult(400 * 1024));
status = await claudeStatus(CWD);
ok(status.last?.text === 'the answer, buried',
  'it widens the read when the first window holds no message');
ok(status.state === 'working', 'and the trailing tool result still reads as working');

/*
 * The same transcript seen from the list, which reads one small window and therefore
 * lands entirely inside that one line: nothing in it parses, and a row with no state at
 * all fell back to idle — about a conversation in the middle of the largest thing it had
 * done all day, which is the one moment it is certainly working. 49 lines in this
 * project's transcripts are over 64KB. See SUMMARY_RETRY.
 */
brokerReply = liveSession({ working: false, pid: process.pid });
status = await claudeStatus(CWD);
const buried = status.conversations?.find((c) => c.sessionId === SESSION);
ok(buried?.state === 'working',
  'a row whose whole window is inside one huge line is read again rather than called idle');
ok(buried?.said === 'the answer, buried', 'and the second read finds the message that window could not hold');
brokerReply = { ok: false, why: 'bad handshake' };

section('It does not read the transcript, which is the entire point:');
/*
 * The panel takes 1.75–3.97s to reload a large conversation; this has to answer in
 * a fraction of that or it is just a second copy of the same wait. Timed rather
 * than asserted structurally because the property that matters is the wall clock —
 * the bound is loose enough to survive a busy box and still an order of magnitude
 * under a full read and parse of this file.
 */
const filler = `${toolResult(64 * 1024)}\n`;
fs.writeFileSync(TRANSCRIPT, `${assistant('buried under twelve megabytes')}\n`);
for (let i = 0; i < 190; i += 1) fs.appendFileSync(TRANSCRIPT, filler);
fs.appendFileSync(TRANSCRIPT, `${assistant('the newest thing said')}\n`);
const size = fs.statSync(TRANSCRIPT).size;
const started = Date.now();
status = await claudeStatus(CWD);
const took = Date.now() - started;
ok(status.last?.text === 'the newest thing said', `it answers correctly on ${(size / 1048576).toFixed(1)}MB`);
ok(took < 1500, `and answers in ${took}ms, not in the seconds a full read would take`);

section('A broker answer beats the transcript, in both directions:');
write(assistant('done'), userText('a follow-up with no reply yet'));
brokerReply = liveSession({ working: true });
status = await claudeStatus(CWD);
ok(status.state === 'working' && status.source === 'broker',
  'a live turn is reported from the broker, which is the only thing that knows');
ok(status.clients === 1, 'along with how many pages are driving it');

// A settled transcript, deliberately: between turns is what this is about. A file
// that ends mid-turn while the broker says idle is the one case where the broker is
// not the better source — see the section on a turn the broker never saw.
write(assistant('done'));
brokerReply = liveSession({ working: false });
status = await claudeStatus(CWD);
ok(status.state === 'idle' && status.source === 'broker',
  'a live process between turns is your turn, and the broker is what says so');

/*
 * The case the whole feature turns on. The transcript ends mid-turn — a question
 * with no answer under it — but the broker holds no session for this directory, so
 * there is no process that could ever finish it. That is a definite "your turn",
 * and inferring "working" from the file would leave the chip lying indefinitely.
 */
brokerReply = { ok: true, v: 1, sessions: [] };
status = await claudeStatus(CWD);
ok(status.state === 'idle' && status.source === 'broker',
  'no live process means your turn, even where the transcript stops mid-turn');
ok(status.clients === null, 'with nothing claimed about pages that do not exist');

/*
 * A session with no id has never been spoken to: the panel starts one such probe
 * per page load and never writes to it. Treating one as the conversation would
 * report a directory as idle while the real conversation beside it was working.
 */
brokerReply = {
  ok: true,
  v: 1,
  sessions: [
    { cwd: CWD, sessionId: null, working: false, clients: 1, idleMs: 5, pid: 2 },
    { cwd: CWD, sessionId: SESSION, working: true, clients: 1, idleMs: 50, pid: 3 },
  ],
};
status = await claudeStatus(CWD);
ok(status.state === 'working' && status.sessionId === SESSION,
  'the panel’s never-spoken-to probe is not mistaken for the conversation');

section('Which conversation the answer is about, when a project holds several:');
/*
 * The staleness that prompted all of this. A project on this box has four live
 * conversations in it; the first version of this file answered per *project* —
 * least-idle live session wins — and never said which conversation it meant. So
 * switching conversations inside the panel left a badge confidently describing a
 * different one, and there was no way to tell from the outside.
 *
 * Which conversation is on screen is not knowable from out here: the panel is a
 * vendor webview that reports nothing about itself and fires no navigation when
 * you switch. What is knowable is that a page driving a conversation holds a
 * broker client for it, and that among attached conversations the one spoken to
 * most recently is the one being used. That is a guess, so the answer carries the
 * name of what it chose and a list of the alternatives — a wrong guess is then
 * visibly wrong instead of silently stale.
 */
const OTHER = 'b2c3d4e5-1111-4000-8000-000000000000';
const OTHER_FILE = path.join(PROJECT_DIR, `${OTHER}.jsonl`);
// Exactly as the CLI writes it, field names included. A fixture invented to match
// the reader only proves that the reader agrees with itself: this one said `title`
// and so did the reader, and neither spelling ever appeared on a real transcript.
const title = (text, id) => JSON.stringify({ type: 'ai-title', aiTitle: text, sessionId: id });
const writeConvo = (file, ...lines) => fs.writeFileSync(file, `${lines.join('\n')}\n`);
const older = (file) => {
  const when = new Date(Date.now() - 60 * 1000);
  fs.utimesSync(file, when, when);
};
// The same thing by a chosen amount, for the freshness bound a transcript has to
// fall outside of before it stops overruling an idle broker. See FRESH_TURN_MS.
const staleBy = (file, ms) => {
  const when = new Date(Date.now() - ms);
  fs.utimesSync(file, when, when);
};

writeConvo(TRANSCRIPT, title('The one on screen', SESSION), assistant('what this conversation last said'));
writeConvo(OTHER_FILE, title('The other one', OTHER), assistant('what the other one last said'));
// The conversation being asked about is deliberately the OLDER file, so that an
// answer which merely takes the newest transcript fails here.
older(TRANSCRIPT);

const twoLive = (mine = {}, other = {}) => ({
  ok: true,
  v: 1,
  sessions: [
    { cwd: CWD, sessionId: SESSION, working: false, clients: 1, idleMs: 400, spokeMs: 900, pid: 3, ...mine },
    { cwd: CWD, sessionId: OTHER, working: false, clients: 0, idleMs: 5, spokeMs: 50, pid: 4, ...other },
  ],
});

brokerReply = twoLive();
status = await claudeStatus(CWD);
ok(status.sessionId === SESSION,
  'the conversation a page is attached to is the one described, not the busiest stream');
ok(status.title === 'The one on screen',
  'and it is named, so an answer about the wrong conversation can be recognised as one');
ok(status.last?.text === 'what this conversation last said', 'the message comes from that conversation');
ok(status.conversations?.length === 2, 'the others in the project are listed alongside it');
const listed = (id) => status.conversations.find((c) => c.sessionId === id);
ok(listed(SESSION)?.current === true && listed(OTHER)?.current === false,
  'exactly one of them is marked as the one the answer is about');
ok(listed(OTHER)?.title === 'The other one' && listed(OTHER)?.said === 'what the other one last said',
  'each is described well enough to pick out of a list');
ok(listed(OTHER)?.live === true && listed(OTHER)?.clients === 0,
  'including a conversation still running with nobody watching it — the case this service exists for');

status = await claudeStatus(CWD, { sessionId: OTHER });
ok(status.sessionId === OTHER && status.title === 'The other one',
  'a device that knows which conversation it is in overrides the guess');
ok(status.last?.text === 'what the other one last said', 'and is answered about that one');
ok(status.conversations?.find((c) => c.sessionId === OTHER)?.current === true,
  'the list follows the choice rather than the guess');

// Both attached: the tie-break. `idleMs` is when the stream last produced a byte,
// which resuming a conversation does with nobody typing, so it identifies the
// conversation being *read back*. `spokeMs` is when someone last said something.
brokerReply = twoLive({ spokeMs: 30 * 1000, idleMs: 20 }, { clients: 1, spokeMs: 400, idleMs: 9000 });
status = await claudeStatus(CWD);
ok(status.sessionId === OTHER,
  'among attached conversations the most recently spoken to wins, not the noisiest');

brokerReply = twoLive({ clients: 0, spokeMs: 30 * 1000 }, { clients: 0, working: true });
status = await claudeStatus(CWD);
ok(status.sessionId === OTHER && status.state === 'working',
  'with nothing attached it falls back to the newest transcript, which is the one being written to');

section('A latched "working" is overruled by the transcript, but only on a quiet stream:');
/*
 * Two reasons this is not redundant. A broker predating the input-side turn
 * detection latches `working` on for the life of the process — 11 of 13 sessions
 * on the box, measured — and restarting it ends every live conversation, so the
 * client half has to be deployable on its own. And even a correct broker can only
 * ever *miss* a `result`, never invent one, so the failure mode is always a badge
 * stuck on "working".
 *
 * A turn in flight is not silent: deltas arrive, tools announce themselves. So a
 * stream that has said nothing for OVERRIDE_QUIET_MS, whose transcript ends with a
 * finished turn, is not working.
 */
writeConvo(TRANSCRIPT, title('The one on screen'), assistant('the finished answer'));
brokerReply = twoLive({ working: true, idleMs: 60 * 1000, spokeMs: 120 * 1000 });
status = await claudeStatus(CWD);
ok(status.state === 'idle' && status.source === 'transcript',
  'a "working" stream that has been silent for a minute, over a finished turn, is your turn');
ok(status.conversations?.find((c) => c.sessionId === SESSION)?.state === 'idle',
  'and the list says the same thing about it, rather than contradicting the answer above');

brokerReply = twoLive({ working: true, idleMs: 200, spokeMs: 120 * 1000 });
status = await claudeStatus(CWD);
ok(status.state === 'working' && status.source === 'broker',
  'a stream that is still producing output is working, whatever the transcript shows');

brokerReply = twoLive({ working: true, idleMs: 60 * 1000, spokeMs: 500 });
status = await claudeStatus(CWD);
ok(status.state === 'working',
  'and so is a message sent a moment ago that has not reached the disk yet');

writeConvo(TRANSCRIPT, title('The one on screen'), assistant('done'), userText('a follow-up with no reply yet'));
brokerReply = twoLive({ working: true, idleMs: 60 * 1000, spokeMs: 120 * 1000 });
status = await claudeStatus(CWD);
ok(status.state === 'working',
  'a transcript that itself ends mid-turn overrules nothing — both sources agree');

section('A turn the broker never saw is working, while the file is still being written:');
/*
 * The other direction, and the one that was shipped wrong. A turn only reaches the
 * daemon's stdin when a person types it: a message from another session, a queued
 * message flushed, a /loop wakeup, a cron or a hook all arrive over the CLI's own
 * socket, and a daemon that marks a turn from stdin alone therefore calls the whole
 * turn idle. Measured on this box 2026-09-21, with five sessions messaging each
 * other: three of six live conversations read idle while their transcripts read
 * working, one of them writing assistant frames to its stream throughout.
 *
 * "Idle" is the expensive way to be wrong — it invites you to type over a live turn —
 * and the broker cannot be restarted to fix it without ending every conversation it
 * holds. So the transcript overrules it here, and what bounds that is not how old the
 * file is but who wrote it: see `startedAt`.
 */
writeConvo(TRANSCRIPT, title('The one on screen', SESSION), assistant('let me look', 'tool_use'));
brokerReply = twoLive({ working: false, idleMs: 300, spokeMs: 40 * 60 * 1000, pid: process.pid });
status = await claudeStatus(CWD);
ok(status.state === 'working' && status.source === 'transcript',
  'a broker that says idle about a conversation writing its transcript right now is overruled');
ok(status.conversations?.find((c) => c.sessionId === SESSION)?.state === 'working',
  'and the list agrees, rather than offering a row you would type over');

/*
 * The case a clock got wrong, and the reason this stopped being a clock. A turn spends
 * minutes at a time writing nothing — a Bash call running the suite, a Read of
 * something large, a permission prompt nobody has answered yet — and 254 of the 21,683
 * mid-turn silences in this project ran past two minutes. This process is the one that
 * wrote the mid-turn entry (it is this test's own pid, which started before the fixture
 * was written), so the turn is still its turn however long the file has sat there.
 */
staleBy(TRANSCRIPT, 8 * 60 * 1000);
status = await claudeStatus(CWD);
ok(status.state === 'working' && status.source === 'transcript',
  'a turn that has written nothing for eight minutes is still the turn that process is on');
ok(status.conversations?.find((c) => c.sessionId === SESSION)?.state === 'working',
  'and the list still agrees');

/*
 * The other side of it, which is what the bound was really for: a conversation left
 * mid-turn by a process that has since died, with a *new* process started over the top
 * of it by a resume. On disk that is indistinguishable from a live turn, and the one
 * thing that separates them is the order of the two clocks — this entry was written ten
 * minutes before the process that is now running the conversation existed.
 *
 * `/proc` is what answers that, so this check is Linux-only in the sense that anywhere
 * else it passes for the weaker reason (no process start to read, and a file too old
 * for the fallback clock). That is the same verdict, reached the older way.
 */
const resumed = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
resumed.unref();
writeConvo(TRANSCRIPT, title('The one on screen', SESSION), assistantAgo('let me look', 'tool_use', 10 * 60 * 1000));
staleBy(TRANSCRIPT, 10 * 60 * 1000);
brokerReply = twoLive({ working: false, idleMs: 300, spokeMs: 40 * 60 * 1000, pid: resumed.pid });
status = await claudeStatus(CWD);
ok(status.state === 'idle' && status.source === 'broker',
  'a mid-turn transcript older than the process now running it is an abandoned turn, not a live one');
ok(status.conversations?.find((c) => c.sessionId === SESSION)?.state === 'idle',
  'and the list says that too, rather than a row that will never answer');
resumed.kill();

writeConvo(TRANSCRIPT, title('The one on screen', SESSION), assistant('let me look', 'tool_use'));
brokerReply = { ok: true, v: 1, sessions: [] };
status = await claudeStatus(CWD, { sessionId: SESSION });
ok(status.state === 'idle' && status.live === false,
  'with no process behind it there is nothing to overrule — a dead mid-turn conversation is idle');

section('A project reached by another of its names is the same project:');
/*
 * The bug this was written for, on the box that produced it. This repository was
 * renamed and the old path left behind as a symlink; the broker went on reporting
 * the six conversations it held under the name they were started with, every page
 * asked about the new one, and `s.cwd === cwd` matched none of them. Every live
 * conversation in the project then read "your turn · not running" — the transcript
 * was found (mangleCwd resolves) and the process holding it was not.
 *
 * Both directions matter, because either side can be the one holding the old name:
 * a page can be opened on a symlink, and a process can have been started on one.
 */
const LINK = path.join(PROJECTS, 'demo-by-another-name');
fs.symlinkSync(CWD, LINK);
writeConvo(TRANSCRIPT, title('The one on screen', SESSION), assistant('done'), userText('a follow-up'));

brokerReply = liveSession({ working: true });
status = await claudeStatus(LINK);
ok(status.state === 'working' && status.source === 'broker',
  'a page asking by the symlink finds the session the broker recorded by the real path');

brokerReply = liveSession({ working: true, cwd: LINK });
status = await claudeStatus(CWD);
ok(status.state === 'working' && status.source === 'broker',
  'and a session the broker recorded by the symlink is found by a page asking for the real path');
ok(status.clients === 1, 'with everything the broker said about it, not a bare "running"');

brokerReply = liveSession({ working: true, cwd: path.join(PROJECTS, 'elsewhere-entirely') });
status = await claudeStatus(CWD);
ok(status.state === 'idle' && status.live === false,
  'a different directory is still a different directory — the resolving is not a free pass');

section('A conversation the broker never heard of is still a conversation:');
/*
 * The second half of the same report, and the deeper half. "The broker holds no
 * session for this" was treated as proof that nothing could be running — true only
 * while every panel process was a broker child. The extension launches `claude`
 * through the wrapper only while `claudeCode.claudeProcessWrapper` is in the settings
 * its extension host read at startup; a host that came up without it spawns the real
 * binary itself, and the broker never hears of the conversation. Three of nine live
 * conversations on this box were in that state on 2026-09-23 — including the one
 * whose own page was being told, mid-turn, that nothing was running it.
 *
 * So a process is looked for where the broker has nothing: by `--resume=<id>` in the
 * argv of something called claude. The fixture is exactly that — a `claude` that is
 * really node, because what is being tested is the finding, not the CLI — and it is
 * started *before* the mid-turn entry so that it is the process that could have
 * written it. See resumingSessions and `startedAt`.
 */
const FAKE_CLAUDE = path.join(TMP, 'bin', 'claude');
fs.mkdirSync(path.dirname(FAKE_CLAUDE), { recursive: true });
fs.symlinkSync(process.execPath, FAKE_CLAUDE);
const SLEEPER = path.join(TMP, 'sleep.js');
fs.writeFileSync(SLEEPER, 'setTimeout(() => {}, 120000);\n');
const unbrokered = spawn(FAKE_CLAUDE, [SLEEPER, `--resume=${SESSION}`], { stdio: 'ignore' });
unbrokered.unref();
brokerReply = { ok: true, v: 1, sessions: [] };
/*
 * A beat between the two clocks being compared, because they are only a fraction of a
 * millisecond apart otherwise: `/proc/<pid>` is stamped as the spawn returns and the
 * entry's timestamp is written on the next line, and measured here the process came
 * out 0.4ms *after* the moment the writer read. Passing on that margin is luck — it
 * passed on this box and failed on the deploy box, which is the same thing. What the
 * test means to set up is a process that plainly predates the mid-turn entry.
 */
await new Promise((resolve) => setTimeout(resolve, 1000));
writeConvo(TRANSCRIPT, title('The one on screen', SESSION), assistant('let me look', 'tool_use'));

/*
 * Polled rather than asked once, because the /proc sweep is memoised for two seconds
 * — the check above took one, and this is not a test of the clock. It resolves inside
 * that window or it has failed.
 */
const settle = async (want, ms = 6000, id = SESSION) => {
  const until = Date.now() + ms;
  for (;;) {
    status = await claudeStatus(CWD, { sessionId: id });
    if (want(status) || Date.now() > until) return status;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
};

await settle((s) => s.live === true);
ok(status.live === true && status.state === 'working' && status.source === 'transcript',
  'a turn in flight in a process the broker never spawned is working, not your turn');
ok(status.brokered === false,
  'and says the process is one nobody shares, which is the fork the broker exists to prevent');
ok(status.clients === null && status.idleMs === null,
  'with no numbers invented for the things only the broker can count');
ok(status.conversations?.find((c) => c.sessionId === SESSION)?.state === 'working',
  'the list agrees, rather than offering the row you would type over');

/*
 * And the protection that has to survive it: an abandoned mid-turn transcript, with a
 * process resuming the conversation that is *newer* than the entry. That is a resume
 * over the top of a killed turn, which must never read as work — found in /proc or
 * not, the same two clocks decide it.
 */
writeConvo(TRANSCRIPT, title('The one on screen', SESSION), assistantAgo('let me look', 'tool_use', 10 * 60 * 1000));
staleBy(TRANSCRIPT, 10 * 60 * 1000);
status = await claudeStatus(CWD, { sessionId: SESSION });
ok(status.live === true && status.state === 'idle',
  'a mid-turn entry older than the process resuming it is an abandoned turn, wherever the pid came from');

unbrokered.kill();
writeConvo(TRANSCRIPT, title('The one on screen', SESSION), assistant('let me look', 'tool_use'));
await settle((s) => s.live === false);
ok(status.live === false && status.state === 'idle',
  'and once nothing is resuming it, a mid-turn conversation is your turn again');

section('A session a timer started is working while it exists:');
/*
 * The same report a day later, from the phone: a conversation a systemd timer had
 * started at 04:57 was shown as "your turn · just now · not running" while the process
 * was twenty seconds into a tool call. Two reasons, both fixed here.
 *
 * It names its conversation with `--session-id` rather than resuming one, so the /proc
 * sweep did not match it at all. And it is `claude -p`, which has no prompt to return
 * to: one instruction, then it exits. So unlike an interactive process, its mere
 * existence settles the question — which is why this fixture leaves the transcript
 * looking *finished*. Between a message and the next tool call that is exactly how a
 * live `-p` run looks on disk, and it must still read as working.
 */
const TIMED = 'c3d4e5f6-0000-4000-8000-000000000000';
const TIMED_TRANSCRIPT = path.join(PROJECT_DIR, `${TIMED}.jsonl`);
writeConvo(TIMED_TRANSCRIPT, title('What the timer is doing', TIMED), assistant('here is the answer'));
const timed = spawn(FAKE_CLAUDE, [SLEEPER, '-p', '--session-id', TIMED], { stdio: 'ignore' });
timed.unref();
brokerReply = { ok: true, v: 1, sessions: [] };

status = await settle((s) => s.live === true, 6000, TIMED);
ok(status.live === true && status.state === 'working',
  'a one-shot run nobody can type into is working for as long as it exists');
ok(status.brokered === false,
  'and is reported as a process the broker never heard of, because it is one');
ok(status.conversations?.find((c) => c.sessionId === TIMED)?.state === 'working',
  'the list says so too, so the phone does not offer you a turn that is not yours');

timed.kill();
status = await settle((s) => s.live === false, 6000, TIMED);
ok(status.live === false && status.state === 'idle',
  'and once it has exited the answer it left behind is your turn, in the ordinary way');

section('One project is never answered with another project’s conversation:');
/*
 * The case the user had not tried yet. Sessions are matched on cwd, and this is
 * the check that says so: a conversation working hard in a different project must
 * not leak into this answer, in either direction.
 */
const CWD2 = path.join(PROJECTS, 'elsewhere');
const PROJECT_DIR2 = path.join(CLAUDE_HOME, 'projects', CWD2.replace(/[/.]/g, '-'));
const ELSEWHERE = 'c3d4e5f6-2222-4000-8000-000000000000';
fs.mkdirSync(CWD2, { recursive: true });
fs.mkdirSync(PROJECT_DIR2, { recursive: true });
// A finished turn here, stated rather than inherited from the section above: what is
// being tested is that another project's work does not leak in, and a conversation
// that is mid-turn in its own right would answer "working" for its own good reason.
writeConvo(TRANSCRIPT, title('The one on screen', SESSION), assistant('the finished answer'));
writeConvo(
  path.join(PROJECT_DIR2, `${ELSEWHERE}.jsonl`),
  title('A different project'),
  assistant('what the other project last said'),
);

brokerReply = {
  ok: true,
  v: 1,
  sessions: [
    { cwd: CWD, sessionId: SESSION, working: false, clients: 1, idleMs: 400, spokeMs: 900, pid: 3 },
    { cwd: CWD2, sessionId: ELSEWHERE, working: true, clients: 1, idleMs: 10, spokeMs: 10, pid: 5 },
  ],
};
status = await claudeStatus(CWD);
ok(status.sessionId === SESSION && status.state === 'idle',
  'a busy conversation in another project does not make this one look busy');
ok(!status.conversations.some((c) => c.sessionId === ELSEWHERE),
  'nor does it appear in this project’s list');
status = await claudeStatus(CWD2);
ok(status.sessionId === ELSEWHERE && status.state === 'working' && status.title === 'A different project',
  'and that project is answered about its own conversation');
ok(status.conversations.length === 1, 'with only its own conversations listed');

section('A conversation that moved into a worktree is still this project’s:');
/*
 * The bug this section exists for, as it was found on the box rather than imagined.
 *
 * `EnterWorktree` moves a session into `<project>/.claude/worktrees/<name>`, and
 * Claude Code then records that conversation under the *worktree's* mangled path —
 * while the process holding it keeps the cwd it was started with, so the broker goes
 * on reporting the project root. Every reader here matched both sides on the project's
 * own directory, so the two halves of one conversation fell down the gap between them:
 * `personal-site` had a conversation live, mid-turn, with nobody watching it, in no
 * list of that project's chats and in no answer about it.
 *
 * Two things are therefore checked, and the second is the one that was wrong: that the
 * conversation is listed at all, and that it is listed when the only process holding it
 * is keyed under the project root.
 */
const TREE = path.join(CWD, '.claude', 'worktrees', 'drop-azure');
const TREE_DIR = path.join(CLAUDE_HOME, 'projects', TREE.replace(/[/.]/g, '-'));
const INTREE = 'd4e5f6a7-3333-4000-8000-000000000000';
fs.mkdirSync(TREE, { recursive: true });
fs.mkdirSync(TREE_DIR, { recursive: true });
writeConvo(
  path.join(TREE_DIR, `${INTREE}.jsonl`),
  title('Dropping Azure', INTREE),
  userText('drop azure'),
  assistant('reading the stack', 'tool_use'),
);

// The measured arrangement: the broker knows this conversation by the project root,
// because that is where the process was started, and nothing told it the cwd moved.
brokerReply = {
  ok: true,
  v: 1,
  sessions: [
    { cwd: CWD, sessionId: INTREE, working: true, clients: 0, idleMs: 20, spokeMs: 20, pid: 7 },
  ],
};
status = await claudeStatus(CWD);
const inTree = status.conversations.find((c) => c.sessionId === INTREE);
ok(Boolean(inTree), 'a conversation recorded in a worktree is listed under its project');
ok(inTree?.worktree === 'drop-azure' && inTree?.cwd === TREE,
  'and says which worktree it is in, and the directory a client has to resume it in');
ok(inTree?.state === 'working' && inTree?.live === true,
  'and is reported working, which is the answer that was being lost');
status = await claudeStatus(CWD, { sessionId: INTREE });
ok(status.sessionId === INTREE && status.title === 'Dropping Azure',
  'asking about it by id reads the transcript from the worktree, not the project');
ok(status.sessionCwd === TREE && status.worktree === 'drop-azure',
  'and the answer names where it runs, so a client can address it');
ok(status.state === 'working' && status.live === true,
  'the process keyed under the project root is still matched to it');
const treePrompt = await firstPromptFor(CWD, INTREE);
ok(treePrompt.text === 'drop azure',
  'the prompt it began with is found in the worktree too, addressed by the project');

// And the other direction: the worktree is a directory inside the project, so asking
// about it on its own must not answer with the whole project's conversations.
status = await claudeStatus(TREE);
ok(status.conversations.length === 1 && status.sessionId === INTREE,
  'a worktree asked about on its own answers with its own conversation only');

fs.rmSync(path.join(CWD, '.claude'), { recursive: true, force: true });
fs.rmSync(TREE_DIR, { recursive: true, force: true });

section('Every way of not knowing falls back rather than guessing:');
// Mid-turn, and said so here: the point below is that a conversation left mid-turn is
// reported as the file has it when there is no broker to ask, so the fixture has to be
// this section's rather than whichever one ran last.
writeConvo(TRANSCRIPT, title('The one on screen', SESSION), assistant('let me look', 'tool_use'));
brokerReply = 'silent';
const slowStart = Date.now();
status = await claudeStatus(CWD);
ok(status.source === 'transcript' && Date.now() - slowStart < 1200,
  'a broker that accepts the connection and says nothing is given up on, not waited for');

await new Promise((resolve) => broker.close(resolve));
try {
  fs.unlinkSync(SOCKET);
} catch {
  /* already gone */
}
status = await claudeStatus(CWD);
ok(status.source === 'transcript', 'no broker at all falls back to the transcript');
ok(status.state === 'working',
  'and reports what the file shows rather than claiming a conversation is idle');

section('The prompt a conversation began with, out of the head of the transcript:');
/*
 * Read from the front, for the one message in a conversation that never changes and
 * is hardest to get back to. Compaction is what makes it feel gone — the CLI's own
 * history no longer holds it — but compaction *appends*, so it is still sitting a
 * kilobyte from the start of the file. Everything below is a shape seen on the real
 * transcripts on this box, because the failure this guards against is not an
 * exception: it is quietly answering with a preamble Claude Code wrote, and calling
 * it something the user typed.
 */
const OPENING = path.join(PROJECT_DIR, 'd4e5f6a7-3333-4000-8000-000000000000.jsonl');
const SENT_AT = '2026-09-20T09:00:00.000Z';
/** A `user` entry as the CLI writes one: an origin, and content in blocks. */
const prompt = (blocks, over = {}) =>
  JSON.stringify({
    type: 'user',
    timestamp: SENT_AT,
    origin: { kind: 'human' },
    promptSource: 'sdk',
    message: {
      role: 'user',
      content: (Array.isArray(blocks) ? blocks : [blocks]).map((b) =>
        typeof b === 'string' ? { type: 'text', text: b } : b,
      ),
    },
    ...over,
  });
// Real transcripts open with two of these, which is why "the first line" is not the
// question and why the read has to parse forwards rather than look at line 1.
const queueOp = JSON.stringify({ type: 'queue-operation', operation: 'enqueue' });

fs.writeFileSync(
  OPENING,
  `${[
    queueOp,
    queueOp,
    prompt('Reuse the first prompt of a conversation, copyable from the status sheet.'),
    assistant('on it'),
    prompt('and now deploy it'),
  ].join('\n')}\n`,
);
let opening = await firstPrompt(OPENING);
ok(
  opening?.text === 'Reuse the first prompt of a conversation, copyable from the status sheet.',
  'the opening prompt is read past the bookkeeping entries ahead of it, and later prompts do not win',
);
ok(opening?.at === SENT_AT, 'with when it was sent, so a sheet can say how long ago that was');

/*
 * The case the whole feature is for. A compacted conversation carries Claude Code's
 * own continuation preamble as a `user` entry — indistinguishable from a typed
 * message except by its text — and there are 8 of those in one file on this box.
 * Answering with one of them would hand someone a summary of their conversation
 * where they asked for the sentence they started it with.
 */
fs.writeFileSync(
  OPENING,
  `${[
    queueOp,
    prompt('The original brief, written once and worth sending again.'),
    assistant('done'),
    JSON.stringify({ type: 'compact-boundary', isCompactSummary: true }),
    prompt('This session is being continued from a previous conversation. The conversation is summarised below:'),
    assistant('carrying on'),
  ].join('\n')}\n`,
);
ok(
  (await firstPrompt(OPENING))?.text === 'The original brief, written once and worth sending again.',
  'a compacted conversation still answers with the prompt it began with, not the compaction preamble',
);

/*
 * A prompt sent from the editor arrives with the harness's blocks ahead of the
 * words — a `<system-reminder>`, or the IDE's current selection — inside the *same*
 * entry. So the blocks are read in order rather than only the first one; taking
 * block zero reports a system reminder as the user's opening message.
 */
fs.writeFileSync(
  OPENING,
  `${[
    prompt(['<system-reminder>Codebase instructions follow.</system-reminder>', 'What I actually asked for.']),
  ].join('\n')}\n`,
);
ok(
  (await firstPrompt(OPENING))?.text === 'What I actually asked for.',
  'the harness blocks in front of a prompt are stepped over, not reported as the prompt',
);

// Another agent's message, or the harness's own, comes through the same `user`
// channel and says so in `origin.kind`. It is not something this user typed.
fs.writeFileSync(
  OPENING,
  `${[
    prompt('Another Claude session sent a message: deploy is blocked on your tree.', {
      origin: { kind: 'peer', from: 'uds:/tmp/cc-socks/1.sock' },
      promptSource: 'system',
    }),
    prompt('Then what I said about it.'),
  ].join('\n')}\n`,
);
ok(
  (await firstPrompt(OPENING))?.text === 'Then what I said about it.',
  'a message from another session is not offered as the prompt this user began with',
);

// A subagent's prompt is written into the same transcript as a `user` entry, and it
// is the orchestrator talking, not the person.
fs.writeFileSync(
  OPENING,
  `${[
    prompt('Search the repository for every call site.', { isSidechain: true, origin: undefined }),
    prompt('The thing I typed.'),
  ].join('\n')}\n`,
);
ok(
  (await firstPrompt(OPENING))?.text === 'The thing I typed.',
  'a sidechain prompt belongs to a subagent, so it is not the opening prompt either',
);

/*
 * 35 of the 93 transcripts on this box were written before the CLI stamped an
 * origin on anything, and they are exactly the old conversations someone would go
 * looking for an opening prompt in. With no origin to read, what the text looks
 * like is all there is.
 */
fs.writeFileSync(
  OPENING,
  `${[
    JSON.stringify({
      type: 'user',
      timestamp: SENT_AT,
      message: { role: 'user', content: '<command-name>/init</command-name>' },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: SENT_AT,
      message: { role: 'user', content: 'Caveat: The messages below were generated while running /init.' },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: SENT_AT,
      message: { role: 'user', content: 'An old conversation, from before origins were written.' },
    }),
  ].join('\n')}\n`,
);
ok(
  (await firstPrompt(OPENING))?.text === 'An old conversation, from before origins were written.',
  'a transcript with no origins on it falls back to recognising the injected text, and still answers',
);

/*
 * A screenshot pasted into the opening message is 350KB of base64 in front of the
 * words, measured on this box — and one conversation's first typed prompt is 997KB
 * and 284 entries in. So the read widens rather than reporting a conversation as
 * having no opening prompt, and it is still bounded.
 */
fs.writeFileSync(
  OPENING,
  `${[
    prompt([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(350 * 1024) } },
      'why does this screen look like that',
    ]),
  ].join('\n')}\n`,
);
ok(
  (await firstPrompt(OPENING))?.text === 'why does this screen look like that',
  'a pasted screenshot in front of the words does not hide them: the read widens',
);

// And a transcript holding nothing a person typed is a real answer, not a failure.
fs.writeFileSync(OPENING, `${[queueOp, assistant('resumed with no new prompt')].join('\n')}\n`);
ok((await firstPrompt(OPENING)) === null, 'a transcript with no typed prompt in it answers nothing, and does not throw');

/*
 * The same bound the rest of this file lives by. The panel takes seconds to reload a
 * large conversation; a route that read 12MB from the front to find line 3 would be
 * a second copy of that wait rather than a way out of it.
 */
fs.writeFileSync(OPENING, `${prompt('the prompt that started twelve megabytes')}\n`);
for (let i = 0; i < 190; i += 1) fs.appendFileSync(OPENING, filler);
const headStarted = Date.now();
opening = await firstPrompt(OPENING);
const headTook = Date.now() - headStarted;
ok(
  opening?.text === 'the prompt that started twelve megabytes',
  `it answers correctly on ${(fs.statSync(OPENING).size / 1048576).toFixed(1)}MB`,
);
ok(headTook < 1500, `and answers in ${headTook}ms, without reading the file it is at the front of`);

section('A cwd or a session id from a browser cannot name a path outside the projects root:');
let refused = false;
try {
  await claudeStatus('/etc');
} catch {
  refused = true;
}
ok(refused, 'a cwd outside the projects root is refused');

refused = false;
try {
  await firstPromptFor('/etc', 'a1b2c3d4-0000-4000-8000-000000000000');
} catch {
  refused = true;
}
ok(refused, 'and so is one on the way to an opening prompt');

refused = false;
try {
  await firstPromptFor(CWD, '../../../../etc/passwd');
} catch {
  refused = true;
}
ok(refused, 'a session id shaped like a path traversal is refused rather than joined onto one');

const addressed = await firstPromptFor(CWD, 'd4e5f6a7-3333-4000-8000-000000000000');
ok(
  addressed.text === 'the prompt that started twelve megabytes' &&
    addressed.sessionId === 'd4e5f6a7-3333-4000-8000-000000000000' &&
    addressed.chars === addressed.text.length,
  'the addressed form answers with the prompt, the conversation it came from, and its length',
);
const missing = await firstPromptFor(CWD, 'e5f6a7b8-4444-4000-8000-000000000000');
ok(
  missing.text === null && missing.chars === 0,
  'a conversation with no transcript at all answers nothing rather than failing',
);

section('Who is running a conversation, when it is not us:');
/*
 * Asked before resuming one, and the answer decides whether a chat continues a
 * conversation or forks a copy of it. On 2026-10-25 nobody asked: a chat in the
 * phone UI and the editor's panel held one conversation for ten minutes, the stale
 * one answered when the user typed, and it overwrote the work the other had done.
 * The fixture is the one that mattered that day — a process that named its
 * conversation with `--session-id`, which is how this service now starts every
 * chat, precisely so that this question has an answer.
 */
const OWNED = 'f6a7b8c9-5555-4000-8000-000000000000';
const owning = spawn(FAKE_CLAUDE, [SLEEPER, '--session-id', OWNED], { stdio: 'ignore' });
owning.unref();
// The sweep is memoised for two seconds, so this polls rather than asking once.
let ownerPid = null;
for (let i = 0; i < 40 && ownerPid === null; i += 1) {
  ownerPid = await sessionOwner(OWNED);
  if (ownerPid === null) await new Promise((resolve) => setTimeout(resolve, 150));
}
ok(ownerPid === owning.pid, 'a process holding a session id is found, by the id it named');
ok(
  (await sessionOwner(OWNED, { ignorePids: [owning.pid] })) === null,
  'and is not reported to the caller it belongs to, which would fork a chat from itself',
);
ok(
  (await sessionOwner('a7b8c9d0-6666-4000-8000-000000000000')) === null,
  'a conversation nothing is running has no owner',
);
ok((await sessionOwner(null)) === null, 'and a chat with no session to resume asks nothing');
owning.kill();

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
