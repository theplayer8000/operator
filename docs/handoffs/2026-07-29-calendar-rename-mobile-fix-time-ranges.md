# v12 — Calendar rename, mobile popup fix, start/finish time pickers

**Date:** 2026-07-29
**Commit:** pending approval
**Milestone:** M9

## Summary

Three pieces of direct owner feedback on v11's Events feature, addressed
together:

1. **Renamed "Events" to "Calendar"** in every user-facing place — nav,
   Contents index, command palette, page heading, Dashboard link text, Settings'
   clear-list label. The route moved from `/events` to `/calendar`. Nothing
   internal changed: the type, hook, storage key and component folder are all
   still named Events (`CalendarEvent`, `useEvents`, `events.records`,
   `components/events/`) — the same split already established for "Mission
   Board" over `missions.records`.
2. **Fixed the mobile scrolling complaint.** On a phone, tapping a day used to
   do nothing visible until you scrolled past however many month grids came
   after the one you were looking at — the owner's words: *"I thought it was
   broken at first... expecting it to come up as a popup."* Below `lg`, the day
   panel is now a scrim + floating overlay that opens on tap, closes on Escape
   or tapping the scrim, with the body scroll locked underneath — the same
   mechanism the Sidebar's mobile drawer already uses. At `lg`+, nothing
   changed: same component, same static column.
3. **Replaced the duration-in-minutes field with start/finish time pickers.**
   Both the quick-add row and the edit form now take two clock times; the app
   computes `durationMinutes` from the difference. Editing an existing event
   reconstructs the finish time from the stored start + duration, so the round
   trip is exact. The stored shape didn't need to change — this is a pure input
   improvement over the same `time` + `durationMinutes` fields the Day Schedule
   sync (v11) already reads.

Also confirmed, no code change: the "sync with daily tasks" request from the
previous turn was already satisfied by v11's `RoutineTimeline` merge — the
owner's follow-up description ("show any dates set on the calendar page in
daily tasks or today's schedule") matches what that sync already does. Flagged
back rather than assumed, in case the intent was actually broader (see
Assumptions below).

## Files modified

| File | Change |
|---|---|
| `src/App.tsx` | Route `/events` → `/calendar` |
| `src/components/layout/Sidebar.tsx`, `CommandPalette.tsx`, `src/pages/Contents.tsx` | Label "Events" → "Calendar"; `to` updated |
| `src/lib/storageKeys.ts` | Settings' clear-list label "Events" → "Calendar" (key `events.records` unchanged) |
| `src/components/routine/RoutineTimeline.tsx` | Footer copy "Events" → "Calendar" |
| `src/components/dashboard/CurrentTime.tsx`, `UpcomingEvents.tsx` | Links updated to `/calendar` |
| `src/pages/Events.tsx` | Page heading "Calendar"; mobile overlay state + scrim + body-scroll-lock effect; `onSelect`/"Next up" click now open the overlay |
| `src/components/events/DayPanel.tsx` | `onClose` prop + `lg:hidden` close button; start/finish time pickers replace the duration-minutes input, in both the quick-add row and the edit form; `rangeToDuration()` helper |
| `src/lib/seed.ts` | New seed entry describing this batch, in the owner's terms |
| `docs/design-system.md` | New responsive rule (detail-panel-as-overlay pattern); fixed a stale reference to the deleted `ProductivityScore.tsx` |

## Architectural decisions

**None new.** The mobile overlay is the Sidebar drawer's exact mechanism
(scrim, `fixed` + responsive positioning classes, Escape handler, body scroll
lock) applied to a second case — documented as a reusable pattern in
`design-system.md` now that there are two instances of it, so the next page
with a list-plus-detail-panel shape doesn't reinvent it.

