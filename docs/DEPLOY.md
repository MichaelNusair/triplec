# Deploying

One EC2 instance, one load balancer, one persistent volume, in your own AWS
account. About 20 minutes end to end, most of it waiting for first boot.

> Read [SECURITY.md](SECURITY.md) first. This deploys a web page that runs shell
> commands on a machine you own. That is the point of it, and it is worth
> understanding before it is reachable from the internet.

## Prerequisites

| What | Why | Check |
| --- | --- | --- |
| An AWS account | Everything runs here | `aws sts get-caller-identity` |
| A Route53 hosted zone you control | DNS record + certificate validation | `aws route53 list-hosted-zones` |
| Bedrock model access enabled | Claude runs on Bedrock, not an API key | see below |
| Node 20+ | CDK and the chat service | `node --version` |
| Docker *not* required | | |

**A hosted zone is genuinely required.** The app is served over HTTPS, an ALB
needs a real certificate for that, and a certificate needs a domain you can prove
you own. A subdomain of something you already have is fine —
`claude.yourdomain.com`.

**Enable Bedrock model access** in the region you are deploying to, or the first
message will fail with `AccessDeniedException`:

1. Open the Bedrock console → *Model access*.
2. Request access to the Anthropic models you want. Claude models are usually
   granted immediately.
3. Confirm from the CLI:

   ```bash
   aws bedrock list-foundation-models --region us-east-1 \
     --query "modelSummaries[?contains(modelId,'claude')].modelId" --output text
   ```

## Deploy

```bash
git clone https://github.com/MichaelNusair/triplec.git
cd triplec

cp triplec.config.example.json triplec.config.json
$EDITOR triplec.config.json     # set domainName and hostedZoneName

./deploy.sh
```

That is the whole flow. `deploy.sh` validates the config, runs the
authentication tests, packages the VS Code extensions, deploys the CDK stack,
waits for first boot, ships the application payload over SSM, then verifies that
the live URL requires a login. It prints the URL and password at the end.

It is safe to re-run. Application changes ship without replacing the instance, so
a redeploy takes a couple of minutes and keeps your projects and history.

### First boot takes a while

Ten to fifteen minutes. It installs code-server, Node, the Claude Code CLI and
extension, and compiles `whisper.cpp` from source (there is no arm64 package).
`deploy.sh` waits for all of it. To watch:

```bash
aws ssm start-session --target <InstanceId>
sudo tail -f /var/log/bootstrap.log
```

## Deploying changes afterwards: not from the workspace

The first deploy runs from wherever you are, and that is fine. The thing to know
before the second one is this:

**A full deploy cannot be driven from the instance it deploys to.** Once the app is
up you will be tempted to make changes in the workspace it gives you — that is what
it is for — and then to deploy from that same shell. CloudFormation applies a
UserData change by *stopping* the instance, rewriting the attribute and starting it
again, so everything `deploy.sh` does after `cdk deploy` dies with the box: the SSM
waits, the application payload, the check that the live URL still requires a login,
the summary. The stack goes green and the running app was never updated. `deploy.sh`
detects this and refuses, so you will get a message rather than a mystery — but you
still need somewhere to deploy from.

Two ways forward, and you want both:

**App-only changes ship from the workspace.** Anything under `chat-service/`, `pwa/`,
either extension, or `infra/userdata/bootstrap.sh` is payload rather than
infrastructure:

```bash
./deploy.sh --app-only      # ships app + provisioning script; no AWS changes
```

**Everything else runs on a second machine.** Anything under `infra/lib/` changes AWS
resources and needs a full deploy. Nominate a machine for it — your laptop, CI, or a
small instance kept for the job — and record it in `triplec.config.json`:

```json
"deployFrom": {
  "instanceId": "i-0123456789abcdef0",
  "repoPath": "/home/ec2-user/triplec",
  "user": "ec2-user"
}
```

Then, from anywhere:

```bash
git push origin main
./deploy-remote.sh          # any arguments are passed through to deploy.sh
```

That resets the deploy box's clone to `origin/main`, starts the real `deploy.sh`
there over SSM **detached**, and streams its log back. Because it is detached, the
deploy does not depend on the machine watching it: close your laptop, lose the
network, or let the workspace instance restart in the middle, and it still finishes.
Run `./deploy-remote.sh` again and it re-attaches to the run in progress instead of
starting a second one.

