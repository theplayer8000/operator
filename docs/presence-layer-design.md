# The presence layer — Operator that speaks first

**Status:** partly built. The trigger loop and the schedule store are still
proposed; the voice surface is live. Needs the owner's decisions at the marked
points.
**Date:** 2026-08-30, revised 2026-09-04

**What is actually built since this was written**, because a document that says
"nothing built" is one a session will act on: speech in and out, the clap
detector, `focus_operator`, `listen_once`, intent matching, and
`OPERATOR_MAX_CONCURRENT`. What is not: anything that starts a job without being
asked — which is still the whole point of §2 and §2b.
**Relates to:** [`control-plane-design.md`](control-plane-design.md) (a
different axis — see below), [`vision.md`](vision.md),
[ADR 0011](decisions/0011-remote-terminal-for-authorised-devices.md),
[`known-issues.md`](known-issues.md).

The owner's words for what he is aiming at: *"I want to be able to talk to it
as Tony Stark does in Iron Man."* And for the shape it should take: **layered
on top of Operator**, which is already its own backend system.

That second instruction is the one this document is organised around, because
it is correct and it rules out most of the obvious ways to build this.

## The boundary this document draws

This is **not** the control plane. That document is about *routing work between
models* — gateways, multi-worker jobs, job-level permissions. This is about
Operator having **presence**: being there without being opened, speaking
first, and being spoken to rather than typed at.

They share one component — the local model — and otherwise do not overlap.
Either can be built without the other.

## The core claim

**Jarvis does not need a backend, because Operator already is one.**

Everything Tony asks Jarvis to *do*, Operator can already do: read the
calendar, change the gym log, check whether a service is up, run a build,
restart an app. That is `server/actions.mjs` and it is 34 actions deep.

What is missing is not capability. It is that every one of those actions today
begins with **a person opening a page and typing.** Operator has substance and
no presence.

So the presence layer is thin by construction. It is three things:

| Part | Where it lives | What is new |
|---|---|---|
| **A trigger loop** | `server/` | Something wakes up and starts a job |
| **A voice surface** | frontend | Mic in, speech out, on the existing chat |
| **A policy** | small, then the local model | What is worth waking for, and worth interrupting for |

None of those is a new backend. Two of them are barely new code.

## The primitive already exists

`server/index.mjs` runs `runBackup()` on an hourly `setInterval`. **Operator
already does things on its own schedule without being asked.**

The gap between that and *"every morning, look at the calendar and the gym
programme and tell me what today is"* is not a new subsystem. It is the same
timer, pointed at `jobs.mjs` instead of at one hardcoded function.

Stating that plainly because it changes the size of the project: the hard part
— an agent that can safely act on the owner's real systems — is built and has
been for weeks.

## What makes it a layer rather than a rewrite

Four rules. They are what the owner's "layered on top" actually requires, and
breaking any of them turns this into a second system.

1. **It goes through the capability layer like any other worker.** If the
   presence layer wants to know today's gym session it calls `gym_day` — the
   same action Claude and Gemini call. It gets no privileged read path and no
   direct access to `store.mjs`.
2. **Operator must work completely with the presence layer off.** Dashboard,
   missions, calendar, the Orchestrator: all unchanged. This is additive or it
   is wrong. Same bargain as *"the app must still work when the storage server
   is down"*.
3. **It gets no permission Operator does not already grant.** In particular it
   does not bypass the permission model — a turn it starts is subject to the
   same pre-allow list and the same two denials as one the owner starts.
4. **Its own namespace** (`jarvis.*` or `presence.*`) if it stores anything at
   all, per the one-namespace-per-feature rule.

The one place this boundary is under real pressure is the terminal — see
"Where it stops being a layer", below.

## ⚠ The finding that changes the voice design

**Browser speech recognition is not local.** Chrome's `webkitSpeechRecognition`
streams audio to Google's servers for transcription. It is not on-device, and
nothing about the API says so at the call site.

