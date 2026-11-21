# TripleC

**Claude, Code, Cloud.** Claude Code on a machine of its own, run from a browser
on any device. Open it and you get the **Mux**: every project down the side, ten
worktree slots in each by default, and up to eight agents side by side, each one the real
`claude` CLI in a terminal that lives on the server. Beside them are a real Chrome
on the box that you and Claude both drive, a plain shell in any slot, and the full
VS Code editor when you want files and diffs.

None of it lives in the device you are looking from. A session runs in tmux on the
box, so the run you start at a desk is the one you pick up on a phone, mid-task,
and it carries on while both are shut. The cloud is the third C, and the part this
project adds. Everything inside the terminals is Anthropic's CLI, running
unmodified.

```bash
git clone https://github.com/MichaelNusair/triplec.git
cd triplec
cp triplec.config.example.json triplec.config.json
$EDITOR triplec.config.json     # domainName + hostedZoneName
./deploy.sh
```

**Two ways to run it, from the same MIT-licensed commit.** Self-hosting is free and
always will be. Nothing is held back from this repository, there is no licence key,
and you pay AWS rather than us. Or we run it for you on a hostname of yours: see
[docs/MANAGED.md](docs/MANAGED.md), which also answers the awkward questions,
including why the managed service costs $0 today (we have not started charging).

You need an AWS account, a Route53 hosted zone, and Bedrock model access. Full
walkthrough in [docs/DEPLOY.md](docs/DEPLOY.md).

**Already have a Linux VM?** Host mode installs TripleC onto an existing Ubuntu
24.04 machine as its developer: no AWS, your own `claude /login`, and your
repositories and hooks staying where they are. You reach it through the VM's own
HTTPS proxy or a tailnet. See [docs/HOST.md](docs/HOST.md).

> **Read [docs/SECURITY.md](docs/SECURITY.md) before you expose this.** It
> deploys a web page that runs shell commands on a machine you own. That is the
> product, not a side effect: anyone who logs in has a shell. Deploy it as a
> personal workspace, not a shared service.

## What is in it

- **[The Mux](#the-mux-every-agent-on-one-screen)** (`/chat/mux`, where the app
  opens). Projects, slots and panes. A pane can be Claude Code in a terminal, a bare
  shell, or a command line of your own. On a laptop the panes sit side by side, and
  on a phone you see one at a time, with two rows of terminal keys.
