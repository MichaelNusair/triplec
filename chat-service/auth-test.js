/**
 * Authentication tests, run by deploy.sh before anything ships.
 *
 * These exist because the bug they guard against already happened once: the
 * chat API was reachable without credentials while every comment and doc in the
 * repo said it was gated. A unit test of `verifyPassword` would not have caught
 * that — the hole was in the wiring, not the crypto — so these tests boot the
 * real server and speak HTTP and WebSocket to it.
 *
 * Run: node auth-test.js
 */
import { spawn } from 'child_process';
import { once } from 'events';
import { WebSocket } from 'ws';
import { oidcIdentityAllowed } from './auth.js';

const PASSWORD = 'test-password-32-chars-long-enough';
const SECRET = 'a-long-enough-session-secret-value';

// Each server instance gets a fresh port. Reusing one port across instances lets
// a leftover process from an earlier run answer these tests instead — which
// showed a green "unauthenticated access denied" while the server under test had
// never started. A test that passes against the wrong process is worse than no
// test at all here.
let nextPort = 19970;
let PORT = nextPort;
let BASE = `http://127.0.0.1:${PORT}`;

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

/** Boot the real server as a child process, with auth configured. */
async function startServer(env) {
  nextPort += 1;
  PORT = nextPort;
  BASE = `http://127.0.0.1:${PORT}`;

  const child = spawn(process.execPath, ['server.js'], {
    cwd: import.meta.dirname,
    env: {
      ...process.env,
      PORT: String(PORT),
      // Cookies would otherwise be Secure-only and never sent over plain HTTP.
      CW_INSECURE_COOKIES: '1',
      PROJECTS_ROOT: '/tmp/triplec-test-projects',
      // So a test run cannot touch the real VAPID keypair or device list. Nothing
      // here should reach them — every push route is checked unauthenticated — but
      // "should" is what the hole this file exists for was made of.
      CW_PUSH_DIR: '/tmp/triplec-test-push',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  // Wait for the listener, or for the process to die reporting why.
  const ready = await Promise.race([
    (async () => {
      for (let i = 0; i < 100; i += 1) {
        try {
          const res = await fetch(`${BASE}/healthz`);
          if (res.ok) return true;
        } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    })(),
    once(child, 'exit').then(() => false),
  ]);

  return { child, ready, stderr: () => stderr };
}

/**
 * Resolve with how a WebSocket attempt ended. `once(ws, 'error')` *rejects*
 * rather than resolving, so it cannot be used here — a rejected upgrade is the
 * expected result in half of these tests, not a test failure.
 */
function wsOutcome(url, options) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, options);
    const finish = (outcome) => {
      clearTimeout(timer);
      try { ws.terminate(); } catch { /* already closed */ }
      resolve(outcome);
    };
    const timer = setTimeout(() => finish('timeout'), 4000);
    ws.on('open', () => finish('opened'));
    ws.on('error', (err) => finish(`rejected: ${err.message}`));
  });
}

function stop(child) {
  // A server that refused to start has already exited, and awaiting a second
  // 'exit' from it would hang the test run forever.
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  child.kill('SIGKILL');
  return once(child, 'exit').catch(() => {});
}

// --- 1. Fail-closed configuration -------------------------------------------
console.log('\nRefuses to start when misconfigured:');
{
  // No password at all: the exact state a self-hoster lands in by forgetting a
  // step. Starting up here would publish a shell to the internet.
  const { child, ready, stderr } = await startServer({ AUTH_PASSWORD: '', SESSION_SECRET: '' });
  check('no AUTH_PASSWORD → server does not serve', !ready);
  check('explains why it refused', /AUTH_PASSWORD is not set/.test(stderr()), stderr().slice(0, 200));
  await stop(child);
}
{
  const { child, ready } = await startServer({
    AUTH_PASSWORD: 'short',
    SESSION_SECRET: SECRET,
  });
  check('too-short password → server does not serve', !ready);
  await stop(child);
}
{
  const { child, ready } = await startServer({
    AUTH_PASSWORD: PASSWORD,
    SESSION_SECRET: 'tiny',
  });
  check('weak SESSION_SECRET → server does not serve', !ready);
  await stop(child);
}

// --- 2. The gate, with a correctly configured server ------------------------
const { child, ready, stderr } = await startServer({
  AUTH_PASSWORD: PASSWORD,
  SESSION_SECRET: SECRET,
});
if (!ready) {
  console.error('server failed to start:\n', stderr());
  process.exit(1);
}