One thing worth naming precisely: the body-scroll-lock effect is gated on
`window.innerWidth >= 1024`, checked once when the panel opens — **not** a
live-resizing media query. `mobilePanelOpen` can become `true` on a desktop
window too (any day tap sets it, regardless of viewport, since a day can be
selected at any width), and the CSS-only positioning swap (`lg:static` etc.)
correctly no-ops the *visual* overlay there — but the scroll-lock is a JS side
effect with no CSS equivalent, so it needs its own guard or it would lock
desktop scrolling for an overlay that isn't shown there. This is a narrower,
more deliberate version of the same simplification the Sidebar drawer uses
(there, the trigger button itself is `lg:hidden`, so the state can never
become true on desktop in the first place — Events' day-tap has no such
natural gate, hence the explicit width check).

## Technical debt

**Resolved:** a stale `design-system.md` reference to `ProductivityScore.tsx`,
deleted in v9 (ADR 0008) and never updated in that doc — found while adding the
new responsive rule next to it.

**Introduced:** none knowingly.

## Documentation updated

- **`docs/design-system.md`** — fifth responsive rule (detail-panel overlay
  pattern); the `STATUS_HEX`/Confetti hardcoded-hex note corrected to point at
  the components that actually exist.
- **`docs/roadmap.md`** — Events section retitled "Calendar", with the
  internal-vs-external naming split stated explicitly up front; start/finish
  input and the mobile overlay both documented.
- **`CLAUDE.md`** — status table row updated (label, route, all three v12
  changes, and the internal-naming note).
- **`docs/data-model.md`** — Events section now opens with the naming split;
  new paragraph on `rangeToDuration()` and why the UI never shows a raw
  duration field.

## Outstanding issues

1. **Still not exercised in a browser or on a phone.** The mobile overlay in
   particular — scrim behaviour, scroll lock, Escape, the drag-handle bar — is
   the part most likely to need a visual pass before it's trusted.
2. **The scroll-lock width check is a snapshot, not reactive.** Rotating a
   device or resizing across the `lg` boundary while the panel is open won't
   re-evaluate it until the panel is closed and reopened. Not worth solving
   for a single-user phone-or-desktop app; noted in case it ever surprises
   someone.
3. **Repeating events remains the most-requested-feeling gap** — the owner's
   NHS shift pattern is exactly the case one-at-a-time entry gets old for, and
   it's already logged as the top calendar-related pending item on `/updates`.

## Recommended next milestone

Unchanged: **Gym**, pending the owner's real plan. In the meantime, **repeating
events** is now the more concretely-requested gap on the Calendar itself, ahead
of Weekly Goals/Streaks editors on urgency if the owner's shift pattern is
starting to feel the friction.

## Assumptions & risks

- **Assumed "sync with daily tasks" was fully satisfied by v11's
  `RoutineTimeline` merge**, and that the owner's follow-up message was
  describing/confirming that behaviour rather than asking for something
  additional (e.g. events also appearing in the Dashboard's separate "Today's
  Tasks" checklist, which has no time dimension and wasn't touched). Flagged in
  the summary rather than guessed further — worth a direct answer if the
  reading was wrong.
- **Assumed the route rename to `/calendar` was intended**, not just the label.
  A bookmark or muscle-memory URL to `/events` will now 404 — acceptable for a
  single-user app with no external links in, but worth mentioning since it's
  the one part of this change that isn't purely additive.
- **Assumed `Events.tsx` as a filename should stay** rather than being renamed
  to `Calendar.tsx` — matches the established pattern of nav label differing
  from file/route names elsewhere (Activity Log → `ActivityLog.tsx` → `/log`),
  and avoids diff noise for a rename that's cosmetic at the file level.

## Verification

- [x] `npx tsc -b` clean
- [x] `npx vite build` clean, from a cache-cleared rebuild
- [x] **`rangeToDuration()` and the reconstruction path verified directly**
      via `node --experimental-strip-types`: 14:00→15:00 gives 60; equal,
      backwards, and missing-finish inputs all correctly yield no duration
      rather than a negative or zero one; reconstructing a finish time from a
      stored start (09:00) + duration (90) round-trips to the correct 10:30
- [ ] **Not exercised in a browser** — the mobile overlay, the wrapped
      start/finish inputs at phone width, and the rename are all unverified
      visually
- [ ] Not exercised on a physical phone
