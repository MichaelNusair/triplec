#!/usr/bin/env node
/**
 * TripleC's updater: follow a branch of the repository, and update this deployment
 * from it when the deployment's `autoUpdate` setting says so.
 *
 *   triplec-update.mjs run    --aws | --host <config.json>   [--now]
 *   triplec-update.mjs check  --aws | --host <config.json>   [--now]
 *   triplec-update.mjs status --aws | --host <config.json>   [--json]
 *   triplec-update.mjs apply  --aws | --host <config.json>
 *
 * `apply` installs what is already installed again, with the settings saved on the
 * box page (scripts/box-config.mjs), checks it the same way, and puts the previous
 * settings back if the check fails.
 *
 * `run` updates if it should, `check` says what `run` would do and changes
 * nothing, and `status` reports the last run without touching the network.
 *
 * A systemd timer runs `run` every 5 minutes on every deployment; with
 * `autoUpdate.mode` "off" (the default) it exits before touching the network, and
 * otherwise it looks at the branch every `checkMinutes` (60 unless set). docs/UPDATES.md is
 * the reader's guide; scripts/auto-update-config.mjs has the settings.
 *
 * No releases and no version numbers: the branch is the release. What makes taking
 * a branch tip unattended reasonable is everything around it, in this order:
 *
 *   soak      a commit is taken only once it has been on the branch `soakHours`,
 *             measured from when this box first saw it there. A commit's own date
 *             says when it was written; one written last week and pushed a minute
 *             ago has soaked for a minute.
 *   forward   only a fast-forward of what is installed. Never a downgrade, never a
 *             commit off the branch, never over a build with uncommitted changes.
 *   scope     on AWS, an update that changes the stack (infra/ other than
 *             infra/userdata/) is held: this box cannot apply it to itself. It says
 *             so instead, and resumes once a full deploy has been made.
 *   timing    an install waits for `window` and for `idleMinutes` with no Claude
 *             transcript being written, because it restarts the chat service.
 *   tests     the repository's own suite, on the box, before anything is installed.
 *   verify    after installing: /healthz answers, the API refuses a caller with no
 *             login, and the build the service reports is the one just installed.
 *   rollback  if the install or the check after it fails, the previous commit is
 *             built and installed again the same way, and the failed commit is not
 *             retried. Only a newer one is.
 *
 * `--now` is a person asking: it skips the soak, the window and the idle wait,
 * retries a commit that failed before, and works whatever the mode, "off" included.
 * It is the upgrade command. It never skips the tests or the checks.
 *
 * The installers are the ones a person runs. On AWS, scripts/build-payload.sh and
 * scripts/install-payload.sh, which are what deploy.sh runs; on a host install,
 * deploy/host/install.sh. Nothing here knows how to install TripleC itself.
 *
 * Runs as root on AWS (the install is root's) and drops to the workspace user for
 * everything that runs the fetched code's build: git, npm, the tests, the payload
 * build. That user has passwordless sudo on an AWS box anyway (bootstrap.sh), so
 * this is hygiene rather than a boundary. On a host install it runs as the
 * developer, as install.sh does, and needs sudo without a password to install.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveAutoUpdate, validateAutoUpdate } from './auto-update-config.mjs';
import { AWS_FILE, layer, readStore } from './box-config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MINUTE = 60e3;
const HOUR = 60 * MINUTE;
const MAX_TIPS = 200;

// --- decisions: pure, and what update-test.mjs tests -------------------------------

/** Whether `date` falls inside a "HH-HH" window ("" is always). */
export function inWindow(window, date = new Date()) {
  if (!window) return true;
  const [a, b] = window.split('-').map(Number);
  const h = date.getHours();
  return a < b ? h >= a && h < b : h >= a || h < b;
}

/**
 * The branch tips this box has seen, oldest first, with `sha` as the newest. A tip
 * seen before keeps the time it was first seen: a branch reset back to it does not
 * restart its soak.
 */
export function recordTip(tips, sha, now) {
  const list = Array.isArray(tips)
    ? tips.filter((t) => t && typeof t.sha === 'string' && Number.isFinite(t.seenAt))
    : [];
  const last = list[list.length - 1];
  if (last && last.sha === sha) return list;
  const before = list.find((t) => t.sha === sha);
  return [...list.filter((t) => t.sha !== sha), { sha, seenAt: before ? before.seenAt : now }].slice(-MAX_TIPS);
}

/**
 * Whether a timer run should look at the branch now. The timer fires every
 * TIMER_MINUTES, so half of that is allowed as slack: without it, a run that
 * happened to land a few seconds early would skip, and an hourly check would
 * become a 65-minute one.
 */
export const TIMER_MINUTES = 5;
export function checkDue(last, now, checkMinutes) {
  if (!last || !Number.isFinite(last.at)) return true;
  return now - last.at >= checkMinutes * MINUTE - (TIMER_MINUTES / 2) * MINUTE;
}

