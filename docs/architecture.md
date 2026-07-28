# Architecture

`CLAUDE.md` states the pattern. This document explains how it actually fits
together, and — more importantly — the **invariants** that make it safe. Most of
the ways this codebase can break are invariant violations that TypeScript will
happily compile.

## The shape of the whole app

```
main.tsx
  └── BrowserRouter
        └── ThemeProvider                     (accent CSS var + sidebar collapse)
              └── App.tsx                     (all routes)
                    └── AppLayout             (Sidebar + Topbar + CommandPalette + <Outlet/>)
                          └── <page>
```

There is no other global state. No store, no query cache, no event bus.
`ThemeProvider` is the only React context in the codebase, and it deliberately
holds presentation state only — never feature data.

## The feature slice

Every feature is the same five things, and nothing more:

```
route            App.tsx
   ↓
page             src/pages/<Feature>.tsx          ← calls the hook, owns the data
   ↓
feature hook     src/hooks/use<Feature>.ts        ← owns the namespace + all mutators
   ↓
useLocalStorage  src/hooks/useLocalStorage.ts     ← useState + write-through effect
   ↓
localStorage     "os.<namespace>.<slice>"
```

with **components** (`src/components/<feature>/`) hanging off the page as pure
presentation: they receive data as props and raise intent through `on*`
callbacks. They never read or write storage.

Three features are built this way and are the reference implementations:

| Feature | Page(s) | Hook | Namespace |
|---|---|---|---|
| Dashboard | `pages/Dashboard.tsx` | `hooks/useDashboardData.ts` | `dashboard.*` (9 slices) |
| Daily Routine | `pages/DailyRoutine.tsx` | `hooks/useRoutineData.ts` | `routine.sections`, `routine.lastReset` |
| Mission Board | `pages/MissionBoard.tsx`, `pages/MissionDetail.tsx` | `hooks/useMissionBoard.ts` | `missions.records` |

Mission Board's two pages are the one sanctioned exception (`CLAUDE.md:41-45`):
a board without a detail view isn't the feature. It is still **one** hook, one
namespace, one component folder.

## Why the layers are where they are

**The hook is the seam.** It is the only place that knows a feature's storage
keys, and the only place that mutates them. That is what makes the "one
namespace per feature" rule enforceable rather than aspirational — you can audit
compliance by grepping for `useLocalStorage` and checking that every hit is
inside `hooks/` (the sole legitimate exception being `context/ThemeContext.tsx:24`,
which is a provider, not a feature).

**The page owns the hook.** Not a layout, not a widget, not a context. This is
load-bearing — see Invariant 1 below.

**Components are dumb on purpose.** They stay reusable across registers, they
are trivially testable if tests ever arrive, and — most usefully — you can read
any component and know it cannot have a hidden side effect on stored data.

## The invariants

These are not style preferences. Each one, if broken, produces a bug that
compiles cleanly and fails at runtime or silently corrupts data.

### 1. A feature hook is called **once** per mounted tree

`useLocalStorage` is `useState` plus a write-through `useEffect`
(`hooks/useLocalStorage.ts:9-17`). It has **no context, no subscription, and no
`storage` event listener**. Every call site gets its own independent copy of the
state.

Two mounted components calling `useMissionBoard()` therefore do not share
memory. They both read the same key at mount, then diverge the moment either one
writes, and the last writer wins — silently overwriting the other's changes.

Today this holds because each page calls its hook once and pages are never
mounted simultaneously (`MissionBoard` and `MissionDetail` are sibling routes).
Nothing enforces it. Watch for it when:

- a Dashboard widget wants live Mission Board data;
- a shared layout component wants feature data;
- **Statistics** is built — it is by definition a cross-feature reader, and the
  naive approach (call every feature hook) violates this invariant on day one.

The fix, when it is needed, is a decision to be made deliberately — see
[`decisions/0002-feature-slice-architecture.md`](decisions/0002-feature-slice-architecture.md)
and `known-issues.md` (**OPS-004**). Do not solve it ad hoc inside one feature.

### 2. Features do not read each other's data

`CLAUDE.md:46-51`. The Dashboard's `Mission` and the Mission Board's
`MissionRecord` are separate types over separate keys, deliberately unsynced —
see [`decisions/0003-separate-mission-types.md`](decisions/0003-separate-mission-types.md)
before proposing to merge them.

Cross-feature links that are *planned* are held as **free text plus a
`ReservedSection` placeholder** (`components/missions/ReservedSection.tsx`), not
as real references. That is what `relatedLearning`, `relatedJourneyMilestone`,
and the Related Knowledge / Decisions / Journey tabs in `pages/MissionDetail.tsx`
are: intent recorded without coupling.

### 3. Derived data is computed, never stored

Dependency successors are computed by filtering
(`hooks/useMissionBoard.ts:136`, `pages/MissionDetail.tsx:62-65`) rather than
kept as a reverse-reference field. Routine totals and the productivity average
are computed in their hooks. Milestone progress is the one place this is
violated by accident, not design — see **OPS-002**.

The reason is that this app has no transactions. Anything stored twice can
disagree, and there is no reconciliation layer to fix it.

### 4. Seed data is a fallback, not an initialiser

Seeds are passed as the third argument to `useLocalStorage`
(`hooks/useDashboardData.ts:21`, etc.). On first render the write-through effect
persists them, so from render two onward the user's copy is authoritative and
the seed is dead to them. Changing a seed therefore only affects browsers that
have never run the app. See `data-model.md` for what this means for migrations.

### 5. Storage writes never throw

`lib/storage.ts:21-27` swallows every write error. The app keeps running from
memory when a write fails (quota, private mode). This is a deliberate
availability choice with a real cost — silent data loss — tracked as **OPS-006**.

## What the architecture does not have

Stated plainly so nobody goes looking:

- **No cross-tab sync.** Two tabs open on Operator will fight. Last write wins.
- **No schema versioning or migration.** `lib/storage.ts:11-19` casts parsed
  JSON straight to `T` with no validation. This is the largest structural gap —
  see `data-model.md` and **OPS-003**.
- **No aggregation layer.** Nothing can currently read across features safely
  (Invariant 1). Statistics and Journey will both need this question answered.
- **No delete path.** `MissionRecord.archived` exists and is filtered on
  (`hooks/useMissionBoard.ts:139`) but nothing can set it, and there is no
  delete anywhere in the app.
- **No tests, linter, or CI.** The verification gate is `tsc -b` + `vite build`,
  run by hand. See `development.md`.

## Extending it

The recipe is in [`adding-a-feature.md`](adding-a-feature.md). The short version:
resist the urge to generalise. `CLAUDE.md:60-62` is explicit — no generic entity
system, no ORM-style data layer. Every feature so far is a flat array of typed
objects in localStorage, and the fourth one should be too.
