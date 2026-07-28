# v7 — Edits, deletes & the Homelab dashboard

**Date:** 2026-07-28
**Commit:** pending approval
**Milestone:** M4

## Summary

Two things, one theme: Operator stops being a place you can only add to, and
starts being the front door to the box it runs on.

**Edit and delete** now exist for Dashboard tasks, Quick Notes, Daily Routine
steps, mission milestones, and missions themselves. Every delete is two-step;
missions get archive as the non-destructive option first, with an "Archived"
filter on the board so archiving is reversible rather than a disappearance.
This closes **OPS-012**, open since v3.

**Homelab** (`/homelab`) is a new feature: one tile per service running on the
box, with a live up/down dot and a link in. Tiles are data, not code, so adding
the next project is a form entry. The Dashboard carries a compact read-only
strip of the same tiles — the "homepage for the homelab" the owner asked for —
while management stays on the feature's own page.

The first tile is **Darams CRM** on `:5000`. Operator links to it and shares
nothing with it. That CRM is a separate Flask project with its own database and
its own handoff, and that handoff explicitly asks that the two not be coupled
in code. Nothing in `Darams-CRM/` was touched by this milestone.

## Files modified

| File | Change |
|---|---|
| `src/lib/types.ts` | New `// --- Homelab ---` section: `HomelabService`, `ServiceStatus` |
| `src/lib/seed.ts` | `seedHomelabServices` — Darams CRM + the storage API itself |
| `src/lib/remoteStore.ts` | New `serverKeys` set + `hasOnServer()`. Cache membership couldn't answer "does the server have this", because `getSnapshot` populates the cache on read |
| `server/homelab.mjs` | **New.** TCP reachability probes, 1.5s timeout, 5s cache keyed on the probed set |
| `server/index.mjs` | `GET /api/homelab/status` |
| `src/hooks/useHomelab.ts` | **New.** Feature hook + `serviceUrl()` host-rewrite helper + 30s poll |
| `src/components/homelab/ServiceTile.tsx` | **New.** Tile: dot, name, host:port, latency, Open |
| `src/components/homelab/ServiceForm.tsx` | **New.** One form for both add and edit, with port validation |
| `src/pages/Homelab.tsx` | **New.** Grid + add/edit/delete + manual re-check |
| `src/components/dashboard/HomelabStatus.tsx` | **New.** Read-only tile strip on the homepage |
| `src/components/ui/ConfirmButton.tsx` | **New.** Shared two-step delete, self-disarms after 4s |
| `src/hooks/useDashboardData.ts` | `editTask`, `deleteTask`, `editNote`, `deleteNote` |
| `src/hooks/useRoutineData.ts` | `editTask` (title + minutes), `deleteTask` |
| `src/hooks/useMissionBoard.ts` | `deleteMission`, `setArchived`, `deleteMilestone`, `archived` list |
| `src/components/dashboard/TodayTasks.tsx` | Inline rename + delete per row |
| `src/components/dashboard/QuickNotes.tsx` | Inline edit + delete per note |
| `src/components/routine/RoutineSectionCard.tsx` | Edit mode replaces the row; delete lives inside it |
| `src/components/missions/MilestoneList.tsx` | Inline title/duration edit + delete |
| `src/pages/MissionDetail.tsx` | Archive/restore + delete block below the tabs |
| `src/pages/MissionBoard.tsx` | "Archived" filter, archived count in the subheader |
| `src/pages/Dashboard.tsx`, `DailyRoutine.tsx` | Wiring |
| `src/App.tsx`, `Sidebar.tsx`, `CommandPalette.tsx`, `Contents.tsx` | `/homelab` route + nav + index entry |
| `.gitignore` | `Darams-CRM/` — see OPS-021 |
| `server/dev.mjs` | `Darams-CRM` added to the Dev browser's `DENY` set — see OPS-021 |
| `vite.config.ts` | `server.fs.deny` for `data/`, `Darams-CRM/`, `*.db`, `.env*` — see **OPS-022** |

