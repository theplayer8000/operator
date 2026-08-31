# CURRENT — work in progress

**Updated:** 2026-08-31
**`main`:** clean and pushed.
**Workers:** Claude Code, Gemini, and **Local** (Ollama, `qwen2.5:3b`).
**Terminal:** armed. It survives a restart now only if one is asked for — see below.
**Rule:** see *"Every piece of work keeps a live handoff"* in `CLAUDE.md`.

## Voice and presence — phase 1 done, the gesture is live

**Operator speaks.** Speaker icon in the Orchestrator header, off until asked
for, per-device, with a voice picker. On-device synthesis: no dependency,
nothing leaves the machine, and — unlike the microphone — **not secure-context
gated**, so it works at the bare tailnet IP too.

**Two claps summons it.** Pauses whatever is playing, brings the window to the
front on screen 2, fullscreen, and navigates to the Dashboard. The detector is
arithmetic over `AnalyserNode` output — no model, no dependency, and **no audio
leaves the page**, not even to Operator's own server.

Off by default and desk-only. The microphone is open while armed, which is a
posture change rather than a setting, so the toggle sits on screen (bottom
right) rather than in Settings.

### The state it is in right now

**It works, and the threshold is still being tuned.** The owner swapped to a
wired headset and claps stopped registering — a fixed bar with
`autoGainControl: false` (which the detector needs) does not survive a change of
input device.

So the button now shows a **live level meter with the threshold marked**, which
turns "clapping does nothing" from one symptom into three distinguishable ones:

- the meter does not move → the microphone is the problem
- it moves but never reaches the notch → `PEAK_THRESHOLD` is too high
- it passes the notch and nothing happens → the gesture logic is the problem

Default lowered to `0.18`, and overridable per-device without a rebuild:
`localStorage.setItem("os.clap.threshold", "0.12")`, then reload.

It also counts claps heard, so "heard 3" is proof the detector works even when
the double-clap window is being missed.

### Run Operator as the installed app, not a browser tab

`focus_operator` raises a *window*; it cannot switch a browser tab, and no API
can. The PWA is already installed — opening it that way gives a window with no
tab strip and the problem disappears. **Close the browser tab if the app window
is open**, or the summon may grab whichever it finds first.

## What restarting looks like now

```
POST /api/restart {"arm": true}
```

Comes back with the terminal armed. ADR 0011 still holds: the caller has
already passed the same check arming itself needs, so this grants nothing that
could not be had in two requests — it removes a second trip that was becoming
friction, and friction was the real risk, because it makes people want the
terminal permanently on.

**The intent travels as an exit code (76), never a file.** A worker has `Write`
across the tree, so an "arm on next boot" marker on disk is one the agent could
drop and then trigger a restart to collect.

## Three bugs worth not repeating

- **`Add-Type -PassThru` returns an ARRAY** when the definition declares a
  struct alongside methods. Every `$w::Method()` then fails — *non-terminating*,
  so the script ran to its final `Write-Output` and reported success while doing
  nothing. Verify by asking the window where it ended up, never by reading a
  return value.
- **A maximised or fullscreen window ignores `MoveWindow`.** Order has to be
  leave fullscreen → move → re-enter, with pauses, because the browser
  re-lays-out asynchronously.
- **A lone ALT tap** is the classic way past Windows' foreground restriction and
  a browser reads it as "focus the menu" — which is why a nav link kept getting
  a focus ring. `SwitchToThisWindow` does it with no keystroke.

## Next

**Speech in** — local `faster-whisper` ([ADR 0015](../decisions/0015-hermes-agent.md)).
The clap already opens the microphone, so the capture buffer has somewhere to
start, and the callback fires on the second clap precisely so it can.

Then, in rough order: **Piper** for a real voice rather than whatever Windows
ships; **tool relevance filtering**, because all ~35 actions go to every worker
on every turn and that already made Gemini pick the wrong one; and the **live
layer** on the mission map, which the chat-in-the-graph plan waits on.

## Still waiting on the owner

- `OPERATOR_USAGE_BUDGET_USD=10` is a stopgap, not ADR 0013's ceiling. It resets
  each restart and counts valuation dollars, not credits.
- The **76 permission rules** in `.claude/settings.local.json`, and `greptile`
  enabled against ADR 0014 — see
  [`2026-08-27-claude-code-health-check.md`](2026-08-27-claude-code-health-check.md).
- **Gym mission should update itself** from gym data — queued.