That is **microphone audio from the owner's house leaving the machine, to a
host nobody approved** — the exact thing `CLAUDE.md`'s external-application
rule exists to prevent, and worse than the camera-frame question already
flagged in [`devices-and-harness-notes.md`](devices-and-harness-notes.md),
because a hot mic captures whatever is said near it rather than what was
deliberately pointed at something.

It would also be trivially easy to ship by accident: the API is three lines and
it works immediately.

So there are two paths and they are not equivalent:

| Path | Audio leaves? | Cost |
|---|---|---|
| Web Speech API | **Yes — to Google** | 3 lines, works today |
| Local Whisper | No | a real component, and CPU the box is short of |

**Recommendation: local transcription only, and if that is not viable yet, no
voice input at all rather than the quick version.** Voice output is fine either
way — `SpeechSynthesis` is on-device on both Windows and iOS, and no audio is
being captured to leak.

### ✅ DECIDED 2026-08-30 — local only, and the stack is named

See [ADR 0015](decisions/0015-hermes-agent.md). The owner's answer was local
transcription, and Hermes Agent supplied the concrete stack:

- **`faster-whisper`**, local, nothing leaves the machine.
- **Silero VAD on**, so silence never reaches the model. Not a refinement —
  Whisper decodes plausible text out of a quiet room, and the VAD filter is the
  fix. Expect to need it; do not discover it.
- **`base`** as the starting size, with `tiny` below it if the CPU cannot keep
  up.

If `base` is too slow on this hardware the ladder goes **down to `tiny`, not
out to a cloud API** — that would reintroduce exactly the audio egress this
section exists to prevent.

## The secure-context trap, again

`getUserMedia` — needed for any microphone access at all — is **secure-context
gated**, exactly like `crypto.randomUUID` and the camera.

So voice will not work at the bare tailnet IP and will work at
`https://<host>.<tailnet>.ts.net`. This is the third feature to hit it. Expect
it to present as a mysterious permissions failure rather than an error that
names the cause.

## Phases

Ordered by felt change per unit of risk, not by architectural purity.

### 1. Voice out, then voice in

Operator speaks its replies. On-device, no new dependency, no data leaves.
The smallest change with the largest difference in how it *feels*, and it makes
the next phases worth having — a job that finishes while you are across the
room is useless if it can only write to a page.

Voice **in** follows, gated on the decision above.

### 1b. Barge-in — the conversational model, not turn-taking

**Owner's requirement, stated repeatedly and captured here 2026-09-10 so it
stops being lost:** he must be able to **talk over Operator while it is
mid-sentence and have it actually respond to the interruption** — cut its own
speech, take what was said, act on it. Not a walkie-talkie where you wait for
it to finish. *"This is the actual bar for it feeling like a real JARVIS."*

This is a design requirement, not a refinement, and it is **in direct tension
with how §4b and §4d currently propose to handle feedback.** Both say *"pause
detection while `speech.speaking` is true"* — which is the cheap, correct fix
for Operator hearing its own voice, and is also **exactly a strict turn-taking
model**: if the mic is deaf whenever Operator is talking, you cannot interrupt
it. The two goals pull opposite ways and the doc should not pretend otherwise.

What barge-in actually needs, in rough order of how much is new:

1. **The mic stays hot during TTS.** No pausing detection while speaking. This
   is the part that reintroduces the feedback problem §4b pausing was there to
   avoid.
2. **Tell the owner's voice apart from Operator's own.** Two known routes, and
   jarvis (§4d) uses the second:
   - **Acoustic echo cancellation (AEC).** The browser's `getUserMedia` can do
     this — `echoCancellation: true` is a standard constraint, and it is built
     for exactly this case (a page playing audio while capturing). Cheapest if
     it works well enough with a boom mic close to the speaker; needs measuring,
     not assuming.
   - **Echo detection through the small local model** — jarvis's approach.
     Harder, but it is the fallback if AEC is not clean enough, and the local
     worker is already loaded.
3. **A speech onset that isn't Operator → cut TTS immediately.** `SpeechSynthesis`
   cancels on demand; the trigger is "the mic heard sustained non-echo speech
   while we were talking". This is the actual barge-in action.
