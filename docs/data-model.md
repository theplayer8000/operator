# Data Model & Storage

Everything Operator knows lives in **`data/operator.json`**, served by
`server/index.mjs`. This document is the registry of what is stored, what shape
it has, and the rules for changing it.

## Where the data is

```json
{
  "schemaVersion": 2,
  "updatedAt": "2026-07-28T03:27:36.006Z",
  "state": {
    "missions.records": [ ... ],
    "routine.sections": [ ... ]
  }
}
```

The path defaults to `data/operator.json` and is overridable with
`OPERATOR_DATA` — that is the knob that points it at a NAS mount. It is
**gitignored**, so git is not a backup (**OPS-017**).

`localStorage` is still written, under the same keys prefixed with `os.`
(`lib/storage.ts:7-9`), but only as an **offline read mirror**. It is never the
source of truth. Anything reading it directly is either `remoteStore` or a bug.

### API

| Route | Purpose |
|---|---|
| `GET /api/state` | The whole store |
| `PUT /api/state/<key>` | Replace one slice; body `{ value }` |
| `PUT /api/state` | Bulk merge; body `{ key: value }` — used by import and the one-time localStorage migration |
| `DELETE /api/state/<key>` | Drop a slice back to its seed |
| `GET /api/health` | Liveness + which file is in use |
| `GET /api/dev/meta` | Repo branch, commit, remote — read-only |
| `GET /api/dev/tree?path=` | Directory listing, sandboxed to the repo |
| `GET /api/dev/file?path=` | Text file contents, 400 KB cap |
| `GET /api/homelab/status` | Reachability of the services in `homelab.services` — see [ADR 0007](decisions/0007-homelab-server-side-probes.md) |

The `/api/dev/*` routes are read-only and never touch the store — see
`server/dev.mjs` and **OPS-018**.

Writes are atomic: temp file then `rename`, so a crash cannot truncate the
store.

### Key registry

| Key (`os.` prefix implied) | Type | Owner | Mutable in UI |
|---|---|---|---|
| `dashboard.focus` | `string` | `useDashboardData` | Yes |
| `dashboard.tasks` | `Task[]` | `useDashboardData` | Add, toggle, edit, delete |
| ~~`dashboard.missions`~~ | — | — | **Retired v9** — no reader. Dashboard reads `missions.records` ([ADR 0008](decisions/0008-dashboard-reads-the-real-board.md)). Kept in `BLANK_VALUES` so existing stores can be cleared of it |
| `dashboard.weeklyGoals` | `WeeklyGoal[]` | `useDashboardData` | **No** — read-only display |
| `dashboard.streaks` | `Streak[]` | `useDashboardData` | **No** — read-only display |
| `dashboard.events` | `UpcomingEvent[]` | `useDashboardData` | **No** — read-only display |
| `dashboard.notes` | `QuickNote[]` | `useDashboardData` | Add, edit, delete |
| `dashboard.activity` | `ActivityItem[]` | `useDashboardData` | Appended by mutators, capped at 20 |
| ~~`dashboard.productivityHistory`~~ | — | — | **Retired v9** — the card charting it was seven fixed numbers presented as a trend. Replaced by `MissionStatusChart` |
| ~~`dashboard.events`~~ | — | — | **Retired v10** — Events is a real feature now; the widget reads `events.records` |
| `routine.sections` | `RoutineSection[]` | `useRoutineData` | Yes |
| `routine.completions` | `RoutineCompletions` (`{ [date]: taskId[] }`) | `useRoutineData` | Yes — ticked per date, key dropped when a day empties |
| `routine.lastReset` | `string` (`YYYY-MM-DD`) | *none — retired in v3* | Orphan; kept only so a clear removes it |
| `missions.records` | `MissionRecord[]` | `useMissionBoard` | Yes, incl. archive + delete |
| `events.records` | `CalendarEvent[]` | `useEvents` | Yes |
| `homelab.services` | `HomelabService[]` | `useHomelab` | Yes — the server also reads this slice to know what to probe |
| `gym.sessions` | `GymSession[]` | `useGym` | Not yet — the programme is edited in source/seed |
| `gym.completions` | `GymCompletions` (`{ [date]: exerciseId[] }`) | `useGym` | Yes — ticked per date, key dropped when a day empties |
| `gym.skipped` | `string[]` (`YYYY-MM-DD`) | `useGym` | Yes — days scheduled and deliberately not trained |
| `updates.entries` | `UpdateEntry[]` | `useUpdates` | Yes |
| `theme.accent` | `AccentColor` | `ThemeContext` | No UI exists yet (**OPS-007**) |

