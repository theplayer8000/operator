# Current work

Nothing in flight. Everything below is landed, verified, and committed on
`main`; `dist/` is built from it.

## What landed on 2026-08-31

- **`/map`** — the full-screen live mission map, outside `AppLayout`. Canvas,
  continuous physics you can grab and throw, pan/zoom, motes riding the
  dependency strands. A **core** at the centre — Operator's heartbeat — with
  four states: idle, hearing, speaking, thinking (a turn actually running,
  polled from `/api/jobs`). The owner has seen it and approved the look.
- **Voice reacts on the map** rather than in a widget. Gold hearing, violet
  speaking.
- **Phantom jobs fixed.** Whisper's silence-fillers ("Thanks for watching!",
  "Mm-hmm") were creating real Claude Code turns — about twenty of them.
  `transcribe.py` now scores segments and `index.mjs` gates on confidence,
  voiced fraction and word count.
- **Persistent transcriber.** 5.0 s → 1.3 s per sentence by holding the model
  in memory instead of reloading it per utterance.
- **Tool relevance filtering.** 39 actions were sent to Gemini and Ollama every
  turn — 17,001 chars against Ollama's 4096-token window. Now keyword-scoped;
  "what time is it" sends 4.
- **A third auth tier** (capability), so using Operator's own data no longer
  needs execution rights. Terminal and jobs unchanged.
- **Self-hosted ntfy**, verified arriving on his phone. Mission closed.
- Clap no longer touches media. Vite tasks moved out of a session scratchpad.

## Live infrastructure worth knowing

- ntfy runs from `%LOCALAPPDATA%\ntfy` on `127.0.0.1:8090`, tailnet-exposed at
  `:8095`. Config `server.yml`, topic in `topic.txt`. Five `tailscale serve`
  entries now — CLAUDE.md documents three, and 7443 (Darams CRM) was already
  undocumented before this.
- Scheduled task is **`OperatorServe`**, not "Operator".

## The restart trap, confirmed the hard way

`POST /api/restart` and `schtasks /End` **both failed to reload the
environment.** The supervisor had been alive since 05:43 and every restart
relaunched `index.mjs` as its child with the supervisor's stale env, so
`OPERATOR_NTFY_*` never arrived. It looked restarted and was not.

The reliable sequence is to stop the three processes by PID — `npm run serve` →
`supervise.mjs` → `index.mjs` — then `schtasks /Run /TN OperatorServe`. Confirm
by the banner: a real cold start prints `==== serve started ... ====` and the
env lines under it. **No banner means the `.ps1` never ran and nothing you
changed in the registry is loaded.**

## Next, in the owner's own order

1. **Embed the Orchestrator chat into `/map`.** He called it "soon gnna be my
   main ui".
2. **Make `/map` the page the app opens on.**
3. Voice endpointing — the recording window is a fixed 6 s, so a 1.5 s question
   still waits 6. That is now the largest remaining latency, bigger than
   transcription.
4. Semantic verification (`Job verification`, 55%).
5. Concurrency — `OPERATOR_MAX_CONCURRENT`, decided 2026-08-31, unbuilt.

## Known-bad right now

The clap listener is failing: `OPERATOR_LISTEN` names
`Headset (Tosin's Headphones)` and it is disconnected. It retries every 60 s and
will pick the headset up on its own when it reconnects — no restart needed.
New mic arrives 6-13 Sept; set `OPERATOR_LISTEN` to it and `OPERATOR_LISTEN_GAIN`
to 0 then, from a normal shell, never Operator's terminal.
