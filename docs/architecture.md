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
route             App.tsx
   ↓
page              src/pages/<Feature>.tsx         ← calls the hook, owns the data
   ↓
feature hook      src/hooks/use<Feature>.ts       ← owns the namespace + all mutators
   ↓
useRemoteStorage  src/hooks/useRemoteStorage.ts   ← useSyncExternalStore over…
   ↓
remoteStore       src/lib/remoteStore.ts          ← ONE shared cache for the app
   ↓
storage server    server/index.mjs                ← HTTP, /api/state
   ↓
data/operator.json                                ← the store (OPERATOR_DATA)
```

`localStorage` still exists underneath `remoteStore` as an **offline read
mirror** only. It is never the source of truth.

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
compliance by grepping for `useRemoteStorage` and checking that every hit is
inside `hooks/` (the sole legitimate exception being `context/ThemeContext.tsx:24`,
which is a provider, not a feature).

**The page owns the hook.** Not a layout, not a widget, not a context. Since v5
this is readability rather than correctness — see Invariant 1 below.

**Components are dumb on purpose.** They stay reusable across registers, they
are trivially testable if tests ever arrive, and — most usefully — you can read
any component and know it cannot have a hidden side effect on stored data.

## The invariants

These are not style preferences. Each one, if broken, produces a bug that
compiles cleanly and fails at runtime or silently corrupts data.

### 1. ~~A feature hook is called once per mounted tree~~ — retired in v5

**This invariant no longer applies.** `lib/remoteStore.ts` holds one
module-level cache with per-key subscribers, read through
`useSyncExternalStore`. Every call site sees the same data, and writes are
applied to the shared cache synchronously rather than in a post-render effect.

Calling a feature hook from two mounted components is now **safe**, and
**Statistics is unblocked** — it may read across features.

Kept here because the failure it prevented was real and instructive: under the
old `useLocalStorage`, a mutator followed by `navigate()` in the same handler
lost the write entirely, because the component unmounted before its effect ran
(**OPS-016** — this is what "the New Mission button doesn't work" was).

Two things still hold:

- **Last write wins.** There is no locking. Two devices editing the same slice
  simultaneously will clobber each other.
- **Pages should still own their feature hook** and thread state down as props.
  Not for correctness any more, but because it keeps components presentational
  and the data flow readable.

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

Seeds are passed as the third argument to `useRemoteStorage`
(`hooks/useDashboardData.ts:21`, etc.). A slice is only written to the store
once something actually changes it, so an untouched feature reads its seed on
every load. From the first edit onward the stored copy is authoritative and the
seed is dead to that user. Changing a seed therefore only affects stores that
have never held that key.

### 5. Storage failures degrade, they never crash

A write that the server rejects is **queued** in `remoteStore` and flushed on
reconnect; the Topbar badge turns red so the state is visible rather than
silent. A cold start with the server down falls back to the `localStorage`
mirror and shows the last known data.

The rule for any new code: **the app must never present a blank screen because
the storage server is unavailable.**

## What the architecture does not have

Stated plainly so nobody goes looking:

- **No live sync between devices.** Two clients each hold their own cache and
  push on write; there is no push channel from the server. Refresh to see
  another device's changes. Last write wins.
- **No authentication.** Anyone on the tailnet has full read/write. The tailnet
  is the security boundary.
- **No backup.** `data/` is gitignored, so git does not protect the store
  (**OPS-017**).
- **No delete path.** `MissionRecord.archived` exists and is filtered on
  (`hooks/useMissionBoard.ts:139`) but nothing can set it, and there is no
  delete anywhere in the app.
- **No tests, linter, or CI.** The verification gate is `tsc -b` + `vite build`,
  run by hand. See `development.md`.
- **No cross-device push.** The server does not notify clients of changes; a
  device sees another's edits on refresh.

## Extending it

The recipe is in [`adding-a-feature.md`](adding-a-feature.md). The short version:
resist the urge to generalise. `CLAUDE.md:60-62` is explicit — no generic entity
system, no ORM-style data layer. Every feature so far is a flat array of typed
objects in localStorage, and the fourth one should be too.
