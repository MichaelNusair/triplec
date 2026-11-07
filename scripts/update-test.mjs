#!/usr/bin/env node
/**
 * The updater's decisions, against real git repositories.
 *
 *   node scripts/update-test.mjs
 *
 * A bare repository plays GitHub, a working clone plays whoever pushes to it, and a
 * temporary install directory holds the build.json the updater reads to learn what
 * is installed. The install steps themselves (tests, build, apply, verify) are
 * replaced with recorders: what is under test is when the updater decides to call
 * them, and what it does when one fails. The installers are tested where they live.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  inWindow, recordTip, soakedTips, needsFullDeploy, lastActivity, run, describe, checkDue, statusOf, applyBoxSettings, saveBoxSettings, BOX_SETTINGS,
} from './triplec-update.mjs';
import { validateAutoUpdate, resolveAutoUpdate, UPSTREAM_REPO } from './auto-update-config.mjs';

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const HOUR = 3600e3;
const at = (h, m = 0) => new Date(2026, 10, 6, h, m);

// --- pure pieces --------------------------------------------------------------------
console.log('windows, tips and scope');
check('U1: no window is any time', inWindow('', at(13)));
check('U1: 02-06 includes 02:00 and 05:59', inWindow('02-06', at(2)) && inWindow('02-06', at(5, 59)));
check('U1: 02-06 excludes 06:00 and 01:59', !inWindow('02-06', at(6)) && !inWindow('02-06', at(1, 59)));
check('U1: 22-04 wraps past midnight', inWindow('22-04', at(23)) && inWindow('22-04', at(3)) && !inWindow('22-04', at(12)));

let tips = recordTip([], 'a', 1000);
tips = recordTip(tips, 'a', 2000);
check('U2: a tip seen twice in a row is recorded once', tips.length === 1 && tips[0].seenAt === 1000);
tips = recordTip(tips, 'b', 3000);
tips = recordTip(tips, 'a', 4000);
check('U2: a branch reset back to an old tip keeps when it was first seen', tips.at(-1).sha === 'a' && tips.at(-1).seenAt === 1000, JSON.stringify(tips));
check('U2: soaked tips are newest first', soakedTips([{ sha: 'x', seenAt: 0 }, { sha: 'y', seenAt: HOUR }], 30 * HOUR, 24).map((t) => t.sha).join() === 'y,x');

check('U3: the stack source needs a full deploy', needsFullDeploy(['infra/lib/stack.js', 'infra/config.js']).length === 2);
check('U3: provisioning, print-config, docs and tests do not', needsFullDeploy([
  'infra/userdata/bootstrap.sh', 'infra/print-config.js', 'infra/README.md', 'infra/config-test.js', 'chat-service/server.js',
]).length === 0);

console.log('settings');
check('U4: the defaults validate, and are off', validateAutoUpdate({}).length === 0 && resolveAutoUpdate(undefined).mode === 'off');
check('U4: an empty repo means upstream', resolveAutoUpdate({ mode: 'notify' }).repo === UPSTREAM_REPO);
const bad = validateAutoUpdate({ mode: 'yes', soakHours: -1, window: '06-06', branch: '../x', idleMinutes: 1.5, push: 'no', bnid: 1, repo: 'x; rm -rf /' });
for (const key of ['mode', 'soakHours', 'window', 'branch', 'idleMinutes', 'push', 'bnid', 'repo']) {
  check(`U4: a bad ${key} is named`, bad.some((e) => e.startsWith(`autoUpdate.${key}:`)), bad.join(' | '));
}
check('U4: a non-object is refused', validateAutoUpdate('install').length === 1);

// --- the real thing, with git ---------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'triplec-update-test-'));
const origin = path.join(tmp, 'origin.git');
const work = path.join(tmp, 'work');
const installDir = path.join(tmp, 'install');
const claude = path.join(tmp, 'claude');
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
git(tmp, 'init', '--quiet', '--bare', '-b', 'main', origin);
git(tmp, 'clone', '--quiet', origin, work);
git(work, 'checkout', '--quiet', '-b', 'main');
let n = 0;
function commit(file = `chat-service/f${n}.js`, extraEnv = {}) {
  n += 1;
  fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
  fs.writeFileSync(path.join(work, file), `// ${n}\n`);
  git(work, 'add', '-A');
  execFileSync('git', ['commit', '--quiet', '-m', `change ${n}`], { cwd: work, env: { ...env, ...extraEnv } });
  git(work, 'push', '--quiet', 'origin', 'HEAD:main');
  return git(work, 'rev-parse', 'HEAD');
}
const setInstalled = (sha, dirty = false) => {
  fs.mkdirSync(path.join(installDir, 'chat-service'), { recursive: true });
  fs.writeFileSync(path.join(installDir, 'chat-service', 'build.json'), JSON.stringify({ commit: sha.slice(0, 7), dirty }));
};
const installed = () => JSON.parse(fs.readFileSync(path.join(installDir, 'chat-service', 'build.json'), 'utf8')).commit;

let stateN = 0;
function settings(over = {}, platform = 'host') {
  stateN += 1;
  return {
    platform,
    autoUpdate: resolveAutoUpdate({ mode: 'install', repo: origin, soakHours: 24, idleMinutes: 30, ...over }),
    installDir,
    stateDir: path.join(tmp, `state-${stateN}`),
    user: os.userInfo().username,
    home: tmp,
    claudeHomes: [claude],
    chatUnit: 'none',
    appPort: 1,
    path: process.env.PATH,
  };
}

/** Recorders for the install steps. `fail` names a step that throws. */
function recorder({ fail = {} } = {}) {
  const calls = [];
  const notes = [];
  let current = null;
  const step = (name, fn = () => {}) => (s, arg) => {
    calls.push(name === 'checkout' || name === 'verify' ? `${name}:${String(arg).slice(0, 7)}` : name);
    if (fail[name]) {
      if (typeof fail[name] === 'number') fail[name] -= 1;
      const e = new Error(`${name} broke`);
      e.stage = name;
      throw e;
    }
    return fn(s, arg);
  };
  return {
    calls,
    notes,
    steps: {
      checkout: step('checkout', (s, sha) => { current = sha; }),
      runTests: step('runTests'),
      build: step('build'),
      apply: step('apply', () => setInstalled(current)),
      verify: step('verify', async (s, sha) => {
        if (!sha.startsWith(installed())) throw Object.assign(new Error('wrong build'), { stage: 'verify' });
      }),
      notify: (s, title, body) => notes.push(`${title}: ${body}`),
      canSudo: () => true,
    },
  };
}
const stateOf = (s) => JSON.parse(fs.readFileSync(path.join(s.stateDir, 'state.json'), 'utf8'));

