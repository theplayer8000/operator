# Roadmap & Feature Status

The status table in `CLAUDE.md, "Feature status"` is authoritative for *what is built*.
This document carries the detail: what each feature is meant to become, what
already points at it, and what has to be decided before it can be built.

Keep both in sync when a feature ships.

## Built

### Dashboard — `/`

Ten widgets in a 3-column grid. The daily glance.

**Editable:** focus, tasks (add/toggle/edit/delete), quick notes
(add/edit/delete).
**Live, read-only:** the "Now" card (clock, date, current routine block with
time remaining), the Homelab tile strip, and three mission widgets — Current
Missions, Mission Progress and Mission Status — all reading the real
`missions.records` and linking through to `/missions/:id`.
**Still display-only seed:** weekly goals, streaks, upcoming events. Plumbing
exists; editors don't.

**OPS-005 closed in v9.** The mission widgets used to render `dashboard.missions`
seed data that never moved, and the Productivity Score card charted seven
hardcoded numbers as a "7-day trend". Both now derive from real data — see
[ADR 0008](decisions/0008-dashboard-reads-the-real-board.md), which supersedes
ADR 0003.

Known gaps: weekly goals and streaks are still seeded with no editor — the same
class of defect OPS-005 fixed, one level down.

### Daily Routine — `/routine`

Seven fixed sections (`morning`, `work`, `gym`, `learning`, `forex`, `evening`,
`sleep`) rendered as a vertical rail. Per-section tasks with minute estimates and
per-section notes. Tasks marked `repeatDaily` reset once per calendar day.
Steps can be renamed and re-estimated inline, or deleted — edit mode replaces
the row rather than adding a fifth control to it, since the row already carries
a checkbox, a minute estimate and the repeat toggle.

Each section has a **start time** (schema v2), and a **Day Schedule** timeline
sits above the rail: every block on a clock, with a live "on now" highlight,
duration bars scaled to the longest block, and a warning when one block starts
before the previous is estimated to finish. The Dashboard's "Now" card reads
the same schedule to answer "what am I meant to be doing".

Bar length is relative to the longest block rather than a literal 24h scale —
at true scale a 2-minute step is a sub-pixel sliver and most of the height goes
to the gap before work.

**Steps are tickable from the Day Schedule itself** (v15). Tapping a block
opens it in place and reveals its steps with working checkboxes — the schedule
is where you look to know what you're meant to be doing, so it's where the
tick belongs, rather than scrolling past the card to the section list below.
One block open at a time; the section list is still the place to add, rename
or re-estimate.

**A day stepper scopes the whole page to one date** (v15, completed in v16),
which answers "what does Tuesday look like" and "what did I actually do on
Monday". The date lives on the page rather than in the schedule card, because
the summary and every section card are scoped to it too — stepping the schedule
while the cards below showed today would be two days on one screen.

**Ticks are stored per date** (`routine.completions`, schema v3) and the nightly
reset is gone with the flag it used to clear. v15 shipped the stepper with the
checkboxes hidden off today, because at that point there was genuinely no
per-date record to show and inventing one would have been a lie; v16 gave it a
real one, so they work on every date. What stays today-only is the *clock* — the
"on now" highlight and the dimming of finished blocks are facts about the
present, not about the date being viewed.

Section start times, step titles and estimates are still day-agnostic: editing
them edits the template for every day, because the routine being the same every
day is the premise of the feature. Only completion is per-date. See
`data-model.md` → Daily Routine for the one-off vs repeating distinction, which
is the part that trips people up.

Known gaps: no history view over `routine.completions` — the per-date data now
exists and nothing charts it, the same gap Gym has. (**OPS-009** is moot as of
v16: the reset it described no longer exists.)

### Mission Board — `/missions`, `/missions/:id`

The heart of the app. List view with status filters; detail view with ten tabs
(Overview, Objectives, Milestones, Timeline, Notes, Activity, Related Knowledge,
Related Decisions, Related Journey, AI Summary).

Supports: create, inline edit of every text field, status, progress, time
invested, estimated completion, milestone CRUD, directional dependencies, and an
activity log.

Delete and archive both landed in v7 (**OPS-012** closed) — archive from the
detail page, an "Archived" filter on the board to get records back, and delete
that sweeps the ID out of other missions' `dependsOn`.

