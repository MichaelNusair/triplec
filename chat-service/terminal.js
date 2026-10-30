/**
 * Terminals for the mux: the real Claude Code CLI, in a browser pane.
 *
 * A terminal pane is the `cc` surface, not a new one. The relay runs `cc` itself —
 * `cc demo` for a project's own checkout, `cc demo/slot-3` for a slot — on a
 * pseudo-terminal, and `cc` does what it always does: start the tmux session if it
 * is missing, then attach. So the session belongs to claude-tmux.service, not to
 * this process and not to the browser. Close the laptop and the Claude in it keeps
 * going; attach from a phone, from the editor's terminal or from another pane and
 * it is the same session, the same screen, the same process.
 *
 * What this module owns is the part between: which session a pane may ask for, the
 * relay (term-relay.py, because Node has no pty without a native module), and the
 * socket. It never builds a shell command — the project name is validated by
 * `projectPathFor` and the slot is a number, and both reach `cc` as argv.
 *
 * Socket protocol, at /ws/term?project=<name>&slot=<0-8>&cols=&rows=:
 *   browser → here: JSON text — {type:'input', data}, {type:'resize', cols, rows},
 *                   {type:'scroll', lines} (negative is up)
 *   here → browser: binary frames, the terminal's bytes; JSON text for state —
 *                   {type:'attached', session, existed}, {type:'exit', code},
 *                   {type:'error', message}
 *
 * And POST /api/term/paste?project=&slot=, an image as the body: see savePaste.
 */
import { spawn, execFile } from 'child_process';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'fs/promises';
import { randomBytes } from 'crypto';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { projectPathFor } from './session-manager.js';
import { canHaveSlots, ensureSlot, parseSlot, slotPath } from './slots.js';
import { HOST_MODE } from './host.js';
import { hasRegistry, slotConfigFor } from './projects.js';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

// Overridable for term-test.js, which has no tmux and no `cc` on the deploy box.
const RELAY = process.env.TERM_RELAY || join(here, 'term-relay.py');
const PYTHON = process.env.TERM_PYTHON || 'python3';
// Where the installer put `cc`: /usr/local/bin on the workspace box, ~/.local/bin on
// a host install, which says so in CC_SCRIPT.
const CC = process.env.CC_SCRIPT || (HOST_MODE ? join(process.env.HOME || '', '.local', 'bin', 'cc') : '/usr/local/bin/cc');
const TMUX = process.env.TMUX_BIN || 'tmux';

/**
 * The session a pane asks for: a project, and a slot in it or 0 for its own checkout.
 *
 * The names are `cc`'s, and have to stay so: `claude-<project>` for the checkout is
 * the session the editor's Claude button opens, and `claude-<project>/slot-N` is
 * what `cc <project>/slot-N` opens from any other terminal.
 */
export function terminalTarget(project, slotValue) {
  const path = projectPathFor(project);
  const { count } = slotConfigFor(path);
  const slot = Number(slotValue) === 0 || slotValue === '0' ? 0 : parseSlot(slotValue, count);
  if (slot === null) throw new Error(`slot must be 0, for the project itself, or 1 to ${count}`);
  const name = slot ? `${project}/slot-${slot}` : project;
  return { project, slot, projectPath: path, dir: slot ? slotPath(path, slot) : path, name, session: `claude-${name}` };
}

async function tmux(args) {
  try {
    const { stdout } = await execFileAsync(TMUX, args, { timeout: 5000 });
    return { ok: true, out: (stdout || '').trim() };
  } catch (err) {
    return { ok: false, out: '', err: (err.stderr || err.message || '').toString().trim() };
  }
}

/**
 * Mark which of a project's places — its own checkout and each slot — has a terminal
 * session alive, on an answer from `manager.slots`. A live session is a terminal
 * pane's to rejoin, and the reason a slot reads as taken.
 */
export async function withTerminals(answer) {
  const sessions = await tmuxSessions();
  return {
    ...answer,
    rootTerminal: sessions.has(`claude-${answer.name}`),
    slots: (answer.slots || []).map((s) => ({ ...s, terminal: sessions.has(`claude-${answer.name}/slot-${s.n}`) })),
  };
}

/** Every tmux session on this box, by name. Empty when there is no server. */
export async function tmuxSessions() {
  const res = await tmux(['list-sessions', '-F', '#{session_name}']);
  return new Set(res.ok && res.out ? res.out.split('\n') : []);
}