console.log('soak, install, rollback');
const t0 = Date.now();
const c1 = commit();
setInstalled(c1);
const s = settings();
let r = recorder();
await run(s, { now: t0, steps: r.steps });
check('U5: nothing newer than what is installed is up to date', stateOf(s).last.outcome === 'up-to-date' && r.calls.length === 0, JSON.stringify(stateOf(s).last));

const c2 = commit();
await run(s, { now: t0 + HOUR, steps: r.steps });
check('U6: a commit just pushed is soaking, not installed', stateOf(s).last.outcome === 'up-to-date' && /soaking until/.test(stateOf(s).last.detail) && r.calls.length === 0, JSON.stringify(stateOf(s).last));
await run(s, { now: t0 + 24 * HOUR, steps: r.steps });
check('U6: and still is a minute short of the soak', r.calls.length === 0);
await run(s, { now: t0 + 26 * HOUR, steps: r.steps });
check('U7: once soaked it is tested, built, installed and checked, in that order', r.calls.join() === `checkout:${c2.slice(0, 7)},runTests,build,apply,verify:${c2.slice(0, 7)}`, r.calls.join());
check('U7: the outcome is recorded and announced', stateOf(s).last.outcome === 'installed' && installed() === c2.slice(0, 7) && r.notes.some((x) => x.startsWith('TripleC updated')), JSON.stringify(stateOf(s).last));

