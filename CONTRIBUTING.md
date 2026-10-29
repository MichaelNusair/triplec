# Contributing

Thanks for looking. This is a small, opinionated project — one instance, one
person's workspace — so the useful contributions tend to be sharp and specific
rather than large.

## Before you start

Read [AGENTS.md](AGENTS.md) for the repo map and the gotchas, and
[docs/SECURITY.md](docs/SECURITY.md) for why the code is shaped the way it is.
Both are short and will save you time.

## The one hard rule

**This application executes shell commands on behalf of whoever is logged in.** An
authentication gap is a remote code execution vulnerability. A pull request that
weakens the gate will not be merged, however convenient it makes development.

Concretely:

- Authentication stays enforced in the application process
  (`chat-service/auth.js`). Not in nginx, not in the load balancer alone. A proxy
  config is allowed to break the app; it is not allowed to open it.
- `isOpenPath()` is an allowlist. Keep it one.
- No development bypasses that could reach production. `CW_INSECURE_COOKIES=1`
  exists for localhost and only drops the `Secure` cookie flag — that is the
  furthest this goes.
- If you add a route to `server.js`, add it to the `guarded` list in
  `auth-test.js`.

## Running the checks

```bash
npm test                                  # every suite deploy.sh gates on
cd infra && npx cdk synth --quiet         # stack compiles
bash -n deploy.sh migrate.sh scripts/cc-session.sh infra/userdata/bootstrap.sh
```

`npm run test:auth` boots the real server and speaks HTTP and WebSocket to it. It
should report 112/112 or better — never fewer checks than it did before your change.
The suites need `git`, `bash` and `python3`, and nothing else from the machine: the
terminal tests fake `tmux` and `cc`, and the auth tests start their servers from an
environment scrubbed of the deployment's own credentials, so running them from
inside a chat session on the box gives the same answer as on a laptop.

There is no staging environment and `nginx -t` can't run locally unless you have
nginx installed. So in your PR, say what you actually verified. "Synthesizes and
passes the auth tests; not deployed" is genuinely useful. "Works" is not, unless
you deployed it and watched it work.

## Style

Match the surrounding code. A few conventions that are load-bearing here:

- Plain JavaScript, ES modules, no build step and no TypeScript — including in the
  CDK app. The client is dependency-free because it has to boot fast on a phone.
- Comments explain **why**, especially when the code looks wrong. Much of this
  codebase is shaped by non-obvious constraints — code-server's layout engine, iOS
  suspending WebSockets, EC2's userdata size cap, CloudFormation's volume
  attachment ordering. If you worked something out the hard way, write it down so
  the next person doesn't have to.
- Don't delete a comment that explains a constraint without checking the
  constraint is gone.

## Good contributions

- Bug fixes with a reproduction.
- Hardening, especially anything that makes a misconfiguration fail closed.
- Making the first deploy work for more people — other DNS setups, other regions,
  clearer errors. The failure modes a stranger hits are hard for a maintainer to
  see.
- Documentation fixes. If something misled you, that's a real bug; this project
  has already been bitten badly by a doc that disagreed with the code.

## Please open an issue first for

- New surfaces or major features.
- Anything that changes the routing or the authentication model.
- Dependencies. The chat client has none deliberately.

## Reporting a vulnerability

Please don't open a public issue. Use a
[GitHub security advisory](https://github.com/MichaelNusair/triplec/security/advisories/new)
instead. See [docs/SECURITY.md](docs/SECURITY.md).
