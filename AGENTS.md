# Notes for AI agents

You are probably here because someone asked you to help them deploy, operate, or
modify TripleC. This file is the orientation you need. `CLAUDE.md` points here;
so does the README.

Read [docs/SECURITY.md](docs/SECURITY.md) before changing anything under
`chat-service/` or `infra/`. It explains why the code is shaped the way it is.

**Then read ["Finishing" is committed, pushed, and deployed](#finishing-is-committed-pushed-and-deployed).
It is not optional, and it is the instruction agents here have most often skipped.**

## What this project is, in one paragraph

A self-hosted web front end for Claude Code, running on one EC2 instance in the
user's own AWS account. The primary surface is a phone-friendly chat PWA; a full
VS Code (code-server) instance is available at `/editor/`. The chat is a thin UI
over the real `claude` CLI: one long-lived process per conversation, driven over
`--input-format stream-json`, which is what makes it behave like a messaging app
rather than a series of one-shot commands. Claude runs with
`--permission-mode bypassPermissions` by default, so it executes shell commands
without prompting.

## "Finishing" is committed, pushed, and deployed

**A change that is green on this box and nowhere else is not finished. It is a
change the user has to chase you for.**

Work in this repository is done when all three of these are true, in this order:

```bash
npm test                       # all of it, not just the part you touched
git add -A && git commit       # see the message rules below
git push origin main           # the open-source repo: github.com/MichaelNusair/triplec
./deploy-remote.sh             # runs the real deploy on the deploy box, from
                               # origin/main. It re-runs the tests there and
                               # refuses to ship if any of them fail.
```

**Deploys run on the deploy box, not here.** This is an agreement with the user,
made on 2026-09-18, and it is enforced rather than remembered: `./deploy.sh` now
*refuses* a full deploy when it detects it is running on the instance the stack
manages, because such a deploy cannot finish. CloudFormation applies a UserData
change by stopping this box, so everything after `cdk deploy` — the SSM waits, the
payload push, the login checks, the summary — dies with it, and the stack goes green
over an app that was never updated. `./deploy-remote.sh` is the way to ship: it
resets the deploy box's clone to `origin/main` and runs the real `deploy.sh` there
over SSM, detached, so the deploy survives this end entirely — close the editor,
lose the network, let this box restart mid-deploy, and it still finishes. Run it
again and it re-attaches to the same run rather than starting a second one.

Two things follow from it, and they are the reason it is written here rather than in
a comment:

- **It deploys `origin/main`, so it refuses to run with anything uncommitted or
  unpushed.** That is the opposite of `deploy.sh`, which ships the tree it is run
  from. Push first — including work that is not yours (see below) — or the deploy
  would quietly ship a different tree than the one you are looking at.
- **`./deploy.sh --app-only` from this box is still correct and still finishes**, and
  it is the right tool when the change is only app payload: `chat-service`, `pwa`,
  either extension, or `infra/userdata/bootstrap.sh`. It changes no AWS resources.
  Anything under `infra/lib` needs the deploy box.
- **Ship the deployment whose config is the plain `triplec.config.json`, and only
  that one.** This account can run more than one: a deployment is a config file, and
  a second one is a second config file selected with `TRIPLEC_CONFIG=…` —
  `ls triplec.*.config.json claude-web.*.config.json` is how you find out, since
  they are all gitignored. (Both spellings, because this box predates the rename:
  see ["The names before the rename"](#the-names-before-the-rename).)
  Everything here is shared by all of them — one repository, one `origin/main`, one
  deploy box, one suite — so a change to `chat-service`, `pwa` or `infra/lib` *is* a
  change to every deployment, and the others will drift until someone ships them.
  That is deliberate: the owner of this repository asked for the alternates to be
  updated ad-hoc rather than as part of finishing, because a second deployment is
  someone else's running box and the timing is theirs. So deploy the plain config
  without being asked, deploy an alternate only when asked, and say which ones you
  shipped. ["More than one deployment"](docs/DEPLOY.md#more-than-one-deployment) has
  the mechanics, including why the deploy box needs a checkout per deployment.

The box is named in `triplec.config.json` under `deployFrom` (gitignored, so it
is per-deployment and never committed). Anyone running the open-source repo should
do the same — any second machine with an SSM agent and a role that can deploy the
stack will do, including a laptop or CI. [docs/DEPLOY.md](docs/DEPLOY.md) has the
setup.

Do all three without being asked. Do not stop after the tests and describe what
*could* be shipped; do not leave the commit for the user; do not say "ready to
deploy" as if that were the finish line. If you were asked to build something, you
were asked to put it live — this box *is* production, there is no staging, and an
uncommitted change is one editor crash away from being gone.

**It does not matter who left it.** This is a sweep of the repository, not of your
diff. If you find uncommitted changes, commits that never got pushed, or a tree
that is ahead of what is actually running, finish them too — the user's
instruction is that nothing in here is left built-but-not-live, regardless of
which agent or which session built it. So start by looking:

```bash
git status --short              # anything uncommitted, from any session
git fetch origin && git status -sb   # "ahead N" means commits nobody else has
```

Read what you find before you ship it, and say whose it is (see below). The only
thing that stops you is work you can see is *broken*, not work that is merely
someone else's.

Five things that are still true while you do it:

- **Say what you are shipping.** Neither deploy path ships only your diff:
  `deploy.sh` ships the whole working tree, and `deploy-remote.sh` ships all of
  `origin/main`, which may hold commits you have never seen. More than one agent
  works in this repository at a time, so run `git status` and `git log HEAD..origin/main`
  first and, if there is work in there that is not yours, say so in the commit message
  and in what you tell the user. Ship it — but named, never quietly. And never commit
  `triplec.config.json` — under either name — or `infra/cdk.context.json` (all
  gitignored; keep it that way).
- **Someone else's file may be mid-edit.** The suite is the arbiter: if `npm test`
  is green with their work in the tree, ship it and say you did. If it is red
  *because* of their work, do not fix it by reverting them and do not weaken the
  test — commit your own files by name, push, deploy that, and say plainly what
  you left behind and why.
- **Green first, always.** `deploy.sh` runs the suite itself and refuses on
  failure, and that refusal is a feature. Never pass a flag, skip a test, or weaken
  an assertion to get past it.
- **A deploy is visible to the user.** It restarts `claude-chat` and `code-server`,
  so editor pages reconnect and any tmux server *not* owned by
  `claude-tmux.service` dies with the old cgroup. It never restarts
  `claude-broker`, which is why conversations in the panel survive it — keep that
  true (see the broker's cgroup note below).
- **Report what actually happened.** The commit hash, that the push landed, and
  the deploy's own verdict. If the deploy failed, say that plainly and leave it
  failed rather than describing the change as done.

If you genuinely must not deploy — the user said not to, or the tree holds work
that is known broken — then say so explicitly, in one sentence, as part of
reporting the work. Silence reads as "deployed", and that is the failure this
section exists to prevent.

## The one thing you must not get wrong

**This application executes shell commands on behalf of whoever is logged in. An
authentication gap is a remote code execution vulnerability, not a bug.**

That is not hypothetical here. This project previously shipped with `/api/*` and
`/ws` reachable from the internet with no credentials, because the nginx config
carried a comment describing an `auth_request` gate that had never been written,
and every document in the repo repeated the claim. The lesson encoded in the
current design:

- Authentication is enforced **in the application process**
  ([`chat-service/auth.js`](chat-service/auth.js)), never delegated to nginx, the
  ALB, or any other layer that a comment can lie about.
- New routes are **gated by default**. `isOpenPath()` is an allowlist. Do not
  turn it into a denylist.
- The server **refuses to start** without a strong password and session secret.
  Do not add a fallback, a default, or a development bypass that could reach
  production.
- **Authentication is not authorization.** In `oidc` mode the ALB proves the caller
  has an account with the provider and nothing more — with Google, that is
  everyone. `oidc.allowedEmails` is what says which accounts are the operator's,
  it is mandatory in both `config.js` and `assertAuthConfig()`, and it is checked
  only against claims from a JWT whose signature has already been verified. Do not
  add a path that reads an identity out of an unverified token, and do not make the
  allowlist optional "for convenience" — the convenient version is a public shell.
- **Ask which routes reach `auth.js`, not just whether `auth.js` is right.** That
  distinction is the second hole this repo has had. In `oidc` mode the editor
  routes — `/editor/`, `/p/<name>/` and the catch-all `location /` — proxy to
  code-server, so for a while they never touched `auth.js` and the allowlist never
  applied to them. code-server's password was the only thing there, and a password
  says nothing about *which* identity holds it: any Google account plus that one
  password was a terminal on the box. Found 2026-09-19 by signing in with an
  unlisted address. They now carry `auth_request /__identity`, which asks `auth.js`
  and forwards its answer — the decision stays in the app, nginx only relays it.
  A correct check on a route nothing goes through protects nothing.
- [`chat-service/auth-test.js`](chat-service/auth-test.js) is the contract. It
  boots the real server and speaks real HTTP and WebSocket to it, in both modes.
  `deploy.sh` runs it and refuses to deploy on failure. Route *coverage* is the
  other half, and it lives in
  [`chat-service/manifest-test.js`](chat-service/manifest-test.js): it discovers
  every nginx location that proxies to code-server and requires the gate on each,
  so adding a fourth editor route without one fails the suite. Add a route that
  reaches code-server, and that is the test you will hear from. `deploy.sh` gates
  that one too, as of 2026-09-21 — it did not for months, and the two are not
  interchangeable: `auth-test.js` proves the routes it knows about refuse an
  anonymous caller, `manifest-test.js` proves a newly added route is one of them.
  The nginx config it reads ships *in the payload* (`infra/userdata/bootstrap.sh`),
  so without it a deploy shipped the routing and never checked it.

If you are asked to "just disable auth for testing", use
`CW_INSECURE_COOKIES=1` on `localhost` — which only drops the `Secure` cookie
flag so cookies work over plain HTTP — and say plainly that removing the gate
itself is not something you will do on an internet-facing deployment.

### Before you finish any change to auth, routing, or the stack

```bash
npm run test:auth      # must be 95/95 or better; never fewer checks than before
npm run test:host      # 84/84; host mode against a fake CLI — providers, relay, registry, trusted-header
npm run test:client
npm run test:panes     # several projects at once; what closing a tab must not do
npm run test:overlay   # 106/106; the editor overlay: chords, drafts, clipboard, speech
npm run test:polish    # 19/19; the dictation cleanup's bounds, and its failure paths
npm run test:speak     # 64/64; where a read-aloud message is cut, and every refusal
npm run test:projects  # 53/53; real git repos, real pushes
npm run test:admin     # the operations surface, and every refusal it makes
npm run test:build     # 47/47; which build the app says it is, from a payload
                       # that has no .git, and a tab left open through a deploy
npm run test:status    # 42/42; which conversation a device is told about, and from where
npm run test:broker    # 51/51; one process per conversation, and what counts as a turn
npm run test:mux       # 58/58; slots against real git, the mux, the chat embedded in it
npm run test:term      # 67/67; terminal panes: exact tmux targets, the pty relay, /ws/term
npm run test:landing   # 53/53; the marketing page's analytics, which fails silently
cd infra && npx cdk synth --quiet
```

`npm test` runs all of them in that order.

If you add a route to `server.js`, add it to the `guarded` list in
`auth-test.js`. A route with no test is a route nobody is checking.

## The box you are on

**You have passwordless `sudo`. Install whatever the job needs.** A headless browser,
a compiler, a language runtime, a font, a CLI — do not work around a missing package
and do not ask the user to install it for you.

```bash
sudo dnf install -y <package>       # Amazon Linux 2023, so dnf
npx playwright install chromium     # a headless browser — no root; it lands in ~/.cache
```

A browser works out of the box because `bootstrap.sh` installs the libraries it links
against. Do **not** reach for `playwright install-deps` when something is missing: it
only knows `apt` and exits 127 here. The package names are in the optional group at the
top of `bootstrap.sh`, and `ldd <binary> | grep not-found` is how that list was built.
`chromium` is not in the AL2023 repos, so Playwright's own download (or a direct fetch
from Chrome for Testing) is the way to get one. Chrome for Testing does publish
`linux-arm64`, which two notes on this box got wrong; and use the *headless shell*
binary, since the full `chrome` build crashes at launch here
(`chrome_crashpad_handler: --database is required`) with `ldd` clean.

One caution that belongs with the capability: **this repository serves a landing page
that carries analytics, so do not point a browser at the live one.**
`landing/analytics.js` runs PostHog with `disable_session_recording: false` and no bot
or headless filtering, which makes a verification screenshot a *write* to the funnel
rather than a read — and it fails silently, by being counted. Render the local file and
keep the browser off the network (`--host-resolver-rules="MAP * 127.0.0.1"`) unless the
live origin is the thing under test, and say so when it is.

This is written down because the previous state was invisible from inside a session and
cost real work. Until 2026-09-21 the workspace account (`coder`) was deliberately outside
sudoers, so an agent told to drive a browser got exactly as far as downloading one and
then failed on its system libraries, which are RPMs. The reported symptom was always
"I can't install browsers, I don't have sudo" — and nothing in the repository said
whether that was policy or oversight, so each agent rediscovered the wall and stopped.
It was an oversight. `bootstrap.sh` now writes `/etc/sudoers.d/90-coder`, validates it
with `visudo` before installing it, and then asks `sudo -l` whether the grant is
actually live, so a deploy cannot report success over an account that still cannot
install anything. It also installs the browser libraries themselves, because sudo alone
still left a wall — just a surmountable one twenty RPM names deep.

Two things to know about it:

- **It does not widen the threat model.** `coder` owns `/opt/claude-web`, so it already
  controlled the code the chat service's unit executes, and every session here already
  runs `claude` under `bypassPermissions`. There is no second account on this box to
  protect. [docs/SECURITY.md](docs/SECURITY.md) has always said that anyone past the
  login page has a shell; this stops pretending that shell was fenced. What it does
  mean is that **prompt injection now reaches root**, which changes the cleanup story
  rather than the reachability one — that is the row it earns in the threat model, and
  it is there.
- **What you install by hand is not permanent.** `/home` and `/` are the root volume;
  only `/workspace` persists, with `~/.claude` symlinked into it. A normal deploy or a
  stop/start keeps your packages, but an *instance replacement* (a full deploy that
  changes UserData) hands you a fresh root volume, and both the RPMs and anything
  under `~/.cache` are gone. So if a tool needs to be there on every box rather than
  just this one, add it to the package list at the top of
  [`infra/userdata/bootstrap.sh`](infra/userdata/bootstrap.sh) — in the optional
  `|| echo` group if the build does not depend on it — and ship that. Installing it
  by hand is the right answer for a one-off and the wrong one for a dependency.

## More than one session is in this checkout

Several Claude sessions run on this box at once, and more than one of them is
usually in *this* directory: the editor's tmux session (`cc triplec`), every
conversation in the chat and in the editor's panel — one `claude` process each,
keyed by cwd and conversation id — and whatever a phone has open. They hold
separate context, they cannot see each other, and they share one working tree, one
index and one stash stack. Nothing arbitrates between them.

That is a sharper problem here than in most repositories, because of the finishing
rule at the top of this file: every session is told to sweep the tree and ship what
it finds. An edit you leave half-written for ten minutes is therefore not waiting
for you — it is something another session will commit to `main` and deploy to
production, named in its commit message but still mid-thought. It costs in the
other direction too: `deploy-remote.sh` refuses to run while the tree is dirty, so
your unfinished work blocks their deploy and theirs blocks yours.

**So work in a git worktree whenever the work will sit.** `EnterWorktree` makes one
off `origin/main` under `.claude/worktrees/<name>` and moves the session into it;
that path is gitignored here deliberately, so the sweep above can never commit a
nested checkout. Reach for one when either of these is true — it is cheaper than
being careful:

- `git status` already shows changes that are not yours, or
- your own change will be unfinished for more than a few minutes: anything with a
  test to write, a deploy to weigh, or a question to put to the user first.

A one-line fix you are about to commit is fine in the shared checkout, and so is
the deploy. Give a subagent its own worktree as well (`Agent` with
`isolation: "worktree"`) whenever you expect it to write files, rather than letting
two of them edit the same paths. In a worktree the only uncommitted work is yours,
which is what makes the `git add -A` in the block at the top of this file honest
again.

Three things about a worktree *of this repository* in particular:

- **Nothing gitignored comes with it, and the suite needs three of those.** Symlink
  them from the main checkout and `npm test` passes unchanged in the worktree —
  verified 2026-10-21, 83 tests green, which is all of it:

  ```bash
  W=.claude/worktrees/<name>
  ln -s /workspace/projects/triplec/chat-service/node_modules "$W/chat-service/node_modules"
  ln -s /workspace/projects/triplec/infra/node_modules "$W/infra/node_modules"
  ln -s /workspace/projects/triplec/claude-web.config.json "$W/claude-web.config.json"
  ```

  The config is `triplec.config.json` on a box set up after the rename; this one
  predates it. Without it, anything that reads `infra/config.js` fails on a missing
  `domainName` instead of on something that names the real cause.
- **Push from the worktree, deploy from the main checkout.** `git push origin
  HEAD:main` is the finish: `deploy-remote.sh` ships `origin/main`, so a pushed
  commit is deployable from anywhere, while `deploy.sh --app-only` ships *the tree
  it runs in* — which in a worktree is one branch plus three symlinks. Expect the
  deploy to report the checkout is behind `origin/main` by the commit you just
  pushed; that is the warning working, not a refusal.
- **Then remove it.** `git worktree remove`, or `ExitWorktree` with `remove`. One
  left behind holds a branch and a second copy of the tree, and becomes the next
  session's confusion about whose work it is.

The box-wide version of this note, for every project under `/workspace/projects`,
is written by `bootstrap.sh` into `/workspace/projects/CLAUDE.md` — a
parent-directory `CLAUDE.md`, which Claude Code loads alongside the project's own.
What is above is the part specific to this repository.

## Repository map

```
chat-service/            The chat backend + PWA client. The security boundary.
  auth.js                Password, OIDC and trusted-header (tailnet) verification,
                         cookies, throttling. trusted-header believes a header only
                         from a loopback socket owned by tailscaled's uid.
  host.js                Everything that differs between the AWS box and host mode
                         (TRIPLEC_MODE=host): user, home, paths, feature flags, the
                         Claude provider env, the login-shell PATH, the bind guard,
                         the session cap, the secrets file and the audit log. The
                         only file allowed to name `coder` or /workspace.
  projects.js            Which directories are projects: every one under
                         PROJECTS_ROOT, or an explicit registry (host mode). Every
                         "is this cwd a project?" check goes through projectFor.
  host-test.js           Host mode end to end against a fake CLI, check names
                         keyed to the host-mode requirement IDs.
  auth-test.js           End-to-end auth tests. Run these.
  server.js              HTTP routes, static files, WebSocket upgrade gate.
  session-manager.js     One `claude` process per conversation; transcripts;
                         the project lifecycle (create, clone, remove).
  slots.js               Eight standing worktrees per project
                         (.claude/worktrees/slot-N), made on clone/create and on
                         first use; a new chat fast-forwards a clean one and
                         leaves one holding work exactly as it is.
  terminal.js            The mux's terminal panes: /ws/term, which runs `cc` for
                         a slot on a pty and relays it. Refuses without a tmux
                         server, so nothing it starts lives in this service's
                         cgroup. Serves xterm.js from node_modules.
  term-relay.py          The pty itself, because Node has none without a native
                         module: pty.fork, a select loop, framed stdin for
                         keystrokes and window sizes. Hang-up is a tmux detach.
  admin.js               The operations surface: what is running on all four
                         surfaces, what is wrong with it, and stopping one thing
                         at a time. Reads the broker's processes from outside
                         with ps, and refuses far more than it does.
  build.js               Which build this is: a short id, the version, the
                         commit and when it shipped. Three sources in order —
                         the build.json deploy.sh writes at pack time, then git,
                         then asset mtimes — because the running payload has no
                         .git and the checkout has no stamp. Never throws: an
                         app that cannot name itself must still serve.
  build-test.js          That precedence, the sanitizing of a value a deploy box
                         wrote into an HTML attribute, and the five things the
                         settings sheet can say — including a tab left open
                         across a deploy, which is the whole point.
  claude-status.js       "Is Claude working, and what did it last say" for the
                         EDITOR's panel, in ~40ms, so a device need not wait out
                         the panel's own history load to find out. Two sources,
                         deliberately unequal: the broker for whether a turn is in
                         flight, the tail of the transcript for the message. Plus
                         the head of it, for the prompt the conversation began
                         with — the one message worth sending again, and the one
                         compaction appears to take away. Three states, not two:
                         an unanswered `AskUserQuestion` at the tail is
                         `'question'`, which neither source can see on its own.
                         Depends on nothing in this service but the transcript
                         path helper and the synthetic-prompt filter — the chat
                         service is meant to be retired, and this should move
                         rather than be rewritten.
  status-test.js         That the two sources stay separated: a broker answer
                         wins, a missing one falls back, and neither may claim a
                         conversation is idle when that is not known. That a
                         question waiting reads as neither working nor finished,
                         and an answered one still says which option was taken.
                         And that an opening prompt is never a preamble Claude
                         Code wrote.
  push.js                Web Push, hand-rolled on node crypto: VAPID (ES256) and
                         RFC 8291 aes128gcm, plus the device list. No dependency
                         on purpose — see its header. Keys live under CLAUDE_HOME
                         so a deploy cannot invalidate a phone's subscription.
  push-test.js           The encryption against RFC 8291's published vector, byte
                         for byte and step by step, and a fake push service over
                         real HTTP for the sending, pruning and refusals.
  turn-watcher.js        What actually decides your phone should buzz: polls the
                         transcripts every 5s for a turn that just ended in a
                         session this app is NOT running, and sends one
                         notification per conversation. Also for a turn that
                         stopped to ask you something, which has not ended and is
                         the one thing nothing else will move on.
  turn-watcher-test.js   Mostly about silence — a restart, a rewritten
                         transcript, a mid-turn write and this app's own
                         conversations must all announce nothing. The exception
                         is a question, which buzzes once and says what it asked.
  sw-test.js             pwa/sw.js loaded with `self` stubbed: what tapping a
                         notification focuses or opens. A service worker has no
                         console anyone reads, so a wrong answer here looks
                         exactly like a phone that ignored the tap.
  manifest.js            One web app manifest per project, so a project can have
                         its own home-screen icon and therefore its own window on
                         Android. Differs only in `id`, `start_url`, name.
  manifest-test.js       That a project's manifest stays installable and stays in
                         step with pwa/manifest.webmanifest, which it duplicates.
  transcribe.js          Voice: local whisper.cpp, optional Azure override.
  polish.js              Makes a finished dictation readable: punctuation,
                         capitals, misheard names. Bedrock Haiku, one bounded
                         pass, returns the raw transcript on any failure.
  speak.js               The other direction: reads a message out loud in a
                         neural voice — Azure's free tier by default, Polly's
                         generative engine or OpenAI if asked for, chosen by
                         `preferredVoice`. Cut into segments so the voice starts
                         ~2s after the tap, cached by a hash of what it says, and
                         capped by a daily character budget per provider, since
                         two of the three bill per character.
  smoke-test.js          Boots app.js in jsdom — catches load-time breakage.
                         Also the notification switch, against stubbed
                         Notification/PushManager/serviceWorker: every way that
                         switch can lie is invisible from a desktop browser.
  polish-test.js         The cleanup's guard rails: what `looksLikeCleanup`
                         must reject, and that every failure path hands the
                         raw transcript back.
  speak-test.js          Where a message gets cut, which is the part of the
                         voice a listener can hear, and every refusal: the daily
                         budget, an id that aged out, a segment that does not
                         exist. Runs against a fake synthesiser, so a test run
                         needs no credentials and spends nothing.
  overlay-test.js        Boots pwa/mobile-overlay.js in jsdom — over the editor,
                         and over the mux, where only its voice half may mount.
                         It drives the editor by
                         keybinding, so this is what checks both. Also the
                         speech reducer and the rules iOS imposes on it, against
                         a fake speechSynthesis — jsdom has none, which is also
                         how the no-speech path gets covered.
  project-test.js        Project removal against real git repos. Deletes trees,
                         so the refusals are what this tests hardest.
  admin-test.js          Both halves of /chat/admin against a fake box having
                         every failure this project has had, at once. What it
                         refuses to signal is the code under test.
  pane-test.js           Several projects open at once — a tab is a project, not
                         a conversation: a background project rendering off
                         screen, the live cap, switching chats inside one tab,
                         and that neither that nor closing a tab stops anything.
  mux-test.js            Slots against real git (a refresh never loses an edit or
                         a commit; removal refuses over a dirty slot), the mux in
                         jsdom, and the chat embedded in its panes.
  term-test.js           Terminal panes from `cc` to the page: exact tmux targets
                         against a fake tmux, the relay on a real pty, /ws/term
                         end to end through a fake `cc`. Needs no tmux.
  public/                index.html, app.js, style.css, login.html,
                         admin.html + admin.js for the operations surface,
                         mux.html + mux.js + mux.css for the desktop surface, and
                         term.html + term.js + term.css for a terminal pane.

deploy/host/             Host mode: install onto an existing Ubuntu 24.04 VM as its
                         developer (install.sh, upgrade.sh, uninstall.sh), the
                         config schema and validator (config.mjs), and an Ubuntu
                         container test. See docs/HOST.md and its README.

claude-broker/           Keeps the editor panel's `claude` alive and shared
                         between devices. No dependencies beyond node.
  broker.js              The daemon: one process per (cwd, session id), byte
                         transparent, replays the stream to a joining page.
  wrapper                What the extension launches instead of `claude`. Every
                         failure path execs the real binary — keep it that way.
                         No file extension, on purpose: see its header, and do
                         not rename it to wrapper.js.
  broker-test.js         Boots the real broker over a real socket against a fake
                         CLI. Proves sharing, and proves the fallback.
  install.sh             Installs the unit and the editor setting. In the payload
                         because a bootstrap.sh edit cannot reach a live box.

infra/                   AWS CDK (JavaScript, not TypeScript).
  config.js              Config loading + validation. Single source of truth.
  print-config.js        Emits shell assignments for deploy.sh / migrate.sh.
  lib/stack.js           The whole stack. No account-specific values.
  userdata/bootstrap.sh  Instance provisioning. Idempotent; re-run on deploy.

  lib/landing-stack.js   Optional marketing site: S3 + CloudFront. Separate stack.
  landing-analytics.js   The landing page's analytics contract: the proxy path,
                         PostHog's hosts, the page's CSP. Imported by the stack,
                         the deploy script and the test, so they cannot disagree.
  lib/security-stack.js  Optional CloudTrail + GuardDuty. Account-wide, so its
                         own stack and its own lifetime.

landing/                 The public marketing page. Static, no build step.
  analytics.js           PostHog, proxied through the site's own origin. Ships
                         holding placeholders; stamped at deploy time.
  landing-test.js        Runs analytics.js in a stub browser. `npm run test:landing`.
pwa/                     Assets copied into chat-service/public/ by deploy.sh.
                         THIS IS THE SOURCE OF TRUTH for manifest + sw.js.
voice-extension/         VS Code dictation extension (for the editor surface).
mobile-extension/        Strips VS Code chrome for phone use, and owns the
                         rescue from a layout a file view has taken over.
deploy.sh                The whole deploy. Read it before changing the pipeline.
deploy-landing.sh        The landing site only. Independent of deploy.sh.
deploy-security.sh       The audit stack only. Safe from the workspace: no
                         UserData change, so nothing stops the box mid-deploy.
migrate.sh               Brings local repos + Claude session history up.
```

### Three stacks, deliberately

`TripleCStack` is the workspace — a machine that runs shell commands.
`TripleCLandingStack` is a public static page. They share no resources, and the
landing side has no route to the instance. Keep it that way: do not "simplify" by
serving the marketing page off the workspace's nginx, which would put public
traffic on the box that holds the GitHub token.

Both manage a Route53 record, so **they must never be configured with the same
hostname** — `config.js` rejects that rather than letting CloudFormation find out.
When moving a hostname from one to the other, deploy the stack that is *giving it
up* first.

`TripleCSecurityStack` is separate for a different reason: a CloudTrail trail and
a GuardDuty detector are account-wide singletons, not app resources, and their
lifetime must not be tied to the workspace they watch. Deleting the workspace stack
must not delete the record of what that instance did — which is also why the trail
bucket is `RemovalPolicy.RETAIN`. Do not fold it into `stack.js` to save a file.

Both optional stacks are opt-in and default to off, because a fork must deploy
cleanly in someone else's account. For the security stack that is load-bearing
twice over: AWS allows one GuardDuty detector per account per region, so
`guardDuty: true` in an account that already has one fails the deploy on that
resource. `deploy-security.sh` checks first and explains; keep it that way.

## Common requests, and how to handle them

### "Help me deploy this"

```bash
cp triplec.config.example.json triplec.config.json
# set domainName and hostedZoneName
./deploy.sh
```

Before running it, confirm all four, because each has a distinct and confusing
failure mode:

1. **AWS credentials work** — `aws sts get-caller-identity`.
2. **They own a Route53 hosted zone** containing the domain, and it is the zone
   actually serving that domain publicly. Otherwise certificate validation hangs
   forever with no useful error.
3. **Bedrock model access is enabled** in the target region — otherwise the first
   message fails with `AccessDeniedException` long after the deploy "succeeded".
4. **They understand what `bypassPermissions` means.** Point them at
   docs/SECURITY.md. Do not skip this because it is awkward.

Then walk them through `allowedCidrs`. If they only use this from a couple of
known networks, narrowing it is the single highest-value hardening step and costs
nothing. Most people do not know the option exists.

**And tell them where deploys run from after this one.** The first deploy is fine
from wherever they are — the trap springs on the *second* one, if they run it from
inside the workspace the stack has just created for them. `deploy.sh` refuses that
(see the finishing section above), so the thing to set up before they start making
changes is `deployFrom` in `triplec.config.json` and `./deploy-remote.sh`. The
machine they just deployed from already qualifies; the minimum version of this advice
is "keep running full deploys from here, not from the workspace".

### "It deployed but X is broken"

First settle whether the new build is even live, because "deployed" and "running"
are different facts and half of this section is wasted on the gap. Settings in the
chat names the running build (`v3.0.0 · 33d370b · deployed 2h ago`) and says so
again if the open tab was served by an older one; `/chat/admin` carries the same
line. From a shell on the box, the stamp itself is the answer:
`cat /opt/claude-web/chat-service/build.json` — `/api/version` serves the same
thing but is gated like every other route, so curl gets the login. If the id is the
commit you expected, the deploy worked and the bug is yours.

The Troubleshooting section of [docs/DEPLOY.md](docs/DEPLOY.md) covers the known
failure modes. Diagnose from the box rather than guessing:

```bash
aws ssm start-session --target <InstanceId>     # no SSH port exists
sudo journalctl -u claude-chat -n 100           # chat service
sudo tail -50 /var/log/bootstrap.log            # first boot
sudo tail -50 /var/log/reprovision.log          # redeploy provisioning
sudo nginx -t                                   # proxy config
systemctl is-active claude-chat code-server nginx
```

If `claude-chat` is dead, check the top of the journal first: the service aborts
deliberately when `AUTH_PASSWORD` or `SESSION_SECRET` is missing, and the error
message says so. That is correct behaviour, not a crash — find out why
`/etc/claude-auth.env` is empty.

### "Add a feature to the chat"

`server.js` routes → `session-manager.js` for anything touching the `claude`
process → `public/app.js` for UI. Client requests go through the `api()` wrapper
so a 401 redirects to login; use it rather than bare `fetch`.

**In the client there is no "the chat" any more.** A window onto a project is a
*pane* — its socket, its thread element, the bubble being streamed into, the tool
cards still waiting for their results — and several are open at once as tabs.
Every render function takes the pane it draws into, because a background project
keeps rendering while you are looking at a different one; that is the whole reason
tabs exist. `activePane()` is the one on screen and the only thing the composer,
the header and the mic belong to. If you reach for "the thread" or "the socket" as
a module-level thing, that is the bug the pane model exists to make impossible.

**A tab is a project, not a conversation** — `paneKey(cwd) === cwd`, so a
directory has exactly one tab, and `pane.sessionId` is which of that project's
chats the window currently shows. This is deliberate and was the second design:
tabs per conversation gave a box with 17 projects and 32 chats a chip strip nobody
could read. Switching conversation inside a tab (`showConversation`) drops the old
socket and joins another; it never stops what it left, and the toast says so.
Drafts stay keyed per conversation (`convKey(cwd, sessionId)`), not per tab, so
text always resurfaces in the chat it was typed in — as do list rows, `/api/live`
and everything the server keys by session. The price, accepted: two chats in one
project cannot be on screen at the same time.

Three panes hold a socket (`MAX_LIVE`); past that the least recently used *idle*
one is cooled to a tab — socket closed, thread dropped, nothing stopped. Cooling
is never applied to a pane that is working: the cap is exceeded and the user told
instead, because a tab going quiet while the box is still spending on it is the
one outcome worse than four sockets. Closing a tab is not stopping either, and
neither is switching conversations; ending a conversation is `/chat/admin`'s job,
on purpose. `pane-test.js` holds all of that down and `deploy.sh` runs it.

### "Delete a project I'm done with"

`POST /api/projects/remove` — commit, push every branch and tag, verify with the
remote that it landed, then `rm -rf` the directory. Reachable from the chat: New
chat → the ⋯ next to a project.

The order matters and the verification is not decoration. A `git push` that exits
0 is not proof the remote has anything: the remote-tracking ref it updated is a
local file, and this operation deletes the only other copy of the work. So the
commit on disk is compared against `git ls-remote`, over the network, and anything
short of a match refuses to delete.

It returns **409, not 500**, when something exists only on that machine — no
remote, a stash, a push that partly failed, a chat still working in the directory.
That is a refusal the user can answer, and the client turns it into a specific
question with `force` as the answer. If you add a new way for work to be
local-only, add a check for it *and* a case to `project-test.js`. `force` must
never become the default, and must never be inferred.

Chat transcripts under `CLAUDE_HOME` are deliberately left behind. They are small,
they are the record of what was done, and keeping them means re-cloning the repo
later lands next to its own history.

### "Clone one of my GitHub repos"

`POST /api/projects/clone`, or the repository list from `GET /api/github/repos`.

`parseGithubRepo()` accepts `owner/repo` and github.com URLs and **rejects every
other host**. That is a security boundary, not tidiness: the workspace's git
credential helper (`git-credential-secretsmanager`) answers with the PAT for
whatever host git asks it about, so cloning a caller-supplied URL from elsewhere
would hand that host the token. Do not relax it to "any git URL". If someone wants
that, the fix is to scope the credential helper to github.com first.

### "Change the routing"

Read the comment block above the nginx config in `bootstrap.sh` first. The layout
is not arbitrary:

- The chat's assets are namespaced under `/chat/` and the catch-all `/` belongs to
  code-server, because code-server emits absolute asset URLs and has no supported
  nginx sub-path configuration.
- `index.html` references `/chat/app.js`, and `server.js` rewrites those exact
  strings for cache-busting. Change one, change both.
- `/editor/` strips its prefix and uses `proxy_redirect` so code-server's
  root-relative redirects do not bounce the user back to the chat.
- `/p/<name>/` is that same editor behind a per-project path, and the only regex
  location in the file — it matches one path segment and nothing below it, so
  code-server's absolute asset URLs still fall to the catch-all. It exists so a
  project can be an installable app of its own; see "A window per project, on a
  phone" for why a path, and not just an `id`, is what that takes.
- The three locations that reach code-server — `/editor/`, `/p/<name>/` and the
  catch-all `/` — each carry `$IDENTITY_GATE`, which is `auth_request /__identity`
  in `oidc` mode and empty otherwise. Adding a fourth route to code-server without
  it is a shell on this box for any account the provider will authenticate;
  `manifest-test.js` fails the suite if you do.
- **A security control belongs on the path, not on the location, because two
  locations can reach one handler.** `/chat/` strips its prefix, so `/chat/api/login`
  and `/api/login` are the same endpoint — and the `limit_req` that was attached to
  `location = /api/login` did not apply to the other spelling. The login throttle is
  now keyed on `$uri` through the `$login_attempt` map and applied once at the
  server, so every location inherits it and nginx counts only the paths the map
  names. Do not move it back into a location, and do not give a location its own
  `limit_req` — a location-level directive *replaces* the inherited one. That is
  the same bug as the editor gate above, twice, which is why both are derived from
  the config in `manifest-test.js` rather than listed.

### "Set up the voices" (or: why is Read aloud / Talk it over missing?)

Everything that speaks or listens here is optional, reports `configured: false` with a
sentence saying why when its credentials are absent, and reads those credentials from
**one** secret — the `WhisperConfig` one, whose ARN arrives as `WHISPER_SECRET_ARN`.
One secret because the instance role is granted `secretsmanager:GetSecretValue` per ARN
in `infra/lib/stack.js`: a *new* secret is a stack change, and a stack change replaces
UserData and reboots this box, killing every live conversation on it. A new *field* is
an app-only deploy and nothing else. Its fields, all optional:

| Field | What it turns on | Bills |
|---|---|---|
| `speechKey`, `speechRegion` | Azure AI Speech: the default read-aloud voice (`Ava`), the Hebrew voices (`Hila`, `Avri`), and Hebrew dictation | Nothing — `F0` answers 429 when the month's 0.5M characters are gone |
| `openaiApiKey` | The multilingual read-aloud voices (`marin` and friends) and, without the three fields below, the spoken conversation | A card, unless the account is on prepaid credits |
| `azureRealtimeEndpoint`, `azureRealtimeKey`, `azureRealtimeDeployment` | The spoken conversation, on Azure OpenAI instead — preferred over `openaiApiKey` when both are present | Sponsorship credit, which stops rather than overdrawing |
| `endpoint`, `key` | Azure Whisper for dictation, overriding the local `ggml-base.en.bin` | Per minute |

Two things to get right when writing to it. **`put-secret-value` replaces the whole
document**, so read it, merge, and write it back — dropping `speechKey` while adding a
realtime field takes read-aloud with it. And **`azureRealtimeDeployment` is the name you
gave the deployment**, not the model name; a wrong one is a 404 at mint time.

Then `GET /api/voice-status?refresh=1`, which re-reads all of it without a restart —
that route exists so that adding a credential does not have to end every live
conversation on the box. `SPEAK_VOICE`, `SPEAK_ENGINE`, `AZURE_SPEECH_KEY`,
`AZURE_SPEECH_REGION`, `OPENAI_API_KEY`, `AZURE_REALTIME_*` and `REALTIME_PROVIDER`
override the same values from the environment, which is how the service runs on a
laptop with no instance role to borrow.

### "Make it cheaper"

Stopping the instance when idle is the main lever; the ALB bills regardless. A
smaller `instanceType` works but `whisper.cpp` transcription gets slower. Do not
suggest removing the ALB — it terminates TLS, and the security model depends on
the instance being unreachable except through it.

## The surfaces, and which one persists

Know this before answering any question about long-running work:

| Surface | Who owns `claude` | Survives closing the app | Shared live across devices |
| --- | --- | --- | --- |
| Chat (`/`) | `claude-chat` systemd service | yes | yes — `getBySession` hands both sockets the same process |
| Extension panel — **the editor's default** | `claude-broker.service`, reached through the wrapper | yes | yes — one process per conversation, every page attached |
| Extension panel, broker stopped | extension host, tied to the browser | **no — dies in ~5s** | **no — it forks** |
| `cc` / tmux | the tmux server, owned by `claude-tmux.service` | yes | yes — multiple tmux clients, one session |
| Mux (`/chat/mux`) — the desktop view | a chat pane: `claude-chat`, exactly as the chat. A terminal pane: the tmux server, exactly as `cc` | yes | yes — a chat pane *is* the chat, framed, and the phone opens it from its list; a terminal pane is `cc <project>/slot-N`, so any other terminal joins it |

The mux is not a fifth owner, and that is deliberate: each of its two kinds of pane
is an existing surface in a frame — the chat app, or a tmux client running `cc` — so
it inherits that surface's ownership and its `--session-id` and `sessionOwner`
checks below rather than needing its own. See
[The mux and its slots](#the-mux-and-its-slots).

The middle two rows are the same panel. Which one you get depends on whether
`claude-broker.service` is running and `claudeCode.claudeProcessWrapper` points at
it, so when someone reports the panel forking, that is the first thing to check:

```bash
systemctl status claude-broker
grep claudeProcessWrapper /workspace/code-server-data/User/settings.json
```

That 5 seconds is measured, not guessed: a probe on a live box recorded
`exthost` and `claude` both `DEAD` five seconds after `ws_conns` hit 0, mid-turn.
`ReconnectionGraceTime` does appear in the code-server bundle, which misleadingly
suggests a 3-hour grace period — it does not apply here. Do not tell someone the
extension will keep working in the background; it will not.

**The panel does not just fail to share — it forks, silently, and that is worse.**
code-server creates one extension host *per browser page*, so a second device (or
a plain reload) gets a second extension host, which starts its own `claude` and
resumes the same session id from the transcript on disk. The first process is
never told anything and keeps running. Two live processes then append to one
`.jsonl`, and the two devices diverge from the moment of the fork. Observed on a
live box, 2026-09-17: extension hosts 314616 (phone) and 319472 (laptop) under one
code-server, three `claude` processes, one project directory — and an agent whose
own `CLAUDE_PID` changed from 315100 to 319986 mid-conversation while the phone's
315100 was still running. What the user sees is "I opened my laptop and Claude was
idle, and now they're telling different stories".

**The fix is outside the extension host, because nothing can fix it inside one.**
No supported API shares an extension host between two page loads, so the panel
cannot solve this itself and neither can this repo by patching it. What it can do
is take the process out of the extension host altogether:
[`claude-broker/`](claude-broker/) is a daemon owning one `claude` per
conversation, and the extension's own
`claudeCode.claudeProcessWrapper` setting — "Executable path used to launch the
Claude process" — points the panel at
[`claude-broker/wrapper`](claude-broker/wrapper) instead of the binary. The
wrapper hands its stdio to the broker and every page attaches to the same process.
The panel is not modified, not patched, and does not know: it sees an ordinary
stream-json conversation on stdio.

The contract is that the wrapper is exec'd with the real claude path as its first
argument, then the extension's own args — confirmed in the shipped bundle, not
assumed:

```js
if (J) return { pathToClaudeCodeExecutable: J, executableArgs: X ? [X] : [], env: Q, viaProcessWrapper: !0 };
```

so `process.argv[2]` is the binary and `slice(3)` is everything the extension
wanted. Setting a wrapper also makes the extension resolve permission mode itself
(`resolvePermissionModeInCli: !W0("claudeProcessWrapper")`), which is why the
wrapper must pass the args through untouched.

**"Exec'd" is conditional, and the condition is the wrapper's file extension.**
Reading only the pairing above is how the panel came to be broken on 2026-09-17.
The other half of the bundle turns that pair into a command line, and it branches
on the configured path's extension:

```js
function qW0($){return![".js",".mjs",".tsx",".ts",".jsx"].some((Q)=>$.endsWith(Q))}
let b=qW0(G),          // G = the configured wrapper path
    p=b?G:Y,           // Y is the JS runtime, "node"
    C=b?[...z,...d]    // exec'd:     wrapper <real claude> <args>
      :[...z,G,...d];  // under node: node <real claude> wrapper <args>
```

`executableArgs` comes first in both branches, so a wrapper named `wrapper.js`
hands node the real `claude` as its entry script: node parses an ELF binary as
JavaScript and the panel reports `SyntaxError: Invalid or unexpected token` with
Claude never having started. Hence the extensionless filename, its `"type":
"module"` from the sibling `package.json`, its shebang, and its executable bit —
all four are load-bearing, `install.sh` refuses a JS-looking path, and
`broker-test.js` exec's the file exactly as the extension does rather than
spawning `node wrapper`. A test that builds its own argv proves nothing about the
panel; that is why the break got through a green suite.

**The wrapper fails safe, and every change to it must keep doing so.** It sits in
front of the only interface the user has, so no broker, a stale socket, a refused
join, or a malformed handshake all fall through to exec'ing the real binary — the
panel forks again, which is merely the old behaviour, rather than failing to start.
That is what makes `systemctl stop claude-broker` a complete rollback with no
settings change and no deploy. `claude-broker/broker-test.js` asserts both halves
and `deploy.sh` will not deploy without it.

**One conversation, one process — between surfaces, not just inside one.** Every
row of the table above solves sharing within its own surface, and each of them
believed it was the only thing on the box running conversations. On 2026-10-25 a
chat was started in the phone UI, the editor came up 71 seconds later, and the
panel resumed *that* session id — the newest transcript in the folder it had open.
For ten minutes two processes in two systemd units held one conversation: the
chat's did the work and moved into a worktree, the panel's sat on the history it
had read at startup, and when the user typed, the stale one answered. It re-ran a
survey the other had finished, overwrote its output file, and reported that
"another session" was doing the job — itself. Nothing could have seen it: a new
chat had no id in its argv at all, because `chat-service` let the CLI name it and
only learned the name from the `init` event a second later.

So a conversation is now identifiable from outside the process holding it, and
both owners ask before resuming one:

- `chat-service` passes `--session-id` for every chat it starts, which is what
  puts the id in `/proc` from the first instant. Taking that flag away does not
  break a test you will notice — it makes the two guards below silently blind,
  which is exactly the state that produced the incident.
- `ownerOutside` (broker.js) and `sessionOwner` (claude-status.js) ask the same
  question from the two sides: is a `claude` outside *this* service already
  holding this id. Where one is, the conversation is resumed with
  `--fork-session` — same history, new id, its own transcript — instead of
  becoming the second writer on someone else's. The chat says so in the thread
  when it happens, because silence is what made the original expensive.
- Both also match a live conversation on the id alone when the directory does not
  match (`liveBySessionId`, `liveSession`). A session that moves into a worktree
  mid-conversation keeps the directory it was keyed under while its transcript
  moves below it, so the pair legitimately misses — and a miss used to mean a
  second process on one transcript.

A fork is the fallback, not the goal: it is what this can offer because there is
no joining a process another unit owns. If you are adding a fifth surface, give it
`--session-id` and these two questions before it resumes anything.

`cc` / tmux stays as the surface that depends on nothing — no broker, no wrapper,
no extension setting — and is the real CLI rather than a UI over it. Verified on
the box: two simultaneous clients, one session, one `claude`, and the session still
alive after both detached.

**A tmux session is only as durable as the cgroup its server is in.** Sessions are
forked by the tmux server, so they inherit *its* cgroup, and a server first
started by `cc` from an editor terminal is inside `code-server.service` — which is
`KillMode=control-group`, systemd's default. So `systemctl restart code-server`,
which every deploy does, kills the sessions: being detached from the terminal is
not enough. Observed 2026-09-17, a task running in tmux dying mid-deploy, which is
the exact failure tmux was introduced to prevent. Hence `claude-tmux.service` owns
the server, with `exit-empty off` so it stays alive with no sessions — otherwise
the next `cc` quietly starts a replacement in the wrong cgroup and durability is
lost with nothing to see. `cc` warns when it finds a server outside that unit.
Never `systemctl restart claude-tmux` from a deploy path; `enable --now` only.

**The same cgroup lesson applies to the broker**, and for the same reason: the
conversations are its children, so they live in `claude-broker.service`'s cgroup.
Never `systemctl restart claude-broker` from a deploy path — `enable --now` only,
exactly as with `claude-tmux`. A restart ends every live conversation, which is the
failure the service exists to prevent, so a change to `broker.js` lands at the next
deliberate restart, chosen at a moment when losing the running work is acceptable.

### The mux and its slots

`/chat/mux` is the laptop's view: every project down the side with its eight
worktree slots, a light on each (orange working, blue ring finished while nobody
looked, amber another surface has a process there), and one to eight panes side by
side. Linked from the chat list's tab bar.

**On a phone** (≤760px, the width app.js calls narrow) it is one pane at a time:
mux.css hides every pane but the focused one, the sidebar becomes a drawer behind ☰,
and `renderTabs` puts a tab per pane in a bar on top. Which panes exist is still the
layout's, and the layout is per device (localStorage), so a phone's never touches a
laptop's. Opening something there does not hand the frame the keyboard. Nothing in
that is a desktop rule: the desktop styles are untouched, and a touch screen only
adds `@media (hover: none)`, which shows the slot rows' hover-only `+`.

**On a touch screen the terminal page** (embedded or not) has the keys a phone lacks,
a compose line that types its text and then, separately, Enter (sent together the
CLI reads a paste and puts a newline in its prompt), and **tap-to-choose**:
`choiceAt` reads the tapped row from xterm's buffer and, if it is a numbered option
in the same menu as a `❯`-marked one, sends its digit. A numbered list in prose is
not a menu, so a tap there types nothing. It never calls `term.focus()` by itself,
which on a phone would open the keyboard over the screen.

**The editor overlay's voice is the mux's too.** `mux.html` loads
`pwa/mobile-overlay.js` (as `/chat/mobile-overlay.js` — deploy.sh and the host
installer copy it into the chat service's `public/` beside `sw.js`), and `mux.js` sets
`window.cmoHost = { name: 'mux' }` first. In that mode the overlay leaves out
everything that only means something in code-server — dictation, the project switcher,
the layout rescue, the terminal chord, install offers, the reload history, the wake
lock, the Disconnect-frame filter — and draws no chip, since the rings already say
it. What it keeps is the status sheet: the last message rendered, Read aloud with the
server voices and speed, Talk it over, the answered-question note, and following
the sheet while it is open, which reads out each new message as it lands. It
puts `cmoHost.open({ cwd, sessionId })` on the host. Each pane's 🔊 button calls it
with that pane's slot, plus its conversation if it is a chat. A terminal pane pins
nothing, so the answer is the slot's most recent transcript, which is the CLI in it.
The sheet stays on the pane it was opened for, and changing panes forgets the last
one before asking, so the poll never reads another slot's history out as news. The
floating bar is there only while something is playing. Once the sheet is dismissed
it is the only Stop. Dictation is deliberately not offered here.

A pane is a **chat** or a **terminal** — the sidebar's "New" switch picks what a `+`
opens, and each pane's header switches its own slot between the two. Both kinds are
frames on something that already exists, never a second implementation of it.

**A chat pane is the chat app in a frame** — `/chat/?embed=1&cwd=<slot>&session=<id>`
— not a second client. That is the whole design, for two reasons. The conversation
is owned by `claude-chat.service` the moment it starts, so shutting the laptop
mid-turn loses nothing and the phone finds it in its list, labelled with the slot.
And there is one renderer, one voice stack and one set of tool cards to keep right.
`EMBED` in app.js is what an embedded page leaves out: it writes no device tabs
(eight frames would clobber the phone-style set), holds no wake lock, repairs no
push subscription, loads no list and polls nothing. It reports its state to the
mux with `postMessage`, same-origin only, and the mux does the rings.

**A terminal pane is `cc` in a frame** — `/chat/term?embed=1&project=<p>&slot=<n>`,
an xterm.js page whose socket is `/ws/term`. `chat-service/terminal.js` runs
`cc <project>/slot-N` (or `cc <project>` for the main checkout) on a pseudo-terminal
through `term-relay.py`, and `cc` does what it always does: start the tmux session if
it is missing, attach. So the Claude in it belongs to `claude-tmux.service`, and the
pane is one more tmux client. What follows from that:

- **The socket refuses when no tmux server is running.** `cc` would start one, and a
  server started from here is a child of `claude-chat.service`, in its cgroup, so the
  next deploy would end every session in it — the failure the tmux section above is
  about. Better no terminal than one that quietly dies on Thursday.
- **Every tmux target is exact** (`=name`, or `=name:` for a window). A bare
  `-t claude-demo` is a *prefix* match when nothing has exactly that name, so before
  this `cc demo` with no session would rejoin `claude-demo/slot-3` — another agent's
  terminal — and call it yours. `cc`, `terminal.js` and the admin kill all use `=`,
  and `term-test.js` checks it against a fake tmux.
- **A slot's session is `claude-<project>/slot-N`**, and `cc` accepts that name or the
  slot's path. The basename alone (`slot-3`) is in every project.
- **Scrolling is tmux's copy mode**, driven from the server (`copy-mode -e`,
  `send-keys -X scroll-up`), because tmux draws on the alternate screen and the
  emulator has no history of its own. Nothing turns on tmux's mouse mode, which would
  change the session for every other client attached to it.
- **The ring comes from the transcript.** The page only sees bytes, so the mux polls
  `/api/claude-status?cwd=<slot>` for terminal panes on screen, and also rings on the
  terminal bell. Hanging up the pane — closing it, a network drop, a chat-service
  restart — is a SIGHUP to `tmux attach`, which is a detach.
- On the ALB, `/ws/term` falls under the default rule, not the `/api/*`+`/ws` one
  that answers 401: an expired ALB session gets a redirect the upgrade cannot follow.
  `term.js` covers it by asking `/api/auth-check` on any close, which *is* under the
  401 rule, and sending the page to login. Adding `/ws/*` to that rule is right, but
  it is an infra change and lands with the next full deploy.

**Slots** (`chat-service/slots.js`) are ordinary linked worktrees at
`<project>/.claude/worktrees/slot-1` … `slot-8`, each on a branch of the same name,
made when a project is cloned or created and on first use otherwise. That path is
the one `projectPlaces` already reads, which is why nothing else had to change for
a slot's conversations to appear in the phone's list. The rules that keep them safe:

- `.claude/worktrees/` goes in the project's `.git/info/exclude`, not its
  .gitignore — no project is left with an uncommitted change by being cloned, and
  the main checkout's `git add -A` never records eight nested checkouts.
- A new chat in a slot first fast-forwards it to the default branch, after a fetch,
  **only** if it is clean and has no commit the base lacks. `--ff-only` is the
  argument: there is no reset anywhere in this code, so a slot holding work is
  started on as it is, and the pane says so.
- Opening an *existing* conversation does not touch its slot.
- `removeProject` refuses while any worktree holds uncommitted changes. It used to
  `rm -rf` them unasked, because `findRepos` skips dot-directories and a worktree's
  `.git` is a file; with eight slots per project that stopped being an edge case.
  Their commits were already safe — a slot's branch is a branch of the root repo,
  so `push --all` and the per-branch unpushed check cover it.
- The generated `/workspace/projects/CLAUDE.md` tells a session in a slot not to
  enter another worktree and never to remove a slot, because its general advice —
  "remove the worktree when you are done" — is exactly wrong for one.

A slot is "held" when any `claude` on the box has its cwd there, read from `/proc`
(`claudeCwds`), so one taken by the panel or a tmux session reads as taken, and
`/api/slots` says which slots have a terminal session (`terminal`, `rootTerminal`).
Starting a second agent in a held slot — a chat beside a terminal, or the reverse —
asks first; joining a slot's running terminal does not, because that is what a tmux
session is for. The `+` on a project picks a free, clean one. A slot a pane names
that does not exist yet (a restored layout, a removed worktree) is made on demand by
both kinds of pane, instead of failing as `spawn claude ENOENT`.

### Seeing all four at once: `/chat/admin`

Every note in the section above was found with an SSM shell, `ps` and
`journalctl` — ten forgotten probes at ~205 MB each, three `claude` processes
against one project, a tmux server in the wrong cgroup. None of it was visible
from any of the app's own surfaces. [`chat-service/admin.js`](chat-service/admin.js)
is that shell, on a phone: what is running on each surface, what is wrong with it,
and stopping one thing at a time. Four decisions in it are load-bearing.

**It is a screen inside the chat service, not an app of its own.** A second app
would be a second authentication implementation, and this repository's founding bug
was auth living in the wrong place. It is behind the same gate as `/ws` and adds no
authority the caller did not already have — that gate hands out a shell with
`bypassPermissions`. Every one of its routes is in the `guarded` list in
`auth-test.js`; unauthenticated, `/api/admin/overview` would be a remote inventory
of the box and `/api/admin/kill` a remote kill.

**It is served at `/chat/admin`** because nginx already routes `/chat/` to the
service with the prefix stripped. A new nginx location would mean editing
`bootstrap.sh` — which `--app-only` does ship now, but which cloud-init will not
apply on its own, and which is therefore still the slowest thing in this repository
to get live. See the gotchas.

**The broker is inspected from the outside, with `ps` and `/proc`.** Adding a
list/kill op to `broker.js` is the obvious move and the wrong one: its
conversations are its children, so the change would only take effect at a restart,
and a restart ends every live conversation. Their argv already carries
`--resume <session id>`, so today's broker needs no change at all. The same argv is
what tells a real conversation from the panel's never-written-to probe.

**Every stop is a refusal first.** `AdminBlocked` → 409 with a reason, which the
client turns into a specific question, exactly as a project removal does. `force`
is the answer to that question: never a default, never inferred. And a pid from the
client is only ever signalled after being re-found in a freshly-read process table
under the parent we expected — the one thing this file must never become is a way
to turn a caller-supplied string into a signal for an arbitrary process.
`admin-test.js` tests the refusals hardest, and `deploy.sh` will not deploy without
it.

**It says which build it is.** The first card is the payload the box is running,
because "the box is behaving oddly" and "the box is running something older than I
think" arrive as the same sentence and only one of them is worth debugging. It comes
from the same [`build.js`](chat-service/build.js) the chat's settings sheet uses, so
the two surfaces cannot disagree.

**A bulk stop asks one question that carries all the refusals.** Fifteen panel
sessions across two projects is the state this page is actually opened in, and
tapping Stop fifteen times — answering fifteen separate 409s — is what "Stop all"
in a section label, and per project in the band heading above its rows, exists to
replace. It is still the same `/api/admin/kill`, once per session, with `force`: the
client aggregates what the refusals would have said ("2 working right now, 1 open on
a device") into the single confirm, and the server re-reads the process table and
re-checks parentage for every pid, exactly as before. There is deliberately no bulk
route — a loop over an audited kill is cheaper than a second code path that can
signal things, and the list it loops over is re-fetched first, because polling stops
while the tab is hidden and a stale list means killing a turn that started after it
was drawn.

## Being told a turn ended

The thing that made this box worth building is starting a turn and walking away.
Which leaves one question — *is it done yet* — and three answers, deliberately
separate, because they fail in different places and one of them can wake a phone up
at night.

**A conversation this app is running announces itself on screen.** `announce()` in
`app.js`: a toast, and a buzz through the Vibration API. It knows the turn ended
because it is holding the socket, so nothing has to be polled or guessed.

**A conversation this app is *not* running is watched from the transcripts.**
`chat-service/turn-watcher.js`, started by `server.js`, polls every five seconds
and sends a Web Push notification when a session in the editor panel or under tmux
finishes a turn. It reads the same `lastExchange()` as `claude-status.js` rather
than asking the broker, because the broker has no such event to subscribe to and
adding one means restarting it — which ends every live conversation, the cgroup rule
again. Its whole design is about not buzzing for nothing, and each rule is there
because the failure it prevents would make the feature something you turn off:

- **Nothing is announced for what was already finished when the watcher started.**
  The first scan seeds silently, so a deploy does not replay the day.
- **This app's own conversations are excluded**, by session id from
  `manager.liveSummary()`, *including after they exit* — otherwise a chat you were
  just reading buzzes as you close the app. That is also why `announce()` keeps its
  toast and its buzz: the two surfaces do not overlap, so neither is redundant.
- **One notification per conversation**, with a per-conversation `Topic` and `tag`
  and `renotify: true`, so a second answer replaces the first rather than stacking
  behind it.
- **Nothing older than ten minutes**, and a content digest so a rewritten
  transcript is not a new answer.
- **A turn that was *killed* says so, instead of claiming it finished.** Claude Code
  writes an interrupted turn as an assistant entry with `stop_reason:
  'stop_sequence'` and the text `No response requested.`, and a context overflow the
  same way with `Prompt is too long` — both of which `inferState()` read as idle, so
  the phone got "Claude finished" over a body quoting the artifact. That is the one
  moment the person has to come back and say `continue`, announced as the one moment
  they need not. `NO_ANSWER` in `claude-status.js` maps those two strings to a
  `cutOff` of `interrupted` or `overflow`, exposed on `/api/claude-status`; the
  watcher's body opens with "Stopped" and says which, and the overlay's sheet, chip
  and spoken line follow the same field. Two traps, both covered by tests: the
  artifact is *not* the last thing said (the real last message is the one before it,
  so that is what gets previewed), and because that message was usually announced
  already, `cutOff` is part of the digest — otherwise the stop looks like a repeat
  and is swallowed, losing the only notification worth having.

**A turn that stopped to ask you something is a third state, not another kind of
finish.** `AskUserQuestion` is written to the transcript as an ordinary `tool_use`
with `stop_reason: 'tool_use'`, and the process really does have a turn in flight — so
the transcript said "working", the broker agreed, and every surface reported a
conversation that had stopped and would stay stopped until a person walked back to the
panel. Measured across the transcripts on this box: 71 answered asks, a median wait of
three minutes, a longest of 5.9 hours, three sitting unanswered as it was written. The
fact neither source has on its own is whether a `tool_result` for that ask arrived, and
that is in the file — so `lastExchange()` decides it, reports `state: 'question'`, and
`claudeStatus()` lets it beat a live broker's "working" (the second place the
transcript outranks the broker, after `OVERRIDE_QUIET_MS`). It takes a live process: an
ask with nothing running it is idle in the ordinary way, because there is nothing left
to answer *to*. Downstream, all three surfaces say so — the watcher buzzes with the
question and its option labels, the overlay's chip says "Claude is waiting for your
answer · \<header\>" with a steady amber dot rather than a blinking one, its sheet
prints the question, and a list row reads "waiting on you". The chat app is not
involved: it runs `claude --print`, which is not offered this tool at all, so a
question only ever belongs to the panel or to tmux.

**An answered question that the panel redraws is the other half of it, and it can only
be fixed from outside.** Reopening a conversation makes the panel re-render every
question in it as a fresh card, answered or not, with nothing to distinguish one from a
live one — so the risk is answering the same question twice, days later. The panel is a
vendor webview and the overlay is forbidden to reach into it, so the card cannot be
changed; what can be done is to say, beside it, that the answer is already on disk and
what it was. `toolUseResult.answers` in the transcript holds the chosen labels verbatim,
`question.answered` and `question.answer` carry them out on `/api/claude-status`, and the
overlay shows them *only* on a replay — the first status answer of a page, or a switch to
another conversation, which are exactly the two moments the panel redraws history.
Anywhere else it would be a fact repeated at someone who has already read it. Three
things an unanswered ask can be, and `question.pending` is what tells them apart: the
one being waited on, one the conversation stopped in the middle of (nothing running it —
the sheet says to send the answer as an ordinary message), and one that was dismissed
and walked past, about which the right thing to say is nothing at all.

**A notification names the conversation, and tapping it goes there.** Both halves of
that were missing, and the second one was reported as a bug — "clicking does nothing,
just dismisses it", on Android and on the desktop. It was accurate: `notificationclick`
closed the notification and stopped, on the argument that there is no URL for a
conversation inside the panel. Half of that is still true and the conclusion was still
wrong; a tap that does nothing is indistinguishable from a broken app. So:

- **The title is deployment → project → conversation** — `notificationTitle()` in
  `turn-watcher.js`, built on the same `appTitle()` as a home-screen icon so a phone
  carrying two deployments names them the same way in both places. Android gives a
  title one line and truncates the end, so the order is widest to narrowest and the
  conversation's name is the part that gets cut (marked with an ellipsis, and dropped
  entirely rather than left as a fragment when the project fills the line).
- **The state moved into the body**, where there is room to say what happened. A
  notification arriving is itself the news that a turn ended, so "Claude finished" was
  the least informative thing in the title — but the two cases that are *not* an
  ordinary finish still have to be told apart at a glance, and they lead the body
  instead: `cutOffBody()` opens with "Stopped", and a question with "Waiting on you —".
  A finish can be ignored; a question stops the conversation until someone answers.
- **The payload carries a `url`, and the server is the only side that can build it.**
  `projectStartUrl(name, path)` plus `&session=<id>`: the phone has a mangled transcript
  directory name, and `?folder=` needs the real path. A transcript whose directory is
  not a project gets no URL and falls back to `/chat/`, which is also where the test
  notification goes.
- **The tap opens that project's window, not the chat app.** Notifications only ever
  fire for sessions this app is *not* driving, so resuming one in the chat app would
  start a second `claude --resume` against the same transcript — the thing
  `claude-broker` exists to prevent. `/p/<project>/` is an installed app with one
  window, so an existing window for that project is focused rather than navigated: the
  session id then travels by `postMessage` (`cw-notification-click`), because the URL
  of a window that already exists cannot be changed without the workbench reload that
  focusing was meant to avoid. Anything that is not a path on this origin is refused in
  favour of `/chat/` — the value arrives over the network, and `//elsewhere/` reads like
  a path.
- **The overlay is what turns an address into a conversation.** It reads `?session=`
  before its first status fetch, pins it (`pinnedSession`, the same override the
  conversation list uses) and opens the status sheet — the last message, the opening
  prompt, Read aloud. Then it takes the parameter out of the URL with `replaceState`,
  because the workbench reloads itself on every bfcache restore and would otherwise
  re-open that sheet for a notification tapped hours ago. `sw-test.js` loads the worker
  with `self` stubbed and `overlay-test.js` boots a second document at a `?session=`
  URL; a service worker has no console anyone reads, so both of those failures look
  exactly like a phone ignoring the tap.

**Notifications are switched on from either surface, and there is only one of
them.** The chat app's Settings sheet has a checkbox; the editor overlay's status
sheet has a button (`toggleNotify` in `pwa/mobile-overlay.js`). Same origin, same
worker under `/chat/`, same subscription, same row in the device list — turning it on
in one place turns it on in both, which is why the wording says "this device" and
never "this app". The editor needed its own switch because the sessions being watched
are the editor's: someone who only ever opens `/editor/` could not reach the one
feature written for them. The plumbing is deliberately duplicated rather than
imported — the overlay is a plain script nginx injects into code-server's HTML, and a
switch that depends on a second request and on code-server's CSP is a switch that
fails where it is needed. Both copies obey the same two rules: ask
`Notification.requestPermission()` before anything is awaited (mobile Chrome refuses a
prompt that is no longer the consequence of the tap), and tell the server *before*
the browser drops a subscription (the endpoint is what identifies the device, and it
is gone afterwards). `overlay-test.js` and `smoke-test.js` each assert that order
from a log of acts, and both checks were confirmed to fail when the order is swapped.
One thing the overlay must not do: `await navigator.serviceWorker.ready`. That
resolves for the worker controlling *this* page, and `/chat/sw.js` will never control
`/editor/` — it hangs forever. `register()` returns the registration; use it.

Push itself is `chat-service/push.js`, hand-rolled: VAPID plus RFC 8291, ~400 lines
of node crypto and no new dependency on a box whose whole job is running shell
commands. The keypair and the device list live under `CLAUDE_HOME` (not in
`/opt/claude-web`, which a deploy replaces), so shipping does not silently
unsubscribe every phone. All four `/api/push/*` routes are gated and listed in
`auth-test.js`: a subscription endpoint is a capability to write on the operator's
lock screen, and the list of them is an inventory of their devices.

**A conversation you are looking at in the editor is polled while you look.** The
overlay's status sheet re-asks `/api/claude-status` every five seconds while it is
the sheet on screen, and reads a newly changed message aloud. Bounded by that sheet
on purpose — a phone that starts talking on its own in a meeting is worse than one
that stays quiet — and unbounded speech is fenced by the same rule: only while the
sheet is open, only when the *text* changed, never on a change of conversation.
This is independent of push and must stay that way; the sheet works with
notifications refused, and notifications work with the sheet never opened.

**The prompt a conversation began with is on the same sheet, copyable.** It is the
message most worth sending again — the brief, the standing instructions — and the one
a long conversation puts furthest out of reach: once it has been compacted the CLI's
own history no longer holds it, the chat app renders only the last 400 messages of a
transcript, and nobody scrolls a 12MB conversation back to the top on a phone. What
is easy to miss is that nothing deleted it. **Compaction appends** — 8 compact
summaries in one file on this box — so the opening prompt is still sitting a kilobyte
from the start of the transcript, in full, for every conversation that already
exists. `firstPrompt()` in `claude-status.js` reads it out of a bounded *head* window,
the mirror image of the tail read beside it: 256KB first, widening to 4MB for the five
transcripts of 92 here where a screenshot pasted into the opening message puts the
words 350KB in. Three things about it are deliberate.

- **Nothing caches it.** A cache written from today onwards would be empty for
  exactly the old conversations someone goes looking in, and it would be a second
  copy of something immutable that is already on disk.
- **It is `/api/first-prompt`, not another field on `/api/claude-status`.** The two
  have opposite lifetimes: that answer is polled every four seconds while a turn runs
  and differs each time, while this one cannot change for as long as the conversation
  exists. So the overlay asks once per conversation and keeps it for the life of the
  page — `overlay-test.js` asserts that a redraw does not re-ask.
- **A typed prompt is told from an injected one by `origin.kind === 'human'`**, which
  the CLI now stamps on prompts a person sent (57 of 93 transcripts here, and
  everything written since). A `peer` or `system` origin is another agent or the
  harness talking and is skipped, as are sidechain entries, which belong to
  subagents. Transcripts older than that field fall back to
  `isSyntheticUserText()` — imported from `session-manager.js` rather than copied,
  because two lists of those patterns would drift and the cost of the drift is
  showing someone a "prompt" they never sent.

## A window per project, on a phone

On a laptop each project can have its own window. On Android it cannot: Chrome
gives an installed web app exactly one window, and there is no API that opens a
second — this was checked before anything was built, and the answer does not depend
on our code.

What *is* per-app is identity. A manifest whose `id` differs describes a distinct
application even when served from the same URL, and a distinct application on
Android is a distinct home-screen icon with its own task in the recents switcher.
So `chat-service/manifest.js` hands out one manifest per project — same origin,
same code, same login, same push subscription, differing in `id`, `start_url`,
`scope` and the name under the icon. One install per project, once, and the second
window the user asked for.

**A differing `id` is not enough, and that is why `/p/<name>/` exists.** A
manifest's `scope` is a path prefix, and scope matching *ignores the query string*.
While every project's `start_url` was `/editor/?folder=<path>` with `scope: '/'`,
every project manifest described an app with the same scope as every other one —
so Android had one installed web app claiming the whole origin and refused every
install after the first as "already installed". On Android the installed WebAPK
claims URLs by scope; the `id` never gets a say. A window per project therefore
needs a *path* per project:

- `chat-service/manifest.js` mints `id`, `start_url` and `scope` from
  `projectWindowPath(project)` — `/p/<name>/` — so all three agree by construction.
- `pwa/mobile-overlay.js` sends every navigation there through `projectHref()`, so
  the switcher rows, their ⧉ new-tab siblings and the redirect after creating a
  project all land inside the scope the manifest claims.
- `infra/userdata/bootstrap.sh` routes it. That route is a nginx location, and the
  first attempt to ship it found the trap that cost this feature a day: the stack
  went green, `cdk diff` said there were no differences, and the route had never
  reached the running nginx, because cloud-init does not re-run its user-data stage
  on a stop/start. `deploy.sh --app-only` now installs the payload's `bootstrap.sh`
  before reprovisioning, so an edit here does ship — but verify the route through the
  public domain, not `localhost`, because that is what caught the redirect leaking
  `:8080`.

`?folder=<path>` stays in the URL because it is what code-server reads to open the
folder and what the overlay's `folder()` reads to know which project it is in; the
path segment carries no information and is not redundant, because scope cannot see
a query. Both halves are built together in the two functions named above, and
`manifest-test.js` checks the route in `bootstrap.sh` matches what they hand out —
a drift there puts an error page behind every icon on the phone.

The route **proxies**, it does not redirect: a redirect out of scope lands the user
in Chrome's in-app browser with a toolbar, which is the "semi-window" this feature
was reported as. It proxies to the same code-server `/editor/` does, which is the
security-relevant part: whatever gates the workbench has to gate this too, because
a `/p/` path that reached it ungated would be remote code execution. That means
code-server's own password, plus — in `oidc` mode — the same `auth_request`
identity gate `/editor/` carries. Keeping the two routes identical in what they
check is the point. When the identity gate was added, all three code-server routes
needed it — this one, `/editor/`, and the catch-all — and gating any two of them
would have left the third as the way in.

The accepted cost: `/login` is outside every project's scope, so the first launch
after a lapsed session shows Chrome's toolbar until the redirect lands. A scope wide
enough to hold the login page is wide enough to collide with every other project.

**The `<link rel="manifest">` has to be injected into the editor's document**, which
is why `pwa/mobile-overlay.js` does it (`linkProjectManifest`) rather than the chat
app: a browser installs the manifest linked from the page you install *from*, and
that page is code-server's, which ships no manifest at all. The overlay replaces any
existing link rather than appending — the first one found wins, so appending would
silently install the wrong app — and keeps `crossorigin="use-credentials"` for the
same reason the chat's own link does. The install itself is a button in the project
sheet, using `beforeinstallprompt` where Chrome offers it and telling the user which
menu item to use where it does not (every iOS browser).

**A path per project was still not enough, and the other half is that the chat app
had to get out of the way.** Its manifest claimed `scope: '/'` — the whole origin,
every `/p/<name>/` URL included — and an installed app claims every URL inside its
scope, so one chat icon on a home screen claimed every project and Chrome answered
each project install after it with "already installed". The phone reported exactly
that, on a freshly moved domain where the chat icon was the first thing installed.
So the chat app now lives at `/chat/`:

- `pwa/manifest.webmanifest`: `start_url` and `scope` are `/chat/`, and `id` is
  pinned to `"/"`. The `id` is explicit because it otherwise defaults to `start_url`
  — and a changed `id` is a *different application*, so every phone with the chat
  icon already on it would keep a dead one and install a second beside it instead of
  updating the one it has.
- `infra/userdata/bootstrap.sh`: `location = /` is now a path-only 302 to `/chat/`.
  That redirect is not a courtesy. An install can only be offered from a page inside
  the scope of the manifest it links, so a bare domain still serving the shell in
  place would be a chat app nobody could add to a home screen.
- The `Editor` shortcut points at `/chat/editor/`, which is inside the scope and
  redirects out, because a browser drops an out-of-scope shortcut **silently** — a
  menu item that quietly stops existing.
- `manifest-test.js` asserts the two scopes do not overlap in either direction, that
  `id` stays pinned, that every shortcut is in scope, and that both nginx redirects
  exist and are path-only. Nothing can see that collision by reading either file
  alone, which is how it survived a release.

The same accepted cost applies as for a project: `/login` is outside `/chat/`, so
signing in after a lapsed session shows Chrome's toolbar until it lands back.

A phone that installed the chat icon *before* this shipped still holds a WebAPK
claiming `/`, and will keep refusing project installs until Chrome updates it.
Removing the icon and adding it again is the immediate fix, and **Check this install**
in the project sheet (`explainInstall`) is how to confirm that is what is happening
rather than guess. It prints the build of the overlay, the manifest this page
links and what the server says is in it, whether this page is inside that manifest's
scope, whether this is a browser tab at all, whether `beforeinstallprompt` fired, and
— via `navigator.getInstalledRelatedApps()` — which installed app Chrome thinks this
page belongs to. That last answer is only possible because `manifest.js` declares the
chat app in `related_applications`; the API answers about nothing else.
`prefer_related_applications: false` is stated explicitly there, because `true` is the
one member that would suppress the install offer this is trying to explain.

The scope line in that report earns its place now that scopes are narrow: an install
cannot be offered for a page *outside* the manifest it links, so opening a project at
`/editor/?folder=…` or at the catch-all — both still work, and both are outside
`/p/<name>/` — makes Chrome silent for a reason that is indistinguishable from
"already installed" unless something says which one it is.

**A workbench left open across a deploy runs the script it loaded**, which is
indistinguishable from a feature that does not work. `/mobile-overlay.js` is served
`Cache-Control: no-cache`, so a reload is enough — and `OVERLAY_BUILD`, printed by the
install check, is how to tell the two apart without arguing about it. Bump it when this
file changes in a way anyone would go looking for.

`GET /manifest.webmanifest?project=<name>` is gated like everything else, and is in
`auth-test.js` for a reason that is easy to miss: it answers 200 for a project that
exists and 404 for one that does not, so ungated it would enumerate the project
tree by guessing names.

## Gotchas that look like bugs

Things that have burned people, in this codebase specifically:

- **`pwa/manifest.webmanifest` and `chat-service/public/manifest.webmanifest` are
  two copies.** `deploy.sh` copies `pwa/` over `public/`, so `pwa/` wins. Edit
  that one. Same for `sw.js`.
- **The manifest link needs `crossorigin="use-credentials"`.** Manifests are
  fetched with credentials omitted by default, which means 401 and no install
  prompt now that static files are gated.
- **`userDataCausesReplacement: false` is deliberate, and does not mean userdata
  edits are free.** The bootstrap script's S3 asset hash is in userdata, so
  leaving the flag on replaced the instance on every script edit; `deploy.sh`
  re-runs `/opt/bootstrap.sh` on the live instance instead, which is why
  `bootstrap.sh` must stay idempotent. What CloudFormation does with a changed
  `UserData` on a *running* EBS-root instance is stop → `ModifyInstanceAttribute` →
  start, not replacement — measured 2026-09-18 from CloudTrail: change set executed
  09:47:17, `StopInstances` 09:47:24, `ModifyInstanceAttribute` 09:47:47,
  `StartInstances` 09:47:48, box up 09:47:54, `UPDATE_COMPLETE` 09:48:02. Same
  instance id, same volumes, so `/opt/claude-web` and `/workspace` both survive.
  Two things follow anyway. First, every process on the box dies at 09:47:24,
  **including a `deploy.sh` being driven from the box** — the stages after
  `cdk deploy` (SSM waits, payload upload, verification) never run, and the shell
  reports nothing because it is gone. Proven the same morning: a `cdk deploy` from
  here was killed seven seconds in, and no payload reached the instance. So drive a
  full deploy from another machine. Second, a stop/start does *not* re-run
  cloud-init's user-data stage, so the new bootstrap script is fetched and installed
  by nobody — see the cloud-init gotcha near the end of this file, and the
  `--app-only` bullet below for what does apply it now.
- **`./deploy.sh --app-only` is how you deploy from the box itself.** It runs
  every test, packages both extensions, pushes the payload to the instance that
  is already running, and skips `cdk deploy` — so it cannot race its own
  replacement. Use it for the chat service, the extensions, the overlay and `cc`.
  It reads the running stack's outputs into `dist/outputs.json` so the stages
  after it are the same code path as a full deploy. **It applies edits to
  `infra/userdata/bootstrap.sh` too**, since 2026-09-18: the script ships in the
  payload, and before the reprovision step the instance re-runs its *own* UserData
  with the S3 fetch swapped for the payload copy and the final `bash` dropped. That
  reuses the `sed` substitutions CloudFormation wrote — four Secrets Manager ARNs
  and the domain — so `/opt/bootstrap.sh` is replaced with the new script, fully
  substituted, and then re-run. It refuses rather than half-does it: no
  `__PLACEHOLDER__` may survive, and if the instance's UserData no longer looks like
  the script this expects, it says so and re-runs the copy on disk. What
  `--app-only` still cannot do is change an AWS resource in `infra/lib` — a security
  group, an ALB rule, an IAM policy. That needs a full deploy, from another machine.
- **A deploy disturbs the chat *and* the editor, and agents are working in both.**
  `deploy.sh` restarts `claude-chat` and `code-server` on consecutive lines (580-581),
  and each one costs something different.
  The chat half is the loud one: a conversation is a child of the claude-chat unit, so
  its cgroup takes all of them with it — the cgroup rule above, seen from the other
  side. Nothing is corrupted (the transcripts are on disk and every session is still
  offered in the chat list) but a turn in flight is lost, and the client's tabs come
  back attached to fresh processes.
  The editor half is quiet, and this file claimed for a long time that a deploy ended
  "only the chat's" conversations. It does not. Restarting code-server tears down every
  extension host, and a Claude session running in an editor panel gets `Read`, `Edit`,
  `Write` and its hook bridge *from that host* — so those calls start failing with
  "PreToolUse hook did not respond… host client may be unreachable" while `Bash`, which
  does not go through the host, keeps working. That split is the signature; it looks
  like a broken hook rather than a deploy. It also does not self-heal, because the
  reconnect is driven by the editor page: the tab has to be reloaded. Measured
  2026-09-21, when two `--app-only` deploys took the file tools out from under three
  sessions at once and left all 75 lock files in `~/.claude/ide/` stale, every pid dead
  and no listener on any recorded port.
  So **only the broker's and tmux's conversations genuinely survive a deploy**, because
  no deploy path restarts those units — and that, not the editor panel, is where long
  work belongs. Say which surfaces you are about to disturb rather than being clever
  about it when someone asks to deploy mid-task, and tell the other live sessions
  first: `ListAgents` shows them, and they cannot see your deploy coming.
  `/chat/admin` prints this under the chat's own conversations for the same reason.
- **`/api/projects` reads every transcript, so nothing may poll it.** It stats and
  opens each `.jsonl` to build the titles — fine once per screen, ruinous every few
  seconds. Anything that needs to know what is *running* asks `/api/live`, which is
  a walk of the in-memory conversation map, and the client updates the list's badges
  in place from that rather than redrawing the list. If you add ambient state to the
  UI, add it to `/api/live`; do not reach for the list route because it already has
  a field you want.
- **The CDK CLI reads a narrower slice of `~/.aws/config` than the AWS CLI.** A
  profile whose credentials come from `credential_source = Ec2InstanceMetadata`
  fails the CDK step with "Unable to resolve AWS account to use" while every `aws`
  call in the same script, with the same `--profile`, works. `deploy.sh` resolves
  the profile with `aws configure export-credentials` and hands CDK environment
  credentials instead of the flag. It also checks `sts get-caller-identity` up
  front, because the other way this shows up is a configured profile that no
  longer exists — an instance replacement takes `~/.aws` with the root volume
  while `awsProfile` in the config keeps naming it.
- **The service worker exists for notifications and has no `fetch` handler.** That
  absence is the point: a worker that mishandles a request wedges the app in a way
  the app cannot fix, because the page never loads and so the code that would
  replace the worker never runs either. That happened once, which is why the
  previous version of `pwa/sw.js` existed only to unregister itself. It caches
  nothing — a stale shell breaks a live WebSocket client rather than helping — and
  a browser will not deliver a push to anything but a worker, which is the only
  reason one is registered again. It is also registered only when the switch in
  settings is turned on, never merely by opening the app, and `/chat/reset.html`
  remains the escape hatch. Do not add caching, and do not add `fetch`.
- **The overlay drives the editor through keyboard chords, and both ends have to
  agree.** `pwa/mobile-overlay.js` cannot call a VS Code command — there is no
  supported global for the workbench's command service, and rewriting the bundle
  to get one black-screened the editor twice. So the buttons synthesise
  `ctrl+alt+shift+F9`/`F10`/`F11`, and `mobile-extension/package.json` binds those to
  its commands. Nothing throws if they drift apart; the buttons just stop working,
  on the surface where the user has no other way out. `overlay-test.js` reads the
  chords out of the manifest and compares them against what the buttons dispatch —
  keep it that way rather than hard-coding the keys in the test as well.
- **The terminal button opens an *editor* terminal, not a panel one.** This surface
  sets `workbench.panel.defaultLocation: 'right'`, so the obvious
  `workbench.action.terminal.toggleTerminal` puts a shell in a narrow column beside
  Claude, with the soft keyboard over what is left of it. An editor terminal gets
  the whole window the same way Claude does, and with tabs hidden the two take
  turns — which is also why one button toggles both directions (press it while the
  terminal is in front and you get Claude back) rather than needing a second
  control. It shows an existing terminal rather than creating one, because
  code-server keeps shells alive across a page reload while the extension host is
  destroyed: creating per press would leave a pile of orphaned shells. A shell in a
  tab still dies with the tab, so long work belongs in `cc`/tmux, not here.
  On the `tmux` surface Claude is itself an editor terminal, so this button asks
  *which* terminal is in front rather than whether one is —
  `isClaudeTerminalTab` — because treating Claude as "the terminal" made the button
  bounce off it and never open a shell. That test stays regardless of the default
  surface; it costs nothing on `panel` and is load-bearing on `tmux`.
- **The workbench reloads itself, and a reload of `/editor/` destroys work.** Its
  lifecycle service calls `location.reload()` when the browser restores the page
  from the back/forward cache — on a phone that is every app switch — and a reload
  restarts the extension host. The extension host is where the panel used to keep
  the conversation, which is what made a reload fork it; the broker (and, on the
  other surface, the tmux server) is what takes the process out of the blast radius,
  since both outlive the page. A reload is now survivable rather than free:
  the panel rebuilds its view from the stream the broker replays.
  Everything else below still applies — a reload still discards
  typed text and still rearranges the layout. So
  treat *every* extra page load on that surface as damage: it is measurable (the
  remote agent log shows a fresh `ManagementConnection` and "Extension Host Process
  exited with code: 0" per load, and `code-server-data/logs/*/exthost*/` gains a
  directory) and it is what "it refreshed a few times and deleted what I typed"
  means. Two rules follow. Never navigate to arrive where you already are — the
  project switcher checks the current `?folder=` first. And nothing may hold typed
  text as its only copy: the chat composer and the overlay's dictation textarea both
  write to localStorage as you type, because the reload is not this app's decision.
  When a report like that comes in again, the Layout sheet shows this tab's recent
  loads with `navigation.type` for each — `navigate` means something assigned to
  `location`, `reload` means the page or the OS did it, `bfcache-restore` means the
  browser suspended the tab and the workbench reloaded in response. That line is the
  only diagnostic; the server side of all three causes is identical.
- **The startup layout pass must only act when the layout is wrong.** The mobile
  extension re-checks at 0.8/2/4s because VS Code restores its saved layout shortly
  after startup — but it used to re-run the whole sequence each time, and
  `joinAllGroups` moves editors between groups, which re-parents the Claude webview
  and re-creates it, taking an unsent message with it. So the passes are gated on
  `layoutIsSettled()`, `focusClaude()` skips `openLast` when the panel is already
  open, and `applySettings()` compares `inspect(key).globalValue` before writing —
  45 redundant `update()` calls is 45 configuration-change events through the
  workbench while it is still starting.
- **`closeFileTabs()` closes files, never webviews.** The Claude panel *is* a
  webview, and disposing it ends the conversation inside it. So the rescue works
  from an allowlist of text/diff/notebook tabs: misjudging that way leaves a file
  open, which is untidy, while the inverse throws away a turn in flight. Dirty
  tabs are skipped on purpose too — closing one raises a modal save prompt, which
  is the dead end this whole extension exists to avoid.
- **Every `__PLACEHOLDER__` in `bootstrap.sh` needs a matching `sed -e` in
  `stack.js`.** A mismatch ships a literal `__FOO__` to the box. Check with:

  ```bash
  diff <(grep -oE '__[A-Z_]+__' infra/userdata/bootstrap.sh | sort -u) \
       <(grep -oE '__[A-Z_]+__' infra/lib/stack.js | sort -u)
  ```

- **Quoted heredocs in `bootstrap.sh` do not expand variables.** `<<'EOF'` is
  intentional in places that write scripts; those use `__PLACEHOLDER__` + `sed`.
  Adding a `$VAR` inside one silently writes a literal `$VAR`.
- **The login shell is zsh, but the box's environment is still in
  `/etc/profile.d`.** Bedrock region and model, and the GitHub token resolver, are
  written there as `.sh` files, and zsh reads them only because AL2023's zsh
  package does it for us: its `/etc/zshrc` sources `/etc/profile.d/*.sh` for
  non-login shells (a code-server terminal is one), its `/etc/zprofile` sources
  `/etc/profile` for login shells. Nothing in this repo enforces that, and the
  failure is `claude` starting in a terminal without Bedrock credentials. So check
  it holds before changing distro, and keep adding shell environment as
  `/etc/profile.d/*.sh` rather than in a zsh-only file.
  Our own zsh defaults are in `/etc/claude-web-zshrc`, which `bootstrap.sh` owns
  and rewrites; `~/.zshrc` only sources it, so edits on the box survive a deploy.
  They cannot move into `/etc/profile.d`: zsh sources those under `emulate -L ksh`,
  which localises options, so a `setopt` there is reverted as the file finishes
  loading.
- **`session-manager.js` mangles the *resolved* path** for transcript lookup, so
  symlinks matter. This is why `migrate.sh` rewrites paths.
- **The landing page's copy button must show exactly what it copies.** When the
  clipboard API is unavailable the script selects the visible `<code>` node
  instead, so an abbreviated label hands the visitor a broken command.
  `deploy-landing.sh` checks this and refuses to deploy on a mismatch.
- **Broken analytics on the landing page has no symptom.** The page still loads,
  still reads correctly, and records nothing — and the evidence is a dashboard
  that looks like a page nobody visited. Four separate things have to agree for a
  visit to arrive: the page loads `analytics.js`, the CSP permits what it does,
  CloudFront proxies the path it posts to, and the deploy stamps the token into
  it. So they are defined once in `infra/landing-analytics.js`, and
  `landing/landing-test.js` runs the real script in a stub browser to check the
  page still agrees. If you change any of the four, run `npm run test:landing`
  and then look at PostHog's *Activity* view after deploying — a live event is
  the only proof that matters.
- **Headless Chrome with `--window-size` alone does not apply the viewport meta**,
  so it lays a responsive page out at desktop width and crops it. That looks
  exactly like a mobile overflow bug and isn't one. Use
  `Emulation.setDeviceMetricsOverride` with `mobile: true`, and confirm with
  `documentElement.scrollWidth` rather than by eye.
- **The screen wake lock has to be re-requested, not acquired.** It is held for as
  long as the app is open and visible, not just during dictation, because hiding the
  page also freezes the WebSocket and suspends the recognizer. The browser releases
  the lock on every hide and never re-takes it, and the OS revokes it silently
  (battery saver) with no event to say you may have it back. So there is one
  `syncWakeLock()` reconciler called from `visibilitychange`, `pageshow`, `focus`
  and a 30s timer — not an `acquireWakeLock()` called once at startup, which is
  awake for exactly one screen-off and asleep forever after. The same reconciler is
  duplicated in `pwa/mobile-overlay.js` (injected raw into code-server, imports
  nothing) and reads the same `claude-keep-awake` localStorage key, so one switch
  governs both surfaces. Covered in `smoke-test.js` against a fake `navigator.wakeLock`,
  because whether a display sleeps is invisible to the page.
- **Dictation stops when the page is hidden, on purpose.** A phone being dictated
  into is a phone nobody is touching, so the display sleeps and the recognizer
  goes with it — silently, because the screen showing "recording" is what turned
  off. The wake lock above is the first defence; the second is treating any stop
  they did not ask for as an event to announce: beep, vibrate, and a banner that
  outlives the screen going dark. Do not "improve" this by letting dictation carry
  on through `visibilitychange` and hoping — that is the original bug, and the
  failure is invisible from a desktop browser. The interruption path is covered in
  `smoke-test.js` for exactly that reason.
- **The `record` (whisper) dictation path stops by transcribing.** An interrupted
  recording still yields the words spoken before the interruption, so an unexpected
  stop must call `recorder.stop()` rather than discarding the chunks.
- **The dictation cleanup pass may only ever improve text that is already there.**
  Neither transcriber can punctuate a whole utterance — the browser recognizer emits
  none at all, and whisper sees one pause-delimited phrase at a time — so
  `POST /api/polish` (`polish.js`) makes one Bedrock Haiku pass over the finished
  text. Four rules, and none of them are optional: the raw transcript is written
  into the composer *first* and every failure path leaves it exactly there; the pass
  runs only after dictation ended and the phrase queue drained, never mid-sentence
  and never after an interruption (Resume continues that dictation); the result is
  discarded unless the dictated span is still untouched, because a reply about text
  the user has since edited or sent would overwrite newer work; and the dictated
  text is data, never an instruction — the prompt says so, and `looksLikeCleanup()`
  rejects a model that answered instead of editing. In the overlay the clipboard
  write happens inside the tap, *before* the pass, both because iOS refuses a write
  issued after an `await` and because the copy is the only handover. Covered in
  `smoke-test.js` (span guards, the switch, a send that waits) and `overlay-test.js`
  (copy order, a 503).
- **The CLI's flags are process arguments**, so model, permission mode and effort
  are fixed for the life of a conversation. Settings changes apply to new chats
  only. This is not a bug to fix.
- **The broker is byte-transparent, and must stay that way.**
  `chat-service/session-manager.js` translates stream-json into a small vocabulary
  for its own UI; `claude-broker/broker.js` deliberately does not, because it is
  standing in for a pipe in front of a UI it does not own. It parses exactly one
  thing — the `system` event carrying `session_id`, so a session opened with no id
  can be re-keyed and found by the next device resuming that id. Everything else is
  forwarded verbatim. Interpreting more would couple it to a vendor bundle that
  updates on its own schedule.
- **Replay is all-or-nothing, so it is capped.** A page joining mid-conversation is
  sent every byte written so far, because a partial stream cannot be rendered. Past
  64 MB the session stops accepting new pages instead of handing one a broken
  stream — and a refused page just gets its own process, which is only the old
  behaviour. Do not "fix" the cap by replaying a suffix.
- **The panel spawns two `claude` processes per page load, and only speaks to
  one.** Before the conversation itself it starts a probe — `--permission-mode
  default`, no `--resume` — that it never writes a byte to. Through the broker
  that probe became a resident process nobody could ever name, because a session
  with no id is keyed `pending:` and only the CLI's init event (which needs input)
  re-keys it. Ten of them were live on the box at ~205 MB each, 2.0 GB of 7.8 GB,
  one per reload. So `Session#detach` stops a session that has never been written
  to once its last client leaves. Keyed on input, not on the `pending:` key,
  deliberately: a session that *was* spoken to may have a turn in flight and must
  survive to `IDLE_MS` even when nothing can name it. If you widen that condition,
  the thing you are risking is killing live work.
- **The wait when you open a conversation on another device is not the broker's,
  and cannot be fixed there.** It is the panel reloading the transcript: measured
  1.75–3.97 s in the extension host between the webview asking for the session and
  `claude` being launched, across twelve page loads, all of it *before* the broker
  is contacted. For comparison, the broker's replay of the same conversation was
  4 ms to first byte and 7 ms complete, and the real CLI on `--resume` with no
  input emits **0 bytes** — history never travels through the broker; the extension
  reads the `.jsonl` itself. The panel also renders oldest-first, so the newest
  message, the one you need in order to reply, arrives last. All of that is inside a
  proprietary webview: there is no setting for it among the extension's 19, and
  nothing in this repo can reorder it. The only lever we have is transcript size,
  which the wait scales with. What we did instead was answer the question from
  outside the panel — see `chat-service/claude-status.js` and the chip in
  `pwa/mobile-overlay.js` — so you can tell whether the wait is worth sitting
  through. If someone reports this as slow, do not go looking in `broker.js`.
- **A transcript cannot tell you whether Claude is working.** There is no turn-end
  marker on disk: 0 `"type":"result"` entries across every transcript on the box,
  against 5606 `assistant` entries. Only the process holding the stream sees the
  `result` event, which is why `broker.js` tracks `turnInFlight` and answers
  `op: 'status'`, and why that op is the authority. The transcript can be *inferred*
  from the last `stop_reason` (`tool_use` means a tool is running, `end_turn` means
  the turn is over) but that is the state the conversation was **left** in, not
  proof anything is still running it — a conversation abandoned mid-turn reads as
  "working" forever. Keep the two labelled apart, as `claude-status.js` does with
  `source`. Conflating them puts "Claude is working…" over a conversation that will
  never answer.
- **`op: 'status'` needs a broker restart to appear, and a restart ends every live
  conversation.** Same rule as any `broker.js` change (see above): `install.sh` uses
  `enable --now`, never `restart`, so new code sits on disk until someone chooses a
  moment when losing the running work is acceptable. Until then a broker without the
  op reads the status frame as a handshake and refuses it — which callers treat as
  "cannot say" and fall back to the transcript, so the chip degrades to an inferred
  answer rather than a wrong one. That is the intended behaviour, not a bug to fix
  by restarting the unit from a deploy path.
- **Reading the last message aloud is in the overlay, and there is nowhere else it
  could be.** The Read aloud button in the status sheet is the other half of the
  mic: dictation carries a phone-shaped question in, this carries the answer back
  out. It cannot be done from the extension — the panel is a proprietary webview,
  and the extension host is a node process with no audio device, so neither can
  make a sound — and the text itself needs no new route, because
  `/api/claude-status` already returns it. So the workbench page speaks and the panel
  is untouched. It speaks in one of two kinds of voice, and which one is the device's
  own choice, remembered in `cmo-voice`: a neural voice synthesised on the box, through
  `/api/speak/prepare` and `/api/speak` — Azure's free tier by default, Polly's
  generative engine for anyone who picks it, see `chat-service/speak.js` — or the
  browser's own `speechSynthesis` — instant, free and robotic — which is both the
  fallback whenever the server voice is unavailable or refuses and a choice in the
  picker for anyone who prefers it. Whichever one speaks, the same iOS rule shapes
  the code: audio has to start in a gesture. The browser voice queues its first
  utterance **synchronously inside the click** (the same reason `Copy` writes the
  clipboard before it awaits anything) and then queues **one at a time, chained on
  `end`**, because iOS speaks the first of a long queue and drops the rest. The
  server voice can do neither — at the moment of the tap its audio does not exist
  yet — so what happens inside the tap is `unlockAudio()`, which plays a silent wav
  on a single long-lived `<audio>` element. On iOS the permission belongs to *that
  element*, and once it has it the element can be re-sourced and played from a
  network callback for the rest of the page's life. That is why it is created once
  and never replaced, why the sheet, the bar button and the voice picker all unlock
  it on the way past, and why the auto-read of a turn that finishes while the sheet
  is open works with server audio at all. **Every audio URL on that element must be
  same-origin, and this is the one that bit.** The overlay is injected into
  code-server's workbench, and that page carries code-server's own
  Content-Security-Policy, which says `media-src 'self'`. A `blob:` URL is not
  `'self'` and neither is a `data:` one, so the first version of this — segments
  turned into blobs, unlocked with an inline silent wav — was refused by the browser
  on every read, and the symptom was that the voice picker worked, the mp3s arrived
  with a 200, Polly was billed, and every message came out in the robotic voice
  anyway, because a blocked source raises `error` and the fallback did its job. The
  policy belongs to code-server, ships in its server bundle with per-build nonces
  and hashes, and patching it would be undone by the next upgrade, so this side is
  the side that holds: segments play straight from `/api/speak`, the unlock plays
  `/api/speak/silence`, and the fake `<audio>` in `overlay-test.js` refuses a
  `blob:` or `data:` source the way a browser does, so reaching for one fails the
  suite rather than shipping. The split between the two routes is what
  keeps a read quick and cheap: `prepare` is free — it hashes the text, cuts it into
  segments and hands back an id — and each `GET /api/speak?id=…&segment=n` buys one
  segment, delivered as a complete mp3 with a `Content-Length`, because iOS is
  unreliable about byte ranges on a streamed body. The first segment is deliberately
  short (160 characters) so the voice starts about two seconds after the tap, the
  later ones are long (700) so a message is not dozens of round trips, and the next
  is fetched while the current one plays. Stop after one sentence and the rest was
  never synthesised, so it was never billed — which is the reason the whole message
  is not bought in a single POST. It is also a button on purpose and has no timer or
  subscription anywhere: a turn can end while you are talking to someone, and a
  phone that starts speaking by itself is worse than one that stays quiet. While it
  reads, the bar's status button *is* Stop — it pulses, its glyph changes, and it
  does not reopen the sheet — because the sheet is dismissed by tapping beside it
  and the voice carries on afterwards, so at that point the bar holds the only
  control there is. Do not "fix" it back into a plain open-the-sheet button. Stop
  has more to undo than it looks: as well as cancelling `speechSynthesis` it pauses
  the element, detaches its `src` and bumps a generation counter — a segment already
  in flight will still arrive, and it must not be heard after Stop. And it
  never speaks over a live microphone — `startDictation` stops it and `speak`
  refuses while the mic button carries `cmo-rec` — because the recognizer would
  otherwise dictate Claude's own reply into the composer and the whisper recorder
  would upload it to be transcribed.
- **How fast it reads is changed on this side, never on the server's.** The status
  sheet has a minus / readout / plus stepper (`#cmo-speed`, remembered per device in
  `cmo-speed`) and the chat app's Settings has the same ladder as a picker
  (`#select-speed`, in `claude-chat`'s `speed`); the stops are the ones a podcast
  player offers, 0.5 to 3, with normal in the middle. Nothing about a rate reaches
  `/api/speak`, and that is the point: cached audio is keyed by `(engine, voice,
  text)` — see `VoiceCache` in `chat-service/speak.js` — so asking the server for a
  faster read would be a cache miss, a second synthesis and a second bill for a
  message already on the device, where `playbackRate` is free, instant, and applies
  to the piece already playing. Two things about it are easy to get wrong and both
  have a test. **The rate goes on the element twice**, as `playbackRate` *and*
  `defaultPlaybackRate`, and after every `src`: the media load algorithm resets the
  first to the second on each new source, and a message here is a chain of them, so
  setting one of them once reads the first segment fast and the rest at normal
  speed — a failure that sounds like the control half working and gets reported as
  "it doesn't stick". **`preservesPitch` is set explicitly**, true, because the
  prefixed property older WebKit shipped defaulted the other way and the difference
  is a reader rather than a chipmunk. The browser's own voice takes the same number
  as `SpeechSynthesisUtterance.rate`, which it fixes when an utterance starts, so a
  change there is heard from the next piece on — the sheet's note says so, and says
  something different once a server voice is picked.
- **The markdown is reduced before it is spoken, and the reduction is
  deliberately lossy.** A final message is written to be read: spoken literally it
  is "asterisk asterisk Done asterisk asterisk", every slash of every path read
  out, and a fenced diff pronounced one bracket at a time. So `speakable()` in
  `pwa/mobile-overlay.js` strips the markup, says " Code block. " where a fence was,
  says "link" where a URL was, reduces a path to its file name and `auth.js:42-51`
  to "auth.js, line 42 to 51". It does **not** cut the message short. It used to, at
  2400 characters, announcing "the rest is on screen" — which is the one instruction a
  listener cannot act on, because the reason to listen is that the phone is in a pocket,
  and it landed on exactly the messages worth hearing in full. Stop is one tap away for
  the wrong message; the only limit left is `SPEAK_MAX_CHARS` on the server, which
  refuses a pasted file rather than a long answer, and a refusal is read by the
  browser's own voice instead of not at all. Two decisions in it are not obvious and
  both have a test:
  **a blank line ends a sentence and a single newline does not**, which is what those
  two mean in markdown and also how they sound — a full stop dropped into
  hard-wrapped prose is heard as a real one and changes what the sentence says, so
  headings, bullets and table rows are terminated earlier, in the pass where their
  marker is still there to prove they were one; and **anything spoken before the
  message is passed as `speak`'s `lead`, not concatenated in front of it**, because
  the strips are anchored to the start of a line, so text put ahead of the first line
  hides the marker on it (`## Done` was read out as "hash hash Done" that way). It is
  all deterministic and local rather than a call to `polish.js`, which would do it
  better. For the browser voice that is forced: a model round trip between the tap
  and the first word is exactly what iOS will not allow, because the utterance has to
  be queued inside the click. The server voice does make a round trip, so the rule
  binds it less tightly — but the answer is the same, because reducing the text
  through a model first would put a second wait ahead of synthesis and roughly double
  the two seconds before the first word, on text that is about to be spoken once and
  thrown away.
- **Three things now read the same markdown, and they want different reductions.**
  `renderMarkdown()` draws the status sheet, `plainLine()` feeds the chip and the
  conversation list, `speakable()` feeds the voice — and the temptation on finding
  three is to unify them. Don't: a heading is an element in the sheet, nothing at all
  on a one-line chip, and a sentence boundary out loud. What *is* shared is the one
  rule none of them may break, which is that a message from a model is text.
  `renderMarkdown` returns a `DocumentFragment` built with `createElement` and
  `textContent`; it never assembles markup, and the escape-then-`innerHTML` pattern
  in `chat-service/public/app.js` is not the precedent to copy into the editor,
  because this script runs in a page that can drive the workbench. The single
  attribute taken from a message is a link's `href`, and it is only set when it
  matches `/^(https?:\/\/|\/)/` — a `javascript:` URL in a reply must never become
  something a tap runs. `overlay-test.js` puts an `<img onerror=…>`, a `<b>` inside a
  fence and a `javascript:` link through it for exactly that reason, and those three
  checks are the ones to keep if anything here is ever rewritten. One consequence
  worth knowing before you write an assertion: the sheet's `textContent` is no longer
  the message, because the markers are gone from it. And one judgement already made
  and reversed, so it does not get made again: tables were left out of the first
  version on the grounds that they do not fit a phone. They are most of what a status
  answer is made of — surface, check, result — and a table left as source does not fit
  a phone either, it is a screenful of pipes. They render now, scrolling sideways as a
  unit rather than wrapping every cell, which would lose the alignment that made the
  thing a table.
- **A `setTimeout(closeSheet, …)` closes whatever sheet is open when it fires, not
  the one that scheduled it.** Tap `Copy & close` in the dictation sheet and then
  open the status sheet within 700 ms, and the delayed close dismisses the new one.
  Latent for as long as the delay existed, and it surfaced as a *test* flake — 3 of
  10 parallel `overlay-test.js` runs against 0 for HEAD — because the speech work
  added just enough latency for the race to land. Hence `openSheet` bumps
  `sheetGeneration` and `closeSheetLater(ms)` only closes if the generation still
  matches. Use `closeSheetLater`, never a bare `setTimeout(closeSheet, …)`.
- **No regex lookbehind in `pwa/mobile-overlay.js`.** `/(?<=[.!?])\s+/` is the
  obvious way to split sentences and the one thing that must not be written here: an
  unsupported lookbehind is a **parse** error, so the whole file fails to load and
  every button on the bar disappears — the exact silent failure `overlay-test.js`
  exists for, and the one it cannot catch, because it runs on node where the syntax
  is fine. `splitSentences()` is a hand-written scanner for that reason. The same
  caution applies to anything else that is a syntax error rather than a runtime one
  in an older Safari.
- **"Claude is working" means a message was sent, not that bytes were written.**
  The panel runs with `--permission-prompt-tool stdio`, so it writes to the CLI's
  stdin constantly with nobody typing: `control_request` / `control_response`
  frames for every tool approval, `set_permission_mode`, `auth_status`. None of
  them draws a `result`, so the first version of `claude-broker`, which treated any
  write as the start of a turn, latched `turnInFlight` on and never cleared it —
  **11 of 13 live sessions on the box reported "working", nine of them processes
  that had never run a single turn.** `Session#write` therefore parses whole lines
  out of the input and only claims a turn for `{"type":"user",…}` (see
  `#noteTurnStart`, and `MAX_INPUT_LINE` for the pasted-file case). Being wrong in
  the two directions is not symmetrical, which is why it is written this way round:
  a *missed* message leaves a stale "working", which makes you wait and look again,
  where a false one makes the badge say "your turn" over a live turn and invites
  typing over it.
- **That same flag is what reaps the panel's probes, so do not add `sessionId` to
  the test.** `detach()` stops a session only when it was never spoken to, which is
  how the probe the panel spawns on every page load (no `--resume`, never written
  to) stops costing ~210MB for `IDLE_MS`. It is tempting to also require
  `!this.sessionId` there — an id looks like proof of a conversation — but **every**
  process announces one in its own `system`/`init` event, probe included, so that
  clause silently parks every probe again. `broker-test.js` catches it.
- **Which conversation is on screen cannot be known from outside the panel, so the
  answer names its guess.** The panel is a vendor webview: it reports nothing about
  itself and fires no page event when you switch conversations. The first version of
  `claude-status.js` answered per *project* — least-idle live session wins — and a
  project here has four live conversations, so switching left a badge confidently
  describing a different one. `guessConversation()` now picks among the sessions
  that hold a broker client (the panel drops the client when it moves on; exactly
  one of the four had one), breaks ties on `spokeMs` rather than `idleMs` (resuming
  a conversation produces output with nobody typing, so only `spokeMs` says which
  one is being *used*), and the reply carries `title`, `sessionId` and every other
  conversation in the project so the overlay can name the guess and let a tap pin a
  different one (`&sessionId=`). Keep it that way: a wrong guess that is named is
  correctable, where a silent one reads as a stale badge. Nothing outside the panel
  will ever be able to do better than this, so do not "fix" it by removing the list.
- **A stale "working" is corrected by the transcript, and that override is what
  makes this deployable.** `OVERRIDE_QUIET_MS` (10s) in `claude-status.js` lets a
  finished-looking transcript overrule a broker that says "working" — but only when
  the stream has been silent that long, because a turn in flight is never silent
  (deltas arrive, tools announce themselves). It exists because the broker's fix
  above only takes effect when the daemon restarts, and **restarting
  `claude-broker` ends every live conversation** — so the client half has to be
  correct on its own against a broker that is still latching. The bound also
  protects the opposite race: a message sent a moment ago and not yet on disk.
- **A panel-internal conversation switch fires no page event, so the overlay
  re-asks on a timer.** `STATUS_HEARTBEAT_MS` (15s, visible tabs only, skipped
  while the 4s working poll is running) plus a silent refresh on window `focus`.
  Without them nothing re-checked after a switch, which is what "the status is
  stale when you switch conversation" was. A silent refresh only puts the chip back
  when the conversation changed or a turn finished — never merely because the timer
  fired, or a dismissed chip would return every fifteen seconds.
- **cloud-init will not re-run your `bootstrap.sh` edit, and a green stack does not
  mean it ran.** cloud-init runs `scripts-user` once per instance *ever*
  (`/var/lib/cloud/instances/<id>/sem/config_scripts_user`), and a stack update
  stop/starts this instance rather than replacing it, so `/opt/bootstrap.sh` stays
  whatever first boot wrote — verified 2026-09-17 (same instance id, new boot time,
  `/opt/bootstrap.sh` two days old, zsh and `claude-tmux.service` absent after a
  "successful" deploy) and again 2026-09-18, when the `/p/` nginx route was in the
  stack, in the S3 asset and *not* in the running nginx config. The trap is what
  happens next: the stack is `UPDATE_COMPLETE` and `cdk diff` reports "There were no
  differences", so a re-deploy is a no-op and there is nothing left to notice. Do not
  trust the stack for this; read the thing itself on the box (`grep` the live
  `/etc/nginx/conf.d/claude-web.conf`, `systemctl is-active`, the unit you expected
  to exist). `deploy.sh` now closes the loop by installing the payload's copy of the
  script (the `--app-only` bullet above), but the general rule holds: **anything that
  must actually land goes in the payload**, which is why `claude-broker/install.sh`
  exists and why `cc` is installed from there too. A full deploy from another machine
  is still what re-aligns the stack's UserData, so that if the instance is ever
  genuinely replaced it boots the same script.
- **nginx can refuse a reload and keep running the old config, and nothing in the
  deploy used to notice.** `nginx -t` loads the config from scratch, so it cannot
  see a conflict with shared memory the running master already holds, and
  `systemctl reload` only sends SIGHUP — it exits 0 whatever the master decides.
  When the master rejects the new config it logs `[emerg]`, keeps serving the
  previous one, and stays up, so `nginx -t` passed, `systemctl is-active` said
  active, the config file on disk was visibly new and correct, and the running
  server was two deploys old. Hit 2026-09-19: `limit_req_zone`'s key changed from
  `$binary_remote_addr` to `$login_attempt` while the zone kept the name `login`,
  which nginx refuses outright — *"limit_req "login" uses the "$login_attempt" key
  while previously it used the "$binary_remote_addr" key"*. **Rename a shared memory
  zone whenever you change its key**; a new name is a new zone with nothing to
  conflict with. `deploy.sh` now reads `/var/log/nginx/error.log` across the reload
  and fails on a new `[emerg]`, so this class of failure is loud rather than
  invisible. The tell, if you are ever debugging a config that is provably correct
  and provably not working: compare the nginx worker start times against the config
  file's mtime (`ps -eo lstart,args | grep nginx:` versus `ls -l`). Workers older
  than the config mean the config is not running.

## The names before the rename

This project was called `claude-web` until September 2026. The rename to **TripleC**
is the product's name, the config file, the environment variables and the default
stack names. Two consequences an agent runs into:

- **This box predates it.** Its settings are still in `claude-web.config.json`, here
  and on the deploy box, and `infra/config.js` still loads that name — so do not
  "fix" it by renaming the file. `stackName` is the deployment's identity in
  CloudFormation and it is read from that file; a deploy that cannot find its config
  does not fail, it falls back to the new defaults and starts building a second
  production alongside the first. [docs/DEPLOY.md](docs/DEPLOY.md#the-names-before-the-rename)
  has the full compatibility table.
- **Paths on the instance were deliberately *not* renamed.** `/opt/claude-web`,
  `/etc/claude-web-zshrc` and `/etc/nginx/conf.d/claude-web.conf` keep their names,
  because a rename there would not replace the old copy — it would leave it in place
  and add a second one. Two nginx server blocks for the same host is an outage, and a
  stale `/etc/claude-web-zshrc` that is still sourced is a silent one. They are
  invisible to anyone using the product, so the trade is not close. Comments and
  documents that name those paths are naming a real path and are correct as written.
- **The checkout did move.** It is `/workspace/projects/triplec`, with
  `/workspace/projects/claude-web` left behind as a symlink to it, because several
  agent sessions and the conversations in them hold the old path as their working
  directory. The symlink is not clutter: it is what stops a path that another
  session is standing in from vanishing, and the project list does not double up
  because `readdir(withFileTypes)` reports a symlink as not-a-directory — see
  `listProjects` in chat-service/session-manager.js. The same trick is used for
  Claude Code's own state: `~/.claude/projects/-workspace-projects-claude-web` is a
  symlink onto the `-workspace-projects-triplec` directory, so one history and one
  set of memories serve both spellings of the path.

## Things not to do

- Do not commit `triplec.config.json`, nor `claude-web.config.json` under the name
  this project used before the rename — either one holds the user's domain, account
  profile and git identity. Both are gitignored; keep it that way.
- Do not commit `infra/cdk.context.json` — CDK caches lookups there and the cache
  embeds the AWS account id.
- Do not put an account id, hosted zone id, certificate ARN or personal email
  into tracked files. That is exactly what was removed to make this publishable.
- Do not enable `instanceAdminAccess` on a user's behalf without explaining that
  it makes one leaked password into AWS account takeover.
- Do not weaken `auth.js` to make a test pass. Fix the test or the caller.
- Do not add a caching service worker.
- Do not end a piece of work uncommitted, unpushed, or undeployed without saying
  so. See ["Finishing" is committed, pushed, and
  deployed](#finishing-is-committed-pushed-and-deployed) — it is the first thing
  in this file for a reason.

## Verifying your work

There is no staging environment, so local verification is what you have:

```bash
npm test                                   # auth + client + panes + overlay + polish
                                           # + project lifecycle + per-project manifest
                                           # + operations surface + conversation status
                                           # + push + turn watcher + broker
cd infra && npx cdk synth --quiet          # stack compiles
bash -n deploy.sh migrate.sh infra/userdata/bootstrap.sh claude-broker/install.sh
node --check chat-service/server.js
```

One caveat for the broker: `npm test` proves it shares a process and falls back
safely, using a fake CLI over a real socket. It cannot prove the *panel* renders a
replayed stream correctly, because that is the vendor's UI reacting to bytes it
normally sees live. Only two real devices show that.

`nginx -t` cannot run locally unless nginx is installed; `deploy.sh` runs it on
the instance and fails the deploy if the config is invalid.

Be honest about what you did and did not verify. "Synthesizes and passes the auth
tests, not deployed" is a useful, accurate statement. "Works" is not, unless you
watched it work.

And "not deployed" is a statement about an unfinished job, not a resting place:
verifying is the step before shipping, never instead of it. Go back to ["Finishing"
is committed, pushed, and
deployed](#finishing-is-committed-pushed-and-deployed) and finish.
