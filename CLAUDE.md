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
| [`docs/ai-workspace-design.md`](docs/ai-workspace-design.md) | **Before touching the chat, terminal, or anything AI-facing.** The proposed job-based structure, why the current one has the limits it does, and the provider boundary future models plug into. Proposed, not built — needs the owner's approval |
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
external provider, or any network call to a host the owner doesn't own. If a
future request seems to need one of these, flag it back rather than adding it
silently — self-hosted is a hard requirement, not a default.

### External applications need the owner's explicit approval — every time

Anything that reaches a host the owner doesn't control is **approved case by
case, by him, in advance**. Not inferred from a similar integration already
being here, not bundled into a larger feature, not added because it's "only a
status check". Ask, name the host and what leaves the machine, and wait.

Approved so far — this list is the whole set:

| What | Host | Added |
|---|---|---|
| Google Fonts | `fonts.googleapis.com` | pre-existing, in `index.html` |
| Claude service status | `status.claude.com` | v11, `server/status.mjs` |

**AI model providers are approved in principle but not yet individually.** The
AI Provider Manager was approved on 2026-07-30 (ADR 0009); approving the router
did **not** approve its occupants. Each provider — Anthropic, OpenAI, anything
later — needs its own named approval before integration, and then goes in the
table above. Three hard conditions come with it:

- **The frontend never talks to a provider.** Server-side only, same as
  `server/status.mjs`.
- **API keys never go in `data/operator.json`, in git, or to the client.** That
  file is plaintext, served by an API with no auth — a key in it is a key
  published to the tailnet. Environment variables in development; Docker
  secrets or equivalent runtime config in production.
