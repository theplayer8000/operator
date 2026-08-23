# Gemini, auto-routing, and the capability layer growing writes

**Date:** 2026-08-22 (work spanning 20–22 August)
**Commits:** `dba43bb` … `aeab688` — all on `main`, all pushed.

## Summary

Operator gained a second worker, learned to choose between them, and the
capability layer grew from "change four things" to a surface a worker can
actually run the app through. Several defects were found by using it rather
than by looking for them, and those are the parts most worth reading.

## What shipped

**Gemini as a second worker** (`server/gemini.mjs`). Same `runTurn` contract as
the Claude runner, so `jobs.mjs` dispatches through `providers.mjs` without
knowing the difference. Registers only when `GEMINI_API_KEY` is set. It proved
the architecture on its first real test: asked in plain English to create a
mission, it called `mission_create` itself and a correctly-shaped record
landed — **no Mission Board code was written for Gemini.**

**Auto-routing** (`server/routing.mjs`). New jobs default to `provider: "auto"`.
Rules decide the clear cases; a classifier handles ambiguity; anything
uncertain goes to the capable worker. A `routed` event says which and why.

**The capability layer, substantially extended** (`server/actions.mjs`, now 34
actions):

- **Reads** — `gym_day`, `calendar_range`, `missions_list`, `routine_day`.
- **Gym programme editing** — sessions and exercises, so "propose a new routine
  and change it" is possible.
- **Calendar** — recurring events, and date ranges for annual leave.
- **Job transcripts** — `job_events`, `jobs_list`.

**Weekday routine steps.** `RoutineTask.weekdays` (optional, absent = every
day) so "work at Darams" stops appearing on days off.

**Notifications.** A badge on the Orchestrator nav item driven by the server's
`asking` count, and a toast anywhere in the app when a worker needs you.

**Renames.** "Claude" → **Orchestrator**, `/chat` → `/orchestrator` (old URL
redirects), `dev/ClaudeChat.tsx` → `orchestrator/OrchestratorChat.tsx`, now
provider-agnostic throughout.

**Documentation truth pass.** The README described a Dashboard-only app storing
data in `localStorage`; `roadmap.md` claimed the API had no authentication,
false since ADR 0010. 23 stale `CLAUDE.md:<line>` references replaced with
section names. `AGENTS.md` became a pointer after twice regenerating as a
find-and-replace copy inventing `status.Codex.com`.

**Decisions.** [ADR 0013](../decisions/0013-usage-accounting.md) (usage
accounting), [ADR 0014](../decisions/0014-development-tooling.md) (plugins),
and [`control-plane-design.md`](../control-plane-design.md) (next phase).

## The defects worth remembering

Each was found by using the thing, and each was silent.

**A failed write left the change in memory** (`fcd17cb`). `store.mjs` assigned
before persisting, so a transient Windows `EPERM` renaming `operator.json.tmp`
threw *after* the mutation was live — the retry then double-added a gym
exercise. The quieter half was worse: memory and disk disagreed until the next
successful write, so a restart in that window would have silently discarded a
confirmed change. Writes are now all-or-nothing, and the rename retries through
a transient lock.

**Routing ignored availability** (`e829631`). Claude hit its session limit, the
owner said *"use a different model then duh"*, and the router sent the retry
straight back to Claude — twice. It weighed capability and knew nothing about
whether a worker could take work.

**The capability layer could only write, never read.** "What's my gym session
today" cost **129 seconds, nine permission prompts and $0.92**, because there
was no read path — the worker grepped source and computed a weekday by hand.
Gemini would have been *worse*: no filesystem, so it could not have answered at
all. **Rule that came out of it: a new feature needs a read action, not just
writes.**

**Gemini Flash is a thinking model.** A one-word classification burned 61
thinking tokens and returned `finishReason: MAX_TOKENS` with `parts: null`.
Needs `thinkingConfig.thinkingBudget: 0`. Raising the cap does not help.

**The free tier is 20 requests per *day***, not per minute — and still says
"retry in 18s", which is a lie for a daily cap.

**Two Windows traps that look like broken code.** `schtasks /end` does not stop
the server (it runs under a supervisor), so the relaunch fails to bind and the
*old* process keeps serving while everything looks restarted. And Task
Scheduler caches the user environment, so a `setx` never reaches a task it
launches — the wrapper now reads `HKCU\Environment` at launch.

**The sidebar swipe fought iOS.** `EDGE_ZONE` was 28px, exactly Safari's
back-navigation band, so they raced — and when iOS won it swallowed the
gesture, leaving `drag` non-null and the scrim stuck until reload. Two reported
symptoms, one cause.

## Security

**Workers no longer inherit Operator's secrets** (`aeab688`). A job got the
whole server environment including `GEMINI_API_KEY` and `OPERATOR_TOKEN`. Since
`Bash(echo:*)` is pre-approved, a job could already read them; the only thing
stopping a key leaving was that no outbound command happened to be allowed —
two half-measures leaning on each other. Now independent.

**The Gemini key was reissued twice**, once because it was set with `setx`
**through Operator's own terminal**, which logs every command by design. Never
set a secret there.

## Outstanding

- **A restart is pending.** `server/` changed for the secret fix, the job
  actions and the terminal message. Nothing else is waiting on it.
- `.job4.json` in the agent worktree — `cmd /c del "D:\Projects\Operator-agent\.job4.json"`.
  Deleting is denied to every Claude session by the standing profile.
- **Concurrency and usage ceilings** remain undecided; ADR 0013 settled the
  accounting, not the limits.
- **The next milestone is a choice** between the control plane
  (local routing, gateway seam) and the Knowledge Vault, which several queued
  items are quietly waiting on — the routine restructure, streaks, and the
  owner's own organisation.

## Assumptions and risks

- **A second person and a homelab move are coming**, and both break written
  assumptions — see [`control-plane-design.md` §5b](../control-plane-design.md).
  `threat-model.md` is flagged as needing a rewrite rather than an amendment.
- **Gemini's daily quota makes it unreliable as a data worker.** Routing
  degrades to rules when the classifier is unavailable, which was tested, but
  a paid provider is the real answer.
- **The verification field is still a placeholder.** Every job records
  `verification: { status: "not-run" }` and always has.