Keys are created lazily — a slice only appears in the store once something
writes it. Until then the feature reads its seed.

### Clearing is a write, not a delete

**This is the trap in the whole registry.** Because an absent key falls back to
the feature's seed, `DELETE /api/state/<key>` does not empty a slice — it
restores the demo content. Settings therefore **writes the empty value**
(`PUT` with `[]`, `""`, …) rather than deleting, and `lib/storageKeys.ts` holds
one blank value per key.

Two slices can't be blanked to nothing and stay usable, and both are encoded
there: `routine.sections` keeps its seven sections and start times (sections are
fixed by the type — there is no UI to recreate one, so `[]` is a Daily Routine
you can never refill), and `theme.accent` returns to `"gold"` (a four-value
union has no empty member).

A key with no entry in `BLANK_VALUES` is deleted instead — falling back to a
seed beats guessing an empty shape. Add new slices to that map.

Five of the nine Dashboard slices are display-only today. That is a product
gap, not an architectural one — the storage and hook plumbing is already there
for whenever they get editors.

## Types

All domain types live in `lib/types.ts`, one section per feature, **appended
never interleaved** (`CLAUDE.md, "Architecture pattern"`). Keep the `// --- Feature Name ---`
section-comment style.

### Shared

`ID` (a `string` alias) and `Priority` (`"low" | "medium" | "high"`).

### Dashboard

`Task`, `Mission`, `WeeklyGoal`, `Streak`, `UpcomingEvent`, `QuickNote`,
`ActivityItem`, and a `DashboardData` aggregate interface.

Three known dead members, all at `lib/types.ts:8-25`:

- `DashboardData` (`lib/types.ts:90`) is declared and never used anywhere.
- `Task.dueDate` — declared, never read or written.
- `Task.missionId` — declared, never read or written. Worth noting explicitly:
  this is the tasks→missions link the product philosophy rests on, and it is
  currently just a comment. Wiring it is a product decision, not a cleanup.

### Daily Routine

`RoutineSectionKey` is a **closed union** of seven keys — `morning`, `work`,
`gym`, `learning`, `forex`, `evening`, `sleep`. The shape of a day is fixed by
design; users edit tasks and notes within sections, not the sections themselves.
Adding a section means editing the union, `seedRoutineSections`, and
`components/routine/routineMeta.ts` (icon + caption) together.

`RoutineTask` carries `estimatedMinutes` and `repeatDaily`, which drive the
minute totals and the daily reset respectively.

`RoutineSection.startTime` is a **local wall-clock string** (`"HH:MM"`, 24h),
added in schema v2. It is not a timestamp: a routine happens at 06:30 every
day, not at one instant. A block's **end is derived**, never stored — start
plus the section's task minutes — so it stays honest when tasks are added or
re-estimated.

`ScheduleBlock` (start, end, duration, done/total, `overlapsPrevious`) is
computed in `useRoutineData` per render and never persisted. It is sorted by
start time rather than array order, because the day is what the clock says, not
what order the sections happen to sit in.

**The offline mirror is never migrated.** Migrations run on the server, so a
cold start with the server down can hand the client pre-v2 sections with no
`startTime`. Both `useRoutineData` and `RoutineSectionCard` defend against that
— a missing start reads as 09:00 rather than crashing. Any future field added
to a persisted shape needs the same treatment.