- **The embedded terminal runs for named devices** ([ADR 0011](docs/decisions/0011-remote-terminal-for-authorised-devices.md),
  amending ADR 0009's local-only restriction now that authentication exists).
  **Disarmed** on every start (`OPERATOR_TERMINAL=1` starts it armed), and
  armable from the app only by a device listed in `OPERATOR_TERMINAL_DEVICES` —
  being a known tailnet device gets you the app, not a shell. That list is
  environment-only and **must not become app-editable**, or a device could grant
  itself execution. **The boundary is authentication, not the command allowlist:**
  allowing `claude` is allowing arbitrary execution, because Claude Code runs
  commands. Never relax the auth on the grounds that commands are restricted.
  There is deliberately **no shell** (argv only, `shell: false`); if you hit
  `EINVAL` spawning a Windows `.cmd`, the answer is not `shell: true`. Pipes are
  available by asking for a shell explicitly (`bash -c "…"`), which keeps the
  audit line honest. The executable allowlist was **dropped** — it permitted
  `claude` and `node` while blocking `curl`, which is friction wearing the
  costume of security. `OPERATOR_TERMINAL_ALLOW` can narrow it again if a setup
  ever wants that.

Two rules for the ones that exist:

- **Fetch server-side, never from the browser.** `server/status.mjs` is the
  pattern: the Node process makes the call, the client talks only to
  `/api/*`. One machine — the owner's — contacts the third party, instead of
  every device that opens a page. Over plain HTTP at a tailnet IP a browser
  fetch would be mixed-content and fail anyway.
- **Degrade to silence.** An external host being down must never break the
  page that shows it. Cache, serve stale with the age stated, and say
  "couldn't reach it".

**The app must still work when the storage server is down** — degraded to the
last known data with writes queued, never a blank screen.

### The API is authenticated — don't add an unauthenticated route

Every route under `/api/` requires an identified caller (v19,
[ADR 0010](docs/decisions/0010-tailnet-identity-authentication.md)): a device on
the owner's tailnet (resolved by asking the **local** `tailscale` daemon), a
bearer token matching `OPERATOR_TOKEN`, or loopback. Static assets stay open so
the app can load. New `/api/` routes are gated automatically — the check sits in
front of the router, so you get this for free and must not route around it.

Two things here are load-bearing and easy to break:

- **`xfwd: true` on the Vite proxy** (`vite.config.ts`). Without it the API sees
  every proxied request as loopback and trusts it — port 5173 becomes a complete
  bypass for anything on the LAN.
- **The rightmost `X-Forwarded-For` entry is the real one.** `xfwd` appends, so
  the leftmost entry is whatever the client claimed. Reading it authenticated a
  LAN peer as the owner's iPhone in testing.

`OPS-018` used to accept no-auth on the grounds that "the tailnet is the security
boundary". That was false — the server binds `0.0.0.0` and the store was readable
from the LAN. It is true *now*, and only while the two points above hold.

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

### The one exception: boundaries that isolate infrastructure

Approved 2026-07-30 — see [ADR 0009](docs/decisions/0009-permitted-abstraction-boundaries.md)
for the full test and reasoning. The short version:

**Permitted** — an abstraction that hides a *swappable external dependency*,
has exactly one implementation today, exposes only the operations Operator
actually performs, and doesn't force features to become generic to pass
through it. Four are approved by name: **Storage Provider** (JSON → Postgres),
**Search Service** (JSON scan → vector), **AI Provider Manager**, and
**Deployment Configuration** (nothing hardcoded to this machine).

**Still forbidden** — generic repositories, ORMs, entity systems, a
client-side state library (ADR 0005 stands), anything justified by "we might
need it", and *extending a permitted boundary because it's already there*. The
Storage Provider does not grow a query language.

These sit **below** the feature hooks, not between features and their data.
`useMissionBoard` still owns `missions.records`; only what `remoteStore` talks
to underneath changes.

## Folder map

```
server/
  index.mjs             — JSON storage API (no deps). GET/PUT/DELETE /api/state
  dev.mjs               — read-only repo browser for the Dev page
  homelab.mjs           — TCP reachability probes for the Homelab tiles
  auth.mjs              — who is calling. Tailscale device identity + token fallback.
                          Gates every /api/ route — see ADR 0010 before touching it
  terminal.mjs          — runs commands for authorised devices. No shell (argv only),
                          disarmed by default — see ADR 0011
  workspace.mjs         — a conversation with Claude Code that remembers, by keeping
                          its session_id and passing --resume. Same gate as the
                          terminal: `claude -p` has tool access, so it is execution
  clients.mjs           — in-memory record of which devices are connected
  status.mjs            — Claude service status. The only outbound call; see the rule above
scripts/
  dev.mjs               — starts the API and Vite together
  backup.mjs            — store snapshots. Standalone: no deps, no src/ imports,
                          never calls the API, so `npm run backup` works when
                          everything is down. index.mjs imports runBackup() and runs
                          it hourly — the import goes one way only. docs/development.md
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
    Contents.tsx, Dev.tsx, Chat.tsx,
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

**Skipping is the exception, and only because it isn't destructive.** Skipping a
calendar occurrence or a gym session is one tap with no confirm — the skipped
thing stays on screen with an undo next to it. If you build another skip-like
action, hold the same bargain: no confirm *only* where the undo is visible and
adjacent. Otherwise it's a delete wearing a softer word, and it confirms.

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
| Daily Routine | `/routine` | Built — seven fixed sections on a rail, plus a Day Schedule timeline. Steps are tickable from the schedule itself (tap a block to open it in place), and a **day stepper scopes the whole page** to one date. Ticks are stored per date (`routine.completions`, schema v3) and the nightly reset is **gone** — a date with no entry is just a date nothing was ticked on. `RoutineTask.done` now only means anything for **one-off** steps; for repeating ones read `useRoutineData.isDoneOn`, never `task.done` |
| Mission Board | `/missions`, `/missions/:id` | Built |
| Calendar | `/calendar` | Built — year calendar, 12 month grids, day panel for add/edit/delete, including moving an event's date. Start/finish time pickers, not a duration field. **Weekly recurrence** — one record per series, expanded at read time; a single occurrence can be skipped (and un-skipped) without touching the rule, while delete takes the whole series. **Per-occurrence notes** (`occurrenceNotes`) sit alongside the series note, so "what I missed on this shift" is separate from standing info — the Work page will read these when it exists, not own them. On phone, tapping a day opens the panel as a popup instead of a scroll-to block. Timed events sync read-only onto Daily Routine's Day Schedule. Dashboard's Upcoming Events reads it, and the clock opens it. Internally still `events.records` / `useEvents` / `CalendarEvent` — only the user-facing label and route changed, same as "Mission Board" over `missions.records` |
| Updates | `/updates` | Built — shipped/pending log of Operator's own development, reviewable in-app. Distinct from Activity Log |
| Homelab | `/homelab` | Built — tile per service on the box, with a server-side up/down probe. Also a read-only section on the Dashboard |
| Activity Log | `/log` | Built — read-only aggregator, owns no storage |
| Contents | `/contents` | Built — hand-written index of every section. Keep in step with `docs/roadmap.md` |
| Claude | `/chat` | Built — a conversation with Claude Code that remembers across messages, by keeping its `session_id` and passing `--resume` (`server/workspace.mjs`). Model is selectable, Opus 5 by default. Print mode can't stop and ask, so a blocked tool is reported with the exact rule that would allow it and a one-tap grant. Same gate as the terminal — armable from this page. **This is the page the multi-provider chat grows into** (ADR 0009) |
| Dev | `/dev` | Built — repo status, GitHub links, sandboxed read-only file browser, connected-client monitor, Claude service status, and a **terminal** for authorised devices, disarmed by default (ADR 0011) |
| Gym | `/gym` | Built — today's session as a tickable checklist, day stepper, rest-day and skipped states. Five sessions named by push/pull structure, keyed by ISO weekday. Ticks are stored per date (`gym.completions`), skipped days separately (`gym.skipped`). The programme itself — phases, percentages, deloads, nutrition — is owner content in `reference/gym-programme.md`, not `/docs` |
| Learning | `/learning` | Not built — `ComingSoon` placeholder |
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

## "resume operator build" — the owner's resume phrase

When he types **"resume operator build"** (or close to it), treat it as a
request to do this before anything else:

1. Read [`docs/ai-workspace-design.md`](docs/ai-workspace-design.md) — the
   proposed structure and why the current one is shaped the way it is.
2. Read the newest file in [`docs/handoffs/`](docs/handoffs/).
3. Ask the open decisions in the next section. Don't guess them.
4. Then start at the design doc's next unbuilt step.

His words for why it exists: a preset phrase so a new session picks up where
the last one stopped, instead of him retyping the same three instructions every
time. A session starting cold has the repository and this file and nothing
else, so the phrase is the handover.

## Open decisions waiting on the owner — raise these, don't guess

Ask about anything here that touches what you're about to build. They are
recorded because a previous session needed them and could not proceed without
guessing; guessing is the failure mode this list exists to prevent.

**Before building any of the AI workspace** (see
[`docs/ai-workspace-design.md`](docs/ai-workspace-design.md)):

1. **Job history** — should completed jobs survive a server restart, or is a live
   view enough? Persisting means a storage slice and a retention rule.
2. **Permission profiles** — which bundles are actually wanted? "Edit `src/`",
   "run builds", "anything except git push" are guesses, not requirements.
3. **Concurrency** — one job at a time, or several? One matches a single user on
   a phone; several matters if a long build should run while he asks something
   else.
4. **Usage ceiling** — should a job stop at a token or cost limit? He is on Pro
   with usage credits enabled, so overflow past a plan limit is real money
   (£10.66 of £40 as of 2026-07-31). A counter can only report *Operator's own*
   usage — there is no `claude usage` subcommand — so never present it as plan
   usage.

Plus the two renames in the next section, which have been waiting since before
2026-07-30.

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

**`data/operator.json` is gitignored, so git is not a backup.** Real data is in
it now, and v17 added the copy job: `scripts/backup.mjs`, run
hourly by the storage server itself (and by hand with `npm run backup`), keeping
60 restore points. **Still single-machine** —
it protects against a bad write, a bad migration or a mistaken clear, not
against losing the disk. Point `OPERATOR_BACKUP_DIR` at a NAS share when there
is one. See [`docs/development.md`](docs/development.md#backups) and **OPS-017**.

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