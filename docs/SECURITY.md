# Security

Read this before you expose a deployment to the internet.

## What this software actually is

A web page that runs shell commands on a server you own, as a user that can
read and write every repository on it — and, since 2026-09-21, become root on it
without a password.

That is the product, not a side effect. Claude Code is given a working directory
and permission to act, and the whole point is that you can send it a message
from your phone and it edits code, runs tests and pushes commits without asking
permission for each step. Every security property below follows from that one
fact: **anyone who can reach the chat and pass its login has a shell on the
box.** There is no meaningful sandbox between "authenticated user of this app"
and "arbitrary code execution".

Deploy it accordingly. It is a personal workspace, not a multi-tenant service.

## The threat model

What the design defends against:

- The internet at large finding the URL and using it.
- A stolen session cookie being replayed after the password is rotated.
- Online password guessing.
- A forged session cookie.
- Credentials appearing in logs, git history, or the browser.

What it explicitly does **not** defend against:

- A person who legitimately logs in. They have a shell. There are no per-user
  permissions, no audit trail of who did what (host mode adds one — see *Host
  mode on a developer VM*), and no way to give someone
  read-only access. Do not share the password with anyone you would not give
  SSH access to.
- Prompt injection reaching the shell. If Claude reads a hostile file, issue, or
  web page while running in `bypassPermissions`, the instructions it finds there
  execute with the same privileges you have. This is the sharpest edge in the
  product and it has no clean mitigation — see *Reducing the blast radius*.
- A malicious dependency in a repo on the workspace.
- **Privilege separation on the instance. There is none, deliberately.** The
  workspace user has passwordless `sudo`, because a workspace that cannot
  `dnf install` cannot do the work — a headless browser was the case that forced
  it, since the browser downloads fine and its system libraries do not. Read the
  trade honestly in both directions. It buys nothing back to withhold: `coder`
  owns `/opt/claude-web`, so it already decides what the chat service's unit
  executes on its next restart, and there is no second account here to shield.
  But it does mean the two items above land as **root** rather than as a user,
  and root is where the difference shows up — not in what an attacker can reach
  (they could already run anything as `coder`, read every repo, and use the
  instance profile) but in what they can *keep*: a systemd unit, a package, a
  changed `/etc`, something that survives a restart and outlives the session that
  planted it. Treat a compromised workspace as an instance to replace, not one to
  clean, and keep `/workspace` in mind as the part that gets carried across.

## How authentication works

Enforced in the application process, in
[`chat-service/auth.js`](../chat-service/auth.js), not in the reverse proxy.

This placement is deliberate and comes from a real failure. An earlier version
of this project delegated the decision to nginx, and the nginx config carried a
comment claiming an `auth_request` gate that had never been written. The result:
`/api/*` and `/ws` were reachable from the internet with no credentials at all,
on a box running `--permission-mode bypassPermissions`, while the README stated
that the only unauthenticated path was `/healthz`. Every layer agreed it was
secure except the one actually serving traffic.

So: the process that spawns `claude` is the process that checks the credential.
A proxy misconfiguration can now break the app, but it cannot open it.

Two modes, set by `authMode` in `triplec.config.json`.

### `password` (default)

- A 32-character password is generated into Secrets Manager at deploy time and
  never written to the repository.
- `POST /api/login` verifies it with a constant-time digest comparison and
  returns an HMAC-signed session cookie: `HttpOnly`, `Secure`, `SameSite=Lax`,
  30-day expiry.
- The cookie's signing key is derived from the session secret **and** a hash of
  the current password, so rotating the password immediately invalidates every
  outstanding session. Without that, a leaked password stays useful for as long
  as the attacker's cookie lives.
- Failed attempts are throttled per client IP with exponential backoff (up to 15
  minutes), and nginx separately rate-limits the login to 12 requests/minute at
  the edge. That limit is keyed on the **request path**, not on the nginx location
  it was written next to, and the two are not the same thing: `/chat/` strips its
  prefix, so `/chat/api/login` reaches the same handler, and for a while it reached
  it through a location with no limit — 20 rapid guesses got through where
  `/api/login` stopped at 6. Both spellings now share one counter, so alternating
  between them does not double the budget. `$uri` is the key rather than
  `$request_uri` because it is decoded and normalised, which is what makes
  `/chat/api/%6Cogin`, `/chat//api/login` and `/chat/../api/login` count too.
  `manifest-test.js` derives the set of prefixes that strip from the config and
  fails if any of their login paths is missing from the map, so a second `/chat/`
  added later cannot reintroduce the hole.
