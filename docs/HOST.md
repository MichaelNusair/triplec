# Host mode

TripleC on a Linux VM that already belongs to someone — typically a developer's
own dev VM, with no public IP, reached through the VM's private HTTPS proxy from a
laptop on the VPN, or through a tailnet from a phone. TripleC runs as that
developer and drives the same `claude` they use over SSH, in the repositories,
hooks and git setup the VM already has.

The AWS deployment ([DEPLOY.md](DEPLOY.md)) builds a machine around TripleC. Host
mode adds TripleC to a machine that has a life of its own. Installing it is
[deploy/host/README.md](../deploy/host/README.md); this page is what is different
once it runs, and how to prove it conforms.

Read [SECURITY.md, *Host mode on a developer VM*](SECURITY.md#host-mode-on-a-developer-vm)
first. Anyone past TripleC's login is the developer, on that VM's network.

## What changes

| | AWS deployment | Host mode |
| --- | --- | --- |
| Installed by | `deploy.sh` + `bootstrap.sh`, as root, once per instance | `deploy/host/install.sh`, as the developer, any number of times |
| Runs as | `coder` | the developer (`TRIPLEC_MODE=host`, `WORKSPACE_USER`, `HOME`) |
| Claude home | `/workspace/claude` | the developer's `~/.claude` and `~/.claude.json` |
| Projects | every directory under `/workspace/projects` | an explicit registry, `projects: [{name, path}]` |
| Claude provider | Bedrock, via the instance role | `claude.authMode`: `login` (the developer's `claude /login`), `vertex`, `apiKey` or `bedrock` |
| Default model | the Bedrock id in `defaultModel` | none — the CLI's own default — unless `defaultModel` is set |
| Default permission mode | `bypassPermissions` | `manual` or `acceptEdits`, with approvals relayed to the chat |
| CLI's PATH | the unit's | the developer's login shell's (Homebrew, `~/.local/bin`, `~/go/bin`, …) |
| Secrets | AWS Secrets Manager | `~/.config/triplec/secrets.env` (0600), or the environment |
| Git credentials | a PAT from Secrets Manager | the VM's own `gh` login or SSH key |
| In front | ALB → nginx on :8080 | the VM's own HTTPS proxy → one nginx site on `127.0.0.1:8080`; or Tailscale Serve → the app port |
| Login | `password` or `oidc` (ALB) | `password`, and/or `trusted-header` (Tailscale identity) |
| Features | all | flags: `editor voice polish push mux admin retire` |

Nothing on the AWS deployment changes: with `TRIPLEC_MODE` unset every default is
the one it always had, and `chat-service/host.js` is the only file that knows both.

## Running

**Claude.** In `login` mode the service sets no provider variable at all — it
removes any it inherited — and passes no `--model` unless `defaultModel` is set, so
a chat runs exactly as `claude` does in the developer's terminal. The CLI is driven
headless (`--print --input-format stream-json`), which works with `claude /login`
credentials the same way it does with an API key. Whether an organisation's
agreement with Anthropic covers that use of a subscription login is a question
for that organisation; `apiKey` and `vertex` are there for when the answer is no.

**Permissions.** Every chat starts the CLI with `--permission-prompt-tool stdio`.
In any mode that asks, the CLI then sends a `control_request` (`can_use_tool`) on
stdout instead of refusing, and the service relays it to every device attached to
that chat as an approve/deny card — and as a push notification, with push on. The
first answer is written back as a `control_response`; the others are told it was
answered. An interrupt withdraws the question. Requests and decisions are audited.
Verified against Claude Code 2.1.312: `manual` (which the CLI reports as
`default`) asks for a shell command that writes, approve runs it, deny blocks it
with the message the model is shown.

**Hooks and settings.** The CLI is run unmodified — no `--settings`,
`--setting-sources`, `--mcp-config` or `--bare` — with the developer's `HOME`, so it
loads the same user, project and local settings, hooks, skills and MCP servers as
over SSH. Hooks run under every permission mode, `bypassPermissions` included:
verified with a project `PreToolUse` hook that exits 2, which blocked a `Write` in
`bypassPermissions` and surfaced the hook's own message.

**Slots.** A registered project gets `slots.count` worktrees (up to 8) under
`.claude/worktrees/slot-N`, each on a branch of that name. `slots.postCreate` is a
shell command run once in a newly created slot — install dependencies, so the
repository's commit hooks can run there — in the background and one slot at a time
per project. Opening a slot waits for it; a failure is shown in the mux pane with
the end of its output, and the slot stays usable. A slot removed from under
TripleC (a reaper for idle worktrees, a `git worktree remove`) is recreated the next
time it is opened, from its branch, and its past conversations stay listed
throughout. No git call TripleC makes passes `--depth`, `--deepen` or
`--unshallow`: a shallow clone stays shallow.

**Registry.** With `projects` set, those are the only projects. Creating or cloning
one is limited to a registered name whose directory does not exist yet, and with
`retire` off there is no route that deletes a directory at all.

**Limits.** `maxLiveSessions` (default 8) caps the `claude` processes the service
runs; joining a live chat never counts against it, and a new one past it is refused
with a message saying so. The admin page shows memory per session.

**Connections.** The service binds loopback only, and refuses anything else unless
`allowPublicBind` is set. It serves the chat under `/chat/` and redirects the bare
root there itself, so it works whether or not nginx is in front. Cookies are
`Secure` behind any TLS proxy that says `X-Forwarded-Proto: https` from loopback.
Every chat socket gets an application ping every 25 seconds, which the page
watches: after 75 seconds of silence it reconnects and reattaches, which replays
anything it missed — so a turn that is quiet for longer than a proxy's idle
timeout still shows its end.

**From a phone.** Point Tailscale Serve at the app port —
`tailscale serve --bg --https=443 http://127.0.0.1:9997` — and set `auth.mode`
to `trusted-header` with the owner's tailnet login in
`auth.trustedHeader.allowedEmails`. Serve adds `Tailscale-User-Login` (with
`-Name` and `-Profile-Pic`) for requests from tailnet users — including users of
other tailnets the device has been shared with, which is why the allowlist is what
decides — strips any copy a client sent, and adds none for Funnel or for tagged
devices, which therefore cannot sign in this way (checked against Tailscale's Serve
documentation, 2026-10-29). The
service believes the header only from a socket owned by `tailscaled` (uid 0) — see
[SECURITY.md](SECURITY.md#trusted-header-host-mode-over-a-tailnet). The PWA and
push work on any HTTPS origin, so both the proxy hostname and the tailnet hostname
can be installed.

**Logs.** Both units log to the journal (`journalctl -u triplec-chat`). Audit
events are single JSON lines starting `{"audit":"triplec"`; a log agent that ships
the journal or syslog ships them with no further configuration.

## Conformance

```bash
scripts/host-conformance.sh                       # the installed system, read-only
scripts/host-conformance.sh --live --exercise     # plus a real chat, the relay, and a slot removed and recreated
scripts/host-conformance.sh --static              # no install needed; what CI runs
```

One line per requirement ID with `PASS` or `FAIL`, exit 0 only when nothing failed.
`--expect-tools "claude node go"` names the commands that must resolve on the
login-shell PATH; `--public-url https://…` also checks the address the VM's proxy
serves. The same requirements are covered without a VM by
`chat-service/host-test.js` (part of `npm test`) and, for the installer, by
`deploy/host/test/container-test.sh` in an Ubuntu 24.04 container.

Two checks need a person, and the script says what is left for one:

- **PWA and push.** Install the app on iOS and on Android over the tailnet, let a
  chat finish while the app is closed, and confirm the notification; then confirm a
  laptop session through the VM's proxy.
- **Permission prompts.** In a chat in `manual` mode, ask for something that
  writes; approve one request and deny another from a phone, and find both in the
  audit log.

And one is best done side by side: trigger an edit that a repository's own
`PreToolUse` hook blocks, once from a TripleC chat and once from `claude` over
SSH, and compare the two messages. They come from the same hook, so they should be
identical.

## What stays with the VM's owner

- **Running the installer.** A VM provisioned by cloud-init runs it once, at
  creation; TripleC's installer is a separate, repeatable step that belongs after
  boot (a post-boot unit, or by hand).
- **`claude /login`**, `gh auth login`, and joining a tailnet, all as the developer.
- **`slots.postCreate`** for each project — whatever a fresh checkout needs before
  it builds and its hooks pass.
- **Network reach.** Whether a VM that runs TripleC should also be able to reach
  production databases. TripleC cannot narrow it; see SECURITY.md.
- Optionally, exempting `.claude/worktrees/slot-*` from a worktree reaper. Not
  needed — a reaped slot comes back — but it saves re-running `postCreate`.
