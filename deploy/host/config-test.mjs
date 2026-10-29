#!/usr/bin/env node
/**
 * The host config's rules, one assertion each: what validate() refuses, and the
 * exact env file the service is started with. No dependencies and no framework,
 * because CI runs it in a bare container before anything is installed.
 *
 *   node deploy/host/config-test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { envPairs, get, renderEnv, renderProjects, resolve, validate } from './config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const example = JSON.parse(readFileSync(join(here, 'triplec.host.example.json'), 'utf8'));
const ctx = { user: 'dev', home: '/home/dev' };

let passed = 0;
let total = 0;
const failures = [];
function test(name, fn) {
  total += 1;
  try {
    fn();
    passed += 1;
  } catch (e) {
    failures.push(`${name}\n    ${e.message.split('\n').join('\n    ')}`);
  }
}

/** The example with a change applied at a dotted path (undefined deletes). */
function withChange(path, value, base = example) {
  const c = structuredClone(base);
  const parts = path.split('.');
  let o = c;
  for (const p of parts.slice(0, -1)) o = o[p];
  if (value === undefined) delete o[parts.at(-1)];
  else o[parts.at(-1)] = value;
  return c;
}
const errorsOf = (c) => validate(c).errors;
const ok = (c) => assert.deepEqual(errorsOf(c), []);
function rejects(c, keyPrefix, pattern) {
  const errs = errorsOf(c);
  assert.ok(errs.some((e) => e.startsWith(keyPrefix) && (!pattern || pattern.test(e))),
    `expected an error on ${keyPrefix}${pattern ? ` matching ${pattern}` : ''}, got: ${JSON.stringify(errs)}`);
}
const env = (c) => Object.fromEntries(envPairs(resolve(c, ctx)));

// --- the example and the minimum --------------------------------------------
test('the example validates', () => ok(example));
test('{"mode":"host"} alone validates, on defaults', () => ok({ mode: 'host' }));
test('not an object', () => rejects([], 'config'));
test('mode must be host', () => rejects(withChange('mode', 'aws'), 'mode'));

// --- unknown keys -------------------------------------------------------------
test('unknown top-level key', () => rejects({ ...example, bnid: '0.0.0.0' }, 'bnid', /unknown key/));
test('unknown nested key', () => rejects(withChange('listen.bnid', '0.0.0.0'), 'listen.bnid', /unknown key/));
test('unknown feature', () => rejects(withChange('features.telemetry', true), 'features.telemetry', /unknown key/));
test('unknown project key', () => rejects(withChange('projects', [{ name: 'a', path: '/a', branch: 'x' }]), 'projects[0].branch'));
test('unknown slots key', () => rejects(withChange('projects', [{ name: 'a', path: '/a', slots: { n: 1 } }]), 'projects[0].slots.n'));

// --- features -------------------------------------------------------------------
test('feature flags are booleans', () => rejects(withChange('features.mux', 'yes'), 'features.mux'));
test('features must be an object', () => rejects(withChange('features', ['mux']), 'features'));
test('polish without bedrock is a warning, not an error', () => {
  const c = withChange('features.polish', true);
  ok(c);
  assert.ok(validate(c).warnings.some((w) => w.startsWith('features.polish')));
});

// --- claude -----------------------------------------------------------------------
for (const m of ['login', 'bedrock', 'apiKey']) test(`authMode ${m} accepted`, () => ok(withChange('claude.authMode', m)));
test('authMode unknown', () => rejects(withChange('claude.authMode', 'console'), 'claude.authMode'));
test('vertex needs projectId and region', () => {
  const c = withChange('claude.authMode', 'vertex');
  rejects(c, 'claude.vertex.projectId', /required/);
  rejects(c, 'claude.vertex.region', /required/);
});
test('vertex with both validates', () => {
  ok(withChange('claude.vertex', { projectId: 'my-project-123', region: 'us-east5' }, withChange('claude.authMode', 'vertex')));
});
test('vertex projectId shape', () => rejects(withChange('claude.vertex.projectId', 'Not A Project'), 'claude.vertex.projectId'));
for (const m of ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan', 'default']) {
  test(`permissionMode ${m} accepted`, () => ok(withChange('claude.permissionMode', m)));
}
test('permissionMode unknown', () => rejects(withChange('claude.permissionMode', 'yolo'), 'claude.permissionMode'));
for (const e of ['low', 'medium', 'high', 'xhigh', 'max']) test(`effort ${e} accepted`, () => ok(withChange('claude.effort', e)));
test('effort unknown', () => rejects(withChange('claude.effort', 'ultra'), 'claude.effort'));
test('defaultModel shape', () => rejects(withChange('claude.defaultModel', 'opus; rm -rf /'), 'claude.defaultModel'));
test('defaultModel with [1m] accepted', () => ok(withChange('claude.defaultModel', 'claude-opus-4-1[1m]')));

