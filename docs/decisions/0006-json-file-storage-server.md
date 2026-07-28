# 0006 — JSON file storage server

**Status:** Accepted
**Date:** 2026-07-28
**Supersedes:** [0001 — Local-first storage, no backend](0001-local-first-storage.md)

## Context

ADR 0001 chose `localStorage` and named the condition that would overturn it:
*"genuine multi-device use… the first move is probably file-based
export/import or a self-hosted sync target on the owner's own homelab — not a
SaaS backend."*

That condition arrived. `vision.md` now requires that *"no core workflow should
require a desktop computer"*, and the owner uses a PC and a phone today with a
laptop coming. `localStorage` is scoped to one browser profile, so the phone
was a **completely separate Operator** — different data, no sync, ever. Making
the UI responsive would have produced a nicer-looking wrong app.

Three further pressures pointed the same way:

- **No migration path.** A shape change silently corrupted data already in the
  browser (OPS-003), and the vision expects the app to evolve for years.
- **No backup path.** Clearing site data destroyed everything.
- **Per-instance state.** `useLocalStorage` gave every call site its own copy,
  which lost a newly created mission on navigate (OPS-016) and blocked
  Statistics from ever reading across features (OPS-004).

SQLite was considered and rejected *for now*: the dataset is kilobytes, the app
already loads everything into memory and filters in JS, and `better-sqlite3`
means a native compile on Windows. The thing that actually future-proofs this
is the **API boundary**, not the database behind it.

## Decision

Storage is a **JSON file served by a small Node process in `server/`**.

- `data/operator.json` — `{ schemaVersion, updatedAt, state: { "<key>": value } }`.
  Path overridable via `OPERATOR_DATA`, so it can point at a NAS mount.
- No dependencies. Node's built-in `http` and `fs` only.
- `GET /api/state`, `PUT /api/state/<key>`, `PUT /api/state` (bulk),
  `DELETE /api/state/<key>`, `GET /api/health`.
- Writes go to a temp file then `rename`, so a crash cannot truncate the store.
- A `MIGRATIONS` array runs oldest-first on load — this is what `localStorage`
  never had.
- Vite proxies `/api` in dev so the app is same-origin and needs no CORS.
- `npm run serve` serves the built app and the API from one port, for when it
  moves to the EPYC box.

On the client, `useLocalStorage` became `useRemoteStorage` with an **identical
signature**, backed by one module-level cache in `lib/remoteStore.ts`. No
feature hook changed shape. `localStorage` is retained as an offline read
mirror, and writes made while the server is unreachable are queued and flushed
on reconnect.

The self-hosting principle from ADR 0001 is **unchanged**: this is the owner's
own process, on the owner's own hardware, on the owner's own tailnet. Nothing
is sent to a third party.

## Consequences

**Makes easy:** one dataset across every device. A human-readable data file that
can be copied, diffed, or dropped on a NAS. Real migrations. A shared client
cache that closes OPS-004 and makes Statistics buildable. Settings becomes
mostly plumbing that already exists.

**Makes hard:**

- **The app now has a runtime dependency.** With the server down it degrades to
  the last known data with writes queued — deliberately, and surfaced by the
  `Local store` badge in the Topbar — but it is no longer purely client-side.
- **`npm run dev` starts two processes**, and ports must not collide (Vite is
  pinned with `strictPort` for exactly this reason).
- **No authentication.** Anyone on the tailnet has full read/write. Accepted:
  the tailnet is the security boundary.
- **`data/` is gitignored, so git is not a backup.** A separate copy job is
  needed once real data exists.
- **Two writers can still clobber each other** — last write wins, no locking.
  Fine for one person; would need revisiting for concurrent editing.

## What would change this

**SQLite**, when relationships genuinely need querying rather than filtering in
JS — most likely when Knowledge Vault, Journey, or Statistics land and the
vision's "understand relationships between entities" stops being satisfiable by
loading everything into memory. Because the API boundary exists, that swap
touches `server/index.mjs` and nothing in the app.

**Auth**, if Operator is ever reachable from outside the tailnet. It should not
be.
