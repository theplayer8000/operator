# Current work

## Restarting now to load the VAPID keys — 2026-09-01

ntfy is retired; notifications go by **Web Push** (`server/push.mjs`,
`server/subscriptions.mjs`, `public/sw.js`, `src/hooks/usePush.ts`).
`notify()`'s signature is unchanged, so no caller was touched.

`OPERATOR_VAPID_PUBLIC` / `_PRIVATE` / `_SUBJECT` are set at user scope but the
running server was started before them — `/api/push/key` answers
`configured:false`. That is the documented restart trap, not a bug in the keys.

**After the restart:** Settings → Notifications → Turn on, from the home-screen
app on iOS (Safari cannot subscribe, and the prompt needs a real tap).

**A key was printed into a Claude session transcript while building this.** If
that pair is still in use, regenerate: `node scripts/push-keys.mjs`, re-`setx`,
restart, and every device re-subscribes.


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

## Intent is LIVE — `server/intentrun.mjs`, 2026-09-01

**Needs a server restart to take effect.** Written, built, tested, not yet
running.

The owner asked for observe-only to end. The concern that held it back is not
answered by switching it on, so it is answered by three guards in
`intentrun.mjs`: a resolver that finds nothing abandons rather than running the
action with what it has; ambiguity becomes a spoken question rather than a coin
toss; and create/delete actions are refused independently of what the rules
emit. Everything goes through `runAction`, so a spoken tick is indistinguishable
from a tapped one and notifies his phone the same way.

Tested against the real store, not invented phrases:

- `"set the control plane mission to sixty percent"` → ran, said "The control
  plane is at 60%."
- `"tick off my morning routine"` → ticked **5**, skipped the one already done,
  said "Ticked off 5 morning things." State restored afterwards.
- `"yeah i did push day"` → abandoned, "no gym session today" (1 Sep is a rest
  day). The `expect` check means saying it on a leg day abandons too.
- `"tick off bench press"` → abandoned safely, but see the known mis-route
  below.

### Two things found while testing, both still true

1. **"tick off bench press" routes to the ROUTINE, not the gym.**
   `intent.mjs` matches it as `routine_toggle_task`. The guard catches it — no
   routine step is called that, so it abandons and says so — but the right
   answer is `gym_toggle_exercise`. A rules fix in `intent.mjs`, not in the
   runner.
2. **`needs.match` is where the name lives, not `params`.** The first version of
   the resolvers read `params.exerciseName`, which is never set — every intent
   would have silently abandoned. The contract is `{match, each, skipDone,
   unique, expect}`, and `each: true` means run the action once per candidate.

## Phone was silent — fixed, same restart

iOS grants audio playback **per `<audio>` element**, and only from a user
gesture. `speakLocally` created `new Audio()` per sentence, so every element was
untouched and permanently blocked; `play()` rejected into a catch that fell
through to the system voice, which iOS blocks for the same reason. One shared
element now, unlocked on the first tap (`unlockSpeech`).

**Also check the speaker icon in the chat is on** — it defaults to off and is
stored per device, so turning it on at the desk does nothing for the phone.

## Saying "stop" now stops it — 2026-09-01, needs the same restart

He hit the failure this exists for: Whisper heard **"Head off my morning
routine"** for "tick off", the intent rules correctly declined to match it, so
it went to a worker — *"it does things im not even asking it to do"* — and there
was no way to cut it short.

- `matchVoiceCommand` gains **`stop`** (`server/voicecommand.mjs`), checked in
  `/api/listen/transcribe` **before** arming, before the intent router, before a
  job is created — every one of those is something "stop" might be preventing.
- `jobs.stopAll()` cancels everything running or queued, whoever started it, and
  clears the wait list so `pump()` cannot revive a queued job.
- **The asymmetry is deliberately REVERSED from arming.** Everything else in
  that file refuses when unsure; stop fires when unsure. A false stop costs one
  retry, a missed stop costs money. Bare "stop" counts, capped at 25 characters.
- `node server/voicecommand.mjs --self-test` — 30 phrases, and the must-NOT list
  matters as much: "waiting on the build" must not match (the `` after `wait`
  is what saves it), and "head off my morning routine" must fall through to the
  router rather than being swallowed here.

### Barge-in: the self-hearing guard would have blocked this

Yesterday's fix discarded any segment recorded while Operator was talking. But
"stop" is said **precisely while it is talking**, so the case that matters most
would never have reached the server.

Overlapped audio is now **uploaded with `x-overlapped: 1`** instead of dropped,
and the server honours **nothing but a stop** from it. The feedback loop stays
closed — Operator's own sentence still cannot become a request — while the one
word that has to get through does. The client also calls `speech.stop()`, so it
stops mid-sentence rather than finishing the paragraph it was interrupted in.

## The pre-allow list was silently broken — fixed

Three of the four full-path `operator-action` rules in `server/jobs.mjs`
contained **literal newlines** and could never match. Written as plain quoted
JS strings, so `\P` dropped its backslash and `
` in `
odejs` became a line
break. They were added to fix "two permission prompts for one command", looked
correct in review, and did nothing.

**A pre-allow rule fails silently** — an entry matching nothing is
indistinguishable from an entry never added. Verified after fixing: 91 rule
literals, 0 containing a newline. If you edit that list, print it and read what
the strings actually contain.

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
