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
| [`docs/threat-model.md`](docs/threat-model.md) | **Before changing anything about auth, the terminal, or how Operator is reached.** What actually holds the line, and the fact that there is no sandbox — the terminal runs as the owner with no isolation |
| [`docs/known-issues.md`](docs/known-issues.md) | **Before shipping anything** — two entries are active defects, not theory |
| [`docs/development.md`](docs/development.md) | Running, verifying, or handing off work |
| [`docs/decisions/`](docs/decisions/) | Before "fixing" something that looks wrong, or changing an established pattern |
| [`docs/decisions/0012-claude-agent-sdk.md`](docs/decisions/0012-claude-agent-sdk.md) | Before touching the job runner, or adding anything to `server/`'s dependencies |
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
| Anthropic (Claude Code worker) | Anthropic's API, via the Agent SDK | [ADR 0012](docs/decisions/0012-claude-agent-sdk.md), 2026-08-04. Runs on the Pro subscription, no API key |
| **Google Gemini** | `generativelanguage.googleapis.com` | **2026-08-20**, `server/gemini.mjs`. What leaves the machine: the prompt and whatever job context is attached. Key in `GEMINI_API_KEY`, env only |

**Each AI provider needs its own named approval.** The AI Provider Manager was
approved on 2026-07-30 (ADR 0009); approving the router did **not** approve its
occupants, and approving Gemini does not approve the next one. OpenAI/Codex and
anything later still needs asking for by name, and then goes in the table above.
Three hard conditions come with each:

- **The frontend never talks to a provider.** Server-side only, same as
  `server/status.mjs`.
- **API keys never go in `data/operator.json`, in git, or to the client.** That
  file is plaintext, served by an API with no auth — a key in it is a key
  published to the tailnet. Environment variables in development; Docker
  secrets or equivalent runtime config in production.
- **And never type one into Operator's own terminal.** It logs every command it
  runs — that audit line is the point of ADR 0011 — so `setx SOME_KEY <value>`
  there writes the secret to the server log in plaintext. The Gemini key had to
  be reissued for exactly this. Set secrets from a normal shell at the desk;
  the server reads them from the environment either way.
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

### AI workers change data through the capability layer, not through code

An AI asked to tick off a gym session, add a mission or drop something on the
calendar must **not** edit source to do it. `server/actions.mjs` exposes named,
validated actions for exactly this, run via
`node scripts/operator-action.mjs <action> '<json>'` (`list` shows them all).
Each mirrors what the matching hook in `src/hooks/` does — same id generation,
same date-key handling, same invariants — so the write is indistinguishable
from one made through the feature's own page. Editing source is for changing
how Operator *works*, not what it currently *holds*.

Three rules keep this from rotting into the thing it replaced:

- **It is not a generic write gateway, and must never become one.** Every action
  has a fixed name and a fixed parameter shape and can only do what the owner
  could already do through the UI. `PUT /api/state/<key>` — which *is* generic
  and unvalidated — stays a maintenance backdoor, not something a worker is
  pointed at.
- **A new action mirrors its hook, it does not invent behaviour.** If the UI
  archives before deleting, the action does too. Where the two disagree, the
  hook is right and the action is a bug.
- **A CLI, deliberately, not an SDK-native tool.** The Agent SDK's `tool()`
  helper needs zod, which is not a declared dependency here (it exists only as
  something the SDK pulled in), and declaring it needs an ADR. A CLI is also
  worker-agnostic — Claude, Gemini and Codex call it identically, which is the
  entire point of having a capability layer rather than one integration per
  model. Revisit only if a worker can't run commands.

Everything here touches **Operator's own data only**. Anything reaching an
external host — GitHub, email, Slack, Drive — is a separate decision under the
approval rule above, one named host at a time, however tempting a "capability
registry" makes it look like a single step.

## Tech stack

React 18 + TypeScript + Vite + Tailwind + React Router v6 + Recharts +
lucide-react. Nothing else **in the frontend**.

