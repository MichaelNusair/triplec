#!/usr/bin/env node
//
// Boots the real broker against a fake `claude` and drives it over the real unix
// socket. Nothing is stubbed except the CLI itself, because the two things worth
// proving are exactly the two that a unit test with mocks would assume:
//
//   1. a second page JOINS the live process instead of starting a second one —
//      the whole point, and the bug that shipped;
//   2. the wrapper FAILS SAFE — no broker, or a refusal, still runs Claude.
//
// (2) matters more than (1). This sits in front of the user's only interface, so
// a broker that is down must degrade to today's behaviour rather than to a panel
// that will not open.
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WRAPPER = path.join(HERE, 'wrapper');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-test-'));
const SOCKET = path.join(TMP, 'broker.sock');
const PIDFILE = path.join(TMP, 'starts.log');
// One line per start, in the same order as PIDFILE: how the broker chose to
// launch the CLI. The fork guard is a decision about argv, so the only honest
// way to test it is to read the argv the broker actually used.
const ARGVFILE = path.join(TMP, 'argv.log');
const FAKE = path.join(TMP, 'fake-claude');

let pass = 0;
let fail = 0;
const ok = (cond, label, detail = '') => {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};
const section = (name) => console.log(`\n${name}`);

// A stand-in for the CLI: announces a session id like the real one does, echoes
// whatever is written to it, and records every start so the test can prove how
// many processes exist. `end-turn` makes it emit the `result` event that ends a
// turn in the real stream-json vocabulary, which is the only way the broker can
// tell "Claude is still working" from "your turn".
fs.writeFileSync(
  FAKE,
  `#!/usr/bin/env node
require('fs').appendFileSync(${JSON.stringify(PIDFILE)}, process.pid + '\\n');
require('fs').appendFileSync(${JSON.stringify(ARGVFILE)}, process.argv.slice(2).join(' ') + '\\n');
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'S1' }) + '\\n');
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString();
  const lines = buf.split('\\n');
  buf = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    // The panel's two kinds of input: a user message, and a control frame it
    // sends without anyone typing. Unwrap the first, ignore the second, and
    // treat anything unparseable as the plain text the older checks send.
    let text = line.trim();
    try {
      const frame = JSON.parse(line);
      text = frame.type === 'user' && typeof frame.message?.content === 'string'
        ? frame.message.content.trim()
        : '__control__';
    } catch {
      /* not JSON: a raw line from a byte-transparency check */
    }
    // The panel launches the CLI with \`--debug --debug-to-stderr\`, so a parked
    // conversation writes while nobody is reading. On the box that output was
    // resetting the reaper's clock, and five conversations last spoken to between
    // 1.6h and 22.8h earlier all reported an idle time of 194 seconds.
    if (text === 'chatter') {
      setInterval(() => process.stderr.write('[DEBUG] still here\\n'), 60);
      continue;
    }
    if (text === 'end-turn') {
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success' }) + '\\n');
      continue;
    }
    // A turn nobody typed. The real CLI takes cross-session messages, queued
    // messages and /loop wakeups on its OWN socket, so they never touch the stdin
    // the broker holds — the turn simply appears in the output. Driven by a file
    // for the same reason: the test has to start it without writing a byte here.
    if (text === 'watch-for-off-stream-turns') {
      const trigger = require('path').join(process.cwd(), '.off-stream');
      let last = '';
      setInterval(() => {
        let want = '';
        try { want = require('fs').readFileSync(trigger, 'utf8').trim(); } catch { return; }
        if (want === last) return;
        last = want;
        if (want === 'assistant') {
          process.stdout.write(JSON.stringify({
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: 'a peer asked me something' }] },
          }) + '\\n');
        }
        if (want === 'result') {
          process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success' }) + '\\n');
        }
      }, 40).unref();
      continue;
    }
    // A question put to whoever is driving, which is what the CLI does with
    // \`--permission-prompt-tool stdio\`: a control_request on STDOUT, and then nothing
    // until a control_response comes back. These frames are the real ones, captured
    // from claude 2.1.280 — a plain approval, and the one whose tool IS the question.
    if (text === 'ask-permission' || text === 'ask-question' || text === 'ask-slowly'
      || text === 'ask-unflagged') {
      const frame = JSON.stringify(text === 'ask-question' || text === 'ask-unflagged'
        ? {
          type: 'control_request',
          request_id: text === 'ask-unflagged' ? 'Q2' : 'Q1',
          request: {
            subtype: 'can_use_tool',
            tool_name: 'AskUserQuestion',
            display_name: 'AskUserQuestion',
            input: { questions: [{ question: 'Tabs or spaces?', header: 'Indentation' }] },
            tool_use_id: 'toolu_q',
            // The same frame without the flag, for the variant: what the CLI would
            // send if it ever stopped marking these, and the one field it cannot stop
            // sending is the name of the tool.
            ...(text === 'ask-unflagged' ? {} : { requires_user_interaction: true }),
          },
        }
        : {
          type: 'control_request',
          request_id: text === 'ask-slowly' ? 'P2' : 'P1',
          request: {
            subtype: 'can_use_tool',
            tool_name: 'Bash',
            display_name: 'Bash',
            input: { command: 'rm -rf /nowhere', description: 'Delete nothing' },
            permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
            tool_use_id: 'toolu_p',
          },
        }) + '\\n';
      // One byte at a time for the slow variant, so the frame is split inside its own
      // name and the broker has to bridge the seam to see it at all.
      if (text !== 'ask-slowly') {
        process.stdout.write(frame);
        continue;
      }
      let j = 0;
      const drip = setInterval(() => {
        if (j >= frame.length) { clearInterval(drip); return; }
        process.stdout.write(frame[j]);
        j += 1;
      }, 2);
      continue;
    }
    // A frame that NESTS one of those, unescaped, at a level that is not the top.
    // Valid JSON, not a question, and the case a substring match gets wrong — which
    // matters because a conversation reading this very file back would contain one.
    if (text === 'ask-inside-a-message') {
      process.stdout.write(JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'quoting the wire format at you' },
        quoted: { type: 'control_request', request_id: 'NOPE', request: { subtype: 'can_use_tool', tool_name: 'Bash' } },
      }) + '\\n');
      continue;
    }
    // The model saying something after a question was asked — the backstop for a
    // question the CLI abandoned without telling anyone.
    if (text === 'move-on') {
      process.stdout.write(JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'never mind, I found another way' }] },
      }) + '\\n');
      continue;
    }
    // The same event, one byte per write, so the broker sees it split across
    // chunks. The real CLI does this whenever a flush lands mid-token.
    if (text === 'end-turn-slowly') {
      const event = JSON.stringify({ type: 'result', subtype: 'success' }) + '\\n';
      let i = 0;
      const tick = setInterval(() => {
        if (i >= event.length) { clearInterval(tick); return; }
        process.stdout.write(event[i]);
        i += 1;
      }, 2);
      continue;
    }
    process.stdout.write(JSON.stringify({ type: 'echo', got: line }) + '\\n');
  }
});
process.stdin.on('end', () => process.exit(0));
setTimeout(() => process.exit(0), 15000).unref();
`,
  { mode: 0o755 },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pids = () =>
  fs.existsSync(PIDFILE)
    ? fs.readFileSync(PIDFILE, 'utf8').trim().split('\n').filter(Boolean).map(Number)
    : [];
const starts = () => pids().length;
const argvs = () =>
  fs.existsSync(ARGVFILE)
    ? fs.readFileSync(ARGVFILE, 'utf8').trim().split('\n').filter(Boolean)
    : [];
const lastPid = () => pids().at(-1);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const SESSION_ARGS = ['--input-format', 'stream-json', '--output-format', 'stream-json'];

/**
 * A wrapper-shaped client: speaks the framing, collects decoded stdout.
 *
 * `resume` goes into the args as well as into the handshake, because that is the
 * only shape the real client comes in: the wrapper reads the id out of the
 * extension's argv (`resumeIdFrom`), so a hello naming a session always has a
 * `--resume` beside it. A helper that sent one without the other let a check pass
 * on a command line the CLI would have refused.
 */
function connect({ resume, cwd = TMP, socket = SOCKET }) {
  const sock = net.connect(socket);
  const client = { sock, hello: null, out: '', frames: [] };
  let buffered = '';
  sock.on('data', (chunk) => {
    buffered += chunk.toString();
    const lines = buffered.split('\n');
    buffered = lines.pop() || '';
    for (const line of lines) {
      if (!line) continue;
      const frame = JSON.parse(line);
      if (!client.hello) {
        client.hello = frame;
        continue;
      }
      client.frames.push(frame);
      if (frame.s === 'out') client.out += Buffer.from(frame.d, 'base64').toString();
    }
  });
  return new Promise((resolve, reject) => {
    sock.on('error', reject);
    sock.on('connect', () => {
      sock.write(
        `${JSON.stringify({
          v: 1,
          cwd,
          claude: FAKE,
          args: resume ? [...SESSION_ARGS, `--resume=${resume}`] : SESSION_ARGS,
          resume,
          env: process.env,
        })}\n`,
      );
      resolve(client);
    });
  });
}

const send = (client, text) =>
  client.sock.write(
    `${JSON.stringify({ s: 'in', d: Buffer.from(text).toString('base64') })}\n`,
  );

/**
 * Say something, the way the panel says it: a `user` frame in stream-json.
 *
 * The distinction between this and `send` is the whole of the turn-detection fix.
 * The panel writes to stdin constantly without anybody typing — permission
 * requests, mode changes, auth checks — so "bytes were written" is not "a turn
 * began", and treating it as one latched every session on this box into
 * "working" and stopped the never-spoken-to probes from ever being reaped.
 */
const say = (client, text) =>
  send(
    client,
    `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`,
  );

/** What the panel sends unprompted. Written to stdin; not a turn. */
const CONTROL_FRAMES = [
  { type: 'control_request', request_id: '1', request: { subtype: 'set_permission_mode', mode: 'default' } },
  { type: 'control_response', response: { subtype: 'success', request_id: '1' } },
  { type: 'control_request', request_id: '2', request: { subtype: 'auth_status' } },
  // The awkward one: a permission answer quoting a path with `user` in it, so a
  // substring test for the word would call this a message.
  {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: '3',
      response: { behaviour: 'allow', updatedInput: { file_path: '/home/user/notes.md' } },
    },
  },
];

