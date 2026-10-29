/**
 * Where this service is running, and what that machine expects of it.
 *
 * TripleC was built for one shape of box: an EC2 instance it provisions itself,
 * with a `coder` account, a data volume at /workspace, Claude on Bedrock through
 * the instance role, and an ALB in front. That is still the default, and nothing
 * here changes it. Host mode (`TRIPLEC_MODE=host`) is the other shape: an existing
 * Linux VM that belongs to a developer, where TripleC is installed *as* that
 * developer by deploy/host/install.sh, alongside whatever the VM already runs —
 * its own repositories, hooks, git setup, `claude /login`, reverse proxy.
 *
 * Every assumption that differs between the two lives in this file, so the rest of
 * the service asks a question ("whose home?", "which provider?", "is the editor
 * part of this install?") instead of carrying a literal. The AWS answers are the
 * defaults below and are the only place `coder` and `/workspace` appear in code.
 *
 * Imported first by server.js, because the secrets file it reads has to be in
 * process.env before anything checks for a password.
 */
import { execFileSync } from 'child_process';
import { readFileSync, statSync } from 'fs';
import { isIP } from 'net';
import { join } from 'path';

export const HOST_MODE = process.env.TRIPLEC_MODE === 'host';

// The EC2 deployment's layout, as infra/userdata/bootstrap.sh builds it. Used only
// when host mode is off; host mode takes these from the installer's env file.
const AWS_PROFILE_DEFAULTS = {
  user: 'coder',
  home: '/home/coder',
  projectsRoot: '/workspace/projects',
  claudeHome: '/workspace/claude',
};

const hostHome = () => process.env.HOME || '/';

export const WORKSPACE_USER = process.env.WORKSPACE_USER
  || (HOST_MODE ? process.env.USER || '' : AWS_PROFILE_DEFAULTS.user);

// The home the CLI is started with. In host mode it is the developer's own, which is
// what makes a chat see the same ~/.claude.json (MCP servers), ~/.claude (settings,
// hooks, credentials from `claude /login`) and git identity as `claude` over SSH.
export const USER_HOME = HOST_MODE
  ? hostHome()
  : process.env.CODER_HOME || AWS_PROFILE_DEFAULTS.home;

export const PROJECTS_ROOT = process.env.PROJECTS_ROOT
  || (HOST_MODE ? join(hostHome(), 'projects') : AWS_PROFILE_DEFAULTS.projectsRoot);

export const CLAUDE_HOME = process.env.CLAUDE_HOME
  || (HOST_MODE ? join(hostHome(), '.claude') : AWS_PROFILE_DEFAULTS.claudeHome);

// --- secrets ------------------------------------------------------------------

/**
 * The file backend for secrets: KEY=VALUE lines in a file only its owner can read.
 *
 * The other backend is the environment itself (a systemd drop-in, a vault agent),
 * which needs nothing from here — a key already set is never overwritten, so the
 * environment always wins over the file.
 *
 * Refused, not warned about, when anyone else can read it: the file holds the one
 * password between a browser and a shell, and on a shared VM "group-readable" can
 * mean every developer on the box.
 */