Known gaps: nothing prevents a dependency cycle (**OPS-013**); no undo on
delete (**OPS-020**).

### Homelab — `/homelab`

One tile per service running on the box: name, description, `host:port`, stack,
a live online/offline dot, and a link that opens it. Tiles are added, edited and
removed from the page itself; the list is data (`homelab.services`), not code,
so a new project is a form entry rather than a commit.

This is what makes Operator the front door to the EPYC server rather than just
one app on it. The Dashboard carries a compact read-only strip of the same
tiles — the homepage-of-the-homelab job — while management stays on `/homelab`.

Status is probed **server-side**, which is the whole design decision here: the
browser is usually a phone over Tailscale, so a client-side probe of
`localhost:5000` would probe the phone and report everything offline. See
[ADR 0007](decisions/0007-homelab-server-side-probes.md).

First tile is **Darams CRM** (`:5000`), which is a separate Flask project with
its own database and its own repo. Operator links to it and shares nothing with
it — deliberately, per that project's own handoff. Do not integrate them in
code.

Known gaps: port-open is not health (**OPS-019**); no grouping or ordering of
tiles beyond insertion order; no favicon or icon per service.

### Calendar — `/calendar`

Labelled **Calendar** in the nav; the feature underneath is still named Events
internally (`events.records`, `useEvents`, `CalendarEvent`) — same split as
"Mission Board" over `missions.records`. Only the user-facing label and route
changed; `docs/data-model.md`'s Events section still covers the type.

The year on a calendar: twelve month grids, Monday-first, with coloured dots per
day by kind (work / personal / admin / health / other). Pick a day to see what's
on it, add one, or edit any field of an existing one — including its **date**,
which moves it off the day you're looking at and follows the selection there.
Timing is set as a **start and finish**, not a duration in minutes — pick two
clock times and the app does the subtraction; editing an existing event
reconstructs the finish time from the stored start + duration so it round-trips
cleanly. A "Next up" list runs alongside. The Dashboard's Upcoming Events widget
reads the same feature and links in, and the "Now" card's clock/date opens the
calendar directly.

