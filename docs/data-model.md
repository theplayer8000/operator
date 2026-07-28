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
| `routine.sections` | `RoutineSection[]` | `useRoutineData` | Yes |
| `routine.lastReset` | `string` (`YYYY-MM-DD`) | `useRoutineData` | Internal marker |
| `missions.records` | `MissionRecord[]` | `useMissionBoard` | Yes, incl. archive + delete |
| `homelab.services` | `HomelabService[]` | `useHomelab` | Yes — the server also reads this slice to know what to probe |
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
never interleaved** (`CLAUDE.md:52-55`). Keep the `// --- Feature Name ---`
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

### Mission Board

`MissionRecord` is the richest type in the app — see `CLAUDE.md:162-166` for the
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

## Seed data

`lib/seed.ts` holds one export per feature: `seedTasks`, `seedMissions`,
`seedWeeklyGoals`, `seedStreaks`, `seedEvents`, `seedNotes`, `seedActivity`,
`seedProductivityHistory`, `seedRoutineSections`, `seedMissionRecords`,
`seedHomelabServices`.

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