/**
 * The tmux server's pid, or null when there is none.
 *
 * Asked before every terminal, because the answer decides whether one may start. With
 * no server, `cc` would start one — and a server started from here is a child of
 * claude-chat.service, in its cgroup, so the next restart of this service (every
 * deploy) would end every session in it. That is the failure claude-tmux.service
 * exists to prevent; see AGENTS.md on the tmux cgroup.
 */
export async function tmuxServerPid() {
  const res = await tmux(['display-message', '-p', '#{pid}']);
  const pid = Number(res.out);
  return res.ok && Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Scroll a session's history, in tmux's own copy mode.
 *
 * The browser's terminal has no history of its own to scroll: tmux draws on the
 * alternate screen, so the scrollback lives in tmux. Doing this here rather than
 * turning on tmux's mouse mode leaves the session's options exactly as `cc` set
 * them, for every other terminal attached to it. `-e` leaves copy mode on its own
 * once scrolled back to the bottom.
 */
async function scroll(session, lines) {
  const n = Math.max(1, Math.min(Math.abs(Math.trunc(lines)) || 1, 200));
  if (lines < 0) await tmux(['copy-mode', '-e', '-t', `=${session}:`]);
  await tmux(['send-keys', '-t', `=${session}:`, '-X', '-N', String(n), lines < 0 ? 'scroll-up' : 'scroll-down']);
}

function frame(kind, payload) {
  const head = Buffer.alloc(5);
  head.write(kind, 0, 'latin1');
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

const clampSize = (value, fallback) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 2 && n <= 1000 ? n : fallback;
};

/**
 * Serve one terminal socket. `query` is the upgrade request's URLSearchParams.
 */
export async function serveTerminal(ws, query) {
  const sendJson = (msg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const fail = (message) => {
    sendJson({ type: 'error', message });
    ws.close();
  };

  let target;
  try {
    target = terminalTarget(query.get('project'), query.get('slot'));
  } catch (err) {
    fail(err.message);
    return;
  }

  if (!(await stat(target.projectPath).catch(() => null))?.isDirectory()) {
    fail(`no project named "${target.project}"`);
    return;
  }
  if (target.slot && !(await stat(join(target.dir, '.git')).catch(() => null))) {
    // A slot nobody has used yet. Made here rather than refused, because the pane
    // asking is the first use; refreshing it is the mux's job, before it asks.
    if (!(await canHaveSlots(target.projectPath))) {
      fail('this project has no git repository at its root, so it has no slots');
      return;
    }
    const made = await ensureSlot(target.projectPath, target.slot);
    if (!made.ok) {
      fail(made.error);
      return;
    }
  }

  if (!(await tmuxServerPid())) {
    fail('no tmux server is running, so a terminal started now would end at the next deploy — '
      + 'check `systemctl status claude-tmux`');
    return;
  }

  const existed = (await tmuxSessions()).has(target.session);
  const cols = clampSize(query.get('cols'), 100);
  const rows = clampSize(query.get('rows'), 30);
  // `-I`: the relay is ours, and nothing in the environment or the working directory
  // gets to change which Python modules it loads.
  // With a registry a project's directory is not `$PROJECTS_ROOT/<name>`, so `cc` is
  // handed the directory itself and told the name to give the session — the same
  // `claude-<name>` this side looks for, rather than one built from the path.
  const ccArg = hasRegistry() ? target.dir : target.name;
  const relay = spawn(PYTHON, ['-I', RELAY, String(cols), String(rows), CC, ccArg], {
    cwd: target.dir,
    env: {
      ...process.env,
      CC_SESSION_NAME: target.name,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: process.env.LANG || 'C.UTF-8',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  sendJson({ type: 'attached', session: target.session, existed, dir: target.dir });

  relay.stdout.on('data', (chunk) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(chunk, { binary: true });
    // A page that cannot keep up — a phone on a bad network, a tab in the
    // background — is let to fall behind by a few megabytes, not without limit.
    if (ws.bufferedAmount > 8 * 1024 * 1024 && !relay.stdout.isPaused()) {
      relay.stdout.pause();
      const resume = setInterval(() => {
        if (ws.readyState !== ws.OPEN || ws.bufferedAmount < 1024 * 1024) {
          clearInterval(resume);
          relay.stdout.resume();
        }
      }, 100);
    }
  });
  let stderr = '';
  relay.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-2000); });
  relay.stdin.on('error', () => { /* the relay is gone; its exit says why */ });

  relay.on('exit', (code) => {
    if (code && stderr.trim()) console.error(`terminal ${target.session}: relay exited ${code}: ${stderr.trim()}`);
    sendJson({ type: 'exit', code });
    ws.close();
  });
  relay.on('error', (err) => fail(`could not start the terminal: ${err.message}`));

  ws.on('message', (raw, isBinary) => {
    if (relay.exitCode !== null || relay.stdin.destroyed) return;
    if (isBinary) {
      relay.stdin.write(frame('d', Buffer.from(raw)));
      return;
    }
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'input' && typeof msg.data === 'string') {
      relay.stdin.write(frame('d', Buffer.from(msg.data, 'utf8')));
    } else if (msg.type === 'resize') {
      const size = Buffer.alloc(4);
      size.writeUInt16BE(clampSize(msg.cols, cols), 0);
      size.writeUInt16BE(clampSize(msg.rows, rows), 2);
      relay.stdin.write(frame('r', size));
    } else if (msg.type === 'scroll' && Number.isFinite(msg.lines) && msg.lines !== 0) {
      scroll(target.session, msg.lines).catch(() => {});
    }
  });

  // The page went away: close the relay's stdin, which hangs up `tmux attach`. That is
  // a detach — the session and the Claude in it carry on.
  ws.on('close', () => {
    if (!relay.stdin.destroyed) relay.stdin.end();
  });
}

