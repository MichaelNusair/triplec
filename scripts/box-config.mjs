#!/usr/bin/env node
/**
 * Settings changed on the box page (/chat/admin), layered over the deployment's
 * config file.
 *
 *   box-config.mjs status --aws | --host <config.json>             the page's view, as JSON
 *   box-config.mjs set    --aws | --host <config.json> --value '{"path": value, …}'
 *   box-config.mjs reset  --aws | --host <config.json> [--path <dotted.path>]
 *   box-config.mjs shell  --aws                                   for bootstrap.sh
 *
 * Every key of the config can be changed from the page. The config file stays where
 * a setting comes from: a change saved here is kept on the box, beside the file
 * rather than in it, because a deploy rewrites the box's copy of the file and would
 * undo it. It lasts across deploys until someone changes that same key in the config
 * file itself. Then the file wins: whoever edited it meant it, and an edit made on
 * the box before that is about a value nobody has any more. Each entry records the
 * file's value it was made against (`base`), for exactly that comparison.
 *
 * Where a change takes effect depends on the key, and the page says which:
 *
 *   timer  autoUpdate.*: read by the updater on its next run. Nothing restarts.
 *   box    applied by the box to itself: `triplec-update apply` re-runs the install
 *          with the saved values, checks the app still requires a login, and rolls
 *          back if not. It restarts the chat service.
 *   stack  on AWS, everything that is the stack's: saved as pending, and applied
 *          by the next full `./deploy.sh` from a machine with AWS credentials, which
 *          reads this file from the box over SSM. This box cannot redeploy the
 *          stack it runs in.
 *
 * The file: /workspace/triplec-config/overrides.json on AWS (the EBS volume that
 * outlives the instance), `<stateDir>/box-config.json` on a host install.
 *
 *   { "values": { "<path>": value }, "base": { "<path>": "<JSON of the file's value>" },
 *     "savedAt": { "<path>": ms } }
 *
 * No dependencies beyond node's own, and the pure parts touch no filesystem:
 * infra/config.js imports this on a laptop, before anything is installed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const AWS_FILE = '/workspace/triplec-config/overrides.json';
export const HOST_FILE_NAME = 'box-config.json';

// --- paths --------------------------------------------------------------------------

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const json = (v) => (v === undefined ? 'undefined' : JSON.stringify(v));

export function getPath(obj, p) {
  let v = obj;
  for (const part of p.split('.')) {
    if (!isObject(v) || !(part in v)) return undefined;
    v = v[part];
  }
  return v;
}

/** A copy of `obj` with `p` set to `value`, creating objects on the way. */
export function setPath(obj, p, value) {
  const out = clone(obj) || {};
  const parts = p.split('.');
  let v = out;
  for (const part of parts.slice(0, -1)) {
    if (!isObject(v[part])) v[part] = {};
    v = v[part];
  }
  v[parts.at(-1)] = clone(value);
  return out;
}

/**
 * Every editable path in a resolved config, in its order: the leaves, where an
 * array counts as one leaf (a list is edited whole). `$comment` keys are not config.
 */
export function leaves(view, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(view || {})) {
    if (k.startsWith('$')) continue;
    const p = prefix ? `${prefix}.${k}` : k;
    if (isObject(v) && Object.keys(v).length) out.push(...leaves(v, p));
    else out.push(p);
  }
  return out;
}

// --- where each key takes effect ------------------------------------------------------

/** On AWS, the keys the box applies to itself, and the bootstrap.sh variable each feeds. */
export const AWS_BOX_KEYS = {
  defaultModel: 'DEFAULT_MODEL',
  permissionMode: 'PERMISSION_MODE',
  effortLevel: 'EFFORT_LEVEL',
  gitUserName: 'GIT_USER_NAME',
  gitUserEmail: 'GIT_USER_EMAIL',
  'pwa.name': 'PWA_NAME',
  'oidc.allowedEmails': 'OIDC_ALLOWED_EMAILS',
  'oidc.allowedDomain': 'OIDC_ALLOWED_DOMAIN',
  // Not a UserData placeholder: bootstrap.sh reads the file's value from the
  // payload's deployment/config.json, so this only carries the page's change to it.
  'browser.enabled': 'BROWSER_ENABLED',
};

export function scopeOf(platform, p) {
  if (p === 'autoUpdate' || p.startsWith('autoUpdate.')) return 'timer';
  if (platform === 'host') return 'box';
  return p in AWS_BOX_KEYS ? 'box' : 'stack';
}

/*
 * The values bootstrap.sh writes into unit files, a JSON settings file and git
 * config as root. The config file's own validation is the first check; this is the
 * second, for the page's values, which reach those places through a shell.
 */
const SHELL_UNSAFE = /['"`$\\\n\r|;&<>]/;

// --- the store ----------------------------------------------------------------------

export function emptyStore() {
  return { values: {}, base: {}, savedAt: {} };
}

export function readStore(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isObject(s) || !isObject(s.values) || !isObject(s.base)) return emptyStore();
    return { values: s.values, base: s.base, savedAt: isObject(s.savedAt) ? s.savedAt : {} };
  } catch {
    return emptyStore();
  }
}

