# v9 — Settings, and the Dashboard tells the truth

**Date:** 2026-07-28
**Commit:** pending approval
**Milestone:** M6

## Summary

**Settings** (`/settings`) is built: storage status, JSON export/import, and
per-feature clear. This is the first way to get data *off* the machine, and it
partly closes **OPS-017** — open since v5 and increasingly overdue as v7 added
five ways to destroy data and v8 migrated live data with no snapshot.

**The Dashboard's mission widgets now read the real Mission Board.** They had
been rendering `dashboard.missions` — four seeded percentages nothing could
change (**OPS-005**, open since v3). The Productivity Score card had the same
defect and is replaced by a Mission Status donut derived from real records.
This reverses ADR 0003, so it carries **ADR 0008**.

## Files modified

| File | Change |
|---|---|
| `src/lib/storageKeys.ts` | **New.** Namespace registry + `BLANK_VALUES` (the empty value per slice) |
| `src/hooks/useSettings.ts` | **New.** Export / import / clear, plus store health |
| `src/pages/Settings.tsx` | **New.** Replaces the `ComingSoon` placeholder |
| `src/lib/storage.ts` | `removeStorage` / `clearMirror` replace the old mirror-scoped export/import/reset |
| `src/lib/remoteStore.ts` | `dropKey`, `dropAll`, `reload` |
| `src/components/dashboard/MissionStatusChart.tsx` | **New.** Donut over real mission statuses |
| `src/components/dashboard/CurrentMissions.tsx` | Rewritten — reads `useMissionBoard()`, links to `/missions/:id` |
| `src/components/dashboard/ProjectProgress.tsx` | Rewritten, same. Retitled "Mission Progress" |
| `src/components/dashboard/ProductivityScore.tsx` | **Deleted** |
| `src/components/missions/MissionBadges.tsx` | `STATUS_HEX` — the four status colours as hex, for Recharts |
| `src/hooks/useDashboardData.ts` | Dropped `missions` / `productivityHistory` |
| `src/lib/types.ts` | `Mission` retired; `DashboardData` trimmed |
| `src/lib/seed.ts` | `seedMissions`, `seedProductivityHistory` removed |
| `src/App.tsx`, `src/pages/Contents.tsx` | Settings route + index status |

## Architectural decisions

**[ADR 0008] The Dashboard reads the real Mission Board** — supersedes ADR
0003. The two-mission-type split was defensible when written and had become the
worse failure: a widget showing numbers that cannot change is worse than no
widget, because it looks live. One mission type again; the Dashboard reads it
read-only and keeps its own register (shields, not pills — that's ADR 0004 and
still holds). `Mission`, `dashboard.missions`, `seedMissions` and
`dashboard.productivityHistory` are all retired.

**Settings is the second read-and-administer exception**, after the Activity
Log. It acts on every namespace and owns none, so it talks to the storage API
directly rather than through a feature hook. No ADR — it's the same sanctioned
shape, not a new pattern.

**Clearing writes the empty value; it does not delete the key.** This is the
one genuinely counter-intuitive decision here and it came from the owner
correcting the first implementation mid-build. Because an absent key falls
through to the feature's seed, `DELETE` would have made "clear the Dashboard"
hand back the demo tasks. `BLANK_VALUES` in `lib/storageKeys.ts` holds one
empty value per slice, and two of them can't be `[]`:

- `routine.sections` keeps its seven sections and start times — sections are
  fixed by the type with no UI to recreate one, so `[]` is a Daily Routine that
  can never be refilled.
- `theme.accent` returns to `"gold"` — a four-value union has no empty member.

**Import merges rather than replaces.** A slice missing from the backup is left
alone. That's the safer default for a restore, and it makes export → edit the
JSON → import a supported way to bulk-load data. The UI says so explicitly,
because "import" reads as "replace" to most people.

## Technical debt

**Resolved:**

