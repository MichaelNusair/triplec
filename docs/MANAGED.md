# The managed service

TripleC is MIT licensed and the whole of it is in this repository. You never have
to buy anything to run it, and nothing here is held back from the version you can
deploy yourself — there is no licence key, no gated feature and no "enterprise"
directory.

This document is about the other option: we run it for you. It exists because the
questions worth asking about a managed service are the uncomfortable ones, and a
landing page is the wrong place to answer them.

## What you get

An instance of exactly what is in this repository, deployed in **our** AWS account,
on a hostname you choose, with a login only you have.

| | Self-hosted | Managed |
| --- | --- | --- |
| Whose AWS account | Yours | Ours |
| Who pays AWS | You (~$75/month idle, plus model usage) | Us |
| Who upgrades it | You: `triplec-update` on the box, by hand or on a timer, and `./deploy.sh` for stack changes | Us |
| TLS, DNS, backups | You | Us |
| Who can reach the box | You | You, and our operators (see below) |
| Cost to you | $0, forever | $0 today — see below |
| The code | This repository | The same commit of this repository |

One instance per customer. Not a tenant in a shared instance, not a namespace —
its own EC2 instance, its own EBS volume, its own load balancer, its own login.
This is not generosity, it is the only honest way to run this particular program:
TripleC's whole function is to execute shell commands, so two customers on one box
would be two customers with each other's shell. There is no version of multi-tenancy
here that is worth building.

## Money, stated plainly

**We are not charging anyone today. There is no card field, no invoice, and no
meter running.**

The button on [triplec.host](https://triplec.host) says "I'm willing to pay by
usage", and that is all it does: it records that you would be willing to, once
there is something to pay. Then you get the service for free. We are paying the AWS
bill in the meantime, which is the real reason this cannot stay free forever, and
the reason we would rather say so now than discover it together later.

When that changes:

- You will be told **before** anything is charged, in advance, with the numbers.
- Nothing will be billed retroactively for the free period.
- If you don't want to pay, you leave, and you take your data with you.
- **Self-hosting stays free regardless**, because it is the same MIT-licensed
  repository. That is not a promise about our future pricing — it is a property of
  the licence, which we cannot take back from a commit that is already published.

Deciding to charge is also the point at which this document changes, and it is in
git, so you can see when it did.

## What we can see, and what we can't

This is the part to read carefully, because the honest answer is not "nothing".

**We are the cloud provider for your instance.** It runs in our account. That means
our account's credentials can, in principle, reach the volume your code is on, read
the instance's disk, and see anything in CloudWatch. Any managed provider who tells
you otherwise about a box in their own account is describing a wish. What we can
offer is what we actually do:

- **We do not log in to run commands on your instance.** Operations are done by
  deploying the same scripts in this repository, not by reading your workspace.
- **Your chat history is not exported anywhere.** Conversations live on your
  instance's volume, in the same files as a self-hosted install. There is no
  central database of customer sessions, because there is no central anything.
- **The app collects no telemetry.** Look for yourself: there is no analytics in
  `chat-service/`. The only PostHog in this repository is on the public marketing
  page, which is a separate CloudFront distribution and knows nothing about
  logged-in users. See [`landing/analytics.js`](../landing/analytics.js).
- **Model calls go to Bedrock**, through the instance role, under Anthropic's and
  AWS's terms — not through any service of ours.
- **We will tell you if we are compelled to hand something over**, unless we are
  legally prohibited from telling you.

**If that residual access is not acceptable to you, self-host.** That is a
completely reasonable conclusion, it is why this project is open source, and it is
not a worse version of the product — it is the same commit, and the deploy is one
script. Nobody at TripleC gets paid less if you do that today.

## The security model is the same one

Read [docs/SECURITY.md](SECURITY.md). All of it applies to a managed instance,
because it is the same program:

- **Anyone who logs in to your instance has a shell on it.** Managed or not.
  Treat the password like the SSH key it effectively is.
- **Claude runs with real permissions by default.** Prompt injection that reaches
  a shell is a genuine risk with no clean fix, and being managed does not change
  that — we are not sandboxing your agent, we are running your box.
- **Authentication is enforced inside the application process**, never in nginx or
  the load balancer alone. That design is the scar tissue from getting it wrong
  once; `docs/SECURITY.md` has the incident.

Two things a managed instance genuinely does improve: it is patched and redeployed
when a fix lands, and its IAM is configured by someone who has read
`infra/lib/stack.js`.

## Leaving

By design, there is nothing to unwind:

1. We hand you a snapshot of `/workspace` — your repositories and your full
   session history, in the same layout a self-hosted install uses.
2. You clone this repository, set `domainName` and `hostedZoneName` in
   `triplec.config.json`, and run `./deploy.sh` in your own account.
3. `./migrate.sh` restores the projects and rewrites the paths in your Claude Code
   history so past conversations stay resumable.

There is no export format to reverse-engineer and no proprietary state, because
the managed service was never a different program. Ask and you get the snapshot;
you do not need a reason.

## Asking for one

Today this is a person doing it by hand, so the signup is a conversation rather
than a form: press the button on [triplec.host](https://triplec.host) and it will
show you how to reach us. Tell us the hostname you want it on, and we will send
back a login.

What we need from you is the hostname and a way to reply. What we do not ask for is
a card, a company, or a reason.
