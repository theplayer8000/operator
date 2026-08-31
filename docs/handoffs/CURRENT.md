# CURRENT — work in progress

**Updated:** 2026-08-31
**`main`:** clean and pushed.
**Workers:** Claude Code, Gemini, Local (Ollama, `qwen2.5:3b`).
**Terminal:** armed. Disarms on a full restart, not on the API one.
**Rule:** see *"Every piece of work keeps a live handoff"* in `CLAUDE.md`.

## Voice works, end to end

Clap twice → Operator comes to the front on screen 2, fullscreen → it records
→ transcribes locally → starts a job from what you said. Proven in the log:

```
[operator] clap heard: "Okay."
[operator] clap heard: "And it is us."
```

- **Detection** — `server/listen.mjs`, ffmpeg on a named device. Runs on the
  machine, not in a tab, so it works while you are looking at something else.
- **Transcription** — `faster-whisper` via `uv`, spawned with a text interface.
- **The window** — `server/win/OperatorWin.exe`, compiled from
  `OperatorWin.cs` by `node scripts/build-win.mjs`. ~235ms, was ~1500ms.
- **Speech out** — the speaker icon in the Orchestrator header, with a voice
  picker. On-device, and the only voice feature that works at the bare IP.

The clap no longer pauses your music; `media_play_pause` remains as its own
action.

## ⚠ Three traps that cost a whole evening

1. **`POST /api/restart` does NOT reload the environment.** `supervise.mjs`
   relaunches `index.mjs` with the env the supervisor already has; the wrapper
   that reads the registry only runs when Task Scheduler starts the supervisor.
   Device switches made through the restart button silently did nothing.
   **Env changes need `schtasks /end` + `/run`** — which also disarms the
   terminal, so re-arm after.
2. **A second ffmpeg on the same dshow device records digital silence.** This
   looked exactly like three broken microphones and was one held device — the
   clap listener owns it permanently. Capture takes audio from the stream
   already open, with a 2s pre-roll.
3. **A clap clears a badly-set input level; a voice does not.** Speech measured
   0.0009 against a 0.0007 room floor while a clap on the same mic hit 0.352.
   Every "it doesn't work" was that gap. `OPERATOR_LISTEN_GAIN=30` fixed it.

## Waiting on hardware — arriving 6–13 September

An Attack Shark keyboard, **a boom mic**, **a webcam**, and a coiled cable.

The boom mic is the one that matters: current transcripts are rough because the
Bluetooth headset barely registers speech, and one capture peaked at **1.0**,
which is clipping.

It is a **dynamic XLR/USB mic with a hardware gain knob**, which is a better
fit than it looks. Hardware gain acts before the converter, so it lifts speech
without amplifying the noise `OPERATOR_LISTEN_GAIN` cannot avoid — **set the
knob and put the software gain back to 0.** Dynamic capsules also reject room
noise far better than condensers, which matters with a mechanical keyboard
arriving in the same order. Its 50Hz–12kHz range is not a limitation here:
Whisper runs at a 16kHz sample rate and cannot use anything above 8kHz anyway.

When it arrives:

```
setx OPERATOR_LISTEN_GAIN 0
setx OPERATOR_LISTEN "<new device name>"
```

`ffmpeg -list_devices true -f dshow -i dummy` prints the exact name. Then a
**full** restart, per trap 1.

Two things about that mic that will otherwise cost an evening:

- **Set the reverb/echo knob to zero.** Reverb smears the tail of each word and
  Whisper transcribes the smear as extra syllables.
- **It has a physical mute button, which Operator cannot see.** Muted, it
  produces exactly the `peak 0.0007` reading that trap 3 above describes, with
  nothing in software able to say why. Check the button first.

The webcam feeds the camera work in
[`devices-and-harness-notes.md`](../devices-and-harness-notes.md), and has a mic
of its own as a fallback.

## Next — verification

The gate on everything proactive. **You are the verification step today**: you
read every result and decide whether it was right. A presence layer that speaks
first is by definition acting unwatched, so nothing above it is safe until
something else can check the work. It is also the right first job for the local
model — checking is cheaper than doing.

After that, in rough order: **tool relevance filtering** (all ~35 actions go to
every worker every turn, and that already made Gemini pick the wrong one),
**Piper** for a real voice, **ntfy** so Operator can reach you, and the **live
layer** on the mission map — which needs the concurrency now decided in
`CLAUDE.md` (several turns, `OPERATOR_MAX_CONCURRENT`, default 1, unbuilt).

## Still waiting on the owner

- **`server/winhelper.mjs`** — untracked, superseded by the compiled helper.
  `cmd /c del "D:\Projects\operator\server\winhelper.mjs"`
- **`OPERATOR_USAGE_BUDGET_USD=10`** is a stopgap, not ADR 0013's ceiling: it
  resets each restart and counts valuation dollars, not credits.
- **76 permission rules** in `.claude/settings.local.json`, some granting
  arbitrary execution, and `greptile` enabled against ADR 0014 — see
  [`2026-08-27-claude-code-health-check.md`](2026-08-27-claude-code-health-check.md).
