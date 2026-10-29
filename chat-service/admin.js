/**
 * What is actually running on this box, and how to stop one of it.
 *
 * Every hard-won note in AGENTS.md was found the same way: an SSM shell, `ps`,
 * and `journalctl`. Ten never-spoken-to probe processes at ~205 MB each, 2.0 GB of
 * 7.8 GB. Three `claude` processes against one project, two devices telling
 * different stories. A tmux server in the wrong cgroup, discovered only when a
 * deploy killed the work it was supposed to protect. None of those were visible
 * from any of the app's own surfaces, and all of them are visible from `ps`.
 *
 * So this file is that shell, on a phone. It is read-only apart from three
 * explicit kills, and it deliberately does not become a monitoring system: no
 * history, no storage, no alerting. It answers "what is running right now" and
 * "why does this box feel wrong", which are the two questions that have actually
 * come up.
 *
 * THE BROKER GETS NO NEW OP, ON PURPOSE. Adding a list/kill op to
 * `claude-broker/broker.js` would be the obvious way to enumerate its sessions,
 * and it would be the wrong one: the conversations are children of that process,
 * so a change to it only takes effect at a restart, and a restart ends every live
 * conversation — the exact failure the broker exists to prevent. Its children are
 * ordinary processes owned by the same user as this service, so `ps` and `/proc`
 * answer most of this for free, and a SIGTERM to one of them is handled by the
 * broker's own exit handler, which tells the attached pages and unregisters the
 * session.
 *
 * What `ps` cannot answer is which conversation a process IS. Argv names one only
 * when the editor resumed it; a conversation started fresh is named by the CLI at
 * runtime, in an init event that only the broker sees — five of nine live
 * processes on the box, unnameable from outside. So the id comes from the READ-ONLY
 * `op: 'status'` the broker already answers, which is why this still needs no
 * change to `broker.js` and no restart: `chat-service/claude-status.js` has spoken
 * that op since it shipped. It is asked for a name, never for authority — every
 * stop still goes through a freshly-read process table and a parent we expected —
 * and an unanswered ask degrades to what argv says, never to a blank page.
 *
 * Security: this adds no authority. Every route in front of it sits behind the
 * same gate as `/ws`, which already hands the caller a shell with
 * `bypassPermissions`. What it must never do is turn a caller-supplied string
 * into a signal for an arbitrary process, so a pid is only ever signalled after
 * being found in a freshly-read process table under a parent we expected.
 */
import { readFile, readlink } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import { brokerSessions as liveBrokerSessions } from './claude-status.js';
import { buildInfo } from './build.js';
import { HOST_MODE, PROJECTS_ROOT, feature } from './host.js';
import { projectLabel } from './projects.js';

const execFileAsync = promisify(execFile);

/**
 * The units the deployment is made of. Order is the order they are shown in.
 *
 * A host install names its own (deploy/host/install.sh) so they cannot be mistaken
 * for the workspace box's, and has the editor's two only when the editor is part
 * of it — a unit that was never installed is not a unit that is down.
 */
const UNIT = HOST_MODE
  ? { chat: 'triplec-chat', editor: 'code-server', broker: 'claude-broker', tmux: 'triplec-tmux' }
  : { chat: 'claude-chat', editor: 'code-server', broker: 'claude-broker', tmux: 'claude-tmux' };
const UNITS = [
  UNIT.chat,
  ...(HOST_MODE && !feature('editor') ? [] : [UNIT.editor, UNIT.broker]),
  ...(HOST_MODE && !feature('mux') ? [] : [UNIT.tmux]),
  'nginx',
];

const DATA_MOUNT = PROJECTS_ROOT;

/**
 * A refusal the UI can act on, rather than a crash. Same shape as the one
 * `session-manager.js` throws for a project removal, and for the same reason:
 * stopping a process that may hold a turn in flight is a question for the user,
 * and the honest answer has a reason attached.
 */
export class AdminBlocked extends Error {
  constructor(message, { target = null } = {}) {
    super(message);
    this.name = 'AdminBlocked';
    this.blocked = true;
    this.target = target;
  }
}

async function defaultRun(cmd, args, { timeout = 10_000 } = {}) {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, out: (stdout || '').trim() };
  } catch (err) {
    return { ok: false, out: (err.stdout || '').toString().trim(), err: (err.stderr || err.message || '').toString() };
  }
}

