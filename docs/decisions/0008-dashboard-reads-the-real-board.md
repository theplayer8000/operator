# 0008 — The Dashboard reads the real Mission Board

**Status:** Accepted
**Date:** 2026-07-28
**Supersedes:** [0003 — Two separate mission types](0003-separate-mission-types.md)

## Context

ADR 0003 gave the Dashboard its own lightweight `Mission` type over
`dashboard.missions`, separate from the Mission Board's `MissionRecord` over
`missions.records`. The reasoning was sound at the time: the Dashboard wanted a
glanceable summary, the board wanted a rich record, and coupling them early
would have forced one shape to serve two jobs.

It left one question open, and **OPS-005** has tracked it since v3: *should the
Dashboard widgets read live Mission Board data?* Until that was answered, the
widgets rendered seed data with no writer — `setMissions` was returned by
`useDashboardData` and never called. Three missions sat at fixed percentages
forever.

The owner answered it directly: *"the current missions on dashboard needs a
rework, not functionable to what we have in mission board."*

That is the right call, and the separation had become the worse of the two
failure modes. A widget showing numbers that cannot change is worse than no
widget, because it looks live. Someone glancing at "Darams CRM 78%" has no way
to know that number is a fixture.

## Decision

**The Dashboard's mission widgets read `missions.records` directly, read-only.**

- `CurrentMissions`, `ProjectProgress` and the new `MissionStatusChart` all call
  `useMissionBoard()` and render real records. Each links through to
  `/missions/:id`.
- **They mutate nothing.** This is the read-only aggregator exception already
  covering the Activity Log and `HomelabStatus` — editing still happens on the
  board, where the feature's hook is the only writer.
- **`dashboard.missions` and the `Mission` type are retired.** With no reader
  left, keeping a second mission shape would be dead surface pretending to be a
  design. `Mission`, `seedMissions`, and `DashboardData.missions` are gone from
  the codebase; the storage key stays in `BLANK_VALUES` so existing stores can
  still be cleared of it.
- **`dashboard.productivityHistory` is retired the same way**, along with the
  Productivity Score card that charted it — seven hardcoded numbers presented
  as a 7-day trend. It is replaced by `MissionStatusChart`, which derives a
  status breakdown from the real board per render and stores nothing.

**Two registers, one dataset.** The Dashboard still renders missions as
hexagonal shields; the board still renders them as neutral status pills. That
difference is [ADR 0004](0004-tonal-registers.md) and is deliberately kept —
what ADR 0003 got wrong was duplicating the *data*, not the presentation.

## Consequences

**Good.** OPS-005 closes. There is one mission type again, so a change to
`MissionRecord` can't leave a second shape stale. The Dashboard is finally
answerable — every number on it traces to something the owner entered.

**Costs.**

- **The Dashboard now depends on the Mission Board.** Deleting or renaming
  `missions.records` breaks three Dashboard widgets, where before it broke none.
  That coupling is the point, but it is real.
- **Three widgets each call `useMissionBoard()`.** Cheap — `remoteStore` gives
  every hook one shared cache (ADR 0006), so this is one slice read three times,
  not three fetches. Before v5 this pattern would have been unsafe.
- **The Dashboard's "glanceable summary" idea is gone.** If a genuinely
  summary-shaped view is ever wanted, it should be *derived* from
  `MissionRecord`, never stored alongside it.

## What would change this

- **A second consumer needs a different mission shape** — e.g. Journey rolling
  missions up into life milestones. Derive it; do not reintroduce a parallel
  stored type. The lesson of ADR 0003 is not "never summarize", it is "never
  keep a second copy that nothing keeps in sync".
- **The Dashboard becomes slow.** Not plausible at this dataset size (tens of
  records, filtered in memory), but if it ever were, memoize in the hook rather
  than reintroducing a stored summary.

## Alternatives rejected

**Sync the two slices.** Write through from Mission Board to
`dashboard.missions` on every mutation. This is the option that keeps both ADRs
intact, and it is the worst one — two sources of truth plus a sync step is
strictly more failure than one source, and every new mutator becomes a place to
forget the write-through.

**Leave it and delete the widgets.** Honest, and briefly considered. Rejected
because the owner wants missions on the homepage — the widgets aren't the
problem, their data source was.