console.log('\nRejects unauthenticated access:');
// Every route that can reach the Claude process or the filesystem.
const guarded = [
  ['GET', '/api/projects'],
  ['POST', '/api/projects'],
  // Reads and writes the project tree: status inspects a repository, remove
  // deletes a directory, clone runs git against the network.
  ['GET', '/api/project-status?name=demo'],
  ['POST', '/api/projects/remove'],
  ['POST', '/api/projects/clone'],
  ['GET', '/api/github/repos'],
  // A manifest per project, for giving one its own home-screen icon. It answers
  // 200 for a project that exists and 404 for one that does not, so unauthenticated
  // it would enumerate the project tree by guessing names.
  ['GET', '/manifest.webmanifest?project=demo'],
  // Push. A subscription endpoint is a capability to write on someone's lock
  // screen, and the list of them is an inventory of the operator's devices — so
  // subscribing, unsubscribing and sending are all gated, and so is the key that
  // makes a subscription possible in the first place.
  ['GET', '/api/push/key'],
  ['POST', '/api/push/subscribe'],
  ['POST', '/api/push/unsubscribe'],
  ['POST', '/api/push/test'],
  // Whether this box has a given endpoint. It answers yes/no and a count, never the
  // list — but an open one is an oracle for "is this device subscribed" and a count of
  // how many of the operator's devices exist, which is the inventory the note above is
  // about.
  ['POST', '/api/push/status'],
  // The receipt a service worker posts when it has shown a notification. It only
  // writes a log line, but an open one is a stranger writing into this box's log
  // with a tag of their choosing, and a way to learn whether anyone is subscribed.
  ['POST', '/api/push/received'],
  ['GET', '/api/transcript?cwd=/tmp&sessionId=x'],
  // Reads the tail of a transcript and asks claude-broker what it is running, so
  // an unauthenticated hit would be both a read of private conversations and an
  // inventory of every live one.
  ['GET', '/api/claude-status?cwd=/tmp'],
  // Hands back the opening prompt of a conversation verbatim, which is a read of
  // someone's private transcript however short the answer is.
  ['GET', '/api/first-prompt?cwd=/tmp&sessionId=x'],
  ['GET', '/api/models'],
  ['GET', '/api/voice-status'],
  ['POST', '/api/transcribe'],
  // Spends Bedrock tokens on caller-supplied text, so it is a paid endpoint as
  // well as a private one.
  ['POST', '/api/polish'],
  // Read aloud. `prepare` takes a message and hands back an id; `/api/speak`
  // turns an id into audio, which is Polly at $30 per million characters. So the
  // pair is a paid endpoint *and* a way to read a private conversation back — and
  // the id alone, being a hash of text nobody else has, is not a credential.
  ['POST', '/api/speak/prepare'],
  ['GET', '/api/speak?id=0123456789abcdef&segment=0'],
  // 44 bytes of silence, and no secret in it — but gated with the rest of the
  // feature rather than opened. It reveals that this is a TripleC box, the
  // allowlist is the thing this file exists to keep short, and the only caller is
  // a page that is already signed in.
  ['GET', '/api/speak/silence'],
  ['POST', '/api/client-error'],
  // Says whether a project could be installed on the device that tried. Nothing
  // secret in a report, but an open one would let a stranger write lines into this
  // box's journal, which is where the answer to "why will it not install" is read.
  ['POST', '/api/install-report'],
  // The operations surface. `/admin` is the reason this list matters most: it
  // enumerates every process on the box and can signal three of them, so an
  // unauthenticated hit here would be a remote inventory *and* a remote kill.
  ['GET', '/admin'],
  ['GET', '/admin.html'],
  ['GET', '/admin.js'],
  ['GET', '/api/admin/overview'],
  ['POST', '/api/admin/kill'],
  ['POST', '/api/admin/reap'],
  ['GET', '/api/live'],
  // Which build is running. Not a secret worth widening the allowlist for — it
  // names a commit of a private repository, and the only caller is a signed-in
  // page — but an unauthenticated one would tell a stranger which version of this
  // app to look up known problems in.
  ['GET', '/api/version'],
  ['GET', '/app.js'],
  ['GET', '/'],
];
for (const [method, path] of guarded) {
  const res = await fetch(`${BASE}${path}`, { method, redirect: 'manual' });
  // 401 for API callers, 302 to /login for a browser navigation.
  check(
    `${method} ${path} → denied`,
    res.status === 401 || res.status === 302,
    `got ${res.status}`,
  );
}