// A commit written long ago and pushed now soaks from when it was seen.
const c3 = commit(undefined, { GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z', GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z' });
r = recorder();
const t1 = t0 + 30 * HOUR;
await run(s, { now: t1, steps: r.steps });
check('U8: an old commit pushed today still soaks from today', r.calls.length === 0 && stateOf(s).last.outcome === 'up-to-date', JSON.stringify(stateOf(s).last));

// Someone is mid-conversation.
const transcript = path.join(claude, 'projects', '-workspace-projects-app', 'abc.jsonl');
fs.mkdirSync(path.dirname(transcript), { recursive: true });
fs.writeFileSync(transcript, '{}\n');
const t2 = t1 + 25 * HOUR;
fs.utimesSync(transcript, new Date(t2 - 5 * 60e3), new Date(t2 - 5 * 60e3));
await run(s, { now: t2, steps: r.steps });
check('U9: a conversation written to 5 minutes ago holds the install', r.calls.length === 0 && stateOf(s).last.outcome === 'waiting' && /active 5 min ago/.test(stateOf(s).last.detail), JSON.stringify(stateOf(s).last));
check('U9: and lastActivity names its transcript', lastActivity([claude]).file === transcript);
fs.utimesSync(transcript, new Date(t2 - 45 * 60e3), new Date(t2 - 45 * 60e3));

// The install breaks: roll back to what was running. An hour on, because a timer
// run inside checkMinutes of the last one does not look (U25).
r = recorder({ fail: { apply: 1 } });
await run(s, { now: t2 + HOUR, steps: r.steps });
check('U10: a failed install is rolled back by installing the previous commit the same way',
  r.calls.join() === `checkout:${c3.slice(0, 7)},runTests,build,apply,checkout:${c2.slice(0, 7)},build,apply,verify:${c2.slice(0, 7)}`, r.calls.join());
const failedState = stateOf(s);
check('U10: and recorded as failed, rolled back, and announced', failedState.last.outcome === 'failed' && failedState.failed?.sha === c3 && failedState.failed.rolledBack === true
  && installed() === c2.slice(0, 7) && r.notes.some((x) => /update failed: .*Rolled back to/.test(x)), JSON.stringify(failedState.last) + r.notes.join(' | '));

r = recorder();
await run(s, { now: t2 + 2 * HOUR, steps: r.steps });
check('U11: a commit that failed is not retried by the timer', r.calls.length === 0 && stateOf(s).last.outcome === 'held' && r.notes.length === 0, JSON.stringify(stateOf(s).last));
await run(s, { now: t2 + 2 * HOUR, force: true, steps: r.steps });
check('U11: --now retries it', installed() === c3.slice(0, 7) && stateOf(s).last.outcome === 'installed' && stateOf(s).failed === null, r.calls.join());

// The tests break: nothing was touched, so nothing is rolled back.
const c4 = commit();
r = recorder({ fail: { runTests: true } });
const t3 = t2 + 3 * HOUR;
await run(s, { now: t3, steps: r.steps });
await run(s, { now: t3 + 25 * HOUR, steps: r.steps });
check('U12: failing tests stop the update before anything is built or installed', r.calls.join() === `checkout:${c4.slice(0, 7)},runTests` && installed() === c3.slice(0, 7), r.calls.join());
check('U12: and say nothing was installed', /Nothing was installed/.test(stateOf(s).last.detail) && stateOf(s).failed.rolledBack === true);

// A newer commit is tried even though an older one failed.
const c5 = commit();
r = recorder();
const t4 = t3 + 26 * HOUR;
await run(s, { now: t4, steps: r.steps });
await run(s, { now: t4 + 25 * HOUR, steps: r.steps });
check('U13: a newer commit after a failed one is installed', installed() === c5.slice(0, 7), r.calls.join());

