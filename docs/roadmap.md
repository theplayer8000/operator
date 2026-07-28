# Roadmap & Feature Status

The status table in `CLAUDE.md:143-158` is authoritative for *what is built*.
This document carries the detail: what each feature is meant to become, what
already points at it, and what has to be decided before it can be built.

Keep both in sync when a feature ships.

## Built

### Dashboard — `/`

Ten widgets in a 3-column grid. The daily glance.

**Editable:** focus, tasks (add/toggle/edit/delete), quick notes
(add/edit/delete).
**Live:** a "Now" card (clock, date, and which routine block is on with time
remaining) and the Homelab tile strip. Both read other features' data and
mutate none of it.
**Display-only:** weekly goals, streaks, upcoming events, productivity score,
current missions, project progress. The storage and hook plumbing exists for all
of them; only the editors are missing.

Known gap: the two mission widgets render `dashboard.missions` seed data that
never moves, and `setMissions` is returned but unused (**OPS-005**). Whether
these should read live Mission Board data is an open product question — see
[ADR 0003](decisions/0003-separate-mission-types.md) before deciding.

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

Known gaps: the reset is mount-only and UTC-based, so a tab left open across
midnight doesn't reset, and the day rolls at 01:00 local during BST
(**OPS-009**).

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

### Dev — `/dev`

Repo status (branch, commit, subject), links out to GitHub, and a read-only
browser over the project directory with shortcuts to the key docs.

Served by `server/dev.mjs`, which is the only part of Operator that touches the
filesystem beyond the data file. It is deliberately narrow: **reads only** (no
write route exists), every path is resolved and re-checked against the repo
root so traversal cannot escape, and `node_modules`, `.git`, `dist` and `data`
are never listed or served — `data` because it holds personal content and has
its own API. Text only, 400 KB cap.

There is no authentication; the tailnet is the boundary
([ADR 0006](decisions/0006-json-file-storage-server.md)). **This must not be
exposed beyond it.**

## Not built

All seven have a route, a `ComingSoon` placeholder, a sidebar entry, and a
command-palette destination already wired.

| Feature | Route | What it's for | Decide first |
|---|---|---|---|
| **Learning** | `/learning` | Skill/topic progress over time. `MissionRecord.relatedLearning` is free text waiting for it; the Related Knowledge tab already renders a `ReservedSection` pointing here | Its relationship to Knowledge Vault — are they one feature or two? |
| **Gym** | `/gym` | Training log. `routine.sections` already has a `gym` block, but that is a daily checklist, not a training record — they are different features and should stay separate namespaces | Register (calm vs playful) |
| **Forex** | `/forex` | Study/observation journal. Note the routine caption is "Study, don't trade" — this is a learning journal, not a P&L tracker | Whether Recharts is needed here; it is currently used in exactly one widget |
| **Work** | `/work` | GEH NHS / Darams work tracking | Scope — this overlaps Mission Board's `career` category |
| **Journey** | `/journey` | The long-term life roadmap that missions ladder up to. `MissionRecord.relatedJourneyMilestone` is free text waiting for it. Nav entry reserved on request | The top of the three-tier hierarchy — this one deserves real design thought, and it is the feature the whole philosophy points at |
| **Statistics** | `/statistics` | Cross-feature aggregate view | **Unblocked as of v5** — the shared store means it can safely read every feature's hook. Keep it strictly read-only |
| **Settings** | `/settings` | Export / import / reset, accent switcher, storage location | Nothing blocking, and now mostly plumbing: `GET /api/state` is export, `PUT /api/state` is import, `DELETE /api/state/<key>` is per-feature reset. The accent switcher is wired and just needs UI. Still the **cheapest** feature, and it closes **OPS-017** (backup) |

## Not started, no route

| Feature | Notes |
|---|---|
| **Knowledge Vault** | Personal wiki — notes, commands, resources, confidence per topic. Linked from missions' Related Knowledge tab (free-text field + `ReservedSection` today) |
| **Decision Log** | Decision / date / reasoning / outcome. Linked from missions' Related Decisions tab (`ReservedSection` today). Note: the ADRs in [`decisions/`](decisions/) are *engineering* decisions and are a different thing from this *life* decision log — don't conflate them |

## Reserved integration points

Places in the built app that are already waiting for an unbuilt feature. Each is
a `ReservedSection` or a free-text field, deliberately not a real reference
(Invariant 2):

| Location | Waiting on |
|---|---|
| `MissionDetail` → Related Knowledge tab | Knowledge Vault |
| `MissionDetail` → Related Decisions tab | Decision Log |
| `MissionDetail` → Related Journey tab | Journey |
| `MissionDetail` → Overview → Files & Attachments | A real design conversation. The store is JSON, so binary still doesn't belong in it — likely paths or links, not contents |
| `MissionDetail` → AI Summary tab | An AI summary feature that would need a network call, i.e. a constraint conversation first |
| `GET`/`PUT`/`DELETE /api/state` | Settings — export, import, per-feature reset |
| `ThemeContext` accent | Settings |

## Suggested sequencing

Not a decision — a recommendation for the owner, based on cost against risk
retired:

1. ~~`generateId()` fix (**OPS-001**)~~ — **done in v5.**
2. ~~Storage off localStorage (**OPS-003**, **OPS-004**)~~ — **done in v5.**
3. ~~Mobile / responsive pass~~ — **done in v6.**
4. **Settings** — smallest remaining feature, and the only route to a backup
   (**OPS-017**). Mostly plumbing over the existing API.
5. Then whichever feature the owner actually wants. Journey is the one the
   whole three-tier philosophy points at.

## Pending naming changes

Flagged in `CLAUDE.md:187-200` as wanted **eventually**, not yet. Do not apply
without explicit confirmation:

- "Today's Focus" → "Primary Objective"
- "Current Missions" → "Active Missions"

Separately, `components/dashboard/CurrentMissions.tsx:22` still says "start one
from Projects" — pre-rename copy that should say "Mission Board". That one is a
plain bug rather than a pending decision (**OPS-005**).