/** Tips that have soaked, newest first. */
export function soakedTips(tips, now, soakHours) {
  const cutoff = now - soakHours * HOUR;
  return [...(tips || [])].filter((t) => t.seenAt <= cutoff).reverse();
}

/** When the oldest tip still soaking will have soaked, or null. */
export function nextSoakAt(tips, now, soakHours) {
  const cutoff = now - soakHours * HOUR;
  const waiting = (tips || []).filter((t) => t.seenAt > cutoff);
  return waiting.length ? waiting[0].seenAt + soakHours * HOUR : null;
}

/**
 * The files in a diff that an AWS box cannot apply to itself: the stack's own
 * source. Conservative on purpose. infra/config.js feeds the stack as well as the
 * payload build, so a change to it is held too; the cost of holding one that did
 * not need it is a notification, and the cost of the opposite is an app running
 * against a stack it was not written for.
 */
export function needsFullDeploy(files) {
  return files.filter((f) => f.startsWith('infra/')
    && !f.startsWith('infra/userdata/')
    && f !== 'infra/print-config.js'
    && !/-test\.m?js$/.test(f)
    && !f.endsWith('.md'));
}

/** The newest *.jsonl write under each Claude home's projects/, as { at, file }. */
export function lastActivity(claudeHomes) {
  let best = { at: 0, file: '' };
  const seen = new Set();
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth > 0) walk(p, depth - 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try {
          const at = fs.statSync(p).mtimeMs;
          if (at > best.at) best = { at, file: p };
        } catch { /* gone between readdir and stat */ }
      }
    }
  };
  for (const home of claudeHomes) {
    let real;
    try {
      real = fs.realpathSync(path.join(home, 'projects'));
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    // projects/<project>/<session>.jsonl, and a sub-agent's under <session>/subagents/.
    walk(real, 3);
  }
  return best;
}

const short = (sha) => String(sha || '').slice(0, 7);
const ago = (ms) => {
  const m = Math.round(ms / MINUTE);
  if (m < 90) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
};

// --- settings -------------------------------------------------------------------------

const BASE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** An AWS deployment: fixed paths, and the config the last payload carried. */
export function awsSettings(deployment, { installDir = '/opt/claude-web' } = {}) {
  const errors = validateAutoUpdate(deployment.autoUpdate);
  if (errors.length) throw new UsageError(errors.join('; '));
  return {
    platform: 'aws',
    autoUpdate: resolveAutoUpdate(deployment.autoUpdate),
    installDir,
    deploymentConfig: path.join(installDir, 'deployment', 'config.json'),
    stateDir: '/workspace/triplec-update',
    user: 'coder',
    home: '/home/coder',
    claudeHomes: ['/workspace/claude', '/home/coder/.claude'],
    chatUnit: 'claude-chat',
    appPort: 9997,
    path: `${path.dirname(process.execPath)}:${BASE_PATH}`,
  };
}

/** A host install: whatever its config.json resolves to. */
export async function hostSettings(configFile) {
  const m = await import(pathToFileURL(path.join(HERE, '..', 'deploy', 'host', 'config.mjs')).href);
  const raw = m.loadLayered(configFile);
  const { errors } = m.validate(raw);
  if (errors.length) throw new UsageError(`${configFile}: ${errors.join('; ')}`);
  const c = m.resolve(raw);
  return {
    platform: 'host',
    autoUpdate: c.autoUpdate,
    installDir: c.installDir,
    hostConfig: path.resolve(configFile),
    boxConfigFile: path.join(c.stateDir, 'box-config.json'),
    stateDir: path.join(c.stateDir, 'update'),
    user: c.user,
    home: c.home,
    claudeHomes: [c.claudeHome],
    chatUnit: 'triplec-chat',
    appPort: c.listen.appPort,
    path: `${path.dirname(process.execPath)}:${path.join(c.home, '.local', 'bin')}:${BASE_PATH}`,
  };
}

class UsageError extends Error {}

/** A step that failed, carrying the stage it failed at. */
class StepFailed extends Error {
  constructor(stage, message) {
    super(message);
    this.stage = stage;
  }
}

// --- running things -------------------------------------------------------------------

/**
 * Run a command as the build user, or as ourselves when we are that user. Output
 * goes to `log` (an fd) when given, else is captured and returned.
 */
