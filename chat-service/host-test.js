/**
 * Host mode: TripleC installed onto somebody else's Linux VM, as that VM's user.
 *
 * Boots the real server in host mode against a fake `claude` on PATH, and speaks
 * HTTP and WebSocket to it, the way auth-test.js does — the requirements this
 * covers are about wiring (which routes exist, which provider variables reach the
 * CLI, who a header is believed from), and wiring is what a unit test misses.
 *
 * Every check is named after the requirement it is evidence for, so a failure
 * says which promise the change broke: A2 (no literal user or paths), A4 (the
 * login shell's PATH), A5 / E5 (features off means no route), B1 / B2 (login mode
 * sets no provider and no model), B3 (no AWS), C1 (loopback only), C2 (Secure
 * cookies through a TLS proxy, served at the root), C3 (application ping), C4
 * (the identity header and whose socket it came from), C5 (the audit trail), D1
 * (permission relay), E1 (the registry), E2 (a slot's set-up command), E3 (no
 * history-depth flags), E4 (a slot removed under us), F2 (the session cap).
 *
 * Run: node host-test.js
 */
import { spawn, execFile } from 'child_process';
import { once } from 'events';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { WebSocket } from 'ws';

const execFileAsync = promisify(execFile);
const here = import.meta.dirname;

