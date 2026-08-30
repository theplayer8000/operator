# The presence layer — Operator that speaks first

**Status:** proposed, nothing built. Needs the owner's decisions at the marked
points.
**Date:** 2026-08-30
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

**Owner's decision needed.** This is a named-host approval question, not an
implementation detail, and the honest framing is: a wake-word Jarvis that uses
browser recognition is a permanently open microphone reporting to a third
party.

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

1. **Voice input: local transcription only, or is browser recognition
   acceptable?** Recommendation: local only. This is a named-host approval.
2. **Usage ceilings** — undecided since ADR 0013, and phase 2 makes them load-
   bearing rather than theoretical.
3. **Does the presence layer get to arm the terminal?** Recorded as intended in
   the control-plane doc; the mitigations above are the version that keeps
   ADR 0011 intact.
4. **Is presence a page, or a mode?** It needs settings — triggers, voice on
   or off, quiet hours — and that is either a small Settings section or its own
   surface. Leaning Settings section, since it is infrastructure rather than a
   feature.
