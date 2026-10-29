#!/usr/bin/env node
/**
 * The live half of scripts/host-conformance.sh: talks to an installed host-mode
 * service the way a browser does, over its login and its chat socket.
 *
 *   node host-conformance-live.mjs <check> [--base URL] [--cwd DIR] [--timeout S]
 *
 * Checks:
 *   ping        a chat socket receives an application ping within 30 seconds (C3)
 *   reply       a chat message gets an answer, with whatever credentials the CLI
 *               has — the `claude /login` case (B1). Costs one short model call.
 *   permission  a tool call that needs approval reaches the socket as a
 *               permission_request, and denying it blocks it (D1). Costs a call.
 *
 * Logs in with AUTH_PASSWORD from TRIPLEC_SECRETS_FILE (or the environment), never
 * prints it, and exits 0 on PASS, 1 on FAIL, printing one line of evidence either
 * way. `ws` is resolved from the installed chat service, so this needs nothing of
 * its own.
 */
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { join } from 'path';

const args = process.argv.slice(2);
const check = args[0];
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const base = opt('base', `http://127.0.0.1:${process.env.PORT || 9997}`);
const cwd = opt('cwd', '');
const timeoutS = Number(opt('timeout', check === 'ping' ? 35 : 180));
const installDir = opt('install-dir', process.env.TRIPLEC_INSTALL_DIR || join(process.env.HOME || '', '.local/share/triplec'));

const require = createRequire(join(installDir, 'chat-service', 'package.json'));
const { WebSocket } = require('ws');

function password() {
  if (process.env.AUTH_PASSWORD) return process.env.AUTH_PASSWORD;
  const file = process.env.TRIPLEC_SECRETS_FILE;
  if (!file) return '';
  const line = readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('AUTH_PASSWORD='));
  return line ? line.slice('AUTH_PASSWORD='.length).trim() : '';
}

const done = (ok, evidence) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${evidence}`);
  process.exit(ok ? 0 : 1);
};

const pw = password();
if (!pw) done(false, 'no AUTH_PASSWORD to sign in with (password login is off, or the secrets file is unreadable)');
const login = await fetch(`${base}/api/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: pw }),
}).catch((err) => ({ status: 0, err }));
if (login.status !== 204) done(false, `login answered ${login.status}`);
const cookie = (login.headers.get('set-cookie') || '').split(';')[0];

const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`, { headers: { Cookie: cookie } });
const timer = setTimeout(() => done(false, `${check}: nothing conclusive within ${timeoutS}s`), timeoutS * 1000);
const started = Date.now();
let attached = false;
let asked = null;

ws.on('error', (err) => done(false, `socket error: ${err.message}`));
ws.on('open', () => {
  if (check === 'ping') return;
  if (!cwd) done(false, `${check} needs --cwd, a directory inside a registered project`);
  ws.send(JSON.stringify({ type: 'start', cwd, permissionMode: check === 'permission' ? 'manual' : undefined }));
});
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'error' && msg.fatal) done(false, `the service refused: ${msg.message}`);
  if (check === 'ping' && msg.type === 'ping') {
    clearTimeout(timer);
    done(Date.now() - started <= 30_000, `application ping after ${Math.round((Date.now() - started) / 1000)}s`);
  }
  if (msg.type === 'attached' && !attached) {
    attached = true;
    const text = check === 'reply'
      ? 'Reply with exactly the word PONG and nothing else. Do not use any tools.'
      : 'Use the Bash tool to run exactly: touch triplec-conformance-probe.txt  — run it once, and if it is refused, say REFUSED and stop.';
    ws.send(JSON.stringify({ type: 'message', text }));
  }
  if (check === 'reply' && msg.type === 'assistant_text') {
    clearTimeout(timer);
    done(/PONG/.test(msg.text), `reply: ${JSON.stringify(msg.text.slice(0, 80))}`);
  }
  if (check === 'permission' && msg.type === 'permission_request' && !asked) {
    asked = msg;
    ws.send(JSON.stringify({ type: 'permission', requestId: msg.requestId, decision: 'deny' }));
  }
  if (check === 'permission' && msg.type === 'turn_complete') {
    clearTimeout(timer);
    done(Boolean(asked), asked
      ? `${asked.toolName} asked for approval on the socket and was denied`
      : 'the turn ended without a permission request (is the mode bypassPermissions, or the command pre-approved?)');
  }
  if (msg.type === 'exit') done(false, `the CLI exited (code ${msg.code})`);
});