- **[Workspaces](#workspaces-a-second-clone-for-a-second-task)**: up to five full
  clones of one repository by default, each on its own branch with its own slots,
  for running separate tasks in parallel.
- **[The Browser pane](#the-browser-pane-a-real-chrome-on-the-box)**: Google Chrome
  running on the box, streamed to the page as video. You browse in it, and a Claude
  on the box drives the same window over DevTools.
- **[The editor](#the-editor-on-a-phone)** (`/editor/`): code-server with the
  official Claude Code extension, laid out for a phone. Its panel follows you
  between devices through a broker, rather than forking.
- **[Voice](#voice)**: hear what Claude last said in any pane, talk it over out loud
  with something that cannot act, and dictate in the editor. English runs on the
  box, and Hebrew has voices too.
- **[Notifications](#notifications)**: your phone buzzes when a session you are not
  watching finishes, and the tap takes you to it.
- **[The box page](#the-box-page-what-is-running-and-every-setting)**
  (`/chat/admin`): every conversation and service on the instance, what is wrong
  with them in words, and every setting of the deployment, editable in place.
- **[Updates](#keeping-itself-up-to-date)**: the Claude Code CLI updates itself
  daily, and the deployment can follow this repository on its own, as cautiously as
  you configure it.

```
your-domain.com
  │
  ALB :443  ── ACM cert (created for you), :80 → :443
  │           4000s idle timeout (a turn can run for many minutes)
  │
  EC2 t4g.large (Graviton, arm64) — reachable only from the ALB
  ├── nginx :8080
  │     ├── /           → redirects to /chat/mux
  │     ├── /chat/      → chat service (:9997): the Mux, terminal, browser and box
  │     │                 pages, and the deprecated chat
  │     ├── /editor/    → code-server (:9999)
  │     └── /p/<name>/  → code-server, one installable app per project
  │
  ├── claude-chat service  ← authenticates every request itself: the security boundary
  │     ├── /ws/term          → a slot's tmux session (Claude, or a shell)
  │     ├── /ws/browser(-video) → the box's Chrome: VNC for input, H.264 for the picture
  │     ├── /api/transcribe   → whisper.cpp on the box, no API key
  │     └── projects, slots, workspaces, push, read aloud, the box page
  │
  ├── tmux  ← every terminal session; outlives every browser and every deploy
  │
  ├── triplec-browser service ── Chrome for Testing on Xvnc, DevTools on 127.0.0.1:9222
  │
  ├── code-server + official anthropic.claude-code extension
  │     ├── its Claude launched via claude-broker/wrapper
  │     └── GitHub Pull Requests extension, signed in with the gh token
  │
  ├── claude-broker service
  │     ├── one `claude` per editor conversation, outliving every browser page
  │     └── replays the stream to a device that joins mid-turn
  │
  ├── timers: the Claude Code CLI daily, triplec-update when you turn it on
  │
  └── /workspace  ← persistent EBS, survives instance replacement
        ├── projects/   one directory per repo, its worktree slots inside
        ├── claude/     ~/.claude: session history lives here
        └── code-server-{data,ext}/, triplec-browser/profile

  Bedrock via instance role: no model keys in the browser
```

## Why it's built this way

Claude Code is already a very good interface, and it's a terminal program. The
part missing from it is a machine that stays on, so this project gives it one and
stays out of the way. A pane in the Mux is the CLI's own TUI in a tmux session, and
`cc my-project/slot-3` from any terminal joins the very same session. Nothing about
Claude is reimplemented: what you run on a laptop is what runs here.

The project did not start there. It began as VS Code in the browser with the
official extension, which works at a desk and is painful on a phone. It then grew
a purpose-built chat over `claude --input-format stream-json`. Both are still
served. The editor is the place for files and diffs, and the chat is deprecated in
favour of the Mux, because a real terminal turned out to work better than either
once a phone had the keys for it. The rest of the work went into the part a laptop
cannot give you: sessions that outlive the browser, and a way to see and steer many
of them at once.

## The Mux: every agent on one screen

`/chat/mux` is a cmux-style view, and it is where the app opens: the bare domain
and the installed app's icon both land there.

**Down the side:** every project, each with up to **ten worktree slots** (see
[How many](#how-many-slots-panes-and-workspaces)), and a
light on each one. It is orange while the slot works, and a blue ring means it
finished while nobody was looking (the tab title counts those, and desktop alerts
are one switch away). A filter narrows the list. The **+** beside it adds a project:
clone `owner/repo`, pick from the repositories the token can see, or create a new
one with an optional GitHub remote. The **⋯** on a project opens its sheet: what it
holds, cloning another repository into it, making a workspace, and **push & delete**.

**In the middle:** one to eight panes (by default). A pane is one of:

- **a terminal**, the default, running the real Claude Code CLI in the permanent
  tmux session `cc` keeps for that slot. Every device that opens the slot attaches
  to the same session.
- **a shell** (`$` on a slot row, or **$ Shell** in a pane's header): a plain
  `bash -l` in a tmux session of its own beside the slot's Claude, so you can run
  the tests while it works. **Claude** in the header switches back.
- **your own command line** (**❯…**): restarts the slot's terminal with a line you
  give it, such as an environment variable or `claude --resume <id>`, without
  resetting the slot. The line is split into arguments with quotes honoured and
  nothing expanded.

Each pane's header also has **📎** to attach any file (an image, a PDF) to what you
are typing, **Aa** for the terminal font and size, **🔊** for [what Claude last said
there](#voice), **⇱** to copy a link that opens the pane full-screen on a phone, and
**⇄** to swap it with any other pane (Alt+Shift+number). Closing a pane stops
nothing.

The terminal behaves like one: the wheel and a finger scroll Claude Code, a
drag-copy lands on your real clipboard (OSC 52), Ctrl-C copies when something is
selected, URLs are links even when tmux wrapped them, a pasted or dropped image is
uploaded and its path typed in, and Hebrew and Arabic read the right way round.

**Two screens, two windows.** Open the Mux in a second window and each shows its
own page of the panes, 1–3 on one and 4–6 on the other (or 1–4 and 5–8 four
across). The two follow each other's changes instead of undoing them, and ⇄ swaps
a pane across them.

### Slots

Each slot is its own checkout: `<project>/.claude/worktrees/slot-1` … `slot-10`, on
branches of the same names. So ten agents on one project never edit the same
working tree. Every project you clone or create here gets them, and older ones get
each slot the first time you use it. Press **+** next to a project for a pane in a
free, clean slot. Starting one brings the slot up to date with the default branch
first, fast-forward only, and only if nothing in it would be lost. Otherwise it
starts from what is there, and the pane says so.

When Claude exits in a slot (`/exit`), the slot resets: it is refreshed the same
cautious way, and the sidebar stops showing the title of the conversation that
ended. Exiting a shell ends only the shell. A project's own checkout is shown above
its slots and can take a terminal for read-only work. Feature work belongs in a
slot, since everything else shares that tree.

### Workspaces: a second clone for a second task

Slots are for many agents on one line of work. A **workspace** is for a second
line of work: a full clone of the repository, on a branch of its own, with ten
slots of its own. Use one for "mono on master with its ten slots, and Feature A on
`feat/a` with ten more", up to five per repository counting the original. Make one
from the project's ⋯ sheet: it clones from the project's own checkout, points
`origin` at the real remote, and checks out the branch (the remote's if it exists,
or a new one from the default branch). Its slots branch from, and refresh to, the
workspace's branch, so a slot agent starts from what the task has so far. In the
sidebar it is nested under its project. Underneath, it is an ordinary project
(`<project>--<slug>`), so terminals, `cc`, notifications and the auth checks work
on it unchanged.

### How many slots, panes and workspaces

Ten slots per project, eight panes and five workspaces per repository are defaults,
not fixed limits. Each deployment sets its own in the config, and can change them
from the box page without a stack deploy:

```json
"mux": { "slots": 10, "panes": 8, "workspaces": 5 }
```

`slots` can be 1–32, `panes` 1–16 (twelve and sixteen add four-by-three and
four-by-four layouts), and `workspaces` 1–20. They are ceilings, not quotas: a slot
is made the first time it is used, and a workspace only when you ask for one.
Lowering a number hides what is above it and deletes nothing. A slot past the new
count keeps its worktree, its branch and its work, and comes back when the number
goes up again. What a box can actually run at once is a question of memory: each
Claude holds a few hundred megabytes, and a `t4g.large` has 8 GB.

### On a phone

The Mux shows one pane at a time: the projects and slots are a drawer behind ☰, and
a tab per pane runs along the top. In a terminal, tap one of Claude Code's numbered
choices ("1. Yes", "2. No") to pick it. Two rows of keys run along the bottom:

- **Row one:** Esc, Enter, the arrows, 1–4, Shift-Tab, 📎, and Copy, which shows the
  screen as selectable text.
- **Row two:** Ctrl and Alt, which hold for the next key so you can type any chord.
  It also has one-tap keys for what Claude Code and a shell use most (^X^S to send
  now, a newline that does not send, Esc Esc, ^O ^R ^T ^G ^D ^U ^W ^K ^A ^E ^L,
  ^B^B for tmux, Home/End/PgUp/PgDn/Del), and the symbols a phone keyboard hides a
  page deep.

There is also a line of ordinary text input, with the phone's autocorrect and
dictation, that is typed into the terminal and then Enter.

Nothing on the laptop or the phone owns any of it. Shut the laptop mid-task and the
task finishes. Open the phone and every pane is there, in the slot you left it.

## Sessions that outlive the browser, and follow you between devices

A terminal session is the simplest case: it is a tmux session on the box, the same
one on every device you attach from, and it depends on nothing else. tmux runs as
its own service, so a deploy of the app does not end it. From any terminal on the
box:

```bash
cc                      # list live sessions and projects
cc my-project           # start, or rejoin, a permanent session
cc my-project/slot-3    # the same, in one of its worktree slots
cc my-project --kill    # end it
```

The editor's Claude panel needed more work. It runs `claude` as a child of the
extension host, and code-server creates one extension host *per browser page*, then
tears it down within **five seconds** of the last WebSocket closing. So the panel
did not hand off between devices; it *forked*. The second device started its own
`claude` and resumed the same session from the transcript on disk, while the first
one carried on running, untouched. Both then appended to the same file and diverged.

That is fixed outside the extension, because nothing can fix it inside one
extension host. The panel's `claude` is launched through a small wrapper
(`claudeCode.claudeProcessWrapper`, a supported setting) that hands its stdio to
**claude-broker**, a service that owns one real process per conversation. Every
page attaches to that one process, and a page that joins mid-turn is replayed the
stream so far and catches up.

- closing the editor, the browser, or your laptop changes nothing
- **opening the project on a second device joins the same live run**, mid-turn,
  rather than starting a second Claude
- it survives a reload, a dropped connection and a code-server restart: the broker
  is its own systemd service, so restarting the editor cannot take your
  conversation down with it
- if the broker is ever down, the wrapper just runs the real binary, so you get
  single-device behaviour instead of an editor that will not start

Set `claudeMobile.claudeSurface` to `tmux` to make the editor's Claude button open
the slot's tmux session instead of the panel.

## The Browser pane: a real Chrome on the box

**Browser**, at the top of the Mux, opens `/chat/browser`: a full Google Chrome
running on the box, on a virtual screen, shown in the page. Its tabs, address bar,
extensions and profile are the box's. So the laptop, the phone and any Claude on
the box see and drive the same browser: sign in to something once and an agent can
use it, or watch an agent work through a page you are both looking at.

- **The picture is video.** ffmpeg encodes the screen as H.264 and the page decodes
  it with WebCodecs, at 30 frames a second (or 60 with `browser.fps`) and a few
  megabits. VNC carries the keys, the pointer and the clipboard. A browser without
  WebCodecs falls back to VNC's own picture.
- **It fits whoever is looking.** The screen is resized to the viewer, so a phone
  gets a phone-shaped browser with a keyboard, and a Mac's ⌘ is sent as Ctrl.
  Pasting carries your clipboard across, and a copy in the browser comes back to it.
- **Claude drives it over DevTools** on `127.0.0.1:9222`:
  `claude mcp add chrome -- npx chrome-devtools-mcp@latest --browser-url=http://127.0.0.1:9222`.
- It is Chrome for Testing's current Stable, refreshed by every install, with its
  profile on the workspace volume. It is on by default. `"browser": {"enabled":
  false}` removes the service. It runs at a lower CPU priority than terminals and
  the editor, and a hidden page closes its video stream, so a background tab costs
  nothing.

Details and settings are in [docs/HOST.md](docs/HOST.md) and
[docs/DEPLOY.md](docs/DEPLOY.md).

## Voice

**Hear what Claude last said.** The 🔊 on any Mux pane, and the status button in
the editor, open a sheet with the last message there, **rendered rather than shown
as source**: bold, headings, bullets, tables and fenced code come out as themselves.
Tables scroll sideways as a unit, and Hebrew and Arabic are laid out right to left.
**Read aloud** reads it in a neural voice, with a **speed** stepper from half speed
to three times that applies to the message being read and keeps the voice's pitch.
While the sheet is open it follows the conversation and reads out a newly arrived
message by itself. The sheet's reach is bounded, because a phone that starts
talking on its own after you have put it down is worse than one that stays quiet.

Over the message sit **‹ Previous**, **● LIVE** and **Next ›**, which work like the
scrubber on a live stream. LIVE is lit by default: each new message replaces the one
on screen and the one being read. Previous steps back and reads an earlier message,
and from then on the sheet is *paused*. It stays on that message, and messages that
arrive meanwhile are kept but neither shown nor read until Next steps forward to
them. LIVE, pressed while lit, pauses right where it is. Closing the sheet ends a
pause.

Voices come from Azure AI Speech (its free tier by default, which refuses rather
than charges when its monthly allowance runs out), Amazon Polly or OpenAI. Hebrew is
spoken in a native Hebrew voice on Azure, or in OpenAI's multilingual voices without
it, and a Hebrew word in an English sentence is still said.
Code blocks are offered one by one rather than read as noise.

**Talk it over.** Beside Read aloud, **Talk it over** opens a spoken conversation
*about that message*: "wait, go back to the part about the timeout", asked out loud
while walking. It goes over WebRTC straight from the browser to OpenAI's or Azure
OpenAI's realtime API, so the audio never touches the box. It is deliberately a dead
end. It gets the message and the question that produced it and nothing else, has no
tools, cannot reach Claude, and says so on screen. A voice channel with no
transcript is the last place a command should be issued from.

**Dictation** is in the editor's floating bar (and in the deprecated chat). Tap the
mic, talk, tap to stop, and the transcript is inserted at your cursor. English is
transcribed **on the instance** with `whisper.cpp` (`base.en`): no API key, nothing
per request, and audio never leaves the box (about 4s for 11s of audio on 2 vCPUs).
Hebrew goes to Azure Speech's free tier, or to OpenAI's `gpt-transcribe` without it
(Bedrock's speech models answer what they hear instead of writing it down). When you
stop talking, the finished text gets one pass through Claude Haiku on Bedrock for
punctuation, capitals and plainly misheard names. It never answers, acts on or rewrites what you said, and the raw
transcript stays if the pass fails. The switch for it is in Settings. In a Mux
terminal on a phone, the compose line takes the phone's own dictation.

A long dictation used to end without warning, because a phone being talked into is
a phone nobody is touching, and the display sleeps on its idle timer, taking the
recognizer with it. So the app **holds the screen awake** while it is open and in
front (on by default, switch in Settings). It re-requests the wake lock on every
return to the foreground and every 30s, because the browser releases it on every
hide and the OS revokes it without saying so. The status bar counts the seconds of
a dictation, and any stop you did not ask for **beeps, buzzes and leaves a banner**,
with the words kept and Resume to carry on. A small ⟳ beside the mic resets
dictation completely, with Undo for a few seconds.

Two details worth knowing. The browser converts audio to 16 kHz mono WAV before
uploading, because browsers record Opus, the bundled decoder does not read it, and
Amazon Linux 2023 has no ffmpeg package. And for other languages on the box, swap
`WHISPER_MODEL` to a multilingual build (`ggml-base.bin`) in
`/etc/claude-voice.env`. Azure OpenAI Whisper is an optional override. See
[docs/DEPLOY.md](docs/DEPLOY.md).

## Notifications

When a session you are not watching finishes a turn (a Mux terminal, the editor
panel, anything under tmux), your phone buzzes with the project and the first line
or so of the answer. It says "waiting for sub-agents" rather than "finished" when a
turn hands off, and that Claude is waiting for you when it is asking a question.
Each device chooses what a tap opens: the project's editor window, or the Mux on
that very slot, which joins the session already running there rather than starting
a second Claude. There is one notification per conversation, replaced rather than
stacked, and nothing for anything older than ten minutes.

They are off until you turn them on, from the Mux sidebar, the editor's status
sheet or Settings. Turning them on asks the OS once and sends a test notification,
so you find out immediately rather than hours later.

## The editor on a phone

`/editor/` is real code-server, with the activity bar, status bar and tabs stripped
so Claude gets the whole screen, and dark on every device. A small bar of buttons
floats over it: dictate, switch project, terminal, fix the layout, and the status
button described under [Voice](#voice). Long-press any of them to move the bar to
the other edge. The GitHub Pull Requests extension is installed and signed in with
the workspace's GitHub token.

Claude opens **in the editor area**, full width, rather than in a side bar, which
on a phone is a narrow strip that wraps text to a letter per line. It is the
official extension's panel, sharing one conversation across your devices through
the broker described above.

The status button answers **is Claude working, and what did it last say** without
waiting out the panel's own history load. A phone that has just come back from
sleep otherwise shows an empty transcript for several seconds. It names the
conversation it is talking about, since the panel and other surfaces can be in
different ones.

The terminal button opens a second, plain shell in the editor area, and pressing it
again hands the window back to Claude. It reuses the shell you already had, even
across a page reload. That shell is **zsh**, with completion, shared history and a
two-line prompt with the git branch. History lives on the workspace volume, so a
command typed on a phone can be recalled on a laptop. Your own additions go in
`~/.zshrc`, which a deploy leaves alone.

The layout button exists because of one specific way the editor gets stuck. Tap a
file in the transcript and it opens beside the panel, and with no tabs and no
status bar there is nothing on screen to close it. Three escalating ways out:

- **Back to Claude** closes the files and diffs the panel opened and gives Claude
  the whole window. Unsaved files are left alone rather than raising a save dialog
  no phone can answer.
- **Show tabs & bars** puts the chrome back so things can be closed by hand.
- **Reload** recovers on its own: the editor closes restored file tabs at startup.
  Set `claudeMobile.closeFilesOnStartup` to `false` if you use this as an IDE at a
  desk and want your open editors back.

A reload of the editor restarts the extension host, and the workbench reloads
itself whenever a phone restores the page from its back/forward cache. So the
surface adds no loads of its own, dictated text is saved as you speak it, and the
Layout sheet lists this tab's recent loads and what caused each one.
`…/chat/reset.html` clears the service worker, the caches and the saved workbench
state for the device. It touches nothing on the server.

## The box page: what is running, and every setting

`/chat/admin` (**Box** at the top of the Mux) is a task manager for the instance.
It exists because every hard-won fact in this README was found the same way: an SSM
shell, `ps` and `journalctl`. None of it was visible from the app itself.

- **Every conversation on every surface**: each tmux session (badged working or
  waiting on you), the editor panel's through the broker, and the deprecated chat's.
  Each shows the project it is in, how long it has been idle, and how much memory
  it holds.
- **The services the deployment is made of**, live, with memory for the box and
  disk for the workspace volume.
- **What is wrong, in words.** An editor panel that has forked. Processes the panel
  started and never spoke to (ten of those once held 2 GB of 7.8 GB). A tmux server
  in a cgroup the next deploy would kill. Each one says what it costs, and the ones
  with a safe fix have a button.
- **Stopping one thing.** Anything that might be mid-turn refuses the first tap and
  says what you would lose. Killing a whole service is not offered: that is
  `systemctl`'s job.
- **Settings.** Every key of the deployment's config, grouped, each with an input of
  its own type, what the file says, and where a change takes effect. A saved value
  is kept on the box and outlasts deploys until the file's own value changes. Keys
  the box can apply to itself (model, permission mode, effort, git identity, the
  login allowlist, the browser) take effect on **Apply**. Apply reinstalls with the
  new values, checks the login still holds, and puts the old ones back if not. Keys
  that belong to the AWS stack wait for the next full deploy, which reads them from
  the box. See [docs/DEPLOY.md](docs/DEPLOY.md).

It is a page inside the chat service rather than a second app, so there is one
login, one authentication implementation, and nothing new exposed to the internet.

## Keeping itself up to date

A root timer updates the **Claude Code CLI** every day, because the CLI's own
updater runs as the workspace user and cannot write to the global install.

TripleC itself has no releases: `main` is the release. `triplec-update run --now`
takes it, and the `autoUpdate` setting lets a box do the same on a timer, as
cautiously as you choose:

- **Modes:** `off` (the default), `notify` (push when an update is ready), or
  `install`.
- **When it acts:** a commit must have **soaked** on the branch for a set time
  (24 hours by default), an install waits for a time window if you give one, and it
  waits until no Claude conversation has written anything for 30 minutes.
- **How it installs:** fast-forward only, after the full test suite has passed in
  its own clone. It then verifies that the app answers, still refuses a caller with
  no login, and reports the new build. A failed install is rolled back to the
  previous commit and not retried.

It is editable from the box page. Read [docs/UPDATES.md](docs/UPDATES.md), including
what turning `install` on trusts.

## The chat (deprecated)

`/chat/` (**Chats** on the Mux) is the earlier interface: a purpose-built chat over
one long-lived `claude` process per conversation, with tool calls as collapsible
cards, a stop button, a tab per project, dictation, drafts that survive the browser
discarding the tab, and a list of every past session on the box. It still works, and
everything else on this page works without it. It carries a banner pointing at the
Mux, and a chat pane in the Mux offers **Switch to terminal**. New work goes into
the Mux, and project management moved there too.

## Defaults

Opus 5.5 on Bedrock, `--permission-mode bypassPermissions`, `--effort max`. The
deployment-wide defaults live in `triplec.config.json` and can be changed from the
box page. They apply to new sessions: an existing conversation keeps the flags it
started with, because they're process arguments.

`bypassPermissions` means Claude runs commands in the workspace without asking.
That is the point of the UX and the main thing to be aware of. Set `permissionMode`
to `acceptEdits` or `plan` if you'd rather have a checkpoint.

## Security

Authentication is enforced inside the application process that spawns `claude`,
not in nginx and not in the load balancer alone. Every route and every WebSocket
upgrade (the terminals and the browser included) require a session. The server
refuses to start without a strong password and cookie signing key, and failed logins
are throttled at two layers. Sign-in is a password, or Google or any OIDC provider
with an allowlist of identities.

This is stated precisely because earlier versions of this project got it wrong
twice, in the same shape both times. First the nginx config carried a comment
describing an `auth_request` gate that had never been written, and the chat API sat
open to the internet while every document in the repo said otherwise. Then, after
`oidc` mode arrived, the identity allowlist was enforced correctly in `auth.js`, but
the editor routes did not go through `auth.js` at all. Neither was a bug in the
check. Both were a route that did not reach it.

So the claim is checked by machine, from both ends.
[`chat-service/auth-test.js`](chat-service/auth-test.js) boots the real server and
asserts every route and socket refuses an unauthenticated caller.
[`chat-service/manifest-test.js`](chat-service/manifest-test.js) parses the nginx
config and asserts no route bypasses it, discovering the routes from the config
rather than from a list, because a list is what both bugs got past. `deploy.sh`
refuses to deploy if either fails, and after deploying it curls the live URL and
aborts if the API answers without a login. Self-updates make the same check.

```bash
npm run test:auth
```

Full threat model, what it does and does not defend against, and how to reduce the
blast radius: [docs/SECURITY.md](docs/SECURITY.md). Found a hole? Please report it
[privately](https://github.com/MichaelNusair/triplec/security/advisories/new).

## Install as an app

Open the URL, sign in, then **Add to Home Screen** (iOS Safari) or the install icon
in the address bar (Chrome/Edge/Android). The icon opens the Mux. The service worker
exists only to receive notifications: it caches nothing and intercepts no requests,
because the app is a live WebSocket client and a stale cached shell would break it.

**A project can have its own icon, and therefore its own window.** Open the project
in the editor from the floating bar's project button (it opens at `/p/<name>/`),
then use that same button → **Give &lt;project&gt; its own window**. It lands on the
home screen as its own app, in its own task in the app switcher. This is the only
way to get a second window on Android, where Chrome gives an installed web app
exactly one.

**The `/p/<name>/` path is the whole trick.** An installed app owns a *path prefix*
(its scope), and scope matching ignores the query string. While every project
opened at `/editor/?folder=<path>`, they were all one app as far as Android was
concerned, and only the first would install. So a project gets a path of its own,
which nginx proxies to the same code-server. The app itself lives under `/chat/`
for the same reason, so that its icon does not claim every project's scope too.

If Chrome still answers **"this app is already installed"**, the likeliest cause is
an icon added back when the app claimed the whole site. Remove it from the home
screen and add it again. **Check this install**, beside the project button, asks
the phone what it can see rather than guessing.

## Cost

Roughly **$75/month** left running: `t4g.large` ~$49, ALB ~$16, 100 GB gp3 ~$8, 40
GB root ~$3, plus Bedrock token usage. Stopping the instance when idle cuts the
compute portion. The workspace volume is retained on stack deletion, so projects
and history survive a stop or a teardown. Host mode costs whatever your VM does.

## The landing page

[`landing/`](landing/) is the static marketing site, the page at
<https://triplec.host>. It deploys as its own stack (private S3 behind CloudFront)
with no shared resources and no route to the workspace, so public traffic never
touches the machine holding your GitHub token. It is optional: skip it if you're
self-hosting for yourself.

```bash
./deploy-landing.sh    # independent of ./deploy.sh
```

Visitor analytics is optional and off until you give it a key. Set
`landing.analytics.posthogKey` to a PostHog project key (`phc_…`) and the page
records sessions in full: replay, autocapture, heatmaps, scroll depth, which
sections were read, and whether the install command was copied. PostHog is proxied
through the site's own domain. Leave the key empty and no analytics code runs at
all. See [docs/DEPLOY.md](docs/DEPLOY.md#analytics-for-the-landing-page).

## Working on it

`AGENTS.md` (and `CLAUDE.md`) orient both people and AI agents: repo map, the
rules that matter, and the gotchas that have burned people. Contributions welcome:
see [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
npm test                              # every suite: auth and routing, the Mux, terminals,
                                      # the browser, voice, push, the broker, the box page,
                                      # updates, host mode, the landing page's analytics
cd infra && npx cdk synth --quiet     # stack compiles
```

## License

MIT. See [LICENSE](LICENSE).
