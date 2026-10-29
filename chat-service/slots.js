/**
 * Worktree slots: eight standing checkouts per project, one conversation each.
 *
 * Every project used to be one working tree shared by every session in it, and
 * AGENTS.md spends a section on what that costs — `git add -A` sweeping up another
 * session's half-written file, a checkout reverting work that was never yours. The
 * answer there is "enter a worktree when the work will sit", which each session has
 * to remember to do and then clean up after.
 *
 * A slot makes that the default instead of a discipline. `<project>/.claude/
 * worktrees/slot-1` … `slot-8` are ordinary linked worktrees, each on a branch of
 * the same name, created when a project arrives (clone or new) and on first use for
 * one that predates this. The path is the one Claude Code's own EnterWorktree uses,
 * which is not a coincidence: `projectPlaces` in session-manager.js already finds a
 * conversation in `.claude/worktrees/*`, so a slot's chats show up in the phone's
 * list, labelled with the slot, with nothing else changed.
 *
 * The mux surface (/chat/mux) is the reason there are eight of them: it is the
 * desktop view with several conversations side by side, and eight agents in one
 * checkout is the collision above times eight.
 *
 * Nothing here ever discards work. A slot is created if missing, and refreshed —
 * fast-forwarded to the default branch — only when it is clean and holds no commit
 * of its own. A slot with anything in it is left exactly as it is, and says so.
 */
