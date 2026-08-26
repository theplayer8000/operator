# Devices, inputs, and how much harness Operator already has

**Written:** 2026-08-26, late.
**Status:** notes from a conversation. **Nothing here is agreed or started.**
The owner asked for it to be saved rather than processed — he was tired, and
this exists so none of it has to be re-derived tomorrow.

Two threads got tangled together in one conversation and they are worth pulling
apart, because they are different axes and only one of them makes the agent
better at its job.

---

## 1. Operator is already an agentic harness

A model produces text. The **harness** is everything around it that turns that
into work getting done: the loop, the tool surface, what happens on refusal or
error, how context is managed, and how anyone knows the result was correct.
Same model, different harness, wildly different outcomes.

The point worth keeping: this has been getting built here for months without
being called that.

| Harness concern | Operator's answer |
|---|---|
| The loop | `server/jobs.mjs` — append-only event log, `session_id`, `--resume` |
| Tool surface | `server/actions.mjs` — named, validated, worker-agnostic |
| Model boundary | `providers.mjs` / `runner.mjs` / `gemini.mjs` |
| Permissions | [ADR 0012](decisions/0012-claude-agent-sdk.md) option C — a denial is a question, answerable from the phone |
| Blast radius | the `agent` worktree, so half-finished work is invisible |
| Routing | `server/routing.mjs` — rules first, classifier second |
| Observability | the Orchestrator page, `CURRENT.md`, the Updates changelog |

So the useful question is never "should Operator get a harness". It is **which
parts are missing.**

## 2. What is missing, ranked

1. **Verification.** Every job records `verification: { status: "not-run" }` and
   always has. The owner is the verifier today: he reads the result and decides
   whether it is right. This is the largest gap and the most local-model-shaped
   — checking work is cheaper than doing it.
2. **Planning and decomposition.** A job is one conversation. A harness splits a
   task, runs what can run in parallel, and joins the results. This is the
   multi-worker half of [`control-plane-design.md`](control-plane-design.md).
3. **Repair loops.** `task` / `attempts` / `handoff` are already recorded on
   every job and are dormant on the frontend. A harness reads them: failed, here
   is why, try *differently* — as opposed to retrying the same thing.
4. **Context strategy.** No compaction or summarisation of its own. A long job
   simply runs out.
5. **Evals.** No way to tell whether a change to the prompt or the tool list
   made the agent better or worse. Every judgement so far has been the owner
   noticing. Least enjoyable, and the one that stops the project going in
   circles.

**The order matters: 1 before 2.** Fanning out more workers before their output
can be checked multiplies unverified work, which is strictly worse than one
worker whose results a person reads.

---

## 3. The device ambition

His words, and worth recording as the direction rather than a feature:

> "ideally i'd like to connect any device to operator and have it work
> seamlessly, but i know there will be limitations"

A camera is the first instance of it. Note what it is and is not: **a camera is
a new input, not a better loop.** It does nothing for any of the five gaps
above. Both are worth having; they should not be confused for each other.

### What a camera genuinely unlocks

- **Physical ground truth for Homelab.** Directly relevant to the "is it
  actually up" work of 2026-08-26: every software signal has lied at least once
  — a green tile over a dead app, a *Running* task with nothing listening. A
  lens pointed at the box cannot. Lights, no lights, a bluescreen.
- **Gym.** That a session happened; possibly form on a lift.
- **Presence.** Whether he is at the desk. More a routing input than a feature —
  "he is out, do not start a job that will need a permission tap."
- **Capture into the Knowledge Vault.** Whiteboard, book page, a label. Text
  that would otherwise be retyped.

### Two different builds, and he wants both

They are independent and can land separately.

- **Camera on the box.** The server reads the device directly, no browser
  involved. Likely `ffmpeg`, spawned **argv-only, no npm package** — exactly the
  precedent set by `server/render.mjs` using Edge. The no-dependency rule of ADR
  0012 survives it.
- **Camera on whatever he is holding.** `getUserMedia` in the browser, frames
  posted up.

### The constraint that will look like a bug

`getUserMedia` is **secure-context gated** — same family as `crypto.randomUUID`,
`crypto.subtle` and `navigator.clipboard` in [`known-issues.md`](known-issues.md).

So browser camera access **will not work at the bare tailnet IP**, and *will*
work at `https://<host>.<tailnet>.ts.net`, which has a real certificate. Hitting
this cold reads as a mysterious permissions failure. It is the first thing to
check.

### A frame is not a prompt

Sending text to Claude or Gemini is one thing. Sending images of his house is a
different category of data leaving the machine, even to an already-approved
host. The approvals rule in `CLAUDE.md` exists to make exactly this get said out
loud rather than inherited from "we already send prompts there".

A local model handling frames on-box sidesteps it entirely — another argument
for the Ollama box, and it connects this thread back to
[`control-plane-design.md`](control-plane-design.md).

---

## 4. Phones: iOS is not Android, and it is structural

Prompted by a video of three Android phones being driven at once.

- **Android** exposes ADB deliberately — `adb -s <serial> shell input tap x y`,
  `adb exec-out screencap`. Point it at several serials and drive several
  phones. Those multi-phone demos are Android device farms.
- **iOS** has no equivalent. The nearest is WebDriverAgent (what Appium uses),
  which must be built and signed with Xcode — **so it needs a Mac.** Free
  signing expires every seven days; a year needs the paid developer account.
- **Unlocking is a flat no.** WebDriverAgent requires a device that is already
  unlocked. Nothing gets past Face ID or a passcode programmatically, by design.

None of it transfers, and none of it is what he actually wants anyway: Operator
already solved the phone by making it a *client*, not something to puppet.

## 5. The real version of "check it on iOS"

The genuine gap is narrower and was proved on 2026-08-26. `server/render.mjs`
reported the dashboard clipping at 390px; the owner looked at his actual phone
and it was fine. Headless Chromium ignores `<meta name="viewport">`, so a narrow
window is a narrow *desktop*, not an iPhone (trap 4 in that file).

**Playwright ships a WebKit build that runs on Windows** — same engine family as
Safari, no Mac, no phone, and real device emulation rather than a resized
window. It would be a **dev dependency, not a `server/` one**, which is a much
lower-stakes conversation than ADR 0012.

Be honest about its ceiling, though: it catches **engine** differences, not
**iOS** ones. The sidebar swipe bug was Safari's back-navigation gesture band —
iOS UI, not WebKit rendering — and Playwright would not have found it. Neither
would it find the input-zoom-on-focus behaviour.

So it is a real upgrade on what exists and still not a substitute for glancing
at the phone. For one app and one user, glancing is probably the correct amount
of engineering.

---

## Open questions, for when he is not tired

- **Verification first?** It is the smallest of the five gaps, the most
  local-model-shaped, and it makes everything after it safer. Recommended
  starting point.
- **Which camera path first** — box or handheld? Both are wanted; they share
  almost no code.
- **Does a frame ever leave the machine**, or is on-box inference a hard
  precondition? This decides whether the camera work waits on the Ollama box.
- **Is Playwright worth a dev dependency** for mobile-engine checks, given it
  would not have caught the iOS bugs actually hit so far?
