#!/usr/bin/env node
/**
 * The box page's settings store (scripts/box-config.mjs): the layering rule, the
 * catalogue of keys, saving with each platform's own validation, and what
 * bootstrap.sh is handed.
 *
 *   node scripts/box-config-test.mjs
 *
 * Against real files in a temporary directory, the real infra/config.js for AWS and
 * the real deploy/host/config.mjs for a host install.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  layer, leaves, withChanges, withoutPaths, shellAssignments, scopeOf, statusOf, save, deployment,
  readStore, writeStore, emptyStore, getPath,
} from './box-config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'box-config-test-'));

// A resolved AWS config, the shape the payload's deployment/config.json has.
const exampleFile = path.join(tmp, 'triplec.config.json');
fs.writeFileSync(exampleFile, JSON.stringify({
  domainName: 'claude.example.com',
  hostedZoneName: 'example.com',
  defaultModel: 'sonnet',
  gitUserName: 'Ada',
  gitUserEmail: 'ada@example.com',
  oidc: { allowedEmails: [] },
}));
const resolved = JSON.parse(execFileSync('node', [path.join(HERE, '..', 'infra', 'print-config.js'), '--json'], {
  env: { ...process.env, TRIPLEC_CONFIG: exampleFile, TRIPLEC_BOX_OVERRIDES: path.join(tmp, 'none.json') },
  encoding: 'utf8',
}));

console.log('the layering rule');
{
  const store = withChanges(resolved, emptyStore(), { defaultModel: 'opus', 'pwa.name': 'work' }, { platform: 'aws', now: 1 });
  const { config, applied } = layer(resolved, store);
  check('B1: a saved value applies over the file', config.defaultModel === 'opus' && config.pwa.name === 'work' && applied.length === 2);
  check('B1: and is recorded against the file\'s value', store.base.defaultModel === '"sonnet"' && store.savedAt.defaultModel === 1);
  check('B1: nested keys are set in place, not replacing their object', config.pwa.iconDir === resolved.pwa.iconDir);
  const deployedAgain = layer(JSON.parse(JSON.stringify(resolved)), store);
  check('B2: a deploy that leaves the key alone keeps the edit', deployedAgain.config.defaultModel === 'opus');
  const fileChanged = { ...resolved, defaultModel: 'haiku' };
  const after = layer(fileChanged, store);
  check('B2: a change to that key in the file wins over the older edit',
    after.config.defaultModel === 'haiku' && after.superseded.includes('defaultModel') && after.config.pwa.name === 'work');
  const back = withChanges(resolved, store, { defaultModel: 'sonnet' }, { platform: 'aws' });
  check('B3: setting the file\'s own value back drops the entry', !('defaultModel' in back.values) && 'pwa.name' in back.values);
  check('B3: a reset of one path drops only it', Object.keys(withoutPaths(store, ['pwa.name']).values).join() === 'defaultModel');
  check('B3: a reset of none drops everything', Object.keys(withoutPaths(store, []).values).length === 0);
}

console.log('what can be edited, and where it takes effect');
{
  const paths = leaves(resolved);
  for (const p of ['domainName', 'instanceType', 'allowedCidrs', 'oidc.allowedEmails', 'pwa.name', 'autoUpdate.mode', 'security.guardDuty', 'landing.domainName']) {
    check(`B4: ${p} is on the page`, paths.includes(p));
  }
  check('B4: a list is one field, edited whole', paths.includes('allowedCidrs') && !paths.some((p) => p.startsWith('allowedCidrs.')));
  check('B5: autoUpdate takes effect on the timer', scopeOf('aws', 'autoUpdate.soakHours') === 'timer');
  check('B5: the model is applied by the box', scopeOf('aws', 'defaultModel') === 'box');
  check('B5: the instance type needs a full deploy', scopeOf('aws', 'instanceType') === 'stack');
  check('B5: on a host install everything is the box\'s own', scopeOf('host', 'listen.appPort') === 'box');
}

console.log('refusals');
{
  const refuse = (changes, platform = 'aws') => {
    try {
      withChanges(resolved, emptyStore(), changes, { allowed: leaves(resolved), platform });
      return '';
    } catch (e) {
      return e.message;
    }
  };
  check('B6: a key the config does not have is refused by name', /nonsense: not a key/.test(refuse({ nonsense: 1 })));
  check('B6: a value of the wrong type is refused', /instanceType: must be a string/.test(refuse({ instanceType: 4 })));
  check('B6: a list stays a list', /allowedCidrs: must be a list/.test(refuse({ allowedCidrs: '0.0.0.0/0' })));
  check('B7: a box key bootstrap writes as root takes no shell metacharacters',
    /gitUserName: may not contain/.test(refuse({ gitUserName: "Ada'; reboot; '" })));
  check('B7: in a list either', /oidc.allowedEmails: may not contain/.test(refuse({ 'oidc.allowedEmails': ['a@b.c', '$(id)@x'] })));
}

console.log('what bootstrap.sh is handed');
{
  const store = withChanges(resolved, emptyStore(), {
    defaultModel: 'opus', 'oidc.allowedEmails': ['a@example.com', 'b@example.com'], instanceType: 't4g.large',
  }, { platform: 'aws' });
  const sh = shellAssignments(resolved, store);
  check('B8: the box keys, as the variables bootstrap.sh uses, quoted',
    sh.includes("DEFAULT_MODEL='opus'") && sh.includes("OIDC_ALLOWED_EMAILS='a@example.com,b@example.com'"), sh);
  check('B8: and nothing for a stack key, which the stack carries', !/t4g/.test(sh));
  const tampered = { ...store, values: { ...store.values, gitUserName: "x'; reboot #" }, base: { ...store.base, gitUserName: JSON.stringify(resolved.gitUserName) } };
  check('B8: a value edited into the file by hand is still left out', !/reboot/.test(shellAssignments(resolved, tampered)));
}

console.log('saving, with each platform\'s validation');
{
  // AWS: the installed payload's config, and infra/config.js from this checkout.
  const install = path.join(tmp, 'opt');
  fs.mkdirSync(path.join(install, 'deployment'), { recursive: true });
  fs.writeFileSync(path.join(install, 'deployment', 'config.json'), JSON.stringify(resolved));
  const storeFile = path.join(tmp, 'overrides.json');
  process.env.TRIPLEC_INSTALL_DIR = install;
  process.env.TRIPLEC_BOX_OVERRIDES = storeFile;
  const d = await deployment(['--aws']);
  await save(d, { defaultModel: 'opus', instanceType: 't4g.2xlarge' });
  const st = statusOf(d, readStore(storeFile));
  check('B9: a save is kept on the box', readStore(storeFile).values.defaultModel === 'opus');
  check('B9: status lists every key with its file value and what applies',
    st.fields.find((f) => f.path === 'defaultModel')?.value === 'opus' && st.fields.find((f) => f.path === 'defaultModel')?.file === 'sonnet'
      && st.fields.find((f) => f.path === 'defaultModel')?.changed === true);
  check('B9: and what is waiting, by where it takes effect',
    st.pending.box.join() === 'defaultModel' && st.pending.stack.join() === 'instanceType', JSON.stringify(st.pending));
  let msg = '';
  try {
    await save(d, { domainName: 'not a hostname' });
  } catch (e) {
    msg = e.message;
  }
  check('B10: a value the config itself refuses is refused, with its message', /domainName "not a hostname" is not a hostname/.test(msg), msg);
  check('B10: and nothing is saved', readStore(storeFile).values.domainName === undefined);
  msg = '';
  try {
    await save(d, { 'autoUpdate.checkMinutes': 1 });
  } catch (e) {
    msg = e.message;
  }
  check('B10: autoUpdate is checked by the same rules as the file', /checkMinutes/.test(msg), msg);

  // The deploy reads the store too (infra/config.js loadConfig).
  const shell = execFileSync('node', [path.join(HERE, '..', 'infra', 'print-config.js')], {
    env: { ...process.env, TRIPLEC_CONFIG: exampleFile, TRIPLEC_BOX_OVERRIDES: storeFile }, encoding: 'utf8',
  });
  check('B11: a deploy deploys the box page\'s values', /CFG_INSTANCE_TYPE='t4g.2xlarge'/.test(shell), shell.split('\n').find((l) => l.includes('INSTANCE')));
  const payloadConfig = JSON.parse(execFileSync('node', [path.join(HERE, '..', 'infra', 'print-config.js'), '--json'], {
    env: { ...process.env, TRIPLEC_CONFIG: exampleFile, TRIPLEC_BOX_OVERRIDES: storeFile }, encoding: 'utf8',
  }));
  check('B11: but the payload carries the file\'s own values, which the box compares with',
    payloadConfig.instanceType === resolved.instanceType && payloadConfig.defaultModel === 'sonnet');
  // The command itself, as the page runs it: a save it must validate with
  // infra/config.js, which imports this module back.
  const cli = (...args) => {
    try {
      return { code: 0, out: execFileSync('node', [path.join(HERE, 'box-config.mjs'), ...args, '--aws'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 }) };
    } catch (e) {
      return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
    }
  };
  const refusedCli = cli('set', '--value', '{"domainName":"not a host"}');
  check('B15: the command refuses an invalid value with the config\'s message, and exits 1',
    refusedCli.code === 1 && /is not a hostname/.test(refusedCli.out), `${refusedCli.code}: ${refusedCli.out.slice(0, 200)}`);
  const savedCli = cli('set', '--value', '{"effortLevel":"low"}');
  check('B15: and saves a valid one, answering the new status', savedCli.code === 0
    && JSON.parse(savedCli.out).fields.find((f) => f.path === 'effortLevel')?.value === 'low', `${savedCli.code}: ${savedCli.out.slice(0, 200)}`);
  delete process.env.TRIPLEC_INSTALL_DIR;
  delete process.env.TRIPLEC_BOX_OVERRIDES;

  // A host install: the raw file, validated by config.mjs.
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  const hostFile = path.join(tmp, 'host.json');
  fs.writeFileSync(hostFile, JSON.stringify({ mode: 'host', user: 'dev', home, stateDir: path.join(tmp, 'state') }));
  const h = await deployment(['--host', hostFile]);
  await save(h, { maxLiveSessions: 4, 'claude.defaultModel': 'opus' });
  const hs = statusOf(h, readStore(h.file));
  check('B12: a host install saves beside its state', fs.existsSync(path.join(tmp, 'state', 'box-config.json')));
  check('B12: and everything it saves is the box\'s to apply', hs.pending.box.sort().join() === 'claude.defaultModel,maxLiveSessions' && !hs.pending.stack.length);
  msg = '';
  try {
    await save(h, { maxLiveSessions: 0 });
  } catch (e) {
    msg = e.message;
  }
  check('B12: refused by the host config\'s own rules', /maxLiveSessions/.test(msg), msg);
  const { loadLayered } = await import('../deploy/host/config.mjs');
  const layered = loadLayered(hostFile);
  check('B13: install.sh installs the saved values', layered.maxLiveSessions === 4 && getPath(layered, 'claude.defaultModel') === 'opus');
  const fileNow = JSON.parse(fs.readFileSync(hostFile, 'utf8'));
  fs.writeFileSync(hostFile, JSON.stringify({ ...fileNow, maxLiveSessions: 6 }));
  check('B13: until the file changes that key', loadLayered(hostFile).maxLiveSessions === 6 && getPath(loadLayered(hostFile), 'claude.defaultModel') === 'opus');
  writeStore(h.file, emptyStore());
  check('B13: an empty store leaves no file behind', !fs.existsSync(h.file));
}

console.log('the payload carries what the box needs');
{
  const build = fs.readFileSync(path.join(HERE, 'build-payload.sh'), 'utf8');
  check('B14: the payload stages box-config.mjs and infra/config.js',
    /cp scripts\/box-config\.mjs dist\/stage\/scripts\//.test(build) && /cp infra\/config\.js dist\/stage\/infra\//.test(build));
  // Every directory staged is one the tarball lists: it names them one by one, and a
  // staged directory left off that list is silently not shipped.
  const staged = new Set([...build.matchAll(/dist\/stage\/([a-z-]+)/g)].map((m) => m[1]));
  const tarLine = /tar -czf "\$OUT" -C dist\/stage \\\n\s*([^\n]+)/.exec(build)?.[1] || '';
  const shipped = new Set(tarLine.trim().split(/\s+/));
  const missing = [...staged].filter((d) => !shipped.has(d));
  check('B14: and the tarball lists every directory it stages', missing.length === 0 && shipped.size > 3, `missing: ${missing.join(', ')}; tar: ${tarLine}`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed}/${passed + failed} checks passed`);
process.exitCode = failed ? 1 : 0;
