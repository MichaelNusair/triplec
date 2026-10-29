#!/usr/bin/env node
/**
 * The host-mode config: validation, and everything the installer derives from it.
 *
 * Host mode installs TripleC onto a Linux VM that already belongs to a developer
 * (see deploy/host/README.md). Its whole configuration is one JSON file,
 * ~/.config/triplec/config.json, shaped like triplec.host.example.json next to this
 * script. This file is the single reader of it: install.sh, upgrade.sh and
 * uninstall.sh never parse JSON themselves, they ask this script.
 *
 *   node config.mjs validate <file>          exit 0, or 1 with every problem listed
 *   node config.mjs env <file>               the service's systemd EnvironmentFile
 *   node config.mjs projects <file>          projects.json for the service
 *   node config.mjs get <file> <dotted.key>  one resolved value, for the shell
 *
 * No dependencies, on purpose: it runs before `npm install` has happened, on a
 * machine whose node may be whatever the developer already had.
 *
 * Strict rather than forgiving. An unknown key is an error, not a warning, because
 * the most likely unknown key is a misspelt one — `"bnid": "0.0.0.0"` silently
 * ignored is a listener nobody meant to open. Keys that are absent take the
 * defaults below, so a config can be as short as `{"mode": "host"}`.
 *
 * There are deliberately no secrets in this file. The password and the cookie
 * signing key live in secrets.env (mode 0600), which the installer generates; a
 * config is something people paste into issues and commit to dotfile repos.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FEATURES = ['editor', 'voice', 'polish', 'push', 'mux', 'admin', 'retire'];
export const AUTH_MODES = ['login', 'bedrock', 'vertex', 'apiKey'];
export const PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const LOOPBACK = ['127.0.0.1', '::1', 'localhost'];
// code-server's port when the editor is on. Fixed, because nginx and the unit both
// name it, and a collision with either listener is a config that cannot start.
export const EDITOR_PORT = 9999;

/** Every key the config may have, with the value an absent key takes. */
export const DEFAULTS = {
  mode: 'host',
  user: '',
  home: '',
  installDir: '~/.local/share/triplec',
  configDir: '~/.config/triplec',
  stateDir: '~/.local/state/triplec',
  projectsRoot: '~/projects',
  claudeHome: '~/.claude',
  projects: [],
  listen: { nginxPort: 8080, appPort: 9997, bind: '127.0.0.1', allowPublicBind: false },
  features: { editor: false, voice: false, polish: false, push: true, mux: true, admin: true, retire: false },
  claude: {
    authMode: 'login',
    defaultModel: '',
    permissionMode: 'manual',
    effort: 'high',
    loginShellPath: true,
    vertex: { projectId: '', region: '' },
  },
  auth: {
    mode: 'password',
    singleOwner: true,
    trustedHeader: { header: 'Tailscale-User-Login', allowedEmails: [], peerUid: 0, allowPassword: true },
  },
  secrets: { backend: 'file' },
  maxLiveSessions: 8,
  pwa: { name: '' },
};

const PROJECT_DEFAULTS = { name: '', path: '', slots: { count: 8, postCreate: '' } };

// Key names that only ever hold a secret. Rejected with a message that says where
// the secret goes instead, because "unknown key" alone reads like a typo to fix.
const SECRET_KEY = /password|passwd|passphrase|secret|token|credential|private.?key|api.?key|access.?key/i;
// Keys whose names match the above but are not secrets.
const NOT_SECRET_KEYS = new Set(['allowPassword', 'secrets']);
// Values that are recognisably a credential, wherever they appear.
const SECRET_VALUES = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/, 'an Anthropic API key'],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/, 'an AWS access key id'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/, 'a GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/, 'a GitHub token'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/\bAIza[0-9A-Za-z_-]{30,}/, 'a Google API key'],
];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

/**
 * Validate a parsed config. Returns { errors, warnings }, both lists of strings
 * that name the key they are about. Never throws on bad input.
 */
