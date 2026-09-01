# Current work

Nothing in flight. Committed on `main`, `dist/` built.

## Where the voice layer got to, 2026-09-01

The four gaps this note listed a day ago are now three-quarters closed. What
changed today:

- **Operator no longer hears itself.** Kokoro spoke through the speakers, the
  microphone recorded it, Whisper transcribed it as though he had said it. Left
  alone that is a feedback loop — it answers, hears itself, answers again. A
  segment that Operator talked over is now discarded whole rather than trimmed,
  because half his sentence and half Operator's is still confidently sent
  somewhere.
- **The speaking signal covers both voices.** `useVoiceActivity` read
  `speechSynthesis.speaking`, which was complete until Kokoro arrived — Kokoro
  plays through an `<audio>` element that `speechSynthesis` knows nothing about,
  so the guard above would have been dead on the common path. There is now one
  module-scoped signal in `useSpeech.ts` that both voices set.
- **`scripts/intent-misses.mjs`** reads `serve.log`, groups what fell through by
  word overlap, and (`--notify`) sends a short digest to his phone. Scheduled
  every four hours as **`OperatorIntentDigest`**. Silent when nothing missed.

## Why the model does not write the intent rules

He asked whether qwen could watch the misses and update the router. The
grouping half is what got built. The writing half was refused on purpose:
`intent.mjs` decides whether speech **modifies his data**, a bad pattern is a
false positive is an unwanted write, and qwen2.5:3b scores 2/3 on semantic
verification and has hallucinated agreement outright. It summarises; a person
writes the rule. It is also source code, and the capability layer exists so a
model changes data rather than code.

## The one gap left

**Intent is still observe-only.** `server/intent.mjs` logs what it *would* have
done and runs nothing. That is deliberate — every phrase in its 103 tests was
invented, and shipping a rule set on invented evidence is the guessed-clap-
threshold mistake repeated. The digest is how the real evidence arrives. Do not
switch it live until the misses have been read.

Three resolvers (`gym_exercise`, `routine_step`, `mission`) are blocked on the
same evidence.

## Live infrastructure

- ntfy from `%LOCALAPPDATA%\ntfy`, loopback `:8090`, tailnet `:8095`. All
  notifications are **priority 4+** — anything lower arrives silently.
- `OPERATOR_LISTEN` is `Microphone (Realtek USB Audio)`.
- `OPERATOR_SEMANTIC_VERIFY=1`. `OPERATOR_MAX_CONCURRENT=3`.
- Scheduled tasks: **`OperatorServe`**, `OperatorViteMain`, `OperatorViteAgent`,
  `OperatorSdkProbe`, **`OperatorIntentDigest`**.
- Every task launches through `scripts/hidden.vbs` so no console window sits on
  the desktop. **`hidden.vbs` takes ONE argument** — a command line with its own
  quotes cannot survive being nested inside the task's quoted argument, and
  registering it that way leaves the task hung in "running" forever. Point it at
  a `.cmd` file, as `scripts/intent-digest.cmd` does.

## The hardware position

- **0.45 GB free of 15.7** at one point, with four MuMu instances running. A
  cold Whisper load took **68 seconds** under that pressure and **282ms** warm.
  32GB of DDR4 (~£50) is the best-value fix and keeps the emulators.
- **4GB VRAM** caps the local model at 3B, which is why semantic verification
  scores 2/3 and why qwen is not trusted to write rules. A 12-16GB card is what
  makes local AI capable rather than merely resident — and it belongs in his own
  box, because a remote Ollama is an external host under his own rule.

## The restart trap, still true

`POST /api/restart` and `schtasks /End` **both fail to reload the environment**
while the supervisor survives — they look like restarts and are not. Stop the
three processes by PID (`npm run serve` → `supervise.mjs` → `index.mjs`), then
`schtasks /Run /TN OperatorServe`. The banner in `serve.log` is the only honest
signal that the `.ps1` ran and read the registry.

## Next

Read the first few digests. Then the usage ceiling (ADR 0013) — one job at a
time bounded spend by wall-clock, and three do not.
