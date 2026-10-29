# TripleC

**Claude, Code, Cloud.** Claude Code as a chat app you can install on your phone,
running on a machine of its own. Send a message, Claude works on your repo, you
get an answer. The full VS Code editor is still there at `/editor/` when you're at
a desk and want files, diffs, and a terminal.

Your sessions live on the server, not in a terminal on a laptop, so the
conversation you start at a desk is the one you pick up on a phone — mid-task,
with context intact, and still running while both are shut. The cloud is the third
C, and the part this project adds; everything above it is Anthropic's CLI, running
unmodified.

```bash
git clone https://github.com/MichaelNusair/triplec.git
cd triplec
cp triplec.config.example.json triplec.config.json
$EDITOR triplec.config.json     # domainName + hostedZoneName
./deploy.sh
```

**Two ways to run it, and the same MIT-licensed commit either way.** Self-hosting
is free and always will be — nothing is held back from this repository, there is
no licence key, and you pay AWS rather than us. Or we run it for you on a hostname
of yours: see [docs/MANAGED.md](docs/MANAGED.md), which is also where the awkward
questions are answered, including the fact that the managed service costs $0 today
because we have not started charging for it.

You need an AWS account, a Route53 hosted zone, and Bedrock model access. Full
walkthrough in [docs/DEPLOY.md](docs/DEPLOY.md).

**Already have a Linux VM?** Host mode installs TripleC onto an existing Ubuntu
24.04 machine as its developer — no AWS, your own `claude /login`, your
repositories and hooks where they already are, reached through the VM's own HTTPS
proxy or a tailnet. See [docs/HOST.md](docs/HOST.md).

> **Read [docs/SECURITY.md](docs/SECURITY.md) before you expose this.** It
> deploys a web page that runs shell commands on a machine you own — that's the
> product, not a side effect. Anyone who logs in has a shell. Deploy it as a
> personal workspace, not a shared service.

## Why it's built this way

The first version served VS Code in the browser with the official Anthropic
extension. That works well on a laptop and is genuinely painful on a phone — which
is the device you actually want this on. So the primary interface is a
purpose-built chat, and the editor is the secondary surface.

The chat isn't a reimplementation of Claude's brain; it's a thin UI over the real
`claude` CLI. Each conversation is **one long-lived process** driven over
`--input-format stream-json`, which is what makes it behave like a messaging app
rather than a series of one-shot commands: context, working directory, and session
id all persist, and a follow-up message costs no startup.

```
your-domain.com
  │
  ALB :443  ── ACM cert (created for you), :80 → :443
  │           4000s idle timeout (a turn can run for many minutes)
  │
  EC2 t4g.large (Graviton, arm64) — reachable only from the ALB
  ├── nginx :8080
  │     ├── /          → chat service (:9997)
  │     ├── /chat/     → chat assets
  │     ├── /editor/   → code-server (:9999)
  │     ├── /p/<name>/ → code-server, one installable app per project
  │     └── /          → code-server, for its own absolute asset URLs
  │
  ├── claude-chat service
  │     ├── authenticates every request itself  ← the security boundary
  │     ├── one `claude` process per conversation, kept alive
  │     ├── stream-json → a small event vocabulary for the UI
  │     └── /api/transcribe → whisper.cpp, on-box, no API key
  │
  ├── code-server + official anthropic.claude-code extension
  │     └── its Claude launched via claude-broker/wrapper
  │
  ├── claude-broker service
  │     ├── one `claude` per conversation, outliving every browser page
  │     └── replays the stream to a device that joins mid-turn
  │
  └── /workspace  ← persistent EBS, survives instance replacement
        ├── projects/   one directory per repo
        ├── claude/     ~/.claude — session history lives here
        └── code-server-{data,ext}/

  Bedrock via instance role — no model keys in the browser
```

## The chat

- **Conversation list** — every past session across every project, newest first,
  titled by its opening message. Tap to resume; the transcript is replayed and
  Claude still has its context.
- **Tool calls** as collapsible cards (`📖 Read src/main.c`) — tap for arguments
  and full output. Failures auto-expand.
