#!/usr/bin/env node
//
// One `claude` process per conversation, shared by every browser page.
//
// The problem it solves: code-server creates one extension host per browser
// page, and the Claude Code panel's `claude` is a child of that host. Open the
// same project on a phone and a laptop and you get two processes resuming one
// session id, both appending to one transcript, telling two different stories.
// Observed on this box: two extension hosts, three `claude` processes, one
// project. The panel cannot fix this itself — nothing shares an extension host
// between two page loads.
//
// So the panel's stdio is routed here through claude-broker/wrapper, and this
// keeps the process. Both pages then drive the same conversation.
//
// It is deliberately BYTE-TRANSPARENT. It does not translate the stream-json
// vocabulary the way chat-service/session-manager.js does, because it is not
// building a UI — it is standing in for a pipe. Whatever the CLI writes, each
// attached page receives verbatim, which is what lets the extension's own UI
// keep working without knowing any of this is happening.
//
// Security: the control channel is a unix socket inside a 0700 directory owned by
// the service user, never a TCP port. Anything that can write to it can run
// `claude` as that user — but anything that can write to it already has that
// user's shell, so this adds no reachable surface. Do not move it to a port.
import net from 'net';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const SOCKET =
  process.env.CLAUDE_BROKER_SOCKET || '/run/claude-broker/broker.sock';

// Replay is all-or-nothing: a page that joins mid-conversation is sent every
// byte the CLI has written, because a partial stream cannot be rendered
// coherently. So the buffer is capped, and a conversation that outgrows it stops
// accepting new pages rather than handing one a broken stream — that page then
// gets its own process, which is only today's behaviour, not a failure.
const MAX_LOG_BYTES = Number(process.env.CLAUDE_BROKER_MAX_LOG || 64 * 1024 * 1024);

// A conversation nobody is watching is still worth keeping — that is the entire
// point — but not forever, or every conversation ever opened stays resident.
const IDLE_MS = Number(process.env.CLAUDE_BROKER_IDLE_MS || 12 * 60 * 60 * 1000);

/*
 * The end of a turn, as it appears in the stream.
 *
 * This is the one thing about a conversation that cannot be recovered from disk.
 * A transcript records what was said, not whether anything is still saying it:
 * there is no turn-end marker in the .jsonl at all — 0 `result` entries across
 * every transcript on the box, against 5606 `assistant` entries. So "is Claude
 * working right now, or is it my turn" exists in this process and nowhere else,
 * which is what `op: 'status'` is for.
 *
 * Matched as a substring rather than by parsing each line. This runs on every
 * chunk of every conversation, and one bit does not justify JSON.parse over a
 * stream that can reach MAX_LOG_BYTES. The failure mode is also the harmless
 * one: a missed `result` leaves the answer at "working" until the next turn
 * ends, which is a stale badge, not a broken conversation.
 */
const RESULT_EVENT = '"type":"result"';

/*
 * The start of a turn: a user message, and ONLY a user message.
 *
 * The panel's stdin carries far more than what someone typed. It launches Claude
 * with `--permission-prompt-tool stdio`, `--enable-auth-status` and
 * `--setting-sources`, and every permission decision, mode change and auth probe
 * comes back down this same pipe as a `control_request`/`control_response` frame.
 *
 * Treating any write as the beginning of a turn therefore latched `turnInFlight`
 * on permanently, because a control frame draws no `result` to clear it. Measured
 * on the box before this fix: 11 of 13 live sessions reported "working", nine of
 * them processes that had never run a single turn. A badge that says "working"
 * about everything answers nothing.
 *
 * So the input side is parsed by line, unlike the output side. It can afford to
 * be: this is what a person typed, not what the model produced.
 */
const USER_MESSAGE = '"type":"user"';

/*
 * The model producing, as it appears in the stream — and the only turn-start
 * signal that sees every turn.
 *
 * A turn does not have to begin with a device typing. It also begins when another
 * Claude session sends this one a message, when a queued message is flushed, when
 * a /loop wakeup or a cron fires, or when a hook injects one. All of those reach
 * the CLI by its own socket, not down the stdin this daemon holds, so
 * `#noteTurnStart` never sees them and `turnInFlight` stayed false for the whole
 * turn. Measured on the box before this fix: koinespace session 44e6ff2e took a
 * cross-session message at 02:48:02, was running a tool five minutes later, and
 * `op: 'status'` called it idle throughout — three polls in a row — while the
 * transcript plainly read `working`. A badge that says "your turn" while Claude is
 * mid-tool is the direction that makes you type over live work, which is the one
 * thing this flag exists to prevent.
 *
 * So the *output* side decides a turn has begun: an assistant event means the
 * model is producing, whoever asked. That cannot latch on the way counting any
 * stdin write did, for two reasons — a `result` always follows an assistant event
 * in the same turn and clears it, and a resumed conversation replays nothing.
 * Checked on this box: `--resume` with `--input-format stream-json` writes not one
 * byte to stdout until it is spoken to, so there is no history to mistake for work.
 */
const ASSISTANT_EVENT = '"type":"assistant"';