`server/` was dependency-free — eleven Node built-ins and nothing else — and is
no longer, as of [ADR 0012](docs/decisions/0012-claude-agent-sdk.md), which
adopts the Claude Agent SDK for the job runner. That is the amendment, not an
opening: a server dependency needs an ADR naming the package and what it buys,
and everything outside the runner (`auth.mjs`, storage, backups, terminal) stays
pure Node so that what serves your data is still readable end to end. Don't introduce a state management library
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
  jobs.mjs              — work with Claude Code, modelled as a job rather than a
                          request: an append-only event log that outlives any HTTP
                          request. Owns a session_id per job and passes --resume, so
                          a tab is a thread that remembers. Owns the pre-allow list
                          and the questions registry — a permission the running turn
                          is suspended on, answerable from the phone. Same gate as
                          the terminal: a job has tool access, so it is execution.
                          Step 1 of docs/ai-workspace-design.md
  store.mjs             — the ONE in-memory copy of data/operator.json, and the
                          only place in server/ allowed to read or write it.
                          withState() is the race-safe read-modify-write every
                          action goes through — read its comment before adding
                          a second writer
  actions.mjs           — the capability layer. Named, validated READS and
                          writes of Operator's OWN data (gym, missions,
                          calendar, routine) that an AI worker can call.
                          Mirrors each feature hook exactly, including its
                          derived views — recurrence expansion, isDoneOn.
                          **A new feature needs a read action, not just
                          writes**: without one a worker greps source to
                          answer a question, which cost $0.92 and two minutes
                          the one time it happened. NOT a generic write
                          gateway — see its header before adding anything
  providers.mjs         — the worker boundary between jobs.mjs and a turn. One
                          worker registered (claude-code → runner.mjs); adding a
                          speculative second one is exactly the "extending a
                          permitted boundary because it's there" ADR 0009 forbids
                          — don't, until a provider is actually approved by name
  runner.mjs            — one turn, through the Claude Agent SDK. The ONLY file in
                          server/ that imports an npm package — ADR 0012 bounded
                          the dependency there deliberately. Keep it that way
  uploads.mjs           — local files attached to a job. Staged outside
                          operator.json (10 MB cap), claimed onto a turn, the
                          worker gets told the local path. Swept when a job
                          closes or clears — nothing here outlives its job
  routing.mjs           — picks the worker for a new job. Rules first (they work
                          with no network and no quota), a Flash call only for
                          genuinely ambiguous phrasing. Uncertain → Claude Code
  clients.mjs           — in-memory record of which devices are connected
  status.mjs            — Claude service status. The only outbound call; see the rule above