import { execFile } from 'child_process';
import { appendFile, mkdir, readFile, readdir, readlink, stat } from 'fs/promises';
import { dirname, join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const SLOT_COUNT = 8;
const WORKTREES = ['.claude', 'worktrees'];

export const slotName = (n) => `slot-${n}`;

/** A slot number from anything a client sends, or null. */
export function parseSlot(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= SLOT_COUNT ? n : null;
}

export function slotPath(projectPath, n) {
  return join(projectPath, ...WORKTREES, slotName(n));
}

/**
 * The project and slot a directory is, or null when it is not exactly a slot of a
 * project directly under `root`.
 */
export function slotOf(cwd, root) {
  const m = /^(.+)\/\.claude\/worktrees\/slot-([1-8])$/.exec(String(cwd || ''));
  if (!m || dirname(m[1]) !== root) return null;
  return { projectPath: m[1], n: Number(m[2]) };
}

// Same contract as the helper in session-manager.js: report, never throw, and never
// let git wait on a terminal nobody is attached to.
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

const exists = async (path) => Boolean(await stat(path).catch(() => null));

/**
 * Whether a project can have slots: a repository at its root, with a commit.
 *
 * `.git` has to be a directory, for the reason `findRepos` gives — a file means the
 * project is itself somebody's worktree or submodule. A project of several repos
 * side by side has nothing at its root to branch from, and an empty repo has no
 * commit to put a worktree on; both are simply run without slots.
 */
export async function canHaveSlots(projectPath) {
  const dotGit = await stat(join(projectPath, '.git')).catch(() => null);
  if (!dotGit?.isDirectory()) return false;
  return (await git(projectPath, ['rev-parse', '--verify', 'HEAD'])).ok;
}

/**
 * What a slot is branched from and refreshed to: the remote's default branch when
 * there is one, else whatever the project's own checkout is on.
 */
async function baseRef(projectPath) {
  const head = await git(projectPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (head.ok && head.out) return head.out;
  for (const candidate of ['origin/main', 'origin/master']) {
    if ((await git(projectPath, ['rev-parse', '--verify', candidate])).ok) return candidate;
  }
  const local = await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return local.ok && local.out !== 'HEAD' ? local.out : 'HEAD';
}

/**
 * Keep the slots out of the project's own `git status`.
 *
 * `.git/info/exclude` rather than the project's .gitignore: this is a fact about
 * this machine, not about the repository, and editing .gitignore would leave every
 * project with an uncommitted change the moment it was cloned. Without it the main
 * checkout shows `.claude/` as untracked, and a `git add -A` there records eight
 * nested checkouts — the worst thing a sweep can pick up.
 */
async function excludeSlots(projectPath) {
  const file = join(projectPath, '.git', 'info', 'exclude');
  const line = '/.claude/worktrees/';
  const current = await readFile(file, 'utf8').catch(() => '');
  if (current.split('\n').some((l) => l.trim() === line)) return;
  await mkdir(join(projectPath, '.git', 'info'), { recursive: true });
  await appendFile(file, `${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`);
}

/**
 * Create one slot if it is missing. Returns `{ ok, created, error? }`.
 *
 * A branch can outlive its worktree — someone ran `git worktree remove` — so an
 * existing `slot-N` branch is checked out again rather than recreated from the base,
 * which would fail, and which would also be the wrong answer: that branch may hold
 * the commits of whoever worked there last.
 */
export async function ensureSlot(projectPath, n, { base = null } = {}) {
  const path = slotPath(projectPath, n);
  if (await exists(join(path, '.git'))) return { ok: true, created: false };
  if (await exists(path)) {
    // A directory with no checkout in it is not ours to fill or to delete.
    return { ok: false, created: false, error: `${path} exists but is not a worktree` };
  }
  // A worktree deleted by hand is still registered, and git refuses to reuse its path.
  await git(projectPath, ['worktree', 'prune']);
  await mkdir(join(projectPath, ...WORKTREES), { recursive: true });
  const branch = slotName(n);
  const hasBranch = (await git(projectPath, ['rev-parse', '--verify', `refs/heads/${branch}`])).ok;
  const add = hasBranch
    ? await git(projectPath, ['worktree', 'add', path, branch])
    : await git(projectPath, ['worktree', 'add', '--no-track', '-b', branch, path,
      base || (await baseRef(projectPath))]);
  return add.ok ? { ok: true, created: true } : { ok: false, created: false, error: add.err.slice(0, 300) };
}

/**
 * Every slot a project should have. Reported per slot rather than thrown, because a
 * project with seven slots is a working project — the caller adds it as a step.
 */
export async function ensureSlots(projectPath, { count = SLOT_COUNT } = {}) {
  if (!(await canHaveSlots(projectPath))) return { ok: false, skipped: true, created: 0 };
  await excludeSlots(projectPath);
  const base = await baseRef(projectPath);
  let created = 0;
  const errors = [];
  for (let n = 1; n <= count; n++) {
    const result = await ensureSlot(projectPath, n, { base });
    if (result.created) created++;
    if (!result.ok) errors.push(`${slotName(n)}: ${result.error}`);
  }
  return { ok: errors.length === 0, created, errors };
}

/**
 * What one slot holds that would make refreshing it, or deleting it, lose work.
 */
async function slotState(path) {
  const branch = await git(path, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const porcelain = await git(path, ['status', '--porcelain']);
  const dirty = porcelain.out ? porcelain.out.split('\n').length : 0;
  // Commits on this slot's HEAD that no remote-tracking ref has: work that exists
  // only here, whether or not it has been merged into the local main. Not asked of a
  // project with no remote, where every commit would count and the number would
  // say nothing.
  const remotes = await git(path, ['remote']);
  const local = remotes.out
    ? await git(path, ['log', '--oneline', 'HEAD', '--not', '--remotes'])
    : { ok: false, out: '' };
  const unpushed = local.ok && local.out ? local.out.split('\n').length : 0;
  return { branch: branch.ok ? branch.out : null, dirty, unpushed };
}

/**
 * The live `claude` processes on this box and the directory each runs in.
 *
 * From `/proc`, for the reason claude-status.js gives — a pid cannot go stale. This
 * is how a slot held by the editor's panel or a tmux session reads as taken, which
 * this service's own list of conversations cannot see.
 */
export async function claudeCwds({ proc = '/proc' } = {}) {
  const found = [];
  for (const entry of await readdir(proc).catch(() => [])) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const argv = (await readFile(join(proc, entry, 'cmdline'), 'utf8')).split('\0');
      const exe = argv[0]?.split('/').pop();
      // The CLI runs as `claude`, or as node with the CLI's entry script.
      if (exe !== 'claude' && !(exe === 'node' && /\/claude(-code)?\/|\/claude$/.test(argv[1] || ''))) continue;
      found.push({ pid: Number(entry), cwd: await readlink(join(proc, entry, 'cwd')) });
    } catch {
      /* gone between readdir and read, or not ours to see */
    }
  }
  return found;
}

/**
 * Every slot of a project, with what is in it and who is working there.
 *
 * `live` is this service's own conversations (`liveSummary`); `others` is the
 * output of `claudeCwds` with this service's pids already removed. A slot is
 * `busy` when one of ours is mid-turn there, and `held` when anyone at all has a
 * process in it — the editor, a terminal, or us.
 */
export async function listSlots(projectPath, { live = [], others = [] } = {}) {
  if (!(await canHaveSlots(projectPath))) return { enabled: false, slots: [] };
  const slots = [];
  for (let n = 1; n <= SLOT_COUNT; n++) {
    const path = slotPath(projectPath, n);
    const inside = (cwd) => cwd === path || String(cwd).startsWith(`${path}/`);
    const created = await exists(join(path, '.git'));
    const mine = live.filter((s) => inside(s.cwd));
    const theirs = others.filter((p) => inside(p.cwd));
    slots.push({
      n,
      name: slotName(n),
      cwd: path,
      created,
      ...(created ? await slotState(path) : { branch: null, dirty: 0, unpushed: 0 }),
      sessions: mine.map((s) => ({ sessionId: s.sessionId, busy: Boolean(s.busy) })),
      busy: mine.some((s) => s.busy),
      held: mine.length > 0 || theirs.length > 0,
      elsewhere: theirs.length,
    });
  }
  return { enabled: true, slots };
}

/**
 * Get a slot ready for a new conversation: create it if missing, and bring it up to
 * date if — and only if — nothing in it would be lost.
 *
 * Up to date means a fast-forward to the default branch, after a fetch. `--ff-only`
 * is the whole safety argument: it cannot succeed if the slot has a commit the base
 * does not, so a slot somebody committed in and never merged is left alone. The
 * count of those commits is asked first only so the answer can say why. The clean
 * check is there for the other case — uncommitted
 * edits a merge might happily carry across, into a chat that did not make them.
 *
 * A fetch that fails (offline, no remote, no credential) is not an error: the slot
 * is refreshed to what this machine already knows.
 */
export async function prepareSlot(projectPath, n, { env = {}, fetch = true } = {}) {
  if (!(await canHaveSlots(projectPath))) {
    return { ok: false, error: 'this project has no git repository at its root, so it has no slots' };
  }
  await excludeSlots(projectPath);
  const made = await ensureSlot(projectPath, n);
  if (!made.ok) return { ok: false, error: made.error };
  const path = slotPath(projectPath, n);
  const base = await baseRef(projectPath);

  let fetched = false;
  if (fetch && base.startsWith('origin/')) {
    fetched = (await git(path, ['fetch', '--quiet', 'origin'], { timeout: 30_000, env })).ok;
  }

  const state = await slotState(path);
  let refreshed = false;
  let kept = null;
  // Commits here that the base does not have. Asked of the base rather than of the
  // remotes, so a project with no remote at all can still be refreshed.
  const ahead = await git(path, ['rev-list', '--count', `${base}..HEAD`]);
  const own = ahead.ok ? Number(ahead.out) || 0 : 0;
  if (state.dirty) {
    kept = `${state.dirty} uncommitted change${state.dirty === 1 ? '' : 's'}`;
  } else if (own) {
    kept = `${own} commit${own === 1 ? '' : 's'} of its own that ${base} does not have`;
  } else {
    refreshed = (await git(path, ['merge', '--ff-only', '--quiet', base])).ok;
    if (!refreshed) kept = `${state.branch || 'its branch'} could not be fast-forwarded to ${base}`;
  }
  return { ok: true, cwd: path, created: made.created, base, fetched, refreshed, kept, ...(await slotState(path)) };
}