- The server **refuses to start** if the password or session secret is missing or
  under 16 characters. A misconfigured deployment is a dead one, never an open
  one.

### `oidc`

Authentication moves to the load balancer, so no unauthenticated request reaches
the instance at all. The app still verifies the `x-amzn-oidc-data` JWT's ES256
signature against the ALB's published key, because "the load balancer checked
it" is only true if the header actually came from the load balancer — and *only
the ALB can reach the instance* is a security group rule, one console click from
being false.

**Authentication is not authorization, and here the difference is the whole
thing.** An ALB `authenticate-oidc` action proves the caller holds an account with
the provider. It does not prove they are *you*. Pointed at Google with nothing
further, "logged in" means every Google account in existence — and this service
hands whoever gets in a shell. So oidc mode carries a second, separate check:

- `oidc.allowedEmails` (and/or `oidc.allowedDomain`) names the identities that are
  yours. It is **mandatory**: `infra/config.js` fails the synth without it, and
  `assertAuthConfig()` kills the process at boot without it, so there is no
  configuration in which the provider's whole user base gets in.
- The allowlist is matched only against claims from a JWT whose signature has
  already been verified. Reading an identity out of an unverified token would be
  worse than not checking at all, because then the attacker writes the claims.
- `email_verified` must be true. With some providers `email` is whatever the user
  typed at signup, which would make the list a formality.
- Matching is case-insensitive and anchored at the domain label boundary, so
  `notexample.com` cannot pass as `example.com` and `you@example.com.evil.test`
  cannot pass as `you@example.com`.
- `oidc.scope` must contain `email`, or there is no claim to match and every login
  is refused. The synth rejects a scope without it rather than letting you
  discover that at the login screen.

`/api/*` and `/ws` get their own listener rule that answers an unauthenticated
request with 401 rather than redirecting to the provider — a cross-origin 302 is
an opaque CORS failure to `fetch()` and is un-followable by a WebSocket upgrade,
so the client could not tell a lapsed session from a broken deployment.

One trade to know about: the ALB's session cookie caps at 7 days, where password
mode issues 30. You re-authenticate weekly.

Requires an OAuth app with your provider. See [DEPLOY.md](DEPLOY.md).

### `trusted-header` (host mode, over a tailnet)

For a host install reached from a phone through Tailscale Serve. Serve proxies a
tailnet user's request to the chat service on loopback and adds a
`Tailscale-User-Login` header naming them; the service accepts that identity only
if all of these hold, checked in `trustedIdentity()` in `chat-service/auth.js`:

1. the peer is a loopback address;
2. **the socket on the other end belongs to the configured uid** — `0`, which is
   `tailscaled`'s — read from the kernel's own socket table (`/proc/net/tcp`),
   which the caller cannot write;
