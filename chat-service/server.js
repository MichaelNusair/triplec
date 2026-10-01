/**
 * Chat backend: static PWA + JSON API + WebSocket bridge to the Claude CLI,
 * plus the voice transcription endpoint.
 *
 * Listens on localhost only, behind nginx, which terminates TLS.
 *
 * Authentication is enforced *here*, not in the proxy. This service starts a
 * `claude` process with shell access, so an unauthenticated request to it is an
 * unauthenticated command execution — and the previous version of this file
 * said the proxy handled that while the proxy config had no such rule. See
 * auth.js.
 */
import http from 'http';
import { readFile, stat } from 'fs/promises';
import { join, extname, normalize, sep } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { WebSocketServer } from 'ws';
import { SessionManager, PROJECTS_ROOT, DEFAULT_MODEL } from './session-manager.js';
import { transcribe, voiceStatus, resetConfigCache } from './transcribe.js';
import { polish } from './polish.js';
import {
  prepare as prepareSpeech,
  speakSegment,
  speechStatus,
  resetSpeech,
  SILENT_WAV,
} from './speak.js';
import { mintSession, realtimeStatus } from './realtime.js';
import { buildInfo, applyBuildStamp } from './build.js';
import { claudeStatus, firstPromptFor } from './claude-status.js';
import {
  manifestForProject,
  chatManifest,
  applyDeploymentName,
  deploymentName,
} from './manifest.js';
import { vapidPublicKey, addSubscription, removeSubscription, listSubscriptions, notifyAll, topicFor, wasGone, describeDevice } from './push.js';
import { startTurnWatcher } from './turn-watcher.js';
import { createAdmin } from './admin.js';
import {
  AUTH_MODE,
  assertAuthConfig,
  isAuthenticated,
  isOpenPath,
  verifyPassword,
  sessionCookie,
  clearedCookie,
  throttleStatus,
  recordFailure,
  recordSuccess,
  clientIp,
} from './auth.js';

// Fail fast and loudly: a misconfigured deployment must not boot into an open
// state. This throws before the listener is created.
assertAuthConfig();

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 9997);
const PUBLIC_DIR = join(__dirname, 'public');

const manager = new SessionManager();
// The operations surface. In this process, behind this process's gate: a second
// app at /admin would mean a second authentication implementation, and the reason
// this file authenticates at all is that the last thing to own that decision was
// a proxy comment. See admin.js.
const admin = createAdmin({ manager });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const json = (res, code, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

/**
 * A refusal from the voice, answered with the status it carries.
 *
 * None of these are bugs, and each one has something the client can do about it:
 * 404 means prepare the text again (which is free), 429 means the day's character
 * budget is spent for that provider, 403 means this instance's role cannot call
 * Polly, and 409 means the message is in Hebrew and this box has no voice that can
 * say it — the one refusal whose fallback is better than what it refused, since a
 * phone's own voice does speak Hebrew and Polly would have read silence. The overlay's
 * response to all of them is the same — go back to the browser's own voice — so
 * the sentence travels in the body, where the status sheet can show it instead of
 * the read just going quiet. Anything without a status is a real error and is left
 * to the handler's own catch, which logs it and answers 500.
 */
const speakRefusal = (res, err) => {
  if (err?.name !== 'SpeakError') throw err;
  // The ones an operator has to fix, rather than the ones a client causes.
  if (err.status === 403 || err.status >= 500) console.warn('speak:', err.message);
  json(res, err.status, { error: err.message });
};

async function readBody(req, limit = 32 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Asset URLs are stamped with the build's mtime so a client holding a stale
// copy under the old URL can never serve it for the new one. Browsers that
// cached app.js while it was still `max-age=3600` would otherwise never
// re-request it, and no server-side header change can reach them.
let assetVersion = null;
async function getAssetVersion() {
  if (assetVersion) return assetVersion;
  const files = ['app.js', 'style.css', 'admin.js'];
  let newest = 0;
  for (const f of files) {
    try {
      const info = await stat(join(PUBLIC_DIR, f));
      newest = Math.max(newest, info.mtimeMs);
    } catch {
      /* missing file is handled by the request path */
    }
  }
  assetVersion = String(Math.floor(newest)) || '1';
  return assetVersion;
}

async function serveStatic(req, res, pathname) {
  // Resolve inside PUBLIC_DIR only — never trust the request path.
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC_DIR, rel);
  // Compare against the directory *plus a separator*: a bare startsWith would
  // also accept a sibling directory whose name merely begins with PUBLIC_DIR.
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + sep)) {
    json(res, 403, { error: 'forbidden' });
    return;
  }

  try {
    let data = await readFile(file);

    // Rewrite asset references in any of our HTML shells to include the version
    // stamp. Paths are /chat/-prefixed because nginx routes the chat's assets
    // there and strips the prefix before it reaches us; the catch-all at /
    // belongs to code-server.
    //
    // Matched by pattern rather than by exact string. There are two shells now
    // (index.html and admin.html), and the failure mode of the old exact-string
    // pair was silent — an unstamped asset is only visible as a browser holding a
    // stale copy days later — so a second copy of that hazard is not worth the
    // literal it saves.
    if (file.endsWith('.html')) {
      const v = await getAssetVersion();
      // Which build this response came from, for the shell to remember. It is the
      // only way a running page can later notice it is older than the server —
      // see applyBuildStamp in build.js.
      const build = await buildInfo();
      data = Buffer.from(
        applyBuildStamp(
          applyDeploymentName(
            data
              .toString()
              .replace(/(src|href)="(\/chat\/[A-Za-z0-9._-]+\.(?:js|css))"/g, `$1="$2?v=${v}"`),
          ),
          build.id,
        ),
      );
    }

    /*
     * The chat app's own manifest, wearing this deployment's name — the icon on a
     * home screen says which deployment it opens, the way a project's does.
     *
     * Rewritten here rather than at deploy time, and rather than through a route of
     * its own, so it stays one file: pwa/manifest.webmanifest is what ships, and the
     * name is the only thing this process knows that the file cannot. Guarded on the
     * name so an unnamed deployment serves those bytes untouched rather than a
     * re-serialised copy of them.
     */
    if (file.endsWith('.webmanifest') && deploymentName()) {
      try {
        data = Buffer.from(`${JSON.stringify(chatManifest(JSON.parse(data.toString())), null, 2)}\n`);
      } catch {
        // Not JSON, so not something to rename. Serve it as it is: a manifest that
        // installs under the wrong name beats no manifest at all.
      }
    }

    // Revalidate app code and the shell on every load. A stale app.js paired
    // with fresh HTML is a silent breakage that looks like "stuck loading", and
    // these files are small enough that a 304 round-trip costs nothing.
    const revalidate = /\.(html|js|css|webmanifest)$/.test(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Cache-Control': revalidate ? 'no-cache' : 'public, max-age=86400',
      ETag: `"${data.length}-${(await stat(file)).mtimeMs}"`,
    });
    res.end(data);
  } catch {
    // Single-page app: unknown paths fall back to the shell.
    try {
      const shell = await readFile(join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      // Named here too: a tab that opened on an unknown path is still this
      // deployment's app, and the client reads its own name out of this shell.
      res.end(applyDeploymentName(shell.toString()));
    } catch {
      json(res, 404, { error: 'not found' });
    }
  }
}