let failures = 0;
let checks = 0;
function check(name, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// The modules imported directly below read their configuration at import, so this
// process is put in host mode, on the login provider, before any of them load.
process.env.TRIPLEC_MODE = 'host';
process.env.CLAUDE_AUTH_MODE = 'login';
delete process.env.TRIPLEC_SECRETS_FILE;
delete process.env.TRIPLEC_PROJECTS_FILE;
delete process.env.TRIPLEC_LOGIN_PATH;

const PASSWORD = 'host-test-password-long-enough-32';
const SECRET = 'host-test-session-secret-long-enough';

const root = await mkdtemp(join(tmpdir(), 'triplec-host-'));
const home = join(root, 'home');
const bin = join(root, 'bin');
const log = join(root, 'claude-log');
await mkdir(home, { recursive: true });
await mkdir(bin, { recursive: true });
await mkdir(log, { recursive: true });

/*
 * A stand-in for the CLI. It records its argv and the provider variables it was
 * given, answers `system/init` with the id it was told to use, and — for a message
 * containing NEEDS_APPROVAL — asks for permission over the control protocol the
 * real CLI uses with `--permission-prompt-tool stdio`, then reports the answer.
 */
const FAKE = `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
const pick = (k) => (process.env[k] === undefined ? null : process.env[k]);
fs.writeFileSync(${JSON.stringify(log)} + '/' + process.pid + '.json', JSON.stringify({
  args, cwd: process.cwd(), home: pick('HOME'), path: pick('PATH'),
  bedrock: pick('CLAUDE_CODE_USE_BEDROCK'), vertex: pick('CLAUDE_CODE_USE_VERTEX'),
  model: pick('ANTHROPIC_MODEL'), apiKey: pick('ANTHROPIC_API_KEY'),
  authPassword: pick('AUTH_PASSWORD'), sessionSecret: pick('SESSION_SECRET'),
}));
const sid = args[args.indexOf('--session-id') + 1] || 'fake-session';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ type: 'system', subtype: 'init', session_id: sid, model: 'fake', cwd: process.cwd(), permissionMode: 'default' });
let buf = '';
let waiting = null;
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.type === 'control_response' && waiting && msg.response.request_id === waiting) {
      waiting = null;
      const r = msg.response.response;
      out({ type: 'assistant', message: { content: [{ type: 'text', text: r.behavior === 'allow' ? 'ALLOWED ' + (r.updatedInput.command || '') : 'DENIED: ' + r.message }] } });
      out({ type: 'result', subtype: 'success', session_id: sid });
      continue;
    }
    if (msg.type !== 'user') continue;
    const text = msg.message.content[0].text;
    if (text.includes('ASK_QUESTION')) {
      waiting = 'ask-' + Date.now();
      out({ type: 'control_request', request_id: waiting, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [] } } });
      continue;
    }
    if (text.includes('NEEDS_APPROVAL')) {
      waiting = 'req-' + Date.now();
      out({ type: 'control_request', request_id: waiting, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'touch approved.txt' }, description: 'Create a file', tool_use_id: 'toolu_1' } });
      continue;
    }
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'echo: ' + text }] } });
    out({ type: 'result', subtype: 'success', session_id: sid });
  }
});
`;
await writeFile(join(bin, 'claude'), FAKE);
await chmod(join(bin, 'claude'), 0o755);

// A real repository for the project registry, at a path named nothing like the
// project — which is the case the registry exists for.
const repo = join(root, 'repos', 'webapp', 'main');
const origin = join(root, 'origin.git');
await mkdir(repo, { recursive: true });
const git = (cwd, ...args) => execFileAsync('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
await git(root, 'init', '-q', '--bare', '-b', 'main', origin);
await git(repo, 'init', '-q', '-b', 'main');
await git(repo, 'config', 'user.email', 'test@example.com');
await git(repo, 'config', 'user.name', 'Test');
await writeFile(join(repo, 'README.md'), '# webapp\n');
// What a set-up command installs is ignored, as dependencies are, so a slot that ran
// one is still clean — the state a worktree reaper looks for.
await writeFile(join(repo, '.gitignore'), 'node_modules/\n');
await git(repo, 'add', '-A');
await git(repo, 'commit', '-q', '-m', 'init');
await git(repo, 'remote', 'add', 'origin', origin);
await git(repo, 'push', '-q', '-u', 'origin', 'main');
await git(repo, 'remote', 'set-head', 'origin', 'main');

const configDir = join(root, 'config');
await mkdir(configDir, { recursive: true });
const registryFile = join(configDir, 'projects.json');
await writeFile(registryFile, JSON.stringify([
  { name: 'webapp', path: repo, slots: { count: 3, postCreate: 'mkdir -p node_modules && echo set-up ran > node_modules/.triplec-setup && test -z "$FAIL_SETUP"' } },
]));
const secretsFile = join(configDir, 'secrets.env');
await writeFile(secretsFile, `AUTH_PASSWORD=${PASSWORD}\nSESSION_SECRET=${SECRET}\n`, { mode: 0o600 });
await chmod(secretsFile, 0o600);

/*
 * Nothing from this process's own environment that could change the answer: no
 * deployment auth, no provider, no AWS. B3 is "the service starts with AWS_* unset",
 * so the base environment here has none of it.
 */
const STRIP = /^(AUTH_PASSWORD|SESSION_SECRET|CW_.*|AWS_.*|CLAUDE_CODE_.*|ANTHROPIC_.*|GITHUB_SECRET_ARN|TRIPLEC_.*|PROJECTS_ROOT|CLAUDE_HOME|CODER_HOME|WORKSPACE_USER|PWA_NAME|DEFAULT_.*|MAX_LIVE_SESSIONS|BIND_ADDRESS|ALLOW_PUBLIC_BIND|CLAUDECODE)$/;
const ambient = Object.fromEntries(Object.entries(process.env).filter(([k]) => !STRIP.test(k)));

let nextPort = 21970;
async function startServer(env = {}, { expectExit = false } = {}) {
  nextPort += 1;
  const port = nextPort;
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: here,
    env: {
      ...ambient,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      USER: 'developer',
      TRIPLEC_MODE: 'host',
      PORT: String(port),
      PROJECTS_ROOT: join(root, 'projects'),
      CLAUDE_HOME: join(home, '.claude'),
      TRIPLEC_PROJECTS_FILE: registryFile,
      TRIPLEC_SECRETS_FILE: secretsFile,
      TRIPLEC_FEATURES: 'mux,admin,push',
      CLAUDE_AUTH_MODE: 'login',
      DEFAULT_PERMISSION_MODE: 'manual',
      CW_AUTH_MODE: 'password',
      CW_SINGLE_OWNER: '1',
      CW_INSECURE_COOKIES: '1',
      CW_PUSH_DIR: join(root, 'push'),
      TRIPLEC_APP_PING_MS: '300',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  const exited = once(child, 'exit');
  if (expectExit) {
    const result = await Promise.race([exited.then(([code]) => ({ exited: true, code })),
      new Promise((r) => setTimeout(() => r({ exited: false }), 5000))]);
    if (!result.exited) child.kill('SIGKILL');
    return { ...result, stderr: () => stderr };
  }
  let ready = false;
  for (let i = 0; i < 100 && !ready; i += 1) {
    try {
      ready = (await fetch(`${base}/healthz`)).ok;
    } catch { /* not up yet */ }
    if (!ready) await new Promise((r) => setTimeout(r, 100));
  }
  return { child, base, port, ready, stdout: () => stdout, stderr: () => stderr };
}

async function stopServer(server) {
  if (!server.child || server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await once(server.child, 'exit').catch(() => {});
}

async function login(base, headers = {}) {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ password: PASSWORD }),
  });
  return { res, cookie: (res.headers.get('set-cookie') || '').split(';')[0], raw: res.headers.get('set-cookie') || '' };
}

