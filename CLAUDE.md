# CLAUDE.md — Operator (Personal OS)

This file is the handoff for Claude Code (or any engineer) picking this project up.
Read it before touching anything. It exists so the architecture and design
decisions made so far don't get silently reversed or "helpfully" refactored.

## Documentation

This file is the **entry point** and holds the rules. The long-form knowledge
behind them lives in [`/docs`](docs/) — start at [`docs/README.md`](docs/README.md).
Nothing in `/docs` overrides this file; where both cover the same subject, this
file states the rule and the document explains it.

| Document | Read it when |
|---|---|
| [`docs/vision.md`](docs/vision.md) | **Always — treat as equally important as this file.** Why Operator exists, not how it's built. If an implementation satisfies the architecture but conflicts with the vision, say so before proceeding |
| [`docs/architecture.md`](docs/architecture.md) | Adding or changing any feature; anything touching state. **Contains the invariants** — the ways this codebase breaks while compiling cleanly |
| [`docs/data-model.md`](docs/data-model.md) | Adding a type, a storage key, or changing a persisted shape |
| [`docs/design-system.md`](docs/design-system.md) | Building any UI |
| [`docs/adding-a-feature.md`](docs/adding-a-feature.md) | Building Learning, Gym, Forex, Work, Journey, Statistics, or Settings |
| [`docs/roadmap.md`](docs/roadmap.md) | Planning; deciding what's next |
| [`docs/known-issues.md`](docs/known-issues.md) | **Before shipping anything** — two entries are active defects, not theory |
| [`docs/development.md`](docs/development.md) | Running, verifying, or handing off work |
| [`docs/decisions/`](docs/decisions/) | Before "fixing" something that looks wrong, or changing an established pattern |
| [`docs/handoffs/`](docs/handoffs/) | At the end of every milestone — template and naming convention |

## What this is

A personal productivity dashboard — the owner's daily operating system, not a
generic todo app. Core philosophy: tasks contribute to missions, missions
contribute to a long-term life roadmap. Everything is self-hosted — no cloud,
no third-party services, no account. Data never leaves hardware the owner
controls.

Storage is a **local JSON file served by a small Node process in `server/`**
(`data/operator.json`, path overridable with `OPERATOR_DATA`). It runs on the
owner's PC today and moves to the EPYC server later. This replaced
`localStorage` in v5 so that desktop and phone share one dataset over
Tailscale — see [ADR 0006](docs/decisions/0006-json-file-storage-server.md).
`localStorage` still exists, but only as an offline read-mirror.

**Do not add:** cloud sync, a third-party backend, authentication against an
external provider, or any network call to a host the owner doesn't own. Google
Fonts in `index.html` is the one pre-existing exception. If a future request
seems to need one of these, flag it back rather than adding it silently —
self-hosted is a hard requirement, not a default.

**The app must still work when the storage server is down** — degraded to the
last known data with writes queued, never a blank screen.

## Tech stack

React 18 + TypeScript + Vite + Tailwind + React Router v6 + Recharts +
lucide-react. Nothing else. Don't introduce a state management library
(Redux/Zustand/etc.) — `useLocalStorage` + React state has been sufficient
and should stay that way unless the user asks otherwise.

## Architecture pattern — apply this to every new feature

Established across Dashboard, Daily Routine, and Mission Board, and expected
to continue for Learning, Gym, Forex, Work, Journey, Statistics, Settings:

- **One storage namespace per feature** (e.g. `dashboard.*`, `routine.*`,
  `missions.records`). Keys are slices of the JSON store; the same strings are
  used for the offline `localStorage` mirror, prefixed with `os.` by
  `lib/storage.ts`.
- **One hook per feature** that owns that namespace's `useRemoteStorage`
  slices and exposes read state + mutator functions. Pages/components never
  call `useRemoteStorage` directly for feature data — they go through the
  feature's hook. See `useDashboardData.ts`, `useRoutineData.ts`,
  `useMissionBoard.ts`.
- **One folder per feature** under `src/components/<feature>/` for that
  feature's components. Shared primitives live in `src/components/ui/`.
- **One page per feature** under `src/pages/`, wired to one route in
  `App.tsx`. Mission Board is the one exception with two pages
  (`MissionBoard.tsx` list + `MissionDetail.tsx` detail) because a mission
  board without a detail view isn't the feature — but it's still one hook,
  one namespace, one folder.
- **Features stay independent for writes.** Don't cross-wire one feature's
  mutators into another's without being asked. **Reads are different** — a
  widget or page may read another feature's hook as long as it mutates
  nothing. The Activity Log, `HomelabStatus`, `CurrentTime` and the Dashboard's
  three mission widgets all do this. Writing still goes through the owning
  feature's hook, always.
  (The Dashboard used to keep its *own* parallel `Mission` type over
  `dashboard.missions`. That was retired in v9 — see
  [ADR 0008](docs/decisions/0008-dashboard-reads-the-real-board.md). Don't
  reintroduce a second stored copy of anything; derive it instead.)