3. the login is on `CW_TRUSTED_EMAILS`, which has exactly one entry when
   `CW_SINGLE_OWNER` is set (the host profile's default).

The second check is the one that matters on a developer VM, and the reason this
mode is not "trust the header from 127.0.0.1". Such a VM often runs its own HTTPS
proxy that maps one hostname per port to `127.0.0.1:<port>` and forwards whatever
headers the caller sent — so every loopback port is reachable from that proxy's
network, and a header that arrives from loopback proves nothing about who wrote
it. Requests through that proxy come from nginx worker sockets (not root) and are
refused; TripleC's own nginx site also blanks the three `Tailscale-User-*` headers.
Point Serve **at the app port**, not at nginx, or the socket the service sees is
nginx's and the header is (correctly) ignored.

`CW_TRUSTED_ALLOW_PASSWORD=1` keeps the password login available beside it, for
the path through the VM's proxy from a laptop. Every acceptance and every refusal
is written to the audit log (see below).

## What is gated

Everything except an explicit allowlist. `isOpenPath()` in `auth.js` lists the
only paths served without a session:

| Path | Why it is open |
| --- | --- |
| `/healthz` | ALB health check. Returns a constant; touches nothing. |
| `/login`, `/login.html` | The login page itself. Self-contained, inline CSS. |
| `/api/login` | Verifies the password. Rate-limited, on every path that reaches it. |
| `/api/auth-mode` | Says whether to show a password form. Reveals no secret. |

The allowlist direction matters: a new route added to `server.js` is gated
unless someone deliberately opens it. The reverse — a denylist — is how the
original bug happened.

Two WebSockets exist, and both are authenticated in the same `upgrade` handler,
before the handshake completes: `/ws`, the chat, which can start a `claude`; and
`/ws/term`, the mux's terminal panes, which is a pseudo-terminal running `cc` —
a shell, in plain terms, for whoever holds one. Any other path under `/ws` is
dropped. The terminal takes a project name and a slot number and nothing else: the
name goes through the same validation as every project route, the slot is an
integer, and both reach `cc` as argv, never through a shell string.
`auth-test.js` asserts the unauthenticated upgrade is a 401, and `term-test.js` that a
path-shaped name or an out-of-range slot is refused before anything is spawned.

The editor at `/editor/` is gated by code-server's own password, enforced by
code-server itself, so it does not depend on the proxy being right. In `oidc`
mode that is not sufficient on its own and the editor carries a second gate —
see below.

### The editor is a second surface, and it needs the allowlist too

A password proves someone knows a shared secret. It does not say **which
identity** knows it. That distinction does not matter in `password` mode, where
one secret is the whole authentication story for both surfaces. In `oidc` mode it
is the entire point: the load balancer admits any account the provider will
authenticate, and the thing that narrows "any Google account" down to yours is
`oidc.allowedEmails`, checked in `auth.js`. So any route that never reaches
`auth.js` never gets that check.

**This was a live hole, found on 2026-09-19 by signing in with an address that
was not on the allowlist and landing in the editor.** `/editor/`, `/p/<name>/`
and the catch-all `location /` proxied straight to code-server. The ALB let any
Google account through the front door; code-server asked for its password; and
that was the whole of it. Any Google account plus that one password was a full
IDE with a terminal on this box, held by an identity the allowlist had never
heard of. The chat was never exposed — every chat request goes through
`auth.js`. The editor simply never went through `auth.js` at all.

The fix does not move the decision into nginx. In `oidc` mode those three
locations carry `auth_request /__identity`, an `internal` location that proxies
to the chat service's `/api/auth-check`; `auth.js` verifies the signed
`x-amzn-oidc-data` header and matches the allowlist exactly as it does for the
chat, and answers 204 or 401. nginx forwards the answer, it does not form one.
code-server's password still applies behind it, so this adds a door rather than
replacing one. The gate is empty in `password` mode, where a second door would
only lock out someone who uses the editor and never opens the chat.

The lesson is narrower than "check the editor": **the question is never whether
`auth.js` is correct, it is which routes reach `auth.js`.** The correctness of
the allowlist had been verified. Its coverage had not. So the check in
[`chat-service/manifest-test.js`](../chat-service/manifest-test.js) is written
over *every* nginx location that proxies to code-server, discovered from the
config rather than listed, and fails for a route added later — because the bug
was a route nobody thought to add to a list.

### Verified, not asserted

[`chat-service/auth-test.js`](../chat-service/auth-test.js) boots the real server
and asserts that every API route, every static asset and the WebSocket upgrade
refuse an unauthenticated caller; that forged, tampered and expired cookies are
rejected; and that the server dies rather than starting without credentials.

In `oidc` mode it additionally asserts that the server refuses to start with no
allowlist configured, that a forged `x-amzn-oidc-data` header is rejected
(unsigned, symmetric-alg, and a structurally valid ES256 token carrying an
allowlisted address but an invented signature), that a local password is not a
second door past the provider, and — case by case, without a network — that the
identity allowlist accepts exactly the addresses it should and refuses
lookalikes, prefixes, subdomain tricks and unverified addresses.

[`chat-service/manifest-test.js`](../chat-service/manifest-test.js) covers the
other half, the one that was missing: it parses the nginx config out of
`bootstrap.sh` and asserts that every location reaching code-server carries the
identity gate, that the gate is `internal` and asks `auth.js`, that it is
conditional on `oidc` mode, and that `/healthz` stays outside it — a gated health
check would fail the ALB's own target and take the site down for everyone,
including you.

`deploy.sh` runs it *before* deploying and refuses to proceed if it fails, then
curls the live URL afterwards and aborts if the deployed app answers
`/api/projects` without a login. The claim in this document is checked by
machine on every deploy, because the last time it was only checked by a comment
it was wrong for months.

Run it yourself:

```bash
npm run test:auth
```

## Infrastructure

- **No SSH ingress.** Shell access is via SSM Session Manager: no open port, and
  IAM-controlled and audited.
- **TLS terminates at the ALB**, with a DNS-validated ACM certificate created by
  the stack. Port 80 permanently redirects to 443.
- **The instance is not publicly reachable.** Its security group accepts traffic
  only from the load balancer's security group, on one port.
- **Least-privilege instance role by default.** `instanceAdminAccess` is `false`,
  granting only Bedrock model invocation, read on its own four secrets, and
  attach/describe on its own volume. See below before turning it on.
- **Secrets live in Secrets Manager**, read at request time by the service
  account. `/etc/claude-auth.env` is mode `600` and owned by `coder`.
- **The GitHub token is never written to disk.** A git credential helper fetches
  it from Secrets Manager per invocation, so rotating it needs no redeploy and
  nothing on the box can read it out of a file.
- **Bootstrap logging disables shell tracing around secrets** so they do not land
  in `/var/log/bootstrap.log`.

## Reducing the blast radius

In rough order of value for effort:

1. **Restrict `allowedCidrs`.** The single highest-value change available. If you
   only ever use this from home, an office, or a VPN, setting
   `["203.0.113.4/32"]` removes the login page from public reach entirely.
   Nothing can guess a password it cannot connect to.
2. **Leave `instanceAdminAccess: false`.** With it on, anything that executes in
   the workspace reaches your whole AWS account through instance metadata — and
   Claude executes things. That turns one leaked password, or one successful
   prompt injection, into account takeover. Turn it on only if you specifically
   want the workspace to deploy AWS infrastructure, and then use a dedicated
   account with nothing else in it.
3. **Use a dedicated AWS account.** Cheap, and it bounds everything above.
4. **Consider `permissionMode: "acceptEdits"`.** Claude still edits files freely
   but asks before running commands. It costs you the hands-off experience and
   buys a checkpoint in front of the dangerous half.
5. **Use `authMode: "oidc"`** if you want a real identity and MFA rather than one
   shared password — and set `oidc.allowedEmails` when you do. Without it the
   load balancer authorises your provider's entire user base; with Google, the
   internet. The deployment refuses to run in that state, but the reason to
   configure it is that it is the check doing the work, not that a validator
   nagged you.
6. **Stop the instance when you are not using it.** The workspace volume is
   retained, so nothing is lost, and a stopped instance has no attack surface.
7. **Give the GitHub token the narrowest scope that works.** It can push to
   whatever you grant it. A fine-grained token limited to specific repositories
   beats a classic `repo`-scoped one.

## Knowing the blast radius

Separate from reducing it, and not a substitute for it. Everything above bounds
what a compromise *can* reach; this bounds how long you would spend guessing.

By default an AWS account has no CloudTrail trail. The console shows 90 days of
Event history, which is not durable, not integrity-validated and not exportable —
so after an incident involving the instance role, the question *which API calls
did those credentials make* has no answer you can rely on. That is the one gap
that cannot be closed retroactively: you cannot decide to have been logging.

```json
{
  "security": { "enabled": true, "cloudTrail": true, "guardDuty": false }
}
```

```bash
./deploy-security.sh
```

A multi-region trail with log file validation, into a private encrypted bucket
that is `RETAIN`ed on stack deletion — `cdk destroy` must not delete the evidence
of whatever prompted the teardown. `guardDuty` adds detection of credentials being
used from somewhere they should not be; it defaults to off only because AWS allows
one detector per account per region and enabling a second fails the deploy. See
[DEPLOY.md](DEPLOY.md#optional-the-audit-stack-cloudtrail--guardduty).

Two more worth enabling from the console if you are serious about this, neither of
which this repository manages for you:

- **ALB access logs**, which are the only record of requests that the application
  never saw — including ones it rejected.
- **An account-level S3 public access block**, which makes "a bucket was
  accidentally made public" unreachable as a class rather than per bucket.

## Rotating credentials

Rotate the login password (this signs every device out, because the cookie
signing key is derived from it):

```bash
aws secretsmanager put-secret-value --secret-id <PasswordSecretArn> \
  --secret-string "$(openssl rand -base64 24)" --region us-east-1
./deploy.sh --app-only   # re-reads the secret onto the instance
```

`--app-only` because nothing about the stack changes here — and because it is the
form that works from inside the workspace, which is where you are most likely to be
when you decide to rotate a password. See [DEPLOY.md](DEPLOY.md) on why a full
deploy is not run from there.

Sign every device out without changing the password — rotate the cookie key:

```bash
aws secretsmanager put-secret-value --secret-id <SessionSecretArn> \
  --secret-string "$(openssl rand -base64 48)" --region us-east-1
./deploy.sh --app-only
```

Both ARNs are in the stack outputs (`dist/outputs.json` after a deploy).

## If you think you have been compromised

The instance holds a GitHub token and, depending on configuration, credentials
reaching your AWS account. Treat it as a credential incident, not just a host
incident.

```bash
# 1. Cut off access immediately.
aws ec2 stop-instances --instance-ids <InstanceId> --region us-east-1

# 2. Revoke the GitHub token at https://github.com/settings/tokens

# 3. Rotate the login password and session secret (above).

# 4. Read the access log before you rebuild it.
aws ssm start-session --target <InstanceId>
sudo journalctl -u claude-chat | grep -E 'login|failed login'

# 5. Find out what the instance role did, if you have a trail (see above).
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=Username,AttributeValue=<instance-id> \
  --start-time 2026-01-01 --max-results 50 --region us-east-1
```

Successful and failed logins are logged with their source IP, and never with the
attempted password.

Step 5 is the one that needs to have been set up in advance. Calls made with the
instance role appear under the instance id as the username, which is what makes
that query the answer to "what did it touch". Without a trail you get 90 days of
Event history at best and nothing you can attest to.

The workspace volume survives instance termination, so you can replace the
instance without losing work — but if you believe code on the volume was
modified, diff it against your remotes before trusting it.

## Host mode on a developer VM

Everything above is about the AWS deployment, where TripleC owns the instance. In
host mode (`deploy/host/install.sh`, see [HOST.md](HOST.md)) it is installed onto
a machine that already belongs to a developer, as that developer, and it inherits
everything that machine can do. That changes the blast radius more than any
setting here can.

**A compromised session is the developer, on that VM, with that VM's network.**
Anyone past the login — or any prompt injection a session runs into — acts with
the developer's own credentials (`claude /login`, `gh`, SSH keys, cloud CLIs
already logged in) and the VM's own network routes. If the VM is peered into
networks that reach staging or **production databases**, and its service account
holds a database-client role there, then a browser-reachable shell on that VM is
a browser-reachable path to those databases. Nothing in TripleC narrows that: it
creates no credentials and changes no IAM, but it does not take any away either.

What host mode does about it, by default:

- **Asks before acting.** The host profile defaults to `manual` (or
  `acceptEdits`), not `bypassPermissions`. Every tool call the CLI wants approval
  for is relayed to the chat as an approve/deny card, shown on every device
  attached, and the decision is audited. Hooks still run in every mode, so a
  repository's own write gates keep working in TripleC sessions exactly as they
  do over SSH.
- **Loopback only.** The service refuses to bind anything else unless
  `allowPublicBind` is set. TLS is the VM proxy's or Tailscale's.
- **One owner.** `singleOwner` requires exactly one identity in
  `trusted-header` (and `oidc`) mode; password mode is one secret by definition.
- **An audit trail.** Sign-in successes and failures, session start and stop
  with the permission mode used, and every permission request and decision, as
  `{"audit":"triplec",…}` JSON lines on stdout — so in the journal under
  `triplec-chat`, and in whatever ships the journal off the box. No secret value
  is ever written; field names that look like one are redacted regardless.
- **No credential or IAM footprint.** The installer uses sudo only for packages,
  its systemd units and its one nginx site file. It never writes sudoers, SSH
  config, cloud CLI config, firewall rules, peering or IAM, and it records a
  checksum snapshot of those before its first run so the conformance script can
  prove it.
- **Fewer surfaces.** Features are flags; an off feature has no routes. A
  cautious profile turns off the editor (a second shell surface), retire (the
  only route that deletes a directory) and the dictation clean-up.

What it does not do, and what to decide before installing it on a machine with
production reach:

- It cannot tell a legitimate approval from a careless one. Approving a command
  on a phone is still approving it.
- It does not sandbox the CLI from the VM's network. If a VM can reach a
  production database, a session can. The strongest mitigation is not to give a
  pilot VM that reach — run it without the production peering and without the
  production database-client grant — and that is a decision for whoever owns the
  network, not a setting here.
- `bypassPermissions` remains available per chat. The audit log records which
  mode every session used.

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue:
open a [GitHub security advisory](https://github.com/MichaelNusair/triplec/security/advisories/new).

Include what you can reach, what you can do with it, and how you got there.
Findings that let an unauthenticated caller reach the chat API, or that let one
authenticated session forge another, are the most valuable — those are the
boundaries this design actually claims to hold.