/**
 * Reject an unauthenticated request. A browser navigating to a page gets sent to
 * the login form; anything else gets a 401 the client can act on. Both say only
 * that authentication is required — never whether the path exists, so this
 * cannot be used to enumerate projects or routes.
 */
function denyUnauthenticated(req, res) {
  const wantsHtml = (req.headers.accept || '').includes('text/html');
  if (wantsHtml) {
    // Carry the requested path through the login so the user lands where they
    // were going. Only the path and query are forwarded, and the login page
    // additionally refuses anything that isn't a same-origin relative path —
    // echoing a caller-supplied URL back into a redirect is how a login page
    // becomes an open redirect.
    const target = req.url && req.url.startsWith('/') ? req.url : '/';
    const next = encodeURIComponent(target);
    res.writeHead(302, { Location: `/login?next=${next}`, 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  json(res, 401, { error: 'authentication required' });
}

async function handleLogin(req, res) {
  if (AUTH_MODE !== 'password') {
    // With an identity provider in front, a local password would be a second,
    // weaker door into the same box.
    json(res, 400, { error: 'password login is disabled; this deployment uses OIDC' });
    return;
  }

  const ip = clientIp(req);
  const throttle = throttleStatus(ip);
  if (throttle.locked) {
    res.writeHead(429, {
      'Content-Type': 'application/json; charset=utf-8',
      'Retry-After': String(throttle.retryAfter),
    });
    res.end(JSON.stringify({ error: 'too many attempts', retryAfter: throttle.retryAfter }));
    return;
  }

  let password = '';
  try {
    // Small cap: a login body is a few dozen bytes, and this route is reachable
    // without a session, so it must not be an unauthenticated memory sink.
    const body = JSON.parse((await readBody(req, 4 * 1024)).toString() || '{}');
    password = typeof body.password === 'string' ? body.password : '';
  } catch {
    json(res, 400, { error: 'malformed request' });
    return;
  }

  if (!verifyPassword(password)) {
    recordFailure(ip);
    // Logged without the attempted value: writing guesses to the journal turns
    // a log leak into a credential leak, and near-misses are still secrets.
    console.warn(`failed login from ${ip}`);
    json(res, 401, { error: 'incorrect password' });
    return;
  }

  recordSuccess(ip);
  console.log(`login from ${ip}`);
  res.writeHead(204, { 'Set-Cookie': sessionCookie(), 'Cache-Control': 'no-store' });
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  try {
    if (pathname === '/healthz') {
      json(res, 200, { ok: true });
      return;
    }

    // Lets the client show the right thing on a 401: a password form, or a
    // "sign in with your identity provider" bounce. Reveals no secret.
    if (pathname === '/api/auth-mode' && req.method === 'GET') {
      json(res, 200, { mode: AUTH_MODE });
      return;
    }

    if (pathname === '/api/login' && req.method === 'POST') {
      await handleLogin(req, res);
      return;
    }

    if (pathname === '/login' || pathname === '/login.html') {
      // Self-contained page: it must render before any authenticated asset
      // loads, so its CSS is inline and it needs nothing else from the server.
      await serveStatic(req, res, '/login.html');
      return;
    }

    // ---- Everything past this line requires a session. ---------------------
    // Deliberately positioned so that a route added below cannot be reached
    // without authentication, whatever the author of that route forgets.
    if (!isOpenPath(pathname) && !(await isAuthenticated(req))) {
      denyUnauthenticated(req, res);
      return;
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      res.writeHead(204, { 'Set-Cookie': clearedCookie() });
      res.end();
      return;
    }

    // Reached only with a valid session — the gate above returns 401 otherwise.
    // Lets the client tell "session expired" apart from "network dropped", which
    // look identical from a closed WebSocket.
    if (pathname === '/api/auth-check') {
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }

    if (pathname === '/api/projects' && req.method === 'GET') {
      json(res, 200, { projects: await manager.listProjects(), defaultModel: DEFAULT_MODEL });
      return;
    }

    /*
     * A manifest per project, which is how a project gets a window of its own.
     *
     * Android gives an installed web app one window and no API changes that, so
     * "another window" there has to be another installed app — and app identity is
     * the manifest `id`. Serving a different id per project turns one add-to-home-
     * screen into a second icon with its own task in the recents switcher. See
     * manifest.js.
     *
     * Gated like everything else, which is why the `<link rel="manifest">` that
     * points here carries `crossorigin="use-credentials"`: a manifest is fetched
     * with credentials omitted by default, and this route answers 401 to that.
     * The overlay injects the link; index.html has carried the same attribute
     * since the chat app was installable.
     *
     * Matched before the static handler, and only with `?project=`, so
     * /manifest.webmanifest still serves the chat app's own file.
     */
    if (pathname === '/manifest.webmanifest' && url.searchParams.has('project')) {
      let manifest;
      try {
        manifest = await manifestForProject(url.searchParams.get('project'));
      } catch (err) {
        json(res, err.code === 'ENOPROJECT' ? 404 : 400, { error: err.message });
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/manifest+json',
        // Chrome re-reads the manifest to decide whether an installed app changed.
        // A cached copy would pin a project's window to a stale start_url.
        'Cache-Control': 'no-cache',
      });
      res.end(JSON.stringify(manifest));
      return;
    }

    if (pathname === '/api/projects' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const { name, github, private: isPrivate, description } = body;
      // Creating the GitHub repo involves network calls, so this can take a few
      // seconds; the client shows progress rather than assuming it's instant.
      json(res, 200, {
        project: await manager.createProject(name, {
          github: Boolean(github),
          private: isPrivate !== false,
          description: typeof description === 'string' ? description.slice(0, 200) : '',
        }),
      });
      return;
    }

    // What deleting this project would cost, asked before anything is offered.
    if (pathname === '/api/project-status' && req.method === 'GET') {
      const name = url.searchParams.get('name');
      if (!name) {
        json(res, 400, { error: 'name is required' });
        return;
      }
      json(res, 200, { status: await manager.projectStatus(name) });
      return;
    }

    // Commit, push, verify, then delete from the machine. This is irreversible,
    // so a refused removal comes back as 409 with the reason and the repository
    // state that produced it — the client turns that into a specific question
    // rather than a generic failure. `force` is the answer to that question, and
    // must never be the default.
    if (pathname === '/api/projects/remove' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 4 * 1024)).toString() || '{}');
      if (!body.name) {
        json(res, 400, { error: 'name is required' });
        return;
      }
      try {
        json(res, 200, await manager.removeProject(body.name, { force: body.force === true }));
      } catch (err) {
        if (!err.blocked) throw err;
        console.warn(`refused to remove ${body.name}: ${err.message}`);
        json(res, 409, { error: err.message, canForce: true, status: err.status, steps: err.steps });
      }
      return;
    }

    // Bring an existing GitHub repository into the workspace. Cloning is slow
    // enough on a phone to need its own progress reporting client-side.
    //
    // `into` names an existing project to clone *inside*, which is how a project
    // comes to hold more than one repository — the workspace shape where `api/`
    // and `web/` are separate repos opened as one project.
    if (pathname === '/api/projects/clone' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 4 * 1024)).toString() || '{}');
      json(res, 200, {
        project: await manager.cloneProject({
          repo: body.repo,
          name: body.name,
          into: body.into,
        }),
      });
      return;
    }

    if (pathname === '/api/github/repos' && req.method === 'GET') {
      json(res, 200, { repos: await manager.listGithubRepos() });
      return;
    }

    if (pathname === '/api/transcript' && req.method === 'GET') {
      const cwd = url.searchParams.get('cwd');
      const sessionId = url.searchParams.get('sessionId');
      if (!cwd || !sessionId) {
        json(res, 400, { error: 'cwd and sessionId are required' });
        return;
      }
      json(res, 200, { messages: await manager.loadTranscript(cwd, sessionId) });
      return;
    }

    // Client-side errors land here so a failure that only happens on one device
    // is visible in `journalctl -u claude-chat` instead of being invisible.
    if (pathname === '/api/client-error' && req.method === 'POST') {
      const body = (await readBody(req, 64 * 1024)).toString();
      console.error('CLIENT ERROR:', body.slice(0, 1200));
      res.writeHead(204);
      res.end();
      return;
    }

    /*
     * Whether a project could be installed, answered by the phone that could not
     * install it.
     *
     * This is the one failure in the app that leaves no trace a log can reach.
     * Whether a browser offers to install a project depends on what is already on
     * that home screen; Android refuses silently — no request, no status, no console
     * anyone else can open — and the device it happens on is a phone in someone's
     * hand. It has been reported three times and answered from inference every time.
     * So the overlay sends what it saw, and this box's own journal holds it beside
     * the request that fetched the manifest:
     *
     *   journalctl -u claude-chat | grep INSTALL
     *
     * console.log rather than console.error, because an install that worked reports
     * too and a line saying so is not an error. installFacts in
     * pwa/mobile-overlay.js is the other end, and names the fields.
     */
    if (pathname === '/api/install-report' && req.method === 'POST') {
      const body = (await readBody(req, 4 * 1024)).toString();
      // One line: journalctl folds a multi-line entry into something grep answers
      // with half of.
      console.log('INSTALL:', body.replace(/\s+/g, ' ').slice(0, 600));
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === '/api/voice-status' && req.method === 'GET') {
      // ?refresh=1 re-reads the secret, so a rotated key or a newly created
      // deployment takes effect without restarting the service.
      if (url.searchParams.get('refresh')) {
        resetConfigCache();
        resetSpeech();
      }
      // Both directions in one answer: which engine will hear you (transcribe.js)
      // and which voice will read to you (speak.js). The overlay asks once and
      // builds its mic button and its voice picker from the reply, and `speech`
      // never throws — a box that cannot synthesise says so and keeps the
      // browser's own voice.
      json(res, 200, {
        ...(await voiceStatus()),
        speech: await speechStatus({ lang: url.searchParams.get('lang') || 'en' }),
        // And whether this box can hold a spoken conversation about a message,
        // which is a separate question from whether it can read one out: the same
        // key, a different model, and its own daily count. A client that only asked
        // about `speech` would offer a button that answers 503.
        realtime: await realtimeStatus(),
      });
      return;
    }

    /*
     * Start a spoken conversation about one finished message.
     *
     * This mints a two-minute credential for the browser to open a WebRTC session
     * with OpenAI *directly* — the audio never passes through this box, because a
     * relay on an instance that is also running a compiler is latency, and latency
     * is the whole feature. See realtime.js for why the conversation is deliberately
     * unable to reach Claude, and for what bounds the cost.
     *
     * Behind the session gate like every other /api/ route: `OPEN_PATHS` in auth.js
     * is an allowlist, so this is authenticated by not being on it. That matters more
     * here than elsewhere — the response body is a credential for a paid third-party
     * service — hence `no-store` as well, so it is not written to a disk cache on a
     * shared phone.
     *
     * The client chooses nothing that costs money: the model, the session's length,
     * the instructions and the absence of tools are all decided in realtime.js. What
     * it sends is the message to talk about, the prompt that produced it, and a voice
     * name — and the voice is checked against a list rather than passed through.
     */
    if (pathname === '/api/realtime/token' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString() || '{}');
      try {
        const minted = await mintSession({
          text: body.text,
          prompt: body.prompt,
          voice: body.voice,
          lang: body.lang,
        });
        const payload = JSON.stringify(minted);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(payload),
          'Cache-Control': 'no-store',
        });
        res.end(payload);
      } catch (err) {
        if (err?.name !== 'RealtimeError') throw err;
        if (err.status === 403 || err.status >= 500) console.warn('realtime:', err.message);
        json(res, err.status, { error: err.message });
      }
      return;
    }

    /*
     * Hear a dictation. `?lang=he` is a routing decision, not a hint: the model
     * installed on this box is English-only and answers Hebrew speech with fluent
     * English that nobody said, so a language other than English is sent to a hosted
     * model or refused. See transcribe.js. No parameter means English, which is what
     * every existing client sends and what the local model is for.
     */
    if (pathname === '/api/transcribe' && req.method === 'POST') {
      const body = await readBody(req);
      const text = await transcribe(body, req.headers['content-type'], {
        lang: url.searchParams.get('lang') || '',
      });
      json(res, 200, { text });
      return;
    }

    /*
     * Punctuate and capitalise a finished dictation, and fix the names the small
     * recognizers mangle. See polish.js: it is a repair pass with a hard timeout
     * that returns the original text on any failure, so this route answers 200
     * with something usable even when Bedrock is unreachable.
     *
     * The project names go in as vocabulary. They are the words this speaker says
     * most and the ones no general model could guess, and they are already visible
     * to any caller who can reach this route (`GET /api/projects`), so nothing new
     * is disclosed by sending them.
     */
    if (pathname === '/api/polish' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString() || '{}');
      const names = (await manager.listProjects().catch(() => [])).map((p) => p.name);
      const { text, changed } = await polish(body.text, { vocabulary: names });
      json(res, 200, { text, changed });
      return;
    }

    /*
     * Read a message out loud in a voice that sounds like a person, in two steps.
     *
     * The split is not ceremony: synthesis is billed per character and takes about
     * a fifth of the time its own audio takes to play, so `prepare` registers the
     * text and says how many pieces it is — free, instant, nothing synthesised —
     * and each piece is then fetched as it is needed while the previous one plays.
     * A read abandoned after the first sentence costs one short piece instead of a
     * whole message. See speak.js for the measurements the sizes come from.
     *
     * The text is whatever the client wants said. It is already the caller's own
     * conversation, reduced from markdown in the overlay, and it goes to one of two
     * synthesisers: Polly, on this instance's own role, for everything it can say,
     * and OpenAI for a message with Hebrew in it, which Polly cannot say at all.
     * Which one is not the client's choice to make — `chooseVoice` decides from the
     * text, and the answer names the voice that will read it, so a caller can see
     * where its words went. A box with no OpenAI key sends nothing to OpenAI and
     * refuses Hebrew with a 409 instead; see speak.js.
     */
    if (pathname === '/api/speak/prepare' && req.method === 'POST') {
      /*
       * Generous on purpose, and it has to be: `SPEAK_MAX_CHARS` is 40,000
       * characters, Hebrew is two bytes of UTF-8 each and an emoji four, so the body
       * carrying a message this will happily read can be several times its length in
       * characters. The refusal for text that is too long belongs to speak.js, which
       * answers 413 with a sentence the sheet can show — a limit here would throw
       * before that and outside the catch below, which is a 500 and no explanation.
       */
      const body = JSON.parse((await readBody(req, 512 * 1024)).toString() || '{}');
      try {
        // Awaited: choosing the voice depends on whether this box has an OpenAI
        // key, because a message with Hebrew in it cannot be given to Polly. The
        // key is read from Secrets Manager once per process, so this is a real
        // round trip on the first read after a restart and free afterwards.
        // `kind: 'code'` is the per-block read button: the body is one fenced block,
        // and what a listener hears is decided in speak.js so that both surfaces
        // hear the same thing. Anything else is prose the client already reduced.
        json(res, 200, await prepareSpeech(body.text, {
          voice: body.voice,
          kind: body.kind === 'code' ? 'code' : 'prose',
          lang: typeof body.lang === 'string' ? body.lang.slice(0, 20) : '',
        }));
      } catch (err) {
        speakRefusal(res, err);
      }
      return;
    }

    /*
     * The silence the tap unlocks the audio element with.
     *
     * Served from here, rather than being a `data:` URL in the overlay, because
     * the overlay runs in code-server's workbench under code-server's own
     * `media-src 'self'` — which blocks `data:` and `blob:` alike. See SILENT_WAV.
     *
     * Immutable: 44 bytes that will never change, asked for on every first tap.
     */
    if (pathname === '/api/speak/silence' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Content-Length': SILENT_WAV.length,
        'Cache-Control': 'private, max-age=86400, immutable',
      });
      res.end(SILENT_WAV);
      return;
    }

    /*
     * One piece of a prepared message, as a complete mp3.
     *
     * Complete, with a Content-Length, rather than streamed: iOS Safari is
     * unreliable about playing a media response it cannot range-request, and this
     * feature exists for a phone. The short first piece is what keeps the wait
     * before the first word to a couple of seconds.
     *
     * Cacheable because it is content-addressed — the id is a hash of the engine,
     * the voice and the words, and Polly is deterministic, so the same id can only
     * ever mean the same audio. `private` because it is a private conversation
     * being read aloud.
     */
    if (pathname === '/api/speak' && req.method === 'GET') {
      const id = url.searchParams.get('id') || '';
      if (!/^[0-9a-f]{8,64}$/.test(id)) {
        json(res, 400, { error: 'id is not a prepared message' });
        return;
      }
      try {
        const { audio, cached } = await speakSegment(id, Number(url.searchParams.get('segment') || 0));
        res.writeHead(200, {
          'Content-Type': 'audio/mpeg',
          'Content-Length': audio.length,
          'Cache-Control': 'private, max-age=600',
          // So `journalctl` and the tests can tell a synthesis from a re-read.
          'X-Speak-Cached': cached ? '1' : '0',
        });
        res.end(audio);
      } catch (err) {
        speakRefusal(res, err);
      }
      return;
    }

    /*
     * Who is live and who is working, and nothing else.
     *
     * The chat list and the tab strip both need to keep a badge honest while the
     * user is looking at a different conversation, and `GET /api/projects` cannot
     * be polled for it: that route stats every transcript and reads each file from
     * the start to build a title. This one touches no disk at all.
     */
    if (pathname === '/api/live' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ sessions: manager.liveSummary(), at: Date.now() }));
      return;
    }

    /*
     * Which build is running, so the app can show it and a stale tab can notice.
     *
     * Behind the gate with everything else: it names a commit of a private
     * repository, which is not a secret worth a route in the allowlist, and the
     * only caller is a page that is already signed in. `no-store` matters more than
     * it looks — a cached answer here would report the build of whatever was
     * running when the response was first made, which is precisely the mistake
     * this route exists to catch. See build.js.
     */
    if (pathname === '/api/version' && req.method === 'GET') {
      const build = await buildInfo();
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(build));
      return;
    }

    /*
     * Is Claude working in the editor's panel, and what did it last say.
     *
     * For the editor surface, not this one: the Claude Code panel reloads the
     * whole transcript on every page load and renders it oldest-first, so opening
     * a conversation on a second device means seconds of watching history scroll
     * before the newest message — the one you need in order to reply — appears.
     * That is inside a proprietary webview and cannot be changed from here. This
     * answers the same two questions from outside it, in tens of milliseconds, so
     * the overlay can say whether the wait is worth it. See claude-status.js.
     *
     * Reads only. It cannot start, stop or steer a conversation, and asking is not
     * counted as a page attaching to one.
     */
    if (pathname === '/api/claude-status' && req.method === 'GET') {
      const cwd = url.searchParams.get('cwd');
      if (!cwd) {
        json(res, 400, { error: 'cwd is required' });
        return;
      }
      // Optional: which conversation to answer about. Without it the answer is a
      // guess, because nothing outside the panel knows which one is on screen.
      // Constrained to the shape of a session id — it becomes a filename.
      const wanted = url.searchParams.get('sessionId');
      if (wanted && !/^[a-zA-Z0-9_-]{1,64}$/.test(wanted)) {
        json(res, 400, { error: 'sessionId is not a session id' });
        return;
      }
      let status;
      try {
        status = await claudeStatus(cwd, { sessionId: wanted || null });
      } catch (err) {
        json(res, 400, { error: err.message });
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        // Polled while a turn is in flight; a cached answer is a wrong answer.
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(status));
      return;
    }

    /*
     * The prompt a conversation began with, to be sent again.
     *
     * A separate route rather than another field on the answer above, because the
     * two have opposite lifetimes: that one is polled every four seconds while a
     * turn is in flight and is a different answer each time, while this one cannot
     * change for as long as the conversation exists. So a caller asks once per
     * conversation and keeps it — see claude-status.js for why it is read out of the
     * transcript rather than cached here.
     */
    if (pathname === '/api/first-prompt' && req.method === 'GET') {
      const cwd = url.searchParams.get('cwd');
      const wanted = url.searchParams.get('sessionId');
      if (!cwd || !wanted) {
        json(res, 400, { error: 'cwd and sessionId are required' });
        return;
      }
      let answer;
      try {
        // Both arguments become part of a filename; firstPromptFor checks their
        // shape and rejects anything else, as claudeStatus does.
        answer = await firstPromptFor(cwd, wanted);
      } catch (err) {
        json(res, 400, { error: err.message });
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        // Immutable, and still not cached: this is the text of a private
        // conversation, and the one caller keeps it in memory for as long as the
        // page lives. A disk cache would outlive the page on a shared phone.
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(answer));
      return;
    }

    /*
     * --- push notifications -------------------------------------------------
     *
     * The other half of the question above, for when you are not looking at the
     * app at all: a session you started in the editor panel or under tmux finishes
     * a turn, and the phone says so. See turn-watcher.js for what counts as
     * finishing, and push.js for the encryption.
     *
     * All four are gated. The public key is not a secret — it is handed to every
     * browser that subscribes — but an endpoint is: it is a capability to put a
     * notification on someone's lock screen, and the list of them is a list of the
     * operator's devices.
     */
    if (pathname === '/api/push/key' && req.method === 'GET') {
      json(res, 200, { key: await vapidPublicKey(), devices: (await listSubscriptions()).length });
      return;
    }

    /*
     * Whether the box agrees that *this* device is subscribed.
     *
     * The switch in settings used to be painted from `pushManager.getSubscription()`
     * alone, on the reasoning that a stored flag can disagree with the browser while
     * the browser cannot be wrong. It can: a subscription whose endpoint the push
     * service has forgotten, or that the box has pruned, is still handed back looking
     * perfectly healthy — right shape, right key — and the switch reads "on" over a
     * device the box cannot reach. That is the lie this answers.
     *
     * A POST because an endpoint is far too long to put in a query string and has no
     * business in an access log. It returns a count and a yes/no, never the list: the
     * endpoints are capabilities to write to someone's lock screen, as the note on
     * /api/push/key says.
     */
    if (pathname === '/api/push/status' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 8 * 1024)).toString() || '{}');
      const devices = await listSubscriptions();
      const endpoint = String(body.endpoint || '');
      json(res, 200, {
        devices: devices.length,
        known: Boolean(endpoint) && devices.some((d) => d.endpoint === endpoint),
      });
      return;
    }

    if (pathname === '/api/push/subscribe' && req.method === 'POST') {
      // A subscription is what `pushManager.subscribe()` hands back, passed
      // through unchanged. push.js validates it rather than trusting it.
      const body = JSON.parse((await readBody(req, 8 * 1024)).toString() || '{}');
      const ua = req.headers['user-agent'] || '';
      try {
        /*
         * An endpoint the push service has already refused is not worth storing: the
         * next notification would be refused too and it would be pruned again, which
         * is the loop that kept this quietly broken. Say so instead — the device
         * cannot work this out for itself, because the dead subscription still looks
         * healthy in the browser and its key still matches ours.
         */
        if (wasGone(body.endpoint)) {
          console.log(`push: ${describeDevice(ua)} re-offered an endpoint the push service has forgotten; asking it for a new one`);
          json(res, 200, { devices: (await listSubscriptions()).length, gone: true });
          return;
        }
        const devices = await addSubscription(body, { ua });
        console.log(`push: subscribed a device (${devices.length} now)`);
        json(res, 200, { devices: devices.length });
      } catch (err) {
        json(res, 400, { error: err.message });
      }
      return;
    }

    if (pathname === '/api/push/unsubscribe' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 8 * 1024)).toString() || '{}');
      const devices = await removeSubscription(body.endpoint || '');
      json(res, 200, { devices: devices.length });
      return;
    }

    /*
     * Send one now.
     *
     * Not a debugging leftover: everything about a web push can be correct on this
     * box and still produce nothing on the phone — permission revoked in the OS,
     * the app uninstalled, a battery optimiser holding the service worker down. The
     * only way to find out is to send one on purpose, so the settings switch does.
     */
    if (pathname === '/api/push/test' && req.method === 'POST') {
      // Which device is asking. Optional, because an older page that does not send it
      // still deserves the totals rather than an error.
      const asking = JSON.parse((await readBody(req, 8 * 1024)).toString() || '{}').endpoint || '';
      const result = await notifyAll(
        {
          title: 'Notifications are on',
          body: 'This is what you will see when a session outside the app finishes a turn.',
          tag: 'cw-push-test',
        },
        { topic: topicFor('push-test') },
      );
      console.log(`push: test sent to ${result.sent}/${result.devices} device(s)`);
      /*
       * The caller is one device asking about *itself*, and the totals cannot answer
       * that: a sum over every device reports success as long as some other phone is
       * healthy. That is not a hypothetical — it is how this phone came to be told
       * "a test notification has just been sent to this device" one second after the
       * push service refused the message, which is the whole reason the failure went
       * unnoticed for a day.
       *
       * `results` itself is deliberately not returned. An endpoint is a capability to
       * put a notification on someone's lock screen, so the list of them does not
       * travel to one device just because it asked about its own.
       */
      const mine = result.results.find((r) => r.endpoint === asking) || null;
      json(res, 200, {
        sent: result.sent,
        failed: result.failed,
        pruned: result.pruned,
        devices: result.devices,
        mine: mine && { ok: mine.ok, status: mine.status, gone: mine.gone },
      });
      return;
    }

    /*
     * The phone saying it showed one.
     *
     * Everything else here can only see as far as the push service: FCM answers 201,
     * and whether Chrome ever woke the worker, and whether Android then chose to
     * display anything, is invisible from this box. That gap is exactly where "it
     * says it sent one and I didn't get it" lives, and no amount of logging on this
     * side can close it — only the worker can, by saying it got there. See the push
     * handler in pwa/sw.js.
     *
     * Best-effort by design: it is a log line, not state. A receipt that never
     * arrives is itself the useful signal.
     */
    if (pathname === '/api/push/received' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 2 * 1024)).toString() || '{}');
      const who = describeDevice(req.headers['user-agent'] || '');
      const which = body.tag ? ` (${String(body.tag).slice(0, 40)})` : '';
      /*
       * Two different pieces of news, and they are worth telling apart.
       *
       * `shown` is the good one and closes the gap this endpoint exists for. The other
       * is the interesting one: the worker ran and the platform refused to display,
       * which the browser answers by revoking the subscription — so the device comes
       * back with a new endpoint, receives one push, is refused again, and looks
       * freshly subscribed the whole time. Reading that as a delivery problem is how a
       * phone gets debugged from the wrong end.
       */
      if (body.shown === false) {
        console.error(
          `push: ${who} received a notification and could not show it${which}`
          + `${body.error ? `: ${String(body.error).slice(0, 200)}` : ''}`
          + ' — the browser will revoke this subscription; check that notifications are'
          + ' allowed for the browser itself in the phone\'s own settings',
        );
      } else {
        /*
         * `held` is what the browser believes is on screen. Zero is the interesting
         * answer: the browser accepted the notification and the platform then declined
         * to keep it, which is the phone's own settings rather than anything here.
         */
        const holding = Number.isInteger(body.held)
          ? ` — the browser is holding ${body.held}`
            + (body.held === 0
              ? ', so the phone accepted it and displayed nothing: check notifications for the'
                + ' installed app as well as for the browser'
              : '')
          : '';
        console.log(`push: ${who} showed a notification${which}${holding}`);
      }
      json(res, 200, { ok: true });
      return;
    }

    // --- operations surface -------------------------------------------------
    // Reachable at /chat/admin through nginx. Deliberately part of this service
    // rather than an app of its own; see the note next to `admin` above.
    if (pathname === '/admin' || pathname === '/admin.html') {
      await serveStatic(req, res, '/admin.html');
      return;
    }

    if (pathname === '/api/admin/overview' && req.method === 'GET') {
      json(res, 200, await admin.overview());
      return;
    }

    /*
     * Stop one conversation, on one surface.
     *
     * A refusal comes back as 409 with the reason, exactly as a blocked project
     * removal does, and the client turns it into a specific question. `force` is
     * the answer to that question — never a default, and never inferred, because
     * everything reachable from here may be holding a turn in flight.
     */
    if (pathname === '/api/admin/kill' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 4 * 1024)).toString() || '{}');
      try {
        const result = await admin.kill({
          kind: body.kind,
          target: body.target,
          force: body.force === true,
        });
        console.log(`admin stopped ${body.kind} ${body.target}${body.force ? ' (forced)' : ''}`);
        json(res, 200, result);
      } catch (err) {
        if (!err.blocked) throw err;
        json(res, 409, { error: err.message, canForce: true, target: err.target });
      }
      return;
    }

    // The never-spoken-to probes the editor panel leaves behind, in one tap. No
    // `force`: a probe holds no conversation, which is what makes it reapable.
    if (pathname === '/api/admin/reap' && req.method === 'POST') {
      const result = await admin.reap();
      console.log(`admin reaped ${result.stopped} probe(s), ${Math.round(result.freedKb / 1024)} MB`);
      json(res, 200, result);
      return;
    }

    if (pathname === '/api/models' && req.method === 'GET') {
      json(res, 200, {
        models: [
          { id: 'us.anthropic.claude-opus-5', label: 'Opus 5' },
          { id: 'us.anthropic.claude-sonnet-5', label: 'Sonnet 5' },
          { id: 'us.anthropic.claude-opus-4-8', label: 'Opus 4.8' },
          { id: 'us.anthropic.claude-haiku-4-5', label: 'Haiku 4.5' },
        ],
      });
      return;
    }

    await serveStatic(req, res, pathname);
  } catch (err) {
    console.error(`${req.method} ${pathname} failed:`, err.message);
    json(res, 500, { error: err.message });
  }
});

