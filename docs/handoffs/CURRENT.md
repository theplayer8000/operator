# Current work

Nothing in flight. **`main` is 37 commits ahead of `origin` and needs pushing by
hand** — see the bottom of this file.

## FIRST THING TO CHECK — it is probably not broken

Speech is **off by default and stored per device**, and the Tauri window is its
own storage profile from the browser. Symptom: Operator answers correctly on
screen and says nothing, which reads exactly like the feature failing.

The map prints the reply in gold with `muted — tap the speaker in the chat to
hear replies` underneath. If that line is showing, that is the answer.

## Landed 2026-09-02 (evening) — Claude dispatches, the others do the reading

The owner's ask: *"claude opus 5 as the main bit taking in everything and
dispatching and the other models helping so claude doesnt have to be the heavy
worker anymore but it can be if needed."*

`routing.mjs` already did half of that — it picks which worker takes a JOB. What
was missing is the other half: once Claude has a job, it read everything itself,
at Claude's price, into Claude's context.

- **`server/delegate.mjs` + `scripts/delegate.mjs`** — the dispatching worker
  hands one piece of work down and gets prose back. Measured on its own source:
  local 3B **101.7s**, two of five environment variables found; AI Router
  **6.8s**, all five.
- **Two refusals are structural, not advisory.** The sub-task gets `useTools:
  false`, so it cannot write anything; and a path outside the project is
  refused by name (verified against `~/.gitconfig`).
- **NOT a capability action.** `actions.mjs` is Operator's own data;
  worker-to-worker is a different thing wearing the same shape. It also settles
  "can a delegated worker delegate?" as a plain no.
- Pre-allowed in `jobs.mjs` and named in the system prompt — a gate would defeat
  it, and a tool that is merely mentioned does not get used.

**Semantic verification is now ON and on AI Router.**
`OPERATOR_SEMANTIC_VERIFY=1` was already set; `OPERATOR_SEMANTIC_PROVIDER` was
not, so it had been silently running on the 3B. Both set now.

**[ADR 0016](decisions/0016-ai-router.md) amended** — source diffs and project
files named explicitly rather than inherited from "prompt and job context".
Audio of him is still outside it; moving Whisper or TTS there needs its own
clause written first.

## What is NOT changed, and why

**Routing still classifies with Qwen3.8, not Opus.** Making Opus the literal
front door means paying an Opus turn to answer "which worker?" for every message
the rules do not settle — the exact cost `routing.mjs` was built to avoid ($0.58
for "what time is it", measured 2026-08-31). Claude is the dispatcher for WORK,
not for triage. Raise it if he wants it the other way.

## Next

**Hosted Whisper + TTS through AI Router, local as the fallback.** Approved in
principle 2026-09-02 for RAM reasons — Kokoro holds ~300MB resident on a machine
that hit 2.33GB free during the Rust build. Local Whisper is already 287ms warm,
so this buys memory, not speed. **Write the ADR 0016 audio clause first.**

**`runner.mjs` still discards the SDK's token counts** — a five-line change, and
the highest-value follow-up in the accounting. Claude's records read `reported`
where they should read `derived`.

## Environment

- `AIROUTER_API_KEY` set. `OPERATOR_SEMANTIC_PROVIDER=airouter`,
  `OPERATOR_SEMANTIC_VERIFY=1`, `OPERATOR_TTS_IDLE_MS=14400000`,
  `OPERATOR_FOCUS_SCREEN=1`, `OPERATOR_MAX_CONCURRENT=3`.
- Four workers registered: claude-code, gemini, airouter, ollama.
- **`OperatorShell` scheduled task added** — the desktop shell now launches the
  same hidden way the server and both Vite instances do.

## The restart trap, still true

`POST /api/restart` and `schtasks /End` do NOT reload the environment while the
supervisor survives. **The new `OPERATOR_SEMANTIC_PROVIDER` needs a full stop:**
kill all three node PIDs, then `schtasks /Run /TN OperatorServe`.

## For the owner to run by hand

Both denied to the agent session by design:

```
git push origin main
rm scratch-also.mjs scratch-chain.mjs scratch-undo.mjs scratch-air.mjs scratch-sem.mjs
```