**Routine completion is keyed by date (schema v3), and the nightly reset is
gone.** `routine.completions` is `{ [dateKey]: taskId[] }` — the same shape as
`gym.completions`, for the same reason. A date with no entry is simply a date
nothing was ticked on, so there is nothing to roll back, no marker to keep, and
last Tuesday stays readable.

Before v3 completion was a single `done` flag per step and a nightly effect
flipped every repeating step back to `false`. **OPS-009** fixed *when* that ran
(it compared UTC and only ran on mount); it could not fix the deeper problem,
which was that the reset **destroyed the record rather than archiving it** — the
routine had no history at all, only current state overwritten each midnight.
Removing the reset is what made a day stepper on `/routine` meaningful.

Two consequences the UI has to respect:

- **`RoutineTask.done` is still the truth for one-off steps**, and only those. A
  step with `repeatDaily: false` is done once and stays done on every date, so
  its state belongs to the step, not to a day. For a repeating step the field is
  **ignored** — read `routine.completions`. `useRoutineData.isDoneOn` is the one
  place that decides this; don't read `task.done` directly.
- **`routine.lastReset` is retired.** No reader remains. It stays in
  `BLANK_VALUES` only so a Settings clear takes it out of existing stores
  instead of leaving an orphan.

The v2 → v3 migration credits anything already ticked to **today** rather than
discarding it. That is a guess about when it happened, but it is the only date
the old shape supports, and the old reset means a `done: true` can only have
been set since the last local midnight. It builds the date from local parts,
never `toISOString()` (OPS-009). `done` is left on the task untouched —
additive only.

### Mission Board

`MissionRecord` is the richest type in the app — see `CLAUDE.md, "Mission Board detail"` for the
full field list. Structural notes:

- `milestones: Milestone[]` is **embedded**, not a separate key. A milestone has
  no independent existence.
- `dependsOn: ID[]` is **directional and one-way**. Successors are computed by
  filtering (`hooks/useMissionBoard.ts:136`); there is no reverse field to keep
  in sync, and there should not be. Nothing currently prevents a dependency
  cycle — `DependencyEditor` excludes only self-reference
  (`components/missions/DependencyEditor.tsx:12`).
- `activity: MissionActivityEntry[]` is embedded and capped at 30
  (`hooks/useMissionBoard.ts:31`).
- `relatedLearning` and `relatedJourneyMilestone` are **free text standing in
  for future foreign keys** into Knowledge Vault and Journey. When those
  features exist, these become the migration point.
- `archived: boolean` is filtered on and now settable — `setArchived` in
  `useMissionBoard`, surfaced at the bottom of `MissionDetail` with an
  "Archived" filter on the board so a record can be got back.
- **Deleting a mission sweeps its ID out of every other mission's `dependsOn`**
  in the same write (`deleteMission`). Because successors are computed rather
  than stored, a leftover ID is not a visibly broken link — it is an invisible
  one that changes nothing until the ID is reused. The invariant lives in the
  hook, not the caller.

### Events

**Labelled "Calendar" in the UI as of v12** (route `/calendar`) — the type,
hook, storage key and folder are still named Events, matching how "Mission
Board" sits over `missions.records`. This section covers the internal shape.

`CalendarEvent` is title, `date`, optional `time`, optional `durationMinutes`,
`notes`, and a `kind` used only for colour.

**The UI never shows a duration field.** `DayPanel` takes a start and a finish
time and computes `durationMinutes` from the difference (`rangeToDuration()`);
editing an existing event reconstructs the finish time from the stored start +
duration so the round trip is exact. An end at or before the start is treated
as "no duration", not an error — the event still saves as a point-in-time
entry. Two clock times are a better interface than typing a number of minutes,
and the stored shape (`time` + `durationMinutes`) didn't need to change to get
that — it's what `RoutineTimeline`'s sync already reads.

