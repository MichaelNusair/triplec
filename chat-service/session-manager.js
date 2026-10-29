/**
 * Owns the long-lived `claude` processes.
 *
 * The key design point: one process per conversation, kept alive across
 * messages via --input-format stream-json. That's what makes the UX feel like
 * a chat app instead of a series of one-shot commands — context, cwd and
 * session id all persist, and a follow-up message costs no startup.
 */
import { spawn, execFile } from 'child_process';
import { readdir, readFile, stat, mkdir, realpath, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { promisify } from 'util';
import { ensureSlots, listSlots, prepareSlot, claudeCwds, parseSlot } from './slots.js';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

const execFileAsync = promisify(execFile);
const WORKSPACE_USER = process.env.WORKSPACE_USER || 'coder';

// Resolved on demand and cached: `gh` needs the token in its environment, and
// keeping it out of any file means nothing in the workspace can read it back.
let cachedGithubToken = null;
async function getGithubToken() {
  if (cachedGithubToken !== null) return cachedGithubToken;
  const arn = process.env.GITHUB_SECRET_ARN;
  if (!arn) {
    cachedGithubToken = '';
    return cachedGithubToken;
  }
  try {
    const client = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-1' });
    const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
    cachedGithubToken = JSON.parse(res.SecretString || '{}').token || '';
  } catch {
    cachedGithubToken = '';
  }
  return cachedGithubToken;
}

const PROJECTS_ROOT = process.env.PROJECTS_ROOT || '/workspace/projects';
const CLAUDE_HOME = process.env.CLAUDE_HOME || '/workspace/claude';
// ANTHROPIC_MODEL is the deployment's `defaultModel`, put in this service's unit
// by bootstrap.sh. The literal is only what a bare `node server.js` runs on.
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'us.anthropic.claude-opus-5-5';
const DEFAULT_PERMISSION_MODE = process.env.DEFAULT_PERMISSION_MODE || 'bypassPermissions';
const DEFAULT_EFFORT = process.env.DEFAULT_EFFORT || 'max';

// Claude Code stores transcripts under a path-mangled directory name:
// /workspace/projects/foo -> -workspace-projects-foo
//
// It mangles the *resolved* path, so any symlink in the path (on macOS, /tmp ->
// /private/tmp) changes the directory name. Resolve before mangling or the
// lookup silently finds nothing.
async function mangleCwd(cwd) {
  let resolved = cwd;
  try {
    resolved = await realpath(cwd);
  } catch {
    /* directory may not exist yet; fall back to the literal path */
  }
  return resolved.replace(/[/.]/g, '-');
}

/** Where Claude Code records the conversations held in a directory. */
async function transcriptDir(cwd) {
  return join(CLAUDE_HOME, 'projects', await mangleCwd(cwd));
}

/** Where a session moved into a worktree ends up — see projectPlaces. */
const WORKTREES = ['.claude', 'worktrees'];

/**
 * Every directory a project's conversations are recorded under: the project
 * itself, then each of its worktrees.
 *
 * A project is a directory, and its conversations used to run in exactly that
 * directory — one mangled path named every transcript belonging to it. A worktree
 * breaks that assumption without announcing it. `EnterWorktree` moves a session
 * into `<project>/.claude/worktrees/<name>`, which is what this box's own
 * instructions ask for whenever several sessions share one checkout, and from that
 * moment Claude Code writes the conversation's transcript under the *worktree's*
 * mangled path instead. Nothing moves it back.
 *
 * Measured here on 2026-10-23: `personal-site` had a conversation live in the
 * broker, mid-turn, with nobody watching it — the exact case every status surface
 * in this repository exists for — and it appeared in no list of that project's
 * chats and in no status answer about it, because its transcript had moved to
 * `-workspace-projects-personal-site--claude-worktrees-drop-azure-bedrock-chat`
 * and every reader was still looking at `-workspace-projects-personal-site`.
 *
 * So anything that means "the conversations in this project" asks this, and each
 * answer carries the cwd the conversation really runs in. That cwd is not
 * decoration: it is what a client sends back to resume, and resuming a worktree's
 * conversation against the project root would start a second process on one
 * transcript, which is the fork claude-broker exists to prevent.
 *
 * One level, and only `.claude/worktrees/*`, deliberately. That is the path the
 * tool creates; a general walk of a project is a walk of its node_modules.
 */
async function projectPlaces(cwd) {
  const places = [{ cwd, dir: await transcriptDir(cwd), worktree: null }];
  const root = join(cwd, ...WORKTREES);
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    // `isDirectory()` is false for a symlink, which is what keeps this from
    // following one out of the project — the same rule `findRepos` follows.
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    places.push({ cwd: path, dir: await transcriptDir(path), worktree: entry.name });
  }
  return places;
}

/**
 * Not everything stored as a `user` turn was typed by the user. The CLI injects
 * skill loaders, interrupt markers, compaction preambles, command output and
 * system reminders through the same channel — rendering those as chat bubbles
 * shows people "messages they never sent".
 */
const SYNTHETIC_USER_PATTERNS = [
  /^\[Request interrupted/i,
  /^\[No response requested/i,
  /^Caveat: The messages below were generated/i,
  /^This session is being continued from a previous conversation/i,
  /^Base directory for this skill:/i,
  /^<(command-name|command-message|command-args|local-command|bash-input|bash-stdout|bash-stderr|system-reminder|user-prompt-submit-hook|session-start-hook|ide_selection|task-notification)/i,
  /^Your task is to create a detailed summary of the conversation/i,
  /^Please continue the conversation from where we left it off/i,
  /^\s*$/,
];

// Exported for claude-status.js, which asks the same question of the *first* user
// entry in a transcript rather than of every one: what did a person actually type.
export function isSyntheticUserText(text) {
  const trimmed = text.trim();
  return SYNTHETIC_USER_PATTERNS.some((re) => re.test(trimmed));
}

/** One line, short enough for a row title on a phone. */
function truncate(text, max = 70) {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/**
 * Validate a project name and turn it into a path under PROJECTS_ROOT.
 *
 * The character class is the whole defence: with no `/` and no leading dot,
 * `join` cannot be talked out of the projects root. Reaching any caller of this
 * requires a valid session — and a logged-in user already has a shell here — but
 * one of these callers deletes a directory tree, so the name it is handed must
 * not be able to name a directory somewhere else.
 */
function assertSafeName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error('name may only contain letters, numbers, dot, dash and underscore');
  }
  if (name.startsWith('.') || name.length > 100) throw new Error('invalid project name');
  return name;
}

function projectPathFor(name) {
  return join(PROJECTS_ROOT, assertSafeName(name));
}

/**
 * Accept the forms people actually paste — `owner/repo`, a browser URL, an SSH
 * remote — and normalise them to one slug.
 *
 * Deliberately GitHub-only. The workspace's git credential helper answers with
 * the PAT for whatever host git asks it about, so cloning a caller-supplied URL
 * from some other host would hand that host the token. Restricting the input to
 * github.com is what keeps this endpoint from being a credential exfiltrator.
 */
function parseGithubRepo(input) {
  const raw = String(input || '').trim().replace(/\/+$/, '').replace(/\.git$/, '');
  const match =
    /^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/|git@github\.com:)?([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/
      .exec(raw);
  if (!match) throw new Error('expected owner/repo, or a github.com URL');
  const [, owner, repo] = match;
  if (repo === '.' || repo === '..') throw new Error('expected owner/repo, or a github.com URL');
  return { owner, repo, slug: `${owner}/${repo}` };
}

/**
 * Run git and report the outcome instead of throwing.
 *
 * Inspecting a repository means asking questions that legitimately fail — "is
 * there an origin remote?" answers itself with a non-zero exit — so the caller
 * decides what a failure means.
 *
 * `GIT_TERMINAL_PROMPT=0` matters more than it looks: without it a repository
 * whose credentials cannot be resolved makes git sit waiting for a username on
 * a stdin nobody is attached to, and the HTTP request hangs until the timeout
 * rather than returning a usable error.
 */
async function git(cwd, args, { timeout = 60_000, env = {} } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    });
    return { ok: true, out: (stdout || '').trim(), err: (stderr || '').trim() };
  } catch (err) {
    return {
      ok: false,
      out: (err.stdout || '').toString().trim(),
      err: (err.stderr || err.message || '').toString().trim(),
    };
  }
}