/** Read a file of the vendored terminal emulator, for the static routes. */
export async function vendorFile(name) {
  const files = {
    'xterm.js': ['@xterm/xterm/lib/xterm.js', 'text/javascript; charset=utf-8'],
    'xterm.css': ['@xterm/xterm/css/xterm.css', 'text/css; charset=utf-8'],
    'addon-fit.js': ['@xterm/addon-fit/lib/addon-fit.js', 'text/javascript; charset=utf-8'],
  };
  const entry = files[name];
  if (!entry) return null;
  const path = join(here, 'node_modules', entry[0]);
  const info = await stat(path);
  return { body: await readFile(path), type: entry[1], etag: `"${info.size}-${Math.floor(info.mtimeMs)}"` };
}

/*
 * An image pasted or dropped into a terminal pane.
 *
 * Claude Code's own image paste reads the clipboard of the machine it runs on, which
 * is this box, not the browser — so in a pane it finds nothing. What the CLI does take
 * is a path to an image, the way a terminal hands it a dropped file. So the page
 * uploads the image here, and pastes the path it gets back.
 *
 * Kept under the temp directory, apart per session, and only for a day: the path is
 * read when the message is sent, and nothing needs it after.
 */
const PASTE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
export const PASTE_LIMIT = 20 * 1024 * 1024;
const PASTE_ROOT = process.env.TERM_PASTE_DIR || join(tmpdir(), 'triplec-term-paste');
const PASTE_KEEP_MS = 24 * 60 * 60 * 1000;

export async function savePaste(project, slotValue, type, body) {
  const target = terminalTarget(project, slotValue);
  const ext = PASTE_TYPES[String(type || '').split(';')[0].trim().toLowerCase()];
  if (!ext) throw Object.assign(new Error('only a PNG, JPEG, GIF or WebP image can be pasted'), { status: 415 });
  if (!body?.length) throw Object.assign(new Error('the image is empty'), { status: 400 });
  // The session name has a slash in it for a slot; the directory does not.
  const dir = join(PASTE_ROOT, target.name.replace(/[^A-Za-z0-9._-]/g, '_'));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await prunePastes(dir);
  const path = join(dir, `paste-${Date.now()}-${randomBytes(4).toString('hex')}.${ext}`);
  await writeFile(path, body, { mode: 0o600 });
  return path;
}

async function prunePastes(dir) {
  const now = Date.now();
  for (const name of await readdir(dir).catch(() => [])) {
    const path = join(dir, name);
    const info = await stat(path).catch(() => null);
    if (info?.isFile() && now - info.mtimeMs > PASTE_KEEP_MS) await unlink(path).catch(() => {});
  }
}