function runAs(s, cmd, args, { cwd, env = {}, log, allowFail = false, stage = 'run', root = false } = {}) {
  const amRoot = process.getuid?.() === 0;
  const base = { PATH: s.path, HOME: s.home, USER: s.user, LOGNAME: s.user, LANG: 'C.UTF-8', GIT_TERMINAL_PROMPT: '0', ...env };
  let file = cmd;
  let argv = args;
  let spawnEnv = base;
  if (amRoot && !root && s.user && s.user !== 'root') {
    // runuser rather than sudo: no PAM conversation, nothing to configure, and the
    // environment is exactly the one given here.
    file = 'runuser';
    argv = ['-u', s.user, '--', 'env', '-i', ...Object.entries(base).map(([k, v]) => `${k}=${v}`), cmd, ...args];
    spawnEnv = { PATH: BASE_PATH };
  } else if (root && amRoot) {
    spawnEnv = { ...base, HOME: '/root', USER: 'root', LOGNAME: 'root' };
  }
  const r = spawnSync(file, argv, {
    cwd,
    env: spawnEnv,
    encoding: 'utf8',
    maxBuffer: 64 << 20,
    stdio: log === undefined ? ['ignore', 'pipe', 'pipe'] : ['ignore', log, log],
  });
  if (r.error) throw new StepFailed(stage, `${cmd}: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) {
    const why = log === undefined ? (r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' / ') : '';
    // Short names, not paths: this ends up in a push notification, where a command
    // line cut off at a length limit names neither the script nor what it was given.
    const what = [cmd, ...args.filter((a) => !a.startsWith('-'))].map((a) => path.basename(a)).slice(0, 3).join(' ');
    throw new StepFailed(stage, `${what} exited ${r.status ?? r.signal}${why ? `: ${why}` : ''}`);
  }
  return r;
}

const gitIn = (s, src) => (args, opts = {}) => runAs(s, 'git', args, { cwd: src, stage: 'git', ...opts });

function isAncestor(git, a, b) {
  return git(['merge-base', '--is-ancestor', a, b], { allowFail: true }).status === 0;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function ensureStateDir(s) {
  fs.mkdirSync(s.stateDir, { recursive: true });
  if (process.getuid?.() === 0 && s.user !== 'root') {
    // The build user owns the clone inside it, so it owns the directory.
    runAs(s, 'chown', [`${s.user}:`, s.stateDir], { root: true, stage: 'state' });
  }
}

/** A lock file holding our pid; one left by a process that has gone is taken over. */
function takeLock(s) {
  const file = path.join(s.stateDir, 'update.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => fs.rmSync(file, { force: true });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(fs.readFileSync(file, 'utf8'));
      let alive = false;
      try {
        alive = pid > 0 && process.kill(pid, 0);
      } catch (err) {
        alive = err.code === 'EPERM';
      }
      if (alive) return null;
      fs.rmSync(file, { force: true });
    }
  }
  return null;
}

/** The build the service is running, from its build.json. */
function installedBuild(s) {
  const b = readJson(path.join(s.installDir, 'chat-service', 'build.json'), null);
  return b && typeof b.commit === 'string' ? { commit: b.commit, dirty: b.dirty === true } : null;
}

// --- the check ------------------------------------------------------------------------

/**
 * Fetch the branch and decide what to do, without installing anything. Returns
 * { action, ... } where action is one of:
 *   up-to-date  nothing newer has soaked (`soakingUntil` says when something will)
 *   held        something blocks updating; `reason` says what, `key` dedupes the push
 *   update      `target` is ready, `from` is installed, `commits` lists what is new
 * Updates `state.tips` as a side effect.
 */
export function check(s, state, { now = Date.now(), force = false } = {}) {
  const au = s.autoUpdate;
  const src = path.join(s.stateDir, 'src');
  const git = gitIn(s, src);
  if (!fs.existsSync(path.join(src, '.git'))) {
    runAs(s, 'git', ['clone', '--quiet', '--no-checkout', '--branch', au.branch, au.repo, src], { stage: 'fetch' });
  } else {
    const url = git(['remote', 'get-url', 'origin'], { allowFail: true }).stdout.trim();
    if (url !== au.repo) git(['remote', 'set-url', 'origin', au.repo]);
  }
  git(['fetch', '--quiet', '--prune', 'origin', `+refs/heads/${au.branch}:refs/remotes/origin/${au.branch}`], { stage: 'fetch' });
  const tip = git(['rev-parse', `refs/remotes/origin/${au.branch}^{commit}`]).stdout.trim();
  state.tips = recordTip(state.tips, tip, now);
  state.tip = tip;

  const build = installedBuild(s);
  if (!build) {
    return { action: 'held', key: 'no-build', reason: `${s.installDir}/chat-service/build.json is missing, so which commit is installed is unknown. Install once by hand (deploy or upgrade) and updates resume.` };
  }
  if (build.dirty) {
    return { action: 'held', key: `dirty-${build.commit}`, reason: `the installed build is ${build.commit}+, which had uncommitted changes. An update would overwrite them, so updates wait until a clean commit is installed by hand.` };
  }
  const from = git(['rev-parse', '--verify', '--quiet', `${build.commit}^{commit}`], { allowFail: true }).stdout.trim();
  if (!from) {
    return { action: 'held', key: `unknown-${build.commit}`, reason: `the installed commit ${build.commit} is not in ${au.repo}, so there is nothing to update it along.` };
  }
  if (!isAncestor(git, from, tip)) {
    return { action: 'held', key: `off-${short(from)}`, reason: `the installed commit ${short(from)} is not on ${au.branch} (it is ahead of it, or off it), so a fast-forward cannot reach it.` };
  }
  if (from === tip) return { action: 'up-to-date', from, tip };

  // The newest soaked tip that is still on the branch and ahead of what runs. With
  // --now, the tip itself.
  let target = null;
  const candidates = force ? [{ sha: tip }] : soakedTips(state.tips, now, au.soakHours);
  for (const t of candidates) {
    if (t.sha !== tip && !isAncestor(git, t.sha, tip)) continue; // rewritten away
    if (t.sha === from || isAncestor(git, t.sha, from)) break; // already have it
    if (isAncestor(git, from, t.sha)) {
      target = t.sha;
      break;
    }
  }
  const newer = Number(git(['rev-list', '--count', '--first-parent', `${from}..${tip}`]).stdout.trim());
  if (!target) {
    return { action: 'up-to-date', from, tip, newer, soakingUntil: nextSoakAt(state.tips, now, au.soakHours) };
  }

  const commits = git(['log', '--first-parent', '--format=%h %s', `${from}..${target}`]).stdout.trim().split('\n').filter(Boolean);
  if (!force && state.failed?.sha === target) {
    return { action: 'held', key: `failed-${target}`, quiet: true, reason: `the update to ${short(target)} failed (${state.failed.stage}) and is not retried; a newer commit will be.` };
  }
  if (s.platform === 'aws') {
    const files = git(['diff', '--name-only', from, target]).stdout.trim().split('\n').filter(Boolean);
    const infra = needsFullDeploy(files);
    if (infra.length) {
      return {
        // Keyed on what is installed, so it is said once until a full deploy, not
        // again for every new commit that piles up behind it.
        action: 'held', key: `infra-${short(from)}`, target, from, commits,
        reason: `${commits.length} commit(s) up to ${short(target)} change the stack itself (${infra.slice(0, 3).join(', ')}${infra.length > 3 ? ', …' : ''}), which this box cannot apply to itself. Run ./deploy.sh from a machine with AWS credentials; updates resume from there.`,
      };
    }
  }
  return { action: 'update', from, target, tip, commits };
}

// --- installing -----------------------------------------------------------------------

function checkout(s, sha, log) {
  const git = gitIn(s, path.join(s.stateDir, 'src'));
  git(['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--force', '--detach', sha], { stage: 'checkout', log });
  // node_modules kept, so the next run's npm ci has a cache to be quick with.
  git(['clean', '-ffdxq', '-e', '/chat-service/node_modules'], { stage: 'checkout', log });
}

function runTests(s, log) {
  const src = path.join(s.stateDir, 'src');
  runAs(s, 'npm', ['ci', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: path.join(src, 'chat-service'), stage: 'tests', log });
  runAs(s, 'npm', ['test'], { cwd: src, stage: 'tests', log });
}

/** Everything short of changing the box: on AWS, the payload. A host install builds as it installs. */
function build(s, log) {
  if (s.platform !== 'aws') return;
  if (process.getuid?.() !== 0) throw new StepFailed('build', 'installing on an AWS box needs root: sudo triplec-update run');
  const src = path.join(s.stateDir, 'src');
  // The build needs this deployment's config, which is not in the repository.
  runAs(s, 'cp', [s.deploymentConfig, path.join(src, 'triplec.config.json')], { stage: 'build', log });
  runAs(s, 'bash', ['scripts/build-payload.sh', 'dist/payload.tar.gz'], { cwd: src, stage: 'build', log });
}

/** Change the box. */
function apply(s, log) {
  const src = path.join(s.stateDir, 'src');
  if (s.platform === 'aws') {
    runAs(s, 'tar', ['-xzf', path.join(src, 'dist', 'payload.tar.gz'), '-C', s.installDir], { root: true, stage: 'install', log });
    runAs(s, 'bash', [path.join(s.installDir, 'scripts', 'install-payload.sh')], { root: true, stage: 'install', log });
  } else {
    runAs(s, 'bash', [path.join(src, 'deploy', 'host', 'install.sh'), '--source', src, '--config', s.hostConfig], { stage: 'install', log });
  }
}

async function fetchStatus(url) {
  try {
    const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    return { status: r.status, text: await r.text().catch(() => '') };
  } catch {
    return { status: 0, text: '' };
  }
}

/** The service is up, still requires a login, and is running `sha`. */
async function verify(s, sha) {
  const base = `http://127.0.0.1:${s.appPort}`;
  let healthy = false;
  for (let i = 0; i < 60 && !healthy; i += 1) {
    const h = await fetchStatus(`${base}/healthz`);
    healthy = h.status === 200;
    if (!healthy) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!healthy) throw new StepFailed('verify', `${base}/healthz did not answer 200 within a minute`);
  // The same paths deploy.sh checks from outside. This app runs shell commands for
  // whoever it lets in, so an update that opened one is the worst thing it can do.
  for (const p of ['/api/projects', '/api/models']) {
    const { status } = await fetchStatus(`${base}${p}`);
    if (![401, 403, 302, 303].includes(status)) {
      throw new StepFailed('verify', `${p} answered ${status} with no login; it must refuse (401). Rolled back for that reason alone.`);
    }
  }
  const build = installedBuild(s);
  if (!build || !sha.startsWith(build.commit) || build.dirty) {
    throw new StepFailed('verify', `the service reports build ${build?.commit || 'none'}, not ${short(sha)}`);
  }
}

/** A push notification to every device signed up on this deployment. Best effort. */
function notify(s, title, body) {
  console.log(`notify: ${title}: ${body}`);
  if (!s.autoUpdate.push) return;
  try {
    // The running service's own environment, for where its push keys and device list
    // live. Only the variables that locate them: the unit's environment also holds
    // the login password, and argv is readable by every user on the box.
    const pid = runAs(s, 'systemctl', ['show', '-p', 'MainPID', '--value', s.chatUnit], { root: true, allowFail: true }).stdout.trim();
    const env = {};
    if (pid && pid !== '0') {
      const raw = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
      for (const kv of raw.split('\0')) {
        const i = kv.indexOf('=');
        const k = kv.slice(0, i);
        if (['CW_PUSH_DIR', 'CLAUDE_HOME', 'PROJECTS_ROOT', 'TRIPLEC_MODE', 'TRIPLEC_PROJECTS_FILE', 'HOME'].includes(k)) env[k] = kv.slice(i + 1);
      }
    }
    const script = `const p = await import('./push.js');
const r = await p.notifyAll({ title: process.env.TU_TITLE, body: process.env.TU_BODY, tag: 'triplec-update' }, { topic: p.topicFor('triplec-update') });
console.log('push: ' + r.sent + ' sent, ' + r.failed + ' failed');`;
    const r = runAs(s, process.execPath, ['--input-type=module', '-e', script], {
      cwd: path.join(s.installDir, 'chat-service'),
      env: { ...env, TU_TITLE: title, TU_BODY: body },
      allowFail: true,
      stage: 'notify',
    });
    console.log((r.stdout || r.stderr || '').trim().split('\n').slice(-1)[0] || 'push: no answer');
  } catch (e) {
    console.log(`push: not sent (${e.message})`);
  }
}

const NAME = 'TripleC';

/** One pass: check, and act on what the check found. Returns an exit code. */
const canSudo = (s) => runAs(s, 'sudo', ['-n', 'true'], { allowFail: true }).status === 0;
const STEPS = { checkout, runTests, build, apply, verify, notify, canSudo };

export async function run(s, { now = Date.now(), force = false, steps = {} } = {}) {
  const au = s.autoUpdate;
  // Injectable so update-test.mjs can drive the real decisions against real
  // repositories without installing anything.
  const S = { ...STEPS, ...steps };
  // `mode` is what the timer may do. A person running `run --now` is asking for an
  // update whatever the mode, and gets the same tests, checks and rollback.
  if (au.mode === 'off' && !force) {
    console.log('autoUpdate.mode is "off"; nothing to do. See docs/UPDATES.md to turn it on.');
    return 0;
  }
  // The timer fires more often than most deployments want to look; this is what
  // makes checkMinutes the interval. Read without the lock: it only decides whether
  // to try, and a run that is under way has `last` from its previous pass.
  const lastLook = readJson(path.join(s.stateDir, 'state.json'), {}).last;
  if (!force && !checkDue(lastLook, now, au.checkMinutes)) {
    console.log(`not due: looked ${ago(now - lastLook.at)} ago, and checks every ${au.checkMinutes} min`);
    return 0;
  }
  // Before anything is recorded: a forgotten sudo is not a failed commit, and
  // recording it as one would stop the timer from ever trying that commit.
  if (s.platform === 'aws' && process.getuid?.() !== 0 && !steps.build) {
    console.error('run installs as root on an AWS box: sudo triplec-update run' + (force ? ' --now' : ''));
    return 2;
  }
  ensureStateDir(s);
  const release = takeLock(s);
  if (!release) {
    console.log('another update is running; leaving it to finish');
    return 0;
  }
  const stateFile = path.join(s.stateDir, 'state.json');
  const state = readJson(stateFile, {});
  const record = (outcome, detail, extra = {}) => {
    state.last = { at: now, outcome, detail, ...extra };
    writeJson(stateFile, state);
    console.log(`${outcome}: ${detail}`);
  };
  try {
    let d;
    try {
      d = check(s, state, { now, force });
    } catch (e) {
      record('error', `checking ${au.repo} failed: ${e.message}`);
      return 1;
    }

    if (d.action === 'up-to-date') {
      const soak = d.soakingUntil ? `; ${d.newer} newer commit(s) soaking until ${new Date(d.soakingUntil).toISOString()}` : '';
      record('up-to-date', `running ${short(d.from)}${soak}`);
      return 0;
    }
    if (d.action === 'held') {
      if (!d.quiet && state.heldKey !== d.key) S.notify(s, `${NAME} update held`, d.reason);
      state.heldKey = d.key;
      record('held', d.reason);
      return 0;
    }
    state.heldKey = null;

    const what = `${d.commits.length} commit(s), ${short(d.from)} → ${short(d.target)}: ${d.commits[0]?.replace(/^\S+ /, '') || ''}`;
    if (au.mode === 'notify' && !force) {
      if (state.notified !== d.target) {
        const how = s.platform === 'aws' ? 'sudo triplec-update run --now' : `${s.installDir}/bin/triplec-update run --now`;
        S.notify(s, `${NAME} update ready`, `${what}. Install with: ${how}`);
        state.notified = d.target;
      }
      record('ready', what, { target: d.target });
      return 0;
    }

    if (!force && !inWindow(au.window, new Date(now))) {
      record('waiting', `ready (${what}); installs inside the ${au.window} window`, { target: d.target });
      return 0;
    }
    if (!force && au.idleMinutes > 0) {
      const act = lastActivity(s.claudeHomes);
      if (act.at && now - act.at < au.idleMinutes * MINUTE) {
        const where = path.basename(path.dirname(act.file));
        record('waiting', `ready (${what}); a conversation (${where}) was active ${ago(now - act.at)} ago, and installs wait for ${au.idleMinutes} min of quiet`, { target: d.target });
        return 0;
      }
    }
    if (s.platform === 'host' && !S.canSudo(s)) {
      const reason = 'installing needs sudo without a password (install.sh writes units and reloads nginx), and it asks for one here. Set autoUpdate.mode to "notify", or allow it.';
      if (state.heldKey !== 'sudo') S.notify(s, `${NAME} update held`, reason);
      state.heldKey = 'sudo';
      record('held', reason, { target: d.target });
      return 0;
    }

    // The update. Output of every step goes to one log, so a failure has one place
    // to read; the journal gets the tail.
    const logFile = path.join(s.stateDir, 'last-run.log');
    const log = fs.openSync(logFile, 'w');
    let installed = false;
    try {
      console.log(`updating: ${what}`);
      S.checkout(s, d.target, log);
      S.runTests(s, log);
      S.build(s, log);
      installed = true; // from here on, a failure means something was changed
      S.apply(s, log);
      await S.verify(s, d.target);
    } catch (e) {
      const stage = e.stage || 'update';
      let rolledBack = !installed;
      let note = installed ? '' : ' Nothing was installed.';
      if (installed) {
        try {
          fs.writeSync(log, `\n--- rolling back to ${d.from}\n`);
          S.checkout(s, d.from, log);
          S.build(s, log);
          S.apply(s, log);
          await S.verify(s, d.from);
          rolledBack = true;
          note = ` Rolled back to ${short(d.from)}.`;
        } catch (re) {
          note = ` ROLLBACK FAILED (${re.message}). The box needs attention: ${logFile}.`;
        }
      }
      fs.closeSync(log);
      printTail(logFile);
      state.failed = { sha: d.target, at: now, stage, error: e.message, rolledBack };
      S.notify(s, `${NAME} update failed`, `${short(d.target)} at ${stage}: ${e.message.slice(0, 160)}.${note}`);
      record('failed', `${short(d.target)} at ${stage}: ${e.message}.${note}`, { target: d.target, log: logFile });
      return 1;
    }
    fs.closeSync(log);
    state.failed = null;
    state.notified = null;
    state.installedAt = now;
    S.notify(s, `${NAME} updated`, what);
    record('installed', what, { target: d.target, log: logFile });
    return 0;
  } finally {
    release();
  }
}

/**
 * `apply`: install the box page's settings (scripts/box-config.mjs) on what is
 * already installed. On AWS that is install-payload.sh from the install directory,
 * which re-runs bootstrap.sh, and bootstrap.sh reads them; on a host install it is
 * install.sh from the updater's clone at the installed commit, whose config.mjs
 * reads them. Then the same check an update gets. If it fails, the settings that
 * were installed last are put back and installed again, so a value that breaks the
 * login cannot stay.
 *
 * What was installed is recorded as `state.applied.values` (the box-scope values),
 * which is how the page tells "saved" from "saved and installed".
 */
export async function applySettings(s, { now = Date.now(), steps = {} } = {}) {
  const S = { ...STEPS, ...steps };
  if (s.platform === 'aws' && process.getuid?.() !== 0 && !steps.apply) {
    console.error('apply installs as root on an AWS box: sudo triplec-update apply');
    return 2;
  }
  ensureStateDir(s);
  const release = takeLock(s);
  if (!release) {
    console.log('an update or an apply is running; try again when it has finished');
    return 1;
  }
  const stateFile = path.join(s.stateDir, 'state.json');
  const state = readJson(stateFile, {});
  const storeFile = s.platform === 'aws' ? (process.env.TRIPLEC_BOX_OVERRIDES || AWS_FILE) : s.boxConfigFile;
  const store = readStore(storeFile);
  const build = installedBuild(s);
  const logFile = path.join(s.stateDir, 'last-apply.log');
  const log = fs.openSync(logFile, 'w');
  const record = (outcome, detail) => {
    state.applied = { at: now, outcome, detail, values: outcome === 'applied' ? store.values : state.applied?.values || {} };
    writeJson(stateFile, state);
    console.log(`${outcome}: ${detail}`);
  };
  const install = async () => {
    if (s.platform === 'aws') {
      runAs(s, 'bash', [path.join(s.installDir, 'scripts', 'install-payload.sh')], { root: true, stage: 'install', log });
    } else {
      if (!S.canSudo(s)) throw new StepFailed('install', 'installing needs sudo without a password, and it asks for one here');
      if (!build?.commit) throw new StepFailed('install', 'which commit is installed is unknown (no build.json)');
      S.checkout(s, build.commit, log);
      S.apply(s, log);
    }
    if (build?.commit) await S.verify(s, build.commit);
  };
  try {
    try {
      await (steps.install || install)();
    } catch (e) {
      const previous = state.applied?.values || {};
      fs.writeSync(log, `\n--- putting the previous settings back\n`);
      let note;
      try {
        const prior = { values: {}, base: {}, savedAt: {} };
        for (const [p, v] of Object.entries(previous)) {
          if (p in store.base) {
            prior.values[p] = v;
            prior.base[p] = store.base[p];
            prior.savedAt[p] = store.savedAt[p] ?? now;
          }
        }
        const { writeStore } = await import('./box-config.mjs');
        writeStore(storeFile, prior);
        await (steps.install || install)();
        note = 'The settings installed before were put back.';
      } catch (re) {
        note = `PUTTING THEM BACK FAILED (${re.message}). The box needs attention: ${logFile}.`;
      }
      S.notify(s, `${NAME} settings not applied`, `${e.message.slice(0, 160)}. ${note}`);
      record('failed', `${e.message}. ${note}`);
      return 1;
    }
    record('applied', Object.keys(store.values).length ? `installed ${Object.keys(store.values).join(', ')}` : 'installed the config file’s values');
    return 0;
  } finally {
    fs.closeSync(log);
    release();
  }
}

/**
 * `check`: fetch and say what `run` would do, changing nothing but the record of
 * which tips have been seen (seen is seen, and that is what the soak counts from).
 */
async function dryRun(s, { force = false } = {}) {
  ensureStateDir(s);
  const release = takeLock(s);
  if (!release) {
    console.log('an update is running; try again when it has finished');
    return 0;
  }
  try {
    const stateFile = path.join(s.stateDir, 'state.json');
    const state = readJson(stateFile, {});
    const d = check(s, state, { force });
    writeJson(stateFile, state);
    if (d.action === 'update') {
      console.log(`would update ${short(d.from)} → ${short(d.target)} (${d.commits.length} commit(s)):`);
      for (const c of d.commits) console.log(`  ${c}`);
    } else if (d.action === 'held') {
      console.log(`held: ${d.reason}`);
    } else {
      const soak = d.soakingUntil ? `; ${d.newer} newer commit(s) soaking until ${new Date(d.soakingUntil).toISOString()}` : '';
      console.log(`up to date at ${short(d.from)}${soak}`);
    }
    return 0;
  } catch (e) {
    console.log(`check failed: ${e.message}`);
    return 1;
  } finally {
    release();
  }
}

function printTail(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    console.log(`--- last lines of ${file}`);
    console.log(lines.slice(-30).join('\n'));
  } catch { /* nothing to show */ }
}