// Directories a repository is never kept in, and which are large enough that
// walking them is the difference between a status call costing milliseconds and
// costing seconds. A dependency tree holds other people's code by definition.
const NEVER_A_PROJECT_REPO = new Set(['node_modules', 'vendor', '__pycache__']);

/**
 * Every git repository inside a project, the project root included.
 *
 * A project here is a *directory*, not a repository — the same shape as a VS
 * Code workspace — so `api/` and `web/` side by side is one project with two
 * repos and nothing at its root. Anything that inspects or deletes a project has
 * to see all of them: the version of this that only looked at the root would
 * push the root, report a verified success, and then `rm -rf` a sibling repo's
 * unpushed commits.
 *
 * Deliberately a filesystem walk rather than asking git. A repo the outer
 * `.gitignore` hides is invisible to `git status`, and that is precisely the
 * case that loses work without anyone noticing.
 *
 * `.git` has to be a *directory*. When it is a file the checkout belongs to some
 * other repository — a submodule, or a linked worktree — and pushing it from
 * here would mean pushing another repo's detached HEAD. Submodules already
 * travel with their superproject, which is why `cloneProject` recurses them.
 *
 * Returned root-first, parents before their descendants, which is the order
 * `removeProject` reverses to save an embedded repo before the repo embedding it.
 */
async function findRepos(root, { maxDepth = 3, limit = 25 } = {}) {
  const found = [];

  const walk = async (dir, rel, depth) => {
    if (found.length >= limit) return;
    const dotGit = await stat(join(dir, '.git')).catch(() => null);
    if (dotGit?.isDirectory()) found.push(rel);
    if (depth >= maxDepth) return;

    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      // `isDirectory()` is false for a symlink, which is what keeps this walk
      // from following one out of the project or around in a circle.
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (NEVER_A_PROJECT_REPO.has(entry.name)) continue;
      await walk(join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name, depth + 1);
    }
  };

  await walk(root, '', 0);
  return found;
}

/**
 * How to name a repository in a sentence the user reads.
 *
 * A project with one repo at its root is the common case and should read exactly
 * as it did when that was the only case — `"koinespace"`, not
 * `"koinespace" (the project root)`. Only a project with more than one repo needs
 * the subdirectory said out loud.
 */
function label(project, repo) {
  return repo.dir ? `"${project}/${repo.dir}"` : `"${project}"`;
}

/** The path a `git status --porcelain` line refers to, without its status flags. */
function porcelainPath(line) {
  return line.slice(3).replace(/^"|"$/g, '').replace(/\/$/, '');
}

/**
 * What one repository still holds that nothing else has.
 *
 * `nested` names the repos that live *inside* this one, relative to it. They are
 * dropped from this repo's own dirty and ignored lists, because they get a block
 * of their own: without this, a project whose root repo contains `web/` reports
 * "1 uncommitted change: web/" for what is actually a whole second repository,
 * and the number the user is deciding from is describing the wrong thing.
 */
