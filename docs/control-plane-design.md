# Operator as the control plane — next-phase architecture

**Status:** Proposed. Nothing here is built. Needs the owner's approval before
implementation, and several parts deliberately defer a choice rather than make
one.
**Date:** 2026-08-21
**Supersedes, in scope:** [`ai-workspace-design.md`](ai-workspace-design.md) —
that document proposed the job model and a provider boundary for *one* worker,
and is now largely delivered. It stays as written; this picks up where it ends.
**Relates to:** [ADR 0009](decisions/0009-permitted-abstraction-boundaries.md)
(permitted abstractions), [ADR 0012](decisions/0012-claude-agent-sdk.md) (the
SDK worker), [ADR 0013](decisions/0013-usage-accounting.md) (usage accounting),
[`threat-model.md`](threat-model.md).

## The boundary this document draws

Three phases, kept distinct so a future session can tell them apart:

| | Where it lives | State |
|---|---|---|
| **The old proposal** | `ai-workspace-design.md` | Written 2026-07-30. Jobs, event log, provider boundary, uploads. Delivered |
| **The current architecture** | `CLAUDE.md`, the code | Two workers, capability layer, auto-routing, permission questions. Running |
| **The next phase** | this document | Operator as control plane. Not built |

## Why stop and design

The foundation is now large enough that the next few decisions are structural.
Two workers, a capability layer, routing, permissions, uploads and usage
accounting all exist and interlock. The next additions — a gateway, a local
control model, multi-worker jobs — either fit that shape or quietly bend it,
and bending it is expensive to undo once three features depend on the bend.

This is the point to spend an evening on the control plane rather than three
days later excavating it back out of the codebase.

## The intended shape

```
                USER
                  |
                  v
            OPERATOR  ← the control plane
     local model: planning, routing, delegation
                  |
                  v
              GATEWAY  ← one integration, provider-neutral
                  |
        +---------+---------+
        |         |         |
        v         v         v
      Claude     GPT     Gemini
              (workers)
```

The claim that matters: **external models are workers, not the architecture.**
Operator stays useful when a provider changes price, changes terms, breaks, or
disappears. Today's design already assumes this — `server/providers.mjs` is the
boundary and `jobs.mjs` never names a vendor — so this phase extends an
existing decision rather than introducing one.

## 1. The gateway abstraction — build the seam, defer the product

**Decision: build the abstraction. Do not pick the gateway yet.**

A gateway is one integration instead of N, with unified usage data, model
fallback and pooled rate limits. The usage argument is real and specific:
[ADR 0013](decisions/0013-usage-accounting.md) exists because every provider
reports consumption differently, and a gateway is the natural place to
normalise that — one schema, one place, every call.

### What a gateway costs, stated plainly

**A gateway sees everything.** Today prompts go to Anthropic *or* Google and
neither sees the other's traffic. Behind a gateway, one party sees every
prompt, every attached file, across every provider. `CLAUDE.md`'s founding rule
is that data never leaves hardware the owner controls; that has been bent once,
per-provider, each approved by name. A gateway is not another provider — it is
a party with a complete view, and it needs approving as that.

### The two candidates differ on exactly that point

| | Hosted (e.g. Nexos, OpenRouter) | Self-hosted (e.g. LiteLLM) |
|---|---|---|
| Runs on | their infrastructure | the homelab box |
| Sees your prompts | yes, all of them | only you |
| Operational cost | none | a container to run and update |
| Fits the self-hosted rule | needs a named exception | yes |

A self-hosted proxy gives the same architectural position — one
OpenAI-compatible endpoint in front of Claude, GPT, Gemini and Ollama, with
unified usage — without adding a party. Given Proxmox is already planned, it
is another container.

**Not decided here.** The point of building the seam first is that the choice
can be made when the homelab exists and both can be tried.

### What not to do

**Do not delete the direct provider integrations in anticipation.**
`server/gemini.mjs` is small; `providers.mjs` is the valuable part and survives
either way. A gateway becomes *one more entry* in `WORKERS`, proves itself in
use, and only then do the direct paths retire. Otherwise a gateway outage is an
Operator outage, and the fallback was deleted on purpose.

## 2. The local control model

**Intent:** a local model (Qwen via Ollama, on the homelab) becomes the layer
that understands a request, plans the work, delegates it, and assembles the
result. Cloud models stay specialist workers.

**It does not need to be the strongest model** — it needs to be *present*,
free, unmetered, and under the owner's control. That is the whole argument: a
control plane that stops working when a subscription lapses is not a control
plane.

### It is the only worker that stays running