/**
 * What `status --json` prints, which is what the box page shows
 * (chat-service/admin.js). The same facts as `describe`, as data, plus the two
 * times a reader wants: when the next look at the branch is due, and when a commit
 * that is soaking will be taken.
 */
export function statusOf(s, state, now = Date.now()) {
  const au = s.autoUpdate;
  const build = installedBuild(s);
  const seen = state.tip ? (state.tips || []).find((t) => t.sha === state.tip) : null;
  const current = Boolean(build && state.tip && state.tip.startsWith(build.commit));
  // Soaking means "newer than what runs". A tip installed with --now is still inside
  // its soak window, and saying it will be taken tomorrow would be wrong.
  const newer = build ? (state.tips || []).filter((t) => !t.sha.startsWith(build.commit)) : [];
  const soakingUntil = current || au.mode === 'off' ? null : nextSoakAt(newer, now, au.soakHours);
  const lastAt = state.last?.at;
  return {
    platform: s.platform,
    settings: au,
    // The last time the box page's settings were installed (applySettings).
    applied: state.applied || null,
    timerMinutes: TIMER_MINUTES,
    installed: build,
    tip: state.tip ? { sha: state.tip, seenAt: seen?.seenAt ?? null } : null,
    current,
    soakingUntil,
    // The first timer run at or after this time looks; null when nothing will.
    nextCheckAt: au.mode === 'off' ? null
      : Number.isFinite(lastAt) ? Math.max(now, lastAt + au.checkMinutes * MINUTE - (TIMER_MINUTES / 2) * MINUTE)
        : now,
    installedAt: state.installedAt ?? null,
    last: state.last || null,
    failed: state.failed || null,
    held: Boolean(state.heldKey),
    command: s.platform === 'aws' ? 'sudo triplec-update run --now' : `${s.installDir}/bin/triplec-update run --now`,
  };
}