// --- WebSocket bridge -------------------------------------------------------
// `noServer` rather than `{ server, path }` so the upgrade is authenticated
// before the socket is accepted. Checking inside the 'connection' handler would
// be too late: `ws` completes the handshake first, and this socket is the one
// that can start a `claude` process.
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', async (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (pathname !== '/ws') {
    socket.destroy();
    return;
  }

  let ok = false;
  try {
    ok = await isAuthenticated(req);
  } catch {
    ok = false;
  }
  if (!ok) {
    // A plain HTTP response on the raw socket: there is no WebSocket connection
    // yet to send a close frame over.
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  let conv = null;
  let onEvent = null;

  const send = (msg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  // Acknowledge immediately so the client can distinguish "connected, waiting
  // for me to send something" from "connection silently went nowhere".
  send({ type: 'ready' });

  // Keep-alive: mobile networks and the ALB will drop an idle connection, and
  // without pings the client can sit on a dead socket believing it's live.
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const attach = (conversation, replay) => {
    if (conv && onEvent) conv.off('event', onEvent);
    conv = conversation;
    onEvent = (event) => send(event);
    conv.on('event', onEvent);
    send({ type: 'attached', conversationId: conv.id, cwd: conv.cwd, model: conv.model,
           permissionMode: conv.permissionMode, busy: conv.busy,
           sessionId: conv.sessionId });
    if (replay) for (const event of conv.history) send(event);
  };

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send({ type: 'error', message: 'malformed message' });
      return;
    }

    try {
      switch (msg.type) {
        case 'start': {
          // Is this session already running? If so we are joining it, not
          // restarting it, and the transcript alone would miss the turn in
          // flight — so replay the live tail on top of it.
          const live = msg.resumeSessionId
            ? manager.getBySession(msg.cwd, msg.resumeSessionId)
            : null;

          // Resuming a stored session: show recent history before going live.
          // Sent as ONE batch rather than hundreds of frames — a phone building
          // 400 bubbles one event at a time stalls long enough to look broken.
          if (msg.resumeSessionId) {
            const past = await manager.loadTranscript(msg.cwd, msg.resumeSessionId);
            // Long transcripts are trimmed: the tail is what's readable on a
            // phone, and Claude retains the full context regardless.
            const recent = past.slice(-60);
            send({
              type: 'history',
              messages: recent,
              truncated: past.length - recent.length,
            });
          }

          const conversation = manager.create({
            cwd: msg.cwd,
            model: msg.model,
            permissionMode: msg.permissionMode,
            effort: msg.effort,
            resumeSessionId: msg.resumeSessionId,
          });
          attach(conversation, false);

          if (live) {
            // Joining a process mid-task: the transcript ends at the last
            // completed turn, so hand over what has happened since.
            const tail = live.liveTail();
            for (const event of tail.events) send(event);
            if (tail.partialText) send({ type: 'delta', text: tail.partialText });
            send({ type: 'joined', busy: live.busy });
          }
          return;
        }

        case 'reattach': {
          const existing = manager.get(msg.conversationId);
          if (!existing) {
            send({ type: 'error', message: 'conversation not found', fatal: true });
            return;
          }
          attach(existing, true);
          return;
        }

        case 'message': {
          if (!conv) {
            send({ type: 'error', message: 'no active conversation' });
            return;
          }
          conv.send(msg.text);
          return;
        }

        case 'interrupt': {
          conv?.interrupt();
          return;
        }

        default:
          send({ type: 'error', message: `unknown message type: ${msg.type}` });
      }
    } catch (err) {
      send({ type: 'error', message: err.message });
    }
  });

  ws.on('close', () => {
    // Detach the listener but leave the process running, so work continues
    // when the phone locks and you can reattach later.
    if (conv && onEvent) conv.off('event', onEvent);
  });
});