Stated 2026-08-23: **the local model is the one process that is always up.**
Everything else sleeps until there is work — today that is literally true, and
visibly so: no job running, terminal disarmed, nothing consuming anything.

That is the right shape. Cloud workers are expensive, rate-limited and remote;
they should be woken for a task and then stop. A local model costs nothing to
leave running, so it can be the thing that is *there* — holding context,
noticing, deciding what to delegate. It is the difference between an app that
answers when opened and one that is running the place.

### It arming the terminal is a real change, not a permission tweak

The intent is that the local model may **arm the terminal itself** to delegate
work to other workers. That is coherent — a brain that must wait for a human to
flip a switch before it can delegate is not orchestrating — but it changes
something [ADR 0011](decisions/0011-remote-terminal-for-authorised-devices.md)
deliberately built, and it should change it knowingly.

**Today, arming is a human act.** The terminal starts disarmed on every boot,
and only a device named in `OPERATOR_TERMINAL_DEVICES` can switch it on. That
default is not about restricting *what* runs — the deny list was never
containment, and the ADR says so plainly — it is about there being a moment
where a person decides execution is allowed *now*.

**A model that can arm removes that moment.** Not the authentication, which
stays: only the local model, running on the owner's own machine, would be able
to. But "disarmed by default" stops meaning "off until asked for" and starts
meaning "on whenever the brain judges it useful", which is a different
property, and the one the disarmed default exists to provide.

Ways to keep the intent without losing it entirely, in rough order of cost:

- **Arm for the job, not for the session.** The model arms, delegates, and the
  terminal disarms when that job ends. Execution stays scoped to a task rather
  than to an uptime, and the window is bounded by something other than someone
  remembering.
- **Arm for capability actions, not for the shell.** Most delegation is data
  work, and `server/actions.mjs` already covers that without a terminal at all.
  Reserve arming for genuine shell work, which is rarer than it looks.
- **Say so, visibly.** If the model armed it, the Dev page should show that it
  did, and why. The current UI says *"Armed · tosin-pc"*; it would need to be
  able to say *"Armed by the orchestrator, for job-12"*.

None of that is a blocker. It is the difference between a considered change to
ADR 0011 and a quiet erosion of it, and `threat-model.md` — already flagged for
rewrite — is where the new position has to be written down.

### Its first job is the router, not planning

Full planning and delegation on a small local model is a genuine research
problem. Routing is not: it already exists (`server/routing.mjs`), already
calls a classifier, and that classifier currently runs on the provider that
died at 20 requests a day.

So the first milestone is narrow and honest: **move the existing routing
classifier to a local model.** It removes an external dependency from the
control path, it is measurable against the test set already written, and it
fails safe — the rules carry the common cases with no model at all, which was
proven when the quota ran out.

Planning comes after, once there is evidence of how it handles the easy job.

## 3. Multi-worker jobs — and the rule that has to change

One request should be decomposable into several worker tasks, run where
possible in parallel, then synthesised:

```
    "research this company, analyse competitors,
     write a plan, review the security"
                  |
        +---------+---------+
        |         |         |
     research  analysis  security
      Gemini     GPT      Claude
        |         |         |
        +---------+---------+
                  |
              synthesis
```

**This answers a question that has been open since 2026-08-01** — one job at a
time, or several — and it answers it by making concurrency necessary.

But one-at-a-time exists for a reason: two agents editing the same repository
is a race nobody asked for, and it is why jobs run in a git worktree at all. So
the rule is not dropped, it is **restated**:

> **Concurrent unless they share a workspace.** Read-only and
> capability-layer tasks parallelise freely. Two workers writing to the same
> checkout never do.

That is enforceable from what already exists: a task's declared capabilities
say whether it writes, and `OPERATOR_JOB_CWD` says where.

## 4. Permissions at job level

**The problem:** four workers on one request must not produce four separate
permission questions. The owner approves a request, not a worker's internal
plumbing.

**The intent:** plan the permission envelope for the whole job, approve it
once, and give each worker only the subset it needs.

```
JOB  (approved once)
 ├── Claude   read project · write project · run tests
 ├── GPT      read project
 └── Gemini   read project
```

### Half of this is buildable now, and the halves are different

**Enumerable — build it.** The capability layer is 23 named actions with known
blast radius. A job can declare which it needs, the owner approves that
envelope once, and each worker is scoped to its subset. Nothing has to be
predicted.

**Not enumerable — keep asking.** Open-ended tool use cannot be planned in
advance: the SDK does not announce what a worker will want to `Bash` before it
wants it, and a wrong prediction is worse than a question, because it either
over-grants or blocks work mid-flight. The existing mid-turn question
([ADR 0012](decisions/0012-claude-agent-sdk.md) option C) stays exactly as it
is for that.

