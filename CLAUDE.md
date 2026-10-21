# CLAUDE.md

See [AGENTS.md](AGENTS.md) — it is the orientation for anyone, human or agent,
working on this repository.

The short version, if you read nothing else:

- **Finish the job: `npm test`, then commit, then `git push origin main`, then
  `./deploy-remote.sh`.** Every time, without being asked. A change that is green on
  this box and nowhere else is not done — it is something the user has to chase you
  for. There is no staging; this box is production. The suite is re-run on the deploy
  box and the deploy refuses to ship if anything fails, so never work around it. This
  applies to anything you find left uncommitted, unpushed, or undeployed, whether you
  built it or not: nothing in this repository is left built-but-not-live. Details in
  [AGENTS.md](AGENTS.md#finishing-is-committed-pushed-and-deployed).
- **Deploys run on the deploy box, never here** — an agreement with the user, and
  `deploy.sh` enforces it by refusing a full deploy on the instance the stack
  manages, which is this one. `./deploy-remote.sh` runs the real deploy there from
  `origin/main`, so push first: unlike `deploy.sh`, it ships what is on the branch
  rather than your working tree, and it refuses to run if anything here is
  uncommitted. `./deploy.sh --app-only` is still right, and still finishes, for a
  change that is only app payload (`chat-service`, `pwa`, the extensions,
  `infra/userdata`). Either way both paths ship more than your diff and more than one
  agent works here at once, so run `git status` first and say what you are shipping.
- **Several sessions share this one checkout, so work in a worktree when the work
  will sit.** The editor, every chat and panel conversation, and any phone are
  separate sessions in this same directory, with one working tree between them —
  and the finishing rule above means another session will commit and deploy
  whatever it finds half-written. If `git status` already shows work that is not
  yours, or your change will be unfinished for more than a few minutes, use
  `EnterWorktree` (and give a writing subagent its own, with
  `isolation: "worktree"`). Symlink `chat-service/node_modules`,
  `infra/node_modules` and the config file in, or the suite cannot run there;
  push with `git push origin HEAD:main` and deploy from this checkout.
  [AGENTS.md](AGENTS.md#more-than-one-session-is-in-this-checkout) has the rest.
- **You have passwordless `sudo` on this box — install whatever you need.**
  `sudo dnf install -y …`, and `npx playwright install chromium` for a headless
  browser, whose system libraries `bootstrap.sh` already installs (`install-deps`
  is apt-only and fails here). Do not route around a missing package or ask the
  user to install it. Anything a *deployment* depends on belongs in the package
  list in `infra/userdata/bootstrap.sh` instead, because an instance replacement
  gives you a fresh root volume and only `/workspace` survives it.
  [AGENTS.md](AGENTS.md#the-box-you-are-on) has the rest.
- This app runs shell commands on behalf of whoever is logged in. An
  authentication gap here is remote code execution. It has happened once already;
  [docs/SECURITY.md](docs/SECURITY.md) explains how.
- Authentication is enforced in `chat-service/auth.js`, inside the application
  process — never in nginx, never in the load balancer alone.
- Run `npm run test:auth` before finishing any change to auth, routing, or the
  stack. `deploy.sh` runs it too and refuses to deploy if it fails.
- Never commit `triplec.config.json` (or `claude-web.config.json`, which
  `infra/config.js` still loads for deployments made before the rename) or
  `infra/cdk.context.json`; all of them carry account-specific details.
