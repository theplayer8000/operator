# Current work

Nothing in flight. Committed on `main`, `dist/` built, server restarted with the
new worker live.

## FIRST THING TO CHECK — it is probably not broken

Speech is **off by default and stored per device**, and the Tauri window is its
own storage profile from the browser. Symptom: Operator answers correctly on
screen and says nothing, which reads exactly like the feature failing.

The map now prints the reply in gold with `muted — tap the speaker in the chat
to hear replies` underneath. If that line is showing, that is the answer.

## Landed 2026-09-02

- **AI Router** ([ADR 0016](decisions/0016-ai-router.md)) — flat CHF 39/mo,
  Swiss, OpenAI-compatible with real tool calling. Verified end to end: a `now`
  tool call answered correctly in **1641ms**. It replaces the LOCAL model, not
  Claude. Reports `basis: "billed"` with a **null** cost, never $0.
- **Usage ceilings** (ADR 0013) — tokens stored, USD derived, nothing sums
  across `basis`, quota is a separate ledger. All ceilings env-only and unset by
  default, so nothing is enforcing yet.
- **"tick off bench press"** reaches the gym via `needs.also`, a fallback chain
  tried only where the primary found nothing. 121 self-test checks.
- **Voice output picker** (Settings) — `setSinkId` on the shared audio element.
- **Desktop shell**: Ctrl+Alt+O, tray with a two-state microphone, clap summons
  only when unfocused, fullscreen on `OPERATOR_FOCUS_SCREEN`, Escape backs out.
  Release build is 6.2MB.

## Next, agreed with the owner

**Hosted Whisper + TTS through AI Router, with local as the fallback.**
Approved on 2026-09-02, and the reasoning is RAM rather than speed:

- Local Whisper is already **287ms warm** — transcription is the SMALLEST part
  of a spoken exchange. The 1200ms silence window is the real latency, and the
  fix for that is a smart-turn model, not a hosting change.
- What it does buy is memory. Kokoro holds ~300MB resident and Whisper its own
  model, on a machine that hit **2.33GB free** during the Rust build.

So: build it switchable, hosted first, and **fall back to local once the 2×8GB
arrives** (Facebook Marketplace, no date). An env var, defaulting to local, so
the machine that has RAM keeps its voice on the box.

**This crosses a line held three times** — Deepgram, ElevenLabs and iOS
`SpeechRecognition` were all refused because they send AUDIO OF HIM rather than
text he chose to send. ADR 0016 approved prompts and job context, not voice.
Extend that ADR with an explicit audio clause before writing the code; do not
treat the existing approval as covering it.

## Environment

- `AIROUTER_API_KEY` set. `OPERATOR_TTS_IDLE_MS=14400000` (4h) — set to `0` when
  the RAM lands, which removes the 8.5s cold start entirely.
- `OPERATOR_FOCUS_SCREEN=1`, `OPERATOR_MAX_CONCURRENT=3`.
- Four workers registered: claude-code, gemini, airouter, ollama.

## The restart trap, still true

`POST /api/restart` and `schtasks /End` do NOT reload the environment while the
supervisor survives. Stop all three by PID, then `schtasks /Run /TN OperatorServe`.

## Debris to delete by hand

Deletion is denied to the agent session by design:

```
rm scratch-also.mjs scratch-chain.mjs scratch-undo.mjs scratch-air.mjs
```
