# Data Model & Storage

Everything Operator knows lives in `window.localStorage` under the `os.` prefix.
This document is the registry of what is stored, what shape it has, and the
rules for changing it.

## The namespace

`lib/storage.ts:7-9` prefixes every key with `os.`:

```ts
storageKey("missions.records")  →  "os.missions.records"
```

That prefix is not decoration — it is what makes `exportAllData` /
`importAllData` / `resetAllData` (`lib/storage.ts:30-55`) able to operate on
"all of Operator" without knowing which features exist. **Any key written
outside `useLocalStorage`/`storageKey` is invisible to export, import, and
reset, and will be silently lost the first time a user backs up their data.**

### Key registry

| Key (`os.` prefix implied) | Type | Owner | Mutable in UI |
|---|---|---|---|
| `dashboard.focus` | `string` | `useDashboardData` | Yes |
| `dashboard.tasks` | `Task[]` | `useDashboardData` | Add, toggle |
| `dashboard.missions` | `Mission[]` | `useDashboardData` | **No** — `setMissions` is returned but unused (**OPS-005**) |
| `dashboard.weeklyGoals` | `WeeklyGoal[]` | `useDashboardData` | **No** — read-only display |
| `dashboard.streaks` | `Streak[]` | `useDashboardData` | **No** — read-only display |
| `dashboard.events` | `UpcomingEvent[]` | `useDashboardData` | **No** — read-only display |
| `dashboard.notes` | `QuickNote[]` | `useDashboardData` | Add only |
| `dashboard.activity` | `ActivityItem[]` | `useDashboardData` | Appended by mutators, capped at 20 |
| `dashboard.productivityHistory` | `{day, score}[]` | `useDashboardData` | **No** — read-only display |
| `routine.sections` | `RoutineSection[]` | `useRoutineData` | Yes |
| `routine.lastReset` | `string` (`YYYY-MM-DD`) | `useRoutineData` | Internal marker |
| `missions.records` | `MissionRecord[]` | `useMissionBoard` | Yes |
| `theme.accent` | `AccentColor` | `ThemeContext` | No UI exists yet (**OPS-007**) |

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
- `archived: boolean` is filtered on (`hooks/useMissionBoard.ts:139`) but no UI
  can set it.

## Seed data

`lib/seed.ts` holds one export per feature: `seedTasks`, `seedMissions`,
`seedWeeklyGoals`, `seedStreaks`, `seedEvents`, `seedNotes`, `seedActivity`,
`seedProductivityHistory`, `seedRoutineSections`, `seedMissionRecords`.

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

Currently `crypto.randomUUID()` at eight call sites across three hooks. This
**throws in non-secure contexts** and is the app's one known crash — see
**OPS-001** in `known-issues.md`. The approved fix (a `generateId()` helper with
a fallback) is specified in `CLAUDE.md:214-231` and should land before any new
feature adds a ninth call site.

New features must use whatever the shared helper is at the time, not
`crypto.randomUUID()` directly.

## Changing a persisted shape — read this first

There is **no schema versioning and no migration path**. `readStorage<T>`
(`lib/storage.ts:11-19`) parses JSON and casts to `T` with no validation. The
`try/catch` only protects against malformed JSON, not against a valid object of
the wrong shape.

The consequence, concretely: a user has run the app, so `os.missions.records`
holds records in today's shape. You add `tags: string[]` to `MissionRecord` and
render `mission.tags.map(...)`. Their stored records have no `tags`, the cast
lies, and the page white-screens on `undefined.map`.

Until a migration story exists (**OPS-003**), the safe rules are:

1. **Additive changes only**, and every new field must be read defensively —
   `mission.tags ?? []`, never `mission.tags.map`.
2. **Never rename or retype an existing field** on a shipped type. Add a new
   one and leave the old.
3. **Never assume a nested array exists** on a record loaded from storage.
4. If a breaking change is genuinely needed, that is the trigger to implement
   versioning rather than a reason to skip it.

## Export / import contract

`exportAllData()` produces a JSON object keyed by **full** storage keys
(`"os.dashboard.tasks": [...]`), pretty-printed. `importAllData()` accepts that
shape and writes back only keys starting with `os.`.

Two properties worth knowing before Settings is built:

- Import is a **merge, not a replace** — keys absent from the file are left
  untouched. A user importing an old backup gets a mix of old and current data.
- Import does **no validation and no version check**, so it is a second route to
  the shape-mismatch problem above.

Both are design questions for whoever builds Settings, not bugs today.