export function validate(raw) {
  const errors = [];
  const warnings = [];
  const err = (key, msg) => errors.push(`${key}: ${msg}`);

  if (!isObject(raw)) return { errors: ['config: must be a JSON object'], warnings };

  scanForSecrets(raw, '', err);

  // Unknown keys, against the shape of DEFAULTS. `projects` entries are checked
  // separately below because they are a list.
  const checkKeys = (obj, shape, prefix) => {
    if (!isObject(obj)) return;
    for (const key of Object.keys(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (!(key in shape)) {
        if (!SECRET_KEY.test(key) || NOT_SECRET_KEYS.has(key)) err(path, 'unknown key');
        continue;
      }
      if (isObject(shape[key])) {
        if (!isObject(obj[key])) err(path, 'must be an object');
        else checkKeys(obj[key], shape[key], path);
      }
    }
  };
  checkKeys(raw, DEFAULTS, '');

  const c = merge(DEFAULTS, raw);

  if (c.mode !== 'host') err('mode', 'must be "host" (this installer is host mode only)');

  for (const key of ['user', 'home']) {
    if (typeof c[key] !== 'string') err(key, 'must be a string');
  }
  if (typeof c.user === 'string' && c.user && !/^[a-z_][a-z0-9_.-]*\$?$/i.test(c.user)) {
    err('user', `"${c.user}" is not a valid user name`);
  }
  if (typeof c.home === 'string' && c.home && !c.home.startsWith('/')) {
    err('home', 'must be an absolute path (or empty for the user\'s own home)');
  }
  for (const key of ['installDir', 'configDir', 'stateDir', 'projectsRoot', 'claudeHome']) {
    checkPath(c[key], key, err);
  }

  // projects
  if (!Array.isArray(c.projects)) {
    err('projects', 'must be a list');
  } else {
    const seen = new Set();
    c.projects.forEach((p, i) => {
      const at = `projects[${i}]`;
      if (!isObject(p)) return err(at, 'must be an object');
      for (const key of Object.keys(p)) {
        if (!(key in PROJECT_DEFAULTS)) err(`${at}.${key}`, 'unknown key');
      }
      if (typeof p.name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(p.name) || p.name.startsWith('.')) {
        err(`${at}.name`, 'must match ^[A-Za-z0-9._-]+$ and not start with a dot');
      } else if (seen.has(p.name)) {
        err(`${at}.name`, `"${p.name}" is listed twice`);
      } else {
        seen.add(p.name);
      }
      checkPath(p.path, `${at}.path`, err);
      if (p.slots !== undefined) {
        if (!isObject(p.slots)) {
          err(`${at}.slots`, 'must be an object');
        } else {
          for (const key of Object.keys(p.slots)) {
            if (!(key in PROJECT_DEFAULTS.slots)) err(`${at}.slots.${key}`, 'unknown key');
          }
          if (p.slots.count !== undefined && !isInt(p.slots.count, 1, 8)) {
            err(`${at}.slots.count`, 'must be an integer from 1 to 8');
          }
          if (p.slots.postCreate !== undefined && typeof p.slots.postCreate !== 'string') {
            err(`${at}.slots.postCreate`, 'must be a string (a command, or empty)');
          } else if (/[\r\n\0]/.test(p.slots.postCreate || '')) {
            err(`${at}.slots.postCreate`, 'must be a single line');
          }
        }
      }
    });
  }

  // listen
  const l = c.listen;
  if (isObject(l)) {
    for (const key of ['nginxPort', 'appPort']) {
      if (!isInt(l[key], 1, 65535)) err(`listen.${key}`, 'must be an integer port from 1 to 65535');
    }
    if (l.nginxPort === l.appPort) err('listen', 'nginxPort and appPort must differ');
    if (c.features?.editor === true && [l.nginxPort, l.appPort].includes(EDITOR_PORT)) {
      err('listen', `port ${EDITOR_PORT} is code-server's when features.editor is on`);
    }
    if (typeof l.allowPublicBind !== 'boolean') err('listen.allowPublicBind', 'must be true or false');
    if (typeof l.bind !== 'string' || !l.bind) {
      err('listen.bind', 'must be an address');
    } else if (!LOOPBACK.includes(l.bind) && l.allowPublicBind !== true) {
      err('listen.bind', `"${l.bind}" is not loopback. The app runs shell commands for whoever ` +
        'reaches it; keep it on 127.0.0.1 behind nginx or your proxy, or set ' +
        'listen.allowPublicBind to true if you really mean it');
    } else if (!LOOPBACK.includes(l.bind)) {
      warnings.push(`listen.bind: "${l.bind}" is not loopback; anything that can reach it reaches a shell`);
    }
    if (/[\s;{}#"'$\\]/.test(l.bind || '')) err('listen.bind', 'contains characters no address has');
  }

  // features
  if (isObject(c.features)) {
    for (const name of FEATURES) {
      if (typeof c.features[name] !== 'boolean') err(`features.${name}`, 'must be true or false');
    }
  }

  // claude
  const cl = c.claude;
  if (isObject(cl)) {
    if (!AUTH_MODES.includes(cl.authMode)) err('claude.authMode', `must be one of ${AUTH_MODES.join(', ')}`);
    if (typeof cl.defaultModel !== 'string' || !/^[A-Za-z0-9._:/@[\]-]*$/.test(cl.defaultModel)) {
      err('claude.defaultModel', 'must be a model id (letters, digits, . _ : / @ [ ] -) or empty');
    }
    if (cl.permissionMode !== 'default' && !PERMISSION_MODES.includes(cl.permissionMode)) {
      err('claude.permissionMode', `must be one of ${PERMISSION_MODES.join(', ')} (or "default", meaning manual)`);
    }
    if (!EFFORTS.includes(cl.effort)) err('claude.effort', `must be one of ${EFFORTS.join(', ')}`);
    if (typeof cl.loginShellPath !== 'boolean') err('claude.loginShellPath', 'must be true or false');
    const v = cl.vertex;
    if (isObject(v)) {
      for (const key of ['projectId', 'region']) {
        if (typeof v[key] !== 'string') err(`claude.vertex.${key}`, 'must be a string');
      }
      if (cl.authMode === 'vertex') {
        if (!v.projectId) err('claude.vertex.projectId', 'is required when claude.authMode is "vertex"');
        if (!v.region) err('claude.vertex.region', 'is required when claude.authMode is "vertex"');
      }
      if (typeof v.projectId === 'string' && v.projectId && !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(v.projectId)) {
        err('claude.vertex.projectId', 'is not a valid Google Cloud project id');
      }
      if (typeof v.region === 'string' && v.region && !/^[a-z0-9-]+$/.test(v.region)) {
        err('claude.vertex.region', 'is not a valid region name');
      }
    }
    if (c.features?.polish === true && cl.authMode !== 'bedrock') {
      warnings.push('features.polish: dictation cleanup calls Bedrock, so it only works with claude.authMode "bedrock"');
    }
  }

  // auth
  const a = c.auth;
  if (isObject(a)) {
    if (a.mode === 'oidc') {
      err('auth.mode', '"oidc" is the AWS deployment\'s (it relies on the load balancer\'s signed ' +
        'identity header). In host mode use "password", or "trusted-header" behind a tailnet');
    } else if (!['password', 'trusted-header'].includes(a.mode)) {
      err('auth.mode', 'must be "password" or "trusted-header"');
    }
    if (typeof a.singleOwner !== 'boolean') err('auth.singleOwner', 'must be true or false');
    const t = a.trustedHeader;
    if (isObject(t)) {
      if (typeof t.header !== 'string' || !/^[A-Za-z0-9-]+$/.test(t.header)) {
        err('auth.trustedHeader.header', 'must be an HTTP header name');
      }
      if (!Array.isArray(t.allowedEmails) || t.allowedEmails.some((e) => typeof e !== 'string' || !/^[^\s@,]+@[^\s@,]+$/.test(e))) {
        err('auth.trustedHeader.allowedEmails', 'must be a list of email addresses');
      } else if (a.mode === 'trusted-header') {
        if (t.allowedEmails.length === 0) {
          err('auth.trustedHeader.allowedEmails', 'must name at least one identity in trusted-header mode');
        } else if (a.singleOwner === true && t.allowedEmails.length !== 1) {
          err('auth.trustedHeader.allowedEmails', 'must name exactly one identity when auth.singleOwner is true');
        }
      }
      if (!isInt(t.peerUid, 0, 4294967294)) err('auth.trustedHeader.peerUid', 'must be a uid (an integer >= 0)');
      if (typeof t.allowPassword !== 'boolean') err('auth.trustedHeader.allowPassword', 'must be true or false');
    }
  }

  if (!isObject(c.secrets) || !['file', 'env'].includes(c.secrets.backend)) {
    err('secrets.backend', 'must be "file" or "env"');
  }
  if (!isInt(c.maxLiveSessions, 1, 64)) err('maxLiveSessions', 'must be an integer from 1 to 64');
  if (!isObject(c.pwa) || typeof c.pwa.name !== 'string' || !/^[A-Za-z0-9 ._-]{0,40}$/.test(c.pwa.name)) {
    err('pwa.name', 'must be at most 40 letters, digits, spaces, dots, underscores or hyphens');
  }

  return { errors, warnings };
}

function checkPath(value, key, err) {
  if (typeof value !== 'string' || !value) return err(key, 'must be a path');
  if (!(value.startsWith('/') || value === '~' || value.startsWith('~/'))) {
    return err(key, 'must be absolute or start with ~/');
  }
  if (value.split('/').includes('..')) err(key, 'must not contain ".."');
  if (/[\r\n\0"'$\\`]/.test(value)) err(key, 'contains a quote, $, backslash or newline');
}

function scanForSecrets(value, path, err) {
  if (typeof value === 'string') {
    for (const [re, what] of SECRET_VALUES) {
      if (re.test(value)) err(path || 'config', `looks like ${what}. Secrets do not belong in the config; put them in secrets.env`);
    }
    return;
  }
  if (Array.isArray(value)) return value.forEach((v, i) => scanForSecrets(v, `${path}[${i}]`, err));
  if (!isObject(value)) return;
  for (const [key, v] of Object.entries(value)) {
    const at = path ? `${path}.${key}` : key;
    if (SECRET_KEY.test(key) && !NOT_SECRET_KEYS.has(key)) {
      err(at, 'secrets do not belong in the config (it is meant to be shareable). The installer ' +
        'generates the password into <configDir>/secrets.env; put any API key there too');
      continue;
    }
    scanForSecrets(v, at, err);
  }
}

/** DEFAULTS deep-merged with the file: objects merge, everything else replaces. */
export function merge(base, over) {
  if (!isObject(base) || !isObject(over)) return over === undefined ? structuredClone(base) : over;
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? merge(base[k], v) : v;
  return out;
}

/** The user's home from /etc/passwd, for a config naming someone other than us. */
function passwdHome(user) {
  try {
    for (const line of readFileSync('/etc/passwd', 'utf8').split('\n')) {
      const f = line.split(':');
      if (f[0] === user && f[5]) return f[5];
    }
  } catch { /* fall through */ }
  return '';
}

/**
 * The config with every default applied and every path absolute. `ctx` lets a
 * test pin who "the invoking user" is.
 */
export function resolve(raw, ctx = {}) {
  const c = merge(DEFAULTS, raw);
  const me = ctx.user ?? (process.env.USER || userInfo().username);
  c.user = c.user || me;
  c.home = c.home || ctx.home || (c.user === me ? process.env.HOME || homedir() : passwdHome(c.user));
  if (!c.home) throw new Error(`cannot find a home directory for user "${c.user}"; set "home"`);
  const ex = (p) => expand(p, c.home);
  for (const key of ['installDir', 'configDir', 'stateDir', 'projectsRoot', 'claudeHome']) c[key] = ex(c[key]);
  c.projects = c.projects.map((p) => ({
    name: p.name,
    path: ex(p.path),
    slots: { ...PROJECT_DEFAULTS.slots, ...(p.slots || {}) },
  }));
  if (c.claude.permissionMode === 'default') c.claude.permissionMode = 'manual';
  return c;
}

export function expand(p, home) {
  const out = p === '~' ? home : p.startsWith('~/') ? posix.join(home, p.slice(2)) : p;
  return posix.normalize(out).replace(/(.)\/$/, '$1');
}

const flag = (b) => (b ? '1' : '0');

/** The service's EnvironmentFile, as [key, value] pairs in a stable order. */
export function envPairs(c) {
  const pairs = [
    ['TRIPLEC_MODE', 'host'],
    ['WORKSPACE_USER', c.user],
    ['HOME', c.home],
    ['PROJECTS_ROOT', c.projectsRoot],
    ['CLAUDE_HOME', c.claudeHome],
  ];
  if (c.projects.length) pairs.push(['TRIPLEC_PROJECTS_FILE', `${c.configDir}/projects.json`]);
  pairs.push(['TRIPLEC_FEATURES', FEATURES.filter((f) => c.features[f]).join(',')]);
  pairs.push(['CLAUDE_AUTH_MODE', c.claude.authMode]);
  if (c.claude.defaultModel) pairs.push(['ANTHROPIC_MODEL', c.claude.defaultModel]);
  pairs.push(
    ['DEFAULT_PERMISSION_MODE', c.claude.permissionMode],
    ['DEFAULT_EFFORT', c.claude.effort],
    ['TRIPLEC_LOGIN_PATH', flag(c.claude.loginShellPath)],
    ['PORT', String(c.listen.appPort)],
    ['BIND_ADDRESS', c.listen.bind],
    ['ALLOW_PUBLIC_BIND', flag(c.listen.allowPublicBind)],
    ['CW_AUTH_MODE', c.auth.mode],
    ['CW_SINGLE_OWNER', flag(c.auth.singleOwner)],
  );
  if (c.auth.mode === 'trusted-header') {
    const t = c.auth.trustedHeader;
    pairs.push(
      ['CW_TRUSTED_HEADER', t.header],
      ['CW_TRUSTED_EMAILS', t.allowedEmails.join(',')],
      ['CW_TRUSTED_PEER_UID', String(t.peerUid)],
      ['CW_TRUSTED_ALLOW_PASSWORD', flag(t.allowPassword)],
    );
  }
  if (c.secrets.backend === 'file') pairs.push(['TRIPLEC_SECRETS_FILE', `${c.configDir}/secrets.env`]);
  pairs.push(
    ['MAX_LIVE_SESSIONS', String(c.maxLiveSessions)],
    ['PWA_NAME', c.pwa.name],
    ['TRIPLEC_AUDIT', '1'],
    // TripleC's own state — the push keys and the device list — in its state
    // directory, not under ~/.claude, which belongs to Claude Code and to the
    // developer and which uninstall promises to leave exactly as it found it.
    ['CW_PUSH_DIR', `${c.stateDir}/push`],
  );
  if (c.claude.authMode === 'vertex') {
    pairs.push(['CLOUD_ML_REGION', c.claude.vertex.region], ['ANTHROPIC_VERTEX_PROJECT_ID', c.claude.vertex.projectId]);
  }
  // Where the installer put things the service runs, rather than the AWS paths
  // the service defaults to: `cc` for the mux's terminal panes, whisper for voice.
  if (c.features.mux) pairs.push(['CC_SCRIPT', `${c.installDir}/bin/cc`]);
  if (c.features.voice) {
    pairs.push(
      ['WHISPER_BIN', `${c.installDir}/whisper/whisper-cli`],
      ['WHISPER_MODEL', `${c.installDir}/whisper/models/ggml-base.en.bin`],
    );
  }
  return pairs;
}

export function renderEnv(c) {
  const lines = ['# Written by deploy/host/install.sh from config.json. Edit that and re-run; changes here are overwritten.'];
  for (const [k, v] of envPairs(c)) {
    // systemd's EnvironmentFile parser gives quotes, backslashes and a leading
    // whitespace meaning; none of our values needs them, so refuse rather than escape.
    if (/[\r\n\0"'\\`$]/.test(v) || v !== v.trim()) throw new Error(`${k}: value is not safe for a systemd EnvironmentFile: ${JSON.stringify(v)}`);
    lines.push(`${k}=${v}`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderProjects(c) {
  return `${JSON.stringify(c.projects, null, 2)}\n`;
}

/** One value by dotted path, as the shell wants it: scalars bare, the rest JSON. */
export function get(c, key) {
  let v = c;
  for (const part of key.split('.')) {
    if (!isObject(v) || !(part in v)) throw new Error(`no such key: ${key}`);
    v = v[part];
  }
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

export function load(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`cannot read ${file}: ${e.code || e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${e.message}`);
  }
}

function main(argv) {
  const [cmd, file, key] = argv;
  const usage = 'usage: config.mjs validate|env|projects <file>  |  config.mjs get <file> <dotted.key>';
  if (!cmd || !file || (cmd === 'get' && !key)) {
    console.error(usage);
    return 2;
  }
  let raw;
  try {
    raw = load(file);
  } catch (e) {
    console.error(`config: ${e.message}`);
    return 1;
  }
  const { errors, warnings } = validate(raw);
  for (const w of warnings) console.error(`warning: ${w}`);
  if (errors.length) {
    console.error(`${file}: ${errors.length} problem${errors.length === 1 ? '' : 's'}`);
    for (const e of errors) console.error(`  - ${e}`);
    return 1;
  }
  try {
    const c = resolve(raw);
    switch (cmd) {
      case 'validate':
        console.log(`${file}: ok`);
        return 0;
      case 'env':
        process.stdout.write(renderEnv(c));
        return 0;
      case 'projects':
        process.stdout.write(renderProjects(c));
        return 0;
      case 'get':
        console.log(get(c, key));
        return 0;
      default:
        console.error(usage);
        return 2;
    }
  } catch (e) {
    console.error(`config: ${e.message}`);
    return 1;
  }
}

const invokedDirectly = () => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (process.argv[1] && invokedDirectly()) {
  process.exitCode = main(process.argv.slice(2));
}