export function writeStore(file, store) {
  if (!Object.keys(store.values).length) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o644 });
  fs.renameSync(tmp, file);
}

/**
 * The saved values over a config.
 *
 * `view` is the config file's own resolved values, what `base` is compared with.
 * `onto` is the object the values are set on, which is `view` unless a caller keeps
 * the file's raw form to validate (a host install does). Returns the merged object
 * and, per path, whether it applied or was superseded by a change to the file.
 */
export function layer(view, store, onto = view) {
  let merged = clone(onto);
  const applied = [];
  const superseded = [];
  for (const [p, value] of Object.entries(store?.values || {})) {
    if (store.base[p] !== json(getPath(view, p))) {
      superseded.push(p);
      continue;
    }
    merged = setPath(merged, p, value);
    applied.push(p);
  }
  return { config: merged, applied, superseded };
}

/**
 * The store after saving `changes` ({ path: value }). A value equal to the file's
 * removes that path's entry; anything else records it with the file's value as its
 * base. Paths not in `allowed` are refused, by name. Validation of the result is the
 * caller's, because it differs by platform.
 */
export function withChanges(view, store, changes, { allowed, platform, now = Date.now() } = {}) {
  if (!isObject(changes)) throw new Error('changes must be an object of { "dotted.path": value }');
  const next = { values: { ...store.values }, base: { ...store.base }, savedAt: { ...store.savedAt } };
  const errors = [];
  for (const [p, value] of Object.entries(changes)) {
    if (allowed && !allowed.includes(p)) {
      errors.push(`${p}: not a key of this deployment's config`);
      continue;
    }
    const fromFile = getPath(view, p);
    if (fromFile !== undefined && value !== null && typeof fromFile !== typeof value) {
      errors.push(`${p}: must be ${Array.isArray(fromFile) ? 'a list' : `a ${typeof fromFile}`}, like the config's own value`);
      continue;
    }
    if (platform === 'aws' && p in AWS_BOX_KEYS) {
      const items = Array.isArray(value) ? value : [value];
      if (items.some((x) => typeof x === 'string' && SHELL_UNSAFE.test(x))) {
        errors.push(`${p}: may not contain quotes, backslashes, $, |, ;, &, < or >`);
        continue;
      }
    }
    if (json(value) === json(fromFile)) {
      delete next.values[p];
      delete next.base[p];
      delete next.savedAt[p];
    } else {
      next.values[p] = clone(value);
      next.base[p] = json(fromFile);
      next.savedAt[p] = now;
    }
  }
  if (errors.length) throw new Error(errors.join('; '));
  return next;
}

/** The store without `paths` (all of them when none are given). */
export function withoutPaths(store, paths) {
  const next = { values: { ...store.values }, base: { ...store.base }, savedAt: { ...store.savedAt } };
  for (const p of paths?.length ? paths : Object.keys(next.values)) {
    delete next.values[p];
    delete next.base[p];
    delete next.savedAt[p];
  }
  return next;
}

/** Shell assignments for bootstrap.sh: the AWS box keys the store changes, quoted. */
export function shellAssignments(view, store) {
  const { config, applied } = layer(view, store);
  const lines = [];
  for (const p of applied) {
    const name = AWS_BOX_KEYS[p];
    if (!name) continue;
    let v = getPath(config, p);
    if (Array.isArray(v)) v = v.join(',');
    v = String(v ?? '');
    if (SHELL_UNSAFE.test(v)) continue; // refused at save; never trusted here either
    lines.push(`${name}='${v}'`);
  }
  return lines.join('\n');
}

// --- a deployment ---------------------------------------------------------------------

/**
 * One deployment's config, both ways: the file's own values (`view`), and how a
 * merged object is validated. AWS imports infra/config.js, which ships in the
 * payload; a host install imports deploy/host/config.mjs, staged beside this file.
 */
