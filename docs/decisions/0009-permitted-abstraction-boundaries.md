# 0009 — Infrastructure abstractions are permitted; frameworks are not

**Status:** Accepted
**Date:** 2026-07-30
**Supersedes, in part:** the blanket "no premature abstraction" rule in
`CLAUDE.md`. It does **not** supersede [ADR 0005](0005-no-state-management-library.md)
— React state plus the shared store remains the answer for client state.

## Context

`CLAUDE.md` has said, since the beginning and correctly, *"No premature
abstraction, no generic 'entity' system, no ORM-style data layer. Every feature
so far is a flat array of typed objects — keep doing that."* That rule is why
this codebase is still readable at eleven features: no repository pattern, no
service locator, no generic CRUD layer that every feature has to be bent
through.

The owner's roadmap then asked for four things that read like violations of it:
a **Storage Provider** abstraction (JSON now, PostgreSQL later), a **Search
Service** abstraction (JSON now, vector search later), an **AI Provider
Manager** (Claude and GPT behind one router), and **Deployment
Configuration** (nothing may assume it runs on this machine).

Left unresolved, this becomes the worst of both worlds: either the rule blocks
work the owner has explicitly asked for, or the rule gets quietly ignored and
the codebase acquires exactly the generic layering the rule existed to prevent.

The distinction that resolves it is **what is on the far side of the boundary.**

## Decision

**Abstractions that isolate infrastructure are permitted. Abstractions that
generalise the domain are not.**

An abstraction is permitted when all of these hold:

1. **It hides a swappable external dependency** — a file format, a database, a
   search engine, a model provider, a host. Something that will genuinely be
   replaced, where the replacement would otherwise touch unrelated code.
2. **It has exactly one implementation today**, and that implementation is the
   thing that already exists. No speculative second provider is written until
   there is a real second provider.
3. **Its interface is the narrow set of operations Operator actually performs**
   — not the full surface of the underlying technology. A storage provider that
   exposes `get`/`set`/`delete` per slice is a boundary; one that exposes
   queries, joins and transactions is a database driver with extra steps.
4. **Features do not become generic to pass through it.** `MissionRecord` stays
   `MissionRecord`. Nothing becomes an `Entity<T>`.

Approved on this basis, by the owner on 2026-07-30:

| Abstraction | Boundary it isolates |
|---|---|
| **Storage Provider** | JSON file today → PostgreSQL or other engine later |
| **Search Service** | JSON scan today → SQL or vector search later |
| **AI Provider Manager** | Claude / GPT / future local models behind one router |
| **Deployment Configuration** | Paths, ports, hosts, secrets — never hardcoded to this machine |

Still forbidden, explicitly and with no exception implied by the above:

- A generic repository, ORM, entity system, or `BaseModel`.
- A client-side state management library (ADR 0005 stands).
- Any layer whose justification is "we might need it" rather than a named
  swap the owner has asked for.
- Extending a permitted abstraction beyond its boundary because it is already
  there. The Storage Provider does not grow a query language.

**The one-feature-one-hook pattern is unchanged.** These boundaries sit *below*
the feature hooks, not between features and their data. `useMissionBoard` still
owns `missions.records`; what changes is only what `remoteStore` talks to
underneath.

## AI providers — additional constraints

The AI Provider Manager is a permitted abstraction, but it also crosses the
external-host rule in `CLAUDE.md`, so it carries its own conditions:

- **The frontend never talks to a model provider.** All provider traffic is
  server-side, the same rule `server/status.mjs` already follows.
- **API keys never live in the store, in source control, or on the client.**
  `data/operator.json` is a plaintext file served by an unauthenticated API —
  a key in it is a key published to the tailnet. Environment variables in
  development; Docker secrets or equivalent runtime configuration in
  production.
- **Each new provider is approved individually before integration**, naming the
  host and what leaves the machine. Approving the manager did not approve its
  future occupants.

## The embedded terminal — approved with restrictions

The Embedded Claude Workspace includes a terminal, which inverts the read-only
posture that made **OPS-018** acceptable. Approved for **local development
only**:

- Remote terminal access stays **disabled**.
- **No execution over the tailnet or any external network** until an
  authentication and authorisation model exists.
- Reachable only from the local development machine in this phase.
- Remote execution may be revisited once real auth exists — that is a separate
  decision, not an extension of this one.

## Consequences

**Good.** The owner's infrastructure roadmap becomes buildable without either
ignoring the architecture rules or arguing with them each time. The test is
concrete enough to apply to the next request without another ADR.

**Bad.** "Isolates infrastructure" is a judgement call, and judgement calls
drift. The four-part test above is the guard; if a proposed abstraction fails
any part of it, it needs the owner's approval as a new decision rather than
being waved through by this one.

**The rule to keep repeating:** these boundaries exist so a future swap is
cheap. They do not exist to make the code more general, and generality is not
evidence that one is working.

## What would change this

Revisit if any of these become true:

- **A second implementation never arrives.** If Postgres and vector search are
  still hypothetical a year from now, the Storage Provider and Search Service
  are costing indirection for nothing and should collapse back into
  `remoteStore`. The test is whether a real swap is scheduled, not whether one
  is imaginable.
- **A boundary starts being widened to fit callers.** The first time a feature
  needs the Storage Provider to expose a query, a join, or a transaction, the
  boundary was drawn in the wrong place — stop and redraw it rather than
  growing it.
- **Authentication lands.** The terminal restriction above exists because there
  is no auth (OPS-018). A real authentication and authorisation model makes the
  remote-execution question legitimate to reopen — as a new decision, not as an
  automatic consequence of this one.

What would **not** change it: finding the abstraction inconvenient while
building the second provider. That is the cost this ADR knowingly accepted.