console.log('\nOpen paths stay open:');
{
  const health = await fetch(`${BASE}/healthz`);
  check('GET /healthz → 200', health.status === 200, `got ${health.status}`);
  const login = await fetch(`${BASE}/login`);
  check('GET /login → 200', login.status === 200, `got ${login.status}`);
  const body = await login.text();
  check('login page does not leak the password', !body.includes(PASSWORD));
}

console.log('\nWebSocket upgrade requires a session:');
{
  const outcome = await wsOutcome(`ws://127.0.0.1:${PORT}/ws`);
  // Specifically a 401: the socket must be refused at the handshake, before any
  // frame can ask for a `claude` process.
  check('unauthenticated /ws → rejected with 401', outcome.includes('401'), `got ${outcome}`);
}

console.log('\nLogin:');
let cookie = null;
{
  const bad = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'wrong' }),
  });
  check('wrong password → 401', bad.status === 401, `got ${bad.status}`);
  check('wrong password sets no cookie', !bad.headers.get('set-cookie'));

  const good = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  check('correct password → 204', good.status === 204, `got ${good.status}`);
  const setCookie = good.headers.get('set-cookie') || '';
  check('cookie is HttpOnly', /HttpOnly/i.test(setCookie), setCookie);
  check('cookie is SameSite', /SameSite=Lax/i.test(setCookie), setCookie);
  cookie = setCookie.split(';')[0];
}

console.log('\nWith a valid session:');
{
  const res = await fetch(`${BASE}/api/models`, { headers: { Cookie: cookie } });
  check('GET /api/models → 200', res.status === 200, `got ${res.status}`);

  const check2 = await fetch(`${BASE}/api/auth-check`, { headers: { Cookie: cookie } });
  check('GET /api/auth-check → 204', check2.status === 204, `got ${check2.status}`);

  const outcome = await wsOutcome(`ws://127.0.0.1:${PORT}/ws`, {
    headers: { Cookie: cookie },
  });
  check('authenticated /ws → opens', outcome === 'opened', `got ${outcome}`);
}

console.log('\nSends a browser to the login page, preserving where it was going:');
{
  const res = await fetch(`${BASE}/api/projects`, {
    headers: { Accept: 'text/html' },
    redirect: 'manual',
  });
  const location = res.headers.get('location') || '';
  check('HTML request → 302', res.status === 302, `got ${res.status}`);
  check('redirects to /login with ?next=', location.startsWith('/login?next='), location);
  // An absolute URL here would be an open redirect primitive on a login page.
  check(
    'next= is a relative path, not an absolute URL',
    !/next=https?(%3A|:)/i.test(location),
    location,
  );
}

console.log('\nRefuses to turn client input into arbitrary file paths:');
{
  // Authenticated, so not a privilege boundary — a logged-in user already has a
  // shell. Checked anyway: client-supplied values should never reach a path join
  // unvalidated, whoever is asking.
  const traversal = await fetch(
    `${BASE}/api/transcript?cwd=/tmp&sessionId=${encodeURIComponent('../../../../etc/passwd')}`,
    { headers: { Cookie: cookie } },
  );
  const body = await traversal.text();
  check(
    'traversal in sessionId is rejected',
    traversal.status >= 400 && !body.includes('root:'),
    `status ${traversal.status}`,
  );

  const escape = await fetch(`${BASE}/../server.js`, { headers: { Cookie: cookie } });
  const escaped = await escape.text();
  check(
    'traversal in a static path does not serve server source',
    !escaped.includes('WebSocketServer'),
    `status ${escape.status}`,
  );
}

console.log('\nRejects forged and tampered cookies:');
{
  const forged = [
    'cw_session=nonsense',
    'cw_session=9999999999.abc.deadbeef',
    // Valid structure, signature from a different key.
    `${cookie}x`,
    // Expired but otherwise well-formed.
    'cw_session=1.abc.' + 'A'.repeat(43),
  ];
  for (const c of forged) {
    const res = await fetch(`${BASE}/api/models`, { headers: { Cookie: c } });
    check(`forged cookie rejected (${c.slice(0, 28)}…)`, res.status === 401, `got ${res.status}`);
  }
}

