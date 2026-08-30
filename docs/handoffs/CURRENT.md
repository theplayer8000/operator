# CURRENT — work in progress

**Updated:** 2026-08-31
**`main`:** `cf75ae8`, clean and pushed.
**Workers:** Claude Code, Gemini, and **Local** (Ollama, `qwen2.5:3b`).
**Terminal:** armed, at the owner's request — it does NOT survive a restart.
**Rule:** see *"Every piece of work keeps a live handoff"* in `CLAUDE.md`.

> Written before starting rather than after, because the owner is near a usage
> limit and this session may stop mid-build. If it did, everything below the
> line is what the next session needs.

## Starting now — voice

**Phase 1 of [`presence-layer-design.md`](../presence-layer-design.md): speech
OUT.** Operator speaks its replies.

Chosen first because it is the largest change in how the thing feels for the
least risk: `SpeechSynthesis` is on-device on Windows and iOS, adds no
dependency, sends nothing anywhere, and — unlike the microphone — **is not
secure-context gated**, so it works at the bare tailnet IP as well as the
`.ts.net` hostname.

Speech **in** follows and is a different job: local `faster-whisper` with Silero
VAD ([ADR 0015](../decisions/0015-hermes-agent.md)), and `getUserMedia` **is**
secure-context gated, so it will only ever work on the `https` hostname.

It is also the gate on the wall display: a screen showing a graph is a
screensaver, and the `LISTENING` readouts in the owner's references only mean
something once something is listening.

### If this session stopped before finishing

Nothing about voice is committed yet unless a commit message says so. Check
`git log` first. The design and both decisions are already written down, so
the work is resumable from `presence-layer-design.md` alone.

## Recently landed (all pushed)

- **The mission map** — `/`, big screens only. An organic force layout that
  **settles and stops**, so nodes do not drift under the pointer. 9 missions,
  5 dependencies. Nine layout cases under test in the scratchpad; they caught a
  cycle bug that marked only one member of a loop.
- **`mission_set_dependency`** — `dependsOn` was the only structural field the
  capability layer could not reach. Refuses self-links and loops.
- **A local worker** (`server/ollama.mjs`) — no quota, no cost, nothing leaves
  the machine. **24s → 1.2s** once `keep_alive` stopped it reloading 1.8GB per
  call. It is on the GPU via Vulkan, not CPU.
- **Three apps registered** in `OPERATOR_APPS` — `darams-crm` (supervised),
  `vite-main`, `vite-agent`.
- **Two silent landmines cleared** — the launcher lived in a temp scratchpad
  that gets cleaned, and `whois` cached "couldn't ask the daemon" as "not a
  peer", intermittently locking the owner's own PC out.

## Waiting on the owner

- **`OPERATOR_USAGE_BUDGET_USD=10` is a stopgap**, not the ceiling ADR 0013
  describes. It resets every restart and counts valuation dollars, not credits.
- **Gym mission should update itself** from gym data — queued. Both halves
  exist (`gym_toggle_exercise`, `mission_set_progress`); what is missing is one
  action and a rule for what progress *means*.
- **The 76 permission rules** in `.claude/settings.local.json`, and `greptile`
  enabled against ADR 0014 — see
  [`2026-08-27-claude-code-health-check.md`](2026-08-27-claude-code-health-check.md).
