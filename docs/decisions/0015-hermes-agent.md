# 0015 — Hermes Agent: components taken, the product refused

**Status:** Accepted
**Date:** 2026-08-30
**Relates to:** [ADR 0014](0014-development-tooling.md) (the same test, applied
to a whole assistant rather than a plugin),
[`presence-layer-design.md`](../presence-layer-design.md) (which this resolves a
decision for), [`vision.md`](../vision.md), and `CLAUDE.md`'s
external-application rule.

## Context

The owner installed **Hermes Agent** (Nous Research) on 2026-08-30, on a
recommendation, to see whether it was a route to the Jarvis-like assistant
described in `presence-layer-design.md`. About 1.6 GB: an Electron desktop app
that brings its own Python 3.11 via uv, plus ffmpeg, ripgrep and browser tools.

**It is a complete, shipped implementation of the presence layer that document
proposes.** Its directory layout is the design's component list:

| Hermes | The design's name for it |
|---|---|
| `cron/` | the trigger loop |
| `memories/`, `sessions/` | continuity |
| `skills/` | the capability layer |
| `audio_cache/`, `stt` config | voice |
| `hooks/`, `pairing/` | events, devices |

So the question was not academic. It was whether to keep building or adopt.

## Decision

**Take components. Refuse the product.** Operator remains the thing the owner
talks to; Hermes is a parts bin and a reference implementation.

### Amended 2026-08-31 — `faster-whisper` is the wrong shape for Operator

Right about *local*, wrong about the implementation.

**`faster-whisper` is a Python library.** Hermes is a Python program, so it fits
there. `server/` is Node with one npm dependency by ADR 0012, and every external
capability it has spawns a **binary** — Edge for rendering, ffmpeg for the
microphone, a compiled exe for window work. Adopting faster-whisper means
adopting a Python runtime and its packages as a dependency of Operator, which is
a far larger decision than "use Whisper".

Two paths keep the intent without it:

- **`whisper.cpp`** — the same model as a standalone binary, fitting the spawn
  precedent exactly. Costs a binary download plus a ~150MB model, both package
  fetches in the sense `ollama pull` already is.
- **Windows' own recogniser** (`System.Speech`) — ships with .NET Framework,
  needs **no download at all**, fully on-device. Confirmed present here: one
  en-GB recogniser.

**Decision: start with the Windows recogniser.** It is worse than Whisper at
accuracy and it is free, immediate, and proves the whole path — clap, capture,
transcribe, act — with nothing to install. If accuracy disappoints in use,
whisper.cpp swaps in behind the same interface, and that interface will by then
have been shaped by real use rather than guessed at.

Same argument this ADR already makes about Hermes itself: take the component,
prove the shape, and only then commit to the heavier version.

### Taken — the local speech-to-text stack

`presence-layer-design.md` records that browser speech recognition streams
microphone audio to Google, and therefore that voice input needs local
transcription or it should not be built at all. It left *how* open.

Hermes answers it concretely, and the answer is adopted:

- **`faster-whisper`**, running locally. Nothing leaves the machine.
- **Silero VAD on**, so silence never reaches Whisper. This is not a
  refinement — Whisper decodes plausible text out of silence, and their config
  calls the VAD filter "anti-hallucination hardening" for that reason. Learning
  it from someone else's tuned config costs an afternoon less than learning it
  from a system that confidently transcribes a quiet room.
- **`base` as the starting model size**, with tiny/small/medium/large-v3/turbo
  as the ladder.

This is the same class of borrowing as headless Edge in `server/render.mjs`: a
solved component, no architectural opinion attached, no dependency added to
`server/`, nothing reaching an external host.

**This resolves open decision 1 in `presence-layer-design.md`.** Voice input is
local-transcription-only, and the stack is named.

### Taken — as reference only, no code

Its `config.yaml` has worked answers to four of the five harness gaps recorded
in [`devices-and-harness-notes.md`](../devices-and-harness-notes.md):
`compression` (context strategy), `delegation` (planning), `tool_loop_guardrails`
(repair loops), plus `prompt_caching` and `session_reset`. Worth reading before
building each. Read, do not import.

One incidental confirmation worth recording: its skills are `SKILL.md` files
with YAML frontmatter — the same format Claude Code uses — and its bundled
Airtable skill states its approach as *"REST API directly via `curl` using the
`terminal` tool. No MCP server, no OAuth flow, no Python SDK."*

That is `server/actions.mjs`'s philosophy, arrived at independently by a
different team. It is not evidence the capability layer is correct, but it is
evidence it is not eccentric.

### Refused — Hermes as the assistant

Three reasons, and the first is sufficient.

**1. It inverts the architecture.** `presence-layer-design.md` requires the
presence layer to sit *on top of* Operator, going through the capability layer
like any other worker. A Hermes skill that calls `operator-action.mjs` looks
like a shortcut and is the opposite of one: it makes Hermes the thing the owner
opens, and demotes Operator to a data source inside somebody else's product.

The test, stated plainly so a future session can apply it: **which one does he
open in the morning?** If the answer is not Operator, Operator has become a
backend for a product he does not control — which is what `vision.md` exists to
prevent.

**2. Two unapproved external hosts.** Its configuration references
**Browserbase** (remote browsers) and **Modal** (`TERMINAL_MODAL_IMAGE` — a
cloud sandbox for its terminal). Under `CLAUDE.md`'s external-application rule
each needs naming and approving, one host at a time, and neither has been.

Worth stating the honest tension: a cloud-sandboxed terminal is *better* than
Operator's, which [`threat-model.md`](../threat-model.md) says outright has no
sandbox and runs as the owner. Hermes is not careless here; it made a different
trade — isolation bought with someone else's infrastructure. Operator's rule is
that the infrastructure is the owner's. Both are coherent; only one is this
project's.

**3. Inherited answers are not understood answers.** Adopting it wholesale
means the five harness gaps get solved by configuration rather than by the
owner, which is fine for a product and wrong for the thing he is building to
own.

## What this does not decide

Running Hermes **as a reference** is fine and encouraged — a week of using it
tells the owner what talking to an assistant actually feels like, and whether
he wants voice triggers or just push-to-talk. That is research, not adoption,
and it is cheaper than discovering the answer after building it.

The line is that no Operator feature may depend on Hermes being installed.

## Consequences

**Good.** The hardest part of voice input — local transcription that does not
hallucinate — arrives as a named, working configuration rather than an
open question. The presence layer's first real decision is closed. No
dependency, no external host, no change to `server/`'s purity rule.

**The cost.** Voice is now a build rather than an install, so it is weeks
rather than an evening. That is the price of the thing being his, and it was
priced deliberately.

**Unresolved.** Whether `faster-whisper` at `base` is fast enough on an
i5-10400 with no usable GPU is untested. If it is not, the ladder goes *down*
to `tiny`, not out to a cloud transcription API — that would reintroduce
exactly the audio egress this decision exists to avoid.

## What would change this

Operator gaining voice, triggers and memory of its own makes Hermes redundant
as a reference and it should be uninstalled — 1.6 GB and a second agent with
terminal access is not something to leave lying around once it has stopped
teaching anything.

The refusal would be worth revisiting only if Hermes became something Operator
could *call* rather than something that calls Operator — a component, on this
machine, with no cloud dependency. That is not what it is today.