**On a phone, tapping a day opens the day panel as a floating overlay**, not a
block sitting after twelve month grids in document flow. It used to be the
latter — reachable only by scrolling past however many months came before the
one you tapped — which read as broken rather than as a long page. Below `lg` a
tap opens a scrim + floating card (Escape or tapping the scrim closes it, body
scroll locked underneath, same pattern as the Sidebar's mobile drawer); at
`lg`+ the same component renders as the normal static sidebar column, unchanged.

**Timed events sync onto the Daily Routine's Day Schedule, read-only.** Give an
event a start and finish and it shows up interleaved with today's routine
blocks on `/routine` — a call at 14:00 sits between the Work and Gym blocks the
way it actually happens in your day, rather than living only on a separate
calendar page. Events still owns the data exclusively; the routine page only
reads it, the same pattern `HomelabStatus` and `CurrentTime` already use.

**Fully local — no external permissions.** This is ordinary data in
`events.records`. What *would* need permissions is syncing a third-party
calendar (Google, Outlook): that means OAuth to a host the owner doesn't
control, which the self-hosted rule in `CLAUDE.md` bars. A manual `.ics` import
would not cross that line and is the sanctioned route if calendar interop is
ever wanted — same shape as Settings' JSON import.

Dates are stored as local `"YYYY-MM-DD"` keys, never timestamps. See the
`toDateKey` note under **OPS-009** — building one with `toISOString()` puts
every event between midnight and 1am BST on the wrong day.

**Repeating events** landed in v13 (weekly only), driven by the owner's work
shifts. One record per series, expanded at read time. **v14 split skip from
delete**: skipping a single occurrence (annual leave, a swapped shift) adds a
skip date and leaves the rule alone, is one tap with no confirm, and shows the
skipped occurrence on its own day with an undo — deleting now removes the
whole series and still confirms. Before v14, delete on an occurrence silently
meant skip, which left no way to remove a series at all. See `data-model.md` →
Recurring events.

**Notes can belong to one occurrence, not just the series** (v18). A repeating
event's `notes` is a property of the series — editing it writes to every
occurrence, which is right for standing information and useless for what
happened on a particular shift. So a repeating occurrence gets its own note
button and its own note (`occurrenceNotes`, keyed by date), rendered under a
"This day" rule so the two can't be mistaken for each other. Driven by a real
need: *"im on a collection right now and theres a couple areas ive missed out i
need to report to my supervisor."*

**The Work page will read these, not own them.** The owner's preference is for
shift notes to live on `/work` once that's built. Nothing needs to move — a
shift *is* a calendar event, the note is per-occurrence data on that event, and
Work reading `useEvents()` read-only is the pattern the Dashboard and Day
Schedule already use. Copying them into a `work.*` slice would be a second
stored copy of one fact, which is what ADR 0008 exists to prevent.

Known gaps: no multi-day spans, no reminders, no monthly/yearly recurrence.
None should be faked with a loop over single days. Occurrence notes are only
reachable from the day they belong to — there's no "all notes for this series"
view, which is a thing the Work page would be the right home for.

### Gym — `/gym`

Today's session as a one-handed, tickable checklist — a phone on a bench
between sets is the design target, not a desk. A day stepper moves through
past and future dates; each date shows its own session (`gym.completions`,
keyed by date, so nothing needs resetting) or a rest day.

Five sessions, named by push/pull structure, keyed by ISO weekday — the split
itself is owner content in `reference/gym-programme.md` (phases, percentages,
deloads, nutrition), not `/docs`. `gym.sessions` is source/seed today; no
editor exists yet.

**v14 added skip**, matching the pattern also added to Calendar occurrences
the same milestone: a trained-but-skipped day (`gym.skipped`) is one tap with
no confirm, states itself on the page rather than looking like an untouched
session, and offers "Actually, I trained" to undo. Deliberately **not** the
same thing as a rest day or a calendar skip — `gym.skipped` says the session
was scheduled and deliberately not done, distinct from "nothing was
scheduled". See `data-model.md` → Gym.

Known gaps: no session-template editor; no history/adherence view over
`gym.completions` and `gym.skipped` yet — the raw data exists, nothing charts
it.

### Settings — `/settings`

Storage status (online/offline, data file, schema version), backup, and clear.

**Backup.** Export downloads the whole store as JSON, read from the **server**
rather than the local mirror — a mirror-based export would silently omit
anything this browser had never loaded, which is the worst kind of backup.
Import merges: a slice missing from the file is left alone rather than wiped, so
export → edit the JSON → import back is a supported way to load your own data.

**Clear empties, it does not restore the seed.** See the data-model note — this
is the counter-intuitive part, and the reason clearing writes `[]` instead of
deleting the key.

Architecturally Settings is the second sanctioned exception after the Activity
Log: it acts on **every** namespace and owns none. It talks to the storage API
directly instead of going through a feature hook, because it administers the
store rather than modelling anything in it.

Known gaps: backup is manual — nothing is scheduled (**OPS-017**). No accent
picker, deliberately: the accent is ~95% inert (**OPS-007**) and shipping a
control that does nothing is worse than not shipping one.

### Updates — `/updates`

A running log of what's changed in Operator, and what's queued, meant to be
read here rather than dug out of git history or a handoff doc. Two sections:
**Pending** (quick-captured, editable, mark-done) and **Shipped** (dated,
newest first, reversible back to pending). A quick-capture box at the top adds
a pending entry in one line.

**Written for the owner, not the next engineer.** Entries are plain sentences
— "Fixed the daily reset rolling an hour late" — not commit-message shorthand.
This is deliberately a different register from `docs/handoffs/`, which stays
the engineering-facing record for whoever picks this codebase up next; Updates
is the same information, translated, and reviewable on a phone without opening
a repo.

Seeded on first run with the milestones through v11 and the currently-known
pending work (Gym, Weekly Goals/Streaks editors, scheduled backups, repeating
events) — after that it's whatever gets added. The convention going forward:
whenever a real milestone ships, add an entry here in the same pass as the
handoff, in the owner's terms.

Architecturally this is a plain feature — own namespace (`updates.entries`),
own hook, own page — not another read-only aggregator; it owns and writes its
own data like Mission Board or Events do.

### Activity Log — `/log`

A unified, read-only feed of everything that has happened: the Dashboard's
activity slice plus every mission's embedded `activity[]`, merged and grouped
by local calendar day. Filterable by source; mission rows link to the record.

**Architecturally it is the exception that proves the rule** — the app's only
cross-feature reader. It owns no namespace, persists nothing, and mutates
nothing. That became safe in v5 when `remoteStore` gave every hook one shared
cache; before that, calling two feature hooks from one page would have diverged
their state. Statistics should follow this same shape.

Known gaps: it can only show what the underlying logs retain — Dashboard
activity caps at 20 entries and each mission at 30, so the log has a horizon
rather than full history. Routine and theme changes are not logged at all.

### Contents — `/contents`

A hand-written index of every section: what it is, what it's for, and whether
it's built, planned or a concept. Deliberately **not** derived from the route
table — routes know paths, not purpose, and purpose is the point of the page.
**Keep it in step with this document** when a feature's status changes.

### Orchestrator — `/orchestrator`

Was "Claude" at `/chat`, renamed 2026-08-20 when it stopped being about one
model. `/chat` redirects.

Work with a model is a **job**: an append-only event log that outlives any HTTP
request, so a long turn shows which file was read and which command ran instead
of a spinner. Tabs survive a restart; their event logs do not, and the UI says
so. Polling rather than streaming, because stream readers deliver nothing on
the owner's iPhone.

Four pieces sit behind it, each a separate file on purpose:

- **`server/jobs.mjs`** — the queue, job state, the event vocabulary, the
  permission questions registry. Same gate as the terminal: a job has tool
  access, so it is execution.
- **`server/providers.mjs`** — the worker boundary. Claude Code (full tool
  access, via the Agent SDK) and Gemini (capability actions only, registered
  only when a key exists). Adding a speculative third is the "extending a
  permitted boundary" that [ADR 0009](decisions/0009-permitted-abstraction-boundaries.md)
  forbids.
- **`server/routing.mjs`** — picks the worker per task. Rules first, so it
  works with no network and no quota; a classifier only for ambiguous
  phrasing. Anything uncertain goes to the capable worker.
- **`server/actions.mjs`** — the capability layer. Named, validated reads and
  writes over Operator's own data, mirroring what each feature hook does, so a
  worker changes data without editing source.

**A permission is a question, not a dead end**
([ADR 0012](decisions/0012-claude-agent-sdk.md), option C): a tool outside the
pre-allow list suspends the turn and asks on the phone, and answering resumes
that same turn. Publishing and deleting are never asked about — they come back
as a command for the owner to run.

Jobs run in a **separate git worktree on branch `agent`**, so what the running
app serves is never half-finished work.

Still open, designed in [`control-plane-design.md`](control-plane-design.md):
a gateway seam, a local control model, multi-worker jobs, job-level permission
envelopes.

### Dev — `/dev`

Repo status (branch, commit, subject), links out to GitHub, and a read-only
browser over the project directory with shortcuts to the key docs. Two live
diagnostics sit above the repo browser: a **connected-clients monitor**
(who's hit the server this session — device, request count, last endpoint,
held in memory only) and **Claude status**, a read of Anthropic's public
Statuspage.

Served by `server/dev.mjs`, which is the only part of Operator that touches the
filesystem beyond the data file. It is deliberately narrow: **reads only** (no
write route exists), every path is resolved and re-checked against the repo
root so traversal cannot escape, and `node_modules`, `.git`, `dist` and `data`
are never listed or served — `data` because it holds personal content and has
its own API. Text only, 400 KB cap.

**Corrected 2026-08-21.** This section used to say "there is no
authentication; the tailnet is the boundary". That was true when written and
became false at [ADR 0010](decisions/0010-tailnet-identity-authentication.md):
every `/api/` route now requires an identified caller — a tailnet device
resolved from the local `tailscale` daemon, a bearer token, or loopback. The
check sits in front of the router. It still must not be exposed beyond the
tailnet, but the reason is the absence of a sandbox, not the absence of a lock.

The Dev page also carries a **terminal** for named devices, disarmed on every
start ([ADR 0011](decisions/0011-remote-terminal-for-authorised-devices.md)),
and a **Builds** card showing which code each URL is actually serving.

**Outbound calls now number more than one.** `status.claude.com` was the first
(`server/status.mjs` — cached, degrades to stated-stale rather than breaking
the page). Gemini was approved by name on 2026-08-20 and is reached from
`server/gemini.mjs`. Both are in the approvals table in `CLAUDE.md`, which is
the whole set; read the "External applications" rule before adding a third.

## Not built

All seven have a route, a `ComingSoon` placeholder, a sidebar entry, and a
command-palette destination already wired.

| Feature | Route | What it's for | Decide first |
|---|---|---|---|
| **Learning** | `/learning` | Skill/topic progress over time. `MissionRecord.relatedLearning` is free text waiting for it; the Related Knowledge tab already renders a `ReservedSection` pointing here | Its relationship to Knowledge Vault — are they one feature or two? |
| **Forex** | `/forex` | Study/observation journal. Note the routine caption is "Study, don't trade" — this is a learning journal, not a P&L tracker | Whether Recharts is needed here; it is currently used in exactly one widget |
| **Work** | `/work` | GEH NHS / Darams work tracking | Scope — this overlaps Mission Board's `career` category |
| **Journey** | `/journey` | The long-term life roadmap that missions ladder up to. `MissionRecord.relatedJourneyMilestone` is free text waiting for it. Nav entry reserved on request | The top of the three-tier hierarchy — this one deserves real design thought, and it is the feature the whole philosophy points at |
| **Statistics** | `/statistics` | Cross-feature aggregate view | **Unblocked as of v5** — the shared store means it can safely read every feature's hook. Keep it strictly read-only |
| **Settings** | `/settings` | Export / import / reset, accent switcher, storage location | Nothing blocking, and now mostly plumbing: `GET /api/state` is export, `PUT /api/state` is import, `DELETE /api/state/<key>` is per-feature reset. The accent switcher is wired and just needs UI. Still the **cheapest** feature, and it closes **OPS-017** (backup) |

## Not started, no route

*(Knowledge Vault shipped 2026-09-03, Decision Log 2026-09-10 — both moved into
the status table in `CLAUDE.md`. Nothing left in this section.)*

## Reserved integration points

Places in the built app that are already waiting for an unbuilt feature. Each is
a `ReservedSection` or a free-text field, deliberately not a real reference
(Invariant 2):

| Location | Waiting on |
|---|---|
| `MissionDetail` → Related Journey tab | Journey |
| `MissionDetail` → Overview → Files & Attachments | A real design conversation. The store is JSON, so binary still doesn't belong in it — likely paths or links, not contents |
| `MissionDetail` → AI Summary tab | An AI summary feature that would need a network call, i.e. a constraint conversation first |
| `GET`/`PUT`/`DELETE /api/state` | Settings — export, import, per-feature reset |
| `ThemeContext` accent | Settings |

## Suggested sequencing

Not a decision — a recommendation for the owner, based on cost against risk
retired. **Refreshed 2026-08-21**; everything above item 5 shipped.

1. ~~`generateId()` fix (**OPS-001**)~~ — **done in v5.**
2. ~~Storage off localStorage (**OPS-003**, **OPS-004**)~~ — **done in v5.**
3. ~~Mobile / responsive pass~~ — **done in v6.**
4. ~~Settings, and a backup route (**OPS-017**)~~ — **done**, plus hourly
   snapshots run by the server itself.
5. ~~The AI workspace~~ — **done**: jobs, the provider boundary, in-turn
   permissions, the capability layer, auto-routing, uploads.

What is actually next, in the owner's stated order:

6. **The control plane** — [`control-plane-design.md`](control-plane-design.md),
   designed and not built. Local routing first, then a gateway seam. Both are
   provider-neutral and neither commits to a gateway product.
7. **Usage ceilings** — the accounting is decided
   ([ADR 0013](decisions/0013-usage-accounting.md)); per-job, per-provider and
   daily limits are not built. Per-job is the runaway guard and the cheapest.
8. **Knowledge Framework**, then **Search Service**, then **Universal Search** —
   in that order, because the last two need somewhere to search.
9. Then whichever feature the owner actually wants. Journey is still the one
   the whole three-tier philosophy points at, and still unstarted.

## Pending naming changes

Flagged in `CLAUDE.md, "Naming — pending, do not do unprompted"` as wanted **eventually**, not yet. Do not apply
without explicit confirmation:

- "Today's Focus" → "Primary Objective"
- "Current Missions" → "Active Missions"

Separately, `components/dashboard/CurrentMissions.tsx:22` still says "start one
from Projects" — pre-rename copy that should say "Mission Board". That one is a
plain bug rather than a pending decision (**OPS-005**).