**`date` is a local calendar day (`"YYYY-MM-DD"`), not a timestamp.** A birthday
is the 3rd of March wherever you are. Build it with `toDateKey()` from
`lib/time.ts` and never with `toISOString().slice(0, 10)` — that converts to UTC
first, so every event created between midnight and 01:00 BST lands on the
previous day. This is the same defect as **OPS-009** and the reason that helper
exists. (`routine.lastReset`'s blank value in `lib/storageKeys.ts` had this
exact bug too — found and fixed alongside Updates, v11.)

`time` is optional and absent means all-day. `durationMinutes` is only
meaningful alongside `time` — an all-day event has no slot to occupy — and is
dropped whenever `time` is cleared. Both are **omitted keys** when absent on
create, but an **explicit `undefined`** when clearing an existing value on
edit — see the spread trap in `architecture.md`; both directions are
deliberate, not inconsistent.

Everything else (the by-day index, upcoming, the year list) is derived in
`useEvents` per render and never stored, so an event can't appear in two places
that disagree.

**A timed event reads onto the Daily Routine's Day Schedule, read-only.**
`RoutineTimeline` calls `useEvents()` directly and interleaves today's timed
events with routine blocks by start time — the same sanctioned cross-feature
read `HomelabStatus` and `CurrentTime` already use (see `architecture.md`).
Events remains the sole owner and sole writer of `events.records`; nothing
about this merge is stored. An event overlapping a routine block is normal (a
call during the Work block), so it's excluded from the `overlapsPrevious`
conflict warning, which stays scoped to routine-block-on-routine-block
overlaps only.

### Recurring events

Added v13, driven by the owner's work shifts (GEH Mon–Fri, Darams Mon/Tue/Thu,
both to end of year — 179 occurrences that are really two rules).

**One stored record per series, never one per occurrence.** `recurrence` is
`{type: "weekly", weekdays: number[], until: string}` where weekdays are **ISO**
(1 = Monday … 7 = Sunday, via `isoWeekday()` — deliberately not `getDay()`'s
0 = Sunday, because an off-by-one in a persisted rule is silent and horrible).
Occurrences are expanded per render in `useEvents`.

Expansion produces `EventOccurrence`: a copy of the record with `date` set to
that day and a **synthetic `id` of `ruleId@date`** so React keys stay unique,
plus `seriesId` carrying the real record id. Every mutator calls `resolveId()`
first, so a caller can pass whichever id it happens to be holding without
knowing which it is.

Three consequences the UI has to respect, all enforced in `DayPanel`:

- **Editing an occurrence edits the series.** Stated in the edit form, not left
  to be discovered.
- **The date field is hidden for a series.** A series' `date` is the rule's
  *anchor*, not that occurrence's day — writing an occurrence's date back would
  silently reshape every other occurrence. `commitEdit` omits `date` entirely
  when `seriesId` is set.
- **Skipping an occurrence adds to `skipDates`, it doesn't delete the record.**
  That's annual leave, a swapped shift, a bank holiday — the action wanted
  almost every time. It has its own control (v14); before that, *delete* on an
  occurrence quietly meant skip, which left no way to remove a series at all.
  Delete now means delete, behind the usual confirm.

Skipping is the one destructive-looking action in Operator with **no confirm
step**, and the exception is deliberate: `skippedByDay` re-renders the skipped
occurrence on its own day with an undo, so nothing is lost to a mis-tap. That
also means the general no-undo rule (**OPS-020**) does not apply here — if you
ever make a skip unrecoverable, put the confirm back.

**`occurrenceNotes` is the second per-date field on a series** (v18), and the
reason it exists is that `notes` is a property of the *series*. One stored
record means editing `notes` writes to every occurrence — right for standing
information ("ward 4, ask for Sarah"), useless for what happened on a
particular Thursday. So:

| Field | Scope | Reach it via |
|---|---|---|
| `notes` | the whole series (or the single event, for a one-off) | the edit form |
| `occurrenceNotes[date]` | **one day** of a series | the note button on that day's row |