4. **Then it's a normal capture.** Whatever was said during and after the
   interruption is transcribed and routed like any other voice input.

**"stop" as a spoken cancel word** (§4d, "Take these") is a *subset* of this —
one hardcoded phrase that stops playback — not the whole thing. Barge-in is
"respond to anything I say over you", which needs the echo-vs-voice
discrimination that a single keyword match sidesteps.

**Not building now** — voice work proper has not started. This section exists so
that when it does, the feedback-prevention approach in §4b/§4d is understood as
the *turn-taking* answer it is, and the barge-in requirement is designed in from
the start rather than bolted on after the walkie-talkie version ships and
disappoints.

### 2. Operator starts its own jobs

The trigger loop. Extend the existing hourly timer so a schedule can start a
*job* rather than call a function.

This is where it stops being an app you open. It is also where cost stops being
bounded by the owner's typing: a job that runs every hour is a job that runs
8,760 times a year, and [ADR 0013](decisions/0013-usage-accounting.md) settled
the accounting for exactly this reason while explicitly not settling the
ceilings. **A trigger loop without a ceiling is the first thing in Operator
that can spend money while nobody is watching.** The ceiling stops being
optional here.

Rules that fall out of that:
- A trigger names an action or a prompt, and where it runs. Not arbitrary.
- Triggers are **environment or store config, never model-editable** — same
  reasoning as `OPERATOR_APPS` and `OPERATOR_TERMINAL_DEVICES`. A worker that
  can add a trigger can schedule itself.
- Overlap is refused, not queued. An hourly job that takes 90 minutes must not
  stack.

### 2b. Scheduled and triggered tasks — shaped 2026-09-04

The phase above says *what* the trigger loop is. This says what the owner should
be able to **make** with it, because he has now seen the shape working elsewhere
— Claude Code's scheduled-task templates — and wants it here.

Those templates are worth reading as **evidence of the shape, not as a list to
copy**: a briefing on weekdays at 1:30pm, a system health check daily at 1pm,
email and issue triage at fixed weekday times, a PR review digest at 7pm, a
dependency check on Mondays, a flaky-test tracker on Mondays — and, the
interesting one, a release-notes drafter fired **by a pull request closing**
rather than by a clock.

That last one is the finding. **There are two kinds of trigger and only one of
them is a timer.**

| Kind | Fires on | What Operator has today |
|---|---|---|
| **Clock** | a time, a weekday, an interval | the hourly `setInterval` in `server/index.mjs` |
| **Event** | something happened | nothing general — see below |

#### What Operator can schedule today, with no new integration

This is the part that makes the section worth writing: the most valuable
template on that list is also the one that needs **nothing approved and nothing
new**.

A **morning briefing** is four capability calls and a summarisation:
`calendar_range` for what is on, `gym_day` for which session today is,
`routine_day` for the steps, `missions_list` for what is moving — plus `now`,
because a worker asked the date reads the calendar to guess it otherwise. Every
one of those exists, is validated, and is already called by workers daily.
There is no host to approve, because nothing leaves that is not already leaving
when he types the same question by hand.

Near neighbours, same story: an end-of-day roundup from `work_recent` and
`handoff_read`; a Monday "what is blocked" pass over `missions_list` — the
dependency count `/statistics` already derives, delivered rather than visited.

A **system health check** is the honest half-case. The probes exist
(`server/homelab.mjs`, `scripts/app.mjs status`) and neither is reachable as a
capability action, so a scheduled worker asked "is anything down" would have to
shell out or grep — which is exactly the failure `CLAUDE.md` records against
`actions.mjs` ("a new feature needs a read action, not just writes", and the one
time it did not have one it cost $0.92 to answer a question). **A health-check
schedule wants a read action first.** That is a small, in-house piece of work,
not an integration.

#### What is not ours to schedule, named so nobody builds one by accident

