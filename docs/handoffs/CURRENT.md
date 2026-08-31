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

### The listener runs on the MACHINE now, not in a tab

`server/listen.mjs`. ffmpeg captures the microphone, this reads raw PCM and
looks for two transients. Off unless `OPERATOR_LISTEN` names a device
(currently `Headset (Tosin's Headphones)`), environment-only for the same
reason `OPERATOR_TERMINAL_DEVICES` is.

It moved off the page because two browser mechanisms defeat it there and fixing
either alone leaves it broken: `requestAnimationFrame` is throttled to ~1fps in
a background window, and Chromium **suspends** an `AudioContext` when the page
is occluded. Both were patched before the retreat. Both are the browser
correctly refusing to let a hidden page be busy — and clapping is by definition
something you do while looking elsewhere.

**The actual bug was one unmeasured constant.** The owner's headset peaks at
**0.081** on a clap with the room at **0.001**; the threshold was **0.18**, more
than double what the microphone can produce. It could never have fired, in
either implementation, on any number of claps. The bar is now a ratio to
measured ambient, because the ratio is what is stable across microphones.

### ⚠ The summon is still ~1.5s, and the fix did not land

Every summon spawns PowerShell (~320ms) and compiles the Win32 declarations
with `Add-Type` (~450ms) before a single call happens.

**A persistent PowerShell was attempted and reverted.** `powershell -Command -`
buffers multi-line input until EOF rather than behaving as a REPL, so the
helper never reached ready, every call silently fell back to spawning, and the
only symptom was the original slowness plus a warning nobody was reading. A
working version needs a different mechanism — a named pipe, a small compiled
helper, or `dotnet` hosting the type — not another attempt at the same shape.

#### What a working version needs — so the next attempt starts from here

The three things that attempt established, which are worth more than its code:

1. **The declarations must compile once per process, not per call.** That is the
   ~450ms. Any mechanism that keeps a process alive holds the type; any that
   spawns per call pays it again. `OP_DECLARATIONS` in `actions.mjs` is already
   guarded by `-as [type]`, so it is a no-op in a host that has it.
2. **stdin to `powershell -Command -` is not a channel.** It buffers until EOF.
   Nothing that writes commands to a PowerShell's stdin will work, however the
   framing is done — that is the shape to stop trying.
3. **Startup and per-call need separate timeouts.** The compile is ~11s against
   a command time of milliseconds; one timeout for both reads a slow start as a
   wedge and falls back forever.

Three mechanisms that would actually work, roughly in order of effort:

- **A named pipe.** A PowerShell script started once that opens
  `\\.\pipe\operator-win` and loops on it. Real bidirectional channel, no stdin
  buffering, and the server talks to it with `net.connect`.
- **A tiny compiled helper.** The C# is already written; `csc` it once into an
  exe that takes argv and prints a line. Removes PowerShell entirely — spawn
  cost drops to a few ms and there is no compile at all.
- **Skip Windows scripting.** The window operations are `user32.dll` calls;
  anything that can P/Invoke can do them.

The second is probably the right one: the source exists, it deletes the whole
problem rather than working around it, and a spawned exe needs no lifecycle
management, no queue, and no fallback path.

`server/winhelper.mjs` is untracked and adds nothing the above does not say, so
it should go — an unused file in `server/`, where every other file is live and
in the folder map, is a thing a future session wires up by mistake. Deleting is
denied to every Claude session:

```
cmd /c del "D:\Projects\operator\server\winhelper.mjs"
```

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
