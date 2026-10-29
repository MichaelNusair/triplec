/**
 * Which directories are projects.
 *
 * Two answers, and a deployment has exactly one of them:
 *
 *   - **A projects root** (the default). Every directory directly under
 *     PROJECTS_ROOT is a project named after itself. This is the workspace box,
 *     where TripleC clones and creates the projects and owns the directory they
 *     live in.
 *
 *   - **A registry** (`TRIPLEC_PROJECTS_FILE`). An explicit list of
 *     `{name, path}`, for a machine whose repositories were there first: a
 *     developer VM with a checkout at whatever path its own tooling chose, which
 *     need not be named after the project or share a parent with anything else.
 *     With a registry nothing else is a project, and creating or cloning one is
 *     limited to a registered name whose path does not exist yet.
 *
 * Everything that used to ask "is this cwd under PROJECTS_ROOT?" asks `projectFor`
 * instead, so both answers go through the same check. That check is hygiene, not
 * a boundary — anyone signed in already has a shell — but it is what keeps a cwd
 * from a browser from naming a directory nobody meant to open.
 */
import { readFileSync } from 'fs';
import { readdir } from 'fs/promises';
import { isAbsolute, join, normalize } from 'path';
import { PROJECTS_ROOT } from './host.js';

export const MAX_SLOTS = 8;

/**
 * Validate a project name. The character class is the whole defence for the
 * projects-root case: with no `/` and no leading dot, `join` cannot be talked out
 * of the root. See session-manager.js, which deletes trees by this name.
 */
export function assertSafeName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error('name may only contain letters, numbers, dot, dash and underscore');
  }
  if (name.startsWith('.') || name.length > 100) throw new Error('invalid project name');
  return name;
}

/**
 * Parse a registry. Strict, because a typo here is a project that silently is not
 * one, or two names for one directory — and the service refuses to start on it
 * rather than guessing.
 */
export function parseRegistry(text, source = 'the project registry') {
  let list;
  try {
    list = JSON.parse(text);
  } catch (err) {
    throw new Error(`${source} is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(list)) throw new Error(`${source} must be a JSON array of {name, path}`);
  const names = new Set();
  const paths = new Set();
  return list.map((entry, i) => {
    if (!entry || typeof entry !== 'object') throw new Error(`${source}[${i}] is not an object`);
    const name = assertSafeName(entry.name);
    const path = String(entry.path || '');
    if (!isAbsolute(path)) throw new Error(`${source}: "${name}" needs an absolute path`);
    const clean = normalize(path).replace(/\/+$/, '') || '/';
    if (names.has(name)) throw new Error(`${source}: "${name}" is registered twice`);
    if (paths.has(clean)) throw new Error(`${source}: ${clean} is registered twice`);
    names.add(name);
    paths.add(clean);
    const slots = entry.slots || {};
    const count = slots.count === undefined ? MAX_SLOTS : Number(slots.count);
    if (!Number.isInteger(count) || count < 1 || count > MAX_SLOTS) {
      throw new Error(`${source}: "${name}" slots.count must be 1 to ${MAX_SLOTS}`);
    }
    const postCreate = typeof slots.postCreate === 'string' ? slots.postCreate.trim() : '';
    return { name, path: clean, slots: { count, postCreate } };
  });
}

function loadRegistry(file = process.env.TRIPLEC_PROJECTS_FILE) {
  if (!file) return null;
  return parseRegistry(readFileSync(file, 'utf8'), file);
}

let REGISTRY = loadRegistry();

/** For the tests: install a registry (or `null` for the projects root). */
export function setRegistry(list) {
  REGISTRY = list ? parseRegistry(JSON.stringify(list)) : null;
}

export const hasRegistry = () => REGISTRY !== null;

const defaultSlots = () => ({ count: MAX_SLOTS, postCreate: '' });

/** Every project, `{name, path, slots}`, in no particular order. */
export async function listProjectDirs() {
  if (REGISTRY) return REGISTRY.map((p) => ({ ...p, slots: { ...p.slots } }));
  const entries = await readdir(PROJECTS_ROOT, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => ({ name: e.name, path: join(PROJECTS_ROOT, e.name), slots: defaultSlots() }));
}

/** The registered entry for a name, or null. Only meaningful with a registry. */
export function registered(name) {
  return REGISTRY?.find((p) => p.name === name) || null;
}

/**
 * The directory a project name refers to. Throws on a name that is not a name, and
 * — with a registry — on one that is not registered.
 */
export function projectPathFor(name) {
  assertSafeName(name);
  if (REGISTRY) {
    const entry = registered(name);
    if (!entry) throw new Error(`no project named "${name}"`);
    return entry.path;
  }
  return join(PROJECTS_ROOT, name);
}

/**
 * The project a directory is in — the project itself or anything inside it — or
 * null. The longest registered path wins, so a project nested in another's tree is
 * still its own.
 */
export function projectFor(cwd) {
  const raw = String(cwd || '').replace(/\/+$/, '');
  // A path with `..` or `.` in it is refused rather than resolved: it is not the
  // shape any client sends, and resolving it is how a prefix check gets talked past.
  const path = normalize(raw).replace(/\/+$/, '');
  if (!isAbsolute(raw) || path !== raw) return null;
  if (REGISTRY) {
    let best = null;
    for (const p of REGISTRY) {
      if ((path === p.path || path.startsWith(`${p.path}/`)) && (!best || p.path.length > best.path.length)) {
        best = p;
      }
    }
    return best && { name: best.name, path: best.path, slots: { ...best.slots } };
  }
  if (!path.startsWith(`${PROJECTS_ROOT}/`)) return null;
  const name = path.slice(PROJECTS_ROOT.length + 1).split('/')[0];
  if (!name || name.startsWith('.')) return null;
  return { name, path: join(PROJECTS_ROOT, name), slots: defaultSlots() };
}

/**
 * Whether a directory is one this service may open: inside a registered project, or
 * — with no registry — anywhere under PROJECTS_ROOT, the root itself included, which
 * is the check every route has always made (an editor can have the root open).
 */
export function isUnderProjects(cwd) {
  if (REGISTRY) return projectFor(cwd) !== null;
  const raw = String(cwd || '');
  return raw.startsWith(PROJECTS_ROOT) && !/(^|\/)\.\.(\/|$)/.test(raw);
}

/**
 * How to name a directory to a person: the project, and where in it — `api` or
 * `api/.claude/worktrees/slot-3` — or the path itself when it is in no project.
 */
export function projectLabel(cwd) {
  const p = projectFor(cwd);
  if (!p) return cwd;
  return `${p.name}${String(cwd).replace(/\/+$/, '').slice(p.path.length)}`;
}

/** How a project's slots are configured: how many, and what runs in a new one. */
export function slotConfigFor(projectPath) {
  const p = REGISTRY?.find((entry) => entry.path === projectPath);
  return p ? { ...p.slots } : defaultSlots();
}
