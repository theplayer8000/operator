# 2026-09-01 — the voice layer starts acting

The milestone: speech stopped being transcription that a worker then answered,
and became something that changes data directly. Plus the two bugs that were
stopping the phone being usable at all.

## Restart required

`server/` changed. **Nothing in this handoff is live until the server restarts.**

```
# Stop all three by PID: `npm run serve` -> supervise.mjs -> index.mjs
schtasks /Run /TN OperatorServe
```

`POST /api/restart` and `schtasks /End` do **not** reload the environment while
the supervisor survives. Env did not change here, so `/api/restart` is enough
for this one — but the banner in `serve.log` is the only honest confirmation
that a real restart happened.

## What shipped

### 1. Matched intents now run — `server/intentrun.mjs`

`intent.mjs` turned a sentence into a capability action and stopped. This is
the missing half: the three resolvers it declares, plus the code that calls
`runAction`.

Observe-only existed because every one of its 103 test phrases was invented.
The owner asked for it to end, which is his call. Switching it on does not
answer the concern, so the concern is answered by guards instead:

1. **A resolver that finds nothing abandons.** It never runs the action with
   what it has. This is what makes a wrong match harmless rather than
   destructive.
2. **Ambiguity becomes a spoken question**, not a coin toss. Two exercises
   matching "press" equally well returns "Did you mean X, or Y?".
3. **Create and delete are refused independently** of what the rules emit — a
   second lock on the same door, so widening the rules later stays safe.
4. **`expect` is checked first.** "I did push day" on a leg day abandons rather
   than ticking off a session he did not do.

Everything goes through `runAction`, the same function the CLI and every AI
worker call. So a spoken tick is indistinguishable from a tapped one, and it
sends the same notification — which is what makes a wrong match visible in
seconds instead of discovered days later.

**Two bugs found by testing against the real store**, neither of which the
103-test suite would ever have caught:

- **The name lives in `needs.match`, not `params`.** The first version read
  `params.exerciseName`, which is never set. Every intent would have abandoned
  silently while appearing to work.
- **`each: true` means run the action once per candidate.** "I did push day" is
  one sentence and N writes, so the unit is a list of fills. Already-ticked
  ones are skipped, or it unticks the half he did from his phone at the gym.

Measured, with state restored afterwards:

| Said | Outcome |
|---|---|
| "set the control plane mission to sixty percent" | ran → "The control plane is at 60%." |
| "tick off my morning routine" | ticked 5, skipped the 1 already done |
| "yeah i did push day" | abandoned — 1 Sep is a rest day |
| "tick off bench press" | abandoned — see below |

### 2. iOS was never going to speak

Not a setting, not Kokoro, not the server. **Audio playback is granted per
`<audio>` element and only from a user gesture.** `speakLocally` built
`new Audio()` for every sentence, so each one was an element the user had never
touched — permanently blocked. `play()` rejected into a catch that fell through
to the system voice, which iOS blocks for the same reason. Two engines, one
cause, no error anywhere.

One shared element now, unlocked by the first tap (`unlockSpeech`, called from
the mic buttons and from a one-shot global `pointerdown`).

**Separately: the speaker icon in the chat defaults to off and is per device.**
Turning it on at the desk does nothing for the phone.

### 3. Statistics hid its only readout behind hover

A phone has no hover, so the shipped chart was gold bars with nothing to read
them against — the owner's words: *"on the graphs its not rlly info giving"*.
Now tap-to-inspect, a dashed line at the daily average so 34 reads against
"the usual day is ~3.6", and a readout that always shows a value.

This also broke a rule the design system already had. Worth checking the rest
of the app for the same shape.

### 4. Earlier the same day

- **Operator stopped transcribing its own voice.** Kokoro spoke, the mic heard
  it, Whisper transcribed it as the owner — a feedback loop. Segments it talked
  over are discarded whole.
- **The speaking signal covers both voices.** `speechSynthesis.speaking` was
  complete until Kokoro arrived; Kokoro plays through an `<audio>` element it
  knows nothing about.
- **`scripts/intent-misses.mjs`** + the `OperatorIntentDigest` task, every four
  hours, notifying only when something fell through.

## Outstanding

1. **"tick off bench press" routes to the routine, not the gym.** `intent.mjs`
   matches it as `routine_toggle_task`. The guard catches it and abandons, so it
   is safe, but the answer is wrong. **A rules fix in `intent.mjs`.**
2. **Phrases that match nothing yet**, found while probing: "mark today as a
   rest day", "remember that I prefer short answers", "what's on my calendar",
   "I finished incline dumbbell press". The digest is the right way to find the
   rest — from real speech, not more invented phrases.
3. **The usage ceiling** (ADR 0013) is still unbuilt, and `OPERATOR_MAX_CONCURRENT`
   is 3. One job bounded spend by wall-clock; three do not.
4. **`memory.mjs` only remembers what it is told**, not what it notices.

## The next session's job

The owner is going to use it rather than build on it, deliberately: *"intent
layer needs developing and im only gonna get that thru using it"*. That is the
right call — the whole reason observe-only existed was the absence of real
evidence, and the digest now collects it automatically.

**So do not write new intent rules from imagination.** Read
`node scripts/intent-misses.mjs` first. What falls through in real use is the
work list; anything else is repeating the mistake that made the first 103 tests
worthless.

## Risks

- **Intent writes without a confirmation step.** That is the design — the
  notification is the confirmation, and every action it can reach is a toggle or
  a value that can be set back. But there is no undo (**OPS-020**), so a wrong
  match found late is a manual fix.
- **Untested in production.** Everything above was exercised through Node
  directly, not through a microphone. The first real sentence is the first real
  test.
