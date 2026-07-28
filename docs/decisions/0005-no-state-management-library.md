# 0005 — No state management library

**Status:** Accepted
**Date:** 2026-07-26

## Context

A dashboard app with ten features, persistence, and derived views is the classic
shape people reach for Redux, Zustand, Jotai, or React Query to solve.

Operator has no server, so there is nothing to cache, no request lifecycle, no
optimistic updates, and no invalidation. Its "async" surface is a synchronous
localStorage read at mount. Features are deliberately independent
([ADR 0002](0002-feature-slice-architecture.md)), so there is no shared graph to
normalise either.

## Decision

No state management library. State is `useState` via `useLocalStorage`, plus one
React context (`ThemeContext`) for presentation state only — accent colour and
sidebar collapse, never feature data.

`CLAUDE.md:22-24` states this as a rule: it "has been sufficient and should stay
that way unless the user asks otherwise."

## Consequences

**Makes easy:** the entire state layer is seventeen lines
(`hooks/useLocalStorage.ts`). There is nothing to learn, nothing to configure,
no devtools, no middleware, and no version churn. A feature hook is readable
top-to-bottom in under a minute.

**Makes hard:**

- **No cross-component sharing.** Each `useLocalStorage` call site holds its own
  copy, so a feature hook must be called once per mounted tree. This is the
  invariant behind **OPS-004** and it is exactly what a store would solve.
- **No cross-tab sync.** Two tabs will fight; last write wins.
- **No time-travel or devtools** when debugging state.

## What would change this

**Statistics**, or any genuine need for two mounted components to share live
feature state. Even then, reach for the smallest thing that works first: a
`storage` event listener, or lifting `useLocalStorage` to a subscription, both
of which preserve the current API and avoid a dependency.

A library is the last resort, not the first — and adopting one would touch every
feature hook, so it needs its own ADR and the owner's explicit agreement.
