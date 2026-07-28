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
contribute to a long-term life roadmap. Everything is local — no backend, no
auth, no cloud, no database. `localStorage` only. Must work fully offline.

**Do not add:** a backend, authentication, a database, cloud sync, or any
network calls other than Google Fonts in `index.html`. If a future request
seems to need one of these, flag it back to the user rather than adding it
silently — offline-first is a hard requirement, not a default.

## Tech stack

React 18 + TypeScript + Vite + Tailwind + React Router v6 + Recharts +
lucide-react. Nothing else. Don't introduce a state management library
(Redux/Zustand/etc.) — `useLocalStorage` + React state has been sufficient
and should stay that way unless the user asks otherwise.

## Architecture pattern — apply this to every new feature

Established across Dashboard, Daily Routine, and Mission Board, and expected
to continue for Learning, Gym, Forex, Work, Journey, Statistics, Settings:

- **One localStorage namespace per feature** (e.g. `dashboard.*`,
  `routine.*`, `missions.records`). Namespacing lives in `lib/storage.ts`
  (`storageKey()` prefixes everything with `os.`).
- **One hook per feature** that owns that namespace's `useLocalStorage`
  slices and exposes read state + mutator functions. Pages/components never
  call `useLocalStorage` directly for feature data — they go through the
  feature's hook. See `useDashboardData.ts`, `useRoutineData.ts`,
  `useMissionBoard.ts`.
- **One folder per feature** under `src/components/<feature>/` for that
  feature's components. Shared primitives live in `src/components/ui/`.
- **One page per feature** under `src/pages/`, wired to one route in
  `App.tsx`. Mission Board is the one exception with two pages
  (`MissionBoard.tsx` list + `MissionDetail.tsx` detail) because a mission
  board without a detail view isn't the feature — but it's still one hook,
  one namespace, one folder.
- **Features stay independent.** Don't cross-wire one feature's data into
  another's without being asked. Example: the Dashboard has its own
  lightweight `Mission` type (`dashboard.missions`) used only by its
  "Current Missions" / "Project Progress" widgets. Mission Board has a
  completely separate, richer `MissionRecord` type (`missions.records`).
  These are deliberately not synced. Don't "fix" that by merging them.
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
    storage.ts              — localStorage read/write/export/import/reset helpers
  hooks/
    useLocalStorage.ts       — generic localStorage-backed useState
    useDashboardData.ts       — Dashboard feature hook
    useRoutineData.ts          — Daily Routine feature hook (+ daily reset logic)
    useMissionBoard.ts          — Mission Board feature hook
  components/
    layout/                — Sidebar, Topbar
    command/                — CommandPalette (Ctrl/Cmd+K)
    ui/                      — Card, EmptyState, StatCounter, ShieldProgress,
                                Confetti — shared primitives, Dashboard-flavoured
    dashboard/                — one file per Dashboard widget
    routine/                    — RoutineSectionCard, RoutineSummary, routineMeta.ts
    missions/                    — MissionCard, MissionBadges, EditableField,
                                    DependencyChain, DependencyEditor,
                                    MilestoneList, MilestoneTimeline,
                                    NewMissionForm, ReservedSection
  pages/
    Dashboard.tsx, DailyRoutine.tsx, MissionBoard.tsx, MissionDetail.tsx,
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

If asked to add a new top-level feature, ask (or infer from the request's
own tone) which register it should sit in before building it — don't
default to copying Mission Board's calm style or the Dashboard's playful
style without thinking about which fits.

## Feature status

| Feature | Route(s) | Status |
|---|---|---|
| Dashboard | `/` | Built |
| Daily Routine | `/routine` | Built |
| Mission Board | `/missions`, `/missions/:id` | Built |
| Learning | `/learning` | Not built — `ComingSoon` placeholder |
| Gym | `/gym` | Not built — `ComingSoon` placeholder |
| Forex | `/forex` | Not built — `ComingSoon` placeholder |
| Work | `/work` | Not built — `ComingSoon` placeholder |
| Journey | `/journey` | Not built — `ComingSoon` placeholder. Nav entry reserved on request. |
| Statistics | `/statistics` | Not built — `ComingSoon` placeholder |
| Settings | `/settings` | Not built — `ComingSoon` placeholder |
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

## Known issues — not yet fixed, on file for the next batch

**`crypto.randomUUID is not a function`** — thrown on any action that
generates an ID (adding a task, toggling one, logging activity, adding a
milestone, creating a mission). `crypto.randomUUID()` only exists in a
[secure context](https://developer.mozilla.org/en-US/docs/Web/API/Window/crypto)
(`localhost` or HTTPS). The user accesses the dev server over Tailscale via
a bare IP (`http://100.x.x.x:5173`), which the browser treats as insecure,
so the call throws and takes down whichever page it fires on (confirmed on
Dashboard; will affect Daily Routine and Mission Board identically, since
they call `crypto.randomUUID()` in the same pattern).

**Fix plan (approved, not yet applied):** add a small fallback ID
generator, e.g. in `lib/storage.ts` or a new `lib/id.ts`:

```ts
export function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
```

Then replace every `crypto.randomUUID()` call with `generateId()`. Current
call sites: `useDashboardData.ts`, `useRoutineData.ts` (task/note IDs),
`useMissionBoard.ts` (mission/milestone/activity IDs). Search the repo for
`crypto.randomUUID` to find them all before shipping the fix — don't rely
on this list being exhaustive if more features have been added since this
doc was written.

## Verification before handing anything back

```bash
npx tsc -b        # must exit clean
npx vite build    # must exit clean
```

Both must pass with no errors before considering a change done. `dist/`
and `node_modules/` should not be committed or included when packaging the
project for delivery.

## Running with network access (Tailscale, etc.)

```bash
npm run dev -- --host
```

The extra `--` is required so npm passes `--host` through to Vite. Without
`--host`, Vite only binds to localhost.


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