async function repoStatus(dir, rel, nested = []) {
  const repo = {
    dir: rel,
    path: dir,
    hasCommits: false,
    branch: null,
    remote: null,
    dirty: 0,
    dirtySample: [],
    unpushed: 0,
    unpushedBranches: [],
    stashes: 0,
    // Present in the directory but invisible to git: an .env or a local build
    // that no push can preserve. Almost always fine to lose, occasionally the
    // only copy of a credential, so it is shown rather than assumed.
    ignored: [],
  };

  const isNested = (line) => nested.includes(porcelainPath(line));

  const branch = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  repo.branch = branch.ok ? branch.out : null;
  repo.hasCommits = (await git(dir, ['rev-parse', '--verify', 'HEAD'])).ok;

  const remote = await git(dir, ['remote', 'get-url', 'origin']);
  repo.remote = remote.ok ? remote.out : null;

  const porcelain = await git(dir, ['status', '--porcelain']);
  const changes = (porcelain.out ? porcelain.out.split('\n') : []).filter((l) => !isNested(l));
  repo.dirty = changes.length;
  repo.dirtySample = changes.slice(0, 8).map((l) => l.slice(3));

  // `--ignored` collapses whole ignored directories into one entry, so this is
  // "node_modules/, .env" rather than forty thousand paths.
  const ignored = await git(dir, ['status', '--porcelain', '--ignored']);
  repo.ignored = (ignored.out ? ignored.out.split('\n') : [])
    .filter((l) => l.startsWith('!! ') && !isNested(l))
    .map((l) => l.slice(3))
    .slice(0, 12);

  const stashes = await git(dir, ['stash', 'list']);
  repo.stashes = stashes.out ? stashes.out.split('\n').length : 0;

  // Per branch, not just the current one: the directory is about to stop
  // existing, so a side branch nobody pushed is a side branch that is gone.
  const heads = await git(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  for (const head of heads.out ? heads.out.split('\n') : []) {
    const log = await git(dir, ['log', '--oneline', head, '--not', '--remotes']);
    const commits = log.ok && log.out ? log.out.split('\n').length : 0;
    if (commits) {
      repo.unpushed += commits;
      repo.unpushedBranches.push({ dir: rel, branch: head, commits });
    }
  }

  return repo;
}

/** `ensureSlots`'s answer as one of the steps project creation reports. */
function slotStep(result) {
  if (result.skipped) return { step: 'slots', ok: true, note: 'no repository at the root, so no slots' };
  return result.ok
    ? { step: 'slots', ok: true, created: result.created }
    : { step: 'slots', ok: false, created: result.created, error: result.errors.join('; ').slice(0, 300) };
}

/**
 * A refusal the UI can act on, as opposed to a crash.
 *
 * Removing a project deletes a directory tree, so every check that says "this
 * work only exists here" has to be able to stop the operation *and* explain
 * itself well enough that the user can decide to override. A bare Error would
 * arrive at the client as a 500 with a sentence, and the honest answer here has
 * structure: what blocked it, and what the repository looked like at the time.
 */
class Blocked extends Error {
  constructor(message, { status = null, steps = [] } = {}) {
    super(message);
    this.name = 'Blocked';
    this.blocked = true;
    this.status = status;
    this.steps = steps;
  }
}

const PERMISSION_MODES = new Set([
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
  'manual',
]);

class Conversation extends EventEmitter {
  constructor({ id, cwd, model, permissionMode, effort, resumeSessionId, fork = false }) {
    super();
    this.id = id;
    this.cwd = cwd;
    this.model = model || DEFAULT_MODEL;
    this.permissionMode = PERMISSION_MODES.has(permissionMode)
      ? permissionMode
      : DEFAULT_PERMISSION_MODE;
    this.effort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)
      ? effort
      : DEFAULT_EFFORT;
    this.resumeSessionId = resumeSessionId || null;
    /*
     * Resume a conversation into a new one instead of continuing it, because
     * something else on this box is already running it. See `create`.
     */
    this.fork = Boolean(fork && resumeSessionId);
    /*
     * The conversation's durable name, known before the process exists.
     *
     * A new chat used to be nameless until the CLI announced an id in its `init`
     * event, roughly a second in, and that second was a hole nothing could see
     * into: the transcript existed, but no one outside this service could tell
     * which process was writing it, because the id appeared in no argv. On
     * 2026-10-25 the editor's panel resumed a chat 71 seconds after the phone
     * started it — the newest transcript in the folder it had open — and the two
     * processes held one conversation for ten minutes. Nothing could have
     * reported the collision, let alone prevented it.
     *
     * So this service names its own conversations and passes the name to the CLI
     * with `--session-id`. That makes a chat identifiable from `/proc` the moment
     * it exists, which is what `claude-broker` and `claudeStatus` both need in
     * order to see it at all.
     *
     * A fork is the exception: it resumes one id and is given another by the CLI,
     * so its name is not ours to choose and arrives with the init event, as every
     * conversation's used to.
     */
    this.sessionId = this.fork ? null : resumeSessionId || randomUUID();
    // What the CLI is told to call itself, as opposed to what it is resuming:
    // null whenever an id is being resumed, including into a fork.
    this.startSessionId = resumeSessionId ? null : this.sessionId;
    this.proc = null;
    this.busy = false;
    this.buffer = '';
    // Replayed to a client that reconnects mid-conversation.
    this.history = [];
    // Events belonging to the turn in flight. The CLI's transcript is the
    // record of completed turns, but it lags for the turn happening right now,
    // so a device joining mid-task needs these to see the work in progress.
    this.currentTurn = [];
    // Assistant text streamed but not yet finalised, so a device that joins
    // mid-reply sees the half-written answer instead of a blank gap.
    this.partialText = '';
    this.lastActivity = Date.now();
    this.exited = false;
  }

  start() {
    const args = [
      '--print',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--model', this.model,
      '--permission-mode', this.permissionMode,
      '--effort', this.effort,
    ];
    if (this.resumeSessionId) args.push('--resume', this.resumeSessionId);
    // A name of our own, so the conversation is identifiable from outside this
    // process the moment it starts. See the constructor.
    if (this.startSessionId) args.push('--session-id', this.startSessionId);
    // Same history, new conversation: this one is already being run by something
    // else, and two processes on one transcript is the bug this avoids.
    if (this.fork) args.push('--fork-session');

    this.proc = spawn('claude', args, {
      cwd: this.cwd,
      env: {
        ...process.env,
        HOME: process.env.CODER_HOME || '/home/coder',
        CLAUDE_CODE_USE_BEDROCK: '1',
        ANTHROPIC_MODEL: this.model,
        TERM: 'dumb',
        // Prevent the CLI from thinking it's nested inside another agent.
        CLAUDECODE: '',
        CLAUDE_CODE_SESSION_ID: '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout.on('data', (chunk) => this.#onStdout(chunk));

    this.proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      // The CLI writes progress noise to stderr; only surface real errors.
      if (/error|fatal|exception/i.test(text)) {
        this.#emit({ type: 'error', message: text.slice(0, 500) });
      }
    });

    this.proc.on('exit', (code) => {
      this.exited = true;
      this.busy = false;
      this.#emit({ type: 'exit', code });
    });

    this.proc.on('error', (err) => {
      this.exited = true;
      this.busy = false;
      this.#emit({ type: 'error', message: `failed to start claude: ${err.message}` });
    });
  }

  #onStdout(chunk) {
    this.buffer += chunk.toString();
    const lines = this.buffer.split('\n');
    // Last element may be a partial line.
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        continue;
      }
      this.#translate(event);
    }
  }

  /**
   * Turn raw CLI events into the small vocabulary the UI needs. Doing this
   * server-side keeps the client simple and lets the wire format stay stable
   * if the CLI's event shapes change.
   */
  #translate(event) {
    this.lastActivity = Date.now();

    switch (event.type) {
      case 'system':
        if (event.subtype === 'init') {
          // A fresh session gets its id here. Register it under the manager's
          // durable key so another device can find this live process by
          // (cwd, sessionId) rather than by an id only one browser knows.
          const previous = this.sessionId;
          this.sessionId = event.session_id;
          if (previous !== event.session_id) this.emit('sessionId', this, previous);
          this.#emit({
            type: 'session',
            sessionId: event.session_id,
            model: event.model,
            cwd: event.cwd,
            permissionMode: event.permissionMode,
          });
        }
        return;

      case 'stream_event': {
        const inner = event.event;
        if (!inner) return;
        // Incremental assistant text — this is what makes replies appear live.
        if (inner.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
          this.partialText += inner.delta.text;
          this.#emit({ type: 'delta', text: inner.delta.text }, false);
        }
        if (inner.type === 'content_block_start' && inner.content_block?.type === 'thinking') {
          this.#emit({ type: 'thinking_start' }, false);
        }
        return;
      }

      case 'assistant': {
        for (const block of event.message?.content || []) {
          if (block.type === 'text' && block.text?.trim()) {
            this.#emit({ type: 'assistant_text', text: block.text });
          } else if (block.type === 'tool_use') {
            this.#emit({
              type: 'tool_use',
              id: block.id,
              name: block.name,
              input: block.input,
            });
          }
        }
        return;
      }

      case 'user': {
        // Tool results come back as synthetic user messages.
        for (const block of event.message?.content || []) {
          if (block.type === 'tool_result') {
            const content = typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content);
            this.#emit({
              type: 'tool_result',
              toolUseId: block.tool_use_id,
              isError: Boolean(block.is_error),
              // Full payloads can be enormous; the UI only shows a preview.
              content: (content || '').slice(0, 4000),
            });
          }
        }
        return;
      }

      case 'result': {
        this.busy = false;
        // The turn is now in the on-disk transcript, so the live copy is no
        // longer needed to reconstruct it for a joining device.
        this.currentTurn = [];
        this.partialText = '';
        this.#emit({
          type: 'turn_complete',
          isError: Boolean(event.is_error),
          subtype: event.subtype,
          costUsd: event.total_cost_usd,
          durationMs: event.duration_ms,
          sessionId: event.session_id,
        });
        return;
      }

      default:
        return;
    }
  }

  #emit(msg, persist = true) {
    if (persist) {
      this.history.push(msg);
      // Bound memory on very long conversations.
      if (this.history.length > 2000) this.history.splice(0, 500);
      // Also accumulate into the in-flight turn, which a device joining
      // mid-task replays on top of the on-disk transcript.
      if (msg.type !== 'session') {
        this.currentTurn.push(msg);
        if (this.currentTurn.length > 400) this.currentTurn.splice(0, 100);
      }
    }
    this.emit('event', msg);
  }

  /**
   * Everything a device needs to render this conversation as it stands right
   * now: the finished turns come from the transcript, and these are the events
   * the transcript does not have yet.
   */
  liveTail() {
    return {
      events: this.currentTurn,
      partialText: this.partialText,
    };
  }

  send(text) {
    if (this.exited || !this.proc?.stdin.writable) {
      throw new Error('conversation is no longer running');
    }
    this.busy = true;
    this.lastActivity = Date.now();
    this.#emit({ type: 'user_message', text });
    this.proc.stdin.write(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
      }) + '\n',
    );
  }

  interrupt() {
    if (this.proc && !this.exited) {
      // SIGINT maps to the CLI's own cancel handling.
      this.proc.kill('SIGINT');
      this.busy = false;
      this.#emit({ type: 'interrupted' });
    }
  }

  stop() {
    if (this.proc && !this.exited) this.proc.kill('SIGTERM');
  }
}

