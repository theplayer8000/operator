# v10 — Events, and the last of the fake widgets

**Date:** 2026-07-28
**Commit:** pending approval
**Milestone:** M7

## Summary

**Events** (`/events`) is built: the year as twelve month grids, a day panel to
add/rename/delete, and a "Next up" list. The Dashboard's Upcoming Events widget
now reads it and links in — it previously rendered `dashboard.events` seed data
that opened into nothing, which is what the owner asked to fix.

That removes the **last** "looks live, isn't" widget from the Dashboard. Every
number on the homepage now traces to something the owner entered.

**OPS-009 is fixed** as a companion, because building the calendar produced the
verified tool for it — and demonstrated the bug concretely.

## Files modified

| File | Change |
|---|---|
| `src/lib/time.ts` | `toDateKey`, `fromDateKey`, `daysFromToday`, `relativeDay`, `monthGrid`, month/weekday names |
| `src/lib/types.ts` | `CalendarEvent` + `EventKind`; `UpcomingEvent` retired |
| `src/lib/seed.ts` | `seedEvents` converted to `CalendarEvent[]` with local date keys |
| `src/hooks/useEvents.ts` | **New.** Owns `events.records`; derives by-day, upcoming, years |
| `src/components/events/MonthGrid.tsx` | **New.** One month, Monday-first, dots per day |
| `src/components/events/DayPanel.tsx` | **New.** Selected day: list + add/edit/delete |
| `src/components/events/eventMeta.ts` | **New.** Five kinds, coloured from existing tokens |
| `src/pages/Events.tsx` | **New.** Year view + legend + Next up |
| `src/components/dashboard/UpcomingEvents.tsx` | Rewritten — reads `useEvents()`, links to `/events` |
| `src/hooks/useRoutineData.ts` | **OPS-009** — local date comparison + visibility/focus re-check |
| `src/hooks/useDashboardData.ts` | Dropped `events` |
| `src/lib/storageKeys.ts` | `events.records` slice; `dashboard.events` marked retired |
| `src/App.tsx`, `Sidebar.tsx`, `CommandPalette.tsx`, `Contents.tsx` | Route + nav + index |

## Architectural decisions

**None new — the established recipe.** One namespace, one hook, one folder, one
page; the Dashboard widget reads it read-only, which is the pattern ADR 0008
settled. No ADR warranted.

Four choices worth recording:

- **Dates are local `"YYYY-MM-DD"` keys, not timestamps.** A birthday is the 3rd
  of March wherever you are. This also sidesteps timezone drift entirely for
  storage.
- **`time` is optional and absent means all-day**, written as an omitted key
  rather than an explicit `undefined` — the spread trap from `architecture.md`.
- **Repeating events, multi-day spans and reminders are deliberately not
  modelled.** Each is a real calendar feature. Faking a repeat by writing N
  copies makes editing the series impossible and is the standard way calendar
  data rots.
- **Kinds colour from existing tokens** rather than a new palette, so the
  calendar still looks like the same app.

## Technical debt

**Resolved: OPS-009.** Two defects in one effect:

1. `new Date().toISOString().slice(0, 10)` is the **UTC** day. Between midnight
   and 01:00 during BST that reports yesterday, so the routine rolled an hour
   late for half the year.
2. It ran on mount only, so a tab left open across midnight never reset — a
   phone in a pocket overnight, which is the case that actually happens.

Both fixed. Demonstrated under `TZ=Europe/London` before the change: at 00:30 on
2 July, `toDateKey` → `2026-07-02`, `toISOString().slice(0,10)` → `2026-07-01`.
The machine is currently on UTC+1, so this was live, not theoretical.

**Introduced:** none knowingly.

## Documentation updated

- **`docs/known-issues.md`** — OPS-009 closed, with the before/after table and
  the generalised rule (*never build a calendar day with `toISOString()`*).
- **`docs/data-model.md`** — `events.records` in the registry; an Events section
  covering the date-key rule and what is deliberately not modelled;
  `dashboard.events` struck through.
- **`docs/roadmap.md`** — Events section, including the permissions answer;
  Dashboard gap list trimmed.
- **`CLAUDE.md`** — Events in the status table; `lib/time.ts` entry now carries
  the `toDateKey` warning where someone will actually see it.

## Outstanding issues

1. **Not exercised in a browser or on a phone.** The month grids at 390px and
   the native date/time inputs are the parts most likely to need adjusting.
2. **No repeating events.** The owner's routine has weekly shifts; entering
   those one at a time will get old fast. This is the most likely next request
   and should be designed (a `recurrence` field + expansion at read time), not
   grown.
3. **No way to jump to an arbitrary year** beyond stepping one at a time. Fine
   for ±2 years, annoying beyond.
4. **Past events accumulate forever** with no archive or prune. Harmless at this
   scale; worth a thought before it's years deep.
5. **OPS-017 automation still open** — backup is manual.
6. **Weekly Goals and Streaks** remain seeded with no editors — the last two
   decorative widgets on the Dashboard.

## Recommended next milestone

**Gym**, which the owner has explicitly parked until they can share a real
plan — the right call, since the whole feature turns on the shape of the
imported data and designing a parser against a guessed format would be wasted
work.

Until that arrives, **Weekly Goals and Streaks editors** are the obvious
tidy-up: same defect class as OPS-005, small, and it would leave the Dashboard
with nothing decorative left on it.

## Assumptions & risks

- **Assumed Monday-first weeks.** UK convention and matches how the owner's week
  starts; would be wrong for a US user, which this isn't.
- **Assumed five event kinds** are enough. They're colour-only, so adding one is
  cheap — but existing events would need remapping if any were removed.
- **Assumed native `<input type="date">`/`<input type="time">`** behave over
  Tailscale. They need no secure context, unlike the clipboard APIs, but this is
  unverified on iOS Safari.
- **The year view renders 12 grids at once** — 365+ buttons. Fine on desktop,
  and each is a plain button with no per-cell listeners, but unmeasured on an
  older phone.

## Verification

- [x] `npx tsc -b` clean
- [x] `npx vite build` clean
- [x] **Date helpers exercised directly** via `node --experimental-strip-types`:
      Monday-first offset correct (Feb 2026 starts Sunday → six leading blanks),
      28/29-day months correct across a leap year, round-trip
      `toDateKey`/`fromDateKey` stable, invalid keys return `null`
- [x] **OPS-009 bug reproduced and fixed** under `TZ=Europe/London` — the 00:30
      BST case returned the wrong day before the change
- [ ] **Not exercised in a browser** — no month grid, day panel or form has been
      clicked
- [ ] Not exercised on a physical phone