// Drop sockets that stop responding to pings, so a phone that went to sleep on
// a cell network doesn't leave a half-open connection behind.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);
heartbeat.unref?.();

/*
 * Watch for turns ending in sessions this app is not driving, and push them.
 *
 * Started unconditionally and costs nothing until a device subscribes: with an
 * empty subscription list the scan returns without touching the disk. The
 * conversations held in this process are excluded by handing it `liveSummary()` —
 * those already announce themselves on screen.
 *
 * Nothing shuts it down. Its timer is unref'd, so it never holds the process open,
 * and a signal handler here would only put a scan — possibly one waiting out an
 * unreachable push service — between systemd and a restart during every deploy.
 */
startTurnWatcher({ liveSessions: () => manager.liveSummary() });

server.listen(PORT, '127.0.0.1', () => {
  console.log(`chat service on 127.0.0.1:${PORT} (projects: ${PROJECTS_ROOT})`);
  // "0 device(s) subscribed, watching for turns to end" was true and read as healthy.
  // Nothing is being watched for in that state, so it says what it will do instead.
  listSubscriptions()
    .then((devices) => console.log(devices.length
      ? `push: ${devices.length} device(s) subscribed, watching for turns to end`
      : 'push: no device is subscribed — no turn will be announced until one opens the app'))
    .catch(() => {});
});