/*
 * A question the CLI has put to whoever is driving it, as it appears on stdout.
 *
 * `turnInFlight` answers "is Claude working, or is it my turn", and there is a third
 * state it cannot express: Claude is working *on you*. A permission prompt and an
 * `AskUserQuestion` are both a `control_request` written to stdout, after which the
 * CLI blocks until a `control_response` comes back up stdin. No `result` is written
 * in the meantime, so the turn is legitimately in flight — and nothing will move
 * until a person clicks something. Measured on the transcripts here: a median wait of
 * three minutes on an answered question and a longest of 5.9 hours, every minute of
 * it reported as "working".
 *
 * The two subtypes are the two that only a person can settle, verified against the
 * CLI this box runs (2.1.280) by driving it with `--permission-prompt-tool stdio` and
 * reading its stdout:
 *
 *   can_use_tool         a permission prompt. `requires_user_interaction: true`
 *                        marks the ones whose whole purpose is to ask — that is how
 *                        `AskUserQuestion` arrives — and its absence a plain approval.
 *   request_user_dialog  a tool asking the client to render a blocking dialog.
 *
 * Everything else on this channel is the client asking the CLI (`set_permission_mode`,
 * `auth_status`, `initialize`), which is traffic, not a question. See ASK_SUBTYPES.
 */
const ASK_EVENT = '"type":"control_request"';

/** The two the client answers, and what each one is to a person looking at a badge. */
const ASK_SUBTYPES = new Map([
  ['can_use_tool', 'permission'],
  ['request_user_dialog', 'question'],
]);

/**
 * The tool that is nothing but a question, so a prompt for it is never an approval.
 * `chat-service/claude-status.js` names the same tool for the same reason, from the
 * transcript rather than the wire.
 */
const ASK_TOOL = 'AskUserQuestion';

/*
 * The answer, going the other way: `{"type":"control_response","response":{…,
 * "request_id":…}}` on stdin, or a `control_cancel_request` when the client gives up
 * on one. The id is what ties it to the ask, and it is nested one level deeper on a
 * response than on a request — which is why this is read by parsing rather than by
 * matching, like everything else on the input side.
 */
const ANSWER_EVENTS = ['control_response', 'control_cancel_request'];

const NEWLINE = 0x0a;

/*
 * A single input line is normally tiny, but a pasted file is one line and can be
 * megabytes. Past this, stop waiting for the newline and decide on what is here.
 */
const MAX_INPUT_LINE = 256 * 1024;

const log = (...args) => console.log(new Date().toISOString(), ...args);

/** Sessions by merge key, plus a lookup by the id the CLI reports. */
const sessions = new Map();

function keyFor(cwd, id) {
  return `${cwd}|${id}`;
}

/**
 * The live session holding a conversation, whatever directory it was started in.
 *
 * The merge key is `(cwd, id)` because a page arriving to resume one knows both,
 * and keying on the pair is what keeps two projects' conversations apart. But the
 * conversation is the id: the same one can legitimately be asked for under two
 * different directories, and then the pair misses and a second process starts on
 * one transcript — the fork this daemon exists to prevent.
 *
 * It happens two ways, both observed. A session that moves into a worktree
 * mid-conversation (`EnterWorktree`, which this box's instructions ask for
 * whenever several sessions share a checkout) keeps the cwd it was keyed under
 * while its transcript moves to the worktree's directory, so the next device
 * resumes it under the worktree path. And the editor's panel resumes a
 * conversation under the folder it has open, which is the project root even when
 * the work has moved below it.
 *
 * So an explicit `--resume <id>` is answered by the process running that id, and
 * the cwd decides nothing. Nothing is lost by that: a conversation is in exactly
 * one process, and a page that asked for it by name wants that process.
 */
function liveBySessionId(sessionId) {
  for (const session of sessions.values()) {
    if (!session.exited && session.sessionId === sessionId) return session;
  }
  return null;
}

/**
 * A conversation's id as its own argv states it, or null.
 *
 * Both spellings of both flags, because the choice is not ours: the extension
 * writes `--resume=<id>` joined, a script writes `--session-id <id>` spaced, and
 * `chat-service/session-manager.js` names every conversation it starts this way
 * so that it can be found from outside the process holding it. `--resume` with no
 * value means "pick one interactively" and names nothing.
 */
const SESSION_ID_IN_ARGV = /--(?:resume|session-id)[=\0]([0-9a-fA-F-]{8,64})(?:\0|$)/;

/**
 * Whether an argv belongs to a `claude` process, as opposed to something merely
 * holding a claude path.
 *
 * The distinction is load-bearing here and nowhere else in this repository: the
 * wrapper's own argv is `node <wrapper> /path/to/claude --resume=<id> …`, so a
 * loose search for "claude" finds every brokered page as well as the process it
 * is brokered to. Counting those as owners would make the second page of a shared
 * conversation refuse to join the first — breaking the one property this daemon
 * is for. So only argv[0] counts, which is the program actually running.
 */
function isClaudeArgv(argv) {
  const [exe] = argv.split('\0');
  return exe === 'claude' || exe.endsWith('/claude');
}