Approval tiers, as a starting proposal:

| Tier | Example | Approval |
|---|---|---|
| Read-only | `gym_day`, `missions_list` | automatic |
| Project-scoped writes | edit a file in the worktree, capability writes | automatic when pre-approved |
| External communication | anything leaving the machine | explicit |
| Destructive / infrastructure | deploy, delete, publish | explicit, every time |

The last row already exists as the standing profile's two denials, and should
stay the shape it is: not a question, but a command handed back to the owner.

## 5. Secrets

The current position is already right and worth stating so it is not lost:
**keys live in the server's environment, are read by server code, and are never
given to a worker.** No worker has ever held a credential.

The gap appears when a task legitimately needs one — deploying service X. The
answer then is a **broker**, not an environment dump:

> "This task needs the deployment credential for service X" — one scoped
> credential, for one task, with a lifetime.

Never "here is everything Operator has". Local does not mean unlimited; the
local control model is more trusted than a cloud worker, not unbounded.

**And the rule that produced this section:** a credential that has been exposed
is compromised. Revoke, replace, and keep the replacement out of anything a
worker can read — including Operator's own terminal, which logs every command
by design.

## 5b. A second person, and someone else's hardware

**Stated 2026-08-22: Noel gets access, and Operator moves onto his homelab.**
Both are reasonable and neither is free, because each contradicts an assumption
written down as a reason for not doing other work.

### What each one breaks

**A second person breaks the argument in `threat-model.md`.** That document
lists what real containment would look like — a low-privilege account, a
container, splitting the runner — and then says:

> Each is real work. None is justified while this is one person on a private
> tailnet. All become justified the moment Operator is reachable from the
> public internet, which is the change to watch for.

It named the wrong trigger. Public exposure was the change it anticipated; **a
second human is a different axis it does not cover**, and it arrives first.

**Access is already two levels, and that part works.** Being on the tailnet
gets the app; being additionally named in `OPERATOR_TERMINAL_DEVICES` gets the
terminal, jobs and capability actions. So `noel-iphone` on the tailnet but not
in that list is a real, working split that needs no new code — Operator without
a shell and without AI workers.

**What has no split at all is the data.** There is one `data/operator.json`,
holding the owner's gym history, missions, calendar, shifts and notes, and
`/api/state` serves it to anyone the tailnet admits. The authentication
question was answered; the *whose data* question was never asked, because there
was never a second person to ask it about.

**Someone else's hardware breaks the founding rule.** `CLAUDE.md` opens with
*"Data never leaves hardware the owner controls."* Noel's box is not that. This
is not an argument against moving — a homelab is the right destination and it
unlocks the local model — but it is a change to the sentence the whole project
is justified by, and it should be edited deliberately rather than quietly
falsified.

**And on hardware someone else administers, app permissions stop being the
control.** `data/operator.json` is a plaintext file; whoever runs the machine
can read it, and every hourly backup of it, without appearing in any list.
`OPERATOR_TOKEN` protects the API, not the disk. Any plan that relies on
device authorisation to keep data private *from the person hosting it* is
relying on the wrong layer.

### Three shapes, and the third is underrated

1. **Two instances, one box.** Separate `OPERATOR_DATA`, separate containers.
   He gets Operator; the owner keeps his data. Cleanest, and the containment
   work it needs is work that was becoming justified anyway.
2. **One shared instance.** Legitimate if a shared calendar and mission board
   is genuinely wanted — but then it is a joint system and should be designed
   as one, with per-person identity, from the start rather than retrofitted.
3. **Operator stays put; only the model moves.** Ollama runs on the homelab and
   is reached over the tailnet. **The thing actually wanted from that box is the
   local model, and a model server works perfectly well over a network.** This
   gets the control-plane milestone with no relocation, no multi-user identity
   work, and no change to the founding rule — and it can be done first,
   regardless of which of the other two is chosen later.

### What has to exist before either lands

1. **Identity that is not a device.** Today "who is calling" resolves to a
   tailnet device, which is why access is all-or-nothing. Two people need two
   identities, and that is what the SSO step in the sequence below is actually
   for — it has been listed as infrastructure when it is really the
   prerequisite for this.
2. **Authorisation with more than one level.** At minimum: who may run jobs,
   who may arm the terminal, who may read which data. `OPERATOR_TERMINAL_DEVICES`
   is the shape of the idea already — an environment-only list that the app
   cannot edit — and it needs a per-person equivalent.
3. **The containment work, now justified.** The three options in
   `threat-model.md` stop being optional the moment someone else can reach the
   machine. Running Operator in a container on the homelab does this and the
   relocation in one move, which is the argument for doing them together.