- **Types are additive.** `lib/types.ts` is one file, but each feature's
  types are appended, not interleaved with or mutated from another
  feature's types. Follow the existing section-comment style
  (`// --- Mission Board ---`) when adding a new feature's types.
- **Seed data lives in `lib/seed.ts`**, one export per feature
  (`seedTasks`, `seedRoutineSections`, `seedMissionRecords`, etc.), used as
  the fallback value for that feature's first `useLocalStorage` call.

Don't over-engineer. No premature abstraction, no generic "entity" system,
no ORM-style data layer. Every feature so far is a flat array of typed
objects in localStorage — keep doing that.

## Folder map

```
server/
  index.mjs             — JSON storage API (no deps). GET/PUT/DELETE /api/state
  dev.mjs               — read-only repo browser for the Dev page
  homelab.mjs           — TCP reachability probes for the Homelab tiles
scripts/
  dev.mjs               — starts the API and Vite together
data/
  operator.json         — the store. gitignored; NOT backed up by git
src/
  main.tsx              — entry, wraps App in BrowserRouter + ThemeProvider
  App.tsx                — all routes
  index.css              — Tailwind layers + base styles + .card-base etc.
  context/
    ThemeContext.tsx     — accent color (CSS var) + sidebar collapsed state
  layouts/
    AppLayout.tsx         — Sidebar + Topbar + CommandPalette + <Outlet/>
  lib/
    types.ts              — all domain types, one section per feature
    seed.ts                — all first-run seed data, one export per feature
    storage.ts              — localStorage mirror read/write/remove helpers
    storageKeys.ts           — the namespace registry + each slice's blank value
    remoteStore.ts             — shared client cache + sync with the server
    id.ts                       — generateId(), safe in non-secure contexts
    time.ts                      — wall-clock + calendar-date helpers. Local time only.
                                    Use toDateKey() for any "YYYY-MM-DD" — never
                                    toISOString().slice(0,10), which is UTC (OPS-009)
  hooks/
    useRemoteStorage.ts      — generic server-backed useState (shared cache)
    useDashboardData.ts       — Dashboard feature hook
    useRoutineData.ts          — Daily Routine feature hook (+ daily reset logic)
    useMissionBoard.ts          — Mission Board feature hook
    useHomelab.ts                — Homelab feature hook (+ serviceUrl helper)
    useEvents.ts                  — Events feature hook (by-day index, upcoming)
    useSettings.ts                  — export/import/clear, acts on every namespace
    useUpdates.ts                     — Updates feature hook (shipped/pending log)
    useNow.ts                     — ticking clock, re-syncs on tab focus
  components/
    layout/                — Sidebar, Topbar
    command/                — CommandPalette (Ctrl/Cmd+K)
    ui/                      — Card, EmptyState, StatCounter, ShieldProgress,
                                Confetti, ConfirmButton — shared primitives
    homelab/                  — ServiceTile, ServiceForm
    dashboard/                — one file per Dashboard widget
    routine/                    — RoutineSectionCard, RoutineSummary,
                                   RoutineTimeline, routineMeta.ts
    events/                      — MonthGrid, DayPanel, eventMeta.ts
    missions/                    — MissionCard, MissionBadges, EditableField,
                                    DependencyChain, DependencyEditor,
                                    MilestoneList, MilestoneTimeline,
                                    NewMissionForm, ReservedSection
  pages/
    Dashboard.tsx, DailyRoutine.tsx, MissionBoard.tsx, MissionDetail.tsx,
    Homelab.tsx, Events.tsx, Settings.tsx, Updates.tsx, ActivityLog.tsx,
    Contents.tsx, Dev.tsx,
    ComingSoon.tsx           — placeholder for any route not yet built
```

## Design system

Tokens live in `tailwind.config.ts`. Don't hardcode hex values in
components — use the token classes.

- **Base**: `base-950` (deepest bg) through `base-500` (borders/dividers).
  App background is `base-900`, cards are `base-800` with `border-base-600`.
- **Ink** (text): `ink-100` (primary) → `ink-700` (faint/disabled).
- **Accent**: `xp` (`#E8B04D`, "experience gold") is the one primary accent
  — buttons, active nav, progress fills, focus rings. `rank` (`#8D7FE0`,
  violet) is secondary — used for "in progress" states and the repeat-daily
  indicator in Daily Routine. `vital-up` (green) / `vital-down` (red) are
  reserved for genuinely binary positive/negative states (streak alive vs
  broken, mission blocked, milestone complete).
- **Type**: `font-display` (Space Grotesk) for headings, `font-body`
  (Inter) for everything else, `font-mono` (JetBrains Mono) for numbers/
  stats/timestamps — this pairing is deliberate, keep using mono for
  anything numeric.