const defaultDeps = {
  run: defaultRun,
  readProcFile: (path) => readFile(path, 'utf8'),
  readProcLink: (path) => readlink(path),
  sendSignal: (pid, signal) => process.kill(pid, signal),
  // Null for every kind of "cannot say", and this page must stay useful when it
  // is: the broker being down is one of the things you come here to find out.
  liveSessions: () => liveBrokerSessions(),
  // Which payload is running. It belongs on this page more than anywhere else:
  // "the box is behaving oddly" and "the box is running something older than I
  // think" are the same question asked twice, and until this was here the second
  // one could only be answered from a shell. See build.js.
  build: () => buildInfo(),
  memory: () => ({ total: os.totalmem(), free: os.freemem() }),
  load: () => os.loadavg(),
  uptime: () => os.uptime(),
  now: () => Date.now(),
};

/**
 * One `ps` call for the whole box, rather than a walk of /proc per question.
 *
 * `args` goes last because it contains spaces; everything before it is a single
 * field. `etimes` is elapsed seconds, which avoids parsing a locale-formatted
 * start date only to subtract it from now again.
 */
async function processTable(deps) {
  const res = await deps.run('ps', ['-eo', 'pid=,ppid=,rss=,etimes=,args=']);
  if (!res.ok) return [];
  const rows = [];
  for (const line of res.out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 5) continue;
    const [pid, ppid, rss, etimes] = parts;
    rows.push({
      pid: Number(pid),
      ppid: Number(ppid),
      rssKb: Number(rss),
      ageSeconds: Number(etimes),
      args: parts.slice(4).join(' '),
    });
  }
  return rows.filter((r) => Number.isFinite(r.pid));
}

/**
 * Pull the interesting flags out of a `claude` command line.
 *
 * The probe classification is the one that earns this function. The extension
 * starts two processes per page load and only ever speaks to one: the other is a
 * probe with `--permission-mode default` and no `--resume`, which it never writes
 * a byte to. Through the broker each of those became a resident process that
 * nothing could name — ten of them, 2.0 GB. From outside, argv is exactly what
 * tells them apart, and being able to name them is what makes them reapable.
 */
export function parseClaudeArgs(args) {
  const tokens = String(args || '').split(/\s+/);
  /*
   * Both spellings of every flag, because the choice is not ours to make and it
   * is not even consistent within one command line: extension 2.1.278 launches
   * `--resume=<id>` joined and `--permission-mode <mode>` spaced, in the same
   * argv. Reading only the spaced form meant `resume` was ALWAYS null, so every
   * conversation on the box read "no session" — and, far worse, the fork finding
   * below groups by this id and therefore silently matched nothing, on the one
   * page that exists to catch a fork. Measured before this fix: 9 live broker
   * children, 8 of them nameable from argv, 0 named.
   *
   * `claude-broker/wrapper` has read both spellings since it shipped; this is
   * the same rule, and the two must not disagree about what is being resumed.
   */
  const valueOf = (flag) => {
    const joined = tokens.find((t) => t.startsWith(`${flag}=`));
    if (joined !== undefined) return joined.slice(flag.length + 1) || null;
    const i = tokens.indexOf(flag);
    if (i < 0) return null;
    const next = tokens[i + 1];
    // A flag with no value: `--resume` alone means "pick one interactively",
    // which names no session. Taking the next token regardless turned that into
    // a session id of `--permission-mode`.
    return next !== undefined && !next.startsWith('-') ? next : null;
  };
  const isClaude = tokens.some((t) => t === 'claude' || t.endsWith('/claude'));
  const resume = valueOf('--resume');
  const permissionMode = valueOf('--permission-mode');
  return {
    isClaude,
    resume,
    permissionMode,
    model: valueOf('--model'),
    // No conversation to resume and the default permission mode: the panel's
    // probe. A real conversation either resumes an id or was started with this
    // deployment's own permission mode, which is never `default`.
    probe: isClaude && !resume && permissionMode === 'default',
  };
}

