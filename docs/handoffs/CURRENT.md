# Current work

Nothing in flight. Committed on `main`, `dist/` built, server restarted.

## Where things got to, 2026-09-01/02

**Speech changes data.** `server/intentrun.mjs` runs matched intents through the
capability layer. Guards rather than trust: a resolver that finds nothing
abandons, ambiguity becomes a spoken question, create/delete refused
independently of the rules.

**"Stop" works**, and is the one command written to fire when unsure — a wrong
stop costs a retry, a missed one costs money. Barge-in works because overlapped
audio is uploaded flagged rather than discarded, and only a stop may come out of
it.

**Notifications are Web Push**, ntfy retired. Apple carries an encrypted payload
it cannot read. Arrives as Operator, with Operator's icon.

**The page follows changes it did not make.** `/api/health` reports the store's
`updatedAt`; the client polls that and only fetches data when it moves. Adaptive
— 800ms for 15s after a change, 4s at rest.

**The desktop shell exists.** ADR 0015, Tauri, 12MB. It compiles, opens, and
shows the real map. `main.rs` registers nothing native yet, deliberately.

## The digest earned its keep

`scripts/intent-misses.mjs` collected 26 real utterances: 3 matched, 23 missed.
The largest genuine cluster was **asking what is on the gym** — so that became
the first rule in `intent.mjs` written from evidence rather than invention.

It is a READ, placed above the question guard alongside `matchClock`, and it may
only ever emit `gym_day`. The guard is about writes, not about question marks;
`matchClock` had already established that position for the same reason.

Self-test is 109 checks, and the boundary is pinned both ways — "should i do
push day tomorrow" and "how did my gym session go" must still fall through.

**The rest of the misses are mostly Whisper noise** ("And... Huh...", "Okay,
thanks.") and one instance of Operator hearing itself, which the 400ms release
tail should now stop. Do not write rules for those.

## Next

- **Tauri natives**: microphone without a gesture, global hotkey, output device
  selection, tray. Background listening **off by default and visibly so**, and
  the clap detector becomes a toggle — the owner's condition on accepting 0015.
- **Usage ceiling** (ADR 0013). `OPERATOR_MAX_CONCURRENT` is 3 and nothing
  bounds spend.
- **Keep reading the digest.** Every four hours, `OperatorIntentDigest`.

## Environment

- `OPERATOR_TTS_IDLE_MS=14400000` (4h). Was 15 min, which made the first reply
  after a quiet spell take 8.5s instead of 1.0s. Set to `0` — never release —
  once the 2x8GB lands; free RAM touched **2.33GB** during the Rust build, so
  holding 300MB permanently is not free yet.
- `OPERATOR_VAPID_PUBLIC` / `_PRIVATE` / `_SUBJECT` for push, env only.
- `OPERATOR_LISTEN` is `Microphone (Realtek USB Audio)`, which is the **default
  communications device** while the headset is the default device. Clap works.

  **A measurement I got wrong:** I reported that input as dead at −91 dB. It was
  not. `listen.mjs` holds the dshow device open, so a second ffmpeg reading it
  gets a silent stream — the exact trap written up in `useMicLevel.ts`. Do not
  measure a device Operator is already listening on.

## The restart trap, still true

`POST /api/restart` and `schtasks /End` **do not reload the environment** while
the supervisor survives. Stop all three by PID (`npm run serve` →
`supervise.mjs` → `index.mjs`), then `schtasks /Run /TN OperatorServe`.

## Two files to delete by hand

`scratch-gymrun.mjs` and `.probe-intent.mjs` in the repo root — debris from
today, left because deletion is denied to this session by design.

```
rm scratch-gymrun.mjs .probe-intent.mjs
```
