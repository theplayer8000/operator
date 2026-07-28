# v11 — Calendar sync, event date-moves, and the Updates log

**Date:** 2026-07-28
**Commit:** pending approval
**Milestone:** M8

## Summary

Four owner-requested changes, all following the v10 Events feature:

1. **The "Now" card's clock/date opens the calendar.** `/events`, one click.
2. **Timed events now sync onto the Daily Routine's Day Schedule.** Give an
   event a time (and, new this milestone, a duration) and it shows up
   interleaved with routine blocks — read-only, Events stays the sole owner.
3. **An event's date can be changed.** The day panel's edit mode is now a full
   inline form (title, date, time, duration, kind), not title-only. Moving the
   date follows the selection to the new day.
4. **Updates** (`/updates`) — a shipped/pending log of Operator's own
   development, written for the owner and reviewable in the app. Seeded with
   the milestones through v11 and the currently-known pending work, including
   Gym.

Also fixed in passing: `routine.lastReset`'s blank value in `lib/storageKeys.ts`
had the exact same UTC-vs-local bug OPS-009 fixed on the reset itself —
`new Date().toISOString().slice(0, 10)` instead of `toDateKey()`. Clearing
Daily Routine would have set the wrong "last reset" day for up to an hour a
day, the same window OPS-009 closed. Found while adding `events.records` to
the same file.

## Files modified

| File | Change |
|---|---|
| `src/lib/types.ts` | `CalendarEvent.durationMinutes`; `UpdateStatus` + `UpdateEntry` |
| `src/lib/seed.ts` | `seedUpdates`; `pastDateKey()` helper |
| `src/hooks/useEvents.ts` | `addEvent` accepts `durationMinutes` |
| `src/hooks/useUpdates.ts` | **New.** Owns `updates.entries`; done/pending derivations, mark-done/pending |
| `src/components/dashboard/CurrentTime.tsx` | Clock/date wrapped in a `Link` to `/events` |
| `src/components/events/DayPanel.tsx` | Edit mode rewritten — full form incl. date; `onMoved` callback |
| `src/components/routine/RoutineTimeline.tsx` | Reads `useEvents()`; merges today's timed events into the row list |
| `src/pages/Events.tsx` | Wires `onMoved` to follow a moved event to its new date |
| `src/pages/Updates.tsx` | **New.** Quick-capture, Pending, Shipped |
| `src/lib/storageKeys.ts` | `updates.entries` registered; `routine.lastReset` UTC bug fixed |
| `src/App.tsx`, `Sidebar.tsx`, `CommandPalette.tsx`, `Contents.tsx` | `/updates` route + nav + index |

## Architectural decisions

**None new.** Every piece here is the established recipe applied again:

- The clock-opens-calendar and event-sync-onto-timeline changes are the
  **sanctioned cross-feature read** — `RoutineTimeline` calls `useEvents()`
  directly, exactly as `HomelabStatus` and `CurrentTime` already call other
  features' hooks. Events remains the sole writer of `events.records`; nothing
  here is stored twice. Documented in `architecture.md`'s existing exception,
  no new carve-out needed.
- **Updates is a plain feature**, not another aggregator: own namespace, own
  hook, own page, and it owns its own writes — closer to Mission Board than to
  the Activity Log.
- **Explicit `undefined` vs. omitted key**, used correctly in both directions
  in the same milestone: `addEvent`/`addEntry` omit a key that was never set;
  `commitEdit`/`markPending` set an explicit `undefined` to clear a value that
  *was* set. Both are documented at the call site — this is the trap from
  `architecture.md`, applied deliberately rather than avoided.

## Technical debt

**Resolved:** the `routine.lastReset` blank-value UTC bug (a second instance
of OPS-009's root cause, not worth a new ID — same fix, same file family).

**Introduced:** none knowingly. One thing to watch: `RoutineTimeline` now
depends on `events.records` in addition to `routine.sections`. Renaming either
key without checking both call sites will silently break the merged timeline.

## Documentation updated

- **`docs/data-model.md`** — `CalendarEvent.durationMinutes` and the sync
  relationship to `RoutineTimeline`; a new Updates section; the stale
  `seedMissions`/`seedProductivityHistory` references in the seed-data list
  corrected (they were retired in v9 and the doc still named them).
- **`docs/roadmap.md`** — Events section extended (sync, date-move); new
  Updates section explaining the register difference from `docs/handoffs/`.
- **`CLAUDE.md`** — status table, folder map (`useEvents.ts`, `useSettings.ts`,
  `useUpdates.ts`, `Events.tsx`, `Settings.tsx`, `Updates.tsx` — the folder map
  had drifted behind actual v9/v10 additions and is now caught up).

## Outstanding issues

1. **Not exercised in a browser or on a phone.** The inline event-edit form
   (four fields wrapping on a 390px width), the timeline merge rendering, and
   the Updates page are all unverified visually.
2. **The Updates log is manually maintained.** Nothing wires it to git commits
   or handoffs automatically — that was a deliberate scope decision (the
   owner asked for "a little updates log", not build automation), but it means
   it goes stale the moment I forget to add an entry. Worth a habit, not a
   mechanism, unless it starts slipping.
3. **`RoutineTimeline`'s footer can show two stacked notices** (the overlap
   warning and the "N timed events from today" note) if both conditions are
   true on the same day — cosmetically fine, two divider lines, not a bug, but
   worth tightening if it looks off in practice.
4. **Event duration has no upper sanity bound.** A duration typed as 9999
   would render a bar clipped to 100% width but nothing stops the data being
   silly. Not worth validating for a single-user app; noted in case it ever
   matters.
5. **Gym is still the recommended next milestone**, unchanged — parked on the
   owner sharing a real plan, and now tracked as the top pending item on
   `/updates` itself rather than only in this handoff.

## Recommended next milestone

Still **Gym**, once a real plan is available — it's the top pending item on
the very feature just built to track pending items. Failing that, **Weekly
Goals / Streaks editors** is the next-cheapest thing left undone, and
**repeating events** is the most likely near-term ask given the owner's NHS
shift pattern.

## Assumptions & risks

- **Assumed "sync with daily tasks" meant visual interleaving on the Day
  Schedule**, not a write-path that creates routine tasks from events or vice
  versa. A write-path would cross the feature-independence line the way ADR
  0008 explicitly did *not* want to for missions; if the owner actually wants
  events to spawn routine tasks (or the reverse), that's a different, bigger
  design conversation.
- **Assumed the Updates log is manual**, not auto-populated from git. "A temp
  file of every update i do that i can review" read as a running list I keep
  current by hand, not tooling — flagging in case that reading was wrong.
- **Assumed duration is optional and edit-only for new events** (the quick-add
  form still only takes title/time/kind; duration is set via the edit form
  right after). This keeps the add row from overflowing on a phone. If that's
  the wrong tradeoff, adding a duration field to the quick-add row is a small
  follow-up.

## Verification

- [x] `npx tsc -b` clean
- [x] `npx vite build` clean
- [ ] **Not exercised in a browser** — none of the four changes has been
      clicked through
- [ ] Not exercised on a physical phone
