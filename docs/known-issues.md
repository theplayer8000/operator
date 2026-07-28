# Known Issues & Technical Debt

The live register. Each item has a stable ID so it can be referenced from
commits, handoffs, and other documents without depending on line numbers.

**Read this before shipping.** The five high-severity entries were fixed in v5
(2026-07-28); everything below OPS-005 is still live.

Status values: `Open` · `Approved` (fix agreed, not applied) · `Fixed` ·
`Accepted` (known and deliberately tolerated) · `Needs decision` (blocked on the
owner).

| ID | Title | Severity | Status |
|---|---|---|---|
| [OPS-001](#ops-001) | `crypto.randomUUID` crashes outside a secure context | **High** | **Fixed** (v5) |
| [OPS-002](#ops-002) | Milestone progress wiped when set to "In Progress" | **High** | **Fixed** (v5) |
| [OPS-003](#ops-003) | No schema versioning or migration path | **High** | **Fixed** (v5) |
| [OPS-004](#ops-004) | Feature hooks don't share memory across instances | Medium | **Fixed** (v5) |
| [OPS-016](#ops-016) | New mission lost when created — write dropped on unmount | **High** | **Fixed** (v5) |
| [OPS-017](#ops-017) | `data/operator.json` has no automatic backup | Medium | Partly addressed (v9) |
| [OPS-018](#ops-018) | Dev browser exposes the repo over HTTP with no auth | Medium | Accepted |
| [OPS-019](#ops-019) | Homelab status reports port-open, not health | Low | Accepted |
| [OPS-020](#ops-020) | Deletes have a confirm step but no undo | Low | Open |
| [OPS-022](#ops-022) | Vite dev server served every file under the project root | **High** | **Fixed** (v7) |
| [OPS-021](#ops-021) | Separate project with real client data sits inside this repo | Medium | Mitigated, relocation optional |
| [OPS-005](#ops-005) | Dashboard mission widgets are decorative | Medium | **Fixed** (v9) |
| [OPS-006](#ops-006) | Storage writes fail silently | Medium | Partly addressed |
| [OPS-007](#ops-007) | Accent theme is ~95% inert | Low | Needs decision |
| [OPS-008](#ops-008) | Hardcoded hex values in components | Low | Open |
| [OPS-009](#ops-009) | Daily reset is mount-only and UTC-based | Low | Open |
| [OPS-010](#ops-010) | Stale module-load date in Topbar | Low | **Fixed** (v6) |
| [OPS-011](#ops-011) | Dead type surface | Low | Open |
| [OPS-012](#ops-012) | No delete or archive path for missions | Low | **Fixed** (v7) |
| [OPS-013](#ops-013) | Dependency cycles are possible | Low | Open |
| [OPS-014](#ops-014) | Google Fonts breaks the offline-first claim | Low | Needs decision |
| [OPS-015](#ops-015) | Duplicate SVG gradient IDs in `ShieldProgress` | Trivial | Open |

---

## OPS-001

**`crypto.randomUUID` crashes outside a secure context** · High · **Fixed in v5**

> **Fixed 2026-07-28.** `src/lib/id.ts` now exposes `generateId()` with a
> non-crypto fallback, and all eight call sites use it. Verified over Tailscale.
> **Use `generateId()` for any new ID — never `crypto.randomUUID()` directly.**
> The underlying constraint has not gone away: Operator is used at a bare IP, so
> every secure-context API (`crypto.subtle`, `navigator.clipboard`, service
> workers) is still unavailable.

Documented in `CLAUDE.md:202-231`. `crypto.randomUUID()` exists only in a secure
context (`localhost` or HTTPS). The owner accesses the dev server over Tailscale
at a bare IP, which the browser treats as insecure, so **any action that
generates an ID throws and takes down the page** — adding a task, toggling one,
adding a note, creating a mission, adding a milestone, or logging any activity.

Eight call sites, verified:

```
hooks/useDashboardData.ts:38, 56, 64
hooks/useRoutineData.ts:59
hooks/useMissionBoard.ts:29, 48, 66, 100
```

**Fix (approved, spec'd at `CLAUDE.md:214-224`):** add `generateId()` with a
non-crypto fallback, then replace every call site. Grep for `crypto.randomUUID`
rather than trusting the list above — it will be stale if features were added.

Do this before adding a ninth call site.

## OPS-002

**Milestone progress wiped when set to "In Progress"** · High · **Fixed in v5**

> **Fixed 2026-07-28.** `MilestoneList.setStatus` now builds the patch key by
> key and omits `progress` when it should be left alone. `completionDate` still
> passes an explicit `undefined`, because there the overwrite is the intent —
> commented as such at the call site.

*Not in `CLAUDE.md` — found during the 2026-07-28 review.*

`components/missions/MilestoneList.tsx:44-48` builds a patch containing an
explicit `undefined`:

```ts
onUpdate(id, {
  status,
  progress: status === "complete" ? 100 : status === "pending" ? 0 : undefined,
  completionDate: status === "complete" ? new Date().toISOString() : undefined,
});
```

`hooks/useMissionBoard.ts:115` applies it with `{ ...ms, ...patch }`. **A key
present with the value `undefined` overwrites.** So moving a milestone to "In
Progress" sets `progress` to `undefined`:

- `Milestone.progress` is typed `number` but holds `undefined`;
- the bar renders `width: "undefined%"`, which is invalid CSS;
- the bad value is persisted to localStorage.

The same mechanism clears `completionDate`, where it *is* the intent.

TypeScript cannot catch this — an explicit `undefined` is well-typed against
`Partial<Milestone>`.

**Fix options:** omit the key instead of passing `undefined`; or strip
`undefined` values in `updateMilestone` before spreading. The first is smaller
and keeps the "explicit undefined means clear" behaviour available for
`completionDate`.

## OPS-003

**No schema versioning or migration path** · High · **Fixed in v5**

> **Fixed 2026-07-28.** The store now carries `schemaVersion`, and
> `server/index.mjs` runs a `MIGRATIONS` array oldest-first on load. Add one
> entry per persisted shape change. The defensive-read guidance below is still
> good practice, but it is no longer the only line of defence.

`lib/storage.ts:11-19` casts parsed JSON straight to `T` with no validation.
Seeds persist on first render, so every future shape change lands on browsers
already holding the old shape. Add an array field, render it with `.map()`, and
the page white-screens.

`importAllData` (`lib/storage.ts:42-49`) has the same gap from the other
direction — no validation, no version check.

Interim rules are in [`data-model.md`](data-model.md#changing-a-persisted-shape--read-this-first):
additive changes only, defensive reads, never rename or retype a shipped field.

**Decision needed:** add a `schemaVersion` key and a migration hook, or accept
"wipe and re-seed if it breaks" for a single-user app. This gets more expensive
with every namespace added.

## OPS-004

**Feature hooks don't share memory across instances** · Medium · **Fixed in v5**

> **Fixed 2026-07-28.** `lib/remoteStore.ts` holds one module-level cache with
> per-key subscribers, consumed via `useSyncExternalStore`. Every call site now
> reads the same data, so calling a feature hook twice is safe and **Statistics
> is no longer blocked**. Invariant 1 in `architecture.md` is retired.

`useLocalStorage` is `useState` + a write-through effect with no context and no
`storage` listener. Every call site gets an independent copy; two mounted
callers of the same feature hook diverge and clobber each other last-writer-wins.
Two browser tabs do the same.

Safe today only because each page calls its hook once and pages aren't mounted
simultaneously. Nothing enforces it. See Invariant 1 in
[`architecture.md`](architecture.md#1-a-feature-hook-is-called-once-per-mounted-tree).

**This blocks Statistics**, which is by definition a cross-feature reader.
Resolve it deliberately — likely a read-only aggregation path — rather than ad
hoc inside one feature.

## OPS-005

**Dashboard mission widgets are decorative** · Medium · **Fixed** (v9)

`CurrentMissions` and `ProjectProgress` rendered `dashboard.missions` seed data
(EPYC 62%, Homelab 40%, Darams 78%, AI 25%) that never changed. `setMissions`
was returned from `useDashboardData` and never consumed, so there was no editor
either.

The open product question — *should these read the real board?* — was answered
by the owner in v9: yes. Both widgets now read `missions.records` through
`useMissionBoard()`, read-only, and link to `/missions/:id`. The Productivity
Score card had the same defect (a "7-day trend" over seven hardcoded numbers)
and was replaced by `MissionStatusChart`, derived from the same real data.

`dashboard.missions`, `dashboard.productivityHistory`, the `Mission` type and
`seedMissions` are all retired. See
[ADR 0008](decisions/0008-dashboard-reads-the-real-board.md), which supersedes
ADR 0003.

The stale *"start one from Projects"* copy went with the rewrite.

## OPS-006

**Storage writes fail silently** · Medium · Partly addressed

> **Partly addressed 2026-07-28.** Server writes that fail are now queued and
> retried, and the Topbar shows an offline badge — failures are visible rather
> than silent. The `localStorage` mirror write underneath still swallows errors,
> which is now cosmetic rather than data-losing.

`lib/storage.ts:21-27` swallows every write error. On quota exhaustion the app
keeps working from memory and the user finds out on reload.

Deliberate availability trade-off (Invariant 5), recorded here because the cost
is real. Activity-log caps (30 / 20) reduce unbounded growth. Revisit if
attachments or long histories are ever added.

## OPS-007

**Accent theme is ~95% inert** · Low · Needs decision

`ThemeContext` offers four accents and sets `--accent`, but
`components/ui/ShieldProgress.tsx:10` is the only consumer. Everything else uses
the fixed `xp` token, and no UI exists to change the accent.

**Decision needed:** finish it (route `xp` usages through `--accent`, add the
switcher in Settings) or drop it to gold-only and delete the machinery.

## OPS-008

**Hardcoded hex values in components** · Low · Open

Against `CLAUDE.md:102-103`.

- ~~`pages/MissionDetail.tsx:171` — `accent-[#E8B04D]`~~ — fixed in v6
  (`accent-xp`)
- `components/ui/Confetti.tsx:3` — `COLORS` array
- `components/dashboard/ProductivityScore.tsx:24-42` — Recharts colours

The Recharts one is close to unavoidable (props, not classes) and is reasonable
to leave with a comment. The Confetti one is straightforwardly fixable.

## OPS-009

**Daily reset is mount-only and UTC-based** · Low · Open

`hooks/useRoutineData.ts:22-33` runs the reset in an effect with `[]` deps, so a
tab left open across midnight never resets until reload — and a dashboard is
exactly the app people leave open.

Separately, `todayKey()` uses `toISOString()`, i.e. **UTC**. For a UK user in
BST the routine day rolls at 01:00 local, not midnight.

**Fix:** compute the local date (not `toISOString`), and re-check on an interval
or on visibility change rather than mount only.

## OPS-010

**Stale module-load date in Topbar** · Low · **Fixed in v6**

> **Fixed 2026-07-28.** The date is component state refreshed on a 60s interval.
> The synthetic-`KeyboardEvent` hack is also gone — `CommandPalette` now exports
> `openCommandPalette()`, which matters because a faked Cmd+K meant nothing at
> all on a touch device.

## OPS-011

**Dead type surface** · Low · Open

- `DashboardData` (`lib/types.ts:90`) — declared, never used.
- `Task.dueDate` (`lib/types.ts:13`) — declared, never read or written.
- `Task.missionId` (`lib/types.ts:14`) — declared, never read or written. **This
  is the tasks→missions link the product philosophy rests on**; wiring it is a
  product decision, not a cleanup.
- `Target` icon imported but never rendered in `pages/MissionDetail.tsx:6`.
  Compiles because `noUnusedLocals` is `false`.

## OPS-012

**No delete or archive path for missions** · Low · **Fixed** (v7)

`MissionRecord.archived` existed and was filtered on but nothing could set it,
and there was no delete anywhere in the app. A mistyped mission was permanent.

Fixed in v7 along with edit/delete for tasks, notes, routine steps and
milestones. `setArchived` and `deleteMission` live in `useMissionBoard`;
both are surfaced at the bottom of `MissionDetail`, below the tabs, with an
"Archived" filter on the board so an archived record can be reached and
restored. `deleteMission` also sweeps the deleted ID out of every other
mission's `dependsOn` — see the note in `data-model.md`.

## OPS-013

**Dependency cycles are possible** · Low · Open

`components/missions/DependencyEditor.tsx:12` excludes only self-reference. A →
B → A is reachable. Nothing crashes — `DependencyChain` renders one level in
each direction — but the data is nonsense and any future traversal (ordering,
critical path, Journey rollup) would need to handle it.

## OPS-014

**Google Fonts breaks the offline-first claim** · Low · Needs decision

`index.html:7-12` loads three typefaces from a CDN. Offline, all three fall back
to generic sans and the deliberate display/body/mono pairing collapses.

`CLAUDE.md:14-17` explicitly allows this as the one permitted network call, so it
is a known trade-off rather than a violation. **Decision needed:** self-host the
fonts to make offline-first literal, or accept degraded typography offline.

## OPS-015

**Duplicate SVG gradient IDs in `ShieldProgress`** · Trivial · Open

`components/ui/ShieldProgress.tsx:17` derives the gradient ID from progress and
size, so two shields at the same progress emit the same DOM ID. Invisible today
because the gradients are identical. Would break if the gradient ever depends on
anything else.

## OPS-016

**New mission lost when created — write dropped on unmount** · High · **Fixed in v5**

> **Fixed 2026-07-28.** Root cause removed by the shared store in
> `lib/remoteStore.ts` (see OPS-004). Writes now leave the component
> synchronously instead of waiting for an effect that may never run.

Reported as *"the New Mission button doesn't work"*.

`NewMissionForm.submit()` called `onCreate(...)` — which queued `setMissions` —
and then `navigate()` in the same handler. React 18 batched both into one
commit, so `MissionBoard` **unmounted before its write-effect ran**.
`MissionDetail` then mounted, read storage fresh, and found nothing:
*"Mission not found."* The mission was gone.

This was OPS-004 surfacing as visible data loss, and it is the reason the
mutator-then-navigate pattern is safe now but was not before.

## OPS-018

**Dev browser exposes the repo over HTTP with no auth** · Medium · Accepted

`server/dev.mjs` serves the project directory read-only at `/api/dev/*`. It is
sandboxed — traversal outside the repo root is rejected, and `node_modules`,
`.git`, `dist` and `data` are excluded — but there is **no authentication**, in
line with the rest of the API.

Accepted because the tailnet is the security boundary. It becomes a real
problem the moment Operator is reachable from anywhere else, which is a good
reason it should not be.

Verified at implementation: `..`, `../../../Windows`, `data`, `node_modules`
and an absolute-ish sibling path were all rejected.

## OPS-019

**Homelab status reports port-open, not health** · Low · Accepted

`server/homelab.mjs` does a TCP connect. A process that is hung but still
holding its port reads as online. This is deliberate — see
[ADR 0007](decisions/0007-homelab-server-side-probes.md); anything richer means
per-service health endpoints, which couples Operator to each service's
internals. The Homelab page states the limitation on the page itself rather
than implying more certainty than it has.

Revisit the first time a tile says "online" about something visibly broken.

## OPS-020

**Deletes have a confirm step but no undo** · Low · Open

v7 added delete for tasks, notes, routine steps, milestones and missions. Each
is two-step (`components/ui/ConfirmButton.tsx`) and self-disarms after four
seconds, but once confirmed the record is gone — there is no undo buffer and no
soft-delete for anything except missions, which have archive.

The store is a single JSON file with no history, so recovery today means
restoring the whole file — which is also **OPS-017**, and is the second reason
that one matters. A cheap improvement would be a short-lived "undo" toast
holding the deleted item in memory; the honest fix is snapshots.

## OPS-022

**The Vite dev server served every file under the project root** · **High** ·
**Fixed** (v7)

`npm run dev -- --host` binds to the tailnet, and Vite's static middleware will
serve anything under the project root as an asset. No auth, by design — Vite
assumes localhost.

Verified before the fix, against the running dev server:

| Path | Result |
|---|---|
| `GET /data/operator.json` | **200 — the entire Operator store, 36 KB** |
| `GET /Darams-CRM/darams_crm.db` | **200 — the CRM's SQLite database, 53 KB** |
| `GET /Darams-CRM/uploads/tenancies/1/EICR.pdf` | **200 — a real tenancy document** |

This is a **third, independent door**. `.gitignore` does not apply to it, and
neither does the `DENY` set in `server/dev.mjs` — those guard git and the Dev
browser respectively. It is easy to close one and assume the others followed.

Fixed with `server.fs.deny` in `vite.config.ts`, covering `data/`,
`Darams-CRM/`, `*.db`, `*.sqlite` and `.env*`. Re-verified: all of the above
now return 403, while the app and the `/api` proxy still return 200.

**Production is unaffected** — `npm run serve` serves `dist/` only, and never
had this behaviour. This was dev-server-only, which is also why it went
unnoticed: dev is exactly where `--host` gets used.

If a future change adds a directory holding anything private, add it to that
deny list. The lesson worth keeping: three different mechanisms decide what
leaves this machine, and they share no configuration.

## OPS-021

**A separate project with real client data sits inside this repo** · Medium ·
Mitigated, relocation optional

`Darams-CRM/` is a separate Flask project (its own repo, own database, own
handoff) that currently lives inside Operator's working directory. It contains
`darams_crm.db` and `uploads/` — real tenancy documents and personal details.

Two live exposures were found and closed in v7:

- **It was untracked but not ignored.** A `git add -A` would have staged client
  PII into a repo with a GitHub remote. Now in `.gitignore`.
- **The Dev browser listed it.** The extension allowlist stopped `.db`/`.pdf`
  *contents* being served, but `listTree` exposed tenancy document *filenames*
  over HTTP. `Darams-CRM` is now in the `DENY` set in `server/dev.mjs`.

A third exposure — the Vite dev server serving the CRM's database and uploads
over the tailnet — turned out to be a **general Operator defect** rather than a
consequence of nesting, and is tracked separately as **OPS-022**.

**Relocating is no longer required.** The owner opted to keep the CRM nested
and hidden, which is sound now that all three doors are shut:

| Door | Guard |
|---|---|
| git history | `Darams-CRM/` in `.gitignore` |
| Dev browser (`/api/dev/*`) | `Darams-CRM` in `DENY`, `server/dev.mjs` |
| Vite dev server | `**/Darams-CRM/**` in `server.fs.deny`, `vite.config.ts` |

**Do not remove any of the three.** They are independent mechanisms sharing no
configuration, so removing one will not fail loudly.

Two things remain true regardless of where the directory sits:

- **The CRM has no version control of its own.** There is no `Darams-CRM/.git`,
  and Operator's repo ignores it — so that project currently has *no history at
  all* while it is being actively rewritten. `git init` in that directory is
  worth doing on its own merits, and a nested repo is invisible to Operator.
- **Operator's backup story still has to cover it** (**OPS-017**), and it is
  now excluded from the one mechanism that was implicitly copying it.

## OPS-017

**`data/operator.json` has no automatic backup** · Medium · Partly addressed (v9)

`data/` is gitignored — correctly, since it holds personal data — which means
**git is not a backup**. The store is a single file on one machine's disk.

**v9 gave it a manual route out.** Settings > Export downloads the whole store
as JSON, read from the server rather than the local mirror (so it's complete,
not just what this browser has loaded), and Import merges one back.

That is a real backup path and it closes the "no way to get a copy at all"
half of this issue. **It does not close the automation half** — an export only
exists if the owner remembers to take one, and nothing is scheduled. The store
now holds real data (9 missions, live routine), so this matters more than when
it was logged.

Still needed: a scheduled copy off this machine. `rsync` over SSH to the NAS on
a timer is the obvious shape, and is independent of the app. Moving
`OPERATOR_DATA` to a NAS mount improves durability but is still one copy — a
copy job is the thing, not a relocation.

There is also **no automatic pre-migration snapshot**: v8's schema migration ran
against live data with nothing taken first. Taking an export before a migration
is currently a habit, not a mechanism.
