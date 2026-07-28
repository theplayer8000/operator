# 0003 — Two separate mission types

**Status:** Accepted
**Date:** 2026-07-27

## Context

The Dashboard shipped first, with a lightweight `Mission` type behind its
"Current Missions" and "Project Progress" widgets: id, name, category, progress,
deadline, priority, archived. Enough for a shield badge and a bar.

Mission Board shipped next and needed far more: description, difficulty, status,
time invested, next objective, embedded milestones, directional dependencies, an
activity log, "why it matters", "what this unlocks", "knowledge needed", and
free-text links to features that don't exist yet. Twenty-plus fields against
seven.

The obvious move was to make the Dashboard read Mission Board's data — one
source of truth, no duplication.

## Decision

Keep them separate. `Mission` over `dashboard.missions` and `MissionRecord` over
`missions.records` are **different types over different keys, deliberately not
synced** (`CLAUDE.md:46-51`).

## Consequences

**Makes easy:** Mission Board's type can evolve freely — and it will, since
three of its fields are placeholders for unbuilt features — without touching
the Dashboard. The Dashboard's widgets can't break when Mission Board changes.
Each feature stays independently readable and deletable.

**Makes hard — and this is a real, visible cost:**

- The Dashboard's mission widgets show **frozen seed numbers** (EPYC 62%,
  Homelab 40%, Darams 78%, AI 25%) that never move when the real missions
  change.
- `setMissions` is returned from `useDashboardData.ts:80` and never consumed, so
  there is no editor for them either.
- Those two widgets are effectively **decorative** today. Tracked as
  **OPS-005**.

That cost was acceptable while Mission Board was being built. Whether it stays
acceptable is a live product question — the owner has not decided.

## What would change this

The owner deciding the Dashboard should show **live** mission data.

If so: do **not** merge the types. The right shape is for the Dashboard to
derive a read-only projection from `missions.records` — mapping `MissionRecord`
down to what a widget needs — which keeps `MissionRecord` as the single
authority without giving the Dashboard a second editable copy.

That is still a deliberate exception to feature independence
([ADR 0002](0002-feature-slice-architecture.md)) and it collides with **OPS-004**
if both the Dashboard and Mission Board are ever mounted at once. It needs a new
ADR, not a quiet refactor.

Until then: **do not "fix" the duplication.** It is the decision, not an
oversight.
