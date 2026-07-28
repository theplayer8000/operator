# Roadmap & Feature Status

The status table in `CLAUDE.md:143-158` is authoritative for *what is built*.
This document carries the detail: what each feature is meant to become, what
already points at it, and what has to be decided before it can be built.

Keep both in sync when a feature ships.

## Built

### Dashboard — `/`

Ten widgets in a 3-column grid. The daily glance.

**Editable:** focus, tasks (add/toggle), quick notes (add).
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

Known gaps: no delete and no archive UI despite `archived` existing on the type;
setting a milestone to "In Progress" wipes its progress (**OPS-002**); nothing
prevents a dependency cycle.

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
| **Statistics** | `/statistics` | Cross-feature aggregate view | **Blocked on a real decision** — it must read across features, which Invariant 1 makes unsafe today (**OPS-004**). Do not start it without resolving that |
| **Settings** | `/settings` | Export / import / reset, accent switcher | Nothing blocking. `exportAllData`/`importAllData`/`resetAllData` are already written and unused; the accent switcher is already wired and has no UI. This is the **cheapest** feature to build and it retires the largest product risk (data loss) |

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
| `MissionDetail` → Overview → Files & Attachments | A real design conversation — localStorage can't hold binary (`CLAUDE.md:181-185`) |
| `MissionDetail` → AI Summary tab | An AI summary feature that would need a network call, i.e. a constraint conversation first |
| `lib/storage.ts` export/import/reset | Settings |
| `ThemeContext` accent | Settings |

## Suggested sequencing

Not a decision — a recommendation for the owner, based on cost against risk
retired:

1. **`generateId()` fix** (**OPS-001**) — approved, spec'd, blocking real use
   over Tailscale, and cheaper before a ninth call site exists.
2. **Settings** — smallest feature, retires the biggest product risk (no way to
   back data out), and everything it needs is already written.
3. **Schema versioning** (**OPS-003**) — cheaper now than after four more
   namespaces exist.
4. Then whichever feature the owner actually wants.

## Pending naming changes

Flagged in `CLAUDE.md:187-200` as wanted **eventually**, not yet. Do not apply
without explicit confirmation:

- "Today's Focus" → "Primary Objective"
- "Current Missions" → "Active Missions"

Separately, `components/dashboard/CurrentMissions.tsx:22` still says "start one
from Projects" — pre-rename copy that should say "Mission Board". That one is a
plain bug rather than a pending decision (**OPS-005**).