**Docs:** new [ADR 0007](../decisions/0007-homelab-server-side-probes.md);
`CLAUDE.md` (status table, folder map, Homelab register, new *Destructive
actions* rule); `docs/architecture.md` (the aggregator exception now covers
Dashboard widgets reading another namespace); `docs/data-model.md` (key
registry, new Homelab section, `dependsOn` sweep invariant);
`docs/known-issues.md` (OPS-012 closed, OPS-019 and OPS-020 added);
`docs/roadmap.md`.

## Architectural decisions

**[ADR 0007] Homelab status is probed server-side.** The one real decision
here. A client-side `fetch` is the obvious implementation and is broken twice
over: the browser is usually a phone over Tailscale, so probing `localhost:5000`
probes the phone and reports everything offline forever; and CORS makes the
response unreadable regardless. So the storage server probes, and the client
asks it. The probe list comes from the store and the endpoint takes no host or
port parameter, so it can't be used as a port scanner by anything on the
tailnet.

The companion trick is `serviceUrl()`: a stored `localhost` is rewritten to
`window.location.hostname` when building the link, so one config opens
correctly from the desk *and* the phone.

**Homelab is a full feature, not a Dashboard widget.** One namespace, one hook,
one folder, one page — the established pattern. The homepage presence is a
read-only widget over the feature's hook, the same shape as the Activity Log's
sanctioned exception. Tile management deliberately does not live on the
Dashboard; a CRUD editor in the daily-glance grid would wreck what that page is
for.

**Archive before delete, where a record is worth keeping.** Missions get both.
Tasks, notes and steps get delete only — a mistyped routine step doesn't need
a lifecycle.

**Edit mode replaces the routine row rather than extending it.** That row
already carries a checkbox, a minute estimate and the repeat toggle; a fourth
and fifth 44px target leaves no room for the title at 390px. Delete lives one
step in, which also suits it being the destructive one.

## Technical debt

**Resolved:** **OPS-012** — missions can now be archived, restored and deleted,
and `archived` finally has a writer after existing unused since v3.

**Introduced, both logged:**

- **OPS-019** — status is port-open, not health. Deliberate (ADR 0007), stated
  on the page itself rather than implied away.
- **OPS-020** — deletes have a confirm step but no undo. The store is a single
  JSON file with no history, so recovery means restoring the file, which is
  **OPS-017** again. This is the second thing pointing at backups.

**Found and fixed, not introduced — OPS-022 (High).** The Vite dev server
serves any file under the project root, with no auth, and `npm run dev -- --host`
binds it to the tailnet. Verified against the running server: `GET
/data/operator.json` returned **the entire Operator store**, and
`GET /Darams-CRM/darams_crm.db` returned **the CRM's database**. Closed with
`server.fs.deny` in `vite.config.ts`; re-verified as 403 with the app and
`/api` proxy still 200. Production (`npm run serve`, dist-only) was never
affected.

The lesson is the part to carry forward: **three independent mechanisms decide
what leaves this machine** — `.gitignore`, the Dev browser's `DENY`, and Vite's
`fs.deny` — and they share no configuration. Closing one does not close the
others, and none of them fails loudly.

**Found and mitigated — OPS-021.** `Darams-CRM/` sits inside Operator's working
directory with real client data. It was untracked but not gitignored (a
`git add -A` would have staged client PII into a repo with a GitHub remote), and
the Dev browser's `listTree` exposed tenancy document filenames. Both closed.
The owner opted to keep it nested and hidden rather than relocate, which is
sound now that all three doors above are shut. Note that project has **no git
repo of its own** and so currently no version control at all.

**One new coupling to be aware of:** the storage server now reads a specific
application key (`homelab.services`) rather than treating the store as opaque.
That is a deliberate exception, argued in ADR 0007, but it is the first crack in
"the server knows nothing about the shape of the data". Don't widen it without
a reason as good.

## Documentation updated

- **[ADR 0007](../decisions/0007-homelab-server-side-probes.md)** — new. Why the
  status probe is server-side, and what would legitimately change that.
- **`CLAUDE.md`** — Homelab in the status table and folder map; Homelab's tonal
  register (infra, not playful); a new *Destructive actions* rule stating that
  deletes go through `ConfirmButton`, archive comes before delete where a record
  is worth keeping, and there is no undo.
