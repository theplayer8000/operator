# Architecture Decision Records

Short records of decisions that **look wrong without context**. Their job is to
stop a future session from "fixing" something deliberate.

Not every choice needs one. Write an ADR when a decision:

- rules something out that a reasonable engineer would otherwise reach for;
- creates apparent duplication or inconsistency on purpose;
- constrains what future features are allowed to do.

Routine feature work does not need an ADR. Following the recipe in
[`adding-a-feature.md`](../adding-a-feature.md) is not a decision.

> **Not to be confused with the Decision Log feature** on the product roadmap.
> That is a *life* decision log (decision / date / reasoning / outcome) that
> will link from missions. These are *engineering* decisions about the codebase.

## Index

| # | Decision | Status | Date |
|---|---|---|---|
| [0001](0001-local-first-storage.md) | Local-first storage, no backend | **Superseded by 0006** | 2026-07-26 |
| [0002](0002-feature-slice-architecture.md) | Feature-slice architecture | Accepted | 2026-07-26 |
| [0003](0003-separate-mission-types.md) | Two separate mission types | **Superseded by 0008** | 2026-07-27 |
| [0004](0004-tonal-registers.md) | Different tonal registers per feature | Accepted | 2026-07-27 |
| [0005](0005-no-state-management-library.md) | No state management library | Accepted | 2026-07-26 |
| [0006](0006-json-file-storage-server.md) | JSON file storage server | Accepted | 2026-07-28 |
| [0007](0007-homelab-server-side-probes.md) | Homelab status is probed server-side | Accepted | 2026-07-28 |
| [0008](0008-dashboard-reads-the-real-board.md) | The Dashboard reads the real Mission Board | Accepted | 2026-07-28 |
| [0009](0009-permitted-abstraction-boundaries.md) | Infrastructure abstractions permitted; frameworks not | Accepted | 2026-07-30 |

Dates are when the decision was made in the codebase (from git history), not
when it was written down.

## Rules

- **Never edit the substance of a decided ADR.** If a decision changes, write a
  new one and mark the old one `Superseded by NNNN`. Fixing a typo is fine.
- **Status** is one of `Accepted`, `Superseded by NNNN`, or `Proposed`.
- Keep them short. One page. If it needs more, the detail belongs in
  `architecture.md` and the ADR should link to it.

## Template

```markdown
# NNNN — <Title>

**Status:** Accepted
**Date:** YYYY-MM-DD

## Context

What was true that forced a choice.

## Decision

What was chosen, stated plainly.

## Consequences

What this makes easy, what it makes hard, and what it forbids.

## What would change this

The condition under which revisiting is legitimate — so a future session can
tell "this is now wrong" apart from "I would have done it differently".
```