// --now skips the soak.
const c6 = commit();
r = recorder();
await run(s, { now: t4 + 26 * HOUR, force: true, steps: r.steps });
check('U14: --now takes the tip without waiting for it to soak', installed() === c6.slice(0, 7), r.calls.join());

console.log('modes, windows and holds');
const c7 = commit();
const sn = settings({ mode: 'notify' });
r = recorder();
const t5 = t4 + 30 * HOUR;
await run(sn, { now: t5, steps: r.steps });
await run(sn, { now: t5 + 25 * HOUR, steps: r.steps });
await run(sn, { now: t5 + 26 * HOUR, steps: r.steps });
check('U15: notify mode announces a ready update once and installs nothing', r.calls.length === 0 && r.notes.length === 1 && /update ready: 1 commit/.test(r.notes[0]) && installed() === c6.slice(0, 7), r.notes.join(' | '));
check('U15: and the announcement says how to install it', /run --now/.test(r.notes[0]));

const hourNow = new Date(t5 + 25 * HOUR).getHours();
const away = `${String((hourNow + 2) % 24).padStart(2, '0')}-${String((hourNow + 3) % 24).padStart(2, '0')}`;
const sw = settings({ window: away === '23-00' ? '23-24' : away });
r = recorder();
await run(sw, { now: t5, steps: r.steps });
await run(sw, { now: t5 + 25 * HOUR, steps: r.steps });
check('U16: outside its window a ready update waits', r.calls.length === 0 && stateOf(sw).last.outcome === 'waiting' && /window/.test(stateOf(sw).last.detail), JSON.stringify(stateOf(sw).last));

const s0 = settings({ soakHours: 0 });
r = recorder();
await run(s0, { now: t5, steps: r.steps });
check('U17: soakHours 0 takes the tip at once', installed() === c7.slice(0, 7), r.calls.join());

const c8 = commit('infra/lib/stack.js');
const sa = settings({ soakHours: 0 }, 'aws');
r = recorder();
await run(sa, { now: t5, steps: r.steps });
await run(sa, { now: t5 + HOUR, steps: r.steps });
check('U18: on AWS a change to the stack is held, not installed', r.calls.length === 0 && stateOf(sa).last.outcome === 'held' && /infra\/lib\/stack\.js/.test(stateOf(sa).last.detail), JSON.stringify(stateOf(sa).last));
check('U18: and said once, not on every run', r.notes.length === 1 && /deploy\.sh/.test(r.notes[0]), r.notes.join(' | '));
commit();
await run(sa, { now: t5 + 2 * HOUR, steps: r.steps });
check('U18: nor again for each commit that piles up behind it', r.notes.length === 1 && stateOf(sa).last.outcome === 'held');
const sh = settings({ soakHours: 0 });
r = recorder();
await run(sh, { now: t5, steps: r.steps });
check('U19: a host install has no stack, so the same commit installs there', installed() === git(work, 'rev-parse', 'HEAD').slice(0, 7), r.calls.join());
check('U19: (and c8 is behind it)', git(work, 'merge-base', '--is-ancestor', c8, 'HEAD') === '');

commit();
const ss = settings({ soakHours: 0 });
r = recorder();
r.steps.canSudo = () => false;
await run(ss, { now: t5, steps: r.steps });
check('U20: a host install that cannot sudo unattended holds and says why', r.calls.length === 0 && stateOf(ss).last.outcome === 'held' && /sudo without a password/.test(stateOf(ss).last.detail));

setInstalled(git(work, 'rev-parse', 'HEAD~1'), true);
const sd = settings({ soakHours: 0 });
r = recorder();
await run(sd, { now: t5, steps: r.steps });
check('U21: a build with uncommitted changes is never updated over', r.calls.length === 0 && /uncommitted changes/.test(stateOf(sd).last.detail));