// --- auth ----------------------------------------------------------------------------
test('oidc is refused in host mode, with a reason', () => rejects(withChange('auth.mode', 'oidc'), 'auth.mode', /AWS/));
test('auth mode unknown', () => rejects(withChange('auth.mode', 'none'), 'auth.mode'));
const th = (emails, singleOwner = true) => withChange('auth', {
  mode: 'trusted-header',
  singleOwner,
  trustedHeader: { header: 'Tailscale-User-Login', allowedEmails: emails, peerUid: 0, allowPassword: true },
});
test('trusted-header needs an identity', () => rejects(th([]), 'auth.trustedHeader.allowedEmails', /at least one/));
test('trusted-header singleOwner needs exactly one', () => rejects(th(['a@x.dev', 'b@x.dev']), 'auth.trustedHeader.allowedEmails', /exactly one/));
test('trusted-header with one owner validates', () => ok(th(['a@x.dev'])));
test('trusted-header shared validates with two', () => ok(th(['a@x.dev', 'b@x.dev'], false)));
test('allowedEmails must be emails', () => rejects(th(['not an email']), 'auth.trustedHeader.allowedEmails'));
test('peerUid integer', () => rejects(withChange('auth.trustedHeader.peerUid', -1), 'auth.trustedHeader.peerUid'));
test('header name shape', () => rejects(withChange('auth.trustedHeader.header', 'X Bad: 1'), 'auth.trustedHeader.header'));

// --- listen -----------------------------------------------------------------------------
for (const b of ['127.0.0.1', '::1', 'localhost']) test(`bind ${b} accepted`, () => ok(withChange('listen.bind', b)));
test('public bind refused by default', () => rejects(withChange('listen.bind', '0.0.0.0'), 'listen.bind', /allowPublicBind/));
test('public bind allowed when asked, with a warning', () => {
  const c = withChange('listen', { nginxPort: 8080, appPort: 9997, bind: '0.0.0.0', allowPublicBind: true });
  ok(c);
  assert.ok(validate(c).warnings.some((w) => w.startsWith('listen.bind')));
});
test('ports are integers in range', () => {
  rejects(withChange('listen.nginxPort', 70000), 'listen.nginxPort');
  rejects(withChange('listen.appPort', '9997'), 'listen.appPort');
});
test('ports must differ', () => rejects(withChange('listen.appPort', 8080), 'listen', /differ/));
test('9999 is taken by the editor', () => {
  rejects(withChange('listen.appPort', 9999, withChange('features.editor', true)), 'listen', /code-server/);
});

// --- projects ------------------------------------------------------------------------------
const proj = (...ps) => withChange('projects', ps);
test('project name charset', () => rejects(proj({ name: 'a b', path: '/a' }), 'projects[0].name'));
test('project name no leading dot', () => rejects(proj({ name: '.hidden', path: '/a' }), 'projects[0].name'));
test('project names unique', () => rejects(proj({ name: 'a', path: '/a' }, { name: 'a', path: '/b' }), 'projects[1].name', /twice/));
test('project path absolute or ~/', () => rejects(proj({ name: 'a', path: 'src/a' }), 'projects[0].path', /absolute/));
test('project path no ..', () => rejects(proj({ name: 'a', path: '~/../etc' }), 'projects[0].path', /\.\./));
test('slots.count 1..8', () => {
  rejects(proj({ name: 'a', path: '/a', slots: { count: 0 } }), 'projects[0].slots.count');
  rejects(proj({ name: 'a', path: '/a', slots: { count: 9 } }), 'projects[0].slots.count');
  rejects(proj({ name: 'a', path: '/a', slots: { count: 2.5 } }), 'projects[0].slots.count');
  ok(proj({ name: 'a', path: '/a', slots: { count: 1 } }));
});
test('postCreate single line', () => rejects(proj({ name: 'a', path: '/a', slots: { postCreate: 'a\nb' } }), 'projects[0].slots.postCreate'));
test('slots may be omitted', () => ok(proj({ name: 'a', path: '/a' })));
test('directory paths absolute or ~/', () => {
  for (const k of ['installDir', 'configDir', 'stateDir', 'projectsRoot', 'claudeHome']) rejects(withChange(k, 'rel/dir'), k);
});
test('paths may not carry a $', () => rejects(withChange('installDir', '~/$HOME/x'), 'installDir'));
test('home absolute', () => rejects(withChange('home', 'home/dev'), 'home'));

