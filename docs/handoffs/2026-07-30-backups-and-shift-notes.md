# v17–18 — Automated backups, approved abstractions, per-occurrence notes

**Date:** 2026-07-30
**Commits:** `99f6736` (backups + ADR 0009), plus this one pending approval
**Milestone:** M12

Third handoff of the day. Read `2026-07-30-per-date-routine-history.md` first for
the routine work that precedes this.

## Summary

The owner issued a set of explicit architectural decisions and a build order:
mark completed work complete → automatic backups → GEH shift notes → *then* the
AI foundation, in a named sequence. This covers all three of the pre-AI items.

**1. The updates log was behind.** Two queued items had shipped without being
marked. `updates.entries` is now 49 entries, 18 queued / 31 shipped:
"Day selector on Daily Routine" and "Tick tasks straight from the Day Schedule"
flipped to done with their detail rewritten in the log's owner-facing voice, plus
a new entry for the per-date ticks. Written through the API, not by hand.

**2. Automatic backups** — `scripts/backup.mjs`, in `99f6736`, already
committed and documented in [`development.md`](../development.md#backups). Key
points: standalone (no deps, no `src/` imports, never calls the API), refuses to
copy a broken store, verifies what it wrote before pruning, skips unchanged
stores so `KEEP=60` means 60 *distinct states*, local timestamps. Backups land
outside the repo. **No NAS exists yet** — the owner accepted local as the
interim, and `OPERATOR_BACKUP_DIR` is the whole migration when one arrives.
OPS-017 moved to "automated, still single-machine" rather than fixed.

**3. ADR 0009** records the approved abstraction boundaries — also in `99f6736`.
Storage Provider, Search Service, AI Provider Manager and Deployment
Configuration are permitted; generic repositories, ORMs and entity systems stay
forbidden. It carries a four-part test so the next request can be judged without
another ADR, plus the AI provider conditions and the terminal restrictions.

**4. Per-occurrence event notes** (`occurrenceNotes`) — this commit.

## Per-occurrence notes — the actual problem

`CalendarEvent.notes` is a property of the **series**. One stored record per
series (the whole point of the recurrence design) means editing `notes` writes
to all ~110 remaining GEH occurrences. Right for *"ward 4, ask for Sarah"*;
useless for *"missed bays 3 and 7 on Thursday"*, which is what the owner
actually needed:

> "because im on a collection right now and theres a couple areas ive missed out
> i need to report to my supervisor and let her know which arears where missed"

So `occurrenceNotes?: Record<string, string>` sits alongside `notes` — the second
per-date field on a series after `skipDates`, and following its conventions
exactly: keyed by local date, and a blank note **deletes its key** rather than
storing `""`, so an absent key always means "nothing written that day".

`occurrenceOn()` resolves the day's entry onto the expanded occurrence as
`occurrenceNote`, so no consumer indexes the map by date itself. That is what
stops the series note and the day note being confused — the two are different
fields with different names all the way to the JSX.

UI: a `NotebookPen` button on the occurrence row, **only when `seriesId` is
set** (a one-off's `notes` already means "this day"; a second field there would
be noise). The day note renders under a `border-l-2` rule labelled "This day",
in `rank` violet, so it reads as a different kind of thing from the series note
above it. The editor saves on **blur as well as the button**, because typing a
note and tapping away on a phone mid-shift is exactly how it would otherwise be
lost.

## The Work page question — answered, and it needs no migration

The owner's preference, raised mid-build: *"id add it to the work panel to be
honest or can i have it moved later on."*

**Nothing needs to move.** A shift *is* a calendar event; the note is per-date
data on that event. When `/work` is built it reads `useEvents()` read-only — the
same sanctioned cross-feature read `CurrentTime`, `HomelabStatus`, the Dashboard
mission widgets and the Day Schedule already use — and presents the notes as a
shift log. Writing continues to go through `useEvents`.

**Do not copy them into a `work.*` slice.** That is a second stored copy of one
fact, which is precisely what [ADR 0008](../decisions/0008-dashboard-reads-the-real-board.md)
exists to prevent. Recorded in `data-model.md` and `roadmap.md` so the next
session building Work doesn't "fix" this by duplicating.

The one thing Work genuinely adds is a **cross-series view** — every note for
this job, in order — which the calendar has no place for, since occurrence notes
are only reachable from the day they belong to. Logged as a known gap.

## Files modified (this commit)

| File | Change |
|---|---|
| `src/lib/types.ts` | `CalendarEvent.occurrenceNotes`; `EventOccurrence.occurrenceNote` |
| `src/hooks/useEvents.ts` | `occurrenceOn` resolves the day's note; `setOccurrenceNote(seriesId, date, text)` |
| `src/components/events/DayPanel.tsx` | Note button on repeating occurrences; "This day" rendering; inline editor saving on blur |
| `src/pages/Events.tsx` | Wires `setOccurrenceNote` through |
| `docs/data-model.md` | The series-vs-occurrence table, the conventions, and the Work-reads-it-not-owns-it rule |
| `docs/roadmap.md`, `CLAUDE.md` | Calendar entries updated |

## Architectural decisions

**None new for the notes** — `skipDates` already established per-date data on a
series, and this follows it. The genuinely new decisions today are in
[ADR 0009](../decisions/0009-permitted-abstraction-boundaries.md), which is the
owner's, recorded rather than made.

One judgement worth naming: the note editor **omits the key from the spread**
when there is no note (`...(occurrenceNote ? { occurrenceNote } : {})`) rather
than setting `undefined`. `occurrenceOn` spreads over a `CalendarEvent`, and an
explicit `undefined` in a spread overwrites — the **OPS-002** trap, which
TypeScript cannot catch.

## Technical debt

**Resolved:** OPS-017's automation half.

**Introduced:** clearing the last note leaves `occurrenceNotes: {}` rather than
removing the field. Harmless (the field is optional and an empty map reads as
"no notes"), and not worth a migration to tidy.

## Outstanding issues

1. **The backup schedule is not registered.** The script and docs exist; the
   `schtasks` command is the owner's to run — deliberately not executed from
   here, since it is persistent system configuration on his machine. Until then
   the mechanism exists and nothing drives it. `schtasks /query /tn "Operator Backup"`.
2. **Schema v3 still not applied to the live store** — the running server
   predates it and reports `schemaVersion: 2`. A no-op migration, but it needs a
   restart to land.
3. **No cross-series view of occurrence notes.** By design for now; it belongs
   on `/work`.
4. **Not exercised on a physical phone.** The note editor's blur-to-save is the
   part most worth checking there, since that is the interaction it was written
   for.

## Recommended next milestone

**The AI foundation, in the owner's stated order** — Embedded Claude Workspace,
then AI Provider Manager, AI Role Hierarchy, Operator Data Agent. All three
pre-AI items are now done.

Before starting the Workspace, note what ADR 0009 binds you to: **local machine
only**, no execution over the tailnet or any external network until real
authentication exists. The instruction that came with it is worth repeating
verbatim: *"Resolve any further architectural conflicts by asking before
implementation rather than making assumptions."*

## Assumptions & risks

- **Rewrote the two queued items' `detail` text** when marking them shipped,
  rather than only flipping status — every other shipped entry is written in that
  fuller "what changed for you" voice, and the terse one-line captures would have
  read as stubs in the changelog. The owner can edit either from the page.
- **Added a third log entry** ("Your routine ticks are kept per day now") that
  was not one of the two he named. It is a user-visible behaviour change and the
  log's own convention says shipped milestones get an entry; delete it if that
  was overreach.
- **Assumed the day note belongs on the calendar record** rather than waiting for
  `/work`, on the reasoning above. If that reasoning is wrong, the cost is one
  field and one button, not a migration.
- **`occurrenceNotes` is not surfaced anywhere except the day panel.** A note
  written on a day the owner never revisits is effectively invisible. The Work
  page is the fix; until then, the note button lights up in `rank` when a day has
  one, which is the only affordance.

## Verification

- [x] `npx tsc -b` clean
- [x] `npx vite build` clean
- [x] **Backups exercised before committing** — happy path, unchanged-skip,
      `--force`, `--list`; all four refusal paths (bad JSON, missing `state`,
      empty `state`, missing file) return exit 1 and leave existing restore
      points untouched; retention verified by seeding six fake points and
      running with `KEEP=3` (pruned 4, kept the 3 newest); and a **restore
      round-trip** — a backup file served as a complete store on a temp port
      (20 slices, routine sections, 9 events, 5 gym sessions, 49 updates).
      Temp server stopped, fixtures deleted.
- [x] **Occurrence notes exercised against the real store**, then cleaned up:
      note button appears only on the repeating occurrence; editor labelled
      "Note for today only"; saved to `occurrenceNotes["2026-07-30"]` with the
      series `notes` and `skipDates` untouched; rendered under "This day";
      **tomorrow's occurrence of the same series showed no note and an
      unhighlighted button**; reopening restored the draft; clearing deleted the
      key. Store left with `occurrenceNotes: {}` and no test data.
- [ ] Not exercised on a physical phone
