# 0002 — Feature-slice architecture

**Status:** Accepted
**Date:** 2026-07-26

## Context

Operator plans roughly ten top-level features (Dashboard, Daily Routine, Mission
Board, Learning, Gym, Forex, Work, Journey, Statistics, Settings) plus Knowledge
Vault and Decision Log later. They are all "a list of typed objects the owner
edits" — which makes a generic abstraction tempting: one entity system, one
generic CRUD hook, one schema registry.

That temptation is the thing this decision exists to resist. A generic layer
would have been designed against three features and then bent by the next seven,
and every feature would inherit the union of every other feature's needs.

## Decision

Every feature is the same five things and nothing more:

**one localStorage namespace · one hook · one component folder · one page · one
route**

- The **hook** is the only place that knows the feature's storage keys, and the
  only place that mutates them. Pages and components never call
  `useLocalStorage` for feature data.
- The **page** calls that hook exactly once and threads state down as props.
- **Components** are presentational: props in, `on*` callbacks out.
- **Derived values are computed, never stored.**
- **Types are appended** to `lib/types.ts` in their own section, never
  interleaved with or mutated from another feature's types.
- **Seed data** is one export per feature in `lib/seed.ts`, used as the fallback
  argument to the feature's first `useLocalStorage` call.

No generic entity system, no ORM-style data layer, no premature abstraction
(`CLAUDE.md:60-62`). Duplication between slices is the accepted cost.

Mission Board's two pages (list + detail) are the one sanctioned exception to
"one page", because a board without a detail view is not the feature. It remains
one hook, one namespace, one folder.

## Consequences

**Makes easy:** a feature can be read, understood, changed, or deleted in
isolation. New features are mechanical — see
[`adding-a-feature.md`](../adding-a-feature.md). Nothing breaks in Gym because
something changed in Forex.

**Makes hard:**

- **Duplication.** Several features will grow similar list/toggle/edit code.
  This is intentional; resist extracting it.
- **Cross-feature reads have no home.** Statistics and Journey are inherently
  cross-cutting and the architecture has no aggregation path. Worse, the naive
  approach — calling every feature hook from one page — violates the invariant
  below and corrupts data.

**The load-bearing invariant:** `useLocalStorage` is `useState` plus a
write-through effect, with **no context and no `storage` listener**
(`hooks/useLocalStorage.ts:9-17`). Every call site holds its own copy. Two
mounted components calling the same feature hook diverge and clobber each other
last-writer-wins.

This holds today only because each page calls its hook once and pages are never
mounted simultaneously. Nothing enforces it. Tracked as **OPS-004**.

## What would change this

**Statistics.** It cannot be built without answering how one page reads many
features safely. When that happens the likely shapes are (a) a read-only
aggregation module that reads storage directly without hooks, or (b) lifting
`useLocalStorage` to a subscription model so instances share.

Option (b) is a change to the foundation of every feature and needs its own ADR.
Option (a) is smaller and preserves this decision. Neither should be improvised
inside a feature branch.