/**
 * The pid of a `claude` outside this daemon that is already holding a session id,
 * or null.
 *
 * Why this daemon has to look: it is not the only thing on the box that runs
 * conversations. `chat-service` spawns its own `claude` for every chat in the
 * phone UI, and those are not brokered — different service, different process
 * tree, invisible over this socket. On 2026-10-25 a chat started in the phone UI
 * was given a session id by the CLI, and 71 seconds later the editor's panel came
 * up and resumed *that id* (the newest transcript in the folder it had open).
 * Both processes then held one conversation for ten minutes: the phone's did the
 * work, the panel's sat on the history it had read at startup, and when the user
 * typed, the stale one answered — re-ran a survey the other had already done,
 * overwrote its output file, and reported that "another session" was doing the
 * job. It was itself.
 *
 * `/proc` and argv rather than a lock file, because the question is "is a process
 * holding this conversation", and a pid in /proc is the only answer that cannot
 * go stale: a lock file outlives a kill -9 and a reboot, and this guard sits in
 * the path of opening the panel.
 *
 * Our own children are excluded by parentage, not by the session map, so a
 * conversation this daemon has lost track of is still recognised as ours.
 */
function ownerOutside(sessionId) {
  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return null; // no /proc: nothing can be said, and the old behaviour stands
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let argv;
    try {
      argv = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8');
    } catch {
      continue; // exited mid-sweep, or not ours to read
    }
    if (!argv.includes('claude') || !isClaudeArgv(argv)) continue;
    if (SESSION_ID_IN_ARGV.exec(argv)?.[1] !== sessionId) continue;
    let stat;
    try {
      stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
    } catch {
      continue;
    }
    // Field 4 of /proc/<pid>/stat is the ppid, and fields 1-2 can contain spaces
    // and brackets, so it is read from after the last `)` — the standard way.
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[1]);
    if (ppid === process.pid) continue; // one of ours
    return Number(entry);
  }
  return null;
}

class Session {
  constructor({ cwd, claude, args, env, key, sessionId = null }) {
    this.cwd = cwd;
    this.key = key;
    this.clients = new Set();
    this.chunks = [];
    this.logBytes = 0;
    this.truncated = false;
    // Known from argv when the page named what it was resuming, and only then —
    // a new conversation, and a fork of one, are both the CLI's to name. Set here
    // rather than waited for so that liveBySessionId can answer about this
    // conversation before its first byte of output. See #sniffSessionId.
    this.sessionId = sessionId;
    this.lastActivity = Date.now();
    /*
     * When a PERSON last had anything to do with this conversation: it was
     * created, a page attached or detached, or something was written to it.
     * Deliberately not bumped by the CLI's own output, which is what separates
     * this from `lastActivity`.
     *
     * IDLE_MS is measured against this, and has to be, or a parked conversation
     * never dies. `lastActivity` moves on every byte the CLI writes, and these
     * processes are launched by the panel with `--debug --debug-to-stderr`, so
     * they chatter while nobody is watching. Measured on the box before this
     * fix: five parked conversations, last spoken to between 1.6h and 22.8h
     * earlier, every one of them reporting an idle time of 194 seconds and all
     * five advancing in lockstep — one shared event resetting all five clocks,
     * over and over. The 12-hour reaper had therefore never fired for any of
     * them, and nine processes held ~2.0GB until someone found the Stop button.
     */
    this.attendedAt = Date.now();
    this.exited = false;
    // Whether anyone has ever sent this process a MESSAGE — not merely bytes. A
    // session that has not been spoken to holds no conversation: nothing was
    // asked, nothing is running, and its transcript is empty. See `detach`, and
    // see USER_MESSAGE for why the distinction is not academic: the panel writes
    // control frames to the probes it never uses, and counting those as being
    // spoken to parked nine of them on this box at ~210MB each.
    this.spokenTo = false;
    // Whether Claude owes an answer: set by a user message going in OR by the model
    // being heard producing, cleared by the `result` event that ends the turn. Both
    // starts are needed — see ASSISTANT_EVENT for the turns stdin never sees. This
    // is the stop-button-vs-send-button bit, and the reason anything asks this
    // service for status at all.
    this.turnInFlight = false;
    // Trailing bytes of the last chunk, so a `result` split across two chunks is
    // still seen. Copied rather than kept as a view into a stream buffer.
    this.turnTail = Buffer.alloc(0);
    // Partial input line, so a message split across two writes is still seen as
    // one frame. See #noteTurnStart.
    this.inputBuffer = '';
    /*
     * The questions the CLI has asked and nobody has answered: request id -> what it
     * is, what it is about, and when it was asked. Keyed by id because the answers can
     * come back out of order — three tools in one assistant turn are three prompts —
     * and insertion order is age order, which is what `statusSnapshot` reports.
     *
     * Empty is the normal state, and the flag it feeds is deliberately not `working`:
     * a session waiting on a person IS working by the only definition this daemon can
     * defend, and a badge that says so is exactly the one that has been useless. See
     * ASK_EVENT.
     */
    this.asks = new Map();
    // Trailing partial line of stdout, kept only while it could still turn out to be
    // one of those frames. See #noteAsks for why that condition and not a plain buffer.
    this.askTail = Buffer.alloc(0);
    // When someone last actually said something to this conversation, as opposed
    // to when the CLI last wrote a byte. This is what identifies the conversation
    // a person is in: a resumed one emits output while being read back, but only
    // the one being used is spoken to.
    this.spokeAt = null;
    // Only used to spot the init event; forwarding never waits on it.
    this.lineBuffer = '';
    // Whether the CLI has named this conversation yet. Tracked separately from
    // `sessionId`, which may already hold argv's guess at it. See #sniffSessionId.
    this.initSeen = false;

    this.proc = spawn(claude, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });

    this.proc.stdout.on('data', (chunk) => {
      this.lastActivity = Date.now();
      this.#record(chunk);
      this.#broadcast('out', chunk);
      this.#sniffSessionId(chunk);
      this.#noteTurnEdges(chunk);
      // After the turn edges, never before: the chunk that carries the model's tool
      // call can carry the prompt for it as well, and #noteTurnEdges is where a new
      // word from the model clears the questions that came before it.
      this.#noteAsks(chunk);
    });

    this.proc.stderr.on('data', (chunk) => {
      this.lastActivity = Date.now();
      // Not recorded for replay: stderr is diagnostics, and replaying old
      // warnings to a page that just joined would surface them as if they had
      // happened now. The extension watches stderr for real errors, so live
      // delivery still matters.
      this.#broadcast('err', chunk);
    });

    this.proc.on('exit', (code) => {
      this.exited = true;
      log(`session ${this.key} exited code=${code} clients=${this.clients.size}`);
      for (const client of this.clients) {
        this.#send(client, { s: 'exit', code });
      }
      this.#unregister();
    });

    this.proc.on('error', (err) => {
      this.exited = true;
      log(`session ${this.key} failed to start: ${err.message}`);
      for (const client of this.clients) {
        this.#send(client, { s: 'exit', code: 126 });
      }
      this.#unregister();
    });
  }

  #record(chunk) {
    if (this.truncated) return;
    this.logBytes += chunk.length;
    if (this.logBytes > MAX_LOG_BYTES) {
      this.truncated = true;
      this.chunks = [];
      this.logBytes = 0;
      log(`session ${this.key} exceeded ${MAX_LOG_BYTES} bytes; no longer joinable`);
      return;
    }
    this.chunks.push(Buffer.from(chunk));
  }

  /**
   * The CLI announces the real session id in its `system`/`init` event. A page
   * that started a NEW conversation had no id to key on, so the session is
   * re-keyed here — that is what lets a second device, which arrives with
   * `--resume=<that id>`, find this live process instead of starting its own.
   *
   * Runs even when argv already named the session, because the CLI is the
   * authority on what this conversation is called and argv is only the earliest
   * guess at it. The two disagree twice: a fork is given a new id, and so is a
   * `--resume` of an id the CLI cannot find. Trusting argv in either case would
   * leave this keyed under a conversation that is not the one in the process.
   */
  #sniffSessionId(chunk) {
    if (this.initSeen) return;
    this.lineBuffer += chunk.toString();
    const lines = this.lineBuffer.split('\n');
    this.lineBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim() || !line.includes('session_id')) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type === 'system' && event.session_id) {
        this.initSeen = true;
        this.sessionId = event.session_id;
        const newKey = keyFor(this.cwd, event.session_id);
        if (newKey !== this.key) {
          sessions.delete(this.key);
          this.key = newKey;
          sessions.set(newKey, this);
          log(`session re-keyed to ${newKey}`);
        }
        // Stop accumulating; this buffer exists only for this one lookup.
        this.lineBuffer = '';
        return;
      }
    }
  }

  /**
   * Notice the turn starting and ending, so `op: 'status'` can answer the only
   * question a joining device cannot answer for itself. Runs after the chunk has
   * already been forwarded: this is a badge, and nothing waits on it.
   *
   * Both edges are read from the output stream, and the start has to be, because
   * the input side cannot see every turn. See ASSISTANT_EVENT.
   */
  #noteTurnEdges(chunk) {
    // Enough trailing bytes to bridge two chunks: an occurrence that straddles the
    // boundary has at most this many bytes on the far side of it. Kept for the
    // longer of the two markers, and kept whatever the flag says — a turn has to
    // become visible before there is a turn to be in the middle of.
    const span = Math.max(RESULT_EVENT.length, ASSISTANT_EVENT.length) - 1;

    // The chunk on its own first — the common case, and it copies nothing. The
    // seam is only worth assembling when the chunk alone says nothing.
    const carries = (marker) => {
      if (chunk.includes(marker)) return true;
      if (!this.turnTail.length) return false;
      return Buffer.concat([this.turnTail, chunk.subarray(0, marker.length)]).includes(marker);
    };

    const producing = carries(ASSISTANT_EVENT);
    /*
     * The model producing again is the end of every question, whoever answered it.
     *
     * Needed because an ask is not always settled by an answer this daemon can see:
     * the CLI cancels a dialog it has given up on and abandons a permission request
     * whose client went away, and neither writes anything up the stdin held here. Both
     * end the same way — the tool comes back refused and the turn carries on — so the
     * model's next word is the backstop, and it is one this already knows about.
     *
     * Ordered before the frames in this chunk are read, because the chunk that carries
     * the model's tool call can carry the prompt for it too, and clearing after adding
     * would drop the very question that was just asked.
     */
    if (producing && this.asks.size) this.asks.clear();

    if (!this.turnInFlight && producing) {
      this.turnInFlight = true;
      // Something asked it something, so this process holds a conversation and is
      // not one of the panel's throwaway probes — `detach` must not stop it.
      //
      // `spokeAt` is deliberately left alone: it means a *person* spoke, and it is
      // what picks the conversation someone is looking at out of several live ones.
      // A peer session's message is traffic, not attention, and counting it would
      // point every device at whichever conversation a robot last prodded.
      this.spokenTo = true;
    }
    // Second, and not as an `else`: a chunk carrying the model's last words and the
    // `result` after them is a chunk that ended the turn.
    if (this.turnInFlight && carries(RESULT_EVENT)) {
      this.turnInFlight = false;
      // Nothing is waiting on an answer once the turn is over — an unanswered prompt
      // is why some turns end. Holding one past the turn would put "answer me" on a
      // conversation whose answer is that it gave up, which is the wrong half of the
      // only distinction any of this is for.
      this.asks.clear();
    }

    // The tail of the STREAM, not of this chunk. Keeping only the last chunk's
    // tail looks equivalent and is not: a CLI flushing a byte at a time — which it
    // does whenever a flush lands mid-token — then never accumulates enough
    // context to recognise anything, and neither edge is ever seen.
    this.turnTail = chunk.length >= span
      ? Buffer.from(chunk.subarray(chunk.length - span))
      : Buffer.from(Buffer.concat([this.turnTail, chunk]).subarray(-span));
  }

  /**
   * Notice a question the CLI has asked, so that "working" can stop covering for
   * "waiting for you". See ASK_EVENT for what those frames are and why the turn flag
   * cannot answer this.
   *
   * Parsed by line, not matched as a substring, and the reason is the same one the
   * input side has: the difference that matters is between a frame whose `type` is
   * `control_request` and a tool result that merely quotes one — reading this very
   * file back into a conversation would otherwise ask you to approve something. A
   * quoted frame is escaped inside its own JSON string, so it cannot match; a parse
   * makes that a fact rather than a hope.
   *
   * The cost is kept off the common path, because this runs on every byte the CLI
   * writes and a conversation can write MAX_LOG_BYTES of them. Per chunk that carries
   * no frame: one `lastIndexOf`, one `includes` over at most a line's worth of bytes,
   * and one over the chunk. Nothing is turned into a string until a completed line
   * really does carry one.
   */
  #noteAsks(chunk) {
    const buffered = this.askTail.length ? Buffer.concat([this.askTail, chunk]) : chunk;
    const nl = buffered.lastIndexOf(NEWLINE);
    const partial = nl === -1 ? buffered : buffered.subarray(nl + 1);
    /*
     * Carry the unfinished line only while it could still become one of these frames:
     * either it already names one, or it is short enough that the name is what the
     * chunk boundary cut in half — the CLI writes `type` first, so a line past that
     * length with no match is model output. Without the test, one long unfinished line
     * would put every later chunk of the conversation through the parse below; without
     * the carry, a frame split inside its own name would be missed, which the real CLI
     * does whenever a flush lands mid-token.
     */
    this.askTail = partial.includes(ASK_EVENT) || partial.length <= ASK_EVENT.length
      ? Buffer.from(partial)
      : Buffer.alloc(0);
    if (nl === -1) return;

    const complete = buffered.subarray(0, nl);
    if (!complete.includes(ASK_EVENT)) return;

    for (const line of complete.toString().split('\n')) {
      if (!line.includes(ASK_EVENT)) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue; // not a frame we can read; not a question we can claim
      }
      if (frame.type !== 'control_request' || !frame.request_id) continue;
      const kind = ASK_SUBTYPES.get(frame.request?.subtype);
      if (!kind) continue;
      this.asks.set(frame.request_id, {
        // `requires_user_interaction` is the CLI's own word for a request whose point
        // is to ask rather than to gate: it is how `AskUserQuestion` arrives, as a
        // `can_use_tool` for a tool that is a question. Verified against 2.1.280 — the
        // tool name is taken as the same answer because it is the part that cannot
        // quietly change: a CLI that stops setting the flag would otherwise downgrade
        // every question on this box to "a permission prompt for AskUserQuestion".
        kind: frame.request.requires_user_interaction || frame.request.tool_name === ASK_TOOL
          ? 'question'
          : kind,
        // What it is about — a tool name, or the kind of dialog — and never the input,
        // which is the file being written or the command being run and belongs to the
        // conversation, not to a status page.
        name: frame.request.tool_name || frame.request.dialog_kind || null,
        at: Date.now(),
      });
    }
  }

  /**
   * Whether these bytes contain the start of a turn — and, on the way past, the
   * answer to a question this session was waiting on.
   *
   * Line-buffered and parsed, rather than matched as a substring the way the
   * output side is, because the difference that matters here is between a frame
   * whose `type` is `user` and a control frame that merely mentions one — a
   * permission response carrying a tool input, say. A substring match on the
   * whole stream would call that a turn and latch the badge on, which is the bug
   * this replaces.
   *
   * The answers are read in the same pass for the same reason they are read at all:
   * this is where the panel's control traffic already arrives, it is a handful of
   * lines rather than a stream, and every one of them is already being parsed.
   */
  #noteTurnStart(chunk) {
    this.inputBuffer += chunk.toString();
    const lines = this.inputBuffer.split('\n');
    this.inputBuffer = lines.pop() || '';

    // Collected rather than returned from inside the loop: the same batch of lines
    // that starts a turn can settle the question the last turn was stuck on, and an
    // early return used to be free only because there was nothing else to look for.
    let started = false;

    if (this.inputBuffer.length > MAX_INPUT_LINE) {
      // A very long line: decide on what has arrived and stop accumulating. A
      // false positive here costs a badge that says "working" until the turn that
      // is almost certainly starting anyway ends.
      const looksLikeMessage = this.inputBuffer.includes(USER_MESSAGE);
      this.inputBuffer = '';
      if (looksLikeMessage) started = true;
    }

    for (const line of lines) {
      // Cheap gate before parsing: every frame either half cares about contains one
      // of these words, and the ones neither cares about are the common case. The
      // second test is skipped entirely while nothing is waiting to be answered.
      const settles = this.asks.size > 0 && ANSWER_EVENTS.some((type) => line.includes(type));
      if (!settles && !line.includes('user')) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue; // not a frame we can read; not a turn we can claim
      }
      if (frame.type === 'user') started = true;
      /*
       * The answer to a question, or the client giving up on one: either way nobody is
       * being waited for any more. Both ids are read rather than either assumed — a
       * response nests it under `response`, a cancel carries it at the top — and an id
       * that was never asked simply deletes nothing, which is what makes it safe to
       * read this off a channel the client also uses to ask questions of its own.
       */
      if (!settles) continue;
      const settled = frame.type === 'control_response'
        ? frame.response?.request_id
        : (frame.type === 'control_cancel_request' ? frame.request_id : null);
      if (settled) this.asks.delete(settled);
    }
    return started;
  }

  #send(client, frame) {
    if (client.destroyed) return;
    client.write(`${JSON.stringify(frame)}\n`);
  }

  #broadcast(kind, chunk) {
    const frame = { s: kind, d: chunk.toString('base64') };
    for (const client of this.clients) this.#send(client, frame);
  }

  #unregister() {
    if (sessions.get(this.key) === this) sessions.delete(this.key);
  }

  attach(client) {
    this.clients.add(client);
    this.lastActivity = Date.now();
    this.attendedAt = Date.now();
    // Everything written so far, so the page can rebuild its view. One frame per
    // recorded chunk keeps the byte stream identical to what a sole client saw.
    for (const chunk of this.chunks) {
      this.#send(client, { s: 'out', d: chunk.toString('base64') });
    }
    log(`session ${this.key} attached; clients=${this.clients.size}`);
  }

  detach(client) {
    this.clients.delete(client);
    this.lastActivity = Date.now();
    // The reaper's clock starts here for a conversation being left behind, which
    // is what keeps "read an old conversation, close the tab, come back" from
    // finding a dead process: leaving is attention too.
    this.attendedAt = Date.now();
    log(`session ${this.key} detached; clients=${this.clients.size}`);

    // Keeping a watched-by-nobody conversation is the entire point of this
    // service — but only if there is a conversation. The panel spawns TWO
    // processes on every page load: a probe (`--permission-mode default`, no
    // `--resume`) that it never writes a byte to, and then the real one. Left to
    // IDLE_MS, each page load therefore parked ~205MB for twelve hours; ten of
    // them were resident on the box (2.0GB of 7.8GB) after an afternoon of
    // reloading. Measured, not estimated: none of the ten had a transcript.
    //
    // Deliberately keyed on input rather than on the `pending:` key, because it
    // must never abort work. A session that WAS spoken to may have a turn in
    // flight, so it stays until IDLE_MS even when nothing can name it.
    //
    // `spokenTo` now means a real message rather than any byte, and
    // `turnInFlight` is belt and braces around that narrowing: a turn in flight
    // is work, so a message this parser somehow failed to recognise still has to
    // trip the second test before the process can be stopped.
    //
    // What deliberately is NOT tested here is `sessionId`. It is tempting — an
    // id looks like proof of a conversation — but every process announces one in
    // its own `system`/`init` event, probe included, so requiring the absence of
    // one would park every probe again and undo the whole of this.
    if (
      this.clients.size === 0 &&
      !this.spokenTo &&
      !this.turnInFlight &&
      !this.exited
    ) {
      log(`session ${this.key} never spoken to; stopping rather than parking it`);
      this.stop();
    }
  }

  write(data) {
    this.lastActivity = Date.now();
    this.attendedAt = Date.now();
    // Only a message starts a turn; the panel's control traffic does not. This is
    // the *early* half of the answer — it marks the turn from the moment someone
    // hits send, before the model has said anything back — and ASSISTANT_EVENT
    // catches the turns that never come through here at all. The remaining way to
    // be wrong is a missed `result`, which leaves a stale "working" — still the
    // right direction to be wrong in, because "working" makes you wait and look
    // again where "idle" makes you type over a live turn.
    if (this.#noteTurnStart(data)) {
      this.spokenTo = true;
      this.turnInFlight = true;
      this.turnTail = Buffer.alloc(0);
      this.spokeAt = Date.now();
    }
    if (this.proc.stdin.writable) this.proc.stdin.write(data);
  }

  stop() {
    this.proc.kill('SIGTERM');
  }
}