// --- the rest ---------------------------------------------------------------------------------
test('maxLiveSessions 1..64', () => {
  rejects(withChange('maxLiveSessions', 0), 'maxLiveSessions');
  rejects(withChange('maxLiveSessions', 65), 'maxLiveSessions');
  ok(withChange('maxLiveSessions', 64));
});
test('pwa.name shape', () => {
  ok(withChange('pwa.name', 'Dev Box 2'));
  rejects(withChange('pwa.name', '<script>'), 'pwa.name');
  rejects(withChange('pwa.name', 'x'.repeat(41)), 'pwa.name');
});
test('secrets.backend file|env', () => {
  ok(withChange('secrets.backend', 'env'));
  rejects(withChange('secrets.backend', 'vault'), 'secrets.backend');
});

// --- no literal secrets --------------------------------------------------------------------------
test('a password field is refused, pointing at secrets.env', () => rejects(withChange('auth.password', 'hunter2hunter2'), 'auth.password', /secrets\.env/));
test('an apiKey field is refused', () => rejects(withChange('claude.apiKey', 'x'), 'claude.apiKey', /secrets/));
test('a token anywhere is refused', () => rejects({ ...example, githubToken: 'x' }, 'githubToken', /secrets/));
test('a credential-shaped value is refused wherever it is', () => {
  rejects(withChange('pwa.name', 'sk-ant-api03-abcdefghijklmnop'), 'pwa.name', /Anthropic/);
  rejects(proj({ name: 'a', path: '/a', slots: { postCreate: 'export AWS=AKIAABCDEFGHIJKLMNOP' } }), 'projects[0].slots.postCreate', /AWS/);
});
test('allowPassword is not mistaken for a secret', () => ok(withChange('auth.trustedHeader.allowPassword', false)));