Most of the remaining templates are only interesting because they reach a host
Operator does not own. Email triage needs a mailbox. Issue triage needs Linear
or Jira. A PR digest, a dependency check, a flaky-test tracker and the
release-notes drafter all need **GitHub**. An infrastructure alarm worth the
name needs PagerDuty, Datadog or Sentry.

**Not one of those is approved**, and a schedule is a peculiarly easy place to
smuggle one in — the integration is three lines inside something whose headline
is "briefing". `CLAUDE.md`'s rule is per host, in advance, by name, and it
applies here exactly as it applies anywhere: ask, name the host, say what leaves
the machine, wait. Naming them here so that the first person to build a PR
digest finds this paragraph before they find the GitHub API.

The event-trigger case doubles the ask. "When a pull request closes" is a
**webhook** — an inbound route from a host on the internet, on a server whose
entire security posture is that it is only reachable on a tailnet. That is a
second decision, and a larger one than the API call it delivers.

Which leaves event triggers, for now, as **polling**: the same loop, asking. Not
elegant, and honest about what it is. Operator has no event bus — `jobs.mjs` has
an append-only log per job and `store.mjs` funnels every data change through
`withState()`, which are the two places a real one would eventually hang off.
Worth noticing that the most useful internal events already exist there: a job
finished, a job failed, a mission changed status, an app stopped answering.

#### Where a schedule is stored — and the conflict in the phase above

A schedule is state, so the architecture is not in question: **one namespace,
one hook, one folder**, same as every feature. Call it `presence.schedules`,
give it `usePresence`, and the Settings section in decision 4 becomes where it
is edited.

Except the phase above says triggers are **"environment or store config, never
model-editable"**, and those two sentences disagree. A slice of `operator.json`
is writable by any worker with `Write`, and by `PUT /api/state/<key>` on top of
that. **A schedule a worker can edit is a worker that can schedule itself**,
which is the `OPERATOR_APPS` reasoning verbatim.

Three ways out, none free:

- **Environment-only**, like `OPERATOR_APPS`. Safe and unusable — he is not
  editing an env var from his phone, and this is a feature he will want to
  change while looking at it.
- **Its own file**, the `subscriptions.mjs` precedent: outside `operator.json`,
  outside the state API, reached only through the two purpose-built routes that
  own it (there is no capability action for a subscription). A worker with
  `Write` can still reach the file, so this narrows the surface rather than
  closing it.
- **In the store, and accept it**, on the grounds that a worker able to edit
  schedules is already a worker able to edit `server/`. True, and it gives away
  the one thing an env var was protecting: the difference between a worker that
  can act now and a worker that can arrange to act every morning at six.

**Needs his decision.** The middle one is what this document would pick — the
same shape push subscriptions already use, for the same reason: it is state, but
it is not *his data*.

#### A scheduled job is a job, and inherits everything

It goes through `jobs.mjs` like any other. That is not a detail, it is most of
the design:

- **The permission envelope is unchanged** — the pre-allow list, and the two
  denials that never become questions. A 6am job cannot do anything a 6pm one
  cannot.
- **The usage ceiling applies**, and `server/usage.mjs` now enforces one rather
  than proposing it. This matters more here than anywhere: the trigger loop is
  still the first thing in Operator that can spend while nobody is watching, and
  a schedule that says "nothing today" 200 mornings a year pays full price for
  each of them. Worth a cheap pre-check — rules first, the way `routing.mjs`
  already decides — before a worker is woken at all.
- **Routing picks the worker.** A briefing is a summary over four action calls;
  that is the cheap worker's job, not Claude Code's. The expensive worker should
  be reserved for the schedules that actually build something.

#### Two things that only go wrong when nobody is there

**A permission question at 3am.** `PERMISSION_TIMEOUT_MS` is 30 minutes and
**timing out denies** — the right default, chosen so that walking away from your
phone is never read as approval. For an unattended schedule that is still the
right answer and a bad experience: the turn dies half-finished, and it holds a
concurrency slot for half an hour first while doing nothing.