function handleConnection(client) {
  let session = null;
  let buffered = '';
  let handshook = false;

  client.on('error', () => client.destroy());

  client.on('data', (chunk) => {
    buffered += chunk.toString();
    const lines = buffered.split('\n');
    buffered = lines.pop() || '';

    for (const line of lines) {
      if (!line) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }

      if (!handshook) {
        handshook = true;
        // A reader, not a page. It attaches to nothing, starts nothing, and is
        // never counted as a client, so asking for status cannot keep a
        // conversation alive or hold one open.
        if (frame?.op === 'status') {
          respondStatus(client);
          return;
        }
        session = open(frame, client);
        continue;
      }
      if (!session) continue;

      switch (frame.s) {
        case 'in':
          session.write(Buffer.from(frame.d, 'base64'));
          break;
        case 'detach':
          session.detach(client);
          session = null;
          client.destroy();
          break;
        default:
          break;
      }
    }
  });

  client.on('close', () => {
    if (session) session.detach(client);
  });
}

/**
 * Answer "what is running, and is it working" for every live conversation.
 *
 * Why this is here and not read off the disk: opening a conversation on a second
 * device makes the panel re-read and re-render the whole transcript, which is
 * seconds of waiting on a large one — and the thing you actually want to know
 * first is whether to wait at all. If a turn is in flight the answer is coming and
 * the history is worth waiting for; if it is not, the last message is the only
 * thing you need before replying. Nothing on disk distinguishes those two states
 * (see RESULT_EVENT), and this process is the only one that sees the stream.
 *
 * Deliberately narrow. `env` and `args` are not reported: the env is the editor's
 * whole environment, it reaches this daemon only because the wrapper has to pass
 * it through, and a status reader has no use for it. What is here is what a device
 * needs to decide whether to wait, plus the pid, because the thing most likely to
 * be debugged over this socket is which process a conversation is actually in.
 */
