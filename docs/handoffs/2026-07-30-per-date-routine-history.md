# v16 — Routine completion keyed by date, nightly reset retired

**Date:** 2026-07-30
**Commit:** pending approval
**Milestone:** M11
**Schema:** 2 → **3**

Follows `2026-07-30-day-schedule-stepper-and-ticks.md` (v15), which shipped the
day stepper with ticks deliberately hidden off today because there was no
per-date record to show. This is the record.

## Summary

`routine.completions` — `{ [dateKey]: taskId[] }`, the same shape
`gym.completions` already uses — replaces the single `done` flag as the store of
truth for repeating steps, and **the nightly reset is deleted along with the
marker that guarded it.**

The reset was the actual problem. **OPS-009** fixed *when* it ran (it compared
UTC, and only on mount); it could not fix what it did, which was overwrite the
record rather than archive it. The routine had no history — only current state,
destroyed every midnight. Keying by date means a date with no entry is simply a
date nothing was ticked on: nothing to roll back, no midnight boundary to get
wrong, and last Tuesday is readable.

Consequences:

- The **whole `/routine` page** is now scoped to one date, not just the schedule
  card. The date moved up to `DailyRoutine.tsx`, because the summary and every
  section card are date-scoped too — stepping the schedule while the cards below
  showed today would have been two days on one screen.
- The stepper's checkboxes **work on every date** now, and v15's "plan only, no
  ticks" branch is gone.
- `routine.lastReset` has **no reader left**. It stays in `BLANK_VALUES` only so
  a Settings clear removes it from existing stores rather than orphaning it.

## The one-off vs repeating split — the part that will trip someone up

`RoutineTask.done` was **not** removed, and is still the truth for exactly one
case: a step with `repeatDaily: false`. A one-off is done once and stays done on
every date, so its state belongs to the step, not to a day — ticking "work at
Darams" on Tuesday and then looking at Friday should still show it done. That was
the pre-v3 behaviour for non-repeating steps and it is preserved exactly.

For a repeating step, `done` is **ignored**. `useRoutineData.isDoneOn` is the
single place that decides which store to read; **do not read `task.done`
directly** anywhere else.

This also means the repeat toggle in `RoutineSectionCard` now switches which
*store* a step uses, not just its styling — the tooltips say so.

## Files modified

| File | Change |
|---|---|
| `src/lib/types.ts` | `RoutineCompletions`; `RoutineTask.done` documented as one-off-only and ignored for repeating steps |
| `src/lib/storageKeys.ts` | `routine.completions` blank value + added to the Daily Routine clear slice; `routine.lastReset` marked retired |
| `server/index.mjs` | `SCHEMA_VERSION` 2 → 3; migration 2→3; **corrected the stale API header comment** (see below) |
| `src/hooks/useRoutineData.ts` | `routine.completions` slice; reset effect deleted; `isDoneOn`, `toggleTask(dateKey, sectionKey, task)`, `statsFor(dateKey)`, `scheduleFor(dateKey)` |
| `src/pages/DailyRoutine.tsx` | Owns `dateKey`; passes date-bound `isDone` / `onToggleTask` closures down |
| `src/components/routine/RoutineTimeline.tsx` | Controlled date (`dateKey`, `todayKey`, `onDateChange`); ticks on all dates; only the *clock* facts stay today-only |
| `src/components/routine/RoutineSectionCard.tsx` | Takes `isDone`; toggle passes the task; repeat-toggle tooltips explain the two stores |
| `src/components/dashboard/CurrentTime.tsx` | `scheduleFor(todayKey)` — pinned to today on purpose, it answers "right now" |
| `CLAUDE.md`, `docs/roadmap.md`, `docs/data-model.md`, `docs/known-issues.md` | Rewrote the v15 "no per-date history" passages, which this change made false; OPS-009 marked **moot** |

## Architectural decisions

**One new pattern, already established elsewhere:** date-keyed completion. Copied
from `gym.completions` rather than invented, and now used by two features, so it
is the shape to reach for next time something needs per-day state. No ADR — it is
an application of an existing decision, not a new one.

**Date-bound closures instead of threading a date through components.**
`DailyRoutine` passes `isDone={(t) => isDoneOn(dateKey, t)}` and an equivalent
toggle. No component below the page handles a date, so none of them can read the
wrong day, and adding a third date-scoped surface needs no new prop plumbing.

**Components stayed date-unaware rather than each calling the hook.** They could
have read `useRoutineData()` themselves now the store is shared (OPS-004 is
fixed), but then the page's date and theirs could diverge. One owner, passed down.