setInstalled('0123456789abcdef0123456789abcdef01234567');
const su = settings({ soakHours: 0 });
r = recorder();
await run(su, { now: t5, steps: r.steps });
check('U22: a commit the repository does not have is held', r.calls.length === 0 && /is not in/.test(stateOf(su).last.detail), stateOf(su).last.detail);

const so = settings({ mode: 'off' });
const code = await run(so, { now: t5 });
check('U23: mode off does nothing at all, not even a fetch', code === 0 && !fs.existsSync(so.stateDir));
setInstalled(git(work, 'rev-parse', 'HEAD~1'));
r = recorder();
await run(so, { now: t5, force: true, steps: r.steps });
check('U23: but --now is a person asking, and updates whatever the mode', installed() === git(work, 'rev-parse', 'HEAD').slice(0, 7) && r.calls.includes('runTests'), r.calls.join());
const snn = settings({ mode: 'notify' });
setInstalled(git(work, 'rev-parse', 'HEAD~1'));
r = recorder();
await run(snn, { now: t5, force: true, steps: r.steps });
check('U23: in notify mode too', installed() === git(work, 'rev-parse', 'HEAD').slice(0, 7), r.calls.join());

setInstalled(git(work, 'rev-parse', 'HEAD'));
const st = describe(s, stateOf(s), t5);
check('U24: status names the mode, the branch, the cautions and the last run', /mode {8}install/.test(st) && /following {3}main of /.test(st) && /soak 24 h/.test(st) && /last run/.test(st), st);

console.log('how often the timer looks');
const MIN = 60e3;
check('U25: a box that has never looked is due', checkDue(null, 0, 60) && checkDue({}, 0, 60));
check('U25: 30 minutes after a look, an hourly check is not due', !checkDue({ at: 0 }, 30 * MIN, 60));
check('U25: a timer run landing a few seconds early still counts as on time', checkDue({ at: 0 }, 60 * MIN - 10e3, 60));
check('U25: checkMinutes 5 looks on every timer run', checkDue({ at: 0 }, 5 * MIN - 20e3, 5));
const c9 = commit();
const sc = settings({ soakHours: 0, idleMinutes: 0 });
r = recorder();
await run(sc, { now: t5 + 30 * HOUR, steps: r.steps });
const lookedAt = stateOf(sc).last.at;
const c10 = commit();
await run(sc, { now: t5 + 30 * HOUR + 20 * MIN, steps: r.steps });
check('U25: a timer run inside checkMinutes does not fetch, decide or record anything', stateOf(sc).last.at === lookedAt && stateOf(sc).tip !== c10 && installed() !== c10.slice(0, 7), JSON.stringify(stateOf(sc).last));
await run(sc, { now: t5 + 30 * HOUR + 20 * MIN, force: true, steps: r.steps });
check('U25: --now is not a timer run and always looks', installed() === c10.slice(0, 7), r.calls.join());
check('U25: (c9 was taken first, c10 after)', git(work, 'merge-base', '--is-ancestor', c9, c10) === '');
const s5 = settings({ soakHours: 0, idleMinutes: 0, checkMinutes: 5 });
setInstalled(c9);
r = recorder();
await run(s5, { now: t5 + 40 * HOUR, steps: r.steps });
setInstalled(c9);
await run(s5, { now: t5 + 40 * HOUR + 5 * MIN, steps: r.steps });
check('U25: with checkMinutes 5 the next timer run looks again', r.calls.filter((c) => c === 'runTests').length === 2, r.calls.join());
check('U25: checkMinutes below the timer period is refused', validateAutoUpdate({ checkMinutes: 1 }).some((e) => e.startsWith('autoUpdate.checkMinutes:')));