function statusSnapshot() {
  const now = Date.now();
  return [...sessions.values()]
    .filter((session) => !session.exited)
    .map((session) => {
      /*
       * The oldest unanswered question, when there are several: three tools in one
       * assistant turn are three prompts, and the useful number is how long this has
       * been stuck rather than what it asked most recently. `asks` is keyed in the
       * order the questions were asked, so the first one out is the oldest.
       */
      const [asked] = session.asks.values();
      return {
        cwd: session.cwd,
        // Null until the CLI's init event names it — a conversation that has never
        // been spoken to has no id to report. See #sniffSessionId.
        sessionId: session.sessionId,
        working: session.turnInFlight,
        /*
         * The third state, and the one nothing outside this process can see: Claude is
         * working, and what it is working on is you. `working` stays true beside it —
         * the turn really is in flight — so a reader that has never heard of this gets
         * the answer it always got, and one that has can say which kind of wait it is.
         *
         * `permission` or `question`, what it is about, and how long it has been
         * sitting there. Null all round when nothing is waiting, which is the normal
         * state of a conversation and of every session on a CLI old enough not to ask.
         */
        awaiting: asked?.kind ?? null,
        awaitingName: asked?.name ?? null,
        awaitingMs: asked ? now - asked.at : null,
        clients: session.clients.size,
        idleMs: now - session.lastActivity,
        // How long since anyone attached, left, or wrote — the clock the reaper
        // actually runs on, so that "why is this still here" has an answer that
        // matches the decision. `idleMs` is since the CLI last wrote a byte, which
        // is a different question and answers nothing about lifetime.
        attendedMs: now - session.attendedAt,
        // How long since anyone said anything to this conversation, as opposed to
        // since the CLI last wrote a byte. Null if nobody ever has. This is what
        // tells "the conversation being used" from "a conversation being read
        // back": resuming one produces output without anyone typing.
        spokeMs: session.spokeAt === null ? null : now - session.spokeAt,
        pid: session.proc.pid,
      };
    });
}