It deploys `origin/main`, not your working tree, so it refuses to start with anything
uncommitted or unpushed — otherwise it would ship something other than what you are
looking at, and say nothing.

What the deploy box needs:

- The SSM agent running (`aws ssm describe-instance-information` should list it), and
  an instance role or credentials that can deploy the stack.
- A clone of this repository at `repoPath`, owned by `user`, with its own
  `triplec.config.json`. That file is gitignored, so copy it across by hand.
- `node` (20 or newer), `npm` and `git`. It runs the full test suite before shipping,
  so it needs to be able to install dependencies.

If you skip all of this, nothing breaks — you simply cannot change infrastructure
from inside the workspace, and `deploy.sh` will tell you so instead of half-applying
a stack.

## More than one deployment

Two workspaces that share nothing — a personal one and a work one, or one per
client — are two stacks in the same account, and the only setting that makes them
distinct is `stackName`. Nothing in `infra/lib/stack.js` names a resource
explicitly, so every VPC, instance, volume, load balancer, certificate and secret
gets a CloudFormation-generated name of its own. Give the second one its own
hostname, its own `stackName`, and leave `landing.domainName` empty and
`security.enabled` false: a landing hostname and a GuardDuty detector are both
singletons, owned by whichever deployment created them.

A deployment is a config file, so a second deployment is a second config file:

```bash
cp triplec.config.json triplec.work.config.json
$EDITOR triplec.work.config.json      # domainName, stackName, deployFrom.repoPath

TRIPLEC_CONFIG=$PWD/triplec.work.config.json ./deploy-remote.sh
TRIPLEC_CONFIG=$PWD/triplec.work.config.json ./deploy.sh --app-only
```