- **Live streaming** text, with a typing indicator while Claude works.
- **Stop button** while a turn is running.
- **Several projects at once, one tab each** — the projects you are working on sit
  in a tab strip above the thread, each with a dot for what it is doing: working,
  idle, or reconnecting. A tab is a project, not a chat, so the strip stays readable
  on a box with seventeen of them; the line under the tabs says which of that
  project's conversations the window is showing, and tapping it lists the others.
  Switching either way takes the composer and the draft with it, while the projects
  behind carry on streaming; when one of them finishes, it buzzes and names the
  project so you know which chip to tap. Three stay connected at a time and the rest
  wait as tabs, which is what keeps six open projects from costing a phone six live
  threads — tapping one rejoins it exactly as another device would. Neither closing
  a tab nor switching conversations stops anything: it goes on running on the box,
  it just is not being watched.
- **A notification when a session you are not watching finishes** — the editor
  panel, or anything under tmux: the runs you start and walk away from. Your phone
  buzzes with the project and the first line or so of the answer; tapping it just
  dismisses it. One notification per conversation, replaced rather than stacked when
  that conversation answers again, and nothing for anything older than ten minutes.
  Chats inside this app are deliberately excluded — they already announce themselves
  on screen. Off until you turn it on in Settings, which asks the OS once and sends
  a test notification so you find out immediately rather than hours later.
- **Drafts survive the app going away** — a half-typed or half-dictated message is
  saved as you write it and restored with the conversation, because a phone browser
  reloads a backgrounded tab whenever it likes and a paragraph of dictation exists
  nowhere else.
- **Reconnect-safe** — the server keeps the process alive when your phone locks or
  the network drops. Reattaching resumes the same conversation mid-task, including
  work started from another device.
- **One-tap new project** — creates the directory, a git repo, and optionally a
  GitHub remote.
- **Clone an existing GitHub repo** — paste `owner/repo`, or tap one from the list
  of repositories the workspace token can see.
- **Retire a project** — commits, pushes every branch and tag, checks with the
  remote that it really landed, then deletes the folder from the instance. It
  refuses if anything would be lost (no remote, a stash, a push that failed) and
  says which; overriding is a separate, deliberate tap. Chat history is kept.

## Sessions that outlive the browser, and follow you between devices

Start something on your phone, arrive home, open the same project on your laptop,
and keep watching the same run — in the official Claude Code panel, with its diffs
and tool cards.

The panel could not do that on its own. It runs `claude` as a child of the
extension host, and code-server creates one extension host *per browser page* —
then tears it down within **five seconds** of the last WebSocket closing. So the
panel did not hand off between devices; it *forked*. The second device started its
own `claude`, resumed the same session from the transcript on disk, and the first
one carried on running, untouched. Both then appended to the same file and
diverged. What you saw was your laptop showing the conversation sitting idle while
your phone was still working, and the two telling different stories a minute later.

That is fixed outside the extension, because nothing can fix it inside one
extension host. The panel's `claude` is launched through a small wrapper
(`claudeCode.claudeProcessWrapper`, a supported setting) that hands its stdio to
**claude-broker**, a service that owns one real process per conversation. Every
page attaches to that one process; a page that joins mid-turn is replayed the
stream so far and catches up.

- closing the editor, the browser, or your laptop changes nothing
- **opening the project on a second device joins the same live run**, mid-turn,
  rather than starting a second Claude
- it survives a reload, a dropped connection and a code-server restart — the
  broker is its own systemd service, so restarting the editor cannot take your
  conversation down with it
- if the broker is ever down, the wrapper just runs the real binary: you get the
  old single-device behaviour instead of an editor that will not start

A terminal-only route is still there, and it depends on nothing at all — no
broker, no extension. It is the same tmux session on every device you attach from:

```bash
cc                      # list live sessions and projects
cc my-project           # start, or rejoin, a permanent session
cc my-project/slot-3    # the same, in one of its worktree slots (see the mux, below)
cc my-project --kill    # end it
```

Verified on a live box: two clients attached at once, one session, one `claude`
process, and the session still running after both detached. Set
`claudeMobile.claudeSurface` to `tmux` to make the Claude button open that instead
of the panel.

## Several agents at once, on a big screen: the mux

`/chat/mux` (the **Mux** tab in the chat list, on a laptop) is a cmux-style desktop
view. Down the side: every project, each with eight **worktree slots**, and a light
on each one — orange while it works, a blue ring when it finished and nobody was
looking (the tab title counts those, and desktop alerts are one switch away). In the
middle: one to eight panes side by side.

A pane is either a **chat** or a **terminal**. The sidebar's **New: Chat | Terminal**
switch decides what a **+** opens, and each pane's header has a button that switches
it between its slot's chat and its slot's terminal. A terminal pane is the real
Claude Code CLI — the same TUI as `claude` on a laptop — in the permanent tmux
session `cc` keeps for that slot, so `cc my-project/slot-3` from any other terminal
joins the very same session. Scroll with the wheel or a finger; the pane's ⇱ button
copies a link that opens it as a full-screen terminal on a phone, with Esc, Tab and
arrow keys along the bottom.