/** `systemctl show` for one unit. Read-only, and needs no privilege. */
async function unitState(deps, name) {
  const res = await deps.run('systemctl', [
    'show', name,
    '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID', '-p', 'MemoryCurrent',
  ]);
  const fields = {};
  for (const line of (res.out || '').split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) fields[line.slice(0, eq)] = line.slice(eq + 1);
  }
  const memory = Number(fields.MemoryCurrent);
  return {
    name,
    active: fields.ActiveState === 'active',
    state: fields.ActiveState || 'unknown',
    sub: fields.SubState || '',
    mainPid: Number(fields.MainPID) || null,
    // systemd reports `[not set]` for a unit with no accounting, which is not 0.
    memoryBytes: Number.isFinite(memory) && memory > 0 ? memory : null,
  };
}

/** Where a process's working directory is, or null when it has gone away. */
async function cwdOf(deps, pid) {
  try {
    return await deps.readProcLink(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

const projectOf = (cwd) => (cwd ? projectLabel(cwd) : null);

/**
 * The editor panel's conversations: children of the broker, one per conversation.
 *
 * Named from two places, because neither is enough on its own. Argv names a
 * conversation the editor RESUMED. A conversation started fresh in the panel was
 * launched with no id to carry — the CLI invents one and announces it in an init
 * event — so argv cannot name it however carefully it is read, and five of the nine
 * processes on the box were that kind. The broker heard those events, so it is
 * asked; when it cannot answer, argv is still the answer it always was.
 *
 * Asked once for the whole page rather than per process: it is one socket
 * round-trip, and `op: 'status'` deliberately does not count the asker as a client,
 * so opening this page cannot keep a conversation alive.
 */
async function brokerSessions(deps, table, brokerPid) {
  if (!brokerPid) return [];
  const live = (await deps.liveSessions()) || [];
  const livePid = new Map(live.filter((s) => s && s.pid).map((s) => [s.pid, s]));
  const out = [];
  for (const proc of table) {
    if (proc.ppid !== brokerPid) continue;
    const parsed = parseClaudeArgs(proc.args);
    if (!parsed.isClaude) continue;
    const cwd = await cwdOf(deps, proc.pid);
    const known = livePid.get(proc.pid);
    out.push({
      kind: 'broker',
      pid: proc.pid,
      // Argv first: it is what the editor asked for, and it is true even when the
      // broker has been replaced under these processes.
      sessionId: parsed.resume || known?.sessionId || null,
      cwd,
      project: projectOf(cwd),
      model: parsed.model,
      permissionMode: parsed.permissionMode,
      probe: parsed.probe,
      // Null rather than false when the broker did not say, because "not working"
      // and "nobody could tell me" are different answers and only one of them is
      // safe to act on. Not used to decide anything here — the stop path asks the
      // manager, never this — but shown, because it is the question the page is
      // most often opened to answer.
      working: known ? known.working : null,
      /*
       * What it is waiting for a person to answer, when it is waiting for one:
       * `'permission'` for a tool approval, `'question'` for an `AskUserQuestion`,
       * plus what it is about and how long it has been sitting there.
       *
       * This is the half of `working` that made the badge worth so little. A
       * conversation stopped at a permission prompt is working by every definition the
       * broker can defend, and nothing will happen in it until somebody clicks — which
       * is the one thing a page full of "working" rows could not tell you. Only the
       * broker sees it: the prompt goes out on the CLI's stdout and the answer comes
       * back up its stdin, and neither is written to the transcript.
       *
       * Null for all three when nothing is waiting, when the broker could not be asked,
       * and when it is too old to have an opinion — the same conflation `working` makes
       * above, and safe for the same reason: no client acts on this, it only reads.
       */
      awaiting: known ? known.awaiting ?? null : null,
      awaitingName: known ? known.awaitingName ?? null : null,
      awaitingMs: known ? known.awaitingMs ?? null : null,
      clients: known ? known.clients : null,
      rssKb: proc.rssKb,
      ageSeconds: proc.ageSeconds,
    });
  }
  return out;
}

/**
 * The tmux surface. `cc` names its sessions `claude-<project>`, and anything else
 * on this server is someone's own shell — shown, because a stray session holding
 * memory is exactly the sort of thing this page is for, but never offered as a
 * Claude session.
 */
async function tmuxSessions(deps, table, tmuxServerPid) {
  const res = await deps.run('tmux', [
    'list-sessions', '-F', '#{session_name}\t#{session_created}\t#{session_attached}\t#{pane_pid}',
  ]);
  // A server with no sessions exits non-zero with "no server running"; that is an
  // answer, not a failure.
  if (!res.ok) return [];

  const byPid = new Map(table.map((p) => [p.pid, p]));
  const sessions = [];
  for (const line of res.out.split('\n')) {
    if (!line.trim()) continue;
    const [name, created, attached, panePid] = line.split('\t');
    const pid = Number(panePid);
    // Everything the pane forked, so the reported memory is the shell *and* the
    // Claude inside it rather than the shell alone.
    const tree = [byPid.get(pid), ...table.filter((p) => p.ppid === pid)].filter(Boolean);
    sessions.push({
      kind: 'tmux',
      name,
      project: name.startsWith('claude-') ? name.slice('claude-'.length) : null,
      isClaudeSession: name.startsWith('claude-'),
      attachedClients: Number(attached) || 0,
      createdAt: Number(created) * 1000 || null,
      pid: Number.isFinite(pid) ? pid : null,
      rssKb: tree.reduce((sum, p) => sum + p.rssKb, 0),
      hasClaude: tree.some((p) => parseClaudeArgs(p.args).isClaude),
    });
  }
  // The durability of every one of these depends on the server's cgroup, so it is
  // reported alongside them rather than left to be discovered by a deploy.
  const cgroup = tmuxServerPid ? await readCgroup(deps, tmuxServerPid) : null;
  for (const session of sessions) session.serverInOwnUnit = cgroup === null ? null : cgroup.includes(UNIT.tmux);
  return sessions;
}

async function readCgroup(deps, pid) {
  try {
    return await deps.readProcFile(`/proc/${pid}/cgroup`);
  } catch {
    return null;
  }
}

async function diskUsage(deps, path) {
  const res = await deps.run('df', ['-kP', path]);
  if (!res.ok) return null;
  const line = res.out.split('\n').slice(1)[0];
  if (!line) return null;
  const parts = line.trim().split(/\s+/);
  const totalKb = Number(parts[1]);
  const usedKb = Number(parts[2]);
  if (!Number.isFinite(totalKb) || !Number.isFinite(usedKb)) return null;
  return { path, totalKb, usedKb, percent: totalKb ? Math.round((usedKb / totalKb) * 100) : null };
}

/**
 * The findings. This is the part worth having: each one is a failure this project
 * has already had, phrased as the thing you would want to be told.
 */
function findings({ units, chat, broker, tmux, memory, disk }) {
  const out = [];
  const unit = (name) => units.find((u) => u.name === name);

  for (const name of UNITS) {
    const u = unit(name);
    if (u && !u.active) {
      out.push({
        level: 'error',
        text: `${name} is ${u.state}${u.sub ? ` (${u.sub})` : ''}`,
        // The broker being down is not a visible failure — it is a silent
        // regression to one Claude per browser page, which is why it is called out
        // rather than left to be inferred from a dot.
        detail: name === UNIT.broker
          ? 'the editor panel forks a separate Claude per page load while this is down'
          : name === UNIT.tmux
            ? 'the next `cc` will start a tmux server inside code-server, and a deploy will kill its sessions'
            : null,
      });
    }
  }

  // The fork. Two processes resuming one session id, both appending to one
  // transcript — what the user sees is two devices telling different stories, and
  // until now the only way to find it was to count processes by hand on the box.
  const byResume = new Map();
  for (const proc of [...broker, ...chat]) {
    if (!proc.sessionId) continue;
    const list = byResume.get(proc.sessionId) || [];
    list.push(proc);
    byResume.set(proc.sessionId, list);
  }
  for (const [sessionId, procs] of byResume) {
    if (procs.length < 2) continue;
    out.push({
      level: 'error',
      text: `${procs.length} processes are resuming session ${sessionId.slice(0, 8)}…`,
      detail: 'they append to one transcript and will diverge; stop all but the one you are using',
    });
  }

  /*
   * Waiting on a person. Not a fault, and the only finding here that is not — it is
   * the thing this page could not say at all before, and the answer to the question
   * that brings someone to it: which of these rows is actually moving. A conversation
   * parked on a permission prompt is indistinguishable from a busy one by every other
   * number we have, and it will sit there until it is clicked, so the wait is the
   * headline. Raised out of `info` once it has been long enough that whoever started
   * it has plainly walked away.
   */
  const waiting = broker.filter((s) => s.awaiting);
  if (waiting.length) {
    const longest = waiting.reduce((a, b) => ((b.awaitingMs ?? 0) > (a.awaitingMs ?? 0) ? b : a));
    const minutes = Math.round((longest.awaitingMs ?? 0) / 60_000);
    const how = minutes >= 1 ? `${minutes} minute${minutes === 1 ? '' : 's'}` : null;
    out.push({
      level: minutes >= 30 ? 'warn' : 'info',
      text: waiting.length === 1
        ? 'a conversation is waiting for an answer from you'
        : `${waiting.length} conversations are waiting for an answer from you`,
      detail: [
        how && (waiting.length === 1 ? `it has sat there ${how}` : `the longest has sat there ${how}`),
        'answer it in the editor panel; nothing moves in it until you do',
      ].filter(Boolean).join(' — '),
    });
  }

  const probes = broker.filter((s) => s.probe);
  if (probes.length) {
    const mb = Math.round(probes.reduce((sum, p) => sum + p.rssKb, 0) / 1024);
    out.push({
      level: probes.length > 2 ? 'warn' : 'info',
      text: `${probes.length} idle probe${probes.length === 1 ? '' : 's'} holding ${mb} MB`,
      detail: 'the editor panel starts one per page load and never speaks to it; safe to reap',
      action: 'reap',
    });
  }

  const strayTmux = tmux.find((s) => s.serverInOwnUnit === false);
  if (strayTmux) {
    out.push({
      level: 'error',
      text: `the tmux server is not ${UNIT.tmux}.service`,
      detail: 'its sessions are in code-server\'s cgroup, so the next deploy will kill them',
    });
  }

  if (memory.percent >= 85) {
    out.push({
      level: memory.percent >= 93 ? 'error' : 'warn',
      text: `memory is ${memory.percent}% used`,
      detail: 'each Claude holds ~200 MB; reaping probes is the cheapest thing to try first',
    });
  }
  if (disk && disk.percent >= 85) {
    out.push({ level: disk.percent >= 93 ? 'error' : 'warn', text: `${disk.path} is ${disk.percent}% full` });
  }

  return out;
}

export function createAdmin({ manager, deps: overrides = {} } = {}) {
  const deps = { ...defaultDeps, ...overrides };

  /** Everything the dashboard shows, in one round trip. */
  async function overview() {
    const [table, units] = await Promise.all([
      processTable(deps),
      Promise.all(UNITS.map((name) => unitState(deps, name))),
    ]);
    const brokerUnit = units.find((u) => u.name === UNIT.broker) || { name: UNIT.broker, active: false, state: 'not installed' };
    const tmuxUnit = units.find((u) => u.name === UNIT.tmux) || { name: UNIT.tmux, active: false, state: 'not installed' };

    const byPid = new Map(table.map((p) => [p.pid, p]));
    // The chat's own conversations come from memory — this service owns them — and
    // are enriched from the table, because how much a conversation costs is a
    // question only the OS can answer.
    const chat = (manager?.inventory() || []).map((conv) => {
      const proc = conv.pid ? byPid.get(conv.pid) : null;
      return {
        kind: 'chat',
        ...conv,
        rssKb: proc?.rssKb ?? null,
        ageSeconds: proc?.ageSeconds ?? null,
        // A conversation whose process has gone is a row worth seeing: it is what
        // "the chat says session ended" looks like from this side.
        alive: Boolean(proc),
      };
    });

    const [broker, tmux, disk, build] = await Promise.all([
      brokerSessions(deps, table, brokerUnit?.mainPid || null),
      tmuxSessions(deps, table, tmuxUnit?.mainPid || null),
      diskUsage(deps, DATA_MOUNT),
      deps.build(),
    ]);

    const mem = deps.memory();
    const memory = {
      totalKb: Math.round(mem.total / 1024),
      freeKb: Math.round(mem.free / 1024),
      percent: mem.total ? Math.round(((mem.total - mem.free) / mem.total) * 100) : null,
    };

    return {
      generatedAt: deps.now(),
      host: {
        hostname: os.hostname(),
        uptimeSeconds: Math.round(deps.uptime()),
        load: deps.load().map((n) => Math.round(n * 100) / 100),
        memory,
        disk,
        build,
      },
      units,
      surfaces: { chat, broker, tmux },
      findings: findings({ units, chat, broker, tmux, memory, disk }),
    };
  }

  /**
   * Stop one thing.
   *
   * The refusals are the design. Everything here may hold a turn in flight, and a
   * killed turn is not recoverable — so anything that could be live comes back as
   * a refusal carrying the reason, and `force` is the answer to that specific
   * question rather than a flag the client sets by habit. Only a probe, which by
   * definition has never been spoken to, goes on one tap.
   */
  async function kill({ kind, target, force = false } = {}) {
    if (kind === 'chat') {
      const conv = (manager?.inventory() || []).find((c) => c.id === target);
      if (!conv) throw new AdminBlocked('that conversation is no longer running', { target });
      if (conv.busy && !force) {
        throw new AdminBlocked(
          'that chat is working right now — stopping it loses the turn in flight',
          { target },
        );
      }
      const stopped = manager.stopConversation(target);
      return { stopped: Boolean(stopped), kind, target, wasBusy: Boolean(stopped?.wasBusy) };
    }

    if (kind === 'broker') {
      const pid = Number(target);
      if (!Number.isInteger(pid) || pid <= 1) throw new AdminBlocked('not a pid', { target });
      // Re-read the table and re-check the parent. A pid from the client is a
      // number, and the process wearing it now may not be the one the page was
      // looking at when it rendered — so membership is proved again here, against
      // the broker we expect, immediately before the signal.
      const [table, unit] = await Promise.all([processTable(deps), unitState(deps, UNIT.broker)]);
      const proc = table.find((p) => p.pid === pid);
      if (!proc) throw new AdminBlocked('that process has already gone', { target });
      if (!unit.mainPid || proc.ppid !== unit.mainPid) {
        throw new AdminBlocked('that pid is not a broker conversation', { target });
      }
      const parsed = parseClaudeArgs(proc.args);
      if (!parsed.isClaude) throw new AdminBlocked('that pid is not a claude process', { target });
      if (!parsed.probe && !force) {
        throw new AdminBlocked(
          'that is a live conversation — a device may be mid-turn in it',
          { target },
        );
      }
      deps.sendSignal(pid, 'SIGTERM');
      return { stopped: true, kind, target: pid, wasProbe: parsed.probe };
    }

    if (kind === 'tmux') {
      const name = String(target || '');
      // Goes to `tmux kill-session -t`, so it is validated rather than trusted:
      // tmux target syntax has its own sigils, and a name is not a place to find
      // out which ones. One `/` is allowed, for a worktree slot's session —
      // `claude-<project>/slot-3`, see scripts/cc-session.sh — and neither half may
      // start with a dot, so nothing here reads like a path.
      if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)?$/.test(name)) {
        throw new AdminBlocked('not a session name', { target });
      }
      if (!name.startsWith('claude-')) {
        throw new AdminBlocked('only sessions started by `cc` can be stopped here', { target });
      }
      if (!force) {
        throw new AdminBlocked(
          'a tmux session holds a real terminal and its scrollback — ending it cannot be undone',
          { target },
        );
      }
      // `=`: exactly this session. A bare name is a prefix match when no session has
      // exactly that name — a session that ended a moment ago would make this stop
      // `claude-demo/slot-3` in place of `claude-demo`.
      const res = await deps.run('tmux', ['kill-session', '-t', `=${name}`]);
      if (!res.ok) throw new AdminBlocked(`tmux refused: ${(res.err || '').slice(0, 200)}`, { target });
      return { stopped: true, kind, target: name };
    }

    throw new AdminBlocked(`unknown target kind "${kind}"`, { target });
  }

  /**
   * Stop every probe the broker is holding.
   *
   * The one-tap answer to the 2.0 GB story. Safe because a probe has never been
   * written to — no conversation, no transcript, nothing in flight — and because
   * the classification comes from argv rather than from a guess about age or size.
   */
  async function reap() {
    const [table, unit] = await Promise.all([processTable(deps), unitState(deps, UNIT.broker)]);
    if (!unit.mainPid) return { stopped: 0, freedKb: 0 };
    let stopped = 0;
    let freedKb = 0;
    for (const proc of table) {
      if (proc.ppid !== unit.mainPid) continue;
      if (!parseClaudeArgs(proc.args).probe) continue;
      try {
        deps.sendSignal(proc.pid, 'SIGTERM');
        stopped += 1;
        freedKb += proc.rssKb;
      } catch {
        /* it exited between the table and the signal, which is the outcome anyway */
      }
    }
    return { stopped, freedKb };
  }

  return { overview, kill, reap };
}