console.log('\nThrottles guessing:');
{
  let sawLockout = false;
  for (let i = 0; i < 20; i += 1) {
    let res;
    try {
      res = await fetch(`${BASE}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: `guess-${i}` }),
      });
    } catch {
      // Keep-alive socket recycled under a rapid burst. Not a result either way.
      continue;
    }
    if (res.status === 429) { sawLockout = true; break; }
  }
  check('repeated wrong passwords → 429 lockout', sawLockout);

  // The lockout must not be a denial-of-service against the real operator's
  // password once it expires, so confirm it is time-based rather than permanent.
  const status = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  }).then((r) => r.status);
  check('lockout applies even to the correct password', status === 429, `got ${status}`);
}

await stop(child);

// --- 3. oidc mode -----------------------------------------------------------
// The mode with the trap in it. An ALB `authenticate-oidc` action AUTHENTICATES
// — it proves the caller holds an account with the provider — and then forwards
// the request. It does not AUTHORIZE. Point it at Google with no further check
// and "logged in" means every Google account in existence, on a box that hands
// out a shell. So the checks below are about one thing: that the deployment
// knows which identities are its own, and refuses to run when it does not.

const OIDC_ENV = {
  CW_AUTH_MODE: 'oidc',
  CW_OIDC_EXPECTED_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
  CW_REGION: 'us-east-1',
  // Deliberately still set. In oidc mode these must be *ignored*, not required:
  // a password door alongside the provider would be a second, weaker way in.
  AUTH_PASSWORD: PASSWORD,
  SESSION_SECRET: SECRET,
};

console.log('\noidc mode refuses to start without knowing who is allowed in:');
{
  // The whole point. Nothing else in this file would catch it: the server starts
  // fine, the ALB authenticates fine, and the box is open to the internet.
  const { child: c, ready, stderr: err } = await startServer({
    ...OIDC_ENV,
    CW_OIDC_ALLOWED_EMAILS: '',
    CW_OIDC_ALLOWED_DOMAIN: '',
  });
  check('oidc with no allowlist → server does not serve', !ready);
  check(
    'explains that the provider alone authorises nobody',
    /CW_OIDC_ALLOWED_EMAILS/.test(err()),
    err().slice(0, 300),
  );
  await stop(c);
}
{
  const { child: c, ready } = await startServer({
    ...OIDC_ENV,
    CW_OIDC_EXPECTED_CLIENT_ID: '',
    CW_OIDC_ALLOWED_EMAILS: 'you@example.com',
  });
  check('oidc with no expected client id → server does not serve', !ready);
  await stop(c);
}

console.log('\noidc mode with an allowlist serves, and still gates every route:');
{
  const { child: c, ready, stderr: err } = await startServer({
    ...OIDC_ENV,
    CW_OIDC_ALLOWED_EMAILS: 'you@example.com',
  });
  check('oidc with an allowlist → server starts', ready, err().slice(0, 300));

  if (ready) {
    const mode = await fetch(`${BASE}/api/auth-mode`).then((r) => r.json());
    check('reports mode oidc', mode.mode === 'oidc', JSON.stringify(mode));

    // No ALB in front of these, so no header: exactly what a caller reaching the
    // instance directly looks like. "Only the load balancer can reach the box" is
    // a security group rule, i.e. one console click from being false.
    for (const path of ['/api/models', '/api/projects', '/admin', '/']) {
      const res = await fetch(`${BASE}${path}`, { redirect: 'manual' });
      check(
        `oidc: no x-amzn-oidc-data on ${path} → denied`,
        res.status === 401 || res.status === 302,
        `got ${res.status}`,
      );
    }

    const ws = await wsOutcome(`ws://127.0.0.1:${PORT}/ws`);
    check('oidc: unauthenticated /ws → rejected with 401', ws.includes('401'), `got ${ws}`);

    // A local password must not be a second door past the provider.
    const login = await fetch(`${BASE}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    check('oidc: password login is refused', login.status === 400, `got ${login.status}`);
    check('oidc: password login sets no cookie', !login.headers.get('set-cookie'));

    // Forged headers. The first two are rejected on the header alone; the last is
    // structurally a real ES256 token with an allowlisted email in it, and is
    // refused because the signature cannot be verified against an ALB key. That
    // is the property that matters — the claims are an attacker's to write, so
    // nothing may be read from them before the signature is checked.
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const claims = { email: 'you@example.com', email_verified: true };
    const forged = [
      ['unsigned (alg none)', `${b64({ alg: 'none', kid: 'k' })}.${b64(claims)}.`],
      ['symmetric alg', `${b64({ alg: 'HS256', kid: 'k' })}.${b64(claims)}.c2ln`],
      ['not three segments', b64({ alg: 'ES256', kid: 'k' })],
      ['null payload', `${b64({ alg: 'ES256', kid: 'k' })}.${Buffer.from('null').toString('base64url')}.c2ln`],
      ['ES256 with an invented signature', `${b64({ alg: 'ES256', kid: 'k' })}.${b64(claims)}.${'A'.repeat(86)}`],
    ];
    for (const [name, token] of forged) {
      const res = await fetch(`${BASE}/api/models`, {
        headers: { 'x-amzn-oidc-data': token },
      });
      check(`oidc: forged token rejected — ${name}`, res.status === 401, `got ${res.status}`);
    }
  }
  await stop(c);
}

// --- 4. The authorization decision itself -----------------------------------
// Unit-level, because it is the one part of oidc mode a test can cover
// exhaustively without an ALB: no network, no signing key, every variant. It is
// also the line that separates "has a Google account" from "has a shell here".
console.log('\nThe identity allowlist:');
{
  const warn = console.warn;
  // The function logs every rejection, which is right in production and noise
  // here — most of these cases are *meant* to be rejected.
  console.warn = () => {};

  const withEnv = (env, fn) => {
    const before = {
      CW_OIDC_ALLOWED_EMAILS: process.env.CW_OIDC_ALLOWED_EMAILS,
      CW_OIDC_ALLOWED_DOMAIN: process.env.CW_OIDC_ALLOWED_DOMAIN,
    };
    Object.assign(process.env, {
      CW_OIDC_ALLOWED_EMAILS: env.emails ?? '',
      CW_OIDC_ALLOWED_DOMAIN: env.domain ?? '',
    });
    try {
      return fn();
    } finally {
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  const verified = (email) => ({ email, email_verified: true });

  withEnv({ emails: 'you@example.com' }, () => {
    check('allowlisted address is allowed', oidcIdentityAllowed(verified('you@example.com')));
    // Providers are inconsistent about case, and getting this wrong locks the
    // operator out of their own box.
    check('match is case-insensitive', oidcIdentityAllowed(verified('You@Example.COM')));
    check('surrounding whitespace is ignored', oidcIdentityAllowed(verified('  you@example.com ')));
    check('a different address is refused', !oidcIdentityAllowed(verified('someone@example.com')));
    check('a different provider is refused', !oidcIdentityAllowed(verified('you@gmail.com')));
    // The attack that makes the allowlist worthless if it is a substring test.
    check(
      'an address merely containing the allowed one is refused',
      !oidcIdentityAllowed(verified('you@example.com.evil.test')),
    );
    check(
      'an address with the allowed one as a prefix is refused',
      !oidcIdentityAllowed(verified('you@example.como')),
    );
    // An unverified email is a string the user typed at signup with some
    // providers, so honouring it would make the list a formality.
    check(
      'unverified email is refused',
      !oidcIdentityAllowed({ email: 'you@example.com', email_verified: false }),
    );
    check(
      'missing email_verified is refused',
      !oidcIdentityAllowed({ email: 'you@example.com' }),
    );
    // The ALB re-serialises provider claims and does not promise to keep the
    // type, so the string form has to work or a real login fails.
    check(
      'email_verified as the string "true" is accepted',
      oidcIdentityAllowed({ email: 'you@example.com', email_verified: 'true' }),
    );
    check('no email claim at all is refused', !oidcIdentityAllowed({ email_verified: true }));
    check('non-string email is refused', !oidcIdentityAllowed({ email: 1, email_verified: true }));
    check('null claims are refused', !oidcIdentityAllowed(null));
  });

  withEnv({ emails: 'a@example.com, b@example.com ,,' }, () => {
    check('multiple addresses: first', oidcIdentityAllowed(verified('a@example.com')));
    check('multiple addresses: second', oidcIdentityAllowed(verified('b@example.com')));
    check('multiple addresses: neither', !oidcIdentityAllowed(verified('c@example.com')));
  });

  withEnv({ domain: 'example.com' }, () => {
    check('domain form allows the domain', oidcIdentityAllowed(verified('anyone@example.com')));
    check('domain form allows a subdomain', oidcIdentityAllowed(verified('x@eu.example.com')));
    check('domain form refuses another domain', !oidcIdentityAllowed(verified('x@other.com')));
    // "notexample.com" ends with "example.com" as a string. Anchoring to the
    // label boundary is the difference between a restriction and a suggestion.
    check(
      'domain form refuses a lookalike domain',
      !oidcIdentityAllowed(verified('x@notexample.com')),
    );
  });

  // Defence in depth: assertAuthConfig already refuses to start here, but if
  // that check is ever moved or skipped this must still deny rather than allow.
  withEnv({}, () => {
    check('no allowlist configured → nobody is allowed', !oidcIdentityAllowed(verified('you@example.com')));
  });

  console.warn = warn;
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.error(`${failures} FAILED — not safe to deploy.`);
  process.exit(1);
}