export async function deployment(args) {
  if (args.includes('--aws')) {
    const installDir = process.env.TRIPLEC_INSTALL_DIR || '/opt/claude-web';
    const configFile = path.join(installDir, 'deployment', 'config.json');
    let view;
    try {
      view = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    } catch (e) {
      throw new Error(`${configFile} is missing or unreadable (${e.code || e.message}); it ships with every payload`);
    }
    const file = process.env.TRIPLEC_BOX_OVERRIDES || AWS_FILE;
    const validate = async (merged) => {
      const candidates = [path.join(installDir, 'infra', 'config.js'), path.join(HERE, '..', 'infra', 'config.js')];
      const found = candidates.find((f) => fs.existsSync(f));
      if (!found) return [];
      const { resolveConfig } = await import(pathToFileURL(found).href);
      try {
        resolveConfig(merged, { env: {}, quiet: true, repoFiles: false });
        return [];
      } catch (e) {
        return [e.message.replace(/^Invalid configuration: /, '')];
      }
    };
    return { platform: 'aws', view, onto: view, file, validate, configFile };
  }
  const i = args.indexOf('--host');
  if (i < 0 || !args[i + 1]) throw new Error('say which deployment this is: --aws, or --host <config.json>');
  const configFile = path.resolve(args[i + 1]);
  const candidates = [path.join(HERE, '..', 'deploy', 'host', 'config.mjs'), path.join(HERE, 'config.mjs'), path.join(HERE, '..', 'config.mjs')];
  const found = candidates.find((f) => fs.existsSync(f));
  if (!found) throw new Error('deploy/host/config.mjs is not installed beside this script');
  const m = await import(pathToFileURL(found).href);
  const raw = m.load(configFile);
  const view = m.resolve(raw);
  const file = path.join(view.stateDir, HOST_FILE_NAME);
  const validate = async (mergedRaw) => m.validate(mergedRaw).errors;
  return { platform: 'host', view, onto: raw, file, validate, configFile };
}

/**
 * What the last full deploy took from the store, which deploy.sh writes beside it
 * once the stack is green: { values: { path: value }, at }. A stack value saved
 * after that, or changed since, is still pending.
 */
export const DEPLOYED_NAME = 'deployed.json';
export function readDeployed(file) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(path.dirname(file), DEPLOYED_NAME), 'utf8'));
    return isObject(d?.values) ? d : { values: {}, at: null };
  } catch {
    return { values: {}, at: null };
  }
}

/** What the page shows: every key, its file value, what applies, and where it takes effect. */
export function statusOf(d, store) {
  const { config, applied, superseded } = layer(d.view, store, d.view);
  const deployed = readDeployed(d.file);
  const fields = leaves(d.view).map((p) => ({
    path: p,
    value: getPath(config, p),
    file: getPath(d.view, p),
    scope: scopeOf(d.platform, p),
    changed: applied.includes(p),
    superseded: superseded.includes(p),
    savedAt: store.savedAt?.[p] ?? null,
    deployed: applied.includes(p) && json(deployed.values[p]) === json(getPath(config, p)),
  }));
  return {
    platform: d.platform,
    configFile: d.configFile,
    storeFile: d.file,
    fields,
    pending: {
      // Saved, and waiting on something other than the timer: an apply on the box,
      // or a full deploy. `applied` lists those the box already installed.
      box: applied.filter((p) => scopeOf(d.platform, p) === 'box'),
      stack: applied.filter((p) => scopeOf(d.platform, p) === 'stack' && fields.find((f) => f.path === p)?.deployed !== true),
    },
    deployedAt: deployed.at,
    superseded,
  };
}

/** Save `changes`, after validating the whole result the way the platform does. */
export async function save(d, changes, now = Date.now()) {
  const store = readStore(d.file);
  const next = withChanges(d.view, store, changes, { allowed: leaves(d.view), platform: d.platform, now });
  const errors = await d.validate(layer(d.view, next, d.onto).config);
  if (errors.length) throw new Error(errors.join('; '));
  writeStore(d.file, next);
  return next;
}

// --- command line ---------------------------------------------------------------------

async function main(argv) {
  const [cmd, ...args] = argv;
  const usage = "usage: box-config.mjs status|set|reset|shell --aws | --host <config.json> [--value '<json>'] [--path <p>]";
  if (!['status', 'set', 'reset', 'shell'].includes(cmd)) {
    console.error(usage);
    return 2;
  }
  let d;
  try {
    d = await deployment(args);
  } catch (e) {
    console.error(`box-config: ${e.message}`);
    return 2;
  }
  try {
    if (cmd === 'shell') {
      const out = shellAssignments(d.view, readStore(d.file));
      if (out) console.log(out);
      return 0;
    }
    if (cmd === 'set') {
      const v = args.indexOf('--value');
      if (v < 0 || args[v + 1] === undefined) throw new Error("say what to set: --value '{\"defaultModel\": \"opus\"}'");
      let changes;
      try {
        changes = JSON.parse(args[v + 1]);
      } catch {
        throw new Error('--value must be JSON');
      }
      await save(d, changes);
    }
    if (cmd === 'reset') {
      const paths = [];
      args.forEach((a, i) => { if (a === '--path' && args[i + 1]) paths.push(args[i + 1]); });
      writeStore(d.file, withoutPaths(readStore(d.file), paths));
    }
    console.log(JSON.stringify(statusOf(d, readStore(d.file))));
    return 0;
  } catch (e) {
    console.error(`box-config: ${e.message}`);
    return 1;
  }
}

const invokedDirectly = () => {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
// Not a top-level await: saving validates with infra/config.js, which imports this
// module, and a module still awaiting at its top level cannot be imported by one
// it is waiting on. That cycle deadlocked `set` on the box (node exits 13).
if (process.argv[1] && invokedDirectly()) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