// --- resolve + env ------------------------------------------------------------------------------
test('~ expands against the target home', () => {
  const c = resolve(example, ctx);
  assert.equal(c.user, 'dev');
  assert.equal(c.installDir, '/home/dev/.local/share/triplec');
  assert.equal(c.projects[0].path, '/home/dev/src/example');
  assert.equal(c.claudeHome, '/home/dev/.claude');
});
test('an explicit home wins over the invoking user\'s', () => {
  assert.equal(resolve(withChange('home', '/srv/dev'), ctx).configDir, '/srv/dev/.config/triplec');
});
test('env: the default contract, exactly', () => {
  assert.deepEqual(envPairs(resolve(example, ctx)), [
    ['TRIPLEC_MODE', 'host'],
    ['WORKSPACE_USER', 'dev'],
    ['HOME', '/home/dev'],
    ['PROJECTS_ROOT', '/home/dev/projects'],
    ['CLAUDE_HOME', '/home/dev/.claude'],
    ['TRIPLEC_PROJECTS_FILE', '/home/dev/.config/triplec/projects.json'],
    ['TRIPLEC_FEATURES', 'push,mux,admin'],
    ['CLAUDE_AUTH_MODE', 'login'],
    ['DEFAULT_PERMISSION_MODE', 'manual'],
    ['DEFAULT_EFFORT', 'high'],
    ['TRIPLEC_LOGIN_PATH', '1'],
    ['PORT', '9997'],
    ['BIND_ADDRESS', '127.0.0.1'],
    ['ALLOW_PUBLIC_BIND', '0'],
    ['CW_AUTH_MODE', 'password'],
    ['CW_SINGLE_OWNER', '1'],
    ['TRIPLEC_SECRETS_FILE', '/home/dev/.config/triplec/secrets.env'],
    ['MAX_LIVE_SESSIONS', '8'],
    ['PWA_NAME', ''],
    ['TRIPLEC_AUDIT', '1'],
    ['CW_PUSH_DIR', '/home/dev/.local/state/triplec/push'],
    ['CC_SCRIPT', '/home/dev/.local/share/triplec/bin/cc'],
  ]);
});
test('env: no projects means no projects file', () => {
  assert.equal(env(withChange('projects', [])).TRIPLEC_PROJECTS_FILE, undefined);
});
test('env: "default" permission mode is written as manual', () => {
  assert.equal(env(withChange('claude.permissionMode', 'default')).DEFAULT_PERMISSION_MODE, 'manual');
});
test('env: model line only when set', () => {
  assert.equal(env(example).ANTHROPIC_MODEL, undefined);
  assert.equal(env(withChange('claude.defaultModel', 'claude-opus-4-1')).ANTHROPIC_MODEL, 'claude-opus-4-1');
});
test('env: trusted-header lines only in that mode', () => {
  assert.equal(env(example).CW_TRUSTED_HEADER, undefined);
  const e = env(th(['a@x.dev']));
  assert.equal(e.CW_AUTH_MODE, 'trusted-header');
  assert.equal(e.CW_TRUSTED_HEADER, 'Tailscale-User-Login');
  assert.equal(e.CW_TRUSTED_EMAILS, 'a@x.dev');
  assert.equal(e.CW_TRUSTED_PEER_UID, '0');
  assert.equal(e.CW_TRUSTED_ALLOW_PASSWORD, '1');
});
test('env: shared trusted-header joins the list', () => {
  assert.equal(env(th(['a@x.dev', 'b@x.dev'], false)).CW_TRUSTED_EMAILS, 'a@x.dev,b@x.dev');
});
test('env: vertex lines only for vertex', () => {
  assert.equal(env(example).CLOUD_ML_REGION, undefined);
  const e = env(withChange('claude.vertex', { projectId: 'my-project-123', region: 'us-east5' }, withChange('claude.authMode', 'vertex')));
  assert.equal(e.CLAUDE_AUTH_MODE, 'vertex');
  assert.equal(e.CLOUD_ML_REGION, 'us-east5');
  assert.equal(e.ANTHROPIC_VERTEX_PROJECT_ID, 'my-project-123');
});
test('env: env backend has no secrets file', () => {
  assert.equal(env(withChange('secrets.backend', 'env')).TRIPLEC_SECRETS_FILE, undefined);
});
test('env: features list follows the flags', () => {
  const all = Object.fromEntries(['editor', 'voice', 'polish', 'push', 'mux', 'admin', 'retire'].map((f) => [f, true]));
  assert.equal(env(withChange('features', all)).TRIPLEC_FEATURES, 'editor,voice,polish,push,mux,admin,retire');
  const none = Object.fromEntries(Object.keys(all).map((f) => [f, false]));
  const e = env(withChange('features', none));
  assert.equal(e.TRIPLEC_FEATURES, '');
  assert.equal(e.CC_SCRIPT, undefined);
});
test('env: voice points at the installed whisper', () => {
  const e = env(withChange('features.voice', true));
  assert.equal(e.WHISPER_BIN, '/home/dev/.local/share/triplec/whisper/whisper-cli');
  assert.equal(e.WHISPER_MODEL, '/home/dev/.local/share/triplec/whisper/models/ggml-base.en.bin');
});
test('env: push state lives in stateDir, not ~/.claude', () => assert.match(env(example).CW_PUSH_DIR, /\/\.local\/state\/triplec\/push$/));
test('env: a name with spaces survives unquoted', () => {
  assert.match(renderEnv(resolve(withChange('pwa.name', 'Dev Box'), ctx)), /^PWA_NAME=Dev Box$/m);
});
test('env: an unsafe value is refused, not escaped', () => {
  const c = resolve(example, ctx);
  c.user = 'dev"x';
  assert.throws(() => renderEnv(c), /not safe/);
  c.user = 'dev\nEVIL=1';
  assert.throws(() => renderEnv(c), /not safe/);
});
test('env: every line is KEY=VALUE or a comment', () => {
  for (const line of renderEnv(resolve(example, ctx)).trimEnd().split('\n')) assert.match(line, /^(#.*|[A-Z_]+=[^\n]*)$/);
});
test('projects.json: expanded, with slot defaults', () => {
  assert.deepEqual(JSON.parse(renderProjects(resolve(proj({ name: 'a', path: '~/a/' }), ctx))), [
    { name: 'a', path: '/home/dev/a', slots: { count: 8, postCreate: '' } },
  ]);
});
test('get: scalars bare, nested by dots', () => {
  const c = resolve(example, ctx);
  assert.equal(get(c, 'features.mux'), 'true');
  assert.equal(get(c, 'listen.nginxPort'), '8080');
  assert.equal(get(c, 'installDir'), '/home/dev/.local/share/triplec');
  assert.throws(() => get(c, 'listen.nope'), /no such key/);
});

// --- the CLI ------------------------------------------------------------------------------------------
test('CLI: validate exits 0 on the example and 1 on a bad file', () => {
  const cli = join(here, 'config.mjs');
  execFileSync(process.execPath, [cli, 'validate', join(here, 'triplec.host.example.json')], { stdio: 'pipe' });
  assert.throws(() => execFileSync(process.execPath, [cli, 'validate', '/nonexistent.json'], { stdio: 'pipe' }),
    (e) => e.status === 1);
});

for (const f of failures) console.error(`FAIL ${f}`);
console.log(`${passed}/${total} passed`);
process.exitCode = passed === total ? 0 : 1;