4. **A decision about whose data this is.** Shared calendar and missions, or
   separate instances that happen to share hardware? This is the question that
   determines whether object-level authorization is needed at all, and it is
   the owner's to answer — not something to infer from what is easiest to
   build.

### What it changes elsewhere in this document

- **§6 (homelab sequence)** — SSO moves from "step 6 of the infrastructure" to
  a prerequisite of granting access. The container step likewise stops being an
  optimisation.
- **§7 (the domain)** — the "do you actually need public access" question gets
  a real answer if Noel is remote and not on the tailnet. That is one of the
  two good reasons named there.
- **[ADR 0014](decisions/0014-development-tooling.md)** — its deferral of
  API-security tooling is explicitly conditional on there being one user. That
  condition expires here.
- **`threat-model.md` needs rewriting, not amending.** Its central argument is
  "one person, private network, therefore this trade is fine". When that stops
  being true, the document stops being about the right threats — and it is the
  document a future session reads before touching auth.

## 6. Homelab sequence

Expected next infrastructure phase, on the Dell OptiPlex:

1. Proxmox
2. Networking
3. SSH administration, hardened
4. Operator in an isolated VM or container
5. Local model infrastructure — Ollama + Qwen
6. Authentication / SSO
7. Reverse proxy + HTTPS
8. Gateway, once chosen
9. External providers behind it

**SSH is administration of the box. SSO is identity for people using the
services.** They are not substitutes and neither replaces the other.

Two notes on ordering. Steps 5 and 8 are where this document's milestones
land, and neither needs 6 or 7 to be useful — a local model and a gateway are
both internal. And step 4 is the first time Operator has ever had isolation;
[`threat-model.md`](threat-model.md) currently says plainly that there is no
sandbox and the terminal runs as the owner. That changes here, and the threat
model should be rewritten when it does.

## 7. The domain — parked, and worth re-justifying

`operatorx.cloud` is bought and deliberately not connected. Correct, and the
sequencing reason (proxy and SSO first) is right.

**But the goal deserves questioning, not just the timing.** Tailscale already
provides secure access from every device the owner has, with identity, without
exposing anything. Public HTTPS plus SSO adds real attack surface to a
single-user application holding the owner's entire life — and per the threat
model, one with no sandbox behind it.

Worth answering before any DNS work:

- *"I want to share something with someone"* — good reason.
- *"I need it on a device that can't run Tailscale"* — good reason.
- *"I own a domain and want to use it"* — not worth the exposure.

Intended eventual shape, if it goes ahead:

```
https://operatorx.cloud → HTTPS proxy → SSO → Operator
```

Never a port forward straight to the app. And a `502` from that proxy is an
availability failure, not a security control — the same distinction the Homelab
probe fix landed on, where a green tile meant "something answered the port"
rather than "the app is alive".

## 8. Shared folders as an input surface

Operator already attaches files to jobs (`server/uploads.mjs`). The longer-term
idea is that an authorised shared folder becomes another way in:

```
phone / PC / camera → shared folder → Operator → capability layer → worker
```

Deferred, but one thing to decide before it is built: a watched folder is an
**unauthenticated input surface** — whatever can write to the share can put
work in front of a worker. It needs the same gate as everything else, which
probably means it is a folder only the owner's own devices can write to, and
Operator treats its contents as data rather than instructions.

## The next concrete milestone

Two pieces, both provider-neutral, neither committing to a gateway product:

1. **Move the routing classifier to a local model.** Narrow, measurable
   against the existing routing tests, and it removes an external dependency
   from the control path. Needs Ollama, so it needs the homelab.
2. **Establish the gateway seam.** A worker entry that speaks one
   OpenAI-compatible endpoint, configured by URL — so pointing it at LiteLLM
   on the homelab, or a hosted gateway, is configuration rather than code.

Deliberately excluded from this milestone: picking the gateway, multi-worker
fan-out, the permission envelope, and anything touching the domain. Each is
designed above and each is a separate piece of work.

## What would change this

**A gateway that cannot report usage per provider.** The strongest practical
argument for one is ADR 0013 — unified accounting. A gateway that obscures
which provider served a request removes the reason to adopt it.

**A local model that cannot route reliably.** If Qwen underperforms the rules
already in `routing.mjs`, the control-plane-as-local-model direction needs
rethinking rather than forcing — the rules currently handle every test prompt
with no model at all.

**Public access turning out to be unnecessary.** If Tailscale keeps meeting
every real need, sections 6 and 7 shrink to "run Operator in a container" and
the domain stays parked indefinitely. That is a good outcome, not a failure.
