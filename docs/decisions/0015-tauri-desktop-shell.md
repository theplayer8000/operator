# 0015 — A Tauri desktop shell, for the things a browser will not allow

**Status:** Accepted 2026-09-01, not yet built
**Date:** 2026-09-01
**Relates to:** [ADR 0009](0009-permitted-abstraction-boundaries.md) (this is a
new client, not a new abstraction), [`threat-model.md`](../threat-model.md),
`CLAUDE.md`'s tech-stack rule, and [`ai-workspace-design.md`](../ai-workspace-design.md)

## Context

Every voice defect of the last three days has the same root, and it is not a
bug in Operator:

| What happened | The rule behind it |
|---|---|
| The phone was silent for a week | iOS grants audio playback **per `<audio>` element**, only from a user gesture |
| The microphone dies when Operator speaks | Bluetooth switches HFP→A2DP; the browser cannot pin the profile |
| Clapping cannot open the microphone | `getUserMedia` needs a gesture the first time on an origin |
| Operator hears itself through the speakers | Echo cancellation references the *playback* stream; speakers out + headset in gives it nothing to subtract |
| Nothing is heard unless a tab is open | No background audio in a web page |
| iOS push needs `ntfy.sh` as a relay | A web page cannot be woken by the OS |

These were each debugged, and four of them were fixed *around* rather than
solved: a shared audio element, a self-hearing guard with a release tail, a
clap-to-mic path that still needs one prior tap. The workarounds are correct and
they are also the ceiling. **A browser tab is the wrong container for something
meant to listen all day.**

The owner's framing throughout has been JARVIS — speak to it, it acts. The gap
between that and what exists is now almost entirely the sandbox.

## Decision

**Add a Tauri desktop shell as a second client. Do not replace the web app.**

Tauri wraps the existing build in a native window with a Rust host process.
Concretely, for this project:

- **Same `src/`.** It loads the app already built by `vite build`. There is no
  second frontend, no second design system, no second set of feature hooks.
- **Same server.** `server/` is untouched; the shell talks to the same `/api/`
  over the tailnet or loopback. The capability layer, the job model and the
  provider boundary are all unchanged.
- **Native where the browser refused:** microphone without a gesture, a global
  hotkey, audio output device selection, tray presence, launch at login,
  background operation with the window closed.

### Why Tauri rather than Electron

Electron ships a whole Chromium (~150MB) per app. Tauri uses the system WebView
— on Windows that is the WebView2 already present for Edge, which
`server/render.mjs` is already driving headlessly. The binary is single-digit
megabytes and the memory cost is one WebView rather than a second browser.

Rust is a real cost and is named here honestly. It is bounded: the shell needs
microphone capture, a hotkey, and an IPC surface. It is not where features get
written — anything that looks like a feature belongs in `src/` or
`server/actions.mjs`, exactly as now.

### What this does NOT do

**It does not help the phone.** Every constraint in the table's iOS rows stays
exactly as it is. A native iOS client is a separate decision, needs a Mac and
$99/year, and is deliberately deferred.

**It is not a capability.** Same rule as [ADR 0014](0014-development-tooling.md):
a desktop shell changes how the owner *reaches* Operator. It never becomes
something a worker can do. Gemini and the local Qwen cannot call it, so nothing
Operator itself needs may live there — that belongs in `server/actions.mjs`
where every provider can reach it.

## What it costs

**The stack rule.** `CLAUDE.md` says React + TypeScript + Vite + Tailwind +
Router + Recharts + lucide-react, "nothing else in the frontend". This is not a
frontend dependency — it is a container around the built output — but it is
close enough that it needs saying out loud rather than being slipped in. That is
what this ADR is for.

**A second thing that can be out of date.** There are already three builds
(live, dev, agent worktree) and `CLAUDE.md` has a table explaining which command
fixes which. A packaged desktop app is a fourth, and it is the worst kind:
it ships a *snapshot*. Someone will debug a fixed bug in a stale binary.

*Mitigation, and it should be a condition of accepting this:* the shell loads
the app **from the running server** rather than from bundled assets, in dev and
in normal use alike. Then it is a window onto the same `dist/` the browser
sees, and "rebuild the app" keeps meaning exactly what the table says it means.
Bundling is for the day it needs to run with the server down, which is not now.

**The threat model changes shape, though not much.** `threat-model.md` records
that there is no sandbox and the terminal runs as the owner. A native shell with
microphone access and a global hotkey is not a new class of exposure on a
machine where a job can already run arbitrary commands — but it does mean
**Operator is listening when no window is open**, which is a genuinely new
property and the one worth being deliberate about.

*Condition:* background listening is **off by default** and its state is visible
— a tray icon that differs when the microphone is live. The clap detector's own
history is the argument: it false-fired for weeks while nobody could see it.

*Added by the owner on acceptance:* **the clap detector becomes a toggle too.**
His reasoning, and it is the better version of the condition above: *"we dont
want to have it on all the time collecting info that we wouldnt want collected
... even if it is entirely self hosted"*. Self-hosting decides who holds the
recording, not whether it should have been made. A microphone that is always on
because nobody chose to turn it off is a decision by default, and this project
does not make those.

## Consequences

**Good.** The five desktop rows of that table stop being worked around and
start being solved. Clap-to-listen works with no prior tap. Operator can hear
"stop" without a tab focused. Output can be pinned to a device that is not the
one the microphone is on, which is the only real fix for the echo problem. The
web app keeps working for the phone and for review.

**Bad.** Rust in the repo. A fourth build. A packaging step. And a temptation —
every subsequent "this would be easier natively" now has somewhere to go, which
is how a clean boundary rots. The `server/actions.mjs` rule is the defence and
it must be applied strictly.

**Reversible.** Deleting the shell leaves the web app exactly as it is today.
Nothing in `src/` or `server/` becomes dependent on it. That asymmetry is the
strongest argument for trying it: the downside is a wasted week, not a
migration.

## What would change this

**~~A working PWA push path.~~ Built 2026-09-01** — `server/push.mjs`,
`public/sw.js`, ntfy retired. As predicted it changed nothing in the table
above: push is notifications, and every voice constraint listed there still
stands. Recorded here because it was raised as a possible alternative to this
ADR and turned out not to be one.

**Deciding the desktop does not matter.** If the phone becomes the primary
surface, this is the wrong investment and the $99 iOS route is the right one.
The owner's stated use is both, with the desk for real work.
