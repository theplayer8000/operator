# v14 — Gym skip, occurrence skip split from delete, Claude status

**Date:** 2026-07-30
**Commit:** pending approval
**Milestone:** M9

## Summary

Picked up a batch of uncommitted work already sitting in the working tree
(no prior handoff existed for it) and finished, verified, and documented it.
Three pieces:

1. **Gym gets a "skip" state.** `gym.skipped` (new namespace, keyed by date)
   records a session that was scheduled and deliberately not trained —
   distinct from a rest day (nothing was scheduled) and distinct from a
   calendar skip (the calendar's `skipDates` says the block wasn't there;
   this says it was there and didn't happen). One tap, no confirm, clears any
   partial ticks, and shows "Actually, I trained" to undo.
2. **Calendar occurrence skip split from delete.** Previously, deleting a
   single occurrence of a repeating event silently meant "skip this day" —
   there was no way to remove a whole series at all. Now skip and delete are
   separate controls: skip (no confirm, undoable, shown on its own day via
   `skippedByDay`) drops one date from `skipDates`; delete (confirms) removes
   the series record entirely.
3. **Claude service status on `/dev`.** `server/status.mjs` polls
   `status.claude.com`'s public Statuspage summary, server-side, cached one
   minute, degrading to a stated-stale response or "couldn't reach it" rather
   than ever breaking the page. `ClaudeStatus.tsx` renders it. This is the
   second (of two) externally-approved outbound calls Operator makes — see
   the new "External applications" table in `CLAUDE.md`.

All three were already coded and the docs already partly rewritten to
describe them as done; nothing here needed a design decision, only
verification, the remaining doc updates, and a handoff. Confirmed against a
running dev server, over the browser tool, not just `tsc`/`vite build`.

## Files modified

| File | Change |
|---|---|
| `src/hooks/useGym.ts` | `gym.skipped` slice; `isSkipped`/`skipDay`/`unskipDay` |
| `src/pages/Gym.tsx` | Skipped-state card, "Skip this session" / "Actually, I trained" controls |
| `src/hooks/useEvents.ts` | `skippedByDay` (occurrences skipped per date, for the undo row); `expandSeries` takes a `want: "live" \| "skipped"` side |
| `src/components/events/DayPanel.tsx` | Skip button separated from delete; skipped-occurrences list with restore; delete's `ConfirmButton` now actually deletes |
| `src/pages/Events.tsx` | Wires `skippedByDay` / `unskipOccurrence` through to `DayPanel` |
| `src/lib/storageKeys.ts` | `gym.skipped` blank value + Settings clear-list description |
| `server/status.mjs` (new) | Fetches and caches `status.claude.com`'s summary |
| `src/components/dev/ClaudeStatus.tsx` (new) | Renders it on `/dev` |
| `server/index.mjs` | `GET /api/claude-status` route |
| `src/pages/Dev.tsx` | Mounts `<ClaudeStatus />` |
| `CLAUDE.md` | New "External applications" section (the approval table + the two rules); status table: Gym → Built, Dev → mentions the two new cards; skip-vs-delete rule added to the Destructive Actions section |
| `docs/data-model.md` | `gym.skipped` row + Gym section; skip-vs-delete rewritten; the OPS-020 exception for skip stated explicitly |
| `docs/roadmap.md` | New Gym section under Built (moved out of Not built); Dev section mentions Connected Clients + Claude status; Calendar's repeating-events paragraph updated for the v14 skip/delete split |

## Architectural decisions

None new — both skip patterns (Gym, Calendar) follow the same shape and are
now the reference implementation named in `CLAUDE.md`'s Destructive Actions
section: *no confirm, but only where an undo stays visible and adjacent*. Any
future skip-like action should match this, not invent its own variant.

Claude status follows the exact server-side-fetch-and-degrade pattern
`server/homelab.mjs` already established for Homelab's probes — same shape,
different upstream.

## Technical debt

**Resolved:** none directly, though the old occurrence-delete behaviour
(silently meaning skip, with no way to actually remove a series) was a real
gap, closed as a side effect of this split.

**Introduced:** none knowingly. `docs/roadmap.md` was already stale in two
unrelated places before this session (Gym missing from Built, Dev section not
mentioning the connected-clients monitor added in the prior commit,
657a334) — fixed in passing since this milestone touched both sections
anyway, not tracked as new debt.

## Documentation updated

- `CLAUDE.md` — External applications section, status table (Gym, Dev),
  Destructive Actions skip rule.
- `docs/data-model.md` — `gym.skipped`, Gym section, skip-vs-delete rewrite.
- `docs/roadmap.md` — Gym moved to Built; Dev and Calendar sections updated.

## Outstanding issues

1. **No history/adherence view.** `gym.completions` and `gym.skipped` are
   both real per-date data now with nothing charting them — a planned rest
   week and a dropped one are distinguishable in storage but not yet visible
   anywhere as a trend.
2. Everything else already known and unrelated to this milestone — see
   `docs/known-issues.md`.

## Recommended next milestone

Unchanged from the last handoff: **repeating events** is solid through
weekly + the skip/delete split, but monthly/yearly recurrence and multi-day
spans are still unmodelled if the owner's shift pattern needs them. Otherwise
**Weekly Goals/Streaks editors** on the Dashboard remain the largest
still-decorative surface (noted under Dashboard's known gaps).

## Assumptions & risks

- **Assumed this uncommitted work was finished, not mid-edit.** `tsc -b` and
  `vite build` were both already clean before I touched anything, and every
  function the UI called (`unskipOccurrence`, `skippedByDay`, etc.) already
  existed — nothing needed a code fix, only verification and the doc
  catch-up above.
- **Did not test on a physical phone.** The skip controls follow the existing
  44px-touch-target / no-hover-only pattern by inspection, but only the
  desktop browser tool exercised them this session.

## Verification

- [x] `npx tsc -b` clean
- [x] `npx vite build` clean
- [x] Exercised in a running browser against the real dev server and
      `data/operator.json`:
  - Gym: stepped to a training day, skipped it (card + copy changed,
    "Actually, I trained" appeared), undid it (ticks/progress UI returned)
  - Calendar: skipped today's recurring "GEH NHS shift" occurrence (dropped
    out of "Next up", upcoming count 289→288, appeared in the skipped list
    with a restore control), restored it (count and list both back to
    exactly the starting state)
  - Dev: Connected Clients and Claude status both rendered live data
    (`status.claude.com` reachable, "All Systems Operational")
  - No console errors on any of the three pages beyond pre-existing React
    Router future-flag warnings
- [ ] Not exercised on a physical phone