/**
 * `v` and the `sessions` array are how a caller tells a real answer from an older
 * broker's reply. A broker without this op reads the frame as a handshake and
 * answers `{ok:false, why:'bad handshake'}` — which is a clean "cannot answer",
 * so a caller that checks for the array degrades instead of misreporting.
 */
function respondStatus(client) {
  client.write(`${JSON.stringify({ ok: true, v: 1, sessions: statusSnapshot() })}\n`);
  // Ended rather than destroyed, so the reply is flushed first.
  client.end();
}

/**
 * Decide whether this page joins a live conversation or starts one, and reply
 * with the verdict. A refusal is not an error: the wrapper falls back to running
 * the binary directly, so the worst case is the fork we have today.
 */
function open(hello, client) {
  if (!hello || hello.v !== 1 || !hello.cwd || !hello.claude) {
    client.write(`${JSON.stringify({ ok: false, why: 'bad handshake' })}\n`);
    client.destroy();
    return null;
  }

  const wanted = hello.resume ? keyFor(hello.cwd, hello.resume) : null;
  // The pair first, then the id alone: see liveBySessionId for why the directory
  // a conversation is asked for under is not the one it is running in.
  const existing = wanted
    ? sessions.get(wanted) || liveBySessionId(hello.resume)
    : null;

  if (existing && !existing.exited) {
    if (existing.truncated) {
      client.write(`${JSON.stringify({ ok: false, why: 'replay buffer full' })}\n`);
      client.destroy();
      return null;
    }
    client.write(`${JSON.stringify({ ok: true, joined: true })}\n`);
    existing.attach(client);
    return existing;
  }

  // A new conversation, or one whose process is gone. `pending:` keys a session
  // that has no id yet; #sniffSessionId re-keys it the moment the CLI says what
  // the id is, which is what makes it findable by the next device.
  let key = wanted || keyFor(hello.cwd, `pending:${process.hrtime.bigint()}`);
  let args = hello.args || [];

  /*
   * One conversation, one process. Nothing above found it here, so if something
   * outside this daemon is already holding the id, resuming it would make this
   * the second process appending to one transcript — see ownerOutside for what
   * that did on 2026-10-25.
   *
   * Answered with a FORK rather than a refusal: `--fork-session` replays the same
   * history into a new session id with its own transcript, so the page opens on
   * the conversation it asked for and reads correctly, while the process already
   * doing the work keeps sole ownership of the original. A refusal would send the
   * wrapper down its fallback path, which forks the *transcript* — the bug — and
   * a page that will not open is worse than either.
   *
   * The fork is keyed `pending:` deliberately. Its id is the CLI's to choose and
   * is not known until the init event; keying it under the id it was forked FROM
   * would hand the next page a different conversation than the one it named.
   */
  if (hello.resume && !args.includes('--fork-session')) {
    const owner = ownerOutside(hello.resume);
    if (owner !== null) {
      // `--fork-session` is meaningless to the CLI without something to resume,
      // and the wrapper only reports `resume` because it read it out of these
      // args — but a client that says what it is resuming without passing the
      // flag would otherwise be handed a command line the CLI refuses, and the
      // page would not open at all. So the flag is made true rather than assumed.
      const resuming = args.some((arg) => arg === '--resume' || arg.startsWith('--resume='));
      args = [...args, ...(resuming ? [] : ['--resume', hello.resume]), '--fork-session'];
      key = keyFor(hello.cwd, `pending:${process.hrtime.bigint()}`);
      log(
        `session ${hello.resume} is held by pid ${owner} outside this broker; ` +
          'starting a fork of it rather than a second writer',
      );
    }
  }

  let session;
  try {
    session = new Session({
      cwd: hello.cwd,
      claude: hello.claude,
      args,
      env: hello.env || process.env,
      key,
      // Null for a fork: it is a different conversation from the one named, and
      // the CLI has yet to say what it is called.
      sessionId: key === wanted ? hello.resume : null,
    });
  } catch (err) {
    client.write(`${JSON.stringify({ ok: false, why: err.message })}\n`);
    client.destroy();
    return null;
  }
  sessions.set(key, session);
  log(`session ${key} started pid=${session.proc.pid}`);
  client.write(`${JSON.stringify({ ok: true, joined: false })}\n`);
  session.attach(client);
  return session;
}