Same conventions as `skipDates`: keyed by local date, and a blank note **deletes
its key** rather than storing `""`, so an absent key always means "nothing
written that day". `occurrenceOn()` resolves the day's entry onto the expanded
occurrence as `occurrenceNote`, so no consumer indexes the map by date itself —
which is what stops the series note and the day note being confused for each
other. The note button only appears on a repeating occurrence: a one-off's
`notes` already means "this day", and a second field there would be noise.

**This is stored on the calendar deliberately, and the Work page will read it,
not own it.** The owner's intent is for shift notes to surface in Work
(`/work`, unbuilt) once that exists. Nothing needs to move when it does — a
shift *is* a calendar event, the note is per-occurrence data on that event, and
Work reading `useEvents()` is the same sanctioned cross-feature read the
Dashboard and Day Schedule already do. Writing still goes through `useEvents`.
Do **not** copy these into a `work.*` slice; that would be the second stored
copy of one fact, which is what [ADR 0008](decisions/0008-dashboard-reads-the-real-board.md)
exists to prevent.

Still not modelled, deliberately: **multi-day spans, reminders, monthly/yearly
recurrence.** Weekly exists because there was a real case for it. Add the
others the same way — when something actually needs them.

### Gym

`gym.completions` is keyed by local date, not a `done` flag on the exercise —
so nothing needs resetting between sessions and last Tuesday stays readable.

`gym.skipped` is **not** the same as skipping the gym block on the calendar,
and the duplication is intended. The calendar's `skipDates` says *the block
wasn't there*; `gym.skipped` says *the block was there and I didn't train*.
Adherence has to distinguish a planned rest week from a dropped one. Writes stay
inside each feature's own hook: `useGym` never touches `events.records`.

### Homelab

`HomelabService` is a pointer and nothing more: name, description, host, port,
path, protocol, stack. Operator never embeds, proxies, or shares data with the
services it lists — deleting a tile removes the pointer, never the service.

Two things about this slice are unlike every other one:

- **The server reads it too.** `GET /api/homelab/status` probes exactly the
  services in `homelab.services` and takes no host/port parameter, so it cannot
  be used as a port scanner. See
  [ADR 0007](decisions/0007-homelab-server-side-probes.md).
- **Its seed is pushed to the server on first run.** Every other feature's seed
  can live in the browser indefinitely, because only the browser reads it. Here
  the server needs the list, so `useHomelab` writes the seed once — guarded on
  a successful online load via `hasOnServer()`, since writing after a *failed*
  load would overwrite real data with seed data.

`ServiceStatus` (online, latency) is derived per request and **never
persisted** — the same rule the Activity Log follows.

`host` is stored as seen from the box running the storage server, so usually
`localhost`. `serviceUrl()` in `useHomelab.ts` rewrites that to the browser's
current hostname when building a link, which is what makes one stored config
open correctly from both the desk and the phone.

### Updates

`UpdateEntry` is title, `detail`, `status` (`"done" | "pending"`), and an
optional `date` — present only once something is done, since there's nothing
to date about a pending entry. `date` is a `toDateKey()` local calendar day,
same rule as Events.

This is a log **for the owner**, not an engineering handoff: entries are
written in plain terms (see the seed content in `lib/seed.ts` for the register
to match), not commit-message jargon. It is distinct from the Activity Log,
which aggregates the owner's own task/mission activity — Updates is about
Operator's own development, reviewable in the app instead of dug out of git.

Marking an entry done sets `status` and stamps `date` in the same call;
moving it back to pending clears `date` with an **explicit `undefined`** —
the deliberate-overwrite direction of the spread trap, not the omitted-key one.

## Seed data