Each slot is its own checkout — `<project>/.claude/worktrees/slot-1` … `slot-8`, on
branches of the same names — so eight agents on one project never edit the same
working tree. Every project you clone or create here gets them; older ones get each
slot the first time you use it. Press **+** next to a project for a chat in a free,
clean slot. A new chat brings its slot up to date with the default branch first,
but only if nothing in it would be lost; otherwise it starts from what is there,
and the pane says so.

Nothing on the laptop owns any of it. A chat pane is the ordinary chat in a frame,
run by the same service as the phone; a terminal pane is a tmux session, run by
the box's tmux service. Shut the laptop mid-task and the task finishes. Pick it up
on the phone from the chat list — labelled with its slot — or, for a terminal, from
the link or with `cc`. Closing a pane or the tab stops nothing.

## What is running on the box

`/chat/admin` — reachable from the **Box** tab at the bottom of the chat — is a task
manager for the instance. It exists because every hard-won fact in this README was
found the same way: an SSM shell, `ps` and `journalctl`. None of it was visible from
the app itself.

- **Every conversation on every surface** — the chat's, the editor panel's through
  the broker, and each tmux session — with the project it is in, how long it has been
  idle, and how much memory it is holding.
- **The services the deployment is made of**, live, with memory for the box and disk
  for the workspace volume.
- **What is wrong, in words.** An editor panel that has forked. Processes the panel
  started and never spoke to (ten of those were once holding 2 GB of 7.8 GB). A tmux
  server in a cgroup the next deploy will kill. Each one says what it costs, and the
  ones with a safe fix have a button.
- **Stopping one thing.** Anything that might be mid-turn refuses the first tap and
  says what you would lose; confirming is a deliberate answer to that question rather
  than a default. Killing a whole service is not offered — that is `systemctl`'s job,
  over SSM, where you can see the output.

It is a screen inside the chat service rather than a second app, so there is one
login, one authentication implementation, and nothing new exposed to the internet.

## Voice

Tap the mic, talk, tap to stop. The transcript is inserted **at your cursor** with
sensible spacing, so you can dictate into the middle of a half-typed message, move
the caret, and dictate again.

Transcription runs **on the instance** (`whisper.cpp`, `base.en`): no API key, no
quota request, nothing per request, and audio never leaves the box. Measured on 2
vCPUs, ~4s for 11s of audio.

**Then it gets punctuated.** Raw speech-to-text is the one place this used to feel
worse than a consumer app: no punctuation, no capitals, and every product name
mangled — "compared to ChatGPT and Gemini apps" arrives as "compared to Georgia PT
and Germany apps". Neither engine can do better on its own, because sentence
boundaries and proper nouns need the whole utterance and both of them work in
fragments: the browser's recognizer emits no punctuation at all, and whisper sees
one pause-delimited phrase at a time so that text keeps up with the speaker.

So when you stop talking, the finished text gets one pass through Claude Haiku on
Bedrock — punctuation, capitals, the names it plainly misheard, filler removed —
and nothing else. It never answers or acts on what you dictated, and it never
rewrites your words. The raw transcript is in the composer first and stays there
if the pass fails, times out, or comes back looking like a reply rather than an
edit; a send that lands mid-pass waits a moment for it. Costs a second or two and
a few tokens per dictation; the switch is in Settings, and it covers the editor
overlay too, where it runs after the text is already on your clipboard.

A long dictation used to end without warning: a phone being talked into is a phone
nobody is touching, so the display sleeps on its idle timer, and the speech
recognizer goes with it. The screen that was showing "recording" is the thing that
turned off, so there was nothing to notice. Now:

- the app **holds the screen awake** for as long as it is open — see below;
- the status bar above the composer counts the seconds, so a stalled recognizer is
  visible at a glance rather than inferred from silence;
- and any stop you did not ask for **beeps, buzzes, and leaves a banner** that is
  still there when you look at the phone again. The words already dictated stay in
  the box, and Resume carries on from where it stopped.

Where a wake lock is not available the status bar says so outright rather than
promising a screen that will sleep anyway.

