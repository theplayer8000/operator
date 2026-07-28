# v8 — Day schedule & the first real migration

**Date:** 2026-07-28
**Commit:** pending approval
**Milestone:** M5

## Summary

Daily Routine gained a **Day Schedule** timeline: every section on a clock,
with a live "on now" highlight and a warning when one block starts before the
previous is estimated to finish. The Dashboard gained a **Now** card — clock,
date, and which routine block is active with time remaining.

To do that, `RoutineSection` gained a `startTime`, which is the first change to
a persisted shape since the storage server shipped. **This is the first real
migration the store has ever run** — the `MIGRATIONS` array had been an empty
placeholder since v5.

## Files modified

| File | Change |
|---|---|
| `src/lib/time.ts` | **New.** `parseHHMM`, `formatHHMM`, `minutesIntoDay`, `formatDuration`. Local time only, deliberately |
| `src/hooks/useNow.ts` | **New.** Ticking clock; re-syncs on `visibilitychange` and focus |
| `src/lib/types.ts` | `RoutineSection.startTime`; new derived `ScheduleBlock` |
| `src/lib/seed.ts` | Start times on all seven seeded sections |
| `server/index.mjs` | `SCHEMA_VERSION` 1 → 2, plus the v1 → v2 migration backfilling `startTime` |
| `src/hooks/useRoutineData.ts` | `setStartTime`, derived `schedule`, overlap detection |
| `src/components/routine/RoutineTimeline.tsx` | **New.** The Day Schedule card |
| `src/components/routine/RoutineSectionCard.tsx` | Native `<input type="time">` per section |
| `src/components/dashboard/CurrentTime.tsx` | **New.** The "Now" card |
| `src/pages/DailyRoutine.tsx`, `src/pages/Dashboard.tsx` | Wiring |

## Architectural decisions

**None new — established patterns throughout.** `CurrentTime` reads
`useRoutineData` and mutates nothing, which is the read-only aggregator
exception already covering `HomelabStatus` and the Activity Log. No ADR
warranted.

Four choices worth recording:

- **`startTime` is a wall-clock string, not a timestamp.** A routine happens at
  06:30 every day, not at one instant. Storing an ISO timestamp would have been
  the reflex and would be wrong.
- **Block ends are derived, never stored.** Start plus the section's task
  minutes, so the schedule stays honest when tasks are added or re-estimated.
  Consistent with the "derived data is computed" invariant.
- **The timeline is vertical, and bars are relative not absolute.** A literal
  24h horizontal scale renders a 2-minute step as a sub-pixel sliver and wastes
  most of the width on the gap before work; and a schedule you must scroll
  sideways to read is one you won't read on a phone.
- **Native `<input type="time">`** rather than a hand-rolled picker — the
  platform's own control on a phone, and format validation for free.

## Technical debt

**Resolved:** a **documentation defect in `docs/data-model.md`**. The migration
example labelled `MIGRATIONS[0]` as the v1 → v2 step. The code indexes by the
version being migrated *from* (`MIGRATIONS[current]`, `current` starting at the
store's `schemaVersion`), so v1 → v2 is index **1**. Following the old example
would have put a migration on the wrong version where it silently never runs —
which is exactly the failure mode the array exists to prevent. Corrected, with
the real migration named as the worked example.

**Introduced:** none knowingly.

Three properties of the migration system that were implicit and are now written
down in `data-model.md`, because each one can bite:

- Migrations must be **idempotent** — `load()` migrates the cache but
  `persist()` only runs on a write, so a migration re-runs on every cold start
  until something writes.
- **The offline localStorage mirror is never migrated.** `useRoutineData` and
  `RoutineSectionCard` therefore both defend against a missing `startTime`.
- **A running server does not pick up a new migration** without a restart.

## Documentation updated

- **`docs/data-model.md`** — `startTime` and `ScheduleBlock`; schema version 2;
  the corrected migration indexing with the off-by-one called out; the three
  consequences above; and a fourth rule: test migrations against a copy of the
  real store, since seeds already have the new field and never exercise it.
- **`docs/roadmap.md`** — Day Schedule under Daily Routine, "Now" card under
  Dashboard.
- **`CLAUDE.md`** — folder map: `lib/time.ts`, `useNow.ts`, `RoutineTimeline`.

## Outstanding issues

1. **The owner's running server must be restarted** to pick up the migration.
   Verified live: `GET /api/health` reports `schemaVersion: 1` and
   `routine.sections` still serves seven `null` start times, because that
   process started before this change. Until it restarts, every block falls
   back to 09:00 and the timeline will show seven overlapping blocks. Harmless,
   self-correcting, and confusing if unexplained.
2. **Not exercised on a physical phone** — in particular the native time picker
   and the timeline at 390px.
3. **Overlaps are flagged, not prevented.** Deliberate; the owner may genuinely
   want to double-book. Nothing enforces a sane ordering.
4. **`useNow(1000)` re-renders the Now card every second.** Cheap (one small
   card), but if a future page mounts several, prefer a coarser interval — the
   hook takes one.
5. **OPS-009 is still open** and is adjacent: the daily reset is mount-only and
   UTC-based. `useNow` re-syncs on focus and `visibilitychange`, which is the
   pattern OPS-009 needs — the fix is now a copy of an approach already in the
   codebase.

## Recommended next milestone

**Settings**, unchanged and now overdue. It is the only route to closing
**OPS-017**, and v8 has just demonstrated why that matters: the first real
migration ran against the owner's live data with **no automatic pre-migration
snapshot**. It was verified against a copy first, but that was diligence, not a
safety net.

**OPS-009** is now a small, well-understood companion fix.

## Assumptions & risks

- **Assumed default start times** (06:30 morning through 23:00 sleep) for the
  backfill. They are guesses at the owner's actual day; the migration only
  fills sections that have no time, so editing them is safe and permanent.
- **Assumed sections are same-day.** A block crossing midnight (sleep 23:00 +
  a long duration) renders an end past 24:00; `formatHHMM` wraps, so 25:30
  displays as 01:30, but it sorts as "late today" rather than "early tomorrow".
  Fine for the current seven-section shape, wrong if a genuine overnight block
  is ever added.
- **The fallback of 09:00** for a missing `startTime` is wrong-but-harmless by
  design. It exists so a pre-v2 offline mirror renders instead of crashing.

## Verification

- [x] `npx tsc -b` clean
- [x] `npx vite build` clean
- [x] **Migration tested against a copy of the real store** (never the original):
      schemaVersion 1 → 2, all seven sections backfilled with correct times,
      all 18 tasks preserved
- [x] **Idempotency tested**: a v2 store with a customised time (`05:15`)
      survives reload unchanged — the migration does not re-run over real edits
- [x] Throwaway test servers (ports 5997/5998) confirmed terminated afterwards
- [ ] **Not exercised on a physical phone** — native time picker, 390px layout
- [ ] Timeline not observed with a real overlap in the browser