export class SessionManager {
  constructor() {
    this.conversations = new Map();
    // Live conversations keyed by `cwd|sessionId` — a name every device can
    // derive from the chat list, unlike the per-conversation UUID which only
    // the browser that created it ever knew. This is what makes picking a chat
    // up on another device attach to the running process instead of spawning a
    // second one against the same transcript.
    this.bySession = new Map();
    // Reap idle conversations so abandoned tabs don't pin processes forever.
    this.reaper = setInterval(() => this.#reap(), 60_000);
    this.reaper.unref?.();
  }

  static sessionKey(cwd, sessionId) {
    return `${cwd}|${sessionId}`;
  }

  #index(conv, previousSessionId) {
    if (previousSessionId) {
      this.bySession.delete(SessionManager.sessionKey(conv.cwd, previousSessionId));
    }
    if (conv.sessionId) {
      this.bySession.set(SessionManager.sessionKey(conv.cwd, conv.sessionId), conv);
    }
  }

  #forget(conv) {
    this.conversations.delete(conv.id);
    if (conv.sessionId) {
      const key = SessionManager.sessionKey(conv.cwd, conv.sessionId);
      if (this.bySession.get(key) === conv) this.bySession.delete(key);
    }
  }

  #reap() {
    const cutoff = Date.now() - 6 * 60 * 60 * 1000; // 6 hours idle
    for (const conv of [...this.conversations.values()]) {
      if (conv.exited || (!conv.busy && conv.lastActivity < cutoff)) {
        conv.stop();
        this.#forget(conv);
      }
    }
  }

  async listProjects() {
    await mkdir(PROJECTS_ROOT, { recursive: true });
    const entries = await readdir(PROJECTS_ROOT, { withFileTypes: true });
    const projects = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const cwd = join(PROJECTS_ROOT, entry.name);
      projects.push({
        name: entry.name,
        path: cwd,
        sessions: await this.listSessions(cwd),
      });
    }
    projects.sort((a, b) => {
      const at = a.sessions[0]?.mtime || 0;
      const bt = b.sessions[0]?.mtime || 0;
      return bt - at || a.name.localeCompare(b.name);
    });
    return projects;
  }

  /**
   * Past conversations for a project, newest first, with a title preview.
   *
   * Every directory the project's conversations are recorded in, not just the
   * project's own — see projectPlaces for what a worktree does to that. Each row
   * therefore says which cwd it belongs to, and a client that opens one has to
   * send that cwd back: it is where the conversation runs.
   */
  async listSessions(cwd) {
    const places = await projectPlaces(cwd);
    const sessions = [];

    for (const place of places) {
      let files;
      try {
        files = await readdir(place.dir);
      } catch {
        continue; // nothing recorded here yet
      }

      for (const file of files) {
        // `._*` are macOS AppleDouble metadata stubs, not real transcripts.
        if (!file.endsWith('.jsonl') || file.startsWith('._')) continue;
        const full = join(place.dir, file);
        try {
          const info = await stat(full);
          const sessionId = file.replace(/\.jsonl$/, '');
          const live = this.#liveInProject(places, sessionId);
          sessions.push({
            sessionId,
            // Where this conversation runs, which is the project's own directory
            // for all but a worktree's — and, when a live process disagrees with
            // the transcript about that, the process's, because that is the one a
            // resume has to address to be adopted rather than duplicated.
            cwd: live?.cwd || place.cwd,
            // Which worktree it is in, or null for the project itself: a row has
            // to be able to say where it is, now that a project has more than one
            // place to be.
            worktree: place.worktree,
            mtime: info.mtimeMs,
            title: await this.#titleOf(full),
            // Surfaced so the list can show a chat that is still working, and so
            // any device can tell it will be joining rather than restarting.
            live: Boolean(live),
            busy: Boolean(live?.busy),
          });
        } catch {
          /* transcript vanished mid-scan */
        }
      }
    }

    sessions.sort((a, b) => b.mtime - a.mtime);
    return sessions.slice(0, 50);
  }

  /**
   * The live conversation for a session id, in whichever of a project's
   * directories it is keyed under.
   *
   * Conversations are keyed by `(cwd, sessionId)`, and the cwd a conversation was
   * started in is not always the one its transcript ends up under: a session that
   * enters a worktree mid-conversation keeps the process it had. Looking the id up
   * only where the transcript is would call that conversation dead, and then
   * opening it would resume the transcript in a second process — the fork that
   * `create` adopts an existing conversation to avoid.
   */
  #liveInProject(places, sessionId) {
    for (const place of places) {
      const conv = this.getBySession(place.cwd, sessionId);
      if (conv) return conv;
    }
    return null;
  }

  /**
   * What to call a conversation in the list.
   *
   * The CLI names its own sessions: it writes `{"type":"ai-title","aiTitle":…}`
   * into the transcript, rewriting it as the conversation changes subject, and
   * that name is what the editor and the terminal show. So it is what this shows
   * too — a list where one row reads "Empty and lingering sessions" and the next
   * "PostHog tracking on the landing page" is scannable in a way that a row
   * reading "Now wire it into server.js:" is not.
   *
   * Last one wins: the name is regenerated as the conversation moves on, and the
   * current subject is the useful one. A transcript from before the CLI wrote
   * these, or one too young to have been named yet, falls back to its opening
   * message, which is what this always used.
   */
  async #titleOf(file) {
    try {
      const raw = await readFile(file, 'utf8');
      const lines = raw.split('\n');
      // Backwards, and only parsing the lines that can possibly be one. These
      // transcripts reach tens of MB and this runs once per conversation in the
      // list, so the whole-file JSON.parse this would otherwise be is the
      // difference between a list that opens and one that hangs.
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (!lines[i].includes('"ai-title"')) continue;
        try {
          const title = JSON.parse(lines[i]).aiTitle;
          if (typeof title === 'string' && title.trim()) return truncate(title);
        } catch {
          /* torn line at the tail of a transcript being written */
        }
      }
      for (const line of lines) {
        if (!line.trim()) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (entry.type !== 'user') continue;
        const content = entry.message?.content;
        const text = typeof content === 'string'
          ? content
          : (content || []).find((b) => b.type === 'text')?.text;
        // A skill loader or resume preamble makes a useless title.
        if (text?.trim() && !isSyntheticUserText(text)) return truncate(text);
      }
    } catch {
      /* unreadable transcript */
    }
    return 'Untitled conversation';
  }

  /** Read a stored transcript so a resumed chat shows its earlier messages. */
  async loadTranscript(cwd, sessionId) {
    // Both arguments come from the client, and both land in a filesystem path.
    // Reaching this requires a valid session, and a logged-in user already has a
    // shell here — so this is hygiene rather than a boundary, but an id shaped
    // like `../../../../secrets` should never have been turned into a path.
    if (!/^[A-Za-z0-9_-]+$/.test(String(sessionId))) {
      throw new Error('invalid session id');
    }
    if (!String(cwd).startsWith(PROJECTS_ROOT)) {
      throw new Error('cwd must be inside the projects root');
    }

    const file = join(await transcriptDir(cwd), `${sessionId}.jsonl`);
    let raw;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      return [];
    }

    const messages = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      const content = entry.message?.content;
      if (entry.type === 'user') {
        const text = typeof content === 'string'
          ? content
          : (content || []).find((b) => b.type === 'text')?.text;
        // Skip tool-result echoes; they aren't things the user typed.
        const isToolResult = Array.isArray(content) && content.some((b) => b.type === 'tool_result');
        if (text?.trim() && !isToolResult && !isSyntheticUserText(text)) {
          messages.push({ type: 'user_message', text });
        }
      } else if (entry.type === 'assistant') {
        for (const block of content || []) {
          if (block.type === 'text' && block.text?.trim()) {
            messages.push({ type: 'assistant_text', text: block.text });
          } else if (block.type === 'tool_use') {
            messages.push({
              type: 'tool_use',
              id: block.id,
              name: block.name,
              input: block.input,
            });
          }
        }
      }
    }
    return messages.slice(-400);
  }

  /**
   * Get the live conversation for a stored session, if one is still running.
   * This is the device-switching primitive: two browsers asking for the same
   * (cwd, sessionId) get the same process.
   */
  getBySession(cwd, sessionId) {
    const conv = this.bySession.get(SessionManager.sessionKey(cwd, sessionId));
    if (conv && conv.exited) {
      this.#forget(conv);
      return null;
    }
    return conv || null;
  }

  /**
   * The live conversation for a session id, under the directory it was asked for
   * or under any other.
   *
   * The key is `(cwd, sessionId)` because that is what a client can derive from a
   * chat list, but the conversation is the id, and the two legitimately disagree:
   * a session that moves into a worktree mid-conversation keeps the process it
   * had while its transcript moves to the worktree's directory. A client that
   * then sends the worktree path — which it should, because that is where the
   * conversation is recorded — missed this process entirely and got a second one
   * resuming the same transcript.
   *
   * The exact pair still wins, so two projects cannot be confused for one
   * another; the id alone is the fallback, and it can only match a conversation
   * this service is already running.
   */
  liveSession(sessionId, cwd = null) {
    if (!sessionId) return null;
    if (cwd) {
      const exact = this.getBySession(cwd, sessionId);
      if (exact) return exact;
    }
    for (const conv of this.conversations.values()) {
      if (!conv.exited && conv.sessionId === sessionId) return conv;
    }
    return null;
  }

  /** The pids of every process this service is running a conversation in. */
  livePids() {
    return [...this.conversations.values()]
      .filter((conv) => !conv.exited && conv.proc?.pid)
      .map((conv) => conv.proc.pid);
  }

  /**
   * Open a conversation. If the requested session already has a live process,
   * adopt it rather than starting a second `claude --resume` against the same
   * transcript — two processes sharing one transcript is what made a refresh or
   * a device switch land in an idle session waiting for a new command.
   *
   * `fork` is for the case this service cannot adopt: the conversation is live,
   * but in a process belonging to something else on this box — the editor's
   * panel, a terminal, a timer. There is no joining those from here, so the
   * choice is between appending to a transcript another process is writing and
   * resuming a copy of it. The copy wins; see the constructor's `fork`.
   */
  create({ cwd, model, permissionMode, effort, resumeSessionId, fork = false }) {
    if (!cwd.startsWith(PROJECTS_ROOT)) {
      throw new Error('cwd must be inside the projects root');
    }

    if (resumeSessionId) {
      const existing = this.liveSession(resumeSessionId, cwd);
      if (existing) return existing;
    }

    const id = randomUUID();
    const conv = new Conversation({ id, cwd, model, permissionMode, effort, resumeSessionId, fork });
    this.conversations.set(id, conv);
    // Reachable by key immediately, resumed or new, because this service names
    // the new ones itself. A fork is the one conversation whose id is not known
    // yet, and it is indexed when `system/init` says what the CLI called it.
    this.#index(conv);
    conv.on('sessionId', (c, previous) => this.#index(c, previous));
    conv.start();
    return conv;
  }

  get(id) {
    return this.conversations.get(id);
  }

  /**
   * Every conversation this service owns, as plain data for the admin surface.
   *
   * Deliberately a projection rather than the objects themselves: the caller is a
   * JSON route, and handing it `Conversation` instances would put the process
   * handle, the event history and the emitter's listener list one
   * `JSON.stringify` away from a response body.
   *
   * The pid is the interesting field. These processes are children of
   * `claude-chat.service`, so they are the ones a deploy takes with it, and the
   * only way to see how much memory they hold is to go and look.
   */
  inventory() {
    return [...this.conversations.values()].map((conv) => ({
      id: conv.id,
      cwd: conv.cwd,
      project: conv.cwd.startsWith(`${PROJECTS_ROOT}/`)
        ? conv.cwd.slice(PROJECTS_ROOT.length + 1)
        : conv.cwd,
      sessionId: conv.sessionId,
      model: conv.model,
      permissionMode: conv.permissionMode,
      effort: conv.effort,
      busy: conv.busy,
      exited: conv.exited,
      pid: conv.proc?.pid ?? null,
      lastActivity: conv.lastActivity,
      events: conv.history.length,
    }));
  }

  /**
   * Who is live and who is working, with no disk access at all.
   *
   * This is the half of `listProjects()` that can be polled. That one stats every
   * transcript and reads each file from the start to build a title, which is fine
   * once per screen and ruinous every few seconds — so a client that wants to keep
   * a badge honest while the user is looking at something else asks for this
   * instead. Everything here is already in memory.
   */
  liveSummary() {
    const sessions = [];
    for (const conv of this.conversations.values()) {
      if (conv.exited || !conv.sessionId) continue;
      sessions.push({
        cwd: conv.cwd,
        sessionId: conv.sessionId,
        busy: conv.busy,
        lastActivity: conv.lastActivity,
      });
    }
    return sessions;
  }

  /**
   * Stop one conversation by the id the admin surface shows.
   *
   * SIGTERM and forget, which is what `#reap` does to an idle one — so this is the
   * reaper on demand rather than a new way to end a process. Whether stopping a
   * *busy* one is allowed is decided by the route, not here: this layer has no way
   * to ask the user anything.
   */
  stopConversation(id) {
    const conv = this.conversations.get(id);
    if (!conv) return null;
    const wasBusy = conv.busy;
    conv.stop();
    this.#forget(conv);
    return { id, cwd: conv.cwd, sessionId: conv.sessionId, wasBusy };
  }

  /**
   * Create a project: a folder, a git repo, and optionally a GitHub remote.
   *
   * Everything runs as the workspace user so file ownership and git identity
   * match the rest of the tree. `gh` authenticates from the same Secrets Manager
   * token as the git credential helper, so no token is written to disk.
   *
   * Each step is reported back rather than silently skipped — a project that
   * exists locally but failed to reach GitHub is a materially different outcome
   * from a fully wired one, and the UI says which happened.
   */
  async createProject(name, { github = false, private: isPrivate = true, description = '' } = {}) {
    const path = projectPathFor(name);
    try {
      await stat(path);
      throw new Error(`"${name}" already exists`);
    } catch (err) {
      if (!/already exists/.test(err.message) && err.code !== 'ENOENT') throw err;
      if (/already exists/.test(err.message)) throw err;
    }

    await mkdir(path, { recursive: true });
    const steps = [];

    // Seed a README so the first commit isn't empty (GitHub shows an empty repo
    // as unusable, and `gh repo create --push` needs a commit to push).
    await writeFile(
      join(path, 'README.md'),
      `# ${name}\n\n${description || 'Created from the Claude workspace.'}\n`,
      'utf8',
    );

    const run = async (cmd, args, opts = {}) => {
      const { stdout } = await execFileAsync(cmd, args, {
        cwd: path,
        timeout: 120_000,
        env: { ...process.env, ...(opts.env || {}) },
      });
      return (stdout || '').trim();
    };

    // This service already runs as the workspace user, so commands run directly.
    // Going through sudo both was unnecessary and failed outright: that account
    // is deliberately not in sudoers.
    const asUser = ([cmd, ...args], env) => run(cmd, args, { env });

    try {
      await asUser(['git', 'init', '-b', 'main']);
      await asUser(['git', 'add', '-A']);
      await asUser(['git', 'commit', '-m', 'Initial commit']);
      steps.push({ step: 'git init', ok: true });
    } catch (err) {
      steps.push({ step: 'git init', ok: false, error: err.message.slice(0, 200) });
      return { name, path, sessions: [], steps };
    }

    // Before GitHub, so a project whose remote failed still gets its slots: they
    // need a commit to branch from, not a remote.
    steps.push(slotStep(await ensureSlots(path)));

    if (!github) return { name, path, sessions: [], steps };

    try {
      const token = await getGithubToken();
      if (!token) throw new Error('no GitHub token configured');
      const out = await asUser(
        [
          'gh', 'repo', 'create', name,
          isPrivate ? '--private' : '--public',
          '--source', '.', '--remote', 'origin', '--push',
          ...(description ? ['--description', description] : []),
        ],
        { GH_TOKEN: token, GITHUB_TOKEN: token },
      );
      const url = (out.match(/https:\/\/github\.com\/\S+/) || [])[0] || '';
      steps.push({ step: 'github', ok: true, url });
    } catch (err) {
      // The folder and local repo are already usable; surface the failure
      // instead of pretending the remote exists.
      steps.push({
        step: 'github',
        ok: false,
        error: (err.stderr || err.message || '').toString().slice(0, 300),
      });
    }

    return { name, path, sessions: [], steps };
  }

  /**
   * Live conversations working in a project, so it isn't deleted from under one.
   *
   * Anywhere inside the directory, not only at its root: a conversation in a
   * worktree is a conversation in this project, and the caller is about to
   * `rm -rf` the tree it is standing in.
   */
  #liveIn(cwd) {
    const inside = (c) => c.cwd === cwd || c.cwd.startsWith(`${cwd}/`);
    return [...this.conversations.values()].filter((c) => inside(c) && !c.exited);
  }

  /**
   * What would be lost if this project were deleted right now.
   *
   * The removal flow is irreversible, so the client asks this first and shows the
   * answer before offering the button. Every field here exists because it names a
   * way work can live *only* on this machine: uncommitted edits, commits no
   * remote has, stashes, and files git was told to ignore.
   *
   * `repos` is the real answer — one entry per repository in the project, root
   * first — because a project may hold several, or none at its root. The flat
   * fields beside it are kept for two reasons: the root repository is what the
   * single-repo majority of projects means by "the repo", and a client cached
   * from before this existed still reads them. So `isRepo`, `branch`, `remote`,
   * `hasCommits` and `dirtySample` describe the *root*, while the counters —
   * `dirty`, `unpushed`, `stashes`, `ignored` — are totals across every repo.
   * Totals are the safe direction for an old client to be wrong in: it warns
   * about work it cannot attribute, rather than missing it.
   */
  async projectStatus(name) {
    const path = projectPathFor(name);
    const info = await stat(path).catch(() => null);
    if (!info?.isDirectory()) throw new Error(`no project named "${name}"`);

    const status = {
      name,
      path,
      repos: [],
      isRepo: false,
      hasCommits: false,
      branch: null,
      remote: null,
      dirty: 0,
      dirtySample: [],
      unpushed: 0,
      unpushedBranches: [],
      stashes: 0,
      ignored: [],
      live: this.#liveIn(path).map((c) => ({ sessionId: c.sessionId, busy: c.busy })),
      transcripts: (await this.listSessions(path)).length,
    };

    const dirs = await findRepos(path);
    for (const rel of dirs) {
      // The repos directly under this one, named the way its own `git status`
      // names them, so this repo's counts describe this repo.
      const prefix = rel ? `${rel}/` : '';
      const nested = dirs
        .filter((other) => other !== rel && other.startsWith(prefix))
        .map((other) => other.slice(prefix.length));
      status.repos.push(await repoStatus(join(path, rel), rel, nested));
    }

    const root = status.repos.find((r) => r.dir === '');
    if (root) {
      status.isRepo = true;
      status.hasCommits = root.hasCommits;
      status.branch = root.branch;
      status.remote = root.remote;
      status.dirtySample = root.dirtySample;
    }

    for (const repo of status.repos) {
      status.dirty += repo.dirty;
      status.unpushed += repo.unpushed;
      status.stashes += repo.stashes;
      status.unpushedBranches.push(...repo.unpushedBranches);
      // Prefixed so "not in git" still says *where*, now that it can come from
      // more than one repository.
      status.ignored.push(...repo.ignored.map((f) => (repo.dir ? `${repo.dir}/${f}` : f)));
    }
    status.ignored = status.ignored.slice(0, 12);

    /*
     * Uncommitted work in the project's worktrees — its slots, and any a session
     * made for itself.
     *
     * `findRepos` cannot see these, and that is by design: a worktree's `.git` is a
     * file, and it skips dot-directories. But the directory delete below takes them
     * with it, and with eight slots per project that stopped being an edge case.
     * Their *commits* are already covered — a worktree's branch is a branch of the
     * root repository, so the per-branch unpushed count and `push --all` include it.
     * Their working trees are not, and nothing commits them on the way out: an edit
     * left in a slot is somebody's half-finished turn, not a save point.
     */
    status.worktrees = [];
    for (const place of await projectPlaces(path)) {
      if (!place.worktree) continue;
      const porcelain = await git(place.cwd, ['status', '--porcelain']);
      if (!porcelain.ok) continue;
      const changes = porcelain.out ? porcelain.out.split('\n') : [];
      if (changes.length) {
        status.worktrees.push({
          name: place.worktree,
          dirty: changes.length,
          dirtySample: changes.slice(0, 4).map((l) => l.slice(3)),
        });
      }
    }

    return status;
  }

  /**
   * A project's slots and who is in each one. See slots.js.
   *
   * Other surfaces' processes are found from `/proc` with this service's own taken
   * out, so a slot with a chat of ours in it is not also counted as held elsewhere.
   */
  async slots(name) {
    const path = projectPathFor(name);
    const info = await stat(path).catch(() => null);
    if (!info?.isDirectory()) throw new Error(`no project named "${name}"`);
    const mine = new Set(this.livePids());
    const others = (await claudeCwds()).filter((p) => !mine.has(p.pid));
    return { name, path, ...(await listSlots(path, { live: this.liveSummary(), others })) };
  }

  /** Create a slot if it is missing and refresh it if that is safe. See slots.js. */
  async prepareSlot(name, slot) {
    const path = projectPathFor(name);
    const n = parseSlot(slot);
    if (!n) throw new Error('slot must be a number from 1 to 8');
    const info = await stat(path).catch(() => null);
    if (!info?.isDirectory()) throw new Error(`no project named "${name}"`);
    const token = await getGithubToken();
    return prepareSlot(path, n, { env: token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {} });
  }

  /**
   * Commit, push, verify the push actually landed, then delete the directory.
   *
   * "Verify" is the whole point. A `git push` that exits 0 is not proof: the
   * remote-tracking ref it updated is a local file, and this operation deletes
   * the only other copy of the work. So the commit on disk is compared against
   * what the remote reports over the network, and anything short of a match
   * refuses to delete.
   *
   * Chat transcripts under CLAUDE_HOME are deliberately left in place. They are
   * small, they are the record of what was done here, and keeping them means
   * cloning the repo back later lands next to its own history.
   *
   * Every repository in the project goes through this, not just the one at the
   * root. A project holding two repos has two sets of commits to save, and the
   * outer repo cannot stand in for the inner one: `git add -A` records an
   * embedded repository as a gitlink, so pushing the outer repo sends a *pointer*
   * to a commit that then gets deleted along with the only repository that has it.
   */
  async removeProject(name, { force = false } = {}) {
    const status = await this.projectStatus(name);
    const { path } = status;
    const steps = [];
    const block = (message) => {
      throw new Blocked(message, { status, steps });
    };

    if (!force) {
      if (status.live.some((c) => c.busy)) {
        block('a chat in this project is still working — stop it first, or force the removal');
      }
      if (!status.repos.length) {
        block(`"${name}" is not a git repository, so there is nowhere to push it — deleting it would lose the files outright`);
      }
      if (status.worktrees.length) {
        const total = status.worktrees.reduce((n, w) => n + w.dirty, 0);
        const where = status.worktrees.length === 1
          ? `the ${status.worktrees[0].name} worktree`
          : `${status.worktrees.length} worktrees (${status.worktrees.map((w) => w.name).join(', ')})`;
        block(`${total} uncommitted change${total === 1 ? '' : 's'} in ${where} would be lost — nothing commits a worktree on the way out`);
      }
      for (const repo of status.repos) {
        if (repo.stashes) {
          block(`${repo.stashes} stashed change${repo.stashes === 1 ? '' : 's'} in ${label(name, repo)} would be lost — a stash is not pushed by anything`);
        }
      }
    }

    /**
     * Save one repository: commit what is loose, push every branch and tag, then
     * ask the remote whether it really has the commit.
     */
    const save = async (repo) => {
      const dir = repo.path;
      const where = label(name, repo);
      const at = (step, rest) => steps.push({ step, dir: repo.dir, ...rest });

      if (repo.hasCommits && repo.branch === 'HEAD' && !force) {
        block(`HEAD is detached in ${where} — check out a branch so there is something to push`);
      }

      if (repo.dirty) {
        const add = await git(dir, ['add', '-A'], { timeout: 300_000 });
        if (!add.ok && !force) block(`git add failed in ${where}: ${add.err}`);
        const commit = await git(
          dir,
          ['commit', '-m', 'Save work before removing this project from the workspace'],
          { timeout: 300_000 },
        );
        // "nothing to commit" is a success here: it means everything still
        // showing as dirty was ignored, which the ignored-files list covers.
        const empty = /nothing to commit|nothing added to commit/i.test(`${commit.out}\n${commit.err}`);
        if (!commit.ok && !empty && !force) block(`git commit failed in ${where}: ${commit.err || commit.out}`);
        at('commit', { ok: commit.ok || empty, error: commit.ok || empty ? undefined : commit.err });
      }

      // Re-read after the commit: an empty repository that had uncommitted files
      // has a HEAD (and a branch) now, and both are what the push verifies.
      const hasCommits = (await git(dir, ['rev-parse', '--verify', 'HEAD'])).ok;
      const branch = hasCommits
        ? (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).out
        : null;

      if (!hasCommits) {
        // A git repo with no commits holds nothing a push could preserve.
        at('push', { ok: true, note: 'no commits to push' });
      } else if (!repo.remote && !force) {
        block(`${where} has no git remote — there is nothing to push to, so deleting it would lose the commits`);
      } else if (repo.remote) {
        // Every branch and every tag, because none of them survive the delete.
        const all = await git(dir, ['push', '--all', 'origin'], { timeout: 900_000 });
        if (all.ok) {
          at('push', { ok: true });
        } else {
          // One branch failing (a diverged side branch, a protected ref) must not
          // stop the current branch from being saved. The verification below is
          // what decides whether pushing only HEAD was good enough.
          const head = await git(dir, ['push', '-u', 'origin', 'HEAD'], { timeout: 900_000 });
          at('push', {
            ok: head.ok,
            note: head.ok ? `some branches were not pushed: ${all.err.slice(0, 200)}` : undefined,
            error: head.ok ? undefined : head.err.slice(0, 300),
          });
        }
        const tags = await git(dir, ['push', '--tags', 'origin'], { timeout: 300_000 });
        if (!tags.ok) at('push tags', { ok: false, error: tags.err.slice(0, 200) });
      }

      if (hasCommits && !force) {
        const leftover = await git(dir, ['log', '--oneline', '--branches', '--not', '--remotes']);
        if (leftover.out) {
          const n = leftover.out.split('\n').length;
          block(`${n} commit${n === 1 ? '' : 's'} in ${where} still exist only on this machine after pushing — refusing to delete`);
        }

        // Ask the remote directly. The check above trusts remote-tracking refs,
        // which are local files and can be stale or hand-edited; this one cannot.
        const local = await git(dir, ['rev-parse', 'HEAD']);
        const remoteRef = await git(dir, ['ls-remote', 'origin', `refs/heads/${branch}`], {
          timeout: 120_000,
        });
        if (!remoteRef.ok) block(`could not reach the remote of ${where} to verify the push: ${remoteRef.err}`);
        if (!remoteRef.out.startsWith(local.out)) {
          block(`the remote's ${branch} for ${where} is not at the commit on this machine — refusing to delete`);
        }
        at('verify', { ok: true, commit: local.out.slice(0, 12), branch });
      }
    };

    // Deepest first. An embedded repo has to reach its own remote before the repo
    // containing it commits the gitlink pointing at it, or the outer repo's
    // history references a commit that only this disk has.
    for (const repo of [...status.repos].reverse()) await save(repo);

    // Stop the processes before the directory goes away: a `claude` whose cwd has
    // been deleted keeps running against a working directory that no longer
    // exists, which fails in far more confusing ways than being stopped here.
    for (const conv of this.#liveIn(path)) {
      conv.stop();
      this.#forget(conv);
    }

    await rm(path, { recursive: true, force: true });
    steps.push({ step: 'delete', ok: true });

    return { name, removed: true, steps, transcriptsKept: status.transcripts, forced: force };
  }

  /**
   * Clone a repository that already exists on GitHub into the workspace.
   *
   * `gh` is preferred when a token is available — it is what `createProject`
   * already uses, and it authenticates private clones without depending on the
   * credential helper being configured. Plain `git clone` is the fallback, which
   * is what works on a box provisioned with the helper but no gh.
   */
  async cloneProject({ repo, name, into } = {}) {
    const { slug, repo: repoName } = parseGithubRepo(repo);
    const target = name ? name : repoName;

    // `into` is what makes a project able to hold more than one repository: the
    // clone lands in a subdirectory of an existing project instead of becoming a
    // project of its own. Both names go through the same validation, because both
    // are caller-supplied and both end up as a path component.
    let parent = PROJECTS_ROOT;
    if (into) {
      parent = projectPathFor(into);
      const info = await stat(parent).catch(() => null);
      if (!info?.isDirectory()) throw new Error(`no project named "${into}"`);
    }
    // Reuses the project-name rules deliberately: no slash and no leading dot is
    // exactly what keeps `join` from writing outside the directory chosen above.
    const path = join(parent, assertSafeName(target));

    if (await stat(path).catch(() => null)) {
      throw new Error(
        into
          ? `"${into}" already has a ${target} directory`
          : `"${target}" already exists in the workspace`,
      );
    }
    await mkdir(parent, { recursive: true });

    const steps = [];
    const token = await getGithubToken();
    const url = `https://github.com/${slug}.git`;
    // A big repository on a small instance is minutes, not seconds. nginx and the
    // ALB both allow an hour, so the ceiling here is the real one.
    const timeout = 900_000;

    let clone;
    if (token) {
      clone = await git(parent, ['clone', '--recurse-submodules', url, target], {
        timeout,
        env: { GH_TOKEN: token, GITHUB_TOKEN: token },
      });
      if (!clone.ok) {
        // gh knows how to turn a token into git credentials on its own.
        const viaGh = await execFileAsync('gh', ['repo', 'clone', slug, path, '--', '--recurse-submodules'], {
          timeout,
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token, GIT_TERMINAL_PROMPT: '0' },
        }).then(
          () => ({ ok: true, out: '', err: '' }),
          (err) => ({ ok: false, out: '', err: (err.stderr || err.message || '').toString().trim() }),
        );
        if (viaGh.ok) clone = viaGh;
      }
    } else {
      clone = await git(parent, ['clone', '--recurse-submodules', url, target], { timeout });
    }

    if (!clone.ok) {
      // A failed clone can leave a partial directory behind, and a half-repo in
      // the project list is worse than no project at all. `path` and never
      // `parent`: cloning into an existing project must not be able to delete the
      // project it was cloning into.
      await rm(path, { recursive: true, force: true }).catch(() => {});
      const hint = /not found|repository .* does not exist|could not read Username/i.test(clone.err)
        ? ' — check the name, and that the workspace token can see it'
        : '';
      throw new Error(`clone failed: ${clone.err.slice(0, 400)}${hint}`);
    }
    steps.push({ step: 'clone', ok: true, url: `https://github.com/${slug}`, dir: into ? target : '' });

    // A repository cloned *into* a project is not a project of its own, so it gets
    // no slots; the project it joined has its own, or none if its root is no repo.
    if (!into) steps.push(slotStep(await ensureSlots(path)));

    // The project is what the client opens, so when the clone went *into* one, the
    // answer is that project and not the directory just created inside it.
    if (into) {
      return { name: into, path: parent, repo: target, sessions: await this.listSessions(parent), steps };
    }
    return { name: target, path, sessions: [], steps };
  }

  /**
   * The repositories this workspace's token can see, so cloning is a tap rather
   * than typing `owner/repo` on a phone keyboard.
   */
  async listGithubRepos({ limit = 60 } = {}) {
    const token = await getGithubToken();
    if (!token) throw new Error('no GitHub token is configured for this workspace');

    const { stdout } = await execFileAsync(
      'gh',
      [
        'repo', 'list',
        '--limit', String(Math.min(Math.max(Number(limit) || 60, 1), 200)),
        '--json', 'nameWithOwner,description,isPrivate,updatedAt',
      ],
      {
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token },
      },
    );

    const present = new Set(
      (await readdir(PROJECTS_ROOT, { withFileTypes: true }).catch(() => []))
        .filter((e) => e.isDirectory())
        .map((e) => e.name),
    );

    return JSON.parse(stdout || '[]').map((r) => ({
      slug: r.nameWithOwner,
      name: r.nameWithOwner.split('/')[1],
      description: r.description || '',
      private: Boolean(r.isPrivate),
      updatedAt: r.updatedAt,
      // Already here: the UI labels these instead of offering a clone that would
      // fail on the "already exists" check.
      present: present.has(r.nameWithOwner.split('/')[1]),
    }));
  }
}

// mangleCwd and CLAUDE_HOME are exported for claude-status.js, which reads the
// same transcripts from the other end. Shared rather than copied: the symlink
// resolution above is the kind of detail that silently stops finding anything
// when two copies drift. projectPlaces is there for the same reason and more so —
// "which directories hold this project's conversations" is answered by three files
// now, and a reader that misses a worktree loses a live conversation silently.
export {
  PROJECTS_ROOT,
  CLAUDE_HOME,
  DEFAULT_MODEL,
  mangleCwd,
  transcriptDir,
  projectPlaces,
  parseGithubRepo,
  projectPathFor,
};