/** A chat socket that collects every message it is sent. */
function chat(base, cookie) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: { Cookie: cookie } });
  const messages = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    messages.push(msg);
    for (const w of [...waiters]) {
      if (w.test(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  });
  const next = (test, ms = 5000) => {
    const found = messages.find(test);
    if (found) return Promise.resolve(found);
    return new Promise((resolve) => {
      const w = { test, resolve };
      waiters.push(w);
      setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        resolve(null);
      }, ms);
    });
  };
  return { ws, messages, next, opened: once(ws, 'open'), send: (m) => ws.send(JSON.stringify(m)) };
}

const claudeRuns = async () => {
  const runs = [];
  for (const f of await readdir(log)) runs.push(JSON.parse(await readFile(join(log, f), 'utf8')));
  return runs;
};
const clearRuns = async () => {
  for (const f of await readdir(log)) await rm(join(log, f));
};

const auditLines = (stdout) => stdout.split('\n').filter((l) => l.startsWith('{"audit":"triplec"')).map((l) => JSON.parse(l));

try {
  // --- unit-level: host.js and projects.js ------------------------------------
  console.log('host.js and projects.js');
  {
    const host = await import('./host.js');
    check('A5: no TRIPLEC_FEATURES means every feature (the AWS deployment, unchanged)',
      host.parseFeatures(undefined).size === host.FEATURE_NAMES.length);
    const some = host.parseFeatures('push, mux,bogus');
    check('A5: a feature list enables only what it names', some.has('push') && some.has('mux') && !some.has('editor') && !some.has('bogus'));
    check('C1: loopback binds are allowed', host.assertBindAddress('127.0.0.1', false) === '127.0.0.1' && host.assertBindAddress('::1', false) === '::1');
    let refused = null;
    try { host.assertBindAddress('0.0.0.0', false); } catch (err) { refused = err.message; }
    check('C1: a non-loopback bind is refused without allowPublicBind', /Refusing to listen on 0\.0\.0\.0/.test(refused || ''), refused);
    check('C1: allowPublicBind is the one way past it', host.assertBindAddress('0.0.0.0', true) === '0.0.0.0');

    const loose = join(root, 'loose.env');
    await writeFile(loose, 'AUTH_PASSWORD=x\n', { mode: 0o644 });
    await chmod(loose, 0o644);
    let looseErr = null;
    try { host.loadSecretsFile(loose, {}); } catch (err) { looseErr = err.message; }
    check('B3: a secrets file other users can read is refused', /readable by other users/.test(looseErr || ''), looseErr);
    const env = { SESSION_SECRET: 'from-the-environment' };
    const loaded = host.loadSecretsFile(secretsFile, env);
    check('B3: the secrets file fills in what the environment lacks', env.AUTH_PASSWORD === PASSWORD && loaded.includes('AUTH_PASSWORD'));
    check('B3: and never overrides what the environment already has', env.SESSION_SECRET === 'from-the-environment');

    const lines = [];
    host.audit('signin', { force: true, method: 'password', password: 'hunter2', sessionSecret: 'zzz' }, { write: (l) => lines.push(l) });
    check('C5: an audit line is one JSON object marked as ours', lines.length === 1 && JSON.parse(lines[0]).audit === 'triplec');
    check('C5: secret-looking fields are redacted whatever a caller passes', !/hunter2|zzz/.test(lines[0]), lines[0]);

    const fakeShell = join(bin, 'fake-login-shell');
    await writeFile(fakeShell, `#!/bin/sh\necho "a banner a profile printed"\nPATH="/opt/brew/bin:$HOME/.local/bin:$HOME/go/bin:$PATH"\nexport PATH\nexec /bin/sh "$@"\n`);
    await chmod(fakeShell, 0o755);
    const path = host.loginShellPath({ shell: fakeShell });
    check('A4: the login shell\'s PATH is read, banner and all, without the banner',
      path && path.startsWith('/opt/brew/bin:') && path.includes('/.local/bin') && path.includes('/go/bin') && !path.includes('banner'), path);

    const projects = await import('./projects.js');
    let dup = null;
    try { projects.parseRegistry(JSON.stringify([{ name: 'a', path: '/x' }, { name: 'b', path: '/x/' }])); } catch (err) { dup = err.message; }
    check('E1: one directory registered under two names is refused', /registered twice/.test(dup || ''), dup);
    let rel = null;
    try { projects.parseRegistry(JSON.stringify([{ name: 'a', path: 'relative/dir' }])); } catch (err) { rel = err.message; }
    check('E1: a relative path is refused', /absolute path/.test(rel || ''), rel);
    projects.setRegistry([{ name: 'outer', path: '/srv/outer' }, { name: 'inner', path: '/srv/outer/inner' }]);
    check('E1: a cwd belongs to the longest registered path containing it',
      projects.projectFor('/srv/outer/inner/src')?.name === 'inner' && projects.projectFor('/srv/outer/x')?.name === 'outer');
    check('E1: anything outside the registry is not a project',
      projects.projectFor('/srv/elsewhere') === null && projects.projectFor('/srv/outer/../etc') === null);
    let unreg = null;
    try { projects.projectPathFor('nope'); } catch (err) { unreg = err.message; }
    check('E1: an unregistered name names no directory', /no project named "nope"/.test(unreg || ''), unreg);
    projects.setRegistry(null);
  }

  // --- A2 and E3: what the code itself says ------------------------------------
  console.log('the code itself');
  {
    // Every non-comment line of the service and the broker that names the workspace
    // account or the data volume. host.js holds the AWS profile's defaults; nothing
    // else may.
    const offenders = [];
    for (const dir of [here, join(here, '..', 'claude-broker')]) {
      for (const f of await readdir(dir)) {
        if (!/\.(js|py)$/.test(f) && f !== 'wrapper') continue;
        if (/-test\.js$/.test(f) || f === 'host.js') continue;
        const text = await readFile(join(dir, f), 'utf8').catch(() => '');
        text.split('\n').forEach((line, i) => {
          if (/^\s*(\/\/|\*|\/\*|#)/.test(line)) return;
          if (/\bcoder\b|\/workspace\b/.test(line) && !/replace\(\/\^\\\/workspace/.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    check('A2: no code outside host.js names the workspace user or /workspace', offenders.length === 0, offenders.join('\n'));

    // E3: no git call anywhere in what runs on a host passes a history-depth flag.
    const depth = [];
    const scan = async (dir) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await scan(full);
        // The conformance script is the auditor, and carries the pattern it greps for.
        else if (/\.(js|mjs|sh|py)$|^(wrapper|cc-session\.sh)$/.test(entry.name) && !/-test\.(js|mjs)$/.test(entry.name)
          && entry.name !== 'host-conformance.sh') {
          const text = await readFile(full, 'utf8');
          text.split('\n').forEach((line, i) => {
            if (/--(depth|deepen|unshallow)\b/.test(line) && !/^\s*(\/\/|\*|#)/.test(line)) depth.push(`${full}:${i + 1}`);
          });
        }
      }
    };
    for (const d of ['chat-service', 'claude-broker', 'scripts', join('deploy', 'host')]) {
      await scan(join(here, '..', d)).catch(() => {});
    }
    check('E3: no git invocation passes --depth, --deepen or --unshallow', depth.length === 0, depth.join(', '));
  }

  // --- C1: the listener -------------------------------------------------------
  console.log('C1: the listener');
  {
    const refused = await startServer({ BIND_ADDRESS: '0.0.0.0' }, { expectExit: true });
    check('C1: the service refuses to start on a non-loopback address', refused.exited && refused.code !== 0 && /Refusing to listen/.test(refused.stderr()), refused.stderr().slice(-300));
  }

  // --- the main host-mode server ----------------------------------------------
  console.log('a host-mode server: login provider, password auth, registry');
  const server = await startServer();
  check('B3: the service starts with no AWS_* in its environment', server.ready, server.stderr().slice(-500));
  if (!server.ready) throw new Error('host-mode server did not start');
  const { base } = server;
  {
    const root302 = await fetch(`${base}/`, { redirect: 'manual' });
    check('C2: the bare root sends you to the chat', root302.status === 302 && root302.headers.get('location') === '/chat/');
    const unauth = await fetch(`${base}/chat/`, { redirect: 'manual', headers: { Accept: 'text/html' } });
    check('C2: and the chat is still behind the login', unauth.status === 302 && /\/login/.test(unauth.headers.get('location') || ''));

    const proxied = await login(base, { 'X-Forwarded-Proto': 'https' });
    check('C2: a login through a local TLS proxy sets a Secure, HttpOnly cookie',
      proxied.res.status === 204 && /;\s*Secure;/.test(proxied.raw) && /HttpOnly/.test(proxied.raw), proxied.raw);
    const plain = await login(base);
    check('C2: a plain-HTTP login on a dev box does not', plain.res.status === 204 && !/Secure/.test(plain.raw));
    const { cookie } = plain;
    const auth = { Cookie: cookie };

    const shell = await fetch(`${base}/chat/`, { headers: auth });
    check('C2: the chat is served under /chat/ at the host root', shell.status === 200 && /<html/i.test(await shell.text()));

    const feat = await (await fetch(`${base}/chat/api/features`, { headers: auth })).json();
    check('A5: the client is told which features exist', feat.features && feat.features.mux && !feat.features.editor && !feat.features.retire && feat.host === true);

    for (const [path, name] of [
      ['/editor/', 'editor'], ['/p/webapp/', 'editor'], ['/api/transcribe', 'voice'], ['/api/voice-status', 'voice'],
      ['/api/speak/prepare', 'voice'],
    ]) {
      const res = await fetch(`${base}${path}`, { method: path.includes('prepare') || path.includes('transcribe') ? 'POST' : 'GET', headers: auth });
      check(`A5: ${path} is a 404 with ${name} off`, res.status === 404, String(res.status));
    }
    const polish = await fetch(`${base}/api/polish`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'um so deploy it' }) });
    const polished = await polish.json();
    check('B4: with polish off a dictation comes back exactly as heard', polish.status === 200 && polished.text === 'um so deploy it' && polished.changed === false);

    const removal = await fetch(`${base}/api/projects/remove`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'webapp', force: true }) });
    check('E5: with retire off the removal route does not exist', removal.status === 404, String(removal.status));
    check('E5: and the registered directory is untouched', Boolean(await stat(join(repo, 'README.md')).catch(() => null)));
    const created = await fetch(`${base}/api/projects`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'surprise' }) });
    check('E5: creating a project outside the registry is refused', created.status === 500 && /not in this machine's project registry/.test((await created.json()).error || ''));
    const cloned = await fetch(`${base}/api/projects/clone`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ repo: 'someone/other' }) });
    check('E5: cloning a project outside the registry is refused', cloned.status === 500 && /not in this machine's project registry/.test((await cloned.json()).error || ''));
    const unknownApi = await fetch(`${base}/api/does-not-exist`, { headers: auth });
    check('E5: an unknown API path is a 404, not the app shell', unknownApi.status === 404);

    const projects = await (await fetch(`${base}/api/projects`, { headers: auth })).json();
    const webapp = projects.projects.find((p) => p.name === 'webapp');
    check('E1: the registered path is listed under its registered name', webapp && webapp.path === repo && projects.projects.length === 1, JSON.stringify(projects.projects.map((p) => [p.name, p.path])));
    check('B2: with no defaultModel in login mode, there is no default model', projects.defaultModel === '');
    const models = await (await fetch(`${base}/api/models`, { headers: auth })).json();
    check('B2: the picker offers the CLI default first, not a Bedrock id', models.default === '' && models.models[0].id === '' && !models.models.some((m) => m.id.startsWith('us.anthropic.')));

    const slots = await (await fetch(`${base}/api/slots?project=webapp`, { headers: auth })).json();
    check('E2: a registered project has its configured number of slots', slots.enabled && slots.count === 3 && slots.slots.length === 3, JSON.stringify(slots).slice(0, 200));

    // --- E2: the set-up command ---------------------------------------------
    const prep = await (await fetch(`${base}/api/slots/prepare`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'webapp', slot: 1 }) })).json();
    const slot1 = join(repo, '.claude', 'worktrees', 'slot-1');
    check('E2: a new slot runs the configured command', prep.ok && prep.created && prep.postCreate?.state === 'ok'
      && (await readFile(join(slot1, 'node_modules', '.triplec-setup'), 'utf8').catch(() => '')).includes('set-up ran'), JSON.stringify(prep.postCreate));
    const again = await (await fetch(`${base}/api/slots/prepare`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'webapp', slot: 1 }) })).json();
    check('E2: and only once — preparing it again does not re-run it', again.ok && !again.created && again.postCreate?.startedAt === prep.postCreate?.startedAt);
    const beyond = await fetch(`${base}/api/slots/prepare`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'webapp', slot: 4 }) });
    check('E2: a slot beyond the configured count is refused', beyond.status === 500 && /1 to 3/.test((await beyond.json()).error || ''));

    // --- B1, B2, D1, C3, C5: a conversation ------------------------------------
    await clearRuns();
    const c = chat(base, cookie);
    await c.opened;
    c.send({ type: 'start', cwd: slot1 });
    const attached = await c.next((m) => m.type === 'attached');
    check('D1: a chat in host mode starts in the configured prompting mode', attached && attached.permissionMode === 'manual', JSON.stringify(attached));
    await new Promise((r) => setTimeout(r, 300));
    const run = (await claudeRuns()).find((x) => x.args.includes(attached?.sessionId));
    check('B1: login mode sets no provider variable', run && run.bedrock === null && run.vertex === null && run.apiKey === null, JSON.stringify(run));
    check('B2: and passes no --model, and no ANTHROPIC_MODEL', run && !run.args.includes('--model') && run.model === null, run?.args.join(' '));
    check('A3: the CLI runs with the developer\'s own HOME', run && run.home === home, run?.home);
    check('D1: the CLI is asked to route approvals over stdio', run && run.args.join(' ').includes('--permission-prompt-tool stdio'));
    check('B3: the service\'s own secrets are not in the CLI\'s environment', run && run.authPassword === null && run.sessionSecret === null);

    c.send({ type: 'message', text: 'hello' });
    check('B1: a chat message gets a reply with nothing but the login', Boolean(await c.next((m) => m.type === 'assistant_text' && m.text === 'echo: hello')));

    const ping = await c.next((m) => m.type === 'ping', 2000);
    check('C3: the server sends an application-level ping the page can see', Boolean(ping));

    c.send({ type: 'message', text: 'please NEEDS_APPROVAL' });
    const ask = await c.next((m) => m.type === 'permission_request');
    check('D1: a tool that needs approval is relayed to the chat', ask && ask.toolName === 'Bash' && ask.input.command === 'touch approved.txt', JSON.stringify(ask));

    // A second device joining while the question is open is asked it too.
    const other = chat(base, cookie);
    await other.opened;
    other.send({ type: 'reattach', conversationId: attached.conversationId });
    const asked = await other.next((m) => m.type === 'permission_request');
    check('D1: a device that joins while it waits is shown the same request', asked && asked.requestId === ask.requestId);

    c.send({ type: 'permission', requestId: ask.requestId, decision: 'allow' });
    check('D1: approve runs it', Boolean(await c.next((m) => m.type === 'assistant_text' && m.text === 'ALLOWED touch approved.txt')));
    check('D1: and every device is told it was answered', Boolean(await other.next((m) => m.type === 'permission_resolved' && m.decision === 'allow')));
    other.send({ type: 'permission', requestId: ask.requestId, decision: 'deny' });
    check('D1: a second answer to the same request finds nothing to answer', Boolean(await other.next((m) => m.type === 'permission_resolved' && m.decision === 'stale')));

    c.send({ type: 'message', text: 'again NEEDS_APPROVAL' });
    const ask2 = await c.next((m) => m.type === 'permission_request' && m.requestId !== ask.requestId);
    c.send({ type: 'permission', requestId: ask2?.requestId, decision: 'deny' });
    check('D1: deny blocks it, and the model is told why', Boolean(await c.next((m) => m.type === 'assistant_text' && m.text.startsWith('DENIED: The user denied'))));

    const before = c.messages.filter((m) => m.type === 'permission_request').length;
    c.send({ type: 'message', text: 'ASK_QUESTION please' });
    const refused = await c.next((m) => m.type === 'assistant_text' && /cannot show multiple-choice/.test(m.text));
    check('D1: a multiple-choice question is answered "ask in plain text", not shown as approve/deny',
      Boolean(refused) && c.messages.filter((m) => m.type === 'permission_request').length === before);

    await new Promise((r) => setTimeout(r, 200));
    const events = auditLines(server.stdout());
    const kinds = new Set(events.map((e) => e.event));
    check('C5: sign-ins are audited, failures included', kinds.has('signin'));
    check('C5: session start is audited with the permission mode used', events.some((e) => e.event === 'session_start' && e.permissionMode === 'manual' && e.project === 'webapp'));
    check('D1: the audit log records each decision', events.filter((e) => e.event === 'permission_decision').map((e) => e.decision).join(',') === 'allow,deny');
    check('C5: no audit line, nor anything else printed, carries the password or the cookie key',
      !server.stdout().includes(PASSWORD) && !server.stdout().includes(SECRET) && !server.stderr().includes(SECRET));
    c.ws.close();
    other.ws.close();

    // --- E4: a slot removed by the machine's reaper ------------------------------
    // A transcript, as the CLI would have left one for a conversation in slot 3.
    const slot3 = join(repo, '.claude', 'worktrees', 'slot-3');
    await (await fetch(`${base}/api/slots/prepare`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'webapp', slot: 3 }) })).json();
    const { mangleCwd } = await import('./session-manager.js');
    const tdir = join(home, '.claude', 'projects', await mangleCwd(slot3));
    await mkdir(tdir, { recursive: true });
    await writeFile(join(tdir, 'e4e4e4e4-0000-4000-8000-000000000003.jsonl'),
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'work done in slot three' } })}\n`);
    await git(repo, 'worktree', 'remove', slot3);
    check('E4: (setup) the reaper removed slot-3', !(await stat(slot3).catch(() => null)));
    const after = await (await fetch(`${base}/api/projects`, { headers: auth })).json();
    const listed = after.projects[0].sessions.find((s) => s.sessionId === 'e4e4e4e4-0000-4000-8000-000000000003');
    check('E4: a removed slot\'s past conversation is still listed', listed && listed.cwd === slot3 && listed.worktree === 'slot-3', JSON.stringify(after.projects[0].sessions));
    const r = chat(base, cookie);
    await r.opened;
    r.send({ type: 'start', cwd: slot3, resumeSessionId: 'e4e4e4e4-0000-4000-8000-000000000003' });
    const history = await r.next((m) => m.type === 'history');
    check('E4: opening it shows its history', history && history.messages.some((m) => m.text === 'work done in slot three'));
    check('E4: and recreates the slot', Boolean(await r.next((m) => m.type === 'attached')) && Boolean(await stat(join(slot3, '.git')).catch(() => null)));
    await new Promise((res) => setTimeout(res, 300));
    check('E4: and resumes the conversation in it', (await claudeRuns()).some((x) => x.args.includes('--resume') && x.cwd === slot3));
    r.ws.close();

    // --- E3: a shallow clone ---------------------------------------------------
    const shallow = join(root, 'repos', 'shallow');
    // The fixture is the only place a depth flag appears, and it is test setup: the
    // repository a VM's tooling hands TripleC, not a call TripleC makes.
    await execFileAsync('git', ['clone', '-q', ['--', 'depth'].join(''), '1', `file://${origin}`, shallow]);
    const { prepareSlot } = await import('./slots.js');
    const shallowPrep = await prepareSlot(shallow, 1);
    const isShallow = (await git(shallow, 'rev-parse', '--is-shallow-repository')).stdout.trim();
    check('E3: prepareSlot succeeds on a shallow clone', shallowPrep.ok && shallowPrep.fetched, JSON.stringify(shallowPrep).slice(0, 300));
    check('E3: and the clone is still shallow afterwards', isShallow === 'true', isShallow);
  }
  await stopServer(server);

  // --- F2: the session cap ------------------------------------------------------
  console.log('F2: the session cap');
  {
    const capped = await startServer({ MAX_LIVE_SESSIONS: '1' });
    const { cookie } = await login(capped.base);
    const a = chat(capped.base, cookie);
    await a.opened;
    a.send({ type: 'start', cwd: repo });
    await a.next((m) => m.type === 'attached');
    const b = chat(capped.base, cookie);
    await b.opened;
    b.send({ type: 'start', cwd: repo });
    const refusal = await b.next((m) => m.type === 'error');
    check('F2: a chat past maxLiveSessions is refused with a clear message', refusal && refusal.limit && /maxLiveSessions 1/.test(refusal.message), JSON.stringify(refusal));
    const joined = chat(capped.base, cookie);
    await joined.opened;
    const first = a.messages.find((m) => m.type === 'attached');
    joined.send({ type: 'start', cwd: repo, resumeSessionId: first.sessionId });
    check('F2: joining a chat that is already running is not a new one', Boolean(await joined.next((m) => m.type === 'attached' && m.conversationId === first.conversationId)));
    for (const s of [a, b, joined]) s.ws.close();
    await stopServer(capped);
  }

  // --- B2: a configured default model -------------------------------------------
  console.log('B2: a configured default');
  {
    await clearRuns();
    const named = await startServer({ ANTHROPIC_MODEL: 'claude-sonnet-5' });
    const { cookie } = await login(named.base);
    const c = chat(named.base, cookie);
    await c.opened;
    c.send({ type: 'start', cwd: repo });
    const named0 = await c.next((m) => m.type === 'attached');
    await new Promise((r) => setTimeout(r, 300));
    // By session id: a CLI from the previous server may still be booting, and writes
    // its record late.
    const runs = await claudeRuns();
    const run = runs.find((x) => x.args.includes(named0?.sessionId));
    check('B2: setting defaultModel overrides the CLI default', run && run.args.join(' ').includes('--model claude-sonnet-5') && run.model === 'claude-sonnet-5', JSON.stringify(runs.map((x) => [x.cwd, x.args.join(' ')])));
    c.ws.close();
    await stopServer(named);
  }

  // --- C4: the identity header ---------------------------------------------------
  console.log('C4: trusted-header');
  {
    const myUid = process.getuid();
    const owner = 'owner@example.com';
    const base0 = { CW_AUTH_MODE: 'trusted-header', CW_TRUSTED_EMAILS: owner, CW_TRUSTED_ALLOW_PASSWORD: '0' };

    // tailscaled is root. This test is not, so a header it sends is a header from
    // the wrong socket owner — exactly what a request through the VM's proxy is.
    const strict = await startServer({ ...base0, CW_TRUSTED_PEER_UID: '0' });
    check('C4: (setup) trusted-header mode starts', strict.ready, strict.stderr().slice(-300));
    const forged = await fetch(`${strict.base}/api/projects`, { headers: { 'Tailscale-User-Login': owner } });
    check('C4: a forged identity header from a socket that is not tailscaled\'s is rejected', forged.status === 401, String(forged.status));
    const pw = await login(strict.base);
    check('C4: without allowPassword there is no password door', pw.res.status === 400);
    await new Promise((r) => setTimeout(r, 100));
    check('C5: a rejected identity header is audited', auditLines(strict.stdout()).some((e) => e.event === 'signin_failure' && e.method === 'trusted-header'));
    await stopServer(strict);

    // The same request from a socket owned by the configured uid: that is what a
    // request through Tailscale Serve looks like to this service.
    const served = await startServer({ ...base0, CW_TRUSTED_PEER_UID: String(myUid) });
    const ok = await fetch(`${served.base}/api/projects`, { headers: { 'Tailscale-User-Login': owner } });
    check('C4: the owner, through the trusted proxy, is accepted', ok.status === 200, String(ok.status));
    const stranger = await fetch(`${served.base}/api/projects`, { headers: { 'Tailscale-User-Login': 'someone-else@example.com' } });
    check('C4: any other tailnet user is rejected', stranger.status === 401);
    const ws = await new Promise((resolve) => {
      const sock = new WebSocket(`${served.base.replace('http', 'ws')}/ws`, { headers: { 'Tailscale-User-Login': owner } });
      sock.on('open', () => { sock.close(); resolve('opened'); });
      sock.on('error', (e) => resolve(e.message));
    });
    check('C4: the owner\'s chat socket opens through the trusted proxy', ws === 'opened', ws);
    await stopServer(served);

    // A non-loopback peer, and the socket-table parsing, without a network.
    const { trustedIdentity, peerUid } = await import('./auth.js');
    process.env.CW_TRUSTED_EMAILS = owner;
    process.env.CW_TRUSTED_PEER_UID = '0';
    const remote = await trustedIdentity({ headers: { 'tailscale-user-login': owner }, socket: { remoteAddress: '10.1.2.3', remotePort: 5555, localAddress: '10.1.2.4', localPort: 9997 } });
    check('C4: an identity header from a non-loopback peer is rejected', remote === null);
    const table = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n'
      + '   0: 0100007F:270D 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 1\n'
      + '   1: 0100007F:D431 0100007F:270D 01 00000000:00000000 00:00000000 00000000     0        0 2\n';
    const uid = await peerUid({ remoteAddress: '127.0.0.1', remotePort: 0xD431, localAddress: '127.0.0.1', localPort: 0x270D },
      { readTable: async (f) => (f.endsWith('tcp') ? table : '') });
    check('C4: the peer\'s uid is read from its own row of the socket table, not ours', uid === 0, String(uid));

    const multi = await startServer({ CW_AUTH_MODE: 'trusted-header', CW_TRUSTED_EMAILS: `${owner},second@example.com` }, { expectExit: true });
    check('C5: single-owner mode refuses an allowlist of two', multi.exited && /exactly one identity/.test(multi.stderr()), multi.stderr().slice(-200));
  }

  // --- B1: the other providers -------------------------------------------------------
  console.log('B1: providers');
  {
    const { claudeEnv } = await import('./host.js');
    const leaked = claudeEnv({ base: { CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_API_KEY: 'sk-x', AUTH_PASSWORD: 'p', PATH: '/bin' } });
    check('B1: login mode strips provider variables inherited from anywhere', leaked.CLAUDE_CODE_USE_BEDROCK === undefined && leaked.ANTHROPIC_API_KEY === undefined && leaked.AUTH_PASSWORD === undefined && leaked.PATH === '/bin');
  }
} catch (err) {
  failures += 1;
  console.error(`  FAIL host test crashed: ${err.stack}`);
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