`lib/seed.ts` holds one export per feature: `seedTasks`, `seedWeeklyGoals`,
`seedStreaks`, `seedEvents`, `seedNotes`, `seedActivity`,
`seedRoutineSections`, `seedUpdates`, `seedHomelabServices`,
`seedMissionRecords`. (`seedMissions` and `seedProductivityHistory` were
retired in v9 along with the Dashboard's old fixed-data widgets — see
[ADR 0008](decisions/0008-dashboard-reads-the-real-board.md) — and no longer
exist; don't go looking for them.)

Date helpers at the bottom of the file (`futureMonth`, `pastDays`, `nextDays`,
`hoursAgo`, `lib/seed.ts:372-391`) keep seed content relative, so a fresh
install never shows stale absolute dates.

**Seed IDs are short literals** (`"t1"`, `"r1"`, `"mb-homelab"`, `"m1"`) while
user-created IDs are UUIDs. This is deliberate and useful — a literal ID in
storage tells you the record has never been replaced. Note that milestone seed
IDs (`m1`, `m2`, `m3`) are only unique **within** their mission, not globally;
that is fine because milestones are embedded, but don't assume global
uniqueness.

Because of Invariant 4 in `architecture.md`, **changing a seed only affects
browsers that have never run the app.** Seeds are not a migration mechanism.

## ID generation

**Always `generateId()` from `lib/id.ts`. Never `crypto.randomUUID()`.**

Operator is used over Tailscale at a bare IP, which browsers treat as a
non-secure context, so `crypto.randomUUID` is undefined there and throws.
`generateId()` uses it when available and falls back to a timestamp-plus-random
string otherwise. This was the app's one crash bug (**OPS-001**).

## Changing a persisted shape — read this first

**Bump `SCHEMA_VERSION` in `server/index.mjs` and add a migration.** The
`MIGRATIONS` array runs oldest-first on load. **The array is indexed by the
version being migrated *from*** — `migrate()` reads `MIGRATIONS[current]` where
`current` starts at the store's own `schemaVersion`. So the v1 → v2 step is at
index **1**, not 0, and index 0 is the v0 → v1 slot:

```js
const MIGRATIONS = [
  null,                            // 0 -> 1: nothing; v1 was the first shape
  (store) => {                     // 1 -> 2
    for (const m of store.state["missions.records"] ?? []) m.tags ??= [];
    return store;
  },
];
```

A `null` (or any non-function) entry is skipped and the version still bumps,
which is what makes the index-0 placeholder safe. Getting this off by one puts
your migration on the wrong version and it silently never runs.

The real v1 → v2 migration in `server/index.mjs` — backfilling
`RoutineSection.startTime` — is the worked example.

Migrations run **once, server-side, against the file** — unlike the old
localStorage world where every browser held its own unmigrated copy.

Three consequences worth knowing:

- **The file isn't rewritten until something writes.** `load()` migrates the
  in-memory cache; `persist()` only runs on a write. So the version on disk
  can lag the version being served. Migrations must therefore be
  **idempotent** — they will re-run on every cold start until a write lands.
- **The offline localStorage mirror is never migrated at all.** Read new
  fields defensively on the client too, or a cold start with the server down
  hands you the old shape.
- **A running server does not pick up a new migration.** It has to be
  restarted, or it will keep serving the old shape from its cache.

Still good practice, because a migration can be forgotten:

1. **Prefer additive changes**, and read new fields defensively —
   `mission.tags ?? []` rather than `mission.tags.map`.
2. **Don't rename or retype a shipped field** without a migration to match.
3. **Back up `data/operator.json` before running a new migration** the first
   time. There is no automatic pre-migration snapshot (**OPS-017**).
4. **Test against a copy of the real store**, not just seed data. Seeds already
   have the new field; only real data exercises the migration.

## Export / import contract

Settings can be built directly on the API: `GET /api/state` **is** the export,
and `PUT /api/state` **is** the import. The older
`exportAllData`/`importAllData` helpers in `lib/storage.ts` operate on the
localStorage mirror and are effectively legacy — prefer the API.

Two properties worth knowing:

- Bulk `PUT` is a **merge, not a replace** — keys absent from the payload are
  left untouched. Importing an old backup yields a mix of old and current data.
- It does **no validation and no version check**, so a stale export can
  reintroduce an old shape without triggering a migration.

Both are design questions for whoever builds Settings.