- **`docs/architecture.md`** — the read-only-aggregator exception now explicitly
  covers a Dashboard widget reading another feature's namespace, so the next
  session doesn't read `HomelabStatus.tsx` as a violation.
- **`docs/data-model.md`** — key registry (`homelab.services`, updated mutability
  for tasks/notes/missions), a Homelab type section, and the `dependsOn` sweep
  invariant on mission delete.
- **`docs/known-issues.md`** — OPS-012 closed; OPS-019 and OPS-020 added.
- **`docs/roadmap.md`** — Homelab section under Built; edit/delete reflected in
  Dashboard, Daily Routine and Mission Board.

## Outstanding issues

1. **Not exercised on a physical phone.** Type-checked, built, and the probe
   endpoint verified end-to-end against a throwaway server instance — but the
   `serviceUrl()` host rewrite, which is the whole reason the design works, has
   only been reasoned about, not observed from a phone. **This is the one thing
   to confirm first.** Open `/homelab` over Tailscale and check the Darams CRM
   tile's Open link goes to `100.x.y.z:5000`, not `localhost:5000`.
2. **The CRM tile will read offline until the CRM is running.** Verified
   behaviour, not a bug — port 5000 was closed during testing and reported
   offline correctly.
3. **OPS-009 still open** (daily reset mount-only + UTC) and still the most
   likely thing to bite a phone left open overnight.
4. **OPS-017 still open** and now doubly relevant, since v7 added deletes.
5. **No handoff exists for the v6.5 work** (`/log`, `/contents`, `/dev` —
   commits `6b26af3` and `d12cb4f`). Those shipped without one.

## Recommended next milestone

**Settings** — unchanged from the v6 recommendation and now more pressing.
It is mostly plumbing over API routes that already exist (`GET /api/state`
export, `PUT /api/state` import, `DELETE /api/state/<key>` reset), and it is the
only route to closing **OPS-017**. v7 added five ways to destroy data and zero
ways to get a backup out; that gap should not survive another milestone.

**OPS-009** remains the sensible small companion fix.

## Assumptions & risks

- **Assumed every homelab service is co-located with the storage server.** True
  today and the premise of the `localhost` rewrite. A service on another
  machine still works — store its real hostname — but won't follow the browser
  between networks.
- **Assumed TCP connect is a good enough "is it up"** for a tile. See OPS-019.
- **Assumed the 5s probe cache is invisible.** A service that comes up is shown
  as offline for up to 5 seconds after; the manual re-check button has the same
  ceiling. If that ever feels wrong, the cache key already includes the probed
  set, so shortening it is a one-line change.
- **Seed-push on first run is guarded on an online load**, so a failed load
  can't overwrite real data with seed data. That guard is the only thing
  standing between "the server didn't answer" and data loss — leave it alone.
- **`ConfirmButton` disarms after 4 seconds.** Chosen so a stray tap can't sit
  armed indefinitely, long enough to be reachable one-handed. Untested against
  a real thumb.
- **No undo anywhere.** See OPS-020.

## Verification

- [x] `npx tsc -b` clean
- [x] `npx vite build` clean
- [x] `server/homelab.mjs` probed directly: closed port → offline, live port →
      online with latency, invalid entries (port 0, missing host) filtered out
      before probing (5 in, 3 out)
- [x] `GET /api/homelab/status` end-to-end on a throwaway instance
      (`OPERATOR_PORT=5999`, temp data file): correct online/offline, cache
      returns an identical `checkedAt`, `POST` correctly 404s
- [ ] **Not exercised on a physical phone** — including the host rewrite
- [ ] Edit/delete paths not clicked through in a browser
- [x] `Darams-CRM/` untouched — confirmed by `git status`; nothing in that
      directory was written, and nothing was read from it beyond its
      `HANDOFF.md`
- [x] **OPS-022 exposure reproduced and then closed** against the running dev
      server: `/data/operator.json` and `/Darams-CRM/darams_crm.db` returned
      200 with full contents before, 403 after; `/` and `/api/health` still 200
