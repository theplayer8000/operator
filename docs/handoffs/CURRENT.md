# Current work

**Voice-reactive mission map** — the live node graph pulses when Operator hears
him and pulses differently when it answers. His brief: "kinda want a ui for
voice but that should be the live node graph pulsing when it detects my voice
and same when its giving feedback."

The point is that there is **no voice widget**. The map is the voice interface,
so you look at one thing and know which of the two is happening from across the
room without reading anything.

## What landed

- **`GET /api/listen`** (`server/index.mjs`) — `listening`, `device`, `level`,
  `threshold`, `claps`, `reason`. Cheapest route in the file: numbers already in
  memory, because the map polls it at 250ms. Deliberately says **nothing about
  speaking** — speech out is `SpeechSynthesis` in the browser, so the server
  genuinely does not know, and `speaking: false` there would be a confident lie
  in an API rather than an absent field.
- **`src/hooks/useVoiceActivity.ts`** (new) — hearing from the server, speaking
  from `speechSynthesis` directly. The two are polled independently on purpose:
  on a machine with no microphone `/api/listen` fails every time, and speaking
  must still work. A hidden tab reports silence rather than freezing its last
  level.
- **`src/components/dashboard/MissionGraph.tsx`** — a full-canvas wash plus a
  per-node halo that scales with loudness. **Gold = hearing, violet = speaking**,
  two colours rather than one "audio" light, because those are exactly the two
  states worth telling apart. Node halos are delayed `(i % 6) * 60ms` so
  loudness travels across the map instead of every node throbbing together — a
  synchronised pulse reads as a loading spinner. The node circle itself does not
  grow, so no click target moves.
- Header chip: `listening` / `hearing` / `speaking`. Absent entirely when the
  listener is off — a still map is otherwise ambiguous between a quiet room and
  a dead microphone.

## Verified

- `npx tsc -b` clean, `node --check server/index.mjs` clean (real node at
  `C:\Program Files\nodejs\node.exe`, not the shadowed one).

## Not verified — needs the restart

`/api/listen` currently 404s: `server/` is loaded at boot, so the route is not
live until the server restarts. **Nothing about the visual behaviour has been
seen yet.** The level scaling (`level / threshold`, floor 0.004, visible above
0.35) is reasoned from the measured figures — his speech peaks ~0.0009 against a
~0.0007 room floor, with 30dB gain applied — not observed. Expect to tune it.

## Phantom jobs from hallucinated speech — fixed, needs a restart

Found in `data/serve.log` on 2026-08-31. The clap gesture created **about
twenty jobs from nothing** (`job-4` through `job-23`), each a real Claude Code
turn against the $10 ceiling. One reached the point of asking permission to run
git.

Cause, in two parts:

1. **`transcribe.py` reported meaningless confidence.** It printed
   `info.language_probability` from `base.en` — an English-only model, so that
   value is a constant ~1.00. It measured nothing about whether words were
   said.
2. **`index.mjs` never checked confidence anyway.** Any non-empty transcript
   became a job.

So Whisper's stock silence-fillers — "Thanks for watching!", "Mm-hmm",
"Okay.", "Thank you." — went straight through. Those are the model's
best-known hallucinations: fed silence it emits YouTube end-cards, confidently.

Fixed:

- `transcribe.py` now drops segments by the model's OWN verdicts
  (`no_speech_prob` > 0.6, `avg_logprob` < -1.0), then by a blocklist as a
  backstop, then reports confidence derived from `avg_logprob`. Scores first
  on purpose — a blocklist only catches what someone has already seen.
- `index.mjs` gates job creation on confidence ≥ 0.55, voiced fraction ≥ 1.5%,
  and ≥ 2 words. Biased towards dropping: a missed command costs one more clap,
  an invented one costs money and a tab.

**Not yet observed working.** Needs a restart and a real clap test.

## Also visible in that log

- The 60s listener backoff works — `backing off to 60s retries`, then it kept
  trying, where before it stopped dead.
- `clap: nothing heard (peak 1)` recurs: the capture is **clipping**. 30dB of
  gain is too much for the headset. Likely resolves itself with the boom mic
  (set `OPERATOR_LISTEN_GAIN` to 0 then), but worth measuring rather than
  assuming.
- `server/actions.mjs:389` crashed the server once with an unterminated string
  (`].join("`). Recovered, but that came from the in-app agent — worth knowing
  it can happen.

## Next

Restart and test a clap. Then the three: tool relevance filtering, semantic
verification, self-hosted ntfy. `/map` as its own route is still unbuilt and
he has asked for it twice.