console.log('status for the box page');
const now6 = t5 + 41 * HOUR;
const js = statusOf(s5, stateOf(s5), now6);
check('U26: status --json carries the settings, what is installed and the tip',
  js.settings.mode === 'install' && js.settings.checkMinutes === 5 && js.installed?.commit === c10.slice(0, 7) && js.tip?.sha === c10 && js.current === true, JSON.stringify(js));
check('U26: and the last run and when the next look is due', js.last?.outcome === 'installed' && js.nextCheckAt === now6, JSON.stringify(js));
check('U26: an installed tip is not called soaking', js.soakingUntil === null);
const c11 = commit();
const ssk = settings({ soakHours: 24 });
setInstalled(c10);
r = recorder();
await run(ssk, { now: now6, steps: r.steps });
const jk = statusOf(ssk, stateOf(ssk), now6 + MIN);
check('U26: a newer commit that is soaking says when it will be taken', jk.current === false && jk.tip.sha === c11 && jk.soakingUntil === now6 + 24 * HOUR, JSON.stringify(jk));
check('U26: and an hourly check is next due an hour after the last, less the slack', jk.nextCheckAt === now6 + 60 * MIN - 2.5 * MIN, JSON.stringify(jk));
const jo = statusOf(settings({ mode: 'off' }), {}, now6);
check('U26: mode off has no next check, and says how to update by hand', jo.nextCheckAt === null && /run --now/.test(jo.command) && jo.last === null);

console.log('settings saved from the box page');
{
  const sb = settings({ mode: 'off', soakHours: 24 });
  applyBoxSettings(sb, null);
  saveBoxSettings(sb, { mode: 'install', soakHours: 0, checkMinutes: 5 }, 1000);
  check('U27: a box-page edit takes effect', sb.autoUpdate.mode === 'install' && sb.autoUpdate.soakHours === 0 && sb.autoUpdate.checkMinutes === 5);
  check('U27: and says which keys it changed from the config', sb.boxSettings.keys.join() === 'mode,soakHours,checkMinutes', JSON.stringify(sb.boxSettings));
  const saved = JSON.parse(fs.readFileSync(path.join(sb.stateDir, BOX_SETTINGS), 'utf8'));
  check('U27: only what differs from the config is kept', Object.keys(saved.autoUpdate).join() === 'mode,soakHours,checkMinutes', JSON.stringify(saved));

  // A deploy rewrites the config the box reads; one that leaves autoUpdate as it was
  // keeps the edit.
  const again = settings({ mode: 'off', soakHours: 24 });
  again.stateDir = sb.stateDir;
  applyBoxSettings(again, saved);
  check('U28: a deploy that does not touch autoUpdate keeps the edit', again.autoUpdate.mode === 'install');
  const changed = settings({ mode: 'notify', soakHours: 24 });
  applyBoxSettings(changed, saved);
  check('U28: a change to autoUpdate in the config file wins over an older edit',
    changed.autoUpdate.mode === 'notify' && changed.boxSettings.superseded === true, JSON.stringify(changed.boxSettings));
  check('U28: and status says so', /replaced by a later change to the config file/.test(describe(changed, {})));

  let threw = '';
  try {
    saveBoxSettings(sb, { mode: 'always', checkMinutes: 1 });
  } catch (e) {
    threw = e.message;
  }
  check('U29: a bad value is refused, naming each key', /autoUpdate\.mode/.test(threw) && /autoUpdate\.checkMinutes/.test(threw), threw);
  check('U29: and changes nothing', sb.autoUpdate.mode === 'install');
  saveBoxSettings(sb, { ...sb.configAutoUpdate });
  check('U30: setting the config\'s own values back removes the file', !fs.existsSync(path.join(sb.stateDir, BOX_SETTINGS)) && sb.autoUpdate.mode === 'off' && sb.boxSettings === null);
  const js2 = statusOf(sb, {}, 0);
  check('U30: status carries what the config says next to what applies', js2.configured.mode === 'off' && js2.boxSettings === null);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed}/${passed + failed} checks passed`);
process.exitCode = failed ? 1 : 0;