/** What `status` prints. */
export function describe(s, state, now = Date.now()) {
  const au = s.autoUpdate;
  const build = installedBuild(s);
  const lines = [
    `mode        ${au.mode}${au.mode === 'off' ? ' (updates are by hand; see docs/UPDATES.md)' : ''}`,
    `following   ${au.branch} of ${au.repo}`,
    `cautions    soak ${au.soakHours} h · window ${au.window || 'any time'} · wait for ${au.idleMinutes} min idle · push ${au.push ? 'on' : 'off'}`,
    `checks      every ${au.checkMinutes} min${au.mode === 'off' ? ' (while mode is on)' : ''}`,
    `installed   ${build ? `${build.commit}${build.dirty ? '+' : ''}` : 'unknown (no build.json)'}`,
  ];
  if (state.applied) lines.push(`settings    box page's applied ${new Date(state.applied.at).toISOString()}: ${state.applied.outcome}`);
  if (state.tip) {
    const seen = (state.tips || []).find((t) => t.sha === state.tip);
    lines.push(`branch tip  ${short(state.tip)}${seen ? `, first seen ${ago(now - seen.seenAt)} ago` : ''}`);
  }
  if (state.last) {
    lines.push(`last run    ${new Date(state.last.at).toISOString()} ${state.last.outcome}: ${state.last.detail}`);
  }
  if (state.failed) {
    lines.push(`not retried ${short(state.failed.sha)} (failed at ${state.failed.stage}; run --now to retry it)`);
  }
  return lines.join('\n');
}

