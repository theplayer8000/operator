# 0004 — Different tonal registers per feature

**Status:** Accepted
**Date:** 2026-07-27

## Context

The Dashboard was built with a deliberately gamified streak: missions rendered
as hexagonal "shield" progress badges, confetti on task completion, animated
counters, a rotating daily quote. It is a morning glance — a few seconds, and it
should feel rewarding.

Daily Routine came next and wanted something quieter. Confetti on "screens off"
would be absurd.

Mission Board was then explicitly asked to avoid game UI altogether. It is where
multi-month work is tracked: an EPYC server build, a CRM, a career move. A game
HUD would undercut it.

The result looks inconsistent to anyone reading the codebase cold. This ADR
exists so it isn't "corrected".

## Decision

Three registers, applied per feature:

| Register | Feature | Signature | Forbidden |
|---|---|---|---|
| **Playful-but-premium** | Dashboard | `ShieldProgress` hexagons, `Confetti`, `StatCounter`, daily quote | — |
| **Calm** | Daily Routine | Vertical rail, filled/unfilled section nodes, minute budgets | Confetti, shields |
| **Neutral / tool-like** | Mission Board | Dot + pill status, four-dot difficulty pips, plain linear bars, tabs | Shields, confetti, XP language, levels, any game framing |

Mission Board should read like Linear or Notion.

**A new top-level feature must have its register chosen before it is built**
(`CLAUDE.md:138-141`) — inferred from the request's own tone if not stated, and
named explicitly when handing the work back. Do not default to copying whichever
feature you read last.

## Consequences

**Makes easy:** each surface fits its actual use. The reward mechanics land
where a reward makes sense and stay away from where it would feel cheap.

**Makes hard:**

- Shared primitives are not uniformly reusable. `Card` and `EmptyState` are
  register-neutral; `ShieldProgress` and `Confetti` are Dashboard-only. Mission
  Board uses none of `components/ui/` and composes `.card-base` directly.
- The rule lives **only in documentation**. Nothing in the code prevents someone
  importing `Confetti` into Mission Board — it would compile and look, to a
  cold reader, like consistency.
- Every new feature carries a small up-front judgement call.

## What would change this

The owner asking for a uniform tone. Absent that, treat a request to "make it
consistent" as a prompt to ask which register they mean — the inconsistency is
the design, and flattening it silently would remove a product decision they
made deliberately.