So a scheduled job probably wants to be **stricter than an interactive one, not
looser**: fail immediately on anything outside the pre-allow list, log what it
would have asked, and let him answer it in the morning by re-running. A schedule
that quietly waits half an hour for an answer nobody will give is worse than one
that stops. **Needs his decision**, and it is the one most likely to be got
wrong by defaulting.

Related, and cheaper to get right: `notify.mjs` will happily push at 3am. Quiet
hours are already on the list in decision 4 — this is the thing that makes them
mandatory rather than polite.

**`OPERATOR_MAX_CONCURRENT` is now real** (default 1, and his environment runs
3). A scheduled job entering the queue competes with the one he is typing into,
which is a new failure: he asks a question, and waits behind a briefing he
forgot he set. Options are to reserve a slot for interactive work, or to let
schedules run only when nothing else is. **Undecided.** The phase above's
"overlap is refused, not queued" still holds *per schedule* — it stops one
schedule stacking on itself, and says nothing about two different ones landing
on the same minute, which is what a fixed-time list makes likely.

### 3. Operator reaches you

Voice is useless if you are not on the page, so presence needs a way to
interrupt. That means **web push**, and on iPhone that means Operator installed
to the home screen as a PWA — web push on iOS only works for installed web
apps. Fiddliest phase, least interesting, and the one that decides whether any
of this is actually present in daily life.

Note the existing `JobToast` and the nav badge are **not** this: they only fire
with the app already open.

### 4. Operator acts unwatched — the gate on everything

Right now **the owner is the verification step.** He reads every result and
decides whether it was right. A presence layer that speaks first is, by
definition, acting without being watched.

So the verification gap — gap #1 in
[`devices-and-harness-notes.md`](devices-and-harness-notes.md) — is not a
nice-to-have here. It is the thing standing between "an assistant you drive"
and "an assistant that acts". This is where the local model earns its place,
and it is the correct first job for it.

### 4b. The clap gesture — proposed 2026-08-31

The owner's ask: **two claps switches to the graph view and starts listening.**

Worth separating from the wake word below, because it is a much cheaper thing
that happens to solve most of the same problem.

**A clap needs no speech recognition.** It is a sharp amplitude transient, so
detecting two of them inside a window is arithmetic over `AnalyserNode` output
— no model, no dependency, and **no audio leaving the page**, not even to the
server. That is a genuinely better privacy position than a wake *word*, which
has to understand something to know it was said.

It is also a better fit than a wake word for what he actually wants, which is
not "hear me from anywhere" but "get the screen ready without walking over".

#### What it costs, stated plainly

**The microphone is open the whole time.** Nothing is recorded, transmitted or
understood, but the browser will show its recording indicator and the tab will
hold the device. That is a posture change and should be a deliberate, explicit
toggle — never on by default, never enabled as a side effect of turning on
voice output.

And `getUserMedia` is **secure-context gated**, so this works only on
`https://<host>.<tailnet>.ts.net`, never at the bare IP. Third feature to hit
that; it will present as a permissions failure with no explanation.

#### Two failure modes worth designing against

- **Anything percussive triggers it** — a door, a dropped mug, a snare on the
  speakers. Requiring *two* claps inside roughly 200–600ms with a quiet gap
  either side removes most of it, and the action being harmless (switch view,
  start listening) means a false positive costs a glance rather than an action.
  This one stopped being hypothetical almost immediately, and it is what forced
  the correction in the next section.
- **Feedback.** Operator speaking through the same speakers the mic can hear is
  how a clap detector triggers on itself. Pausing detection while
  `speech.speaking` is true is the fix **for the clap gesture specifically** —
  a clap during Operator's own sentence is not a wake signal worth acting on.
  It is **not** the fix for voice input: see §1b, where the owner requires
  talking over Operator mid-sentence, which the pause makes impossible.

#### What the clap should actually do — refined 2026-08-31, corrected 2026-09-04

Three things were asked for here: **pause whatever is playing, put Operator full
screen, and be already listening before the view switches.**