- **Radii/shadow**: `rounded-card` (18px) for cards, `rounded-badge` (10px)
  for buttons/inputs/chips. `.card-base` utility class combines bg, border,
  radius, shadow, and the subtle sheen gradient — use it instead of
  reassembling those classes by hand.

### Tone differs deliberately by section — this is intentional, not inconsistent

- **Dashboard**: playful-but-premium. Missions shown as a hexagonal
  "shield" progress badge (`ui/ShieldProgress.tsx`) — the app's one
  gamified signature element. Confetti on task completion
  (`ui/Confetti.tsx`).
- **Daily Routine**: calmer than the Dashboard. No confetti. A vertical
  rail with filled/unfilled section nodes instead of shield badges.
- **Mission Board**: explicitly asked to avoid game UI. No shields, no
  confetti, no XP language. Status = small dot + neutral pill
  (`MissionBadges.tsx` → `StatusBadge`). Difficulty = four small dot pips,
  not a level number (`DifficultyPips`). Progress = plain linear bar +
  numeric %. This page should read like Linear/Notion, not a game HUD —
  if extending it, keep matching that register.

- **Homelab**: infra register — closer to Mission Board than the Dashboard.
  Status is a dot and a port number. A service being up is not an
  achievement, so no shields, no confetti, no XP language.

If asked to add a new top-level feature, ask (or infer from the request's
own tone) which register it should sit in before building it — don't
default to copying Mission Board's calm style or the Dashboard's playful
style without thinking about which fits.

### Destructive actions

Every delete goes through `ui/ConfirmButton.tsx` — two taps, self-disarming
after four seconds. Don't use `window.confirm` (unstyled, and on iOS it steals
focus from the row being edited) and don't add a bespoke modal per feature.
Where a record is worth keeping, offer **archive before delete** — Mission
Board does both, and the board has an "Archived" filter so archiving is
genuinely reversible rather than a disappearance. There is **no undo**
(**OPS-020**), which is why the confirm step is not optional.

### Responsive is not optional

Operator is used from a phone. Every new surface must work there — see
[`docs/design-system.md`](docs/design-system.md) for the rules. The four that
get broken most: **44px touch targets**, **never hide a control behind
`hover:`**, **`text-base sm:text-sm` on inputs** (or iOS zooms the page), and
**scroll long rows instead of wrapping them**.

## Feature status

| Feature | Route(s) | Status |
|---|---|---|
| Dashboard | `/` | Built |
| Daily Routine | `/routine` | Built |
| Mission Board | `/missions`, `/missions/:id` | Built |
| Events | `/events` | Built — year calendar, 12 month grids, day panel for add/edit/delete, including moving an event's date. Timed events sync read-only onto Daily Routine's Day Schedule. Dashboard's Upcoming Events reads it, and the clock opens it |
| Updates | `/updates` | Built — shipped/pending log of Operator's own development, reviewable in-app. Distinct from Activity Log |
| Homelab | `/homelab` | Built — tile per service on the box, with a server-side up/down probe. Also a read-only section on the Dashboard |
| Activity Log | `/log` | Built — read-only aggregator, owns no storage |
| Contents | `/contents` | Built — hand-written index of every section. Keep in step with `docs/roadmap.md` |
| Dev | `/dev` | Built — repo status, GitHub links, sandboxed read-only file browser |
| Learning | `/learning` | Not built — `ComingSoon` placeholder |
| Gym | `/gym` | Not built — `ComingSoon` placeholder |
| Forex | `/forex` | Not built — `ComingSoon` placeholder |
| Work | `/work` | Not built — `ComingSoon` placeholder |
| Journey | `/journey` | Not built — `ComingSoon` placeholder. Nav entry reserved on request. |
| Statistics | `/statistics` | Not built — `ComingSoon` placeholder |
| Settings | `/settings` | Built — storage status, export/import backup, per-feature clear. Acts on every namespace; owns none |
| Knowledge Vault | none yet | Not started, no nav entry. Future personal wiki — notes/commands/resources/confidence per topic, linked from missions' "Related Knowledge" tab (currently a free-text field + reserved-section note in `MissionDetail.tsx`). |
| Decision Log | none yet | Not started, no nav entry. Future decision/date/reasoning/outcome log, linked from missions' "Related Decisions" tab (currently a `ReservedSection` placeholder). |

### Mission Board detail

`MissionRecord` (see `lib/types.ts`) has: name, description, category,
difficulty, status, progress, estimatedCompletion, timeInvestedHours,
nextObjective, objectivesNotes, notes, milestones[], dependsOn[] (mission
IDs), relatedLearning, relatedJourneyMilestone, whyItMatters, unlocks,
knowledgeNeeded, activity[], archived, createdAt.

