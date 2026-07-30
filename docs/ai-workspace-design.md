# AI Workspace — proposed structure

**Status:** Proposed, not built. Needs the owner's approval before implementation.
**Date:** 2026-07-30
**Relates to:** [ADR 0009](decisions/0009-permitted-abstraction-boundaries.md)
(permitted abstractions), [ADR 0011](decisions/0011-remote-terminal-for-authorised-devices.md)
(terminal and chat gating), and the owner's queue items *Embedded Claude
Workspace*, *AI Provider Manager*, *AI Role Hierarchy*, *Work Queue Framework*.

## Why this document exists

The chat shipped today works, and cannot do real work. Four things stop it:

| # | Limitation | Where it bites |
|---|---|---|
| 1 | 10-minute cap on a turn | Any real build is killed mid-flight |
| 2 | Permission stops, one command at a time | Constant interruption; babysitting, not working |
| 3 | No visibility while it runs | Ten minutes of "Claude is working…" |
| 4 | It cannot safely change its own backend | `server/*.mjs` needs a restart the phone can't do |

**These are not four bugs.** They are four symptoms of one shape: a chat turn is
an HTTP request that spawns a process, waits, and returns. Everything above
follows from that, and no amount of patching removes them — a longer timeout is
still a timeout, and a wildcard permission rule is still a permission stop with
a wider net.

The owner's requirement is explicit: *"this structure will support future models,
can't have limitations."* So the shape has to change once, deliberately, rather
than accumulate workarounds.

## The one structural change

**Model work as a job, not a request.**

Today: `POST /api/chat/send` → spawn → await → reply. The HTTP request *is* the
unit of work, so the work inherits every property of an HTTP request: a timeout,
one response, no mid-flight interaction.

Proposed: a **job** is a first-class object that outlives any request. The client
creates one, then observes it. Nothing about how long it runs, how much it emits,
or how often it needs input is tied to a request lifetime.

```
POST /api/jobs        { provider, model, prompt, resources[] }  → { jobId }
GET  /api/jobs/:id?since=N                                      → events since N
POST /api/jobs/:id/input   { type: "message" | "permission" | "cancel", … }
```

Everything below falls out of that.

### 1. No timeout (fixes ①)

A job has no request to expire. It runs until it finishes, fails, or is
cancelled. Limits become *policy* — a wall-clock budget, a token budget, an
idle timeout — set per job and enforced by the runner, not accidentally imposed
by HTTP.

The owner's **Work Queue Framework** queue item already describes this: *Pending,
Running, Review, Complete, Failed*. That is this object. Building the job model
here is building that item, not a detour around it.

### 2. Permissions answered in-turn (fixes ②)

`claude -p` is one-shot, so a permission request ends the turn — which is why the
current chat can only report a denial and offer to write a rule for next time.

`--input-format stream-json` keeps the process open and makes the channel
two-way. When Claude wants a tool it isn't allowed to use, the job moves to
`awaiting_input` and emits a `permission_request` event. The phone answers; the
answer goes to the process's stdin; **the same turn continues**. No re-asking, no
lost context.

Two things layer on top:

- **Permission profiles.** Named bundles granted per job — "read anything",
  "edit under `src/`", "run builds" — rather than one exact rule at a time.
  Exact rules stay the default for one-offs; a profile is how you say "this is a
  coding session" once instead of forty times.
- **Escalation stays interactive.** Anything outside the job's profile still
  stops and asks. The profile widens the quiet path; it does not remove the gate.

### 3. Events, not a final answer (fixes ③)

The runner emits a typed event stream as it works:

| Event | Carries |
|---|---|
| `text` | A chunk of the reply |
| `tool_use` | Which tool, with what arguments |
| `tool_result` | What came back, truncated |
| `permission_request` | What it wants, and the rule that would allow it |
| `status` | running / awaiting_input / complete / failed |
| `usage` | Tokens and equivalent cost so far |

The client appends by offset — the same polling that already works on the owner's
iPhone, where stream readers deliver nothing. **Polling stays**: it is proven on
the target device, and the job's event log means a locked phone catches up rather
than missing the gap.

This is also what makes a long job tolerable. Watching it read three files and
run a build is information; a spinner is not.

### 4. The runner is a separate process (fixes ④)

Today the agent is spawned *by* the storage server. So the agent cannot restart
the storage server — it would be killing its own parent — and a bad edit to
`server/*.mjs` leaves no way to recover from a phone.

Split them:

```
  operator-server   (API + store + static)      ← can be restarted
  operator-runner   (agent jobs, tool exec)     ← survives that restart
```