function reapIdle() {
  const now = Date.now();
  for (const session of [...sessions.values()]) {
    if (session.clients.size > 0) continue;
    // A turn still running is work, whatever the clocks say. `lastActivity` used
    // to stand in for this — a working conversation is a writing one — and that
    // is exactly the conflation that broke the timeout, so the guard is now its
    // own line and says what it means.
    if (session.turnInFlight) continue;
    if (now - session.attendedAt > IDLE_MS) {
      log(`session ${session.key} unattended for ${Math.round((now - session.attendedAt) / 60000)}m; stopping`);
      session.stop();
    }
  }
}

function main() {
  fs.mkdirSync(path.dirname(SOCKET), { recursive: true, mode: 0o700 });
  // A socket left behind by a killed broker would make every connect fail, and
  // the wrapper would silently fall back to forking for every page.
  try {
    fs.unlinkSync(SOCKET);
  } catch {
    /* not there; fine */
  }

  const server = net.createServer(handleConnection);
  server.on('error', (err) => {
    log(`server error: ${err.message}`);
    process.exit(1);
  });
  server.listen(SOCKET, () => {
    fs.chmodSync(SOCKET, 0o600);
    log(`listening on ${SOCKET}`);
  });

  // Once a minute against a twelve-hour timeout, and never coarser than the
  // timeout itself — a fixed minute would enforce a one-second IDLE_MS a minute
  // late, which is the difference between a test that proves the reaper works and
  // one that waits for it.
  setInterval(reapIdle, Math.max(50, Math.min(60 * 1000, Math.floor(IDLE_MS / 4)))).unref();

  // Leave the sessions running on SIGTERM only if we are being replaced; a
  // deploy restarts this unit, and killing every conversation on restart is the
  // failure this whole file exists to prevent. Sessions are children of this
  // process, so they cannot outlive it — hence the unit is never restarted by a
  // deploy (see infra/userdata/bootstrap.sh) and this is only a clean shutdown.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      log(`${signal}: stopping ${sessions.size} session(s)`);
      for (const session of sessions.values()) session.stop();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    });
  }
}

main();
