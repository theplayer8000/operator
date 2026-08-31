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

## Next

Restart, watch the chip, then the three he asked for on top of this: tool
relevance filtering, semantic verification, self-hosted ntfy.