export { UsageError };

// --- command line ---------------------------------------------------------------------

async function settingsFrom(args) {
  if (args.includes('--aws')) {
    const installDir = '/opt/claude-web';
    const file = path.join(installDir, 'deployment', 'config.json');
    const deployment = readJson(file, null);
    if (!deployment) throw new UsageError(`${file} is missing or unreadable; it ships with every payload, so deploy once with this version of deploy.sh`);
    // The box page's edits over the payload's config: autoUpdate set there applies
    // on the next run. See scripts/box-config.mjs.
    const { config } = layer(deployment, readStore(process.env.TRIPLEC_BOX_OVERRIDES || AWS_FILE));
    return awsSettings(config, { installDir });
  }
  const i = args.indexOf('--host');
  if (i >= 0 && args[i + 1]) return hostSettings(args[i + 1]);
  throw new UsageError('say which deployment this is: --aws, or --host <config.json>');
}

async function main(argv) {
  const [cmd, ...args] = argv;
  const usage = 'usage: triplec-update.mjs run|check|status|apply --aws | --host <config.json> [--now] [--json]';
  if (!['run', 'check', 'status', 'apply'].includes(cmd)) {
    console.error(usage);
    return 2;
  }
  let s;
  try {
    s = await settingsFrom(args);
  } catch (e) {
    console.error(`triplec-update: ${e.message}`);
    return 2;
  }
  if (cmd === 'status') {
    const state = readJson(path.join(s.stateDir, 'state.json'), {});
    console.log(args.includes('--json') ? JSON.stringify(statusOf(s, state)) : describe(s, state));
    return 0;
  }
  if (cmd === 'apply') return applySettings(s);
  if (cmd === 'check') return dryRun(s, { force: args.includes('--now') });
  return run(s, { force: args.includes('--now') });
}

const invokedDirectly = () => {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (process.argv[1] && invokedDirectly()) {
  process.exitCode = await main(process.argv.slice(2));
}
