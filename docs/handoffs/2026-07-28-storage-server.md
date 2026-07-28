# v5 — Crash fixes and JSON file storage

**Date:** 2026-07-28
**Commit:** pending approval
**Milestones:** M1 (defect fixes) + M2 (storage off localStorage)

## Summary

Operator's data no longer lives in the browser. A small dependency-free Node
server (`server/`) now owns `data/operator.json`, and the client talks to it
through one shared store. **Desktop and phone see the same data over Tailscale**
— previously they were two entirely separate apps with separate datasets.

Three high-severity defects were fixed on the way: the ID crash that made the
app unusable over Tailscale, a milestone patch that silently wiped progress, and
a newly diagnosed bug where a created mission was lost before it was ever saved.

Existing localStorage data migrated automatically on first load. Verified by the
owner on both PC and phone.

## Files modified

**New**

| File | Purpose |
|---|---|
| `server/index.mjs` | Storage API. `GET/PUT/DELETE /api/state`, `/api/health`. Atomic writes, `MIGRATIONS` array |
| `scripts/dev.mjs` | Runs the API and Vite together; no new dependency |
| `src/lib/id.ts` | `generateId()` — secure-context-safe |
| `src/lib/remoteStore.ts` | One shared client cache, subscribers, offline queue, localStorage mirror |
| `src/hooks/useRemoteStorage.ts` | Same signature as the old hook, over `useSyncExternalStore` |
| `src/components/layout/StorageStatus.tsx` | Always-visible connection badge |
| `docs/decisions/0006-json-file-storage-server.md` | ADR superseding 0001 |

**Changed**

| File | Change |
|---|---|
| `src/hooks/useDashboardData.ts`, `useRoutineData.ts`, `useMissionBoard.ts` | `useLocalStorage` → `useRemoteStorage`; `crypto.randomUUID()` → `generateId()` (8 sites) |
| `src/context/ThemeContext.tsx` | Same hook swap |
| `src/components/missions/MilestoneList.tsx` | Patch built key-by-key — fixes OPS-002 |
| `src/components/layout/Topbar.tsx` | Hosts the storage badge |
| `src/lib/seed.ts` | Comment only |
| `vite.config.ts` | `/api` proxy; `port: 5173` + `strictPort` |
| `package.json` | `dev`, `dev:web`, `server`, `serve` scripts |
| `.gitignore` | `data/`, `onboarding-report.txt`, `*.scratch.md` |
| `CLAUDE.md` | Storage section rewritten; folder map, run instructions, known-issues section updated |
| `docs/*` | architecture, data-model, adding-a-feature, development, roadmap, known-issues, decisions/README, ADR 0001 (superseded) |

**Deleted:** `src/hooks/useLocalStorage.ts` (orphaned after the swap).

## Architectural decisions

**[ADR 0006](../decisions/0006-json-file-storage-server.md) — JSON file storage
server**, superseding ADR 0001.