**The first of those three — pausing — is struck out; it is point 2 below.**
It was wrong, the owner had said so before it was written down, and the
correction below is kept in full rather than deleted quietly — because the
reasoning is worth considerably more than the feature was.

**1. Capture starts at the clap, not after the switch.** The important one, and
the cheapest. The microphone is already open — that is how the clap was heard —
so the transcription buffer opens on the *second* clap and keeps whatever is
said during the transition. Otherwise the interaction is clap, wait, then talk,
which is worse than pressing a key. Nothing extra is needed for this beyond
being deliberate about where the buffer starts.

**2. Pausing other audio — REMOVED. The symptom was real and the diagnosis was
backwards.**

This section previously proposed a `media_pause` capability action fired by the
gesture. It is withdrawn. **The clap does not touch playback, and no gesture
should.**

The reason is the part worth keeping, and it is **his account, given
2026-09-04**, not something reconstructed from the logs afterwards:

> *"sometimes i have my music play on speakers and that was what was firing the
> clap detector like 11 times the other day i remember u mentioned it and took
> it as a bug but yeah it was but wrong deduction lmao"*

Music on speakers is percussive, so the music was **firing the detector**. That
was read at the time as a bug in the detector's thresholds — a real symptom with
the wrong cause attached. The detector heard precisely what it was built to
hear, and the honest fix is not a tighter window, it is refusing to put the
thing making the noise under the gesture's control.

Two notes on the count, because the repo disagrees with itself and neither
figure should be quoted as measured. His recollection is about eleven; the
changelog entry *"Clapping arms the terminal, for twenty minutes"* says fifteen
claps in an evening. Nothing counted false triggers as such, so both are
impressions. And `server/index.mjs` records a *different* reason for not
building the pause — that he would rather stop his own music than have a gesture
reach into whatever holds the media session. Both reasons are his and they point
the same way; this section keeps the argument rather than the arithmetic.

Building the pause would have made it worse in the way that is hardest to
notice. A gesture false-fired by music, whose first act is to silence the music,
**covers its own tracks** — the false positives stop being visible at exactly
the moment they start being expensive.

`media_play_pause` **still exists** in `server/actions.mjs`, and is fine as it
is: "pause that", asked for. What is removed is the clap firing it. That
distinction is the whole rule — a named action he invokes is not the same object
as an action a sharp noise invokes, even when the code underneath is identical.

The other failure mode above — **Feedback**, Operator's own speech reaching the
mic — survives untouched, and is the same class of problem seen from the other
side: a detector that hears the room hears whatever Operator puts into the room.

**3. Full screen is the one that does not work as asked.** Browsers only grant
`requestFullscreen()` from a genuine user gesture, and a clap is not one — the
call would be rejected, silently, on the machine where it matters most.

The good version is to stop needing it: the display is **already its own screen**
(see `dashboard-graph-design.md`), opened full screen once and left there. So
"full screen Operator" is answered by the window already being one, not by a
fullscreen call at all.

An earlier draft framed that screen as a TV on the wall. **Dropped — he is not
running Operator on a television**, and it was never load-bearing: a panel on a
wall is still driven by the PC, so it is a monitor with a longer cable. The
argument stands or falls on the browser refusing `requestFullscreen()`, which
has nothing to do with what the panel is.

Where Operator *is* just a window, F11 once still beats an API that will refuse
— and since this was written, the machine side answers it directly:
`focus_operator` raises and fullscreens the window from the PowerShell half,
because a page cannot raise itself but a process on the machine can. It
deliberately does nothing else, for the reason in point 2.

### 4c. The device split, named

His framing, and it is worth writing down because it settles several arguments
at once: **the phone is a view and review panel; the PC is the dev side.**

That is already how the decisions have been going without being stated —
the mission map is big-screen only, the wall display is its own screen — and
having it explicit means the next surface does not have to re-litigate it.

"Wall display" here means **a second monitor driven by this PC**, per the
correction in point 3 above. `dashboard-graph-design.md` described it as a TV
or projector until 2026-09-04 and was corrected in the same pass; if that framing
turns up anywhere else, it is the one he ruled out.