**And there is a reset, next to the mic.** Everything above deliberately *keeps*
state when dictation stops — the transcript, where it was written, a phrase still
being transcribed, an interruption waiting to be resumed — because that is nearly
always text you want back. When a piece of it outlives the dictation it belonged
to, it turns up under the next one, and emptying the composer by hand does not help:
none of what puts it back is in the composer. The small ⟳ beside the mic is the way
out of that. It releases the microphone, dismantles the recognizer, forgets the
transcript and the saved draft, and discards anything already in flight — a phrase
mid-upload, a cleanup pass, a microphone granted after you gave up on the prompt —
so the next dictation starts from nothing. The text it clears is offered back as
Undo for a few seconds, because the button is one tap from the mic and what is in
the box is often several minutes of speech.

The editor overlay's Dictate sheet has the same control, for the same reason and
with the same Undo — **Reset**, beside *Restart mic*. The two are deliberately
different: Restart gives a recognizer that has stopped hearing you another go and
keeps every word; Reset is for when the words themselves are the problem. Out there
it also clears the draft the sheet recovers from, which is what makes dictation
survive the workbench reloading itself, and is therefore the other thing that can
hand you a paragraph you thought you had got rid of.

## Keeping the screen awake

The phone's display sleeps on its idle timer, and this app is used in long
stretches where nobody is touching the screen: dictating a paragraph, watching a
task run for two minutes, reading a long answer. When the display sleeps the page
is hidden, and hiding the page suspends the recognizer and freezes the WebSocket —
so the idle timer is not a cosmetic annoyance, it ends whatever was in flight.

So the **Screen Wake Lock** is held for as long as the app is open and in front,
not only while dictating. It is on by default, the switch is in Settings, and one
switch covers both the chat and the editor — they are one origin behind nginx, so
they share the setting. Three properties of the API shape the implementation:

- it needs a **visible** document; requesting while hidden is rejected;
- the browser **releases it on every hide and never re-acquires it**, so every
  return to the foreground has to re-request;
- the OS **revokes it whenever it likes** (battery saver, low battery) with no
  event to say you may have it back, so the only way to notice is to keep asking.

Hence one `syncWakeLock()` that reconciles held-against-wanted, called from every
event that can change either, plus a 30s timer for the revocation case. Turning the
setting off still lets dictation hold the screen: "off" means *don't burn my battery
while I read*, not *cut me off mid-sentence*.

What no web page can do is keep the display on once you leave the app or press the
power button — that is the OS's decision and the page is not consulted. Nor is there
a workaround from inside a browser with no wake lock API at all (iOS before 16.4);
there, raise the screen timeout in the OS settings. That residue is why the
"announce every stop we did not ask for" behaviour above still exists rather than
being replaced by the wake lock.

Two more details worth knowing:

- **The browser converts audio to 16 kHz mono WAV before uploading.** Browsers
  record webm/**opus**, and the bundled decoder (miniaudio) handles WAV/MP3/FLAC/
  Vorbis but *not* Opus — and Amazon Linux 2023 has no ffmpeg package. The browser
  already has an Opus decoder, so it does the conversion via WebAudio. 16 kHz mono
  is also exactly what Whisper wants, so uploads shrink.
- **`base.en` is English-only.** For other languages, swap `WHISPER_MODEL` to a
  multilingual build (`ggml-base.bin`) in `/etc/claude-voice.env`.

Azure OpenAI Whisper is supported as an optional override, falling back to local
if Azure errors. See [docs/DEPLOY.md](docs/DEPLOY.md).

## The editor on a phone

`/editor/` is real code-server, with the activity bar, status bar and tabs stripped
so Claude gets the whole screen. A small bar of buttons — dictate, switch project,
terminal, fix the layout — floats over it; long-press any of them to move the bar
to the other edge.

Claude opens **in the editor area**, full width, rather than in a side bar — on a
phone those are narrow strips that wrap text to a letter per line. It is the
official extension's panel, sharing one conversation across your devices through
the broker described above. A terminal session is one setting away
(`claudeMobile.claudeSurface: tmux`).

The status button answers **is Claude working, and what did it last say** without
waiting out the panel's own history load — a phone that has just come back from
sleep otherwise shows an empty transcript for several seconds. One tap gives a
line; tapping that opens the whole of the last message, with **Read aloud** for
when it is longer than a phone screen, and a **speed** stepper beside it — minus,
the rate, plus, from half speed to three times, which changes the message being
read as well as the next one and keeps the voice's pitch where it is. (The chat
app has the same range in Settings.) While that sheet is open it re-asks every
five seconds and reads a newly arrived message out by itself, so watching a turn
finish costs nothing at all — bounded by the sheet, because a phone that starts
talking on its own after you have put it down is worse than one that stays quiet.
It names the conversation it is talking about, since the panel and the chat app can
be in different ones.

The message is **rendered, not shown as source**: bold, headings, bullets, tables,
links and fenced code come out as themselves, because on a phone that sheet is the whole of
what you read of an answer and an answer is written to be read. The one-line
surfaces — the chip and the conversation list — get the markers stripped instead,
since a heading has nowhere to go on one line. Tables scroll sideways as a unit
rather than wrapping every cell, because a wrapped table is a wall of words with the
alignment that made it a table gone. Nothing about a message is ever
treated as markup: the renderer builds elements and puts model text through
`textContent`, and a link is only tappable if it points at http(s) or at this
origin.

That sheet is also where you **ask to be buzzed when a turn ends** — one tap, and it
sends itself a test notification so you know it works rather than assuming. It is the
same switch as the one in the chat app's settings and the same subscription behind it;
turning it on in either place turns it on for this device. Notifications are for the
sessions out here — this panel, and anything under tmux — which is why the switch is
here as well.

The terminal button opens a second, plain shell, also in the editor area, and
pressing it again hands the window back to Claude — with tabs hidden, the two just
take turns. It reuses the shell you already had rather than opening another,
including across a page reload. It is for the quick things (`git log`, run a test);
that shell dies with its tab, which is exactly why Claude does not live in one.

That shell is **zsh** — completion, shared history, and a two-line prompt with the
git branch, so a long path does not leave you three columns to type in on a phone.
History lives on the workspace volume rather than in `/home`, so a command typed
on a phone can be recalled on a laptop, and it survives the instance being
replaced. Your own additions go in `~/.zshrc`, which a deploy leaves alone.

The layout button is there because of one specific way the editor gets stuck: tap
a file in the transcript and it opens beside the panel, and with no tabs and no
status bar there is nothing on screen that closes it again. The panel keeps
whatever width is left, and reloading brings the file back with it. Three
escalating ways out, because the first two can't confirm they worked:

- **Back to Claude** closes the files and diffs the panel opened and gives Claude
  the whole window. The conversation keeps running; unsaved files are left alone
  rather than raising a save dialog no phone can answer.
- **Show tabs & bars** puts the chrome back so things can be closed by hand.
- **Reload** now recovers on its own — the editor closes restored file tabs at
  startup, so a refresh means what you expect. Set
  `claudeMobile.closeFilesOnStartup` to `false` if you use this as an IDE at a
  desk and want your open editors back after a reload.

A reload of the editor is not free — it restarts the extension host, and the
Claude conversation lives inside it — and it is not always your decision: the
workbench reloads itself when the browser restores the page from its back/forward
cache, which on a phone happens whenever you switch apps and come back. So the
surface no longer adds loads of its own (tapping the project you are already in
does nothing, and the startup layout pass only acts when the layout is actually
wrong), dictated text is saved as you speak it rather than living only in the
overlay's textarea, and the Layout sheet lists this tab's recent loads and what
caused each one — which is the only way that symptom is visible from a phone.

Beyond that, `…/chat/reset.html` clears the service worker, the caches and the
saved workbench state for the device — which is what a black screen or a layout
that survives everything else actually needs. It touches nothing on the server.

## Defaults

Opus 5.5 on Bedrock, `--permission-mode bypassPermissions`, `--effort max`. All
three are overridable per-chat in the settings sheet, and the deployment-wide
defaults live in `triplec.config.json`. Changes apply to new chats — an
existing conversation keeps the flags it started with, because they're process
arguments.

`bypassPermissions` means Claude runs commands in the workspace without asking.
That's the point of the UX and the main thing to be aware of; set
`permissionMode` to `acceptEdits` or `plan` if you'd rather have a checkpoint.

## Security

Authentication is enforced inside the application process that spawns `claude` —
not in nginx, not in the load balancer alone. Every route and the WebSocket
upgrade require a session; the server refuses to start without a strong password
and cookie signing key; failed logins are throttled at two layers.

This is stated precisely because earlier versions of this project got it wrong
twice, in the same shape both times. First the nginx config carried a comment
describing an `auth_request` gate that had never been written, and the chat API sat
open to the internet while every document in the repo said otherwise. Then, after
`oidc` mode arrived, the identity allowlist was enforced correctly in `auth.js` —
and the editor routes did not go through `auth.js` at all, so any account the
provider would authenticate reached a full IDE if it also had the editor's
password. Neither was a bug in the check. Both were a route that did not reach it.

So the claim is checked by machine, from both ends.
[`chat-service/auth-test.js`](chat-service/auth-test.js) boots the real server and
asserts the check is right;
[`chat-service/manifest-test.js`](chat-service/manifest-test.js) parses the nginx
config and asserts no route bypasses it — discovering the routes from the config
rather than from a list, because a list is what both bugs got past. `deploy.sh`
refuses to deploy if either fails, and after deploying it curls the live URL and
aborts if the API answers without a login.

```bash
npm run test:auth
```

Full threat model, what it does and does not defend against, and how to reduce the
blast radius: [docs/SECURITY.md](docs/SECURITY.md). Found a hole? Please report it
[privately](https://github.com/MichaelNusair/triplec/security/advisories/new).

## Install as an app

Open the URL, sign in, then **Add to Home Screen** (iOS Safari) or the install icon
in the address bar (Chrome/Edge/Android). The service worker exists only to receive
notifications: it caches nothing and intercepts no requests — the app is a live
WebSocket client, and a stale cached shell would break it rather than help.

**A project can have its own icon, and therefore its own window.** Open the project
from the project button on the floating bar — it opens at `/p/<name>/` — then that
same button → **Give &lt;project&gt; its own window**. It lands on the home screen as its
own app: tapping it opens the editor on that project, in its own task in the app
switcher, beside whatever else you had open. This is the only way to get a second
window on Android — Chrome gives an installed web app exactly one, and no API opens
another — so it is one install per project, once. Same origin, same login, same
notifications.

**The `/p/<name>/` path is the whole trick.** An installed app owns a *path prefix*
(its scope), and scope matching ignores the query string, so while every project
opened at `/editor/?folder=<path>` they were all one app as far as Android was
concerned and only the first would install — the rest were refused as "already
installed". A project therefore gets a path of its own, which nginx proxies to the
same code-server `/editor/` does. Both addresses still work; only the per-project one
can be installed.

**The chat app lives at `/chat/` for the same reason.** It used to be served at the
root and to claim the whole site as its scope, which meant one chat icon on the home
screen claimed every project too, and Chrome refused each project install after it as
"already installed". The bare URL now redirects there, so nothing changes about how
you open it.

If Chrome still answers **"this app is already installed"**, the likeliest cause is an
icon added before that move: a phone keeps the scope an app was installed with until
Chrome refreshes it, so an old chat icon is still claiming the whole site. Remove it
from the home screen and add it again. **Check this install**, beside the project
button, asks the phone what it can see rather than guessing: which manifest this page
links, whether this page is inside that manifest's scope, whether Chrome offered an
install, and which installed app it thinks this page belongs to. It also prints the
version of the overlay it is running, because a workbench left open across a deploy
keeps the script it loaded; reloading the page is the fix for that one.

## Cost

Roughly **$75/month** left running: `t4g.large` ~$49, ALB ~$16, 100 GB gp3 ~$8, 40
GB root ~$3, plus Bedrock token usage. Stopping the instance when idle cuts the
compute portion; the workspace volume is retained on stack deletion, so projects
and history survive a stop or a teardown.

## The landing page

[`landing/`](landing/) is the static marketing site — the page at
<https://triplec.host>. It deploys as its own stack (private S3 behind
CloudFront) with no shared resources and no route to the workspace, so public
traffic never touches the machine holding your GitHub token. Optional; skip it
entirely if you're self-hosting for yourself.

```bash
./deploy-landing.sh    # independent of ./deploy.sh
```

Visitor analytics is optional and off until you give it a key. Set
`landing.analytics.posthogKey` to a PostHog project key (`phc_…`) and the page
records sessions in full — replay, autocapture, heatmaps, scroll depth, which
sections were read, whether the install command was copied. PostHog is proxied
through the site's own domain, so nothing is lost to a blocker and no third-party
origin appears in the page's CSP. Leave the key empty and no analytics code runs
at all. See [docs/DEPLOY.md](docs/DEPLOY.md#analytics-for-the-landing-page).

## Working on it

`AGENTS.md` (and `CLAUDE.md`) orient both people and AI agents: repo map, the
rules that matter, and the gotchas that have burned people. Contributions welcome
— see [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
npm test                              # auth + client + project tabs + overlay + dictation
                                      # + projects + operations surface + broker
                                      # + the landing page's analytics wiring
cd infra && npx cdk synth --quiet     # stack compiles
```

## License

MIT — see [LICENSE](LICENSE).
