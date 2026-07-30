# v15 — Tickable Day Schedule, and a day stepper on it

**Date:** 2026-07-30
**Commit:** pending approval
**Milestone:** M10

**Read the v14 handoff first** — `2026-07-30-gym-skip-and-claude-status.md`. That
work is still uncommitted in the same working tree as this, and both touch
`docs/roadmap.md` and `docs/data-model.md`.

## Summary

Two owner queue items from `/updates`, both about the Day Schedule card on
`/routine`:

1. **"Tick tasks straight from the Day Schedule — rather than scrolling down to
   the section card."** Tapping a routine block now opens it in place and
   reveals its steps with working checkboxes, wired to the existing
   `toggleTask`. One block open at a time. The section list below is still
   where you add, rename, re-estimate or delete a step — this is a second
   surface for the one action you take repeatedly during the day, not a
   duplicate editor.
2. **"Day selector on Daily Routine — so you can look at what any day looks
   like, not just today."** The card gets a prev / Today / next stepper,
   copying the Gym page's pattern exactly.

No schema change, no new storage key, no new hook.

## The constraint the day selector ran into

Worth stating plainly, because it shaped the result and the next session will
otherwise try to "finish" it.

`routine.sections` stores **one `done` flag per step**, and the daily reset
(**OPS-009**) flips every `repeatDaily` step back to `false` once per local
day. Yesterday's ticks are not archived — they are destroyed. There is no
per-date routine history to read.

So the stepper can honestly show the **plan** for any date but only the
**record** for today. Off today:

- the checkboxes are **not rendered** — not disabled, not inert, gone;
- the block counter reads `6 steps` instead of `0/6`;
- the "on now" highlight and past-block dimming are suppressed, because
  "in progress" is a fact about today only;
- a footer line says so in the owner's terms.

Rendering checkboxes off today would either lie about a past day or write
today's state under another day's heading. Hiding them follows the precedent
`CLAUDE.md` already sets for the accent picker: shipping a control that does
nothing is worse than not shipping one.

What *does* change per date is the calendar events synced in — which shift,
whether there's a gym session — which is what "what does Tuesday look like" is
actually asking. Verified: stepping to Fri 31 July correctly picked up Darams
09:00, GEH NHS shift 17:00 and Gym — Legs & Core 23:00.

**If real per-date routine history is ever wanted**, it is a `routine.completions`
slice keyed by date (the shape `gym.completions` already uses), `done` moving
out of the task, and the daily reset retiring — a date with no entry is simply
untouched. Additive if the old `done` is left in place and ignored. It changes
what the reset *means*, so it is the owner's decision, not a refactor. Written
up in `docs/data-model.md` → Daily Routine.

## Files modified

| File | Change |
|---|---|
| `src/components/routine/RoutineTimeline.tsx` | Day stepper; per-block expand revealing tickable steps; every "today-only" truth (ticks, on-now, past dimming, counters, footer copy) gated on `isToday`; events read from the selected date |
| `src/pages/DailyRoutine.tsx` | Passes `sections` + `toggleTask` through (one line) |
| `CLAUDE.md` | Daily Routine status row now describes both, and states the no-per-date-history constraint so it doesn't get "fixed" blind |
| `docs/roadmap.md` | Daily Routine section documents both, and why the checkboxes vanish off today |
| `docs/data-model.md` | New paragraph under Daily Routine: no per-date history, what it constrains, and the `routine.completions` shape if it's ever wanted |

## Architectural decisions

**None new.** The stepper is the Gym page's pattern (`fromDateKey` → `setDate`
→ `toDateKey`, prev / Today / next, same classes and 44px targets). The
checkbox markup is lifted from `RoutineSectionCard` so the tick looks identical
in both places. `RoutineTimeline` still only *reads* `useEvents()` — the
sanctioned cross-feature read — and writes only through `onToggleTask`, which
belongs to the routine's own hook.

Day-selector state lives inside `RoutineTimeline` rather than being lifted to
the page, because nothing else on `/routine` is date-scoped: the section cards
are day-agnostic by design. Lifting it would imply the whole page moves off
today, which is not what happens and would need a much bigger answer.

## Technical debt

**Resolved:** none.

**Introduced:** none knowingly. The `routine.completions` option above is a
documented open decision, not debt — nothing is currently broken by its absence.

## Documentation updated

`CLAUDE.md`, `docs/roadmap.md`, `docs/data-model.md` — all three as described
above. The constraint is written in all three deliberately: the status table is
where someone checks what exists, the roadmap is where they read what it's
for, and the data model is where they'd go to change the shape.

## Outstanding issues

1. **`routine.sections[work]` has zero steps**, so the Work block is filtered
   out of the schedule entirely (empty sections hide — `f0cf404`). Correct
   behaviour, but it means the 17:00 GEH shift shows as a calendar event with
   no routine block behind it. Not a defect; noting it because it looks like one.
2. **The Gym block and the "Gym — …" calendar event both render at 23:00**, one
   from the routine and one from the calendar. Pre-existing consequence of the
   v11 sync, unchanged here.
3. **Not exercised on a physical phone.** Row heights were measured in-browser
   (49px blocks, 44px steps) but the one-handed reach of an expanded block on a
   real device is unverified.

## Recommended next milestone

**The "notes section for GEH shifts" queue item** — and it needs a decision
before it can be built, which is why it wasn't done here. The owner asked for
notes on a shift ("a couple areas ive missed out i need to report to my
supervisor"). Event notes already exist and already render (`a84328a`), **but
GEH NHS shift is a single recurring record**, so a note written on it applies
to all ~110 remaining occurrences, not to Thursday's collection. Delivering
what was actually asked for means **per-occurrence overrides** — a new shape
alongside `skipDates`, e.g. `occurrenceNotes: { [dateKey]: string }` on the
series record. That is the first time a recurring event would carry per-date
data other than a skip, so it sets a pattern; worth agreeing the shape before
writing it.

## Assumptions & risks

- **Assumed the day selector belongs to the Day Schedule card, not the whole
  page.** The section cards are identical every day, so a page-level date would
  have nothing to change in them.
- **Assumed one-block-open is right** rather than all-expanded or persisted
  expansion state. Seven blocks open at once is just the section list again.
- **Tested against the owner's real `data/operator.json`**, because that is
  what the running server is bound to. A step was ticked and unticked, and a
  calendar occurrence skipped and restored; the store was re-read afterwards
  and confirmed byte-equivalent in the fields touched (`Make bed` back to
  `done: false`, all `skipDates` empty, `gym.skipped` still just `2026-07-29`).
  No test data was left behind.

## Verification

- [x] `npx tsc -b` clean
- [x] `npx vite build` clean
- [x] Exercised in a browser against the running dev server and the real store:
  - Expanded the Morning block from the schedule → 6 steps revealed
  - Ticked "Make bed" → block counter 0/6 → 1/6, page summary 0/19 → 1/19
    steps and 0 → 2 min, and `PUT routine.sections` confirmed server-side
  - Stepped to Fri 31 July → subtitle "Friday 31 July · Tomorrow", 3 correct
    calendar events appeared, counters switched to "N steps", expanded block
    rendered **0 checkboxes**, both footer lines correct
  - Returned to Today and unticked → store restored to `done: false`
  - Hit-testing and touch targets measured: block rows 49px, step rows 44px,
    row centres hit-test to their own button (no overlay)
- [ ] Not exercised on a physical phone