| | Phone | Desk / big screen |
|---|---|---|
| For | checking, answering, acting | building, watching, talking |
| Gets | everything that must work anywhere | the graph, the clap gesture, the wall view |

The rule that falls out: **a phone surface may never depend on a desk-only
feature**, but the reverse is fine. Answering a permission prompt, ticking a
gym session and reading a handoff must all work on a phone. Watching a live
graph need not.

### 4d. What `isair/jarvis` already proves — read 2026-08-31

The owner pointed at [github.com/isair/jarvis](https://github.com/isair/jarvis),
a 100%-local voice assistant. Worth reading properly rather than admiring,
because it is a working instance of the design in this document and it settles
some things by existing.

**It confirms two decisions independently.** Its speech stack is local Whisper
in, **Piper** out — which is what [ADR 0015](decisions/0015-hermes-agent.md)
chose from a different starting point. And it keeps a **small fast model loaded
alongside the chat model** purely for intent classification and tool routing,
which is exactly the always-on local worker in
[`control-plane-design.md`](control-plane-design.md). "Always loaded" is also
the keep-alive lesson Operator learned the expensive way: 24s to 1.2s once the
model stopped being evicted between calls.

**Piper answers "can we get a dedicated voice."** Browser `SpeechSynthesis`
uses whatever voices the OS ships, which is why the current picker is a list of
Microsoft's. Piper is a local neural voice in about 60MB — a real voice rather
than a system one, still nothing leaving the machine. That is the natural
upgrade to phase 1 and it needs no architectural change: `useSpeech` already
owns the whole surface, so the browser path becomes the fallback.

**It solves the feedback problem with a model, not a mute.** Operator hearing
its own speech is flagged above as a clap-detector failure mode; they run echo
detection through the small model. **This is the barge-in enabler** (§1b): the
owner wants to talk over Operator, so the mic cannot go deaf while it speaks,
so "is this the owner or is this Operator's own voice coming back" has to be
answered some other way. jarvis answers it with the small model; browser AEC
(`echoCancellation: true`) is the cheaper thing to try first. Pausing detection
while speaking stays the right answer for the *clap gesture* and the wrong one
for *voice input*.

#### The finding that is actually about Operator

**It routes tools by embedding relevance, explicitly "to prevent degradation
with unlimited MCPs" — and Operator currently does the opposite.**

Every one of `actions.mjs`'s ~35 actions is sent to every worker on every turn,
as a full tool declaration. That has two costs, and the second is worse:

- Tokens, on every request, for tools the task will never touch.
- **Model quality.** A long tool list makes the wrong tool likelier, which is
  not theoretical here: asked the time, Gemini reached for `calendar_range` and
  `jobs_list`. That was read as a missing `now` action — correctly — but a
  crowded list is the other half of the same story, and adding actions makes it
  worse.

Operator does not need embeddings for this. The actions are already grouped by
feature (`gym_*`, `mission_*`, `calendar_*`, `routine_*`, `job_*`), so a keyword
pass over the prompt would cut the list sharply for almost nothing — and
`routing.mjs` already does rules-first-classifier-second for a similar job.

Worth doing **before** the action count grows again, and worth measuring rather
than assuming: count the tokens the declarations currently cost per turn first.

#### "Most likely what Operator will become" — the owner, 2026-08-31

Directionally right, and worth separating what to take from what taking it
whole would cost. Same test as [ADR 0015](decisions/0015-hermes-agent.md):
**components, not identity.**

**Take these.** Each is already decided or already queued, which is the point —
the reference is confirmation rather than a new plan:

| From jarvis | Status here |
|---|---|
| Local Whisper in, Piper out | decided (ADR 0015); Piper queued |
| Small model always loaded, for routing | the local worker, built |
| Tool relevance filtering | queued — the real finding |
| Memory digest before injection, for small models | unbuilt; it is harness gap #4 |
| Secrets auto-redacted in stored memory | not considered here, and should be |
| Whisper hallucination filters (confidence, no-speech) | folds into the VAD decision |
| "stop" as spoken interruption | cheap, obvious, worth copying — but a *subset* of §1b barge-in, not the whole of it |
| Echo detection via the small model | the barge-in enabler (§1b); try browser AEC first |

**The one to be deliberate about: "100% local" is a product identity, and it is
not Operator's.**

Operator's promise is *self-hosted — your data never leaves hardware you
control*, which is why every external host is approved by name. jarvis's promise
is stronger: nothing leaves at all. The stronger promise buys less. Taken
literally it means **trading Claude Code for a 3B model**, and Claude Code is
currently the thing doing the actual engineering on this codebase — work no
local model on this hardware can do. Voice should go local. The *worker* should
not.

The right shape is the one the provider boundary already has: **local for the
things that must be constant, cheap and private** — routing, transcription,
verification, deciding whether to speak — **and a cloud worker for the hard
work, approved by name.** That is not a compromise on the vision; it is the
vision, which was always about the data rather than about isolation.

**Two more differences worth not sleepwalking into.** jarvis is Python and
PyTorch; `server/` is Node with one npm dependency by ADR, so anything adopted
runs as a spawned binary — the precedent Edge and ffmpeg already set — not as a
new stack. And jarvis uses **MCP** for tools where Operator deliberately chose a
CLI, because a CLI is worker-agnostic and MCP is not. That trade is worth
revisiting only when Operator wants something outside its own data (Home
Assistant, GitHub), because that is where MCP's ecosystem is the actual
argument — and that is a named-host decision, not a protocol preference.

### 5. Wake word

Hardest, least valuable, and on an i5-10400 with no usable GPU it would compete
for the CPU the model needs. Last, if ever. A push-to-talk button gets 90% of
the feeling for none of the cost.

## Where it stops being a layer

Rule 3 above holds for everything except one case, and it is the case already
flagged in `control-plane-design.md` §2: **the presence layer arming the
terminal.**

Arming is currently a human act. That is not about restricting *what* runs —
ADR 0011 says outright the deny list is not the boundary — it is that there is
a moment where a person decides execution is allowed now. A presence layer that
arms the terminal on its own judgment is no longer sitting on top of Operator;
it is reaching through it.

The three mitigations recorded there apply unchanged: arm per job rather than
per session, prefer capability actions over the shell, and make the UI say who
armed it and why.

## The honest difference from the film

Film-Jarvis never asks permission because it is never wrong. Operator's
permission model exists precisely *because* models are sometimes wrong, and it
is the reason one is allowed near the owner's data at all.

So the target is not "never asks". It is **asks about the right things and
stops asking about the rest** — which is the same sentence ADR 0012 was already
written to satisfy, applied to a system that now speaks first.

## Decisions needed before any of this starts

1. ~~**Voice input: local transcription only?**~~ **DECIDED 2026-08-30** —
   local only, `faster-whisper` + Silero VAD. [ADR 0015](decisions/0015-hermes-agent.md).
2. ~~**Usage ceilings**~~ **BUILT since this was written.** `server/usage.mjs`
   implements ADR 0013 properly — `checkCeiling`, `ceilingBlock`,
   `jobCeilingUsd`, per-basis aggregates — and `OPERATOR_CEILING_JOB_USD` /
   `OPERATOR_CEILING_DAILY_USD` are live. The old `OPERATOR_USAGE_BUDGET_USD=10`
   stopgap is superseded and its warning no longer applies.

   **What this phase still needs is not a dollar ceiling.** A scheduled job
   spends without anyone watching, so the question is how many *unattended*
   turns may run before it stops and says so — a count, on a clock, separate
   from the interactive ledger. That is unbuilt and undecided.
3. **Does the presence layer get to arm the terminal?** Recorded as intended in
   the control-plane doc; the mitigations above are the version that keeps
   ADR 0011 intact.
4. **Is presence a page, or a mode?** It needs settings — triggers, voice on
   or off, quiet hours — and that is either a small Settings section or its own
   surface. Leaning Settings section, since it is infrastructure rather than a
   feature.