`MissionDetail.tsx` has 10 tabs: Overview, Objectives, Milestones,
Timeline, Notes, Activity, Related Knowledge, Related Decisions, Related
Journey, AI Summary. Milestones (editable CRUD list) and Timeline
(read-only chronological view) are intentionally separate components
(`MilestoneList.tsx` vs `MilestoneTimeline.tsx`) — don't merge them.

Dependencies are directional (`dependsOn: ID[]`) and rendered as a
predecessor → current → successor pill chain (`DependencyChain.tsx`,
read-only) plus a toggle editor (`DependencyEditor.tsx`, edits
`dependsOn`). Successors are computed on the fly by filtering all missions
for `dependsOn.includes(currentId)` — there's no reverse-reference field to
keep in sync.

Attachments/files are explicitly reserved-but-unbuilt — see
`ReservedSection.tsx` usage in the Overview tab. Don't add file upload
without being asked; localStorage can't hold binary files at any real size
anyway, so this will need real design thought when it's actually built
(likely just storing filenames/links, not file contents).

## Naming — pending, do not do unprompted

The user has flagged wording changes they want **eventually**, not yet:

- "Today's Focus" → "Primary Objective"
- "Current Missions" → "Active Missions"

"Projects" → "Mission Board" **has already been done** (nav label + route
`/missions`), since that was the actual feature being built, not just a
label tweak.

These are single-string changes (`Card` `title` props, `NAV_ITEMS` in
`Sidebar.tsx`) — trivial to apply, but wait for explicit confirmation
before touching them.

## Known issues

The live register is [`docs/known-issues.md`](docs/known-issues.md) — read it
before shipping. Two things worth knowing without opening it:

**Secure context.** Operator is used over Tailscale at a bare IP, which
browsers treat as insecure. `crypto.randomUUID`, `crypto.subtle`,
`navigator.clipboard` and service workers are all unavailable there. Use
`generateId()` from `lib/id.ts`, never `crypto.randomUUID()` directly. When a
bug "only happens on the server", check this first.

**`data/operator.json` is gitignored, so git is not a backup.** Once real data
goes in, it needs a copy job.

## Verification before handing anything back

```bash
npx tsc -b        # must exit clean
npx vite build    # must exit clean
```

Both must pass with no errors before considering a change done. There are no
tests and no linter — the type checker is the only automated gate, and it is
weaker than it looks (`noUnusedLocals` is off, and an explicit `undefined` in a
spread type-checks fine while corrupting data). Exercise the UI path you
changed. `dist/`, `node_modules/` and `data/` should not be committed.

## Running it

```bash
npm run dev -- --host    # storage API + Vite, bound to the network
npm run dev:web          # Vite only (API assumed already running)
npm run server           # storage API only
npm run serve            # built app + API from one port (deployment)
```

`npm run dev` starts **two** processes via `scripts/dev.mjs` — the storage
server on 5174 and Vite on 5173. The extra `--` is required so npm passes
`--host` through to Vite; without it Vite binds to localhost only and the
phone can't reach it.

Vite's port is pinned with `strictPort`. If it weren't, a stale dev server on
5173 would push Vite onto 5174 — the API's port — and it would proxy `/api`
to itself.


---

# Claude Code Development Workflow

## Development Philosophy

This project prioritises long-term architectural integrity over rapid feature delivery.

Before implementing any feature:

1. Read this entire `CLAUDE.md`.
2. Read all relevant documentation in `/docs` if it exists.
3. Treat this documentation as the source of truth.
4. If a request conflicts with the documented architecture, explain the conflict before implementing it.
5. Challenge architectural decisions where appropriate rather than agreeing by default.

## Development Standards

- Understand before implementing.
- Prefer extending existing patterns over introducing new ones.
- Avoid unnecessary abstractions.
- Keep features independent unless integration is explicitly required.
- Preserve consistency across the project.
- Document significant architectural decisions.

## Completion Checklist

Before considering work complete:

- Ensure TypeScript compiles successfully.
- Ensure the project builds successfully.
- Review the implementation against the documented architecture.
- Update documentation if architecture or design has changed.

## Engineering Handoff

At the end of every milestone, produce a handoff containing:

- Summary of completed work
- Files modified
- Architectural decisions made
- Technical debt introduced or resolved
- Outstanding issues
- Recommended next milestone
- Any assumptions or risks for the next development session

Assume the next Claude instance has no memory beyond the repository and this document.

## Git Workflow

Every completed milestone should end with:

1. Review the implementation.
2. Update any affected documentation.
3. Produce an engineering handoff in `docs/handoffs/`.
4. Suggest a concise Conventional Commit message.
5. Wait for approval before committing.
6. After approval:
   - Stage the required files.
   - Create the commit.
   - Show a summary of what was committed.
7. Never push to the remote unless explicitly instructed.