/**
 * Ask the broker what it is running, the way chat-service/claude-status.js does.
 *
 * A reader, not a page: it must not attach to anything, must not start anything,
 * and must not be counted as a client — otherwise polling status would keep
 * conversations alive and the badge would be the thing preventing the reap.
 */
function status() {
  return new Promise((resolve, reject) => {
    const sock = net.connect(SOCKET);
    let buffered = '';
    sock.on('error', reject);
    sock.on('connect', () => sock.write(`${JSON.stringify({ v: 1, op: 'status' })}\n`));
    sock.on('data', (chunk) => {
      buffered += chunk.toString();
      if (!buffered.includes('\n')) return;
      sock.destroy();
      try {
        resolve(JSON.parse(buffered.split('\n')[0]));
      } catch (err) {
        reject(err);
      }
    });
  });
}

/**
 * Run the wrapper the way the extension does: EXEC THE FILE, letting its shebang
 * choose node, with the real claude path as the first argument and the extension's
 * own args after it.
 *
 * Spawning `node wrapper …` here instead would be a comfortable lie. That is what
 * this test used to do, and it is why a wrapper the extension could not launch at
 * all passed every check: the extension only runs the configured path under node
 * when the path looks like JavaScript, and in that branch it puts the real binary
 * BEFORE the script, so node parses the ELF and the wrapper never runs. See the
 * header of `wrapper`. Exec it exactly as the extension does, or this file proves
 * nothing about the panel.
 *
 * `holdMs` keeps stdin open, because the extension holds it open for the life of
 * the session and closing it immediately would test a case that never happens.
 */