This contradicted `CLAUDE.md`'s "no backend, no database" rule, and that was
raised with the owner before implementing. It is a legitimate supersede rather
than a violation: ADR 0001 named this exact trigger (multi-device use) and
predicted this exact resolution ("a self-hosted sync target on the owner's own
homelab — not a SaaS backend"). The self-hosting principle is intact — the
process, the hardware, and the network are all the owner's.

**JSON rather than SQLite**, against my own earlier recommendation. The dataset
is kilobytes, the app already loads everything into memory and filters in JS,
and `better-sqlite3` needs a native compile on Windows. `schemaVersion` plus a
migrations array solves versioning at this scale. The thing that future-proofs
this is the API boundary, not the database — swapping in SQLite later touches
`server/index.mjs` and nothing in the app.

**Identical hook signature.** `useRemoteStorage` deliberately matches
`useLocalStorage` so no feature hook changed shape. Storage moved off the
browser without touching a single feature's logic.

## Technical debt

**Resolved:**

- **OPS-001** — `crypto.randomUUID` crash. `generateId()`, 8 call sites.
- **OPS-002** — milestone progress wiped by an explicit `undefined` in a spread.
- **OPS-003** — no migration path. `schemaVersion` + server-side `MIGRATIONS`.
- **OPS-004** — per-instance state. One shared cache; **Statistics unblocked**.
- **OPS-016** — *new*: created missions lost on navigate. Same root cause as 004.
- **OPS-006** — downgraded to partly addressed; failures are now visible and
  queued rather than silent.

**Introduced:**

- **OPS-017** — `data/` is gitignored, so **git is not a backup**. Exposure is
  limited while the data is seed/test content; it becomes real the moment the
  owner enters live data.
- **A runtime dependency.** The app degrades rather than dies when the server is
  down, but it is no longer purely client-side.
- **No auth.** Anyone on the tailnet has full read/write. Accepted deliberately.
- **Two dev processes** with a port collision hazard, mitigated by `strictPort`.

## Documentation updated

`CLAUDE.md` (storage, folder map, run commands, known issues), `vision.md`
(Accessibility section added by the owner, wired into both doc maps), ADR 0006,
ADR 0001 marked superseded, and `architecture.md`, `data-model.md`,
`adding-a-feature.md`, `development.md`, `roadmap.md`, `known-issues.md`.

Invariant 1 in `architecture.md` is now marked retired rather than deleted — the
failure it described was real and the record is worth keeping.

## Outstanding issues

1. **No backup for `data/operator.json`** (**OPS-017**). Owner intends interim
   cloud storage, then the NAS, then the EPYC server. Nothing to do until real
   data exists, but it should not be forgotten.
2. **Mobile is not yet usable** — this milestone made the data shared, which is
   the prerequisite, but the UI is still desktop-assumed: fixed 232px sidebar,
   28px touch targets, a hover-only repeat toggle in Daily Routine that is
   unreachable on a phone, and ten wrapping tabs in Mission Detail. That is M3.
3. **The owner has not yet entered real data** — deliberately deferred until
   after this milestone so it only has to be entered once.
4. **OPS-005** (Dashboard mission widgets are decorative) still needs a product
   decision; now cheaper to resolve since features can safely share the store.

## Recommended next milestone

**M3 — mobile / responsive pass.** It is explicitly required by `vision.md`
("no core workflow should require a desktop computer"), the owner uses a phone
today, and the data-sharing prerequisite is now in place. The hover-only repeat
toggle is a genuine violation of that clause, not just a polish item.

After M3: **Settings**, which is now mostly plumbing over the existing API and
is the only route to closing OPS-017.

## Assumptions & risks

- **Assumed the tailnet is an acceptable security boundary.** There is no auth;
  anyone on the tailnet has full read/write. Stated to the owner, not
  explicitly ratified.
- **Migration ran once and is not idempotent-by-design** — it only fires when
  the server has zero keys, so it cannot overwrite real data. If the store is
  ever deliberately emptied while stale localStorage exists, old data would be
  lifted back up. Low risk, worth knowing.
- **Last write wins across devices.** Editing the same slice on phone and PC
  simultaneously loses one side. Acceptable for one person; not a design that
  survives concurrent editing.
- **The offline queue is memory-only.** Writes made while the server is down
  survive in the localStorage mirror, but the *pending queue* does not survive a
  page reload — a reload while offline reverts to the mirror rather than
  replaying queued writes.
- **Verified by the owner on PC and phone**, including the cross-device shared
  data case. The offline/queue path was implemented and type-checked but **not
  exercised end to end in a browser**.

## Verification

- [x] `npx tsc -b` clean
- [x] `npx vite build` clean
- [x] API smoke-tested: health, full read, single-key write, bulk migrate,
      delete, and the Vite `/api` proxy
- [x] localStorage → server migration verified: 13 keys lifted, including the
      owner's test edits
- [x] Owner confirmed the app on both PC and phone
- [ ] Offline/reconnect queue **not** exercised in a browser
- [ ] `npm run serve` (deployment mode) **not** exercised — no deployment target
      exists yet