- **OPS-005** — Dashboard mission widgets are real, and link through.
- **OPS-017, half of it** — there is finally a way to take a backup. The
  automation half is still open; see below.
- Dead surface removed: `Mission`, `seedMissions`, `seedProductivityHistory`,
  `ProductivityScore.tsx`, and the mirror-scoped `exportAllData`/`importAllData`/
  `resetAllData` that would have exported the wrong thing entirely.

**Introduced:** none knowingly. One coupling worth naming: the Dashboard now
depends on `missions.records`, where before it depended on nothing. That is the
point of the change, but renaming that slice now breaks three widgets.

## Documentation updated

- **[ADR 0008](../decisions/0008-dashboard-reads-the-real-board.md)** — new;
  ADR 0003 marked superseded, index updated.
- **`docs/data-model.md`** — both retired keys struck through; a new
  *"Clearing is a write, not a delete"* section, which is the thing most likely
  to bite whoever adds the next slice.
- **`docs/known-issues.md`** — OPS-005 closed; OPS-017 rewritten as partly
  addressed, with the automation gap and the missing pre-migration snapshot
  called out.
- **`docs/roadmap.md`** — Settings section; Dashboard section rewritten.
- **`CLAUDE.md`** — Settings in the status table; the feature-independence rule
  reworded to *"independent for writes, reads are allowed"*, which is what the
  codebase has actually done since v7.

## Outstanding issues

1. **Backup is manual.** Nothing is scheduled. `rsync` over SSH to the NAS on a
   timer is the obvious next step and needs no app changes.
2. **No pre-migration snapshot.** v8 migrated live data with nothing taken
   first. Taking an export before a migration is a habit, not a mechanism.
3. **Not exercised on a physical phone** — in particular the file picker for
   import, which is the one control here whose mobile behaviour I can't predict.
4. **Import can't be undone.** It merges into live data with no confirm step
   beyond the file picker. A confirm dialog showing which slices would change
   would be a cheap improvement.
5. **Upcoming Events still goes nowhere** — the owner has asked for a real
   events/calendar view behind it. Noted in the roadmap; not built.
6. **Weekly Goals and Streaks are still seeded** with no editors — the same
   class of defect OPS-005 just fixed, one level down.

## Recommended next milestone

**Events / calendar**, since the owner has asked for it directly and it removes
the last "looks live, isn't" widget from the Dashboard. It needs no external
permissions — a year view over an owned `events.*` namespace is ordinary local
data. (Syncing *external* calendars would need OAuth to a third party and is
barred by the self-hosted rule; a manual `.ics` import would not be.)

Then **Gym**, which the owner wants shaped around pasting a plan in from an
external LLM — that is really an import-format question, and worth designing
deliberately rather than growing.

## Assumptions & risks

- **Assumed merge-not-replace is the right import semantic.** It is safer, and
  the destructive alternative is reachable by clearing first. If a true
  "restore exactly this" is ever wanted it needs a server-side replace mode.
- **Assumed the file picker works over Tailscale.** It's a plain `<input
  type="file">` with no secure-context requirement, unlike the clipboard and
  File System Access APIs — but unverified on iOS Safari.
- **Import is blocked while writes are queued**, because a queued write would
  flush *after* the import and overwrite it. The block is a thrown error with an
  explanation, not a silent no-op.
- **Clear everything reads the server's key list**, not just the registry, so a
  slice added since this file was written still gets cleared — as a delete,
  falling back to its seed, if it has no `BLANK_VALUES` entry.

## Verification

- [x] `npx tsc -b` clean
- [x] `npx vite build` clean
- [x] **Clear semantics proven against a copy of the real store** (9 missions,
      4 tasks): `PUT {"value":[]}` leaves the key present as `[]`; `DELETE`
      removes it and the client falls back to seed. This is the distinction the
      whole design turns on
- [x] Throwaway test servers confirmed terminated
- [ ] **Not exercised in a browser** — export download, import file picker, and
      the clear buttons have not been clicked
- [ ] Not exercised on a physical phone