`triplec.*.config.json` is gitignored like `triplec.config.json` itself, and
`TRIPLEC_CONFIG` is read by `infra/config.js`, which every script and the CDK app
load their settings through. `CLAUDE_WEB_CONFIG` still works and means the same
thing — see [the note on the old names](#the-names-before-the-rename) — but where
both are set, `TRIPLEC_CONFIG` wins.

Five things to know, each of which is a mistake someone would otherwise make once:

- **The deploy box needs a second checkout, not a second flag.** `deploy.sh` reads
  `triplec.config.json` from the tree it runs in, and `deploy-remote.sh` resets
  that tree to `origin/main` every time. So clone the repository again at a second
  path, drop the second config in it as `triplec.config.json`, and point
  `deployFrom.repoPath` there. One machine can drive both; run state on it
  (`/var/log/triplec-deploy.<stack>.log` and its `.pid`/`.status` siblings) is
  keyed by stack name, so a deploy of one never overwrites the log or the exit code
  of the other.
- **In `oidc` mode each hostname is a redirect URI the provider has to know.** The
  ALB's callback is `https://<domainName>/oauth2/idpresponse`. One OAuth client can
  serve several deployments, but every one of their hostnames has to be listed on it
  — otherwise the deploy succeeds and the provider refuses the login with
  `redirect_uri_mismatch`, which is a failure that happens at Google rather than on
  your box and so appears nowhere in its logs.
- **Give the second one its own icon, and track it.** Installed on a phone, two
  deployments of this repository are two apps with the same picture and the same
  name. `pwa.iconDir` picks the set that ships — `pwa-icons` by default, or a
  subdirectory of it holding every file `pwa/manifest.webmanifest` names
  (`pwa-icons/README.md` has the sizes and the maskable safe area). Commit the set:
  the config that selects it is gitignored, but a full deploy ships what the deploy
  box checked out from `origin/main`, so an untracked directory there means the
  default icons and a deploy that reports success anyway.
- **And give it a name, which is the half of that the icons cannot do.** `pwa.name`
  — say `"work"` — is what the deployment calls itself, and every title it shows
  then reads `<name>: <project>`: the label under each project's installed icon, the
  browser tab, the editor window. Empty, the default, leaves all of them exactly as
  a single deployment has always had them. Two rules follow from where the value
  travels: it reaches the box in UserData, so changing it needs a full deploy rather
  than `--app-only`, and renaming a deployment never moves a manifest's `id` or
  `scope`, so icons already on a home screen keep working and are not installed
  twice. The name is limited to 24 characters of letters, digits, spaces, dots,
  dashes and underscores, and Android truncates a home-screen label at about 12.
- **Separate stacks are not separate blast radii.** With
  `instanceAdminAccess: true` on either deployment, that box's role is
  AdministratorAccess over the whole account — the other deployment included. If the
  point of the second workspace is containment rather than tidiness, set it to
  `false` there, or use a separate AWS account.

## Configuration

### The names before the rename

This project was called `claude-web` until September 2026. The rename to **TripleC**
changed the name of the config file, the environment variables and the default
stack names — and a config file lives only on the machines that deploy, where no
commit can reach it. So `infra/config.js` loads either name, and every instruction
below works under both:

| New | Still accepted | Notes |
| --- | --- | --- |
| `triplec.config.json` | `claude-web.config.json` | The new name is preferred when both exist. |
| `triplec.*.config.json` | `claude-web.*.config.json` | Both patterns are gitignored. |
| `TRIPLEC_CONFIG` | `CLAUDE_WEB_CONFIG` | Points at a config file by path. |
| `TRIPLEC_DOMAIN`, `TRIPLEC_STACK_NAME`, … | `CLAUDE_WEB_DOMAIN`, … | `TRIPLEC_*` wins where both are set. |
| `TripleCStack`, `TripleCLandingStack`, `TripleCSecurityStack` | `ClaudeWebStack`, … | **Defaults only.** See below. |

**Do not rename an existing deployment's config file expecting nothing to happen.**
`stackName` is the deployment's identity in CloudFormation, and it is read from that
file: if a deploy cannot find its config it falls back to the new defaults, which
name a stack that does not exist yet. That does not fail — it *builds a second
production* beside the first, with its own instance, volume and load balancer. An
existing deployment should keep whatever `stackName` it already has, whichever
filename holds it.

Only `domainName` and `hostedZoneName` are required. Everything else has a
working default — see
[`triplec.config.example.json`](../triplec.config.example.json) for the
annotated version and [`infra/config.js`](../infra/config.js) for the authoritative
defaults and validation.

| Key | Default | Notes |
| --- | --- | --- |
| `domainName` | — | **Required.** `claude.example.com` |
| `hostedZoneName` | — | **Required.** `example.com` — must contain `domainName` |
| `hostedZoneId` | looked up | Set it to skip a Route53 lookup at synth time |
| `certificateArn` | created | Empty creates a DNS-validated certificate |
| `region` | `us-east-1` | Must have Bedrock access enabled |
| `awsProfile` | default chain | Named CLI profile, if you use one |
| `authMode` | `password` | or `oidc` |
| `allowedCidrs` | `["0.0.0.0/0"]` | **Narrow this if you can.** See SECURITY.md |
| `instanceType` | `t4g.large` | 2 vCPU / 8 GiB, Graviton |
| `workspaceVolumeSize` | `100` | GiB, retained on stack deletion |
| `instanceAdminAccess` | `false` | Read SECURITY.md before enabling |
| `defaultModel` | `us.anthropic.claude-opus-5-5` | The CLI, the editor and the chat app. Overridable per chat |
| `permissionMode` | `bypassPermissions` | The main risk/UX tradeoff |
| `gitUserName` / `gitUserEmail` | placeholder | Author on Claude's commits |
| `deployFrom` | none | The machine full deploys run on. See above — set it |

Any key can also be set through the environment — useful in CI, where a config
file is awkward:

```bash
CLAUDE_WEB_DOMAIN=claude.example.com \
CLAUDE_WEB_HOSTED_ZONE=example.com \
./deploy.sh
```

Print what the deployment will actually use:

```bash
npm run config
```

## After the first deploy

### Add your GitHub token

Without it Claude can read repositories you clone by hand but cannot push, open
PRs, or clone anything private. The ARN is in the stack outputs.

```bash
aws secretsmanager put-secret-value \
  --secret-id <GithubSecretArn> \
  --secret-string '{"token":"github_pat_..."}' \
  --region us-east-1
```

A fine-grained token scoped to the repositories you actually want is a much
better idea than a classic `repo`-scoped one — it is a credential living on an
internet-facing box.

No redeploy needed; a credential helper reads it per git invocation.

### Add a project

From the app: **New chat → Add a project**, which creates the directory, an empty
git repository, and optionally a GitHub remote.

By hand:

```bash
aws ssm start-session --target <InstanceId>
sudo -u coder git -C /workspace/projects clone https://github.com/you/repo.git
```

### Bring over local projects and history

```bash
GITHUB_TOKEN="$(gh auth token)" ./migrate.sh
```

Clones every git repository under `~/Documents/code` onto the workspace volume,
then copies your local Claude Code session history up so past conversations are
resumable from your phone. Override the source with `LOCAL_CODE=...`.

The non-obvious part it handles for you: Claude Code keys transcripts by a
mangled **absolute** path and records that path inside each transcript, so
migrating means rewriting both — `-Users-you-Documents-code-X` →
`-workspace-projects-X`, and every embedded `/Users/you/Documents/code/X` →
`/workspace/projects/X`. Skip either and the history is copied but never found.

## Optional: sign in with Google (or any OIDC provider)

Moves authentication to the load balancer, so no unauthenticated request reaches
the instance, and you get a real identity with MFA instead of one shared secret.

**Read this paragraph before you configure anything.** The load balancer's OIDC
action *authenticates*: it proves the caller holds an account with your provider,
and then forwards the request. It does not *authorise*. Pointed at Google with
nothing further, "logged in" means **every Google account in existence**, and
behind that door is a shell on your box. The setting that actually protects the
deployment is `oidc.allowedEmails` — the addresses you personally sign in with.
It is not optional: `./deploy.sh` refuses to synthesise without it, and the chat
service refuses to start without it.

1. Create an OAuth app with your provider. In Google Cloud Console that is
   **APIs & Services → Credentials → Create credentials → OAuth client ID →
   Web application**. Set the authorised redirect URI to
   `https://<domainName>/oauth2/idpresponse` — exactly that path, on the hostname
   in your config.
2. Put the client secret in Secrets Manager:

   ```bash
   aws secretsmanager create-secret --name triplec-oidc \
     --secret-string '<client-secret>' --region us-east-1
   ```

3. Configure it, using the full ARN including the random suffix:

   ```json
   {
     "authMode": "oidc",
     "oidc": {
       "issuer": "https://accounts.google.com",
       "authorizationEndpoint": "https://accounts.google.com/o/oauth2/v2/auth",
       "tokenEndpoint": "https://oauth2.googleapis.com/token",
       "userInfoEndpoint": "https://openidconnect.googleapis.com/v1/userinfo",
       "clientId": "....apps.googleusercontent.com",
       "clientSecretArn": "arn:aws:secretsmanager:us-east-1:123456789012:secret:triplec-oidc-AbCdEf",
       "allowedEmails": ["you@gmail.com"],
       "scope": "openid email"
     }
   }
   ```

4. `./deploy.sh`

### How the two layers divide the work

| Layer | Question it answers | Where |
| --- | --- | --- |
| ALB `authenticate-oidc` | Does this caller have an account with the provider? | `infra/lib/stack.js` |
| `oidcIdentityAllowed` | Is that account **yours**? | `chat-service/auth.js` |

The load balancer keeps unauthenticated traffic off the instance entirely. The
app makes the decision that matters, and it makes it only against claims from a
JWT whose ES256 signature it has verified against the ALB's published key — so
"the load balancer checked it" is only trusted once the header is proven to have
come from the load balancer. Anyone who can reach the instance directly (a
security group is one console click from being wrong) cannot authenticate by
inventing the header.

Three details that are easy to get wrong:

- **`scope` must contain `email`.** The allowlist matches on the email claim. Drop
  the scope and the provider returns no email, so every login is refused — which
  fails safe, and looks exactly like a broken deployment. `config.js` rejects a
  scope without it rather than letting you find out at the login screen.
- **`allowedDomain` is for providers that own a domain** — Google Workspace, or a
  Cognito pool you control. With a public provider, a domain you do not control
  is not a restriction. Matching is anchored at the label boundary, so
  `notexample.com` cannot pass as `example.com`.
- **Unverified addresses are refused.** With some providers `email` is whatever
  the user typed at signup; only `email_verified` makes it a claim the provider
  stands behind.

### Session lifetime, and what to expect when one lapses

The ALB's own session cookie caps at 7 days, shorter than the 30-day cookie
password mode issues. Expect to re-authenticate weekly.

Requests to `/api/*` and `/ws` get a listener rule of their own that answers an
unauthenticated request with **401** instead of the default 302 to the provider.
That is deliberate: `fetch()` would follow a cross-origin redirect to
`accounts.google.com`, which sends no CORS headers for your origin, so the PWA
would see an opaque network error rather than a lapsed session — and a WebSocket
upgrade cannot follow a redirect at all. A 401 is something the client can read
and react to by reloading, which re-runs the login flow properly.

### If you lock yourself out

Nothing here touches SSM. `aws ssm start-session --target <instance-id>` still
works, so a wrong address in `allowedEmails` is recoverable: fix the config and
redeploy, or edit `/etc/claude-auth.env` on the box and
`systemctl restart claude-chat` for an immediate fix.

## Optional: the audit stack (CloudTrail + GuardDuty)

The highest-value thing you can add to this deployment that is not a lock on the
front door. Claude runs shell commands here using the instance role's
credentials, so whatever that role can do, a prompt can do — a documented and
accepted property (see [SECURITY.md](SECURITY.md)). What is not acceptable is not
being able to find out afterwards. Without a trail, the only record of what those
credentials did is CloudTrail's 90-day Event history: not durable, not
integrity-validated, not exportable. The first question after any incident —
*what did it touch?* — has no answer.

```json
{
  "security": {
    "enabled": true,
    "cloudTrail": true,
    "guardDuty": false,
    "logRetentionDays": 365
  }
}
```

```bash
./deploy-security.sh
```

A third stack, and separate for a different reason than the landing site: what it
creates is account-wide, not app infrastructure. Deleting `TripleCStack` must
not delete the record of what that instance did. The trail bucket is `RETAIN`ed
for the same reason — `cdk destroy` leaves the logs behind rather than deleting
the evidence of whatever prompted the teardown.

Safe to run from the workspace itself, unlike `./deploy.sh`: there is no UserData
change here, so CloudFormation never stops the box the deploy is running on.

**`guardDuty` defaults to `false`, and that is not a comment on whether you want
it.** AWS permits exactly one detector per account per region, and CDK cannot
adopt one that already exists, so enabling this in an account that already has a
detector fails the deploy on that resource. Check first:

```bash
aws guardduty list-detectors
```

An empty list means you can turn it on. If it returns an id, detection is already
running — leave the toggle off, you lose nothing. `deploy-security.sh` runs this
check for you and stops with an explanation rather than letting CloudFormation
report it as a logical id.

The same applies more softly to the trail: a second multi-region trail is legal
and works, it just bills twice for the same events. An account inside an AWS
Organization usually has one imposed from the management account already, in
which case set `"cloudTrail": false`.

Costs, so it is not a surprise: management events are free for the first copy in
an account, so the trail is effectively the S3 storage only (cents per month at
this volume). GuardDuty is usage-priced and typically a few dollars a month for a
single small instance.

## Optional: the landing page

The repository includes a static marketing site in [`landing/`](../landing/) — the
page at <https://triplec.host>. You almost certainly don't need this if
you are self-hosting for yourself, but it's here and deployable.

It is a deliberately separate stack: its own hostname, a private S3 bucket behind
CloudFront, and no shared resources with the workspace. The public thing has no
route to the private thing, and deploying either cannot disturb the other.

```json
{
  "landing": {
    "domainName": "claude.example.com",
    "certificateArn": "",
    "analytics": {
      "posthogKey": "",
      "region": "us"
    }
  }
}
```

```bash
./deploy-landing.sh
```

Three things worth knowing:

- **It must be a different hostname from `domainName`.** One DNS record cannot
  point at both CloudFront and a load balancer, and the config refuses the
  overlap rather than letting CloudFormation discover it.
- **The certificate must be in us-east-1**, the only region CloudFront reads them
  from, whatever region the rest of your deployment uses. Leave `certificateArn`
  empty and one is created there; a wildcard already in us-east-1 can be reused.
- **A new CloudFront distribution takes ~15 minutes** to reach every edge, and a
  first-time certificate waits on DNS validation before that. The script polls,
  then tells you if it is still settling rather than failing.

### Analytics for the landing page

Off by default, and off entirely — with no key configured the page loads a script
that returns on its first line, and the distribution has one origin and the
strictest CSP it can have. To turn it on, put a PostHog **project** key in the
config (`Project settings → Project API key`, the public `phc_…` one that is meant
to ship in page JavaScript — not a personal `phx_…` key):

```json
"landing": {
  "analytics": {
    "posthogKey": "phc_...",
    "region": "us"
  }
}
```

```bash
./deploy-landing.sh
```

**It is configured to record as much as PostHog will record.** Session replay,
autocapture of every click and input, heatmaps, dead clicks, rage clicks, web
vitals, console logs, uncaught exceptions, and person profiles for anonymous
visitors so that "unique visitors" and "returning" mean something without anyone
logging in. On top of that, five events the page defines itself:
`command_copied` (which command, and whether the clipboard or the fallback took
it), `outbound_click`, `scroll_depth`, `section_viewed` (a band of the page that
held half the viewport for a second — scrolling past something is not reading it)
and `page_exit` (visible seconds, furthest scroll, which sections were read,
whether the command was copied). No masking: there is no login, no form and no
user-supplied content on that page. If one ever appears, `session_recording` in
`landing/analytics.js` is the thing to change before shipping it.

Four things worth knowing:

- **Session replay also has to be enabled in the PostHog project.** It is a
  server-side toggle (`Project settings → Session replay`) and no client setting
  can turn it on. Everything else here works without it; replays simply will not
  appear.
- **PostHog is proxied through your own domain**, under a short path on the same
  CloudFront distribution — the SDK, the events, the replay snapshots and the
  remote config all come from and go to your hostname. That is not decoration:
  requests to `posthog.com` are on every blocker list, and a blocked request is
  not a degraded visit, it is an invisible one. It also means the page's CSP names
  no third party at all. The path, the CloudFront behaviours and the policy are
  defined once in `infra/landing-analytics.js`, because three things that must
  agree and fail silently when they don't is exactly what that file is for.
- **The key is per-deployment, not committed.** It is public by design, but it
  names *your* PostHog project, and a fork that inherited it would report its
  visitors into your account. So `landing/analytics.js` ships with placeholders
  and `deploy-landing.sh` stamps a staged copy — your working tree is never
  modified, and the deploy refuses to upload a page whose token never got
  written.
- **There is no cookie banner, and this records EU visitors.** A personal project
  page with no login is about as low-stakes as tracking gets, but "we record full
  sessions of everyone" is the honest description of what is switched on, and a
  consent gate is not something this page has. Turning it off is removing the key
  and redeploying.

### If you are moving a hostname between the two

Say the workspace currently owns `claude.example.com` and you want the landing
page there instead. **Move the workspace off it first.** Both stacks manage a
Route53 record, and if you create the landing record while the workspace stack
still owns that name, they will fight over it.

```bash
# 1. Give the workspace a new hostname in triplec.config.json, then:
./deploy.sh              # deletes the old record, creates the new one

# 2. Only now point the landing site at the freed hostname:
./deploy-landing.sh
```

Your projects, session history and volume are unaffected by a hostname change —
nothing is keyed by domain. Two things do change: **an installed PWA points at
the old URL** and must be removed from your home screen and re-added at the new
one, and any bookmark needs updating.

## Optional: voice dictation

Works out of the box with no API key: `whisper.cpp` with `base.en` runs on the
instance and audio never leaves it. Roughly 4 seconds for 11 seconds of speech on
2 vCPUs.

`base.en` is English-only. For other languages, swap `WHISPER_MODEL` to a
multilingual build (`ggml-base.bin`) in `/etc/claude-voice.env`.

To use Azure OpenAI Whisper instead — it falls back to local if Azure errors:

```bash
aws secretsmanager put-secret-value \
  --secret-id <WhisperSecretArn> \
  --secret-string '{"endpoint":"https://YOUR.openai.azure.com","apiKey":"KEY","deployment":"YOUR_DEPLOYMENT"}' \
  --region us-east-1
```

`deployment` is the **deployment name** you chose in Azure, not the model id — a
resource with no deployment returns `DeploymentNotFound` no matter how valid the
key is. `GET /api/voice-status?refresh=1` reports the active backend and re-reads
the secret without a restart.

## Operating it

Most of what you would open a shell for is on the **Box** tab of the chat
(`https://<your-domain>/chat/admin`): every conversation running on every surface,
the state of each service, memory and disk, and a plain-language list of what is
wrong — a forked editor panel, processes the editor started and never used, a tmux
server a deploy is about to kill. It can stop one conversation at a time, and asks
first if that conversation might be mid-turn. It cannot restart a service; that is
below.

It also names the build the box is running — the version, the commit and when it
shipped — and so does **Settings** in the chat, which additionally tells you when the
tab you are looking at was served by an older build than the server has now and
offers a reload. Worth checking before you debug a change you thought you deployed.
From a shell on the box the same answer is in `/opt/claude-web/chat-service/build.json`,
written when the payload was packed.

```bash
# Shell in (no SSH port is open)
aws ssm start-session --target <InstanceId>

# Logs
sudo journalctl -u claude-chat -f
sudo journalctl -u code-server -f
sudo tail -f /var/log/bootstrap.log      # first boot
sudo tail -f /var/log/reprovision.log    # re-provisioning during a redeploy

# Who has been logging in
sudo journalctl -u claude-chat | grep -E 'login|failed login'

# Restart
sudo systemctl restart claude-chat
```

Restarting `claude-chat` ends every conversation open in the chat — they are child
processes of that service. The transcripts are kept and every session can be resumed
from the list, but a turn in flight is lost, so check the Box tab first. The editor
panel's conversations and tmux sessions are owned by their own services and are
unaffected; never restart `claude-broker` or `claude-tmux` to pick up a change unless
you mean to end the work inside them.

### Stop it when idle

```bash
aws ec2 stop-instances --instance-ids <InstanceId>
aws ec2 start-instances --instance-ids <InstanceId>
```

The workspace volume is retained, so projects and history survive. A stopped
instance costs only storage — and has no attack surface.

## Cost

Roughly **$75/month** left running continuously:

| | |
| --- | --- |
| `t4g.large` | ~$49 |
| ALB | ~$16 |
| 100 GiB gp3 workspace | ~$8 |
| 40 GiB gp3 root | ~$3 |

Plus Bedrock token usage, which is billed per request and is usually the part you
actually notice. Stopping the instance when idle removes the compute portion; the
ALB bills whether or not the instance is running.

## Tearing it down

```bash
cd infra && npx cdk destroy
```

The workspace volume, the session secret, and the GitHub and Whisper secrets are
**retained on purpose**, so a teardown does not destroy your work. Delete them by
hand once you are sure:

```bash
aws ec2 delete-volume --volume-id <id>
aws secretsmanager delete-secret --secret-id <arn> --force-delete-without-recovery
```

## Troubleshooting

**`domainName is required`** — no `triplec.config.json`. Copy the example.

**`domainName "x" is not inside hostedZoneName "y"`** — the hostname must be
within the zone. `claude.example.com` needs zone `example.com`.

**Certificate validation hangs** — ACM is waiting for a DNS record in your zone.
It only works if the zone is the one actually serving your domain on the public
internet; check that your registrar's nameservers point at this Route53 zone.

**`AccessDeniedException` on the first message** — Bedrock model access is not
enabled in this region. See Prerequisites.

**`/healthz` returns 503** — targets are unhealthy, usually because first boot is
still running. `sudo tail -f /var/log/bootstrap.log`.

**Editor at `/editor/` misbehaves** — code-server has no officially supported
nginx sub-path configuration, so this path is the least battle-tested part of the
routing. It is served by stripping the `/editor/` prefix while code-server's own
absolute asset URLs are served from the catch-all. If it breaks, the chat is
unaffected; open an issue with what you see.

**Chat loads but stays on "Loading…"** — `app.js` failed to parse or fetch. Open
the browser console, and check `sudo journalctl -u claude-chat` for the client
error the app reports back.

**Stuck on "reconnecting…"** — the session expired but the socket close looks
identical to a dropped network. The client probes `/api/auth-check` and redirects
to `/login`; if it does not, hard-reload.

**Deploy aborts with "THIS ENDPOINT IS OPEN"** — the deployed app served the chat
API without a login. Do not ignore this. Stop the instance, then open an issue —
that is the exact bug this project was built to never ship again.
