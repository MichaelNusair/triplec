# Host mode

Host mode installs TripleC onto a Linux machine that already belongs to someone:
typically a developer's VM, reached through a private HTTPS proxy or over a tailnet.
TripleC runs as that developer, and Claude Code uses the same `~/.claude`,
`~/.claude.json`, git identity and `claude /login` as `claude` does over SSH. No AWS
account is involved, and nothing is provisioned. The AWS deployment
([docs/DEPLOY.md](../../docs/DEPLOY.md)) builds a machine around TripleC. Host mode
adds TripleC to a machine that has a life of its own, and the installer is written
around not disturbing it.

Supported: **Ubuntu 24.04 LTS**, arm64 and x86_64. Other systemd + apt distributions
will probably work, but the installer warns because nothing tests them.

Before you put this on a VM other people can reach, read
[docs/SECURITY.md, host mode on a developer VM](../../docs/SECURITY.md#host-mode-on-a-developer-vm).
Anyone who gets past TripleC's login has a shell as you.

## Install

```bash
git clone https://github.com/MichaelNusair/triplec.git ~/src/triplec
cd ~/src/triplec
deploy/host/install.sh --profile deploy/host/triplec.host.example.json --dry-run   # what it would do
deploy/host/install.sh --profile deploy/host/triplec.host.example.json
```

`--profile` copies a starting config to `~/.config/triplec/config.json`, but only when
no config exists there yet. Edit that file and run `deploy/host/install.sh` again;
every run is idempotent. Run the installer as yourself, not as root. It calls `sudo`
on its own for the few steps that need it.

The password is generated once into `~/.config/triplec/secrets.env` (mode 0600). The
installer never prints it:

```bash
sed -n s/^AUTH_PASSWORD=//p ~/.config/triplec/secrets.env
```

| Command | What it does |
| --- | --- |
| `deploy/host/install.sh [--config F] [--profile F] [--source DIR] [--dry-run]` | Install, or bring an install in line with the config. A second run on an unchanged machine changes nothing and prints `no changes`. Exit 3 means everything was installed but the service is not answering `/healthz`. |
| `deploy/host/upgrade.sh [--config F] [--source DIR] [--no-pull]` | Runs `git pull --ff-only` on the checkout, then the installer. It never makes a shallow fetch, a merge or a rebase. |
| `deploy/host/uninstall.sh [--config F] [--purge]` | Removes what the installer added. Keeps `~/.config/triplec` (and with it the password) unless you pass `--purge`. |

## The config

Every key is optional. An absent key takes the default shown in
[`triplec.host.example.json`](triplec.host.example.json). The installer rejects
unknown keys outright, because a misspelt key that is silently ignored can leave a
listener open that you thought you had closed. Paths are absolute or start with `~/`,
and `~` means the target user's home. `node deploy/host/config.mjs validate FILE`
checks a file without installing anything.

| Key | Default | Meaning |
| --- | --- | --- |
| `mode` | `"host"` | Always `host`. |
| `user`, `home` | the invoking user | Who TripleC runs as. Has to be the user running the installer. |
| `installDir` | `~/.local/share/triplec` | The payload: chat service, scripts, docs, and code-server and whisper if those features are on. |
| `configDir` | `~/.config/triplec` | `config.json`, the rendered `triplec.env` and `projects.json`, and `secrets.env`. |
| `stateDir` | `~/.local/state/triplec` | The pre-install snapshot and the editor's data. |
| `projectsRoot` | `~/projects` | Where the chat looks for projects, used only when `projects` is empty. |
| `claudeHome` | `~/.claude` | Claude Code's state, which the service reads and never moves. |
| `projects[]` | `[]` | An explicit list of `{name, path, slots: {count 1-8, postCreate}}`, for repositories that live in different places. Names match `^[A-Za-z0-9._-]+$` and are unique. |
| `listen.nginxPort` | `8080` | The port nginx listens on, at `127.0.0.1`. This is what a reverse proxy points at. |
| `listen.appPort` | `9997` | The chat service's own port. |
| `listen.bind` | `127.0.0.1` | The chat service's bind address. Anything other than loopback is refused unless `listen.allowPublicBind` is `true`. |
| `features.*` | `push`, `mux`, `admin` on | `editor` (code-server with the Claude extension, behind the chat login), `voice` (local whisper.cpp), `polish` (dictation cleanup, which needs Bedrock), `push`, `mux` (the desktop view and its terminal panes), `admin`, `retire`. |
| `claude.authMode` | `"login"` | `login` (your `claude /login`), `bedrock`, `vertex` (needs `claude.vertex.projectId` and `region`), or `apiKey` (put `ANTHROPIC_API_KEY=` in `secrets.env` yourself). |
| `claude.defaultModel` | `""` | Empty uses Claude Code's own default. |
| `claude.permissionMode` | `"manual"` | `manual` (alias `default`), `acceptEdits`, `auto`, `plan`, `dontAsk`, `bypassPermissions`. |
| `claude.effort` | `"high"` | `low`, `medium`, `high`, `xhigh`, `max`. |
| `claude.loginShellPath` | `true` | Start `claude` with your login shell's `PATH`, so tools from nvm, mise or `~/.local/bin` are found. |
| `auth.mode` | `"password"` | `password`, or `trusted-header` behind a tailnet (see below). `oidc` belongs to the AWS deployment and is refused here. |
| `auth.singleOwner` | `true` | Exactly one identity may sign in. |
| `auth.trustedHeader` | Tailscale's | `header`, `allowedEmails` (exactly one when `singleOwner`), `peerUid` (the uid of the proxy process allowed to send the header, `0` for tailscaled), `allowPassword`. |
| `secrets.backend` | `"file"` | `file` (the generated `secrets.env`), or `env` if something else, such as a systemd drop-in or a vault agent, puts `AUTH_PASSWORD` and `SESSION_SECRET` in the environment. |
| `maxLiveSessions` | `8` | How many `claude` processes may run at once, 1 to 64. |
| `pwa.name` | `""` | What the installed app calls itself, which helps when you have more than one. |

The config holds no secrets, so it is safe to share or commit to a dotfiles
repository. The installer refuses any field that looks like a password, token or
key, and tells you to put it in `secrets.env` instead.

## What it touches, and what it never touches

It writes:

- `installDir`, `configDir` and `stateDir`, all under your home directory.
- `~/.local/bin/cc`, but only while no other `cc` is on your `PATH`. `cc` is also
  the C compiler's name, so the installer steps aside the moment one exists, and
  removes its own copy if a compiler appears later.
- `/etc/systemd/system/triplec-chat.service`, plus `triplec-tmux.service` with `mux`,
  and `triplec-editor.service` and `triplec-broker.service` with `editor`.
- **One** nginx file, `/etc/nginx/conf.d/triplec.conf`. It listens on
  `127.0.0.1:<nginxPort>` and is not a `default_server`. Every variable it defines
  is named `triplec_*`, so it cannot collide with your own maps. Before it reloads
  nginx it runs `nginx -t`, and if that fails it puts the previous file back.
- apt packages, and only the missing ones: `git curl ca-certificates`, `nginx` if
  there is no nginx binary at all, `tmux python3` with `mux`, `build-essential cmake`
  with `voice`, and Node 22 from NodeSource if your login shell has no Node 20 or
  newer. A Node from nvm or mise is used where it is.

It never touches: sudoers, `/etc/ssh`, the firewall, any other nginx file (the
default site and `sites-enabled` included), cloud credentials or gcloud
configuration, `~/.claude`, `~/.claude.json`, or any of your repositories.
Uninstalling leaves the apt packages in place, because something else may need
them.

That promise is checked rather than assumed. On the first run the installer
records `stateDir/pre-install.sha256`, a set of hashes covering `/etc/sudoers.d`,
`/etc/ssh`, `~/.config/gcloud`, every nginx file it does not own, and the firewall
ruleset (with counters and timestamps removed). It never overwrites that file.
`scripts/host-conformance.sh` compares the machine against it.

Services restart only when something they run has changed. The tmux server and
the broker are never restarted for you, because both hold live sessions. If their
unit changes, the installer tells you so.

## Behind an existing HTTPS reverse proxy

If the VM already terminates TLS (a corporate proxy, Caddy, the VM's own nginx), map
a hostname to `http://127.0.0.1:<nginxPort>`. The proxy needs to:

- pass WebSocket upgrades (`Upgrade` and `Connection`), with read timeouts of an hour
  or so, because chats and terminals are long-lived streams;
- set `X-Forwarded-Proto: https`. TripleC's nginx passes it through unchanged, so
  the app knows the browser is on HTTPS even though nginx itself is plain HTTP;
- forward the whole host. TripleC lives at `/chat/` and owns `/`, `/api/`, `/ws` and,
  with the editor on, `/editor/` and `/p/<name>/`. It does not support being mounted
  under a sub-path.

Keep the bind on loopback. The proxy is the only way in.

## Over a tailnet: Tailscale Serve

With `auth.mode: "trusted-header"`, Tailscale identifies the caller and nobody
types a password:

```json
"auth": { "mode": "trusted-header", "singleOwner": true,
          "trustedHeader": { "header": "Tailscale-User-Login", "allowedEmails": ["you@example.com"],
                             "peerUid": 0, "allowPassword": true } }
```

Point Serve **directly at the app port, not at nginx**:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:9997      # listen.appPort
```

The service accepts `Tailscale-User-Login` only on a connection from a process
running as `peerUid`, which is uid 0 (`tailscaled`). A request relayed through nginx
comes from nginx's worker user instead, and TripleC's nginx site also strips all
three `Tailscale-User-*` headers, so nothing that reaches the nginx port can claim an
identity. If you serve the nginx port instead, the password login still works but
the header does nothing. One consequence: the editor's routes live in nginx, so
they are not reachable through a Serve pointed at the app port.

## The editor

`features.editor` installs code-server (pinned, in `installDir/code-server`) on
`127.0.0.1:9999`. Two gates stand in front of it, as on the AWS deployment: nginx
asks the chat service (`auth_request` to `/api/auth-check`) before every editor
request, and code-server has a password of its own, generated once into
`configDir/editor-password` (0600). Its settings and extensions are kept in
`stateDir/code-server`, apart from any code-server you already run. Two things
follow from this:

- The second password is not optional. If your VM's HTTPS proxy maps a hostname
  per port to `127.0.0.1:<port>`, it reaches port 9999 directly, past this nginx
  and its gate. Without the password, anyone who can reach that proxy would have
  an editor (and a terminal) as you.
- The mobile overlay that the AWS deployment injects into the editor is not part of
  host mode.

## Tests

```bash
node deploy/host/config-test.mjs                      # the config rules
DOCKER="sudo docker" deploy/host/test/container-test.sh   # the installer, end to end
```

The container test runs a disposable Ubuntu 24.04 container with systemd as PID 1
and an nginx site that stands in for the VM's own. Inside it, the test installs
twice (the second run must not change a single mtime), upgrades twice and
uninstalls twice, and checks after each step that the pre-existing files are
byte-identical.