scripts/
  dev.mjs               — starts the API and Vite together
  log-update.mjs        — append one entry to the Updates changelog. No deps.
                          Goes through the API, not the file — see the rule above
  operator-action.mjs   — run one capability action (server/actions.mjs). How an
                          AI worker changes DATA instead of editing code. A CLI
                          rather than an SDK tool on purpose: every worker calls
                          it identically, which is the point of the layer
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
    orchestrator/              — OrchestratorChat. Provider-agnostic: reads each
                                  job's provider and capabilities, never assumes
                                  a worker. Was dev/ClaudeChat.tsx until Gemini
    updates/                   — HandoffCard (renders docs/handoffs/CURRENT.md)
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
    Contents.tsx, Dev.tsx, Orchestrator.tsx,
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
| Updates | `/updates` | Built — three sections: the **Handoff** (read-only, rendered from `docs/handoffs/CURRENT.md` — where the work is), the **Queue** (what he's asked for), and the **Changelog** (what shipped, dated). Written to by `scripts/log-update.mjs` as well as by hand. Distinct from Activity Log |
| Homelab | `/homelab` | Built — tile per service on the box, with a server-side up/down probe. Also a read-only section on the Dashboard |
| Activity Log | `/log` | Built — read-only aggregator, owns no storage |
| Contents | `/contents` | Built — hand-written index of every section. Keep in step with `docs/roadmap.md` |
| Orchestrator | `/orchestrator` | Built — **renamed from "Claude" 2026-08-20**, the milestone rather than a relabel: `server/providers.mjs` now sits between `jobs.mjs` and the worker that runs a turn, so a job is a task dispatched to whichever worker is enabled, not "a Claude conversation." **Two workers are enabled** — `claude-code` (the Agent SDK, full tool access) and `gemini` (approved 2026-08-20, `server/gemini.mjs`, capability actions only, registered solely when `GEMINI_API_KEY` is set). `/chat` redirects here. Conversations are **jobs** (`server/jobs.mjs`, design-doc step 1): a tab strip, an append-only event log that outlives the request, a `session_id` per job with `--resume` so a tab remembers. Model is selectable, Opus 5 by default. **A permission is a question, not a dead end** (ADR 0012, option C, merged and live): a tool outside the pre-allow list suspends the turn and shows Allow / No / Allow-and-stop-asking, and the same turn resumes on the tap. The two the **standing profile** denies outright never become questions — that card hands you the command to run yourself instead. **Jobs can carry local file attachments** (`server/uploads.mjs`) — staged outside `operator.json`, claimed onto a turn, the worker gets the local path. **A failed, blocked, or cancelled turn can be retried** with one tap instead of retyping. Every attempt is recorded (`task`/`attempts`/`handoff` on the job) — dormant on the frontend today, the bookkeeping a future verifier or second worker will read, not something a person needs to see while there is only one worker and the owner reads results directly. Same gate as the terminal — armable from this page. **The worker is chosen when a conversation starts, not mid-thread**: a job holds one worker's session for life and the two aren't interchangeable (Claude Code's lives on disk and resumes; Gemini's is a replayed history in server memory and dies with a restart — the UI says which). The chat surface is `src/components/orchestrator/OrchestratorChat.tsx`, renamed from `dev/ClaudeChat.tsx` the day Gemini landed; it reads each job's provider and declared `capabilities` rather than assuming Claude Code's |
| Dev | `/dev` | Built — repo status, GitHub links, sandboxed read-only file browser, connected-client monitor, Claude service status, a **Builds** card (is the live app behind `src/`, is the API behind `server/`, is the dev server up), and a **terminal** for authorised devices, disarmed by default (ADR 0011). **Restart** reloads the server so it picks up its own code — see the two rules below |
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

## Never `git add -A` — two sessions write to this repo now

**Rule:** stage files by name. `git add -A` and `git commit -a` are banned here.

This has gone wrong twice, the same way both times. Claude runs inside Operator
and edits the working tree; a session at the desk runs `git add -A`, sweeps up
whatever the agent had in flight, and commits it under a message describing
something else entirely. `cadccfc` claimed to be a docs commit and carried 867
lines of unreviewed `server/jobs.mjs` plus a route swap that left `main` unable
to restart. It had to be reverted.

The tree is shared. A dirty file you did not touch is not noise to sweep up, it
is someone else's work — and a commit message that does not describe its own
contents is how it gets lost rather than reviewed.

Before committing, run `git status` and stage what you meant to change. If
something unexpected is there, read it and decide deliberately: commit it in its
own commit with its own message, or leave it.

## Every piece of work keeps a live handoff — write it as you go

**Rule:** any session doing real work on Operator — this one, or Claude running
inside Operator — keeps [`docs/handoffs/CURRENT.md`](docs/handoffs/CURRENT.md)
up to date **as it works**, not at the end.

Why this is a rule rather than a nicety: restarting the server is now a normal
part of editing Operator (see the two rules above), and a restart **destroys the
event log**. Claude Code's own session survives, so the model still remembers —
but the app shows an empty thread, and if the session is ever lost too, the work
is unreconstructible. A file on disk survives both.

Update it:

- when starting a piece of work — what and why,
- after anything lands — what changed, what is verified, what isn't,
- **before asking for a restart**, always. That is the moment it exists for.

Keep it short and current. It is a working note, not a record: overwrite it
rather than appending a log. When the work reaches a milestone, fold it into a
dated handoff in the same folder and reset `CURRENT.md` to the empty template.

If it is empty or stale, say so rather than guessing — a confident summary
reconstructed from the diff is worse than "the last session left no note".

**The handoff is now readable in the app.** The Updates page renders that file
directly (`src/components/updates/HandoffCard.tsx`, via `/api/dev/file`) — it is
**not** copied into the store, so there is one file and one truth. Writing it
badly is now visible on his phone, which is the point.

## Every change gets logged to Updates — one line, when it lands

**Rule:** when a piece of work ships, log it:

```bash
node scripts/log-update.mjs "What shipped" "What to know about it"
node scripts/log-update.mjs "An idea for later" "" --pending   # into the queue instead
```

The two records answer different questions and neither replaces the other:
`CURRENT.md` says **where the work is** and is overwritten as it moves; the
Updates changelog says **what happened**, dated, and is never rewritten. A
session reading only the first has no history; a session reading only the second
has no idea what is half-finished.

**Scope: one entry per piece of work someone would want to know shipped — not
one per commit.** A behaviour change, a new surface, a fixed bug, a reversed
decision, a decision that needs him. Not a typo in a comment, not a
formatting pass, not the third commit of the same feature.

Write the entry for the person who will read it in a month, not for git.
"Fixed BuildStatus" is useless; "every build links from its own row — the footer
button couldn't handle a third build" is the entry.

The script goes through the API on purpose: `data/operator.json` is held in the
server's memory while it runs, so a direct write to the file is lost at the next
save.

## "resume operator build" — the owner's resume phrase

When he types **"resume operator build"** (or close to it), treat it as a
request to do this before anything else:

1. Read [`docs/ai-workspace-design.md`](docs/ai-workspace-design.md) — the
   proposed structure and why the current one is shaped the way it is.
2. Read [`docs/handoffs/CURRENT.md`](docs/handoffs/CURRENT.md) — work in
   progress, possibly mid-restart — then the newest dated file in
   [`docs/handoffs/`](docs/handoffs/).
3. Ask the open decisions in the next section. Don't guess them.
4. Then start at the design doc's next unbuilt step.

His words for why it exists: a preset phrase so a new session picks up where
the last one stopped, instead of him retyping the same three instructions every
time. A session starting cold has the repository and this file and nothing
else, so the phrase is the handover.

## Editing Operator while it runs — the two rules

Operator is developed from inside itself, so at any moment the source, the built
snapshot and the running server can all disagree. Which command fixes that
depends only on which folder changed:

| Changed | Dev URL (`:8443`, Vite) | Live URL (the built app) |
|---|---|---|
| `src/` | instant, hot-reloaded | `npm run build` — **no restart**, the server reads `dist/` off disk per request |
| `server/` | Restart | Restart — it is loaded into memory at boot |

### The build must run in `D:\Projects\Operator`, not wherever you are

**If you are Claude running inside Operator, your working directory is the
`agent` worktree, and `npm run build` there does nothing you want.** It writes
`D:\Projects\Operator-agent\dist\`, which nothing serves. The live app reads
`main`'s `dist/`, so the build has to happen in the main checkout:

```bash
npm --prefix D:\Projects\Operator run build
```

This is the obvious mistake to make and it fails silently in the worst way: the
command succeeds, the output looks right, and the live app is unchanged — so the
natural next move is to go hunting for a bug in code that was never shipped.

**And it only helps after the work is on `main`.** Building the main checkout
while your change is still on `agent` rebuilds the old code. The order is:
merge, then build, then (only for `server/`) restart.

`npm run serve` runs under `scripts/supervise.mjs`, which relaunches the server
when it exits with code 75. That is what `POST /api/restart` and the Dev page's
Restart button do. It is **not** crash recovery: a server that dies
unexpectedly stays dead, deliberately, and five restarts in thirty seconds stops
the supervisor with the real error on screen. `npm run serve:once` skips it.

### Three builds, and Claude edits none of the ones you use

| URL | Serves | Checkout |
|---|---|---|
| `https://<host>.<tailnet>.ts.net` | the built app | `main` — what the owner uses |
| `:8443` | Vite, hot-reloaded | `main` — what he reviews |
| `:9443` | Vite, hot-reloaded | **`D:/Projects/Operator-agent`, branch `agent`** — what Claude writes |

The third one is the point. `OPERATOR_JOB_CWD` sends every job's `claude`
process into a **git worktree**, so the agent edits a different checkout to the
one the running server reads.

Before this, a job editing `server/` changed the tree the live server was
serving, and a half-finished migration was immediately everyone's problem —
which is exactly how `main` twice ended up unable to restart. Now its work is
invisible until the `agent` branch is merged, and that merge is the review step
that used to depend on remembering.

The worktree shares `.git` (so branches and history are one thing) and its
`node_modules` is a junction to the main checkout's, so it costs a few MB rather
than a reinstall.

`tailscale serve` **replaces** its config rather than adding to it — run all
three or you will silently drop the others:

```
tailscale serve --bg 5174              # live
tailscale serve --bg --https 8443 5173 # dev,   Vite on main
tailscale serve --bg --https 9443 5175 # agent, Vite on the worktree
```

Start the agent's Vite from the worktree: `npx vite --port 5175 --host`.

## Open decisions waiting on the owner — raise these, don't guess

Ask about anything here that touches what you're about to build. They are
recorded because a previous session needed them and could not proceed without
guessing; guessing is the failure mode this list exists to prevent.

**Before building any of the AI workspace** (see
[`docs/ai-workspace-design.md`](docs/ai-workspace-design.md)):

1. **Job history — DECIDED, and built.** Tabs survive a restart with their
   Claude session; event logs do not, and the UI says so. `data/jobs.json`.
2. **Permission profiles — DECIDED 2026-08-01, revised 2026-08-19.** The
   standing profile is unchanged in substance: **everything except `git push`
   and deleting files.** What changed is how the rest is reached.

   **Option C, on `agent` and not yet merged.** Jobs run through the SDK
   (`server/runner.mjs`, ADR 0012) in `default` mode with a broad **pre-allow
   list**, rather than `bypassPermissions`. Ordinary work — reading, editing,
   building, committing — never prompts because it is pre-approved. Anything
   outside the list **suspends the turn** and asks on the phone, answerable with
   one tap, and the same turn then carries on. Measured 2026-08-19: the callback
   held for six seconds and the tool ran 4ms after the answer.

   Chosen because the first two options were mutually exclusive and both bad:
   `bypassPermissions` never consults the callback, so ADR 0012 buys nothing;
   `default` alone asks about every file read. The pre-allow list is what makes
   the third one quiet, and it is cheap because the SDK already auto-approves
   trivially safe calls on its own.

   **`allowedTools` entries are not what they look like.** A bare tool name
   auto-approves that tool *everywhere*, before the callback is consulted; the
   scoped form (`Write(**)`) was measured to match nothing and make every write
   a prompt. Both are written up above `ALLOWED_TOOLS` in `server/jobs.mjs`.
   Measure before narrowing it — the probes are in `scripts/`.

   The two exceptions are the two that are hard to take back: publishing is
   public and permanent, deleting is unrecoverable and this project has no undo
   (**OPS-020**). Everything else is recoverable from git. They are denied
   outright and **never become a question**, so they cannot be waved through by
   a mis-tap.

   **When Claude hits one of those two, it must not retry** — it writes the
   exact command out for the owner to run in the terminal himself and notes it
   in `CURRENT.md`. That is appended to its system prompt, not left to chance.
   The same prompt now tells it that *everything else* can be asked about, so it
   stops routing around tools it is allowed to request.

   Grant-per-command remains rejected: it had produced 69 single-use rules that
   never expire, which is worse security than a considered standing profile.
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

**Neither gate looks at `server/`.** `tsc` and `vite build` never read a `.mjs`
file, so a clean build says nothing whatsoever about a server change. Syntax-check
those by hand — and **not with the `node` on PATH**:

```
"C:\Program Files\nodejs\node.exe" --check server/<file>.mjs
```

`D:\projects\node_modules\.bin\node` — one directory *above* this repo — shadows
the real binary and points at a POSIX path that doesn't exist on Windows. It
fails **silently**: `node --check` exits 0 having run nothing, and `node -e`
prints nothing at all. A session that verifies with it has verified nothing and
will be told everything is fine.

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