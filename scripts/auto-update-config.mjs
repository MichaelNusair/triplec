/**
 * The `autoUpdate` setting: its defaults and its rules, shared by both deployment
 * types.
 *
 * Imported by infra/config.js (an AWS deployment's triplec.config.json), by
 * deploy/host/config.mjs (a host install's config.json) and by the updater itself,
 * scripts/triplec-update.mjs. One definition, because two configs that disagreed
 * about what "install" means would be two products.
 *
 * Off unless a deployment asks. TripleC is a package you update when you choose
 * to; this lets a deployment choose "whenever there is something new", and choose
 * how cautiously. docs/UPDATES.md is the reader's version of this file.
 *
 * No dependencies, and nothing here touches the filesystem: deploy/host/config.mjs
 * runs before `npm install` has happened, on whatever node the developer had.
 */

/** What each mode does when a newer, soaked commit is on the branch. */
export const UPDATE_MODES = ['off', 'notify', 'install'];

/** Where updates come from unless a deployment says otherwise. A fork sets `repo`. */
export const UPSTREAM_REPO = 'https://github.com/MichaelNusair/triplec.git';

export const AUTO_UPDATE_DEFAULTS = {
  /**
   * "off"     nothing runs; update by hand, as before.
   * "notify"  check, and send a push notification when an update is ready. Never
   *           installs anything.
   * "install" check, and install a ready update by itself, with the safety checks
   *           in scripts/triplec-update.mjs: tests first, a login check after, and
   *           a rollback to what was running if either fails.
   */
  mode: 'off',
  /** The git repository to follow. Empty means UPSTREAM_REPO. */
  repo: '',
  /** The branch to follow. There are no releases; a branch tip is the release. */
  branch: 'main',
  /**
   * How long a commit must have been on the branch before this deployment takes
   * it, in hours. Measured from when this box first saw it there, not from the
   * commit's own date, which says when it was written, not when it was published.
   * A commit reverted within this window never reaches you. 0 takes the tip.
   */
  soakHours: 24,
  /**
   * When an install may happen: "" for any time, or "HH-HH" in the box's local
   * time (UTC on an AWS deployment), start inclusive and end exclusive. "02-06" is
   * 02:00 to 05:59. "22-04" wraps past midnight.
   */
  window: '',
  /**
   * Install only after this many minutes with no Claude conversation writing to
   * its transcript, because installing restarts the chat service and that ends a
   * turn in flight. 0 installs without waiting.
   */
  idleMinutes: 30,
  /** Send a push notification for an update installed, ready, held or failed. */
  push: true,
};

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const WINDOW = /^([01]\d|2[0-3])-([01]\d|2[0-4])$/;

/**
 * Every problem with an `autoUpdate` value, as "<key>: <message>" strings naming
 * the key. Never throws. `prefix` is the key it sits under in its config file.
 */
export function validateAutoUpdate(value, prefix = 'autoUpdate') {
  const errors = [];
  const err = (key, msg) => errors.push(`${prefix}${key ? `.${key}` : ''}: ${msg}`);
  if (value === undefined) return errors;
  if (!isObject(value)) {
    err('', 'must be an object, e.g. {"mode": "notify"}');
    return errors;
  }
  for (const key of Object.keys(value)) {
    if (!(key in AUTO_UPDATE_DEFAULTS)) err(key, 'unknown key');
  }
  const v = { ...AUTO_UPDATE_DEFAULTS, ...value };
  if (!UPDATE_MODES.includes(v.mode)) err('mode', `must be one of ${UPDATE_MODES.join(', ')}`);
  if (typeof v.repo !== 'string') {
    err('repo', 'must be a git URL, or empty for the upstream repository');
  } else if (v.repo && !/^(https:\/\/|git@|ssh:\/\/|file:\/\/|\/)[^\s"'`$\\]+$/.test(v.repo)) {
    // Shapes git accepts, and nothing a shell or a unit file would read twice.
    err('repo', 'must be an https://, ssh:// or git@ URL, or an absolute path');
  }
  if (typeof v.branch !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(v.branch) ||
      v.branch.startsWith('-') || v.branch.includes('..')) {
    err('branch', 'must be a branch name, e.g. "main"');
  }
  if (!Number.isInteger(v.soakHours) || v.soakHours < 0 || v.soakHours > 720) {
    err('soakHours', 'must be a whole number of hours from 0 to 720');
  }
  if (typeof v.window !== 'string' || (v.window && !WINDOW.test(v.window))) {
    err('window', 'must be "" (any time) or "HH-HH", e.g. "02-06"');
  } else if (v.window) {
    const [, a, b] = v.window.match(WINDOW);
    if (a === b || (b === '24' && a === '00')) {
      err('window', 'must not start and end at the same hour; use "" for any time');
    }
  }
  if (!Number.isInteger(v.idleMinutes) || v.idleMinutes < 0 || v.idleMinutes > 1440) {
    err('idleMinutes', 'must be a whole number of minutes from 0 to 1440');
  }
  if (typeof v.push !== 'boolean') err('push', 'must be true or false');
  return errors;
}

/** The value with every default applied and `repo` resolved. Assumes it validated. */
export function resolveAutoUpdate(value) {
  const v = { ...AUTO_UPDATE_DEFAULTS, ...(isObject(value) ? value : {}) };
  if (!v.repo) v.repo = UPSTREAM_REPO;
  return v;
}