The runner owns jobs and talks to the server over the same authenticated `/api`.
Consequences worth having:

- The agent **can** restart the API server, because it is not inside it. That is
  what makes "work on Operator from Operator" actually possible.
- A crash in agent-land does not take down the data layer.
- The runner can later live on a different machine (the EPYC box) from the UI
  without changing the model.

This is the piece that turns Operator into the development environment rather
than a viewer of one.

## Staying provider-agnostic

The owner's stated end state is *one chat page that picks the model per task*. The
job model gives that almost for free, provided one rule holds:

> **The event vocabulary is the contract, not the provider's API.**

A provider implements four things:

```
start(job)            → begins work, emits events
send(jobId, input)    → a message, a permission answer, a cancellation
cancel(jobId)
capabilities()        → { tools, attachments, permissions, streaming }
```

and emits only the events in the table above. The UI never learns which provider
it is talking to. Claude Code (CLI, subscription) is the first. An API-backed
provider — Anthropic Messages, or another vendor — is a second implementation of
the same four methods, not a second code path through the UI.

`capabilities()` is what stops this becoming a lie: a provider without tool access
declares it, and the UI hides tool affordances rather than showing controls that
silently do nothing.

**Per ADR 0009 this is a permitted abstraction** — it isolates a genuinely
swappable external dependency, has one implementation today, and exposes only the
operations Operator performs. It becomes a violation the moment a second provider
is written speculatively, or the interface grows to cover a provider feature
nothing uses.

### Where role-based routing fits

*AI Role Hierarchy* (the owner's item: Claude for engineering, GPT for general,
etc.) is **a policy on top of this**, not part of it. A role maps a task type to
a provider + model + permission profile. It is a lookup table over an interface
that already exists — worth building only after two providers make it non-trivial.
Building routing first would be inventing the abstraction before the thing it
abstracts.

## Attachments

Files and images ride the job, not a separate mechanism: a job carries
`resources[]`, uploaded before it starts and referenced by path in the prompt.
Claude Code takes files by path, so this is a write-to-disk-then-mention, not an
upload protocol.

Constraints worth fixing now: a gitignored directory outside the store (JSON is
the wrong home for binaries), a per-file size cap, and a sweep when the
conversation resets. A provider that cannot take file input declares it via
`capabilities()` and the UI hides the control.

## What this costs

Being honest about the bill:

- **A second process to supervise.** Start, restart, health. More operational
  surface than one server, and it must not become a thing that silently isn't
  running.
- **Jobs need somewhere to live.** In memory is simplest and loses history on
  restart; persisting them means a new storage slice and a retention rule. Start
  in memory, persist only if the loss actually stings.
- **A longer-lived agent is a bigger security surface** than a one-shot. A
  process that stays open with tool access, taking instructions over HTTP, needs
  the same gate as today plus a hard cancel and a per-job budget. The
  authentication story does not change; the blast radius of a compromised session
  does.
- **It is a rewrite of `workspace.mjs`, not an extension.** The current file is a
  good one-shot implementation and the wrong shape for this. Expect to delete
  most of it.

## Sequencing

Each step is independently useful, and nothing is wasted if the next is deferred:

1. **Job model + event stream, still using `claude -p` underneath.** Fixes ① and
   ③. No process-model change yet, so it is low-risk and immediately better.
2. **Switch the runner to `stream-json`.** Fixes ②, brings real in-turn
   permission answers, and makes attachments straightforward.
3. **Split the runner into its own process.** Fixes ④. Do this before asking the
   agent to modify `server/` — until then, `src/` edits work (Vite reloads) and
   `server/` edits need a human restart.
4. **Extract the provider interface.** Only when a second provider is actually
   wanted. The first three steps should be written so this is an extraction, not
   a redesign.

Steps 1–2 give the owner everything he asked for in the Embedded Claude Workspace
item. Step 3 is what makes Operator self-hosting in the real sense. Step 4 is the
AI Provider Manager.

## Open questions for the owner

1. **Job history** — should completed jobs survive a restart, or is a live view
   enough? Persisting means a storage slice and a retention policy.
2. **Permission profiles** — which bundles are actually wanted? "Edit `src/`",
   "run builds", "anything except git push" are guesses, not requirements.
3. **Concurrency** — one job at a time, or several? One is simpler and matches a
   single user on a phone; several matters if long builds should run while he
   asks something else.
4. **Budgets** — should a job have a token or cost ceiling that stops it, given
   plan usage is the real constraint rather than a bill?