function runWrapper(args, env, { holdMs = 300 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(WRAPPER, [FAKE, ...args], {
      cwd: TMP, // same cwd as the test's clients, so joining is possible at all
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    setTimeout(() => child.stdin.end(), holdMs);
    child.on('exit', (code) => resolve({ code, out, err }));
  });
}

const isExecutable = (file) => {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * How the extension launches the wrapper, checked before anything it does.
 *
 * These are trivial, static assertions about a filename, and they are here
 * because the panel has already been broken by exactly that: `wrapper.js` made
 * the extension run `node <real claude> wrapper.js`, node parsed the ELF, and the
 * only symptom was a SyntaxError where Claude should have been. Every behavioural
 * check below this passed throughout, because they spawned the wrapper themselves
 * instead of the way the extension does.
 */
function checkLaunchContract() {
  section('The extension can launch the wrapper:');
  // Reads are guarded rather than allowed to throw: the likeliest way to fail this
  // section is renaming the wrapper back, and an ENOENT stack trace would bury the
  // one line that says what to do about it.
  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  ok(
    fs.existsSync(WRAPPER),
    'the wrapper is at claude-broker/wrapper — extensionless, as its header explains',
  );
  ok(
    !/\.(js|mjs|cjs|ts|tsx|jsx)$/.test(WRAPPER),
    'its path has no JS extension, so the extension execs it rather than running it under node',
  );
  ok(isExecutable(WRAPPER), 'it is executable, which being exec’d directly requires');
  ok(
    read(WRAPPER).startsWith('#!'),
    'and it opens with a shebang, which is what chooses node for it',
  );

  ok(
    /\bWRAPPER="\$HERE\/wrapper"/.test(read(path.join(HERE, 'install.sh'))),
    'install.sh points the editor setting at that exact file',
  );

  // Absent when this test runs from the deployed payload, which ships the broker
  // without deploy.sh.
  const deployPath = path.join(HERE, '..', 'deploy.sh');
  if (fs.existsSync(deployPath)) {
    ok(
      /claude-broker\/wrapper(?![.\w-])/.test(read(deployPath)),
      'deploy.sh puts it in the payload, so the box gets this file and not a stale one',
    );
  }
}

/**
 * The twelve-hour timeout, which had never once fired.
 *
 * Its own broker, because the only way to test a timeout in a second is to set it
 * to a second, and IDLE_MS is fixed at startup. Its own cwd per case, because the
 * fake CLI always announces `S1` and a second session in the same directory
 * re-keys onto the first one's key, displacing it — the displaced process then
 * leaves the map and no assertion about reaping means anything.
 *
 * What this pins down is which clock decides. `lastActivity` moves on every byte
 * the CLI writes, so on the box a parked conversation was kept alive by its own
 * debug output for as long as the box stayed up: nine processes, ~2.0GB, the
 * oldest last spoken to 22.8 hours earlier.
 */
async function checkUnattendedReaping() {
  section('A parked conversation is reaped on the attention clock, not the CLI’s chatter:');
  const socket = path.join(TMP, 'idle.sock');
  const IDLE = 1500;
  const broker = spawn(process.execPath, [path.join(HERE, 'broker.js')], {
    env: { ...process.env, CLAUDE_BROKER_SOCKET: socket, CLAUDE_BROKER_IDLE_MS: String(IDLE) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  broker.stdout.on('data', (d) => (log += d.toString()));
  broker.stderr.on('data', (d) => (log += d.toString()));
  for (let i = 0; i < 50 && !fs.existsSync(socket); i += 1) await sleep(100);

  const dirs = [];
  const freshCwd = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-test-idle-'));
    dirs.push(dir);
    return dir;
  };

  // A real conversation, left behind: spoken to, so detaching parks it rather
  // than stopping it, and its turn is finished, so nothing is in flight. Then it
  // chatters, which is the whole of the bug.
  const parked = await connect({ resume: null, cwd: freshCwd(), socket });
  await sleep(400);
  const parkedPid = lastPid();
  say(parked, 'a-real-first-message');
  await sleep(200);
  // Asked for before the turn is ended, because asking IS a message: a `chatter`
  // sent last would leave a turn in flight and the guard below would keep the
  // process alive for the right reason, proving nothing about the clock.
  say(parked, 'chatter');
  await sleep(200);
  say(parked, 'end-turn');
  await sleep(200);
  ok(alive(parkedPid), 'it is running while its page is open');
  parked.sock.destroy();

  // A turn still running is work. The old code protected it only by accident —
  // a working conversation is a writing one — and writing is exactly what this
  // stopped trusting, so the guard is now explicit and is worth a check.
  const working = await connect({ resume: null, cwd: freshCwd(), socket });
  await sleep(400);
  const workingPid = lastPid();
  say(working, 'a-question-with-no-end-turn');
  await sleep(200);
  working.sock.destroy();

  // And attention keeps a conversation: a page that is still attached holds one
  // open however long the CLI has nothing to say.
  const held = await connect({ resume: null, cwd: freshCwd(), socket });
  await sleep(400);
  const heldPid = lastPid();
  say(held, 'a-real-first-message');
  await sleep(200);
  say(held, 'end-turn');

  await sleep(IDLE + 1500);
  ok(!alive(parkedPid), 'a parked conversation is stopped once nobody has attended it');
  ok(log.includes('unattended'), 'and the log says so in the terms of the decision');
  ok(alive(workingPid), 'a turn in flight is never reaped, whatever the clocks say');
  ok(alive(heldPid), 'and an attached page holds its conversation open indefinitely');

  held.sock.destroy();
  broker.kill('SIGTERM');
  await sleep(400);
  broker.kill('SIGKILL');
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  return log;
}

async function main() {
  checkLaunchContract();

  const broker = spawn(process.execPath, [path.join(HERE, 'broker.js')], {
    env: { ...process.env, CLAUDE_BROKER_SOCKET: SOCKET },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let brokerLog = '';
  broker.stdout.on('data', (d) => (brokerLog += d.toString()));
  broker.stderr.on('data', (d) => (brokerLog += d.toString()));

  for (let i = 0; i < 50 && !fs.existsSync(SOCKET); i += 1) await sleep(100);
  ok(fs.existsSync(SOCKET), 'broker is listening on its socket');

  section('One page starts a conversation:');
  const a = await connect({ resume: null });
  await sleep(600);
  ok(a.hello && a.hello.ok === true, 'the broker accepts it');
  ok(a.hello.joined === false, 'it is reported as a new conversation');
  ok(a.out.includes('"session_id":"S1"'), 'the page receives the CLI init event');
  ok(starts() === 1, 'exactly one claude was started');

  section('A second device joins the SAME live conversation:');
  const b = await connect({ resume: 'S1' });
  await sleep(600);
  ok(b.hello && b.hello.ok === true, 'the broker accepts it');
  ok(b.hello.joined === true, 'it is reported as a join, not a new conversation');
  ok(b.out.includes('"session_id":"S1"'), 'the joining page is replayed the stream so far');
  ok(starts() === 1, 'still exactly one claude — this is the fork that used to happen');

  section('A conversation is found by its id, not by the directory it is asked for:');
  /*
   * The worktree case, and the panel case, which are one bug. A session that moves
   * into `.claude/worktrees/<name>` mid-conversation keeps the directory it was
   * keyed under while its transcript moves below it, so the next device asks for
   * the conversation under a path this broker has never seen. Matching on the pair
   * alone missed the live process and started a second one on its transcript.
   */
  const elsewhere = await connect({ resume: 'S1', cwd: path.join(TMP, 'worktrees', 'wt') });
  await sleep(500);
  ok(elsewhere.hello?.joined === true, 'a different cwd for the same id still joins');
  ok(starts() === 1, 'and starts nothing — the id is the conversation');
  elsewhere.sock.write(`${JSON.stringify({ s: 'detach' })}\n`);
  await sleep(300);

  section('Both devices drive the one process:');
  send(a, 'from-the-phone\n');
  await sleep(500);
  ok(a.out.includes('from-the-phone'), 'the sender sees the reply');
  ok(b.out.includes('from-the-phone'), 'the other device sees it too, live');
  send(b, 'from-the-laptop\n');
  await sleep(500);
  ok(a.out.includes('from-the-laptop'), 'input from either device reaches the same process');
  ok(starts() === 1, 'and it is still one process');

  section('Closing one page does not end the conversation:');
  b.sock.write(`${JSON.stringify({ s: 'detach' })}\n`);
  await sleep(400);
  send(a, 'still-here\n');
  await sleep(500);
  ok(a.out.includes('still-here'), 'the remaining device keeps working');
  ok(starts() === 1, 'no process was restarted');

  section('The wrapper fails safe:');
  const noBroker = await runWrapper(SESSION_ARGS, {
    CLAUDE_BROKER_SOCKET: path.join(TMP, 'nope.sock'),
  });
  ok(
    noBroker.out.includes('"session_id":"S1"'),
    'with no broker reachable it runs Claude directly',
  );
  ok(noBroker.code === 0, 'and exits cleanly');
  ok(starts() === 2, 'that fallback really was its own process');

  const oneShot = await runWrapper(['--version'], { CLAUDE_BROKER_SOCKET: SOCKET });
  ok(
    oneShot.out.includes('"session_id":"S1"'),
    'a one-shot invocation bypasses the broker rather than joining a conversation',
  );
  ok(starts() === 3, 'so it got its own process');

  const forked = await runWrapper([...SESSION_ARGS, '--fork-session'], {
    CLAUDE_BROKER_SOCKET: SOCKET,
  });
  ok(forked.out.includes('"session_id":"S1"'), '--fork-session is honoured, not merged');

  section('The wrapper goes through the broker when it can:');
  const startsBefore = starts();
  const viaBroker = await runWrapper([...SESSION_ARGS, '--resume=S1'], {
    CLAUDE_BROKER_SOCKET: SOCKET,
  });
  ok(
    viaBroker.out.includes('"session_id":"S1"'),
    'it joins the live conversation and is replayed it',
  );
  ok(starts() === startsBefore, 'joining started no new claude — the fork is gone');
  ok(viaBroker.code === 0, 'and the page leaving is not reported as a failure');
  await sleep(300);
  send(a, 'after-the-wrapper-left\n');
  await sleep(500);
  ok(
    a.out.includes('after-the-wrapper-left'),
    'the conversation survived that page closing',
  );

  section('It can say whether Claude is working, which nothing else can:');
  /*
   * The one fact about a conversation that is not on disk. A transcript records
   * what was said, not whether anything is still saying it — there is no turn-end
   * marker in the .jsonl at all — so a device that has just opened a conversation
   * cannot work out whether to wait for the history or simply reply. This process
   * holds the stream, so it is the only thing that knows.
   */
  const startsBeforeStatus = starts();
  const mineNow = async () => ((await status()).sessions || []).find((s) => s.cwd === TMP);

  const answered = await status();
  const mine = (answered.sessions || []).find((s) => s.cwd === TMP);
  ok(answered.ok === true && Array.isArray(answered.sessions), 'the broker answers a status request');
  ok(mine?.sessionId === 'S1', 'it names the conversation the way a device would ask for it');
  ok(starts() === startsBeforeStatus, 'asking for status started no process');
  ok(mine?.clients === 1, 'the page driving it is counted');
  // Plenty of bytes have crossed this session by now — the echo checks above sent
  // them — and none of them was a message.
  ok(mine?.working === false, 'bytes crossing the stream are not, by themselves, a turn');
  ok(mine?.spokeMs === null, 'and nothing is claimed about when it was last spoken to');

  /*
   * The bug this section exists for, and the reason the badge read "working" on
   * conversations nobody had touched.
   *
   * The panel writes to stdin without anybody typing: it runs with
   * `--permission-prompt-tool stdio`, so every tool approval, permission-mode
   * change and auth check is a `control_request`/`control_response` frame going
   * the same way a message goes. None of them draws a `result`, so a broker that
   * counted any write as the start of a turn latched "working" on and never
   * cleared it. Measured on the box before this fix: 11 of 13 live sessions
   * claimed to be working, nine of them processes that had never run a turn.
   */
  for (const frame of CONTROL_FRAMES) send(a, `${JSON.stringify(frame)}\n`);
  await sleep(400);
  const controlled = await mineNow();
  ok(controlled?.working === false, 'the panel’s own control frames do not put a conversation to work');
  ok(controlled?.spokeMs === null, 'nor are they mistaken for somebody typing');

  say(a, 'a-real-question');
  await sleep(400);
  const asked = await mineNow();
  ok(asked?.working === true, 'a user message does — which is what "working" is supposed to mean');
  ok(typeof asked?.spokeMs === 'number', 'and the time since it is reported, so a stale flag can be caught');

  say(a, 'end-turn');
  await sleep(400);
  const after = await mineNow();
  ok(after?.working === false, 'and it is not working once the turn has ended');
  ok(after?.clients === 1, 'asking three times did not attach the reader as a page');
  ok(typeof after?.spokeMs === 'number', 'the last message is still remembered after the answer');
  // Nothing is claimed about `env`: it is the editor's whole environment, it only
  // reaches this daemon because the wrapper has to pass it through, and a status
  // reader has no business seeing it.
  ok(
    after && !('env' in after) && !('args' in after),
    'status does not hand out the environment the panel was launched with',
  );

  // A message need not arrive in one write. The panel's frames are large — a
  // pasted file is one `user` frame — and the socket splits where it likes, so a
  // detector that only looks at whole chunks would miss the turn and leave the
  // badge saying "your turn" while Claude is answering: the direction that makes
  // you type over live work.
  const message = `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: 'split-across-writes' },
  })}\n`;
  send(a, message.slice(0, 14));
  await sleep(200);
  ok((await mineNow())?.working === false, 'half a message is not yet a turn');
  send(a, message.slice(14));
  await sleep(300);
  ok((await mineNow())?.working === true, 'and the rest of it makes one, across the seam');

  // A `result` arriving a byte at a time is invisible to any single chunk, and the
  // symptom of missing it is a badge stuck on "working" until the next turn ends —
  // which is precisely when nobody would think to look at this code.
  say(a, 'end-turn-slowly');
  await sleep(900);
  const dribbled = await mineNow();
  ok(dribbled?.working === false, 'a result split across chunks still ends the turn');

  /*
   * A turn this daemon never saw begin.
   *
   * Not every turn starts with a device hitting send. Another Claude session can
   * message this one, a queued message can be flushed, a /loop wakeup or a cron can
   * fire — and all of those reach the CLI by its own socket, leaving stdin silent.
   * Before this was read off the output stream, `working` stayed false for the whole
   * turn: koinespace 44e6ff2e took a cross-session message at 02:48:02 on
   * 2026-09-21, was still running a tool five minutes later, and status called it
   * idle three polls running. That is the direction that makes a device type over
   * live work, and it is also what put "Claude finished" on a phone repeatedly for
   * one conversation that had not finished anything.
   */
  const trigger = path.join(TMP, '.off-stream');
  // Armed with raw bytes, not a `user` frame: arming must not itself be a turn, or
  // this proves nothing about where the flag came from.
  send(a, 'watch-for-off-stream-turns\n');
  await sleep(300);
  ok((await mineNow())?.working === false, 'arming it is not a turn either');

  // Somebody really did type in this conversation, further up — so what is being
  // checked is that the peer's turn did not RESET that clock. `spokeMs` counts up
  // from the last human message; a peer event mistaken for one would drop it to
  // nearly zero and point every device at whichever conversation a robot last
  // prodded, because that clock is what picks the conversation someone is in.
  const spokeBefore = (await mineNow())?.spokeMs;
  fs.writeFileSync(trigger, 'assistant');
  await sleep(400);
  const peerDriven = await mineNow();
  ok(peerDriven?.working === true, 'the model producing is a turn, even with nothing written to stdin');
  ok(peerDriven?.spokeMs >= spokeBefore, 'a peer session prodding it is traffic, not somebody speaking');

  fs.writeFileSync(trigger, 'result');
  await sleep(400);
  ok((await mineNow())?.working === false, 'and that turn ends the same way every other one does');
  fs.rmSync(trigger, { force: true });

  section('It can say when Claude is waiting for YOU, which "working" cannot:');
  /*
   * The state "working" has always covered for, and the reason the badge is worth
   * looking at at all. A permission prompt and an `AskUserQuestion` are both a turn in
   * flight — the flag is right — and both mean nothing whatsoever will happen until a
   * person clicks something. Measured on the transcripts on this box: 71 answered
   * questions, a median wait of three minutes, a longest of 5.9 hours, and three
   * conversations sitting on an unanswered one, every minute of it reported as work in
   * progress. The prompt is on stdout and the answer comes back up stdin, so this
   * daemon is the only thing that sees either.
   */
  const answer = (id) => send(a, `${JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: id, response: { behavior: 'allow' } },
  })}\n`);

  say(a, 'ask-permission');
  await sleep(400);
  const prompted = await mineNow();
  ok(prompted?.working === true, 'a conversation stopped at a permission prompt is still working');
  ok(prompted?.awaiting === 'permission', 'and now says what it is working on is an answer from you');
  ok(prompted?.awaitingName === 'Bash', 'named by the tool it is asking about, never by its input');
  ok(typeof prompted?.awaitingMs === 'number', 'with how long it has been sitting there, so a stuck one can be found');

  answer('P1');
  await sleep(300);
  const clicked = await mineNow();
  ok(clicked?.awaiting === null, 'clicking an answer clears the wait');
  ok(clicked?.working === true, 'and leaves the turn as in flight as it was — the tool now runs');

  // The question worth telling from a prompt: this one is a decision, not a click, and
  // the CLI marks it as such rather than leaving it to be guessed from the tool name.
  say(a, 'ask-question');
  await sleep(400);
  const asking = await mineNow();
  ok(asking?.awaiting === 'question', 'a question is reported as a question, not as a permission prompt');
  ok(asking?.awaitingName === 'AskUserQuestion', 'and names the tool that asked it');

  say(a, 'end-turn');
  await sleep(400);
  const abandoned = await mineNow();
  ok(abandoned?.working === false, 'a turn that gives up on its question ends like any other');
  ok(abandoned?.awaiting === null, 'and takes the question with it, rather than asking forever');

  /*
   * The same frame with the flag missing, on the cleared slate the turn above left so
   * that it is this frame being read and not the one before it. It is a question
   * because of what asked: a CLI that stopped marking these would otherwise turn every
   * question on this box back into a permission prompt — for a tool called
   * AskUserQuestion, which is the badge admitting it does not know what it is showing.
   */
  say(a, 'ask-unflagged');
  await sleep(400);
  ok((await mineNow())?.awaiting === 'question',
    'a question that forgot to say it needs a person is still a question');
  answer('Q2');
  await sleep(300);
  ok((await mineNow())?.awaiting === null, 'and is answered like any other');

  // A prompt dribbled out a byte at a time is split inside its own name, so nothing
  // that looks at one chunk can see it. The symptom of missing it is the badge this
  // whole section exists to fix, silently back to saying "working".
  say(a, 'ask-slowly');
  await sleep(900);
  ok((await mineNow())?.awaiting === 'permission', 'a prompt split across chunks is still seen');

  // The other way a question ends: the client gives up on it. Written as the extension
  // writes it, with the id at the top level rather than nested under a response.
  send(a, `${JSON.stringify({ type: 'control_cancel_request', request_id: 'P2' })}\n`);
  await sleep(300);
  ok((await mineNow())?.awaiting === null, 'and a cancelled one stops being waited for');

  // The backstop, for a question the CLI abandons without saying so — a dialog it
  // times out on, a request whose client went away. Neither writes anything up the
  // stdin this daemon holds, so the model's next word has to be what settles it.
  say(a, 'ask-permission');
  await sleep(400);
  ok((await mineNow())?.awaiting === 'permission', 'a fresh prompt is waiting again');
  say(a, 'move-on');
  await sleep(400);
  const movedOn = await mineNow();
  ok(movedOn?.awaiting === null, 'the model producing again ends the wait, whoever settled it');
  ok(movedOn?.working === true, 'and that is a turn in flight, not your turn');

  // Parsed, not matched. A tool result quoting the wire format is escaped inside its
  // own JSON and cannot match, but a frame that legitimately nests one is not escaped
  // — and reading this file back into a conversation produces exactly that.
  say(a, 'ask-inside-a-message');
  await sleep(400);
  ok((await mineNow())?.awaiting === null, 'a message that merely nests one of these frames is not one');
  say(a, 'end-turn');
  await sleep(300);

  section('A process nobody ever spoke to is not parked for twelve hours:');
  // The panel spawns TWO claudes per page load — a probe with no `--resume` that
  // it never writes to, then the real conversation — so this is per page load,
  // not per conversation. Ten of them were resident on the box at 205MB each.
  //
  // These use their own cwd because the fake CLI always announces the same id,
  // and re-keying a second session onto `TMP|S1` would displace the conversation
  // the section above is still using.
  const ALT = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-test-alt-'));
  const probe = await connect({ resume: null, cwd: ALT });
  await sleep(500);
  const probePid = lastPid();
  ok(probe.hello?.ok === true && alive(probePid), 'the probe runs while its page is open');
  // The frames the panel really does send such a process — and the reason this
  // reaping stopped working when "spoken to" meant "written to". Nine probes were
  // parked on the box at ~210MB each, every one of them held alive by traffic
  // nobody typed.
  for (const frame of CONTROL_FRAMES) send(probe, `${JSON.stringify(frame)}\n`);
  await sleep(300);
  // Destroyed rather than detached politely: a torn-down extension host is how
  // this actually happens.
  probe.sock.destroy();
  await sleep(800);
  ok(!alive(probePid), 'and is stopped when that page goes away, control frames and all');

  const spoken = await connect({ resume: null, cwd: ALT });
  await sleep(500);
  const spokenPid = lastPid();
  say(spoken, 'a-real-first-message');
  await sleep(400);
  spoken.sock.destroy();
  await sleep(800);
  ok(
    alive(spokenPid),
    'but a conversation that was spoken to still outlives its last page — the point of all this',
  );
  fs.rmSync(ALT, { recursive: true, force: true });

  section('A conversation another service is running is forked, not joined in:');
  /*
   * The incident of 2026-10-25, reproduced. `chat-service` runs its own `claude`
   * for every chat in the phone UI — a different service, a different process
   * tree, nothing this daemon can see over its socket. A chat was started there,
   * the editor's panel came up 71 seconds later and resumed that same id (the
   * newest transcript in the folder it had open), and for ten minutes two
   * processes held one conversation. The phone's did the work; the panel's sat on
   * the history it read at startup, and when the user typed, the stale one
   * answered — re-ran a survey the other had finished, overwrote its output, and
   * reported that "another session" was doing the job. It was itself.
   *
   * So a resume whose id is already held outside this daemon is answered with
   * `--fork-session`: the page opens, reads the same history, and writes its own
   * transcript. What must not happen is a second process on the original.
   */
  const FOREIGN = 'aaaaaaaa-0000-4000-8000-000000000001';
  const FORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-test-fork-'));
  // argv[0] has to end in `/claude` for this to count as a conversation rather
  // than as something merely holding a claude path — which is exactly what the
  // wrapper's own argv is, and counting those would stop a second page joining a
  // shared conversation at all. A symlink to node is the cheapest real one.
  const FOREIGN_BIN = path.join(FORKDIR, 'claude');
  fs.symlinkSync(process.execPath, FOREIGN_BIN);
  const SLEEPER = path.join(FORKDIR, 'sleep.js');
  fs.writeFileSync(SLEEPER, 'setTimeout(() => {}, 60000);\n');
  // Spawned by the test, so its parent is not the broker: that is the whole
  // distinction the guard turns on, and it is read from /proc rather than trusted.
  const foreign = spawn(FOREIGN_BIN, [SLEEPER, '--session-id', FOREIGN], { stdio: 'ignore' });
  await sleep(300);

  const startsBeforeFork = starts();
  const forkPage = await connect({ resume: FOREIGN, cwd: FORKDIR });
  await sleep(700);
  ok(forkPage.hello?.ok === true, 'the page still opens — a page that will not open is worse');
  ok(forkPage.hello?.joined === false, 'and is told it is a new conversation, which it is');
  ok(starts() === startsBeforeFork + 1, 'one process was started for it');
  const forkArgv = argvs().at(-1) || '';
  ok(forkArgv.includes('--fork-session'), 'and it was started as a fork', forkArgv);
  ok(
    forkArgv.includes(`--resume=${FOREIGN}`) || forkArgv.includes(`--resume ${FOREIGN}`),
    'resuming the same history, so the page reads the conversation it asked for',
    forkArgv,
  );
  const forkSessions = (await status()).sessions || [];
  ok(
    !forkSessions.some((s) => s.sessionId === FOREIGN),
    'nothing here claims the id the other service is running',
  );
  ok(alive(foreign.pid), 'and the process that owns it was left alone');

  forkPage.sock.destroy();
  foreign.kill();
  await sleep(300);
  fs.rmSync(FORKDIR, { recursive: true, force: true });

  section('What the CLI calls a conversation beats what argv asked for:');
  /*
   * The id in argv is the earliest guess at a conversation's name, not the
   * answer: the CLI hands a fork a new one, and it does the same to a `--resume`
   * of an id it cannot find. Keying on the guess leaves this daemon holding a
   * process under a conversation that is not in it — and then the conversation
   * that IS in it is found by nobody, which is how a second writer gets started.
   */
  const RENAMED = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-test-renamed-'));
  const askedFor = await connect({ resume: 'bbbbbbbb-0000-4000-8000-000000000002', cwd: RENAMED });
  await sleep(700);
  ok(askedFor.hello?.ok === true, 'the page opens');
  const renamedSessions = (await status()).sessions || [];
  ok(
    renamedSessions.some((s) => s.cwd === RENAMED && s.sessionId === 'S1'),
    'and the session is reported under the id the CLI announced',
  );
  const byRealId = await connect({ resume: 'S1', cwd: RENAMED });
  await sleep(500);
  ok(byRealId.hello?.joined === true, 'so a page arriving with that id joins it');
  askedFor.sock.destroy();
  byRealId.sock.destroy();
  await sleep(300);
  fs.rmSync(RENAMED, { recursive: true, force: true });

  const idleLog = await checkUnattendedReaping();

  broker.kill('SIGTERM');
  await sleep(500);
  broker.kill('SIGKILL');

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) {
    console.log('\nbroker log:\n' + brokerLog);
    console.log('\nreaper broker log:\n' + idleLog);
    process.exit(1);
  }
  fs.rmSync(TMP, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