## Technical debt

**Resolved:** the reset's whole class of problem — OPS-009 is now moot rather
than fixed, since the code it described is gone.

**Introduced:** none knowingly. `routine.lastReset` is a deliberate orphan,
documented in two places.

**Corrected in passing, and worth flagging loudly:** `server/index.mjs`'s header
documented `PUT /api/state/<key>` as taking *"the raw value for that slice"*. The
handler actually does `cache.state[key] = body?.value ?? null`, so it needs a
`{ "value": … }` **envelope** — a bare array or object silently stores `null` and
wipes the slice. I hit this directly while scripting a cleanup against the live
store and nulled `routine.sections`; it was restored from the browser's offline
mirror within a minute and verified against `data/operator-backup-2026-07-30-00-29-54.json`
(no nulls, all seven sections, correct counts and start times). The comment now
says what the code does, including that the bulk `PUT /api/state` is the
inconsistent one that takes a bare map. **Do not script writes against the store
without the envelope.**

## Outstanding issues

1. **The running server must be restarted for schema v3 to land.** Migrations run
   on load, so the process started before this change still reports
   `schemaVersion: 2` and will not have run the 2→3 step. Harmless right now —
   there are zero `done: true` repeating steps, so the migration is a no-op — but
   the version on disk stays 2 until a restart.
2. **No history view.** `routine.completions` and `gym.completions` are both real
   per-date data with nothing charting either. This is the natural feed for
   Statistics.
3. **Future dates are tickable.** Consistent with the Gym page, which has the
   same freedom, and cheaper than a rule that needs explaining. Noted in case it
   ever looks wrong.
4. **`routine.sections[gym]` and `[work]` are empty**, so neither appears on the
   schedule. Confirmed with the owner as intended — the gym steps were seed data
   he had asked to be cleared, and the Gym page owns real training data.

## Recommended next milestone

**Notes per GEH shift** — unchanged from v15 and now the oldest unaddressed queue
item, with a real deadline behind it ("a couple areas ive missed out i need to
report to my supervisor"). Needs per-occurrence data on a recurring series:
`occurrenceNotes: { [dateKey]: string }` alongside `skipDates`. Worth agreeing
the shape first, because it is the second per-date pattern on a *series* rather
than on a feature, and it will set the precedent for anything else that needs to
annotate one occurrence.

## Assumptions & risks

- **Assumed crediting pre-v3 ticks to today is better than discarding them.** The
  old shape carries no date, and the reset means a `done: true` can only have been
  set since the last local midnight, so today is the only defensible guess. Zero
  rows in practice on this store.
- **Assumed one-off steps should stay sticky across dates.** That is the pre-v3
  behaviour preserved, not a new choice — but it does mean two steps side by side
  in the same list behave differently, which the tooltips now explain and which
  is the most likely source of future confusion.
- **`routine.lastReset` is left in the store.** Removing it would need a
  migration that deletes a key, which the additive-only rule discourages for no
  benefit.
- **The owner's read on the earlier gym-step loss was that it was his own seed
  clearance**, not a product defect, so no OPS entry was opened for it. If routine
  steps ever disappear again unexplained, the thing to examine is the offline
  write-replay path — his own suggestion, and the one mechanism that could
  plausibly push a stale `sections` array over a newer one.

## Verification

- [x] `npx tsc -b` clean
- [x] `npx vite build` clean
- [x] **Migration exercised on a throwaway copy**, not the live store: a v2
      fixture with one repeating and one one-off step ticked, served on port 5199
      with `OPERATOR_DATA` pointed at it. Result: `schemaVersion` 3,
      `routine.completions = {"2026-07-30":["r1"]}`, the one-off's `done` left on
      the task and **not** copied into completions, date built from local parts.
      Temp server stopped and fixture deleted afterwards.
- [x] Exercised in a browser against the real store, after a full reload:
  - Today: ticked a repeating step and the one-off → 2/14 steps, block 2/6
  - Tomorrow: 1/14 and 1/6 — the **repeating tick did not carry**, the
    **one-off did** (verified by strikethrough, not just counters)
  - The Morning section card below read 1/6 on tomorrow too, agreeing with the
    schedule rather than showing today
  - Store confirmed: `completions {"2026-07-30":["r1"]}` and
    `doneFlags ["work at Darams"]` — the two kinds of step in the two stores
  - All test ticks then cleared through the UI; store left at `completions {}`,
    zero `done` flags, all seven sections intact
- [ ] Not exercised on a physical phone
- [ ] **Schema v3 not yet applied to the live store** — needs a server restart
      (see Outstanding 1)
