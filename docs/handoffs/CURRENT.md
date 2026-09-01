# Current work

Nothing in flight. Everything is committed on `main`, tree clean, `dist/` built.

This note is mostly about **why the voice layer is not finished**, because the
parts are all working individually and it still does not feel like the thing.

## What the voice layer actually does today

Working, measured, on both the phone and the desk:

- The browser opens a **named** microphone (a picker, not the OS default — that
  was picking his Bluetooth headset over the Realtek beside it).
- Level is read locally at frame rate, so the core reacts with no network in
  the loop. A server poll can only ever be a quarter-second late.
- A segment ends **2s after he stops talking**, not on a timer.
- Typing is rejected by **voiced fraction**, not loudness — a keystroke peaks
  as loud as a syllable but lasts a fraction as long.
- Audio posts to his own server; the resident Whisper transcribes in **~282ms
  warm**. Nothing leaves the machine.
- The words land in the chat, or send straight through if `Send as I speak`
  is on.

## Why it still is not "JARVIS"

Four gaps, and none of them is transcription:

1. **It hears, then hands you text.** Saying "I did push day" should tick the
   gym off. `gym_toggle_exercise` already exists — what is missing is the model
   reliably turning a spoken sentence into an ACTION rather than a reply.
   *Mission: "Voice that does things, not just hears".*
2. **It does not know who he is.** Every store key is feature data; there is no
   slice about him. Claude Code resumes a *thread*, but a new tab is a stranger.
   Confirmed against a "build your own JARVIS" video whose step 5 is the same
   gap. **Local only** — Honcho and similar are hosted, and personal context is
   the most sensitive thing here. *Mission: "Persistent memory".*
3. **It cannot answer back when busy.** A second request queues silently. His
   idea, and it is better than the decision log's: Operator saying "that will
   wait behind the build" or "I will give that to Gemini, it is a lookup".
   *Mission: "Concurrency, and Operator answering back".*
4. **The voice is a system voice.** Best-available is now picked rather than the
   OS default (which was the worst one installed), but that is the free half.
   *Mission: "A real voice — Kokoro".*

## What OpenLive changed, 2026-09-01

`github.com/katipally/openlive` — a local-first voice+vision layer. **Not to be
adopted**: it is an Electron desktop app, and Operator is a tailnet web app that
has to work from a phone. But two of its choices are better than what is here,
and both missions were rewritten to take them:

- **Kokoro instead of Piper** for TTS. Local, on-device, 28 voices, and better
  regarded. Supertonic is its heavier 44.1kHz sibling.
- **A Smart-Turn end-of-turn model** instead of the 2s silence timeout, which is
  the crude version — it cannot tell a mid-sentence pause from being finished.

It also independently confirms the pipeline already built here: VAD → Whisper →
model → local TTS, with only the transcript leaving.

**Deliberately refused**, and the reasoning should survive: Deepgram and
ElevenLabs are hosted, so his voice would go to a company — the same reason iOS
`SpeechRecognition` was refused. **Gemini Live** is tempting and fast, but the
2026-08-20 approval covers prompts and job context; streaming continuous
microphone audio is a different class and needs naming as such. **AirLLM** was
looked at and rejected on merit: it makes big models *possible* on 4GB by
streaming layers off disk, and explicitly not *fast* — it publishes no
end-to-end latency at all. The problem here is answer speed, not model size.

## The hardware position

Measured on the machine, not argued:

- **0.45 GB free of 15.7** at one point, with four MuMu instances running. A
  cold Whisper load took **68 seconds** under that pressure and **282ms** warm.
  32GB of DDR4 (~£50) is the best-value fix and keeps the emulators.
- **4GB VRAM** caps the local model at 3B, which is why semantic verification
  scores 2/3. A 12-16GB card is what makes local AI capable rather than merely
  resident — and it belongs in his own box, not a friend's homelab, because a
  remote Ollama is an external host under his own rule.

## Live infrastructure

- ntfy from `%LOCALAPPDATA%\ntfy`, loopback `:8090`, tailnet `:8095`. All
  notifications are **priority 4+** — anything lower arrives silently.
- `OPERATOR_LISTEN` is `Microphone (Realtek USB Audio)`.
- `OPERATOR_SEMANTIC_VERIFY=1`.
- Scheduled task is **`OperatorServe`**.

## The restart trap, still true

`POST /api/restart` and `schtasks /End` **both fail to reload the environment**
while the supervisor survives — they look like restarts and are not. Stop the
three processes by PID (`npm run serve` → `supervise.mjs` → `index.mjs`), then
`schtasks /Run /TN OperatorServe`. The banner in `serve.log` is the only honest
signal that the `.ps1` ran and read the registry.

## Next

His order: **concurrency + spoken acknowledgement**, then memory. I would argue
memory first — concurrency makes it faster, memory makes it his — but that is
his call.