export function loadSecretsFile(file = process.env.TRIPLEC_SECRETS_FILE, env = process.env) {
  if (!file) return [];
  let info;
  try {
    info = statSync(file);
  } catch {
    throw new Error(`TRIPLEC_SECRETS_FILE ${file} does not exist. Re-run deploy/host/install.sh, which creates it.`);
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error(
      `${file} is readable by other users (mode ${(info.mode & 0o777).toString(8)}). ` +
        'It holds the login password and the cookie signing key; chmod 600 it.',
    );
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error(`${file} is not owned by the user this service runs as.`);
  }
  const loaded = [];
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue;
    if (env[key] === undefined || env[key] === '') {
      env[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
}

loadSecretsFile();

// --- features -----------------------------------------------------------------

export const FEATURE_NAMES = ['editor', 'voice', 'polish', 'push', 'mux', 'admin', 'retire'];

/**
 * Which parts of the product this install has.
 *
 * Unset means all of them, which is the AWS deployment: everything ships together
 * there, and it must keep doing so without anyone setting anything. A host install
 * lists the ones it enabled, and a feature that is not listed has no routes — not a
 * hidden button, a 404 — so "retire is off" is a property of the server rather than
 * of a client that might be stale.
 */
export function parseFeatures(value = process.env.TRIPLEC_FEATURES) {
  if (value === undefined) return new Set(FEATURE_NAMES);
  return new Set(
    String(value)
      .split(',')
      .map((f) => f.trim().toLowerCase())
      .filter((f) => FEATURE_NAMES.includes(f)),
  );
}

const FEATURES = parseFeatures();

export function feature(name) {
  return FEATURES.has(name);
}

export function features() {
  return Object.fromEntries(FEATURE_NAMES.map((name) => [name, FEATURES.has(name)]));
}

// --- the Claude provider --------------------------------------------------------

export const CLAUDE_AUTH_MODES = ['login', 'bedrock', 'vertex', 'apiKey'];

/**
 * How the CLI reaches a model. `bedrock` on the AWS deployment, as it always was;
 * `login` on a host where the developer ran `claude /login` and the credentials are
 * already in their ~/.claude.
 */
export const CLAUDE_AUTH_MODE = (() => {
  const mode = process.env.CLAUDE_AUTH_MODE || (HOST_MODE ? 'login' : 'bedrock');
  if (!CLAUDE_AUTH_MODES.includes(mode)) {
    throw new Error(`Unknown CLAUDE_AUTH_MODE "${mode}". Expected one of ${CLAUDE_AUTH_MODES.join(', ')}.`);
  }
  return mode;
})();

// A Bedrock model id is only a sensible default when the provider is Bedrock. Every
// other mode starts a chat on the CLI's own default unless the install names one.
const BEDROCK_DEFAULT_MODEL = 'us.anthropic.claude-opus-5-5';
export const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL
  || (CLAUDE_AUTH_MODE === 'bedrock' ? BEDROCK_DEFAULT_MODEL : null);

// Every variable that selects a provider or carries a credential for one. In login
// mode none of them may leak in from the service's environment, or the CLI would
// quietly use something other than the credentials the developer logged in with.
const PROVIDER_VARS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
];

/**
 * The environment a spawned `claude` runs with.
 *
 * `model` is the model this conversation was started on, or null for the CLI's own
 * default — in which case ANTHROPIC_MODEL is left out as well, since it would pick a
 * model just as `--model` does.
 */
export function claudeEnv({ model = null, base = process.env } = {}) {
  const env = { ...base, HOME: USER_HOME };
  for (const key of PROVIDER_VARS) delete env[key];
  if (CLAUDE_AUTH_MODE === 'bedrock') {
    env.CLAUDE_CODE_USE_BEDROCK = '1';
  } else if (CLAUDE_AUTH_MODE === 'vertex') {
    env.CLAUDE_CODE_USE_VERTEX = '1';
  } else if (CLAUDE_AUTH_MODE === 'apiKey' && base.ANTHROPIC_API_KEY) {
    env.ANTHROPIC_API_KEY = base.ANTHROPIC_API_KEY;
  }
  if (model) env.ANTHROPIC_MODEL = model;
  // This service's own secrets are not the CLI's business, and a CLI that can read
  // them can hand them to anything it runs.
  for (const key of ['AUTH_PASSWORD', 'SESSION_SECRET']) delete env[key];
  return env;
}

/** Whether the AWS SDK should be reached for at all. */
export const USES_AWS = !HOST_MODE || CLAUDE_AUTH_MODE === 'bedrock';

// --- the login shell's PATH -------------------------------------------------------

/**
 * The PATH a login shell of this user gets, read once at startup.
 *
 * A systemd unit's PATH is /usr/local/bin:/usr/bin:/bin and nothing else, so a CLI
 * started from it cannot find the tools a developer's shell profile adds — Homebrew,
 * ~/.local/bin (where the official installer puts `claude` itself), ~/go/bin — and a
 * repository whose commit hook runs one of them fails in a chat and works over SSH.
 * Asking the shell is the only way to get the answer the developer gets, because
 * that answer is whatever their profile files compute.
 *
 * Bounded and marked: a profile that prints a banner or waits on something must not
 * hang startup or end up inside PATH. A failure keeps the unit's PATH and says so.
 */
export function loginShellPath({ shell = process.env.SHELL || '/bin/bash', timeout = 10_000 } = {}) {
  const mark = '__TRIPLEC_PATH__';
  try {
    const out = execFileSync(shell, ['-l', '-c', `printf '${mark}%s${mark}' "$PATH"`], {
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { HOME: hostHome(), USER: process.env.USER || '', SHELL: shell, PATH: process.env.PATH || '' },
    });
    const found = new RegExp(`${mark}(.*?)${mark}`, 's').exec(out);
    return found && found[1].trim() ? found[1].trim() : null;
  } catch {
    return null;
  }
}

if (HOST_MODE && process.env.TRIPLEC_LOGIN_PATH === '1') {
  const path = loginShellPath();
  if (path) {
    // Process-wide, so git, the slot set-up command and the CLI all agree.
    process.env.PATH = path;
  } else {
    console.warn('host: could not read the login shell PATH; keeping the unit PATH');
  }
}

// --- the listener -----------------------------------------------------------------

export const BIND_ADDRESS = process.env.BIND_ADDRESS || '127.0.0.1';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
export const isLoopbackAddress = (address) =>
  LOOPBACK.has(address) || /^127\./.test(address || '') || address === '::ffff:127.0.0.1';

/**
 * Refuse to listen anywhere but loopback unless told to, in so many words.
 *
 * Everything that reaches this service is supposed to arrive through something that
 * terminates TLS on the same machine — nginx, a VM's own HTTPS proxy, Tailscale
 * Serve. A bind to 0.0.0.0 would put a plain-HTTP shell on whatever network the VM
 * is on, and on a developer VM that network may route to production.
 */
export function assertBindAddress(address = BIND_ADDRESS, allowPublic = process.env.ALLOW_PUBLIC_BIND === '1') {
  if (isLoopbackAddress(address)) return address;
  if (!isIP(address) && address !== 'localhost') {
    throw new Error(`BIND_ADDRESS "${address}" is not an IP address.`);
  }
  if (!allowPublic) {
    throw new Error(
      `Refusing to listen on ${address}: this service runs shell commands for whoever ` +
        'reaches it, and only a loopback address keeps it behind the proxy that ' +
        'terminates TLS. Set allowPublicBind (ALLOW_PUBLIC_BIND=1) to override.',
    );
  }
  return address;
}

// --- session limits --------------------------------------------------------------

export const MAX_LIVE_SESSIONS = (() => {
  const n = Number(process.env.MAX_LIVE_SESSIONS || 8);
  return Number.isInteger(n) && n >= 1 ? n : 8;
})();

// --- the audit trail ---------------------------------------------------------------

// On by default in host mode, where the journal is shipped off the box; opt-in on the
// AWS deployment, whose CloudTrail and journal already cover what it needs.
const AUDIT = process.env.TRIPLEC_AUDIT ? process.env.TRIPLEC_AUDIT === '1' : HOST_MODE;

// Field names whose values are never written, whatever a caller passes. A last line
// of defence: callers already pass identities and outcomes, not credentials.
const NEVER_LOGGED = /pass(word)?|secret|token|cookie|authorization|key/i;

/**
 * One JSON line on stdout per security-relevant event, which systemd puts in the
 * journal under the service's identifier and the VM's log agent ships from there.
 *
 * `{"audit":"triplec", "event": ..., "at": ...}` so a log query can select them
 * without parsing anything else this service prints.
 */
export function audit(event, fields = {}, { write = (line) => console.log(line) } = {}) {
  if (!AUDIT && !fields.force) return null;
  const record = { audit: 'triplec', event, at: new Date().toISOString() };
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'force' || value === undefined) continue;
    record[key] = NEVER_LOGGED.test(key) ? '[redacted]' : value;
  }
  const line = JSON.stringify(record);
  write(line);
  return record;
}

export const auditEnabled = () => AUDIT